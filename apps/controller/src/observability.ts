import { D1LaunchpadStore, type IncidentRecord, type LaunchpadStore, type MetricSnapshotRecord, type ProviderErrorRecord } from '@launchpad/database';
import { fanOutFailure, incidentDelivery, type FanOutResult } from '@launchpad/github-reporting';
import type { ProviderName } from '@launchpad/core';
import { alertConfigFor, alertFingerprint, decideAlert, defaultAlertConfigs, type AlertConfig, type AlertType } from '@launchpad/shared';
import { LaunchpadLogger, MetricsRegistry, metricWorkflowOf, redactText, stableId, type LogContext } from '@launchpad/shared';
import type { ControllerEnv } from './env.js';

/**
 * Controller failure observability: typed error persistence, incident/alert
 * records, bounded metrics, and GitHub fan-out. Every permanent failure ends
 * up as a provider-error row plus an incident row (when the alert decides to
 * fire), with delivery outcomes recorded — a failed sink is visible, never
 * silent. Success is never derived from cleanup: callers record the failure
 * BEFORE any recovery path and re-throw the original error.
 */

export interface ObservabilityDeps {
  store?: LaunchpadStore | undefined;
  logger: LaunchpadLogger;
  metrics?: MetricsRegistry | undefined;
  alertConfigs: AlertConfig[];
  github?: { token: string; baseUrl?: string | undefined; fetchImpl?: typeof fetch | undefined } | undefined;
  now?: (() => Date) | undefined;
}

export interface FailureReportContext {
  correlationId?: string | null;
  applicationId?: string | null;
  operationId?: string | null;
  workflowId?: string | null;
  provider?: ProviderName | null;
  step?: string | null;
  kind?: string | null;
  repository?: string | null;
  pullRequestNumber?: number | string | null;
  sourceCommit?: string | null;
}

export interface FailureReportResult {
  providerError: ProviderErrorRecord | null;
  incident: IncidentRecord | null;
  fanout: FanOutResult | null;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function parsePositiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`LP-ALERT-CONFIG-INVALID: ${name} must be a non-negative integer, got '${value}'.`);
  return parsed;
}

function parseRate(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`LP-ALERT-CONFIG-INVALID: ${name} must be a rate between 0 and 1, got '${value}'.`);
  return parsed;
}

export interface AlertSettings {
  cooldownSeconds: number;
  reconciliationThreshold: number;
  credentialExpiryWindowDays: number;
  errorRateThreshold: number;
  enabled: boolean;
}

export function alertSettingsFromEnv(env: ControllerEnv['Bindings']): AlertSettings {
  return {
    cooldownSeconds: parsePositiveInteger(env.LAUNCHPAD_ALERT_COOLDOWN_SECONDS, 'LAUNCHPAD_ALERT_COOLDOWN_SECONDS', 3600),
    reconciliationThreshold: parsePositiveInteger(env.LAUNCHPAD_ALERT_RECONCILIATION_THRESHOLD, 'LAUNCHPAD_ALERT_RECONCILIATION_THRESHOLD', 3),
    credentialExpiryWindowDays: parsePositiveInteger(env.LAUNCHPAD_ALERT_CREDENTIAL_EXPIRY_WINDOW_DAYS, 'LAUNCHPAD_ALERT_CREDENTIAL_EXPIRY_WINDOW_DAYS', 14),
    errorRateThreshold: parseRate(env.LAUNCHPAD_ALERT_ERROR_RATE_THRESHOLD, 'LAUNCHPAD_ALERT_ERROR_RATE_THRESHOLD', 0.1),
    enabled: env.LAUNCHPAD_ALERTS_ENABLED !== 'false',
  };
}

export function buildAlertConfigs(env: ControllerEnv['Bindings']): AlertConfig[] {
  const settings = alertSettingsFromEnv(env);
  return defaultAlertConfigs().map((config) => ({
    ...config,
    enabled: settings.enabled,
    cooldownSeconds: settings.cooldownSeconds,
    threshold: config.type === 'RECONCILIATION_FAILURE' ? settings.reconciliationThreshold : config.type === 'CONTROLLER_ERROR_RATE' ? settings.errorRateThreshold : config.threshold,
  }));
}

/**
 * Process-scoped metrics registry shared by every request/queue/scheduled
 * invocation in the isolate. Counters accumulate between scheduled
 * snapshots (D1-persisted), so error rates and totals reflect real traffic
 * rather than single-invocation windows. Label sets stay bounded.
 */
