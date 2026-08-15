import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesiredApplication } from '@launchpad/core';
import { DecommissionApplicationWorkflow } from '../../apps/controller/src/workflows.js';
import { cfRecord, expectedDnsOwnership, manifestYamlFrom } from '../fixtures/providers.js';
import { createHarness, SOURCE_COMMIT, type ControllerHarness } from './harness.js';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class WorkflowEntrypoint {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) { this.env = env; }
  },
}));

const DOMAIN = 'fixture.example.com';
const NOW = '2026-08-04T00:00:00.000Z';

function approvedManifest(desired: DesiredApplication, options: { deleteAfter?: string } = {}): string {
  const approved = {
    ...desired,
    lifecycle: {
      ...desired.lifecycle,
      state: 'approved-for-deletion' as const,
      deletionProtection: false,
      decommission: {
        ...desired.lifecycle.decommission,
        requestedAt: '2026-08-03T00:00:00.000Z',
        deleteAfter: options.deleteAfter ?? '2026-08-03T00:00:00.000Z',
        approvalToken: null,
      },
    },
  };
  return manifestYamlFrom(approved as unknown as Record<string, unknown>);
}

async function seedDeletionHarness(options: { ownershipComment?: string; deleteAfter?: string; manifestAtCommit?: boolean; dependents?: boolean; coolingOff?: boolean } = {}): Promise<{ harness: ControllerHarness; desired: DesiredApplication; approval: { approvalId: string; token: string } }> {
  // Freeze the controller clock at NOW so the cooling-off / expiry gates in the
  // destroy machine are deterministic (the delete endpoint reads env.NOW).
  const harness = await createHarness({ envOverrides: { NOW } });
  // Register the application through the real D1 store boundary first: the
  // store requires the application row before any resource, deployment, or
  // known-good record can be persisted, exactly as the controller's
  // `ensureApplicationRegistered` does on the first claim-bound operation.
  await harness.registerApplication();
  const desired = await harness.loadFixtureDesired();
  harness.setControlManifest(harness.fixtureYaml());
  // The Vercel project exists and is owned (project id fingerprint), with the
  // production domain assigned, plus its DNS record.
  harness.seedVercelProject({ domains: [DOMAIN] });
  harness.states.cloudflare.records.push(cfRecord({
    zoneId: 'zone_1', name: DOMAIN, type: 'CNAME', content: 'cname.vercel-dns.com', ttl: 1, proxied: false,
    comment: `launchpad:${options.ownershipComment ?? expectedDnsOwnership('fixture-app', DOMAIN)}`,
  }, harness.states.cloudflare));
  await harness.store.upsertResource({ applicationId: 'fixture-app', provider: 'vercel', resourceType: 'vercel.project', resourceKey: 'vercel.project', providerResourceId: 'fixture-app', desiredGeneration: 1, observedHash: 'h', ownershipFingerprint: 'fixture-app', status: 'ACTIVE' });
  await harness.store.recordDeployment({ id: 'dpl_1', applicationId: 'fixture-app', projectId: 'fixture-app', environment: 'production', repository: 'example/fixture', commitSha: 'e'.repeat(40), desiredGeneration: 1, state: 'CURRENT', url: 'https://fixture.example.com', createdAt: '2026-08-03T00:00:00.000Z' });
  await harness.store.recordKnownGoodDeployment('fixture-app', 'production', 'dpl_1');

  if (options.dependents === true) {
    await harness.store.upsertApplication({ id: 'dependent-app', displayName: 'Dependent', sourcePath: 'catalog/apps/dependent-app.yaml', desiredGeneration: 0, desiredHash: '', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
    const dependent = { ...desired, metadata: { ...desired.metadata, id: 'dependent-app', displayName: 'Dependent' }, dependencies: { applications: ['fixture-app'], external: [] } } as unknown as DesiredApplication;
    const dependentYaml = manifestYamlFrom(dependent as unknown as Record<string, unknown>);
    harness.setControlFile('catalog/apps/dependent-app.yaml', dependentYaml);
  }

  // Operator issues the deletion plan PR and the single-use approval.
  const planResponse = await harness.request('/v1/applications/fixture-app/decommission', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer operator-token' }, body: JSON.stringify({}) });
  expect(planResponse.status).toBe(200);
  const plan = await planResponse.json() as { status: string; pullRequest: { number: number } | null; report: { blockingDependents: string[] } };
  expect(plan.status).toBe('PR_OPENED');
  const approvalResponse = await harness.request('/v1/applications/fixture-app/decommission/approval', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer operator-token' },
    body: JSON.stringify({ sourceCommit: SOURCE_COMMIT, domain: DOMAIN, actor: 'operator' }),
  });
  expect(approvalResponse.status).toBe(200);
  const approval = await approvalResponse.json() as { approvalId: string; token: string };

  // The reviewed PRs merge: main and the approved commit now carry the approved manifest.
  const approvedYaml = approvedManifest(desired, { deleteAfter: options.deleteAfter });
  harness.setControlManifest(approvedYaml);
  if (options.manifestAtCommit !== false) harness.setControlManifest(approvedYaml, SOURCE_COMMIT);
  return { harness, desired, approval };
}

async function deleteAndDrive(harness: ControllerHarness, approval: { approvalId: string; token: string }, idempotencyKey?: string): Promise<{ operationId: string; result: unknown; thrown: Error | null }> {
  const response = await harness.request('/v1/applications/fixture-app/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer operator-token' },
    body: JSON.stringify({ approvalId: approval.approvalId, approvalToken: approval.token, sourceCommit: SOURCE_COMMIT, domain: DOMAIN, actor: 'operator', ...(idempotencyKey !== undefined ? { idempotencyKey } : {}) }),
  });
  expect(response.status).toBe(202);
  const enqueued = await response.json() as { workflowId: string; operationId: string };
  const instance = harness.workflowInstances.at(-1);
  if (!instance) throw new Error('workflow instance missing');
  let thrown: Error | null = null;
  let result: unknown = null;
  try {
    result = (await harness.runWorkflow(DecommissionApplicationWorkflow, instance.params, { instanceId: instance.id })).result;
  } catch (error) {
    thrown = error as Error;
  }
  return { operationId: enqueued.operationId, result, thrown };
}

