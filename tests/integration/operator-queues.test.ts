import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class WorkflowEntrypoint {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) { this.env = env; }
  },
}));

import { createD1QueuePersistence } from '../../apps/controller/src/worker.js';
import { createHttpQueueDispatcher, DEAD_LETTER_QUEUE, handleQueue, QueueFailure, type QueueBatch, type QueueMessage } from '../../apps/controller/src/queues.js';
import { buildObservability, checkCredentialExpiration, snapshotMetricsToStore } from '../../apps/controller/src/observability.js';
import type { ControllerEnv } from '../../apps/controller/src/env.js';
import { SOURCE_COMMIT, createHarness, type ControllerHarness } from './harness.js';

const OPERATOR = { authorization: 'Bearer operator-token' };
const ENVELOPE = { version: 1, kind: 'health-check', id: 'event-1', createdAt: '2026-08-04T00:00:00.000Z', payload: { applicationId: 'fixture-app' } };

function message(id: string, body: unknown, attempts = 1): QueueMessage {
  return { id, body, attempts };
}

function batch(messages: QueueMessage[], queue = 'launchpad-events'): { batch: QueueBatch; acked: string[]; retried: string[] } {
  const acked: string[] = [];
  const retried: string[] = [];
  return {
    batch: { queue, messages, ack: (m) => { acked.push(m.id); }, retry: (m) => { retried.push(m.id); } },
    acked,
    retried,
  };
}

