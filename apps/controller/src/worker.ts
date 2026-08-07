import { D1LaunchpadStore, InMemoryDatabase, LaunchpadRepositories, type LaunchpadStore } from '@launchpad/database';
import { stableId } from '@launchpad/shared';
import { createControllerApp } from './api.js';
import { controllerDependencies } from './handlers.js';
import type { D1Database, ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import type { ControllerEnv } from './env.js';
import { alertSettingsFromEnv, buildObservability, checkCredentialExpiration, evaluateErrorRateAlert, refreshObservabilityGauges, snapshotMetricsToStore, type ObservabilityDeps } from './observability.js';
import { createHttpQueueDispatcher, createProviderEventFanout, createReconciliationWorkflowDispatcher, dispatchScheduledReconciliation, handleQueue, parseProviderEventFanoutLimit, parseProviderEventShardCount, parseReconciliationShardCount, providerEventReconciliationParams, type IncidentRequest, type ProviderEventFanOutcome, type QueueBatch, type QueueDependencies, type QueueEnvelope, type QueuePersistence } from './queues.js';
export { ApplyApplicationWorkflow, AppPreviewStatusWorkflow, DecommissionApplicationWorkflow, PreviewApplicationWorkflow, ReconcileApplicationWorkflow } from './workflows.js';

const repositories = new LaunchpadRepositories(new InMemoryDatabase());

type SecretName = 'OPERATOR_TOKEN' | 'OPERATOR_TOKENS' | 'CONTROLLER_INTERNAL_TOKEN' | 'VERCEL_TOKEN' | 'CLOUDFLARE_TOKEN' | 'GITHUB_TOKEN' | 'VERCEL_WEBHOOK_SECRET';

async function resolveSecret(binding: { get(): Promise<string> } | undefined): Promise<string | undefined> {
  if (!binding) return undefined;
  try {
    return await binding.get();
  } catch {
    throw new Error('LP-SECRET-RESOLUTION-FAILED');
  }
}

/** Automatic reconciliation is fail-closed: only the exact deployment value enables it. */
function automaticReconciliationEnabled(env: ControllerEnv['Bindings']): boolean {
  return env.LAUNCHPAD_CONTROL_PLANE_ENABLED === 'true';
}

/**
 * Resolves typed Secrets Store bindings into the plain string bindings the
 * controller consumes. Values are fetched for every event so a store rotation
 * takes effect without waiting for an isolate restart. Resolution is parallel
 * and fails closed if any configured binding cannot be read.
 */
async function withSecrets(env: ControllerEnv['Bindings']): Promise<ControllerEnv['Bindings']> {
  const [operatorToken, operatorTokens, internalToken, vercelToken, cloudflareToken, githubToken, webhookSecret] = await Promise.all([
    resolveSecret(env.SECRETS_OPERATOR_TOKEN).then((value) => value ?? env.OPERATOR_TOKEN),
    resolveSecret(env.SECRETS_OPERATOR_TOKENS).then((value) => value ?? env.OPERATOR_TOKENS),
    resolveSecret(env.SECRETS_CONTROLLER_INTERNAL_TOKEN).then((value) => value ?? env.CONTROLLER_INTERNAL_TOKEN),
    resolveSecret(env.SECRETS_VERCEL_TOKEN).then((value) => value ?? env.VERCEL_TOKEN),
    resolveSecret(env.SECRETS_CLOUDFLARE_TOKEN).then((value) => value ?? env.CLOUDFLARE_TOKEN),
    resolveSecret(env.SECRETS_GITHUB_TOKEN).then((value) => value ?? env.GITHUB_TOKEN),
    resolveSecret(env.SECRETS_VERCEL_WEBHOOK_SECRET).then((value) => value ?? env.VERCEL_WEBHOOK_SECRET),
  ]);
  const secrets: Partial<Record<SecretName, string>> = {};
  if (operatorToken !== undefined) secrets.OPERATOR_TOKEN = operatorToken;
  if (operatorTokens !== undefined) secrets.OPERATOR_TOKENS = operatorTokens;
  if (internalToken !== undefined) secrets.CONTROLLER_INTERNAL_TOKEN = internalToken;
  if (vercelToken !== undefined) secrets.VERCEL_TOKEN = vercelToken;
  if (cloudflareToken !== undefined) secrets.CLOUDFLARE_TOKEN = cloudflareToken;
  if (githubToken !== undefined) secrets.GITHUB_TOKEN = githubToken;
  if (webhookSecret !== undefined) secrets.VERCEL_WEBHOOK_SECRET = webhookSecret;
  return { ...env, ...secrets };
}

/**
 * D1 queue persistence: every dead-lettered or permanently rejected message
 * becomes an incident row (upserted by type+fingerprint) BEFORE the message
 * is acknowledged, plus an immutable audit event. A failure to persist
 * throws, so the platform redelivers instead of acknowledging.
 */
export function createD1QueuePersistence(db: D1Database): QueuePersistence {
  const store = new D1LaunchpadStore(db);
  return {
    async recordIncident(request: IncidentRequest): Promise<void> {
      const firedAt = request.createdAt;
      await store.recordIncident({
        type: 'DLQ',
        fingerprint: `${request.queue}:${request.messageId}`,
        severity: 'critical',
        applicationId: request.applicationId,
        operationId: null,
        message: request.details.cause !== undefined ? String(request.details.cause) : `Message ${request.messageId} failed permanently on ${request.queue}.`,
        details: { queue: request.queue, messageId: request.messageId, envelopeId: request.envelopeId, kind: request.kind, attempts: request.attempts, code: request.code, errorClass: request.errorClass },
        firedAt,
      });
      await store.appendAudit({ id: `dlq:${request.queue}:${request.messageId}`, actor: 'queue:dead-letter', action: 'DLQ_INCIDENT', applicationId: request.applicationId ?? 'platform', details: { ...request }, createdAt: firedAt });
    },
  };
}

/** In-memory queue persistence mirror for local/dev paths: incident row + audit trail. */
function createAuditQueuePersistence(store: LaunchpadRepositories): QueuePersistence {
  return {
    recordIncident(request: IncidentRequest): void {
      store.recordIncident({
        type: 'DLQ',
        fingerprint: `${request.queue}:${request.messageId}`,
        severity: 'critical',
        applicationId: request.applicationId,
        operationId: null,
        message: request.details.cause !== undefined ? String(request.details.cause) : `Message ${request.messageId} failed permanently on ${request.queue}.`,
        details: { queue: request.queue, messageId: request.messageId, envelopeId: request.envelopeId, kind: request.kind, attempts: request.attempts, code: request.code, errorClass: request.errorClass },
        resolvedAt: null,
        firedAt: request.createdAt,
      });
      store.appendAudit({ actor: 'queue:dead-letter', action: 'DLQ_INCIDENT', applicationId: request.applicationId ?? 'platform', details: { ...request } });
    },
  };
}

/**
 * Creates one durable reconciliation instance for a managed application when
 * a provider-event envelope is consumed. The instance id derives from the
 * envelope id and application id, so queue redeliveries never start a second
 * instance; the reconciliation itself performs provider-backed reads and
 * never trusts payload state.
 */
async function dispatchEventReconciliation(env: ControllerEnv['Bindings'], applicationId: string, envelope: QueueEnvelope): Promise<{ instanceId: string }> {
  return createReconciliationWorkflowDispatcher(env.RECONCILE_WORKFLOW).dispatch(providerEventReconciliationParams(envelope, applicationId));
}

/**
 * Durably records the fan-out outcome as a platform-scoped audit event with a
 * deterministic id; a redelivery never appends a second row (conflict-safe).
 * A throw propagates so the message is retried instead of acknowledged.
 */
async function recordProviderEventFanout(store: D1LaunchpadStore | LaunchpadRepositories | undefined, outcome: ProviderEventFanOutcome): Promise<void> {
  if (!store) throw new Error('LP-PROVIDER-EVENT-OUTCOME-STORE-MISSING');
  const id = `provider-event-fanout:${outcome.eventId}`;
  const scope = 'platform';
  const append = async (): Promise<void> => { await store.appendAudit({ id, actor: 'queue:provider-event', action: 'PROVIDER_EVENT_FANNED_OUT', applicationId: scope, details: { eventId: outcome.eventId, type: outcome.type, applications: outcome.applications, dispatched: outcome.dispatched } }); };
  const alreadyRecorded = async (): Promise<boolean> => (await store.listAudit(scope)).some((event) => event.id === id);
  if (await alreadyRecorded()) return;
  try {
    await append();
  } catch {
    // A concurrent redelivery recorded the identical outcome first.
    if (!(await alreadyRecorded())) throw new Error('LP-PROVIDER-EVENT-OUTCOME-RECORD-FAILED');
  }
}

function queueDependencies(env: ControllerEnv['Bindings'], store: LaunchpadRepositories, observability?: ObservabilityDeps): QueueDependencies {
  const persistentStore = env.DB ? new D1LaunchpadStore(env.DB) : store;
  const httpDispatcher = createHttpQueueDispatcher({ internalUrl: env.CONTROLLER_INTERNAL_URL, internalToken: env.CONTROLLER_INTERNAL_TOKEN });
  const fanout = createProviderEventFanout({
    limit: parseProviderEventFanoutLimit(env.PROVIDER_EVENT_FANOUT_LIMIT),
    shardCount: parseProviderEventShardCount(env.PROVIDER_EVENT_SHARD_COUNT),
    enabled: automaticReconciliationEnabled(env),
    dependencies: {
      listManagedApplications: () => listApplicationIds(env),
      dispatchReconciliation: (input) => dispatchEventReconciliation(env, input.applicationId, input.envelope),
      recordOutcome: (outcome) => recordProviderEventFanout(persistentStore, outcome),
    },
  });
  return {
    // Provider-event envelopes always record their durable outcome; they fan
    // out into reconciliation workflows only while runtime automation is enabled.
    dispatch: { dispatch: async (envelope) => {
      if (envelope.kind === 'provider-event') {
        await fanout.dispatch(envelope);
      } else {
        await httpDispatcher.dispatch(envelope);
      }
    } },
    persist: env.DB ? createD1QueuePersistence(env.DB) : createAuditQueuePersistence(store),
    ...(observability?.metrics ? { metrics: observability.metrics } : {}),
  };
}

async function listApplicationIds(env: ControllerEnv['Bindings']): Promise<string[]> {
  if (env.DB) {
    const rows = await new D1LaunchpadStore(env.DB).listApplications();
    return rows.map((row) => row.application);
  }
  return repositories.listApplications().map((row) => row.application);
}

/**
 * Dispatches every cleanup job whose retention window has elapsed to the
 * internal `preview-cleanup` workflow. The workflow claims the job, deletes
 * the owned shadow project (fail-closed on ownership), and completes the job;
 * a dispatch failure leaves the job QUEUED for the next sweep, and retryable
 * deletion failures surface as FAILED jobs that later sweeps re-attempt.
 */
export async function dispatchDuePreviewCleanup(input: { store: LaunchpadStore; dispatch: (envelope: QueueEnvelope) => Promise<void>; now?: () => string; limit?: number }): Promise<{ dispatched: number; failed: number }> {
  const now = input.now ?? (() => new Date().toISOString());
  const due = await input.store.listDueCleanupJobs({ limit: input.limit ?? 50, now: now() });
  let dispatched = 0;
  let failed = 0;
  for (const job of due) {
    const resource = await input.store.getResource('vercel', job.providerResourceId);
    const envelope: QueueEnvelope = {
      version: 1,
      kind: 'preview-cleanup',
      id: stableId('cleanup-sweep', job.id),
      createdAt: now(),
      payload: {
        applicationId: job.applicationId,
        // The workflow's ownership gate parses the shadow project NAME from
        // projectId; the durable resource row maps the provider id to it.
        projectId: resource?.resourceKey ?? job.providerResourceId,
        providerResourceId: job.providerResourceId,
        reason: 'TTL_EXPIRED',
        cleanupJobId: job.id,
      },
    };
    try {
      await input.dispatch(envelope);
      dispatched += 1;
    } catch {
      // Leave the job QUEUED: the next sweep re-dispatches it.
      failed += 1;
    }
  }
  return { dispatched, failed };
}

export default {
  async fetch(request: Request, env: ControllerEnv['Bindings'], executionContext: ExecutionContext): Promise<Response> {
    const runtime = await withSecrets(env);
    const observability = buildObservability(runtime);
    const dependencies = controllerDependencies(runtime, repositories, observability);
    const configured = createControllerApp({ ...dependencies, store: env.DB ? new D1LaunchpadStore(env.DB) : undefined });
    return configured.fetch(request, env, executionContext);
  },
  async queue(batch: QueueBatch, env: ControllerEnv['Bindings']): Promise<void> {
    const runtime = await withSecrets(env);
    await handleQueue(batch, queueDependencies(runtime, repositories, buildObservability(runtime)));
  },
  async scheduled(_controller: ScheduledController, env: ControllerEnv['Bindings']): Promise<void> {
    const runtime = await withSecrets(env);
    const observability = buildObservability(runtime);
    const applicationIds = await listApplicationIds(env);
    if (automaticReconciliationEnabled(runtime)) {
      const dispatcher = createReconciliationWorkflowDispatcher(runtime.RECONCILE_WORKFLOW);
      await dispatchScheduledReconciliation({ applicationIds, shardCount: parseReconciliationShardCount(runtime.RECONCILIATION_SHARD_COUNT), dispatcher });
    } else {
      observability.logger.info('scheduled reconciliation skipped because the control plane is disabled', { step: 'scheduled/reconciliation', controlPlaneEnabled: false });
    }
    // Preview cleanup sweep: dispatch shadow-project deletions whose retention
    // window elapsed. Runs whenever D1 is configured; failures are logged,
    // never fatal to the reconciliation dispatch above.
    if (env.DB) {
      try {
        const database = env.DB as D1Database;
        const cleanupDispatcher = createHttpQueueDispatcher({ internalUrl: runtime.CONTROLLER_INTERNAL_URL, internalToken: runtime.CONTROLLER_INTERNAL_TOKEN });
        const sweep = await dispatchDuePreviewCleanup({
          store: new D1LaunchpadStore(database),
          dispatch: (envelope) => cleanupDispatcher.dispatch(envelope),
        });
        observability.logger.info('preview cleanup sweep complete', { step: 'scheduled/preview-cleanup', dispatched: sweep.dispatched, failed: sweep.failed });
      } catch (error) {
        observability.logger.error('preview cleanup sweep failed', { step: 'scheduled/preview-cleanup', errorCode: 'LP-CLEANUP-SWEEP-FAILED', message: error instanceof Error ? error.message : 'unknown' });
      }
    }
    // Failure observability pass: credential-expiry warnings (metadata only),
    // bounded metric snapshots, and the controller error-rate alert. Failures
    // here are logged, never fatal to the reconciliation dispatch above.
    try {
      const settings = alertSettingsFromEnv(runtime);
      const [expiry, snapshots, errorRate] = await Promise.all([
        checkCredentialExpiration(observability, settings.credentialExpiryWindowDays),
        (async () => {
          await refreshObservabilityGauges(observability, applicationIds);
          return snapshotMetricsToStore(observability);
        })(),
        evaluateErrorRateAlert(observability),
      ]);
      observability.logger.info('scheduled observability pass complete', { step: 'scheduled/observability', credentialExpiryChecked: expiry.checked, credentialExpiryIncidents: expiry.incidents.length, metricSnapshots: snapshots.length, errorRateIncident: errorRate?.id ?? null });
    } catch (error) {
      observability.logger.error('scheduled observability pass failed', { step: 'scheduled/observability', errorCode: 'LP-OBSERVABILITY-PASS-FAILED', message: error instanceof Error ? error.message : 'unknown' });
    }
  },
};
