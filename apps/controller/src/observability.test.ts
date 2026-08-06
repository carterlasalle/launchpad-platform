import { describe, expect, it } from 'vitest';
import { DurableOperationRunner, type DurableStep } from '@launchpad/workflows';
import { InMemoryLaunchpadStore, type LaunchpadStore } from '@launchpad/database';
import { LaunchpadLogger, MetricsRegistry, SensitiveValue, scanCanary, defaultAlertConfigs } from '@launchpad/shared';
import { createControllerApp } from './api.js';
import { buildAlertConfigs, checkCredentialExpiration, evaluateErrorRateAlert, recordPermanentFailure, snapshotMetricsToStore, type ObservabilityDeps } from './observability.js';
import { DEAD_LETTER_QUEUE, createQueueEnvelope, handleQueue, type QueueBatch, type QueueMessage, type QueuePersistence } from './queues.js';

const T0 = new Date('2026-08-04T08:00:00.000Z');
const canary = 'launchpad-canary-e71a';

/** Builds a classified provider-style failure error with a stable code and retryable flag. */
function failingError(code: string, message: string, retryable: boolean): Error & { retryable: boolean } {
  const error = Object.assign(new Error(message), { retryable });
  error.name = code;
  return error;
}

function deps(store: LaunchpadStore, overrides: Partial<ObservabilityDeps> = {}): ObservabilityDeps {
  return {
    store,
    logger: new LaunchpadLogger({ level: 'debug', sink: () => undefined }),
    metrics: new MetricsRegistry({ now: () => T0 }),
    alertConfigs: buildAlertConfigs({}),
    now: () => T0,
    ...overrides,
  };
}

function seededStore(): InMemoryLaunchpadStore {
  const store = new InMemoryLaunchpadStore({ now: () => T0 });
  void store.upsertApplication({ id: 'app-demo', displayName: 'Demo', sourcePath: 'catalog/apps/demo', desiredGeneration: 1, desiredHash: 'h', syncStatus: 'SYNCED', healthStatus: 'HEALTHY', lifecycleState: 'active' });
  return store;
}

function storePersistence(store: LaunchpadStore): QueuePersistence {
  return {
    async recordIncident(request) {
      await store.recordIncident({ type: 'DLQ', fingerprint: `${request.queue}:${request.messageId}`, severity: 'critical', applicationId: request.applicationId, message: String(request.details.cause ?? 'dropped'), details: { queue: request.queue, messageId: request.messageId, attempts: request.attempts, code: request.code, errorClass: request.errorClass }, firedAt: request.createdAt });
      await store.appendAudit({ actor: 'queue:dead-letter', action: 'DLQ_INCIDENT', applicationId: request.applicationId ?? 'platform', details: { ...request } });
    },
  };
}

function batch(queue: string, messages: QueueMessage[]): QueueBatch & { outcome: () => { acked: string[]; retried: string[] } } {
  const acked: string[] = [];
  const retried: string[] = [];
  return {
    queue,
    messages,
    ack: (message) => acked.push(message.id),
    retry: (message) => retried.push(message.id),
    outcome: () => ({ acked, retried }),
  };
}

