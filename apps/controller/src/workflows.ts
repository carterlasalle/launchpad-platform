import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { D1Database } from '@cloudflare/workers-types';
import { WorkflowFailure, type ReconcileMode } from '@launchpad/workflows';
import { idempotencyKey } from '@launchpad/shared';
import { parseReconciliationEnvelope } from './queues.js';
import { buildObservability, recordPermanentFailure, recordRollback } from './observability.js';

interface WorkflowEnv {
  CONTROLLER_INTERNAL_URL?: string;
  CONTROLLER_INTERNAL_TOKEN?: string;
  DB?: D1Database;
  GITHUB_TOKEN?: string;
  GITHUB_BASE_URL?: string;
  LAUNCHPAD_ALERT_COOLDOWN_SECONDS?: string;
  LAUNCHPAD_ALERT_RECONCILIATION_THRESHOLD?: string;
  LAUNCHPAD_ALERT_CREDENTIAL_EXPIRY_WINDOW_DAYS?: string;
  LAUNCHPAD_ALERT_ERROR_RATE_THRESHOLD?: string;
  LAUNCHPAD_ALERTS_ENABLED?: string;
  LAUNCHPAD_LOG_LEVEL?: string;
}
interface WorkflowPayload { applicationId: string; sourceCommit?: string; planFingerprint?: string; desiredGeneration?: number; idempotencyKey?: string; version?: number; kind?: string; operationId?: string; workflowId?: string; correlationId?: string; repository?: string; prNumber?: number | string; pullRequestNumber?: number; mode?: string; [key: string]: unknown; }

/**
 * Records a terminal workflow failure through the observability pipeline
 * (provider-error row, incident row, GitHub fan-out when context exists).
 * Runs AFTER recovery/cleanup but re-throws the original error — cleanup can
 * never make the failed operation look green.
 */
async function recordWorkflowFailure(env: WorkflowEnv, payload: WorkflowPayload, error: unknown, failedStep: string | null): Promise<void> {
  const observability = buildObservability(env as Parameters<typeof buildObservability>[0]);
  await recordPermanentFailure(observability, {
    error,
    kind: payload.kind ?? 'apply',
    applicationId: payload.applicationId,
    operationId: payload.operationId ?? null,
    workflowId: payload.workflowId ?? null,
    correlationId: payload.correlationId ?? null,
    step: failedStep,
    repository: payload.repository ?? null,
    pullRequestNumber: payload.prNumber ?? payload.pullRequestNumber ?? null,
    sourceCommit: payload.sourceCommit ?? null,
    provider: payload.kind === 'reconcile' ? 'github' : payload.kind === 'apply' || payload.kind === 'preview' || payload.kind === 'app-preview' || payload.kind === 'app-preview-status' || payload.kind === 'decommission' ? 'vercel' : null,
  });
}

/**
 * Internal step dispatch is authenticated with CONTROLLER_INTERNAL_TOKEN
 * (shared controller contract). Failures come back as the typed envelope
 * `{ error: { code, message, retryable, correlationId } }` with no provider
 * bodies or secrets; the envelope is surfaced as a typed `WorkflowFailure`.
 */