const sharedMetrics = new MetricsRegistry();

export function buildObservability(env: ControllerEnv['Bindings'], store?: LaunchpadStore): ObservabilityDeps {
  return {
    store: store ?? (env.DB ? new D1LaunchpadStore(env.DB) : undefined),
    logger: new LaunchpadLogger({ level: env.LAUNCHPAD_LOG_LEVEL === 'debug' ? 'debug' : 'info' }),
    metrics: sharedMetrics,
    alertConfigs: buildAlertConfigs(env),
    github: env.GITHUB_TOKEN ? { token: env.GITHUB_TOKEN, ...(env.GITHUB_BASE_URL ? { baseUrl: env.GITHUB_BASE_URL } : {}) } : undefined,
  };
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

const REMEDIATION_BY_CODE_PREFIX: Readonly<Array<{ prefix: string; remediation: string }>> = [
  { prefix: 'LP-OIDC', remediation: 'Re-run the GitHub Actions job; verify the OIDC issuer, audience, and workflow allowlist in the controller environment.' },
  { prefix: 'LP-AUTH', remediation: 'Rotate the provider credential and re-run (see docs/runbooks/credentials.md).' },
  { prefix: 'LP-RATE', remediation: 'Back off and retry after the provider rate-limit window; review provider quotas.' },
  { prefix: 'LP-TIMEOUT', remediation: 'Check provider status and retry; the durable workflow resumes from its last completed step.' },
  { prefix: 'LP-DB-TOMBSTONE', remediation: 'The application is deleted; recreate it under a fresh application id.' },
  { prefix: 'LP-DB-LOCK', remediation: 'Release or wait for the expiring application/domain lock, then retry.' },
  { prefix: 'LP-DB-IDEMPOTENCY', remediation: 'Re-run with the original idempotency key and payload.' },
  { prefix: 'LP-CONTROL-MANIFEST', remediation: 'Fix the control-repository manifest for the application and open a new PR.' },
  { prefix: 'LP-PLAN', remediation: 'Re-plan against the exact source commit; stale fingerprints block apply.' },
];

export function remediationForCode(code: string): string {
  for (const entry of REMEDIATION_BY_CODE_PREFIX) {
    if (code.startsWith(entry.prefix)) return entry.remediation;
  }
  if (code.includes('AUTHENTICATION') || code.includes('FORBIDDEN') || code.includes('401') || code.includes('403')) {
    return 'Rotate the provider credential and re-run (see docs/runbooks/credentials.md).';
  }
  if (code.includes('TIMEOUT') || code.includes('RATE_LIMITED') || code.includes('TRANSIENT')) {
    return 'Retry with backoff; the durable workflow resumes from its last completed step.';
  }
  return 'Inspect the incident record and provider error rows before retrying; do not repeat destructive actions blindly.';
}

export interface ClassifiedFailure {
  code: string;
  message: string;
  errorClass: ProviderErrorRecord['class'];
  retryable: boolean;
  remediation: string;
}

export function classifyFailure(error: unknown): ClassifiedFailure {
  const scrub = (message: string): string => redactText(message.length > 2048 ? `${message.slice(0, 2048)}…[truncated]` : message);
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const hasCode = typeof record.code === 'string' && record.code.length > 0;
    const hasClass = typeof record.class === 'string' && record.class.length > 0;
    const retryable = record.retryable === true;
    const message = error instanceof Error ? error.message : hasCode ? String(record.message ?? 'Unknown controller failure.') : 'Unknown controller failure.';
    if (hasCode) {
      return {
        code: record.code as string,
        message: scrub(message),
        errorClass: hasClass ? (record.class as ProviderErrorRecord['class']) : 'INTERNAL',
        retryable,
        remediation: remediationForCode(record.code as string),
      };
    }
  }
  if (error instanceof Error) {
    const code = error.name !== 'Error' ? error.name : 'LP-WORKFLOW-STEP-FAILED';
    return { code, message: scrub(error.message), errorClass: 'INTERNAL', retryable: 'retryable' in error && error.retryable === true, remediation: remediationForCode(code) };
  }
  return { code: 'LP-INTERNAL', message: 'Unknown controller failure.', errorClass: 'INTERNAL', retryable: false, remediation: remediationForCode('LP-INTERNAL') };
}

function alertTypeFor(kind: string | null | undefined): AlertType {
  return kind === 'reconcile' ? 'RECONCILIATION_FAILURE' : 'CONTROLLER_ERROR_RATE';
}