describe('recordPermanentFailure', () => {
  it('persists a typed durable record for a forced permanent provider failure', async () => {
    const store = seededStore();
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    const metrics = new MetricsRegistry({ now: () => T0 });
    const observability = deps(store, {
      metrics,
      github: {
        token: 'ghp-test',
        fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
          fetchCalls.push({ url: String(input), init: init ?? {} });
          const body = init?.method === 'GET' || init?.method === undefined ? [] : { id: 1 };
          return new Response(JSON.stringify(body), { status: 200 });
        }) as unknown as typeof fetch,
      },
    });
    const error = failingError('LP-VERCEL-TIMEOUT', 'upstream timed out after 30s', false);

    const result = await recordPermanentFailure(observability, {
      error,
      kind: 'apply',
      applicationId: 'app-demo',
      operationId: 'op-1',
      workflowId: 'wf-1',
      correlationId: 'corr-1',
      step: 'wait-candidate',
      provider: 'vercel',
      repository: 'acme/web-app',
      pullRequestNumber: 42,
      sourceCommit: 'a'.repeat(40),
    });

    expect(result.providerError).toMatchObject({ applicationId: 'app-demo', operationId: 'op-1', provider: 'vercel', code: 'LP-VERCEL-TIMEOUT', class: 'INTERNAL', retryable: false });
    expect(result.providerError?.remediation.length).toBeGreaterThan(0);
    expect(result.incident).toMatchObject({ type: 'CONTROLLER_ERROR_RATE', severity: 'critical', applicationId: 'app-demo', operationId: 'op-1' });
    expect((await store.listProviderErrors('app-demo'))[0]?.code).toBe('LP-VERCEL-TIMEOUT');
    const incident = await store.getIncident('CONTROLLER_ERROR_RATE', result.incident!.fingerprint);
    expect(incident).not.toBeNull();
    expect(incident?.delivery).toMatchObject({ comment: { delivered: true }, commitStatus: { delivered: true } });
    expect((await store.listAudit('app-demo')).some((event) => event.action === 'INCIDENT_FIRED')).toBe(true);
    // GitHub fan-out happened: sticky comment list + write, commit status.
    expect(fetchCalls.some((call) => call.url.includes('/issues/42/comments'))).toBe(true);
    expect(fetchCalls.some((call) => call.url.includes('/statuses/'))).toBe(true);
    // Failure metric recorded.
    expect(metrics.snapshot().find((entry) => entry.metric === 'failures')?.total).toBe(1);
  });

  it('deduplicates refires within the cooldown window and reopens after it', async () => {
    let current = new Date('2026-08-04T08:00:00.000Z');
    const store = seededStore();
    const observability = deps(store, { now: () => current });
    const error = Object.assign(new Error('reconcile failed'), { name: 'LP-RECONCILE-FAILED', retryable: false });

    await recordPermanentFailure(observability, { error, kind: 'reconcile', applicationId: 'app-demo' });
    const incident = await store.getIncident('RECONCILIATION_FAILURE', (await store.listIncidents())[0]!.fingerprint);
    expect(incident).not.toBeNull();
    const firstFiredAt = incident!.lastFiredAt;

    // Same fingerprint within cooldown: no new fire (row and audit unchanged).
    await recordPermanentFailure(observability, { error, kind: 'reconcile', applicationId: 'app-demo' });
    const afterDedupe = await store.getIncident('RECONCILIATION_FAILURE', incident!.fingerprint);
    expect(afterDedupe?.lastFiredAt).toBe(firstFiredAt);
    expect((await store.listAudit('app-demo')).filter((event) => event.action === 'INCIDENT_FIRED')).toHaveLength(1);

    // After the cooldown elapses: refire reopens the same row.
    current = new Date(current.getTime() + 7200_000);
    await recordPermanentFailure(observability, { error, kind: 'reconcile', applicationId: 'app-demo' });
    const refired = await store.getIncident('RECONCILIATION_FAILURE', incident!.fingerprint);
    expect(refired?.lastFiredAt).toBe(current.toISOString());
    expect(refired?.firstSeenAt).toBe(firstFiredAt);
    expect(refired?.resolvedAt).toBeNull();
    expect((await store.listAudit('app-demo')).filter((event) => event.action === 'INCIDENT_FIRED')).toHaveLength(2);
  });

  it('counts consecutive reconciliation failures and fires only at the threshold', async () => {
    let current = new Date('2026-08-04T08:00:00.000Z');
    const store = seededStore();
    const observability = deps(store, { now: () => current, alertConfigs: [{ type: 'RECONCILIATION_FAILURE', enabled: true, cooldownSeconds: 0, threshold: 3 }] });
    const error = Object.assign(new Error('reconcile transient failure'), { name: 'LP-RECONCILE-RETRYABLE', retryable: true });

    await recordPermanentFailure(observability, { error, kind: 'reconcile', applicationId: 'app-demo' });
    await recordPermanentFailure(observability, { error, kind: 'reconcile', applicationId: 'app-demo' });
    // Below threshold: one tracking row, no fired alert.
    const tracking = await store.listIncidents();
    expect(tracking).toHaveLength(1);
    expect(tracking[0]?.details.consecutiveFailures).toBe(2);
    expect((await store.listAudit('app-demo')).filter((event) => event.action === 'INCIDENT_FIRED')).toHaveLength(0);

    current = new Date(current.getTime() + 1000);
    await recordPermanentFailure(observability, { error, kind: 'reconcile', applicationId: 'app-demo' });
    const incidents = await store.listIncidents();
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.details.consecutiveFailures).toBe(3);
    expect((await store.listAudit('app-demo')).filter((event) => event.action === 'INCIDENT_FIRED')).toHaveLength(1);
  });

  it('never leaks canary secrets through logs, rows, comments, or audit details', async () => {
    const store = seededStore();
    const lines: string[] = [];
    const commentBodies: string[] = [];
    const observability = deps(store, {
      logger: new LaunchpadLogger({ sink: (line) => lines.push(line) }),
      github: {
        token: 'ghp-test',
        fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (init?.method === 'GET' || init?.method === undefined) return new Response('[]', { status: 200 });
          if (init?.method === 'PATCH' || init?.method === 'POST') {
            if (url.includes('/comments')) commentBodies.push(String(init.body ?? ''));
          }
          return new Response('{}', { status: 200 });
        }) as unknown as typeof fetch,
      },
    });
    const error = Object.assign(new Error(`token=${canary}`), { name: 'LP-CANARY-FAILED', retryable: false });
    const sensitiveError = Object.assign(new Error('sensitive failure'), { name: 'LP-SENSITIVE', details: { token: new SensitiveValue(canary) } });

    await recordPermanentFailure(observability, { error, kind: 'apply', applicationId: 'app-demo', repository: 'acme/web-app', pullRequestNumber: 7, sourceCommit: 'b'.repeat(40) });
    await recordPermanentFailure(observability, { error: sensitiveError, kind: 'apply', applicationId: 'app-demo' });

    const providerErrors = await store.listProviderErrors('app-demo');
    const incidents = await store.listIncidents();
    const audit = await store.listAudit('app-demo');
    const sweep = await scanCanary({ lines, providerErrors, incidents, audit, commentBodies }, [canary]);
    expect(sweep.leaked).toBe(false);
    expect(sweep.matches).toEqual([]);
  });
});