async function dispatch(env: WorkflowEnv, kind: string, payload: WorkflowPayload): Promise<Record<string, unknown>> {
  if (!env.CONTROLLER_INTERNAL_URL || !env.CONTROLLER_INTERNAL_TOKEN) throw new Error('LP-WORKFLOW-DISPATCH-CONFIG-MISSING');
  const response = await fetch(`${env.CONTROLLER_INTERNAL_URL.replace(/\/$/, '')}/internal/workflows/${kind}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-launchpad-workflow-token': env.CONTROLLER_INTERNAL_TOKEN }, body: JSON.stringify(payload) });
  if (!response.ok) throw await dispatchError(response, kind);
  const value = await response.json() as unknown;
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { value };
}

async function dispatchError(response: Response, kind: string): Promise<Error> {
  try {
    const body = await response.json() as unknown;
    if (body !== null && typeof body === 'object' && 'error' in body && body.error !== null && typeof body.error === 'object') {
      const error = body.error;
      if ('code' in error && typeof error.code === 'string' && 'message' in error && typeof error.message === 'string') {
        return new WorkflowFailure(error.code, error.message, 'retryable' in error && error.retryable === true);
      }
    }
  } catch {
    // Non-JSON failure body; fall through to a stable status error.
  }
  return new Error(`LP-WORKFLOW-DISPATCH-${response.status}`);
}

/** JSON-safe failure projection carried into recovery payloads. */
function failurePayload(error: unknown): { name: string; code: string | null; message: string; retryable: boolean } {
  if (error instanceof Error) {
    let code: string | null = null;
    if ('code' in error && typeof error.code === 'string') code = error.code;
    return { name: error.name, code, message: error.message, retryable: 'retryable' in error && error.retryable === true };
  }
  return { name: 'LP-WORKFLOW-STEP-FAILED', code: null, message: 'Unknown workflow failure', retryable: false };
}

/** Pre-promotion known-good production deployment from the persisted observation. */
function knownGoodFromObserved(observed: unknown): Record<string, unknown> | null {
  if (observed === null || typeof observed !== 'object' || Array.isArray(observed) || !('deployments' in observed)) return null;
  const deployments = observed.deployments;
  if (!Array.isArray(deployments)) return null;
  for (const candidate of deployments) {
    if (candidate !== null && typeof candidate === 'object' && 'environment' in candidate && candidate.environment === 'production' && 'state' in candidate && candidate.state === 'CURRENT') {
      return candidate as Record<string, unknown>; // persisted JSON from our own observe phase; shape is the deployment contract
    }
  }
  return null;
}

/** JSON-safe decode of a dispatch output field into a plain record. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>; // decoded dispatch JSON written by our own phase handlers
}

/**
 * Apply workflow (master plan section 22.1): a granular Cloudflare Workflow
 * state machine with one deterministic `step.do` per provider mutation /
 * readback / poll / gate. Completed steps persist their outputs; a Worker
 * restart replays from the last durable boundary without duplicating writes.
 * Outputs are passed forward explicitly — never through process-global state.
 * The controller reloads the merged manifest at the exact `sourceCommit`,
 * observes live provider state, recomputes the plan, and verifies all
 * freshness bindings before the first provider write.
 */
export class ApplyApplicationWorkflow extends WorkflowEntrypoint<WorkflowEnv, WorkflowPayload> {
  async run(event: WorkflowEvent<WorkflowPayload>, step: WorkflowStep): Promise<Record<string, unknown>> {
    const payload: WorkflowPayload = { ...event.payload, workflowId: event.instanceId };
    let currentStep = 'validate-request';
    // The phase id (not the human step name) is the durable failure contract:
    // recover-on-failure keys its rollback policy on 'production-health'.
    const execute = (phase: string, name: string, body: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> => {
      currentStep = phase;
      return step.do(name, body);
    };

    let candidate: Record<string, unknown> | null = null;
    let productionHealth: Record<string, unknown> | null = null;
    let desired: Record<string, unknown> | null = null;
    let live: Record<string, unknown> | null = null;
    let locks: Record<string, unknown> | null = null;

    try {
      await execute('validate-request', 'validate apply request', async () => {
        if (payload.version !== 1 || payload.kind !== 'apply') throw new WorkflowFailure('LP-WORKFLOW-APPLY-PAYLOAD-INVALID', 'Invalid apply payload version or kind.');
        return dispatch(this.env, 'apply/validate-request', payload);
      });
      const loaded = await execute('load-desired', 'load merged desired from source commit', () => dispatch(this.env, 'apply/load-desired', payload));
      desired = asRecord(loaded.desired);
      live = await execute('observe-live-state', 'observe live provider state', () => dispatch(this.env, 'apply/observe-live-state', { ...payload, desired }));
      const observed = asRecord(live.observed);
      if (observed === null) throw new WorkflowFailure('LP-WORKFLOW-OBSERVE-OUTPUT-INVALID', 'Observe phase returned no observed state.');
      const capabilities = asRecord(live.capabilities);
      if (capabilities === null) throw new WorkflowFailure('LP-WORKFLOW-OBSERVE-OUTPUT-INVALID', 'Observe phase returned no capability snapshot.');
      const replan = await execute('replan-verify', 'rebuild plan and verify freshness', () => dispatch(this.env, 'apply/replan-verify', { ...payload, desired, observed, capabilities }));
      await execute('no-destroy-gate', 'reject destructive operations', () => dispatch(this.env, 'apply/no-destroy-gate', { ...payload, plan: replan.plan }));
      const acquired = await execute('acquire-locks', 'acquire application and domain locks', () => dispatch(this.env, 'apply/acquire-locks', { ...payload, desired }));
      locks = asRecord(acquired.locks);

      await execute('ensure-project', 'ensure project', () => dispatch(this.env, 'apply/ensure-project', { ...payload, desired, plan: replan.plan, locks }));
      await execute('ensure-git', 'connect git repository', () => dispatch(this.env, 'apply/ensure-git', { ...payload, desired, plan: replan.plan, locks }));
      await execute('ensure-settings', 'verify project settings', () => dispatch(this.env, 'apply/ensure-settings', { ...payload, desired, plan: replan.plan, locks }));
      const secrets = await execute('resolve-secrets', 'resolve secret fingerprints', () => dispatch(this.env, 'apply/resolve-secrets', { ...payload, desired }));
      await execute('ensure-environments', 'ensure production environment', () => dispatch(this.env, 'apply/ensure-environments', { ...payload, desired, plan: replan.plan, locks, bindings: secrets.bindings }));
      await execute('ensure-domains', 'attach project domains', () => dispatch(this.env, 'apply/ensure-domains', { ...payload, desired, plan: replan.plan, locks }));
      await execute('ensure-dns', 'ensure cloudflare dns records', () => dispatch(this.env, 'apply/ensure-dns', { ...payload, desired, plan: replan.plan, locks }));
      await execute('verify-authoritative', 'verify authoritative dns', () => dispatch(this.env, 'apply/verify-authoritative', { ...payload, desired }));
      await execute('verify-vercel-domain', 'verify vercel domain', () => dispatch(this.env, 'apply/verify-vercel-domain', { ...payload, desired }));
      await execute('verify-tls', 'verify tls readiness', () => dispatch(this.env, 'apply/verify-tls', { ...payload, desired }));
      const created = await execute('create-candidate', 'create staged production candidate', () => dispatch(this.env, 'apply/create-candidate', { ...payload, desired, plan: replan.plan, locks }));
      const ready = await execute('wait-candidate', 'wait for terminal build and capture logs', () => dispatch(this.env, 'apply/wait-candidate', { ...payload, desired, candidate: created.candidate }));
      candidate = asRecord(ready.candidate);
      await execute('proxy-compatibility', 'verify cloudflare proxy compatibility', () => dispatch(this.env, 'apply/proxy-compatibility', { ...payload, desired, candidate: ready.candidate }));
      const candidateHealth = await execute('candidate-health', 'check candidate health', () => dispatch(this.env, 'apply/candidate-health', { ...payload, desired, candidate: ready.candidate }));
      const promotion = await execute('promote', 'promote exact candidate', () => dispatch(this.env, 'apply/promote', { ...payload, desired, plan: replan.plan, locks, candidate: ready.candidate }));
      const promoted = asRecord(promotion.promotion);
      if (promoted === null) throw new WorkflowFailure('LP-WORKFLOW-PROMOTE-OUTPUT-INVALID', 'Promotion phase returned no promotion result.');
      const deployment = asRecord(promoted.deployment);
      if (deployment === null) throw new WorkflowFailure('LP-WORKFLOW-PROMOTE-OUTPUT-INVALID', 'Promotion phase returned no deployment record.');
      candidate = deployment;
      const production = await execute('production-health', 'check production health', () => dispatch(this.env, 'apply/production-health', { ...payload, desired, candidate: deployment }));
      productionHealth = asRecord(production.health);
      await execute('record-known-good', 'record known-good deployment', () => dispatch(this.env, 'apply/record-known-good', { ...payload, desired, candidate: deployment, productionHealth }));
      const summary = {
        applicationId: payload.applicationId,
        sourceCommit: payload.sourceCommit,
        desiredGeneration: payload.desiredGeneration,
        planFingerprint: payload.planFingerprint,
        candidateId: deployment.id,
        candidateHealth,
        productionHealth,
        status: 'SUCCEEDED',
        errorCode: null,
        rollback: null,
        restored: false,
      };
      const report = await execute('report', 'report apply result', () => dispatch(this.env, 'apply/report', { ...payload, summary }));
      await execute('release-locks', 'release locks', () => dispatch(this.env, 'apply/release-locks', { ...payload, locks }));
      return { status: 'SUCCEEDED', workflowId: event.instanceId, operationId: payload.operationId ?? null, ...report };
    } catch (error) {
      const failedStep = currentStep;
      const knownGood = live !== null ? knownGoodFromObserved(live.observed) : null;
      if (desired !== null && locks !== null) {
        const recovered = await step.do('restore previous known-good when policy permits', () => dispatch(this.env, 'apply/recover-on-failure', { ...payload, desired, candidate, knownGood, productionHealth, failure: { failedStep, error: failurePayload(error) } }));
        recordRollback(buildObservability(this.env as Parameters<typeof buildObservability>[0]), { applicationId: payload.applicationId, kind: 'apply', recovery: recovered });
        await step.do('release locks after failure', () => dispatch(this.env, 'apply/release-locks', { ...payload, locks }));
      } else if (locks !== null) {
        await step.do('release locks after failure', () => dispatch(this.env, 'apply/release-locks', { ...payload, locks }));
      }
      // The original failure is recorded and re-thrown AFTER recovery:
      // successful cleanup/rollback never turns the operation green.
      await recordWorkflowFailure(this.env, payload, error, failedStep);
      throw error;
    }
  }
}

/** Granular preview stages (22.2): each maps to one durable store-backed step and one `step.do` boundary. */
const PREVIEW_STAGES = ['validate', 'supersede', 'create-shadow-project', 'apply-settings', 'create-deployment', 'wait-for-build', 'collect-build-logs', 'build-gate', 'health-check', 'report', 'schedule-cleanup'] as const;

export class PreviewApplicationWorkflow extends WorkflowEntrypoint<WorkflowEnv, WorkflowPayload> {
  async run(event: WorkflowEvent<WorkflowPayload>, step: WorkflowStep): Promise<Record<string, unknown>> {
    try {
      const validated = await step.do('validate preview request', async () => { if (!event.payload.applicationId || !event.payload.sourceCommit) throw new Error('LP-WORKFLOW-PREVIEW-PAYLOAD-INVALID'); return event.payload; });
      const results: Record<string, unknown> = {};
      for (const stage of PREVIEW_STAGES) {
        results[stage] = await step.do(`preview ${stage}`, async () => dispatch(this.env, 'preview', { ...validated, stage }));
      }
      return results;
    } catch (error) {
      await recordWorkflowFailure(this.env, event.payload, error, 'preview');
      throw error;
    }
  }
}

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Versioned app-preview-status machine: the durable home of the exact-commit
 * preview gate (`runAppPreviewStatusWorkflow`). A dedicated
 * `APP_PREVIEW_STATUS_WORKFLOW` binding routes it here — never to the
 * shadow-preview machine. The versioned envelope is validated before any
 * dispatch: malformed payloads fail closed with zero provider/internal
 * traffic, and the handler call is the single durable `step.do` boundary
 * (the workflow itself persists every gate sub-step through the D1 store).
 */
export class AppPreviewStatusWorkflow extends WorkflowEntrypoint<WorkflowEnv, WorkflowPayload> {
  async run(event: WorkflowEvent<WorkflowPayload>, step: WorkflowStep): Promise<Record<string, unknown>> {
    try {
      const validated = await step.do('validate app-preview-status payload', async () => {
        const payload: WorkflowPayload = event.payload;
        if (payload.version !== 1 || payload.kind !== 'app-preview-status') throw new Error('LP-WORKFLOW-APP-PREVIEW-STATUS-PAYLOAD-INVALID');
        if (typeof payload.applicationId !== 'string' || payload.applicationId.length === 0) throw new Error('LP-WORKFLOW-APP-PREVIEW-STATUS-PAYLOAD-INVALID');
        if (typeof payload.sourceCommit !== 'string' || !COMMIT_SHA_PATTERN.test(payload.sourceCommit)) throw new Error('LP-WORKFLOW-APP-PREVIEW-STATUS-PAYLOAD-INVALID');
        if (typeof payload.repository !== 'string' || payload.repository.length === 0) throw new Error('LP-WORKFLOW-APP-PREVIEW-STATUS-PAYLOAD-INVALID');
        if (typeof payload.event !== 'string' || payload.event.length === 0) throw new Error('LP-WORKFLOW-APP-PREVIEW-STATUS-PAYLOAD-INVALID');
        if (payload.repositoryId === undefined || payload.repositoryId === null || payload.ownerId === undefined || payload.ownerId === null) throw new Error('LP-WORKFLOW-APP-PREVIEW-STATUS-PAYLOAD-INVALID');
        return payload;
      });
      return await step.do('run app-preview-status workflow', async () => dispatch(this.env, 'app-preview-status', { ...validated, workflowId: event.instanceId }));
    } catch (error) {
      await recordWorkflowFailure(this.env, event.payload, error, 'app-preview-status');
      throw error;
    }
  }
}

/** Granular reconciliation stages (22.3): each maps to one durable store-backed step and one `step.do` boundary. */
const RECONCILE_STAGES = ['resolve-main', 'load-desired', 'observe-live-state', 'diff-plan', 'persist-status', 'open-or-update-pr', 'report'] as const;

/** Envelope boundary for the reconciliation mode: default open-pr; auto-restore stays disabled. */
function reconcileModeOf(raw: unknown): ReconcileMode {
  if (raw === 'auto-restore') throw new WorkflowFailure('LP-RECONCILIATION-AUTO-RESTORE-DISABLED', 'Silent automatic restore during reconciliation is disabled; drift is resolved through reviewable PRs.');
  return raw === 'adopt-observed-state' || raw === 'restore-desired-state' ? raw : 'open-pr';
}

export class ReconcileApplicationWorkflow extends WorkflowEntrypoint<WorkflowEnv, WorkflowPayload> {
  async run(event: WorkflowEvent<WorkflowPayload>, step: WorkflowStep): Promise<Record<string, unknown>> {
    try {
      const validated = await step.do('validate reconciliation envelope', async () => parseReconciliationEnvelope(event.payload));
      const base: WorkflowPayload = {
        applicationId: validated.applicationId,
        ...(validated.sourceCommit !== undefined ? { sourceCommit: validated.sourceCommit } : {}),
        shard: validated.shard,
        shardCount: validated.shardCount,
        triggeredAt: validated.triggeredAt,
        mode: reconcileModeOf(event.payload.mode),
        idempotencyKey: idempotencyKey('reconcile', validated.applicationId, validated.triggeredAt, String(validated.shard), String(validated.shardCount)),
        workflowId: event.instanceId,
      };
      const payload = (extra: Record<string, unknown>): WorkflowPayload => ({ ...base, ...extra });
      const results: Record<string, unknown> = {};

      results['resolve-main'] = await step.do('resolve control-repo main commit', () => dispatch(this.env, 'reconcile/resolve-main', payload({})));
      const resolved = results['resolve-main'] as Record<string, unknown>;
      const sourceCommit = typeof resolved.sourceCommit === 'string' && resolved.sourceCommit.length > 0 ? resolved.sourceCommit : undefined;
      // Every later phase receives the resolved protected main SHA so the PR
      // base, manifest reads, and request document all reference one commit.
      const forward = payload(sourceCommit !== undefined ? { sourceCommit } : {});
      results['load-desired'] = await step.do('load desired manifest at main', () => dispatch(this.env, 'reconcile/load-desired', forward));
      const loaded = results['load-desired'] as Record<string, unknown>;
      results['observe-live-state'] = await step.do('observe live provider state', () => dispatch(this.env, 'reconcile/observe-live-state', payload({ ...(sourceCommit !== undefined ? { sourceCommit } : {}), desired: loaded.desired ?? null })));
      const live = results['observe-live-state'] as Record<string, unknown>;
      results['diff-plan'] = await step.do('compute planner drift', () => dispatch(this.env, 'reconcile/diff-plan', payload({
        ...(sourceCommit !== undefined ? { sourceCommit } : {}),
        desired: loaded.desired ?? null,
        observed: live.observed ?? null,
        capabilities: live.capabilities ?? null,
        accessErrors: live.accessErrors ?? [],
        manifestError: loaded.manifestError ?? null,
      })));
      const diff = results['diff-plan'] as Record<string, unknown>;
      results['persist-status'] = await step.do('persist status and drift event', () => dispatch(this.env, 'reconcile/persist-status', payload({ ...(sourceCommit !== undefined ? { sourceCommit } : {}), diff, observed: live.observed ?? null })));
      results['open-or-update-pr'] = await step.do('open or update reconciliation pr', () => dispatch(this.env, 'reconcile/open-or-update-pr', payload({ ...(sourceCommit !== undefined ? { sourceCommit } : {}), diff, desired: loaded.desired ?? null, observed: live.observed ?? null, rawManifest: loaded.rawManifest ?? null })));
      results['report'] = await step.do('report reconciliation result', () => dispatch(this.env, 'reconcile/report', payload({ ...(sourceCommit !== undefined ? { sourceCommit } : {}), diff, pr: results['open-or-update-pr'] })));
      return { status: 'SUCCEEDED', workflowId: event.instanceId, ...results };
    } catch (error) {
      await recordWorkflowFailure(this.env, event.payload, error, 'reconcile');
      throw error;
    }
  }
}

export class DecommissionApplicationWorkflow extends WorkflowEntrypoint<WorkflowEnv, WorkflowPayload> {
  async run(event: WorkflowEvent<WorkflowPayload>, step: WorkflowStep): Promise<Record<string, unknown>> {
    try {
      const validated = await step.do('validate decommission request', async () => {
        const payload: WorkflowPayload = event.payload;
        if (!payload.applicationId || !payload.idempotencyKey) throw new Error('LP-WORKFLOW-DECOMMISSION-PAYLOAD-INVALID');
        if (typeof payload.approvalId !== 'string' || payload.approvalId.length === 0) throw new Error('LP-WORKFLOW-DECOMMISSION-PAYLOAD-INVALID');
        if (typeof payload.approvalToken !== 'string' || payload.approvalToken.length === 0) throw new Error('LP-WORKFLOW-DECOMMISSION-PAYLOAD-INVALID');
        if (typeof payload.sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(payload.sourceCommit)) throw new Error('LP-WORKFLOW-DECOMMISSION-PAYLOAD-INVALID');
        if (typeof payload.domain !== 'string' || payload.domain.length === 0) throw new Error('LP-WORKFLOW-DECOMMISSION-PAYLOAD-INVALID');
        return payload;
      });
      // The destroy machine persists every ordered teardown step through D1 and
      // resumes from the last durable boundary when the instance is replayed.
      return step.do('execute durable destroy', async () => dispatch(this.env, 'decommission/destroy', { ...validated, workflowId: event.instanceId }));
    } catch (error) {
      await recordWorkflowFailure(this.env, event.payload, error, 'decommission');
      throw error;
    }
  }
}