// ---------------------------------------------------------------------------
// Permanent-failure recording
// ---------------------------------------------------------------------------

/**
 * Records one permanent (or threshold-reaching) failure end to end:
 * provider-error row, incident row (deduped by cooldown), audit event,
 * GitHub fan-out (sticky PR comment + commit status when context exists),
 * and failure metric. Never throws: persistence or fan-out problems degrade
 * to logged delivery failures instead of masking the original failure.
 */
export async function recordPermanentFailure(deps: ObservabilityDeps, input: FailureReportContext & { error: unknown; remediation?: string | null }): Promise<FailureReportResult> {
  const now = deps.now ?? (() => new Date());
  const classified = classifyFailure(input.error);
  const remediation = input.remediation ?? classified.remediation;
  const logContext: LogContext = {
    correlationId: input.correlationId ?? null,
    applicationId: input.applicationId ?? null,
    workflowId: input.workflowId ?? null,
    operationId: input.operationId ?? null,
    provider: input.provider ?? null,
    step: input.step ?? null,
    errorCode: classified.code,
    retryable: classified.retryable,
    kind: input.kind ?? null,
  };
  let providerError: ProviderErrorRecord | null = null;
  let incident: IncidentRecord | null = null;
  let fanout: FanOutResult | null = null;

  try {
    if (deps.store) {
      providerError = await deps.store.recordProviderError({
        applicationId: input.applicationId ?? null,
        operationId: input.operationId ?? null,
        provider: input.provider ?? null,
        code: classified.code,
        class: classified.errorClass,
        message: classified.message,
        retryable: classified.retryable,
        safeDetails: { step: input.step ?? null, correlationId: input.correlationId ?? null, workflowId: input.workflowId ?? null, kind: input.kind ?? null },
        causeFingerprint: stableId('cause', classified.code, classified.message),
        remediation,
      });

      const type = alertTypeFor(input.kind);
      const fingerprint = alertFingerprint(type, classified.code, input.applicationId ?? 'platform');
      const config = alertConfigFor(deps.alertConfigs, type) ?? { type, enabled: true, cooldownSeconds: 3600, threshold: null };
      const previous = await deps.store.getIncident(type, fingerprint);
      let consecutiveFailures = 1;
      if (type === 'RECONCILIATION_FAILURE' && previous && previous.resolvedAt === null) {
        consecutiveFailures = (typeof previous.details.consecutiveFailures === 'number' ? previous.details.consecutiveFailures : 1) + 1;
      }
      const threshold = type === 'RECONCILIATION_FAILURE' ? (config.threshold ?? 3) : null;
      // Hard (non-retryable) failures fire immediately; retryable failures
      // count consecutive attempts up to the threshold before firing.
      const meetsThreshold = threshold === null || !classified.retryable || consecutiveFailures >= threshold;
      const decision = !meetsThreshold
        ? { fire: false as const, reason: 'below-threshold' as const }
        : decideAlert({
            type,
            fingerprint,
            severity: classified.retryable ? 'warning' : 'critical',
            message: classified.message,
            ...(input.applicationId !== undefined ? { applicationId: input.applicationId } : {}),
            ...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
            details: { code: classified.code, step: input.step ?? null, consecutiveFailures },
            at: now(),
          }, config, previous, now());
      if (decision.fire) {
        fanout = await fanOutFailure({
          targets: {
            ...(input.repository !== undefined ? { repository: input.repository } : {}),
            ...(input.pullRequestNumber !== undefined ? { pullRequestNumber: input.pullRequestNumber } : {}),
            ...(input.sourceCommit !== undefined ? { sourceCommit: input.sourceCommit } : {}),
          },
          report: { plans: [], providerError: { code: classified.code, message: classified.message, operationId: input.operationId ?? null, retryable: classified.retryable }, logs: [] },
          options: deps.github ? { token: deps.github.token, ...(deps.github.baseUrl ? { baseUrl: deps.github.baseUrl } : {}), ...(deps.github.fetchImpl ? { fetchImpl: deps.github.fetchImpl } : {}) } : {},
          workflow: input.kind ?? 'apply',
        });
        incident = await deps.store.recordIncident({
          type,
          fingerprint,
          severity: classified.retryable ? 'warning' : 'critical',
          applicationId: input.applicationId ?? null,
          operationId: input.operationId ?? null,
          message: classified.message,
          details: { code: classified.code, errorClass: classified.errorClass, remediation, step: input.step ?? null, consecutiveFailures, kind: input.kind ?? null },
          firedAt: now().toISOString(),
          delivery: fanout ? incidentDelivery(fanout) : {},
        });
        await deps.store.appendAudit({ actor: 'system:alert', action: 'INCIDENT_FIRED', applicationId: input.applicationId ?? null, details: { type, fingerprint: incident.fingerprint, code: classified.code, severity: incident.severity } });
      } else if (type === 'RECONCILIATION_FAILURE' && classified.retryable) {
        // Below-threshold tracking row: counts consecutive retryable
        // failures without suppressing the eventual firing.
        await deps.store.recordIncident({ type, fingerprint, severity: 'warning', applicationId: input.applicationId ?? null, operationId: input.operationId ?? null, message: classified.message, details: { code: classified.code, consecutiveFailures, kind: input.kind ?? null }, firedAt: now().toISOString() }, { trackOnly: true });
      }
    }
    deps.metrics?.increment('failures', { provider: input.provider ?? 'other', workflow: metricWorkflowOf(input.kind) });
  } catch (recordingError) {
    deps.logger.error('failure recording degraded', { ...logContext, errorCode: 'LP-OBSERVABILITY-RECORD-FAILED', message: recordingError instanceof Error ? recordingError.message : 'recording failed' });
  }

  deps.logger.error('permanent failure', logContext);
  return { providerError, incident, fanout };
}