describe('queue DLQ incident rows', () => {
  it('creates an incident row before acknowledging a dead-lettered message', async () => {
    const store = seededStore();
    const metrics = new MetricsRegistry({ now: () => T0 });
    const message: QueueMessage = { id: 'dlq-1', body: createQueueEnvelope({ kind: 'provider-event', id: 'evt-1', payload: { applicationId: 'app-demo' }, now: T0 }), attempts: 6 };
    const queueBatch = batch(DEAD_LETTER_QUEUE, [message]);
    const outcome = await handleQueue(queueBatch, { persist: storePersistence(store), now: () => T0, metrics });
    expect(outcome).toEqual({ acknowledged: 1, retried: 0, incidents: 1 });
    expect(queueBatch.outcome().acked).toEqual(['dlq-1']);
    const incident = await store.getIncident('DLQ', `launchpad-dead-letter:dlq-1`);
    expect(incident).toMatchObject({ type: 'DLQ', severity: 'critical', applicationId: 'app-demo' });
    expect(incident?.details).toMatchObject({ queue: 'launchpad-dead-letter', messageId: 'dlq-1', code: 'LP-QUEUE-RETRY-EXHAUSTED', errorClass: 'permanent' });
    expect((await store.listAudit('app-demo')).some((event) => event.action === 'DLQ_INCIDENT')).toBe(true);
    const snapshot = metrics.snapshot();
    expect(snapshot.find((entry) => entry.metric === 'dlq_count')?.total).toBe(1);
    expect(snapshot.find((entry) => entry.metric === 'failures')?.total).toBe(1);
  });

  it('retries transient failures without an incident row and records retries', async () => {
    const store = seededStore();
    const metrics = new MetricsRegistry({ now: () => T0 });
    const message: QueueMessage = { id: 'm1', body: createQueueEnvelope({ kind: 'provider-event', id: 'evt-1', payload: { applicationId: 'app-demo' }, now: T0 }), attempts: 1 };
    const queueBatch = batch('launchpad-provider-events', [message]);
    const outcome = await handleQueue(queueBatch, {
      persist: storePersistence(store),
      now: () => T0,
      metrics,
      dispatch: { dispatch: async () => { throw new Error('LP-QUEUE-DISPATCH-RETRYABLE'); } },
    });
    expect(outcome).toEqual({ acknowledged: 0, retried: 1, incidents: 0 });
    expect(queueBatch.outcome().retried).toEqual(['m1']);
    expect(await store.listIncidents()).toHaveLength(0);
    expect(metrics.snapshot().find((entry) => entry.metric === 'retries')?.total).toBe(1);
  });
});

