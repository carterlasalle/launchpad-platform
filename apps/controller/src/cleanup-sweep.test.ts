import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class WorkflowEntrypoint {
    readonly env: unknown;
    constructor(_context: unknown, env: unknown) { this.env = env; }
  },
}));

import { InMemoryLaunchpadStore } from '@launchpad/database';
import { dispatchDuePreviewCleanup } from './worker.js';

describe('preview cleanup sweep', () => {
  async function seededStore(): Promise<InMemoryLaunchpadStore> {
    const store = new InMemoryLaunchpadStore({ now: () => new Date('2026-08-07T06:00:00.000Z') });
    await store.upsertApplication({ id: 'tokentest', displayName: 'Token Test', sourcePath: 'catalog/apps/fixture.yaml', desiredGeneration: 1, desiredHash: '', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
    return store;
  }

  it('dispatches only cleanup jobs whose retention window elapsed, mapping the durable resource name', async () => {
    const store = await seededStore();
    await store.enqueueCleanupJob({ id: 'due-1', applicationId: 'tokentest', providerResourceId: 'prj_due', expiresAt: '2026-08-07T04:00:00.000Z' });
    await store.enqueueCleanupJob({ id: 'future-1', applicationId: 'tokentest', providerResourceId: 'prj_future', expiresAt: '2026-08-07T10:00:00.000Z' });
    await store.enqueueCleanupJob({ id: 'running-1', applicationId: 'tokentest', providerResourceId: 'prj_running', expiresAt: '2026-08-07T03:00:00.000Z' });
    await store.claimCleanupJob('running-1');
    await store.upsertResource({ applicationId: 'tokentest', provider: 'vercel', resourceType: 'vercel.shadow-project', resourceKey: 'lp-pr-86-tokentest-1323783862-abc-1', providerResourceId: 'prj_due', desiredGeneration: 1, observedHash: 'h', ownershipFingerprint: 'lp-pr-86-tokentest-1323783862-abc-1' });

    const dispatched: Array<Record<string, unknown>> = [];
    const outcome = await dispatchDuePreviewCleanup({
      store,
      dispatch: async (envelope) => { dispatched.push(envelope.payload as Record<string, unknown>); },
      now: () => '2026-08-07T06:00:00.000Z',
    });

    expect(outcome).toEqual({ dispatched: 1, failed: 0 });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      applicationId: 'tokentest',
      projectId: 'lp-pr-86-tokentest-1323783862-abc-1',
      providerResourceId: 'prj_due',
      reason: 'TTL_EXPIRED',
      cleanupJobId: 'due-1',
    });
    // The due job stays QUEUED until the workflow claims it; the sweep only dispatches.
    expect((await store.listCleanupJobs('tokentest')).find((job) => job.id === 'due-1')?.status).toBe('QUEUED');
  });

  it('keeps undeliverable jobs QUEUED for the next sweep and reports the failure', async () => {
    const store = await seededStore();
    await store.enqueueCleanupJob({ id: 'due-2', applicationId: 'tokentest', providerResourceId: 'prj_2', expiresAt: '2026-08-07T04:00:00.000Z' });

    const outcome = await dispatchDuePreviewCleanup({
      store,
      dispatch: async () => { throw new Error('dispatch down'); },
      now: () => '2026-08-07T06:00:00.000Z',
    });

    expect(outcome).toEqual({ dispatched: 0, failed: 1 });
    expect((await store.listCleanupJobs('tokentest'))[0]?.status).toBe('QUEUED');
  });
});
