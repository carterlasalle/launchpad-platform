import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReconciliationEnvelope, createReconciliationWorkflowDispatcher, dispatchScheduledReconciliation } from '../../apps/controller/src/queues.js';
import { ReconcileApplicationWorkflow } from '../../apps/controller/src/workflows.js';
import { cfRecord, expectedDnsOwnership } from '../fixtures/providers.js';
import type { TransportRequest } from '../fixtures/transport.js';
import { createHarness, type ControllerHarness } from './harness.js';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class WorkflowEntrypoint {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) { this.env = env; }
  },
}));

/** Base64-decodes the `content` field of a recorded contents write; empty when the write carried none. */
function decodedWriteContent(request: TransportRequest | undefined): string {
  if (request === undefined) return '';
  const body = request.body;
  if (body === null || typeof body !== 'object' || !('content' in body) || typeof body.content !== 'string') return '';
  return Buffer.from(body.content, 'base64').toString('utf8');
}

const TRIGGER = '2026-08-04T08:30:00.000Z';

async function seedReconcileHarness(options: { driftRoot?: string | null; failProjectReads?: boolean } = {}): Promise<ControllerHarness> {
  const harness = await createHarness();
  harness.setControlManifest(harness.fixtureYaml());
  const driftRoot = options.driftRoot === undefined ? 'apps/manual-drift' : options.driftRoot;
  harness.seedVercelProject({ rootDirectory: driftRoot });
  harness.states.vercel.failProjectReads = options.failProjectReads === true;
  harness.states.cloudflare.records.push(cfRecord({
    zoneId: 'zone_1', name: 'fixture.example.com', type: 'CNAME', content: 'cname.vercel-dns.com', ttl: 1, proxied: false,
    comment: `launchpad:${expectedDnsOwnership('fixture-app', 'fixture.example.com')}`,
  }, harness.states.cloudflare));
  await harness.registerApplication();
  return harness;
}

async function driveReconcile(harness: ControllerHarness, envelope: Record<string, unknown>, instanceId: string): Promise<{ result: Record<string, unknown>; steps: unknown }> {
  const outcome = await harness.runWorkflow(ReconcileApplicationWorkflow, envelope as never, { instanceId });
  return { result: outcome.result as Record<string, unknown>, steps: outcome.steps };
}