describe('rollback and cleanup cannot turn a failed operation green', () => {
  it('keeps the run FAILED with its error code even when recovery and lock release succeed', async () => {
    const store = seededStore();
    const failingStep: DurableStep = {
      id: 'promote',
      preconditionHash: 'hash-1',
      run: async () => {
        throw failingError('LP-VERCEL-PROMOTE-REJECTED', 'promotion rejected', false);
      },
    };
    const recovery: DurableStep = {
      id: 'recover-on-failure',
      preconditionHash: 'hash-recovery',
      run: async () => ({ rollback: { deploymentId: 'dep-known-good', restored: true } }),
    };
    const runner = new DurableOperationRunner(store);
    const result = await runner.run({
      applicationId: 'app-demo',
      workflowId: 'wf-rollback',
      action: 'APPLY',
      idempotencyKey: 'idem-rollback',
      payloadHash: 'payload-1',
      steps: [failingStep],
      onFailure: async () => recovery.run(1, { outputs: {} }),
      releaseLocks: async () => undefined,
      sleep: async () => undefined,
    });
    expect(result.status).toBe('FAILED');
    expect(result.failedStep).toBe('promote');
    expect(result.recovery).toEqual({ rollback: { deploymentId: 'dep-known-good', restored: true } });
    const run = await store.getWorkflowRun(result.operationId);
    expect(run?.status).toBe('FAILED');
    expect(run?.errorCode).toBe('LP-VERCEL-PROMOTE-REJECTED');
    // Recovery and lock-release steps are recorded without flipping the run.
    const steps = await store.listWorkflowSteps(result.operationId);
    expect(steps.find((step) => step.stepId === 'recover-on-failure')?.status).toBe('SUCCEEDED');
    expect(steps.find((step) => step.stepId === 'release-locks')?.status).toBe('SUCCEEDED');
  });
});