describe('operator dashboard and queue surface (integration)', () => {
  let harness: ControllerHarness;

  beforeEach(async () => {
    harness = await createHarness();
    harness.setControlManifest(harness.fixtureYaml());
    await harness.registerApplication();
  });
  afterEach(() => { harness.restore(); });

  it('requires the operator bearer token for every dashboard read', async () => {
    const anonymous = await harness.request('/v1/applications');
    expect(anonymous.status).toBe(401);
    await expect(anonymous.json()).resolves.toMatchObject({ error: { code: 'LP-OPERATOR-AUTH-REQUIRED' } });
    const wrongToken = await harness.request('/v1/applications', { headers: { authorization: 'Bearer nope' } });
    expect(wrongToken.status).toBe(401);
    const allowed = await harness.request('/v1/applications', { headers: OPERATOR });
    expect(allowed.status).toBe(200);
  });

  it('serves dashboard reads verbatim from persisted state, including UNKNOWN/FAILED statuses and bounded lists', async () => {
    const store = harness.store;
    await store.recordDeployment({ id: 'dpl-1', applicationId: 'fixture-app', projectId: 'fixture-app', environment: 'production', repository: 'example/fixture', commitSha: SOURCE_COMMIT, desiredGeneration: 1, state: 'CURRENT', url: 'https://fixture.example.com', createdAt: '2026-08-04T00:00:00.000Z' });
    await store.recordKnownGoodDeployment('fixture-app', 'production', 'dpl-1');
    await store.recordDeployment({ id: 'dpl-2', applicationId: 'fixture-app', projectId: 'fixture-app', environment: 'preview', repository: 'example/fixture', commitSha: 'f'.repeat(40), desiredGeneration: 1, state: 'READY', url: 'https://p.example.com', createdAt: '2026-08-04T01:00:00.000Z' });
    await store.recordHealthCheck({ id: 'h1', applicationId: 'fixture-app', environment: 'production', deploymentId: 'dpl-1', url: 'https://fixture.example.com', attempt: 1, dnsResolved: true, tlsValid: true, statusCode: 503, latencyMs: 4, assertionResults: [], result: 'FAILED', checkedAt: '2026-08-04T00:30:00.000Z', errorCode: 'LP-HEALTH-ASSERTION-FAILED' });
    await store.recordDriftEvent({ applicationId: 'fixture-app', fingerprint: 'drift-1', category: 'OUT_OF_SYNC', payload: { resourceKey: 'vercel.project' }, observedAt: '2026-08-04T00:00:00.000Z' });
    const savedPlan = await store.savePlan({ applicationId: 'fixture-app', plan: { schemaVersion: 'launchpad.plan/v1', applicationId: 'fixture-app', desiredGeneration: 1, sourceCommit: SOURCE_COMMIT, createdAt: '2026-08-04T00:00:00.000Z', capabilitySnapshotHash: 'ch', observedStateHash: 'sh', fingerprint: 'plan-1', result: 'READY', operations: [{ id: 'op-1', resourceKey: 'vercel.project', provider: 'vercel', resourceType: 'vercel.project', action: 'UPDATE_IN_PLACE', before: null, after: null, prerequisites: [], invalidates: [], idempotencyKey: 'ik', destructive: false, retryClass: 'NONE' }], downstreamEffects: [], policyResults: [], layers: [], drift: null }, createdAt: '2026-08-04T00:00:00.000Z' });
    await store.replacePlanOperations(savedPlan.id, [{ id: 'op-1', resourceKey: 'vercel.project', provider: 'vercel', resourceType: 'vercel.project', action: 'UPDATE_IN_PLACE', before: null, after: null, prerequisites: [], invalidates: [], idempotencyKey: 'ik', destructive: false, retryClass: 'NONE' }]);
    await store.startWorkflowRun({ applicationId: 'fixture-app', workflowType: 'apply', idempotencyKey: 'run-1', payloadHash: 'ph' });
    await store.upsertCredentialMetadata({ id: 'vercel-token', provider: 'vercel', purpose: 'deploy', valueFingerprint: 'fp-abc', lastCheckedAt: '2026-08-04T00:00:00.000Z', status: 'ACTIVE' });
    await store.appendAudit({ actor: 'system:test', action: 'SEEDED', applicationId: 'fixture-app', details: {} });
    await store.recordIncident({ type: 'CONTROLLER_ERROR_RATE', fingerprint: 'inc-1', severity: 'critical', applicationId: 'fixture-app', message: 'boom', firedAt: '2026-08-04T00:00:00.000Z' });
    await store.recordMetricSnapshot({ metric: 'successes', total: 3, windowSeconds: 3600, capturedAt: '2026-08-04T00:00:00.000Z' });

    const applications = await (await harness.request('/v1/applications', { headers: OPERATOR })).json() as { applications: Array<{ application: string; sync: string; health: string }> };
    expect(applications.applications[0]).toMatchObject({ application: 'fixture-app', sync: 'UNKNOWN', health: 'UNKNOWN' });

    const detail = await (await harness.request('/v1/applications/fixture-app', { headers: OPERATOR })).json() as { application: { sync: string; health: string; lifecycleState: string }; latestHealthCheck: { result: string; errorCode: string | null } | null; knownGoodDeployment: { id: string } | null };
    expect(detail.application).toMatchObject({ sync: 'UNKNOWN', health: 'UNKNOWN', lifecycleState: 'active' });
    expect(detail.latestHealthCheck).toMatchObject({ result: 'FAILED', errorCode: 'LP-HEALTH-ASSERTION-FAILED' });
    expect(detail.knownGoodDeployment?.id).toBe('dpl-1');

    const deployments = await (await harness.request('/v1/applications/fixture-app/deployments?limit=1', { headers: OPERATOR })).json() as { deployments: Array<{ id: string }>; truncated: boolean };
    expect(deployments.deployments).toHaveLength(1);
    expect(deployments.truncated).toBe(true);

    const health = await (await harness.request('/v1/applications/fixture-app/health', { headers: OPERATOR })).json() as { checks: Array<{ result: string }> };
    expect(health.checks[0]?.result).toBe('FAILED');

    const drift = await (await harness.request('/v1/applications/fixture-app/drift', { headers: OPERATOR })).json() as { drift: Array<{ category: string }> };
    expect(drift.drift[0]?.category).toBe('OUT_OF_SYNC');

    const plans = await (await harness.request('/v1/applications/fixture-app/plan', { headers: OPERATOR })).json() as { plans: Array<{ fingerprint: string; operationCount: number }> };
    expect(plans.plans[0]).toMatchObject({ fingerprint: 'plan-1', operationCount: 1 });

    const operations = await (await harness.request('/v1/applications/fixture-app/operations', { headers: OPERATOR })).json() as { operations: Array<{ action: string; status: string }> };
    expect(operations.operations[0]).toMatchObject({ action: 'apply', status: 'QUEUED' });

    const credentials = await (await harness.request('/v1/credentials', { headers: OPERATOR })).json() as { credentials: Array<{ id: string; valueFingerprint: string | null }> };
    expect(credentials.credentials[0]).toMatchObject({ id: 'vercel-token', valueFingerprint: 'fp-abc' });
    expect(JSON.stringify(credentials)).not.toContain('secret');

    const incidents = await (await harness.request('/v1/incidents', { headers: OPERATOR })).json() as { incidents: Array<{ type: string; fingerprint: string }> };
    expect(incidents.incidents[0]).toMatchObject({ type: 'CONTROLLER_ERROR_RATE', fingerprint: 'inc-1' });

    const metrics = await (await harness.request('/v1/metrics', { headers: OPERATOR })).json() as { snapshots: Array<{ metric: string; total: number }> };
    expect(metrics.snapshots[0]).toMatchObject({ metric: 'successes', total: 3 });

    const audit = await (await harness.request('/v1/applications/fixture-app/audit', { headers: OPERATOR })).json() as { events: Array<{ action: string }> };
    expect(audit.events.some((event) => event.action === 'SEEDED')).toBe(true);
  });

  it('replays failed operations through the retry action without duplicating the retry run', async () => {
    const store = harness.store;
    const original = await store.startWorkflowRun({ applicationId: 'fixture-app', workflowType: 'app-preview', idempotencyKey: 'orig-1', payloadHash: 'ph-1' });
    await store.updateWorkflowRun(original.id, { status: 'FAILED', completedAt: '2026-08-04T00:00:00.000Z', errorCode: 'LP-VERCEL-BUILD-FAILED' });
    await store.appendAudit({ actor: 'oidc:workflow', action: 'OIDC_OPERATION_START', applicationId: 'fixture-app', details: { operationId: original.id, workflowId: 'wf-1', repositoryId: '123456789', ownerId: '987654321', repository: 'example/fixture', workflowRef: 'example/fixture/.github/workflows/p.yml@refs/heads/main', event: 'push', sourceCommit: SOURCE_COMMIT, actor: 'alice', params: { version: 1, kind: 'app-preview', applicationId: 'fixture-app', sourceCommit: SOURCE_COMMIT, idempotencyKey: 'orig-1', repositoryId: '123456789', ownerId: '987654321', repository: 'example/fixture', workflowRef: 'example/fixture/.github/workflows/p.yml@refs/heads/main', event: 'push', actor: 'alice' } } });

    const retry = await harness.request('/v1/applications/fixture-app/actions/retry', { method: 'POST', headers: { 'content-type': 'application/json', ...OPERATOR }, body: JSON.stringify({ operationId: original.id }) });
    expect(retry.status).toBe(202);
    const retried = await retry.json() as { operationId: string; workflowId: string; retriedOperationId: string };
    expect(retried.retriedOperationId).toBe(original.id);
    expect(retried.operationId).not.toBe(original.id);
    const retryRun = await store.getWorkflowRun(retried.operationId);
    expect(retryRun).toMatchObject({ idempotencyKey: `retry:${original.id}`, workflowType: 'app-preview', status: 'QUEUED' });
    expect((await store.listAudit('fixture-app')).some((event) => event.action === 'OPERATOR_RETRY' && event.details?.retryOperationId === retried.operationId)).toBe(true);

    const replay = await harness.request('/v1/applications/fixture-app/actions/retry', { method: 'POST', headers: { 'content-type': 'application/json', ...OPERATOR }, body: JSON.stringify({ operationId: original.id }) });
    expect(replay.status).toBe(202);
    await expect(replay.json()).resolves.toMatchObject({ operationId: retried.operationId, retriedOperationId: original.id });
  });

  it('rechecks production health through the durable handler and deduplicates replays', async () => {
    const store = harness.store;
    await store.recordDeployment({ id: 'dpl-1', applicationId: 'fixture-app', projectId: 'fixture-app', environment: 'production', repository: 'example/fixture', commitSha: SOURCE_COMMIT, desiredGeneration: 1, state: 'CURRENT', url: 'https://fixture.example.com', createdAt: '2026-08-04T00:00:00.000Z' });
    await store.recordKnownGoodDeployment('fixture-app', 'production', 'dpl-1');

    const recheck = await harness.request('/v1/applications/fixture-app/actions/recheck', { method: 'POST', headers: { 'content-type': 'application/json', ...OPERATOR }, body: JSON.stringify({}) });
    expect(recheck.status).toBe(202);
    const body = await recheck.json() as { operationId: string; status: string; dispatched: string };
    expect(body).toMatchObject({ status: 'SUCCEEDED', dispatched: 'handler' });
    const health = await store.listHealthChecks('fixture-app', { environment: 'production' });
    expect(health[0]).toMatchObject({ result: 'PASSED', url: 'https://fixture.example.com' });

    const replay = await harness.request('/v1/applications/fixture-app/actions/recheck', { method: 'POST', headers: { 'content-type': 'application/json', ...OPERATOR }, body: JSON.stringify({}) });
    expect(replay.status).toBe(202);
    await expect(replay.json()).resolves.toMatchObject({ operationId: body.operationId, replay: true });
    expect((await store.listHealthChecks('fixture-app', { environment: 'production' })).length).toBe(1);
  });

  it('rolls back to the recorded known-good and replays without touching the provider twice', async () => {
    const store = harness.store;
    await store.recordDeployment({ id: 'dpl-good', applicationId: 'fixture-app', projectId: 'fixture-app', environment: 'production', repository: 'example/fixture', commitSha: SOURCE_COMMIT, desiredGeneration: 1, state: 'CURRENT', url: 'https://fixture.example.com', createdAt: '2026-08-03T00:00:00.000Z' });
    await store.recordKnownGoodDeployment('fixture-app', 'production', 'dpl-good');
    await store.recordDeployment({ id: 'dpl-bad', applicationId: 'fixture-app', projectId: 'fixture-app', environment: 'production', repository: 'example/fixture', commitSha: 'b'.repeat(40), desiredGeneration: 2, state: 'READY', url: 'https://bad.example.com', createdAt: '2026-08-04T00:00:00.000Z' });
    harness.states.vercel.deployments.set('dpl-good', { id: 'dpl-good', projectId: 'fixture-app', url: 'fixture.example.com', state: 'CURRENT', commitSha: SOURCE_COMMIT, target: 'production', createdAt: '2026-08-03T00:00:00.000Z', meta: { repo: 'example/fixture' } });

    const rollback = await harness.request('/v1/applications/fixture-app/actions/rollback', { method: 'POST', headers: { 'content-type': 'application/json', ...OPERATOR }, body: JSON.stringify({ deploymentId: 'dpl-bad' }) });
    expect(rollback.status).toBe(200);
    const body = await rollback.json() as { operationId: string; status: string; failedDeploymentId: string; knownGoodDeploymentId: string };
    expect(body).toMatchObject({ status: 'SUCCEEDED', failedDeploymentId: 'dpl-bad', knownGoodDeploymentId: 'dpl-good' });
    // Current official rollback contract: POST /v1/projects/{projectId}/rollback/{knownGoodId}.
    expect(harness.states.vercel.rollbackCalls).toEqual([{ projectId: 'fixture-app', deploymentId: 'dpl-good' }]);

    const replay = await harness.request('/v1/applications/fixture-app/actions/rollback', { method: 'POST', headers: { 'content-type': 'application/json', ...OPERATOR }, body: JSON.stringify({ deploymentId: 'dpl-bad' }) });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ operationId: body.operationId, replayed: true, status: 'SUCCEEDED' });
    expect(harness.states.vercel.rollbackCalls).toHaveLength(1);
  });

  it('opens config-change PRs only, idempotently, without touching providers', async () => {
    const change = await harness.request('/v1/applications/fixture-app/changes/root', { method: 'POST', headers: { 'content-type': 'application/json', ...OPERATOR }, body: JSON.stringify({ value: 'apps/web' }) });
    expect(change.status).toBe(200);
    const body = await change.json() as { replay: boolean; pullRequest: { number: number; url: string; branch: string } };
    expect(body.replay).toBe(false);
    expect(body.pullRequest.branch).toMatch(/^launchpad\/root\/fixture-app\//);
    expect(harness.transport.count('POST', '/pulls')).toBe(1);
    // The PR carries a valid manifest with the new root directory.
    const put = harness.transport.requestsFor('PUT', '/contents/catalog/apps/fixture-app.yaml')[0];
    const decoded = Buffer.from((put?.body as { content?: string })?.content ?? '', 'base64').toString('utf8');
    expect(decoded).toContain('rootDirectory: apps/web');

    const replay = await harness.request('/v1/applications/fixture-app/changes/root', { method: 'POST', headers: { 'content-type': 'application/json', ...OPERATOR }, body: JSON.stringify({ value: 'apps/web' }) });
    expect(replay.status).toBe(200);
    const replayed = await replay.json() as { replay: boolean; pullRequest: { number: number } };
    expect(replayed.replay).toBe(true);
    expect(replayed.pullRequest.number).toBe(body.pullRequest.number);
    expect(harness.transport.count('POST', '/pulls')).toBe(1);
    // No provider was mutated by the dashboard change.
    expect(harness.transport.count('POST', 'api.vercel.com')).toBe(0);
    expect(harness.transport.count('PATCH', 'api.vercel.com')).toBe(0);
  });

  it('records queue incidents before acknowledgment and never acks unpersisted failures', async () => {
    const persist = createD1QueuePersistence(harness.d1);

    // Dead-letter queue: incident row + audit are persisted before the ack.
    const deadLetter = batch([message('m1', ENVELOPE, 3)], DEAD_LETTER_QUEUE);
    const outcome = await handleQueue(deadLetter.batch, { persist, now: () => new Date('2026-08-04T00:00:00.000Z') });
    expect(outcome).toMatchObject({ acknowledged: 1, incidents: 1, retried: 0 });
    expect(deadLetter.acked).toEqual(['m1']);
    const incidents = await harness.store.listIncidents({ type: 'DLQ' });
    expect(incidents[0]).toMatchObject({ fingerprint: `${DEAD_LETTER_QUEUE}:m1`, severity: 'critical', message: 'Message exhausted its retry budget on the source queue.', details: { code: 'LP-QUEUE-RETRY-EXHAUSTED', queue: DEAD_LETTER_QUEUE, messageId: 'm1', attempts: 3 } });
    // The DLQ incident audit is scoped to the message's application.
    expect((await harness.store.listAudit('fixture-app')).some((event) => event.action === 'DLQ_INCIDENT' && event.details?.messageId === 'm1')).toBe(true);

    // Malformed envelope on the main queue: visible incident, then ack.
    const malformed = batch([message('m2', { not: 'an envelope' }, 1)]);
    const malformedOutcome = await handleQueue(malformed.batch, { persist });
    expect(malformedOutcome).toMatchObject({ acknowledged: 1, incidents: 1 });
    expect(malformed.acked).toEqual(['m2']);

    // Transient dispatch failure: retried, never acknowledged, no incident.
    const transient = batch([message('m3', ENVELOPE, 1)]);
    const transientOutcome = await handleQueue(transient.batch, { persist, dispatch: { dispatch: async () => { throw new Error('boom'); } } });
    expect(transientOutcome).toMatchObject({ acknowledged: 0, retried: 1, incidents: 0 });
    expect(transient.acked).toEqual([]);
    expect(transient.retried).toEqual(['m3']);

    // Permanent dispatch failure: incident persisted, then ack.
    const permanent = batch([message('m4', ENVELOPE, 2)]);
    const permanentOutcome = await handleQueue(permanent.batch, { persist, dispatch: { dispatch: async () => { throw new QueueFailure('LP-QUEUE-DISPATCH-PERMANENT', 'permanent', 'rejected'); } } });
    expect(permanentOutcome).toMatchObject({ acknowledged: 1, incidents: 1 });
    expect(permanent.acked).toEqual(['m4']);

    // A failing persistence throws and nothing is acknowledged (redelivery).
    const failing = batch([message('m5', ENVELOPE, 1)], DEAD_LETTER_QUEUE);
    const failingPersist = { recordIncident: async () => { throw new Error('disk full'); } };
    await expect(handleQueue(failing.batch, { persist: failingPersist })).rejects.toThrow('disk full');
    expect(failing.acked).toEqual([]);
  });

  it('dispatches queued envelopes through the real internal workflow boundary', async () => {
    const store = harness.store;
    await store.recordDeployment({ id: 'dpl-1', applicationId: 'fixture-app', projectId: 'fixture-app', environment: 'production', repository: 'example/fixture', commitSha: SOURCE_COMMIT, desiredGeneration: 1, state: 'CURRENT', url: 'https://fixture.example.com', createdAt: '2026-08-04T00:00:00.000Z' });
    await store.recordKnownGoodDeployment('fixture-app', 'production', 'dpl-1');
    const dispatch = createHttpQueueDispatcher({ internalUrl: 'http://internal', internalToken: 'internal-token', fetchImpl: harness.transport.fetchImpl });
    const queued = batch([message('q1', ENVELOPE, 1)]);
    const outcome = await handleQueue(queued.batch, { persist: createD1QueuePersistence(harness.d1), dispatch });
    expect(outcome).toMatchObject({ acknowledged: 1, incidents: 0, retried: 0 });
    expect(queued.acked).toEqual(['q1']);
    const health = await store.listHealthChecks('fixture-app', { environment: 'production' });
    expect(health[0]?.result).toBe('PASSED');
  });

  it('deduplicates Vercel webhook deliveries, enqueues one sanitized envelope, and rejects bad signatures', async () => {
    const canary = 'launchpad-canary-e71a';
    const payload = JSON.stringify({ id: 'evt_1', type: 'deployment', payload: { deploymentId: 'dpl_1', projectId: 'prj_1', token: canary }, deployment: { id: 'dpl_1', url: 'https://private.example/deploy' } });
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('webhook-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
    const signature = `sha256=${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;

    const first = await harness.request('/webhooks/vercel', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vercel-signature': signature }, body: payload });
    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toMatchObject({ accepted: true, deduplicated: false });

    const second = await harness.request('/webhooks/vercel', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vercel-signature': signature }, body: payload });
    expect(second.status).toBe(202);
    await expect(second.json()).resolves.toMatchObject({ accepted: true, deduplicated: true });

    // Exactly one sanitized provider-event envelope is enqueued for the pair.
    expect(harness.queueMessages).toHaveLength(1);
    const envelope = harness.queueMessages[0] as { kind: string; id: string; payload: Record<string, unknown> };
    expect(envelope).toMatchObject({ kind: 'provider-event', id: 'webhook:vercel:evt_1', payload: { eventId: 'evt_1', type: 'deployment', deploymentId: 'dpl_1', projectId: 'prj_1' } });
    expect(JSON.stringify(harness.queueMessages)).not.toContain(canary);
    expect(JSON.stringify(harness.queueMessages)).not.toContain('private.example');

    // The receipt row stores only the sanitized projection and is marked dispatched.
    const receipts = await harness.store.getWebhookReceipt('vercel', 'evt_1');
    expect(receipts?.payload).toEqual({ eventId: 'evt_1', type: 'deployment', deploymentId: 'dpl_1', projectId: 'prj_1' });
    expect(receipts?.dispatchedAt).toBeDefined();
    const audits = await harness.store.listAuditAll();
    expect(JSON.stringify(audits)).not.toContain(canary);
    expect(audits.some((event) => event.action === 'WEBHOOK_RECEIVED')).toBe(true);
    expect(audits.some((event) => event.action === 'WEBHOOK_DEDUPLICATED')).toBe(true);

    const bad = await harness.request('/webhooks/vercel', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vercel-signature': 'sha256=deadbeef' }, body: payload });
    expect(bad.status).toBe(401);
    await expect(bad.json()).resolves.toMatchObject({ error: { code: 'LP-WEBHOOK-SIGNATURE-INVALID' } });
    // A bad signature never reaches the queue.
    expect(harness.queueMessages).toHaveLength(1);
  });

  it('resolves incidents and snapshots metrics through the observability pass', async () => {
    const env = harness.env as unknown as ControllerEnv['Bindings'];
    const observability = buildObservability(env, harness.store);
    observability.metrics?.increment('successes', { workflow: 'webhook' });
    observability.metrics?.increment('successes', { workflow: 'webhook' });
    const snapshots = await snapshotMetricsToStore(observability);
    expect(snapshots.length).toBeGreaterThan(0);
    const metrics = await (await harness.request('/v1/metrics', { headers: OPERATOR })).json() as { snapshots: Array<{ metric: string; labels: Record<string, string> }> };
    expect(metrics.snapshots.some((snapshot) => snapshot.metric === 'successes' && snapshot.labels?.workflow === 'webhook')).toBe(true);

    // Credential-expiry alerting: a token expiring inside the warning window fires an incident.
    const expiring = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    await harness.store.upsertCredentialMetadata({ id: 'vercel-token', provider: 'vercel', purpose: 'deploy', valueFingerprint: 'fp', expiresAt: expiring, lastCheckedAt: new Date().toISOString(), status: 'ACTIVE' });
    const expiry = await checkCredentialExpiration(observability, 14);
    expect(expiry.incidents.length).toBeGreaterThan(0);
    const incidents = await (await harness.request('/v1/incidents', { headers: OPERATOR })).json() as { incidents: Array<{ type: string; id: string }> };
    const credentialIncident = incidents.incidents.find((incident) => incident.type === 'CREDENTIAL_EXPIRY');
    expect(credentialIncident).toBeDefined();

    const resolved = await harness.request(`/v1/incidents/${credentialIncident?.id}/resolve`, { method: 'POST', headers: OPERATOR });
    expect(resolved.status).toBe(200);
    await expect(resolved.json()).resolves.toMatchObject({ incident: { type: 'CREDENTIAL_EXPIRY', resolvedAt: expect.any(String) as string } });
    // Platform-scoped incidents (credentials carry no application id) resolve into the global audit trail.
    expect((await harness.store.listAuditAll()).some((event) => event.action === 'INCIDENT_RESOLVED' && event.details?.incidentId === credentialIncident?.id)).toBe(true);
  });
});