/** Metrics + audit for a successful recovery that performed a rollback. */
export function recordRollback(deps: ObservabilityDeps, input: { applicationId: string; kind?: string | null; recovery: unknown }): void {
  const recovery = input.recovery as Record<string, unknown> | null;
  const rollback = recovery !== null && typeof recovery === 'object' && 'rollback' in recovery ? recovery.rollback : null;
  if (rollback === null || rollback === undefined) return;
  deps.metrics?.increment('rollback_count', { workflow: metricWorkflowOf(input.kind ?? 'apply') });
  void deps.store?.appendAudit({ actor: 'system:workflow', action: 'APPLY_ROLLBACK', applicationId: input.applicationId, details: { rollback } });
}

// ---------------------------------------------------------------------------
// Credential expiry checks (metadata only — secret values are never read)
// ---------------------------------------------------------------------------

export interface CredentialExpiryResult {
  checked: number;
  incidents: IncidentRecord[];
}

export async function checkCredentialExpiration(deps: ObservabilityDeps, warningWindowDays = 14): Promise<CredentialExpiryResult> {
  if (!deps.store) return { checked: 0, incidents: [] };
  const now = deps.now ?? (() => new Date());
  const config = alertConfigFor(deps.alertConfigs, 'CREDENTIAL_EXPIRY') ?? { type: 'CREDENTIAL_EXPIRY' as const, enabled: true, cooldownSeconds: 3600, threshold: null };
  const credentials = await deps.store.listCredentialsMetadata();
  const incidents: IncidentRecord[] = [];
  for (const credential of credentials) {
    if (!credential.expiresAt) continue;
    const expiresAtMs = Date.parse(credential.expiresAt);
    if (!Number.isFinite(expiresAtMs)) continue;
    const expired = expiresAtMs <= now().getTime();
    const expiringSoon = !expired && expiresAtMs - now().getTime() <= warningWindowDays * 24 * 3600 * 1000;
    const status = expired ? 'EXPIRED' : expiringSoon ? 'EXPIRING_SOON' : 'VALID';
    if (status !== credential.status) {
      await deps.store.updateCredentialStatus(credential.id, status, now().toISOString());
    }
    // The computed status is only ever VALID, EXPIRED, or EXPIRING_SOON;
    // only VALID credentials are not alert-worthy.
    if (status === 'VALID') continue;
    const fingerprint = alertFingerprint('CREDENTIAL_EXPIRY', credential.id);
    const previous = await deps.store.getIncident('CREDENTIAL_EXPIRY', fingerprint);
    const decision = decideAlert(
      { type: 'CREDENTIAL_EXPIRY', fingerprint, severity: expired ? 'critical' : 'warning', message: `Credential '${credential.purpose}' for ${credential.provider} ${expired ? `expired ${credential.expiresAt}` : `expires ${credential.expiresAt}`}.`, applicationId: null, details: { provider: credential.provider, purpose: credential.purpose, expiresAt: credential.expiresAt, status }, at: now() },
      config,
      previous,
      now(),
    );
    if (decision.fire) {
      const incident = await deps.store.recordIncident({ type: 'CREDENTIAL_EXPIRY', fingerprint, severity: expired ? 'critical' : 'warning', applicationId: null, message: `Credential '${credential.purpose}' for ${credential.provider} ${expired ? `expired ${credential.expiresAt}` : `expires ${credential.expiresAt}`}.`, details: { provider: credential.provider, purpose: credential.purpose, expiresAt: credential.expiresAt, status }, firedAt: now().toISOString() });
      await deps.store.appendAudit({ actor: 'system:alert', action: 'INCIDENT_FIRED', applicationId: null, details: { type: 'CREDENTIAL_EXPIRY', fingerprint: incident.fingerprint, provider: credential.provider, purpose: credential.purpose, severity: incident.severity } });
      incidents.push(incident);
    }
  }
  deps.logger.info('credential expiration check complete', { step: 'scheduled/credential-expiry', checked: credentials.length, incidents: incidents.length });
  return { checked: credentials.length, incidents };
}