describe('webhook dedupe and replay records', () => {
  function webhookApp() {
    const store = seededStore();
    const app = createControllerApp({ operatorToken: 'op-token', webhookSecret: 'wh-secret', store, logger: new LaunchpadLogger({ sink: () => undefined }) });
    return { app, store };
  }

  async function sign(payload: string): Promise<string> {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('wh-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
    return `sha256=${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }

  it('accepts the first delivery, deduplicates the replay, and records both', async () => {
    const { app, store } = webhookApp();
    const sent: unknown[] = [];
    const env = { PROVIDER_EVENTS: { send: async (envelope: unknown) => { sent.push(envelope); } } };
    // The HMAC-covered payload carries the event creation time (epoch ms); a
    // fresh timestamp keeps the event inside the default freshness window.
    const payload = JSON.stringify({ id: 'evt-1', type: 'deployment', createdAt: Date.now(), deployment: { id: 'dep-1', token: 'launchpad-canary-e71a' } });
    const signature = await sign(payload);

    const first = await app.request('/webhooks/vercel', { method: 'POST', body: payload, headers: { 'content-type': 'application/json', 'x-vercel-signature': signature } }, env as never);
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ accepted: true, deduplicated: false });

    const replay = await app.request('/webhooks/vercel', { method: 'POST', body: payload, headers: { 'content-type': 'application/json', 'x-vercel-signature': signature } }, env as never);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ accepted: true, deduplicated: true });

    // Exactly one sanitized envelope is enqueued; the raw body never survives.
    expect(sent).toHaveLength(1);
    const envelope = sent[0] as { kind: string; id: string; payload: Record<string, unknown> };
    expect(envelope).toMatchObject({ kind: 'provider-event', id: 'webhook:vercel:evt-1', payload: { eventId: 'evt-1', type: 'deployment', deploymentId: 'dep-1' } });
    expect(JSON.stringify(sent)).not.toContain('launchpad-canary-e71a');

    const audit = await store.listAuditAll();
    expect(audit.filter((event) => event.action === 'WEBHOOK_RECEIVED')).toHaveLength(1);
    expect(audit.filter((event) => event.action === 'WEBHOOK_DEDUPLICATED')).toHaveLength(1);
    expect((await store.getWebhookReceipt('vercel', 'evt-1'))?.payload).toEqual({ eventId: 'evt-1', type: 'deployment', deploymentId: 'dep-1' });
    expect(JSON.stringify((await store.getWebhookReceipt('vercel', 'evt-1'))?.payload)).not.toContain('launchpad-canary-e71a');
  });

  it('rejects invalid signatures and refuses to accept without durable persistence', async () => {
    const { app } = webhookApp();
    const bad = await app.request('/webhooks/vercel', { method: 'POST', body: '{"id":"evt-2"}', headers: { 'x-vercel-signature': 'sha256=deadbeef' } });
    expect(bad.status).toBe(401);

    const storeless = createControllerApp({ operatorToken: 'op-token', webhookSecret: 'wh-secret' });
    const createdAt = Date.now();
    const body = `{"id":"evt-3","createdAt":${createdAt}}`;
    const signature = await sign(body);
    const noStore = await storeless.request('/webhooks/vercel', { method: 'POST', body, headers: { 'x-vercel-signature': signature } });
    expect(noStore.status).toBe(503);
  });
});

describe('credential expiry, metrics snapshots, and error-rate alerts', () => {
  it('marks credentials expiring/expired and fires deduped CREDENTIAL_EXPIRY incidents without reading secrets', async () => {
    let current = new Date('2026-08-04T08:00:00.000Z');
    const store = new InMemoryLaunchpadStore({ now: () => current });
    await store.upsertCredentialMetadata({ id: 'cred-vercel', provider: 'vercel', purpose: 'read-write-token', expiresAt: '2026-08-10T00:00:00.000Z', lastCheckedAt: '2026-08-01T00:00:00.000Z', status: 'VALID' });
    await store.upsertCredentialMetadata({ id: 'cred-cf', provider: 'cloudflare', purpose: 'dns-token', expiresAt: '2026-08-01T00:00:00.000Z', lastCheckedAt: '2026-08-01T00:00:00.000Z', status: 'VALID' });
    await store.upsertCredentialMetadata({ id: 'cred-gh', provider: 'github', purpose: 'pr-token', expiresAt: '2026-12-31T00:00:00.000Z', lastCheckedAt: '2026-08-01T00:00:00.000Z', status: 'VALID' });

    const observability = deps(store, { now: () => current });
    const first = await checkCredentialExpiration(observability, 14);
    expect(first.checked).toBe(3);
    expect(first.incidents).toHaveLength(2);
    expect((await store.getCredentialMetadata('cred-vercel'))?.status).toBe('EXPIRING_SOON');
    expect((await store.getCredentialMetadata('cred-cf'))?.status).toBe('EXPIRED');
    expect((await store.getCredentialMetadata('cred-gh'))?.status).toBe('VALID');

    // Within cooldown: no duplicate incidents.
    const second = await checkCredentialExpiration(observability, 14);
    expect(second.incidents).toHaveLength(0);
    expect(await store.listIncidents({ type: 'CREDENTIAL_EXPIRY' })).toHaveLength(2);
  });

  it('persists bounded metric snapshots and queries them', async () => {
    const store = seededStore();
    const metrics = new MetricsRegistry({ now: () => T0 });
    metrics.increment('successes', { workflow: 'apply', provider: 'vercel' });
    metrics.increment('failures', { workflow: 'apply' });
    const rows = await snapshotMetricsToStore(deps(store, { metrics }));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const listed = await store.listMetricSnapshots();
    expect(listed.length).toBe(rows.length);
    expect(listed.find((row) => row.metric === 'successes')?.labels).toEqual({ workflow: 'apply', provider: 'vercel' });
  });

  it('fires the error-rate alert only when the threshold is met', async () => {
    const store = seededStore();
    const quiet = deps(store);
    quiet.metrics?.increment('successes');
    expect(await evaluateErrorRateAlert(quiet)).toBeNull();

    const loud = deps(store, { alertConfigs: [{ type: 'CONTROLLER_ERROR_RATE', enabled: true, cooldownSeconds: 3600, threshold: 0.5 }] });
    loud.metrics?.increment('failures');
    loud.metrics?.increment('failures');
    loud.metrics?.increment('successes');
    const incident = await evaluateErrorRateAlert(loud);
    expect(incident).toMatchObject({ type: 'CONTROLLER_ERROR_RATE' });
    expect(incident?.details).toMatchObject({ rate: 2 / 3, threshold: 0.5 });
  });

  it('exposes incidents, credentials, and metrics through operator routes', async () => {
    const store = seededStore();
    await store.recordIncident({ type: 'DLQ', fingerprint: 'q:1', severity: 'critical', applicationId: 'app-demo', message: 'dropped', firedAt: T0.toISOString() });
    await store.upsertCredentialMetadata({ id: 'cred-vercel', provider: 'vercel', purpose: 'token', lastCheckedAt: T0.toISOString(), status: 'VALID' });
    await store.recordMetricSnapshot({ metric: 'failures', total: 1, rate: null, windowSeconds: 1800, labels: {}, capturedAt: T0.toISOString() });
    const app = createControllerApp({ operatorToken: 'op-token', store, logger: new LaunchpadLogger({ sink: () => undefined }) });

    const incidents = await app.request('/v1/incidents', { headers: { authorization: 'Bearer op-token' } });
    expect(incidents.status).toBe(200);
    expect(((await incidents.json()) as { incidents: unknown[] }).incidents).toHaveLength(1);

    const credentials = await app.request('/v1/credentials', { headers: { authorization: 'Bearer op-token' } });
    expect(((await credentials.json()) as { credentials: unknown[] }).credentials).toHaveLength(1);

    const metrics = await app.request('/v1/metrics', { headers: { authorization: 'Bearer op-token' } });
    expect(((await metrics.json()) as { snapshots: unknown[] }).snapshots).toHaveLength(1);

    const resolve = await app.request('/v1/incidents/does-not-exist/resolve', { method: 'POST', headers: { authorization: 'Bearer op-token' } });
    expect(resolve.status).toBe(404);

    const unauthorized = await app.request('/v1/incidents');
    expect(unauthorized.status).toBe(401);
  });
});

describe('alert configuration', () => {
  it('builds bounded configs from environment with fail-closed validation', () => {
    const configs = buildAlertConfigs({ LAUNCHPAD_ALERT_RECONCILIATION_THRESHOLD: '5', LAUNCHPAD_ALERT_ERROR_RATE_THRESHOLD: '0.2' });
    expect(configs.find((config) => config.type === 'RECONCILIATION_FAILURE')?.threshold).toBe(5);
    expect(configs.find((config) => config.type === 'CONTROLLER_ERROR_RATE')?.threshold).toBe(0.2);
    expect(configs.find((config) => config.type === 'DLQ')?.cooldownSeconds).toBe(3600);
    expect(() => buildAlertConfigs({ LAUNCHPAD_ALERT_ERROR_RATE_THRESHOLD: '2.5' })).toThrow(/LP-ALERT-CONFIG-INVALID/);
    expect(() => buildAlertConfigs({ LAUNCHPAD_ALERT_COOLDOWN_SECONDS: '-5' })).toThrow(/LP-ALERT-CONFIG-INVALID/);
    const disabled = buildAlertConfigs({ LAUNCHPAD_ALERTS_ENABLED: 'false' });
    expect(disabled.every((config) => config.enabled === false)).toBe(true);
    expect(defaultAlertConfigs().length).toBe(4);
  });
});