describe('reviewed deletion flow (integration)', () => {
  it('opens the decommission PR with impact report and blocks when reverse dependents exist', async () => {
    const { harness } = await seedDeletionHarness({ dependents: true });
    try {
      const planResponse = await harness.request('/v1/applications/fixture-app/decommission', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer operator-token' }, body: JSON.stringify({}) });
      expect(planResponse.status).toBe(200);
      const plan = await planResponse.json() as { status: string; report: { blockingDependents: string[]; promotionStopped: boolean; serviceKept: boolean } };
      // The seed already issued the plan PR (PR_OPENED asserted there). By the
      // time the test body re-plans, the approved manifest has merged to main,
      // so the machine reports the idempotent ALREADY_DECOMMISSIONING status
      // while still returning the impact report.
      expect(plan.status).toBe('ALREADY_DECOMMISSIONING');
      expect(plan.report.blockingDependents).toEqual(['dependent-app']);
      expect(plan.report).toMatchObject({ promotionStopped: true, serviceKept: true });
      // The plan PR carries the decommissioning manifest on the deterministic branch.
      // The GitHub adapter encodes path slashes (%2F), so the match resolves them.
      const branchWrites = harness.transport.requestsFor('PUT', '/contents/').filter((request) => decodeURIComponent(request.url).includes('/contents/catalog/apps/fixture-app.yaml'));
      const branchBody = branchWrites[0]?.body;
      const encodedContent = branchBody !== null && typeof branchBody === 'object' && !Array.isArray(branchBody) && 'content' in branchBody && typeof branchBody.content === 'string' ? branchBody.content : '';
      const decoded = Buffer.from(encodedContent, 'base64').toString('utf8');
      expect(decoded).toContain('state: decommissioning');

      // The reviewed destroy is blocked by the dependent before any provider mutation.
      const { harness: h2, approval } = await seedDeletionHarness({ dependents: true });
      try {
        const { result, thrown } = await deleteAndDrive(h2, approval);
        expect(thrown).toBeNull();
        const outcome = result as Record<string, unknown>;
        expect(outcome.status).toBe('FAILED');
        expect(outcome.errorCode).toBe('LP-DESTROY-DEPENDENTS');
        expect(h2.transport.count('GET', '/zones')).toBe(0);
        expect(h2.transport.count('DELETE', 'api.vercel.com')).toBe(0);
        expect(h2.transport.count('DELETE', '/dns_records')).toBe(0);
        expect(await h2.store.getApplication('fixture-app')).toMatchObject({ lifecycleState: 'active' });
      } finally {
        h2.restore();
      }
    } finally {
      harness.restore();
    }
  });

  it('destroys in order: DNS records, project, deployment statuses, tombstone; the single-use token cannot be replayed', async () => {
    const { harness, approval } = await seedDeletionHarness();
    try {
      const { operationId, result, thrown } = await deleteAndDrive(harness, approval);
      expect(thrown).toBeNull();
      const outcome = result as Record<string, unknown>;
      expect(outcome.status).toBe('DELETED');
      expect(outcome.tombstone).toMatchObject({ applicationId: 'fixture-app', domain: DOMAIN });

      const run = await harness.store.getWorkflowRun(operationId);
      expect(run?.status).toBe('SUCCEEDED');

      // Ordered teardown through the recorded transport: domain unassign and
      // DNS delete before deployment/project deletion, then GitHub status marking.
      const domainDelete = harness.transport.requestsFor('DELETE', '/v9/projects/fixture-app/domains/fixture.example.com')[0];
      const dnsDelete = harness.transport.requestsFor('DELETE', '/dns_records/dns_1')[0];
      const deploymentDelete = harness.transport.requestsFor('DELETE', '/v13/deployments/dpl_1')[0];
      const projectDelete = harness.transport.requestsFor('DELETE', '/v9/projects/fixture-app').find((request) => request.url.endsWith('/v9/projects/fixture-app'));
      const statusCalls = harness.transport.requestsFor('POST', '/statuses');
      expect(domainDelete).toBeDefined();
      expect(dnsDelete).toBeDefined();
      expect(deploymentDelete).toBeDefined();
      expect(projectDelete).toBeDefined();
      const teardownOrder = [domainDelete, dnsDelete, deploymentDelete, projectDelete].map((request) => harness.transport.requests.indexOf(request));
      expect(teardownOrder).toEqual([...teardownOrder].sort((left, right) => left - right));
      expect(statusCalls).toHaveLength(1);
      const statusBody = statusCalls[0]?.body;
      const statusState = statusBody !== null && typeof statusBody === 'object' && !Array.isArray(statusBody) && 'state' in statusBody ? statusBody.state : undefined;
      expect(statusState).toBe('inactive');

      // Persisted finality: tombstone, deleted lifecycle, consumed approval, export audit.
      expect(await harness.store.isTombstoned('fixture-app')).toBe(true);
      expect(await harness.store.isDomainTombstoned(DOMAIN)).toBe(true);
      expect((await harness.store.getApplication('fixture-app'))?.lifecycleState).toBe('deleted');
      expect((await harness.store.listDeletionApprovals('fixture-app'))[0]?.status).toBe('USED');
      const audits = await harness.store.listAudit('fixture-app');
      expect(audits.some((event) => event.action === 'DELETED' && event.details?.retainUntil)).toBe(true);
      expect(audits.some((event) => event.action === 'DESTROY_EXPORT')).toBe(true);
      expect(audits.some((event) => event.action === 'PROMOTION_STOPPED')).toBe(true);

      // Replaying the same idempotent delete resumes from the durable boundary:
      // the token is not re-consumed and no provider resource is deleted twice.
      const replay = await harness.request('/v1/applications/fixture-app/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer operator-token' },
        body: JSON.stringify({ approvalId: approval.approvalId, approvalToken: approval.token, sourceCommit: SOURCE_COMMIT, domain: DOMAIN, actor: 'operator' }),
      });
      expect(replay.status).toBe(202);
      const replayBody = await replay.json() as { operationId: string };
      expect(replayBody.operationId).toBe(operationId);
      const replayInstance = harness.workflowInstances.at(-1);
      if (!replayInstance) throw new Error('replay instance missing');
      const replayResult = await harness.runWorkflow(DecommissionApplicationWorkflow, replayInstance.params, { instanceId: replayInstance.id });
      expect((replayResult.result as Record<string, unknown>).status).toBe('DELETED');
      expect(harness.transport.count('DELETE', '/dns_records')).toBe(1);
      expect(harness.transport.requestsFor('DELETE', '/v9/projects/fixture-app').filter((request) => request.url.endsWith('/v9/projects/fixture-app'))).toHaveLength(1);
      expect(harness.transport.count('DELETE', '/v9/projects/fixture-app/domains/fixture.example.com')).toBe(1);
      expect(harness.transport.count('DELETE', '/v13/deployments/dpl_1')).toBe(1);
      expect(harness.transport.count('POST', '/statuses')).toBe(1);
      expect(await harness.store.isTombstoned('fixture-app')).toBe(true);
      expect((await harness.store.listAudit('fixture-app')).filter((event) => event.action === 'DELETED')).toHaveLength(1);
    } finally {
      harness.restore();
    }
  });

  it('refuses reuse of a consumed approval token before any second deletion', async () => {
    const { harness, approval } = await seedDeletionHarness();
    try {
      const first = await deleteAndDrive(harness, approval);
      expect((first.result as Record<string, unknown>).status).toBe('DELETED');
      // A fresh delete carrying the consumed token (new idempotency key) is
      // refused by the machine's single-use verification step.
      const second = await deleteAndDrive(harness, approval, 'delete-retry-2');
      expect(second.thrown).toBeNull();
      const outcome = second.result as Record<string, unknown>;
      expect(outcome.status).toBe('FAILED');
      expect(outcome.errorCode).toBe('LP-DESTROY-APPROVAL-USED');
      const run = await harness.store.getWorkflowRun(second.operationId);
      expect(run).toMatchObject({ status: 'FAILED', errorCode: 'LP-DESTROY-APPROVAL-USED' });
      expect(harness.transport.requestsFor('DELETE', '/v9/projects/fixture-app').filter((request) => request.url.endsWith('/v9/projects/fixture-app'))).toHaveLength(1);
      expect(harness.transport.count('DELETE', '/dns_records')).toBe(1);
      expect(await harness.store.isTombstoned('fixture-app')).toBe(true);
    } finally {
      harness.restore();
    }
  });

  it('respects the cooling-off window: a future deleteAfter blocks destruction', async () => {
    const { harness, approval } = await seedDeletionHarness({ deleteAfter: '2026-08-10T00:00:00.000Z' });
    try {
      const { result, thrown } = await deleteAndDrive(harness, approval);
      expect(thrown).toBeNull();
      expect((result as Record<string, unknown>).status).toBe('FAILED');
      expect((result as Record<string, unknown>).errorCode).toBe('LP-DESTROY-COOLING-OFF');
      expect(harness.transport.count('DELETE', 'api.vercel.com')).toBe(0);
      expect(harness.transport.count('DELETE', '/dns_records')).toBe(0);
      expect(await harness.store.isTombstoned('fixture-app')).toBe(false);
    } finally {
      harness.restore();
    }
  });

  it('never deletes when the approved manifest disappeared from the approved commit', async () => {
    const { harness, approval } = await seedDeletionHarness({ manifestAtCommit: false });
    try {
      const { result, thrown } = await deleteAndDrive(harness, approval);
      expect(thrown).toBeNull();
      expect((result as Record<string, unknown>).status).toBe('FAILED');
      expect((result as Record<string, unknown>).errorCode).toBe('BLOCKED_MISSING_MANIFEST');
      expect(harness.transport.count('DELETE', 'api.vercel.com')).toBe(0);
      expect(harness.transport.count('DELETE', '/dns_records')).toBe(0);
      expect((await harness.store.getApplication('fixture-app'))?.lifecycleState).toBe('active');
    } finally {
      harness.restore();
    }
  });

  it('refuses to delete DNS records the application does not own', async () => {
    const { harness, approval } = await seedDeletionHarness({ ownershipComment: 'someone-else' });
    try {
      const { operationId, result, thrown } = await deleteAndDrive(harness, approval);
      expect(thrown).toBeNull();
      expect((result as Record<string, unknown>).status).toBe('FAILED');
      expect((result as Record<string, unknown>).errorCode).toBe('LP-DNS-CONFLICT-UNOWNED');
      const run = await harness.store.getWorkflowRun(operationId);
      expect(run?.status).toBe('FAILED');
      // The unowned DNS record is untouched and the project still exists.
      expect(harness.transport.count('DELETE', '/dns_records')).toBe(0);
      expect(harness.transport.requestsFor('DELETE', '/v9/projects/fixture-app').filter((request) => request.url.endsWith('/v9/projects/fixture-app'))).toHaveLength(0);
      expect(harness.states.cloudflare.records).toHaveLength(1);
      expect(harness.states.vercel.projects.has('fixture-app')).toBe(true);
      expect(await harness.store.isTombstoned('fixture-app')).toBe(false);
    } finally {
      harness.restore();
    }
  });

  it('releases the tombstone only with a reviewed override while retention is active', async () => {
    const { harness, approval } = await seedDeletionHarness();
    try {
      const first = await deleteAndDrive(harness, approval);
      expect((first.result as Record<string, unknown>).status).toBe('DELETED');
      expect(await harness.store.isTombstoned('fixture-app')).toBe(true);

      // Retention has not elapsed: reuse is blocked without review evidence.
      const blocked = await harness.request('/v1/applications/fixture-app/tombstone/release', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer operator-token' }, body: JSON.stringify({ domain: DOMAIN }) });
      expect(blocked.status).toBe(409);
      const blockedBody = await blocked.json() as { code: string };
      expect(blockedBody.code).toBe('LP-TOMBSTONE-REUSE-BLOCKED');
      expect(await harness.store.isTombstoned('fixture-app')).toBe(true);

      // A reviewed override releases the tombstone with attributable evidence.
      const released = await harness.request('/v1/applications/fixture-app/tombstone/release', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer operator-token' },
        body: JSON.stringify({ domain: DOMAIN, override: { reviewedBy: 'operator:dora', reviewedAt: NOW, reason: 'Reviewed replacement application', evidenceUrl: 'https://tracker.example.com/issue/9' } }),
      });
      expect(released.status).toBe(200);
      await expect(released.json()).resolves.toMatchObject({ allowed: true, released: true });
      expect(await harness.store.isTombstoned('fixture-app')).toBe(false);
      expect((await harness.store.listAudit('fixture-app')).some((event) => event.action === 'TOMBSTONE_RELEASED' && event.details?.reviewedBy === 'operator:dora')).toBe(true);
    } finally {
      harness.restore();
    }
  });
});