// ---------------------------------------------------------------------------
// Metrics snapshots and error-rate alert
// ---------------------------------------------------------------------------

/** Persists the registry snapshot to the store (bounded rows; labels are the fixed provider/workflow set). */
export async function snapshotMetricsToStore(deps: ObservabilityDeps): Promise<MetricSnapshotRecord[]> {
  if (!deps.store || !deps.metrics) return [];
  const snapshots = deps.metrics.snapshot();
  const rows: MetricSnapshotRecord[] = [];
  for (const snapshot of snapshots) {
    rows.push(await deps.store.recordMetricSnapshot({ metric: snapshot.metric, total: snapshot.total, rate: snapshot.rate, windowSeconds: snapshot.windowSeconds, labels: snapshot.labels as Record<string, string>, capturedAt: snapshot.capturedAt }));
  }
  return rows;
}

/** Sets the drift and preview-cleanup gauges from durable store state. */
export async function refreshObservabilityGauges(deps: ObservabilityDeps, applicationIds: readonly string[]): Promise<void> {
  if (!deps.store || !deps.metrics) return;
  let openDrift = 0;
  for (const applicationId of applicationIds) {
    openDrift += (await deps.store.listDriftEvents(applicationId, { includeResolved: false })).length;
  }
  deps.metrics.set('drift_count', openDrift);
  const pendingCleanup = await deps.store.listPendingCleanupJobs({ limit: 1000 });
  deps.metrics.set('preview_cleanup_backlog', pendingCleanup.length);
}

/** Fires the CONTROLLER_ERROR_RATE incident when the live-window error rate meets the threshold. */
export async function evaluateErrorRateAlert(deps: ObservabilityDeps): Promise<IncidentRecord | null> {
  if (!deps.store || !deps.metrics) return null;
  const now = deps.now ?? (() => new Date());
  const config = alertConfigFor(deps.alertConfigs, 'CONTROLLER_ERROR_RATE') ?? { type: 'CONTROLLER_ERROR_RATE' as const, enabled: true, cooldownSeconds: 3600, threshold: 0.1 };
  const rate = deps.metrics.errorRate();
  const threshold = config.threshold ?? 0.1;
  if (rate < threshold) return null;
  const fingerprint = alertFingerprint('CONTROLLER_ERROR_RATE', 'window');
  const previous = await deps.store.getIncident('CONTROLLER_ERROR_RATE', fingerprint);
  const decision = decideAlert({ type: 'CONTROLLER_ERROR_RATE', fingerprint, severity: 'warning', message: `Controller error rate ${rate.toFixed(3)} exceeds threshold ${threshold}.`, applicationId: null, details: { rate, threshold }, at: now() }, config, previous, now());
  if (!decision.fire) return null;
  const incident = await deps.store.recordIncident({ type: 'CONTROLLER_ERROR_RATE', fingerprint, severity: 'warning', applicationId: null, message: `Controller error rate ${rate.toFixed(3)} exceeds threshold ${threshold}.`, details: { rate, threshold }, firedAt: now().toISOString() });
  await deps.store.appendAudit({ actor: 'system:alert', action: 'INCIDENT_FIRED', applicationId: null, details: { type: 'CONTROLLER_ERROR_RATE', fingerprint: incident.fingerprint, severity: incident.severity, rate } });
  return incident;
}