describe('scheduled reconciliation flow (integration)', () => {
  let harness: ControllerHarness;

  beforeEach(async () => { harness = await seedReconcileHarness(); });
  afterEach(() => { harness.restore(); });

  it('dispatches stable sharded envelopes from the scheduled path and reconciles OUT_OF_SYNC into one control-repo PR', async () => {
    // The scheduled handler path: list applications from D1, dispatch one
    // deterministic instance per application with stable shard assignment.
    const applications = (await harness.store.listApplications()).map((row) => row.application);
    expect(applications).toContain('fixture-app');
    const now = new Date(TRIGGER);
    const createdIds: string[] = [];
    const capture = { create: async (input: { id?: string }) => { createdIds.push(input.id ?? ''); return { id: input.id ?? '' }; } };
    const dispatched = await dispatchScheduledReconciliation({ applicationIds: ['fixture-app', 'second-app'], shardCount: 2, now, dispatcher: createReconciliationWorkflowDispatcher(capture) });
    expect(dispatched.dispatched).toBe(2);
    // Stable shard assignment and deterministic instance ids (sorted application order).
    expect(createdIds[0]).toBe('reconcile-fixture-app-s0-of2-2026-08-04T08-30-00-000Z');
    expect(createdIds[1]).toBe('reconcile-second-app-s1-of2-2026-08-04T08-30-00-000Z');
    const firstEnvelope = createReconciliationEnvelope({ applicationId: 'fixture-app', shard: 0, shardCount: 2, now });
    const expectedInstance = 'reconcile-fixture-app-s0-of2-2026-08-04T08-30-00-000Z';
    const replayed = await dispatchScheduledReconciliation({ applicationIds: ['fixture-app'], shardCount: 2, now, dispatcher: createReconciliationWorkflowDispatcher({ create: async (input) => ({ id: input.id ?? '' }) }) });
    expect(replayed.dispatched).toBe(1);

    // Drive the actual workflow with the scheduled envelope.
    const { result } = await driveReconcile(harness, firstEnvelope as unknown as Record<string, unknown>, expectedInstance);
    expect(result.status).toBe('SUCCEEDED');
    const diff = result['diff-plan'] as Record<string, unknown>;
    expect(diff.status).toBe('OUT_OF_SYNC');
    expect((diff.drift as Array<{ resourceKey: string }>).some((record) => record.resourceKey === 'vercel.project')).toBe(true);
    expect(typeof diff.driftFingerprint).toBe('string');

    // D1 verdicts: OUT_OF_SYNC status, drift event, plan, observation, audits.
    const application = await harness.store.getApplication('fixture-app');
    expect(application?.syncStatus).toBe('OUT_OF_SYNC');
    const driftEvents = await harness.store.listDriftEvents('fixture-app', { includeResolved: false });
    expect(driftEvents).toHaveLength(1);
    expect(driftEvents[0]).toMatchObject({ category: 'OUT_OF_SYNC', fingerprint: diff.driftFingerprint });
    const plans = await harness.store.listPlans('fixture-app');
    expect(plans).toHaveLength(1);
    expect((await harness.store.listObservations('fixture-app'))).toHaveLength(1);
    const audits = await harness.store.listAudit('fixture-app');
    expect(audits.some((event) => event.action === 'RECONCILE_STATUS' && event.details?.status === 'OUT_OF_SYNC')).toBe(true);
    expect(audits.some((event) => event.action === 'RECONCILE_COMPLETE')).toBe(true);

    // Exactly one control-repo PR carrying the manifest + reconciliation request.
    const openRequests = (await harness.store.listReconciliationRequests('fixture-app')).filter((request) => request.status === 'OPEN');
    expect(openRequests).toHaveLength(1);
    expect(openRequests[0]).toMatchObject({ fingerprint: diff.driftFingerprint, mode: 'restore-desired-state', pullRequestNumber: 7 });
    expect(harness.transport.count('POST', '/pulls')).toBe(1);
    expect(harness.transport.count('POST', '/git/refs')).toBe(1);
    const branchWrites = harness.transport.requestsFor('PUT', '/contents/');
    expect(branchWrites).toHaveLength(2);
    // The GitHub adapter percent-encodes the full contents path (catalog%2Fapps%2F...);
    // decode before matching so the file identity is compared literally.
    const manifestWrite = branchWrites.find((request) => decodeURIComponent(request.url).includes('/contents/catalog/apps/fixture-app.yaml'));
    const decoded = decodedWriteContent(manifestWrite);
    expect(decoded).toBe(harness.fixtureYaml());
    const requestWrite = branchWrites.find((request) => decodeURIComponent(request.url).includes('/contents/reconciliation/fixture-app.yaml'));
    expect(decodedWriteContent(requestWrite)).toContain('kind: ReconciliationRequest');
    const prBodies = harness.transport.jsonBodies('POST', '/pulls');
    expect(String(JSON.stringify(prBodies[0])).toLowerCase()).not.toContain('canary');
    expect(harness.transport.allBodies().toLowerCase()).not.toContain('canary');
  });

  it('suppresses duplicate reconciliation PRs: same drift fingerprint updates one PR and one open request', async () => {
    const first = createReconciliationEnvelope({ applicationId: 'fixture-app', shard: 0, shardCount: 1, now: new Date(TRIGGER) });
    const second = createReconciliationEnvelope({ applicationId: 'fixture-app', shard: 0, shardCount: 1, now: new Date('2026-08-04T09:30:00.000Z') });
    await driveReconcile(harness, first as unknown as Record<string, unknown>, 'reconcile-1');
    await driveReconcile(harness, second as unknown as Record<string, unknown>, 'reconcile-2');

    // The second check updated the same branch/PR; nothing new was opened.
    expect(harness.transport.count('POST', '/pulls')).toBe(1);
    expect(harness.transport.count('PATCH', '/pulls/7')).toBe(1);
    expect(harness.transport.count('POST', '/git/refs')).toBe(2); // second branch create conflicts (422) and is treated as idempotent
    const openRequests = (await harness.store.listReconciliationRequests('fixture-app')).filter((request) => request.status === 'OPEN');
    expect(openRequests).toHaveLength(1);
    expect(openRequests[0]?.pullRequestNumber).toBe(7);
    // Each check records its own drift observation with the same fingerprint.
    const driftEvents = await harness.store.listDriftEvents('fixture-app', { includeResolved: false });
    expect(driftEvents).toHaveLength(2);
    expect(new Set(driftEvents.map((event) => event.fingerprint)).size).toBe(1);
  });

  it('records access loss as UNKNOWN without opening any PR', async () => {
    harness.restore();
    harness = await seedReconcileHarness({ failProjectReads: true });
    const envelope = createReconciliationEnvelope({ applicationId: 'fixture-app', shard: 0, shardCount: 1, now: new Date(TRIGGER) });
    const { result } = await driveReconcile(harness, envelope as unknown as Record<string, unknown>, 'reconcile-unknown');
    expect(result.status).toBe('SUCCEEDED');
    expect((result['diff-plan'] as Record<string, unknown>).status).toBe('UNKNOWN');
    const application = await harness.store.getApplication('fixture-app');
    expect(application?.syncStatus).toBe('UNKNOWN');
    const driftEvents = await harness.store.listDriftEvents('fixture-app', { includeResolved: false });
    expect(driftEvents[0]?.category).toBe('UNKNOWN');
    // No PR, no branch, no reconciliation request was opened for an access loss.
    expect(harness.transport.count('POST', '/pulls')).toBe(0);
    expect(harness.transport.count('PATCH', '/pulls/')).toBe(0);
    expect(harness.transport.count('POST', '/git/refs')).toBe(0);
    expect((await harness.store.listReconciliationRequests('fixture-app')).filter((request) => request.status === 'OPEN')).toHaveLength(0);
    const audits = await harness.store.listAudit('fixture-app');
    expect(audits.some((event) => event.action === 'RECONCILE_STATUS' && event.details?.status === 'UNKNOWN' && event.details?.accessErrors?.length > 0)).toBe(true);
  });

  it('reports SYNCED when live state matches the manifest and resolves prior drift', async () => {
    harness.restore();
    harness = await seedReconcileHarness({ driftRoot: '.' });
    const envelope = createReconciliationEnvelope({ applicationId: 'fixture-app', shard: 0, shardCount: 1, now: new Date(TRIGGER) });
    const { result } = await driveReconcile(harness, envelope as unknown as Record<string, unknown>, 'reconcile-synced');
    expect(result.status).toBe('SUCCEEDED');
    expect((result['diff-plan'] as Record<string, unknown>).status).toBe('SYNCED');
    const application = await harness.store.getApplication('fixture-app');
    expect(application?.syncStatus).toBe('SYNCED');
    expect(harness.transport.count('POST', '/pulls')).toBe(0);
  });
});
