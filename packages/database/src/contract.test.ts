import { describe, expect, it } from 'vitest';
import { SensitiveValue, sha256Hex, stableId } from '@launchpad/shared';
import type { HealthCheckRecord, ObservedApplication, PlannedOperation, PlatformPlan } from '@launchpad/core';
import type { LaunchpadStore } from './store.js';
import { InMemoryLaunchpadStore } from './memory.js';

/**
 * Shared contract suite for every `LaunchpadStore` implementation
 * (master plan section 23). Both `InMemoryLaunchpadStore` and
 * `D1LaunchpadStore` run this exact suite; a passing run means the
 * implementations are behaviorally equivalent on every table and invariant.
 */

export interface StoreContractHarness {
  create: () => LaunchpadStore;
  now: () => Date;
  advance: (milliseconds: number) => void;
}

export const T0 = '2026-08-04T00:00:00.000Z';

export function baseApplication(): Parameters<LaunchpadStore['upsertApplication']>[0] {
  return { id: 'app-demo', displayName: 'Demo App', sourcePath: 'catalog/apps/demo', desiredGeneration: 3, desiredHash: 'desired-hash-3', syncStatus: 'SYNCED', healthStatus: 'HEALTHY', lifecycleState: 'active', owners: ['team-launchpad'], domain: 'demo.example.com' };
}

export function baseObservation(): ObservedApplication {
  return { applicationId: 'app-demo', observedAt: T0, desiredGeneration: 3, desiredHash: 'desired-hash-3', observedHash: 'observed-hash-1', resources: [{ provider: 'vercel', resourceType: 'project', providerResourceId: 'prj_demo', resourceKey: 'project', configuration: { name: 'demo' }, ownershipFingerprint: 'fp-project', observedAt: T0 }], deployments: [], health: { status: 'HEALTHY', latest: null } };
}

export function baseOperation(): PlannedOperation {
  return { id: 'op-project', resourceKey: 'project', provider: 'vercel', resourceType: 'project', action: 'UPDATE_IN_PLACE', before: { name: 'old' }, after: { name: 'new' }, prerequisites: [], invalidates: [], idempotencyKey: 'idem-op-project', destructive: false, retryClass: 'NONE' };
}

export function basePlan(): PlatformPlan {
  return { schemaVersion: 'launchpad.plan/v1', applicationId: 'app-demo', desiredGeneration: 3, sourceCommit: 'commit-abc', createdAt: T0, capabilitySnapshotHash: 'cap-1', observedStateHash: 'obs-1', operations: [baseOperation()], downstreamEffects: [], policyResults: [{ rule: 'no-destroy', result: 'PASS', message: 'ok', remediation: null }], fingerprint: 'plan-fingerprint-1', result: 'READY' };
}

export function baseHealthCheck(overrides: Partial<HealthCheckRecord> = {}): HealthCheckRecord {
  return { id: 'hc-1', applicationId: 'app-demo', environment: 'production', deploymentId: 'dep-1', url: 'https://demo.example.com', attempt: 1, dnsResolved: true, tlsValid: true, statusCode: 200, latencyMs: 42, assertionResults: [{ name: 'status', passed: true, message: 'ok' }], result: 'PASSED', checkedAt: T0, errorCode: null, ...overrides };
}

export async function seedApplication(store: LaunchpadStore): Promise<void> {
  await store.upsertApplication(baseApplication());
}

export function runStoreContractSuite(name: string, harness: StoreContractHarness): void {
  describe(name, () => {
    describe('applications', () => {
      it('round-trips an application and its owners', async () => {
        const store = harness.create();
        await seedApplication(store);
        const row = await store.getApplication('app-demo');
        expect(row).toMatchObject({ id: 'app-demo', displayName: 'Demo App', syncStatus: 'SYNCED', healthStatus: 'HEALTHY', lifecycleState: 'active', owners: ['team-launchpad'] });
        expect(await store.getApplication('missing')).toBeNull();
      });

      it('upserts updates in place', async () => {
        const store = harness.create();
        await seedApplication(store);
        const updated = await store.upsertApplication({ ...baseApplication(), displayName: 'Renamed App', desiredGeneration: 4 });
        expect(updated.displayName).toBe('Renamed App');
        expect((await store.getApplication('app-demo'))?.desiredGeneration).toBe(4);
      });

      it('patches sync and health status', async () => {
        const store = harness.create();
        await seedApplication(store);
        const row = await store.updateApplicationStatus('app-demo', { syncStatus: 'OUT_OF_SYNC', healthStatus: 'DEGRADED' });
        expect(row.syncStatus).toBe('OUT_OF_SYNC');
        expect(row.healthStatus).toBe('DEGRADED');
        await expect(store.updateApplicationStatus('missing', { syncStatus: 'SYNCED' })).rejects.toThrow();
      });

      it('enforces the lifecycle state machine forward-only', async () => {
        const store = harness.create();
        await seedApplication(store);
        const decommissioning = await store.setLifecycleState('app-demo', 'decommissioning');
        expect(decommissioning.lifecycleState).toBe('decommissioning');
        expect((await store.setLifecycleState('app-demo', 'active')).lifecycleState).toBe('active');
        await store.setLifecycleState('app-demo', 'decommissioning');
        await store.setLifecycleState('app-demo', 'approved-for-deletion');
        await expect(store.setLifecycleState('app-demo', 'decommissioning')).rejects.toThrow();
        const deleted = await store.setLifecycleState('app-demo', 'deleted');
        expect(deleted.lifecycleState).toBe('deleted');
        await expect(store.setLifecycleState('app-demo', 'active')).rejects.toThrow();
        await expect(store.setLifecycleState('missing', 'decommissioning')).rejects.toThrow();
      });

      it('refuses to re-create a deleted application', async () => {
        const store = harness.create();
        await seedApplication(store);
        await store.setLifecycleState('app-demo', 'decommissioning');
        await store.setLifecycleState('app-demo', 'approved-for-deletion');
        await store.setLifecycleState('app-demo', 'deleted');
        await expect(store.upsertApplication(baseApplication())).rejects.toThrow(/deleted/i);
      });
    });

    describe('desired generations', () => {
      it('advances monotonically and never regresses', async () => {
        const store = harness.create();
        await seedApplication(store);
        await store.advanceDesiredGeneration({ applicationId: 'app-demo', generation: 1, desiredHash: 'h-1' });
        const second = await store.advanceDesiredGeneration({ applicationId: 'app-demo', generation: 2, desiredHash: 'h-2' });
        expect(second.generation).toBe(2);
        expect(second.desiredHash).toBe('h-2');
        await expect(store.advanceDesiredGeneration({ applicationId: 'app-demo', generation: 2, desiredHash: 'h-2' })).rejects.toThrow();
        await expect(store.advanceDesiredGeneration({ applicationId: 'app-demo', generation: 0, desiredHash: 'h-0' })).rejects.toThrow();
        expect((await store.getDesiredGeneration('app-demo'))?.generation).toBe(2);
        await expect(store.advanceDesiredGeneration({ applicationId: 'missing', generation: 1, desiredHash: 'h' })).rejects.toThrow();
      });
    });

    describe('resources and ownership', () => {
      it('keeps one ownership row per provider resource id', async () => {
        const store = harness.create();
        await seedApplication(store);
        const first = await store.upsertResource({ applicationId: 'app-demo', provider: 'vercel', resourceType: 'project', resourceKey: 'project', providerResourceId: 'prj_demo', desiredGeneration: 3, observedHash: 'oh-1', ownershipFingerprint: 'fp-1' });
        const second = await store.upsertResource({ applicationId: 'app-demo', provider: 'vercel', resourceType: 'project', resourceKey: 'project', providerResourceId: 'prj_demo', desiredGeneration: 4, observedHash: 'oh-2', ownershipFingerprint: 'fp-2' });
        expect(second.id).toBe(first.id);
        expect(second.desiredGeneration).toBe(4);
        expect(second.firstSeenAt).toBe(first.firstSeenAt);
        const rows = await store.listResources('app-demo');
        expect(rows).toHaveLength(1);
      });

      it('releases and reactivates ownership', async () => {
        const store = harness.create();
        await seedApplication(store);
        await store.upsertResource({ applicationId: 'app-demo', provider: 'cloudflare', resourceType: 'dns-record', resourceKey: 'demo.example.com', providerResourceId: 'rec_1', desiredGeneration: 3, observedHash: 'oh', ownershipFingerprint: 'fp' });
        const released = await store.releaseResource('cloudflare', 'rec_1');
        expect(released?.status).toBe('RELEASED');
        expect(await store.listResources('app-demo')).toHaveLength(0);
        expect(await store.listResources('app-demo', { includeReleased: true })).toHaveLength(1);
        const reactivated = await store.upsertResource({ applicationId: 'app-demo', provider: 'cloudflare', resourceType: 'dns-record', resourceKey: 'demo.example.com', providerResourceId: 'rec_1', desiredGeneration: 4, observedHash: 'oh-2' });
        expect(reactivated.status).toBe('ACTIVE');
        expect(await store.listResources('app-demo')).toHaveLength(1);
        expect(await store.releaseResource('cloudflare', 'rec_missing')).toBeNull();
      });

      it('rejects resources for unknown applications', async () => {
        const store = harness.create();
        await expect(store.upsertResource({ applicationId: 'missing', provider: 'vercel', resourceType: 'project', resourceKey: 'project', providerResourceId: 'x', desiredGeneration: 1, observedHash: 'oh' })).rejects.toThrow();
      });
    });

    describe('observations', () => {
      it('round-trips observation payloads', async () => {
        const store = harness.create();
        await seedApplication(store);
        const recorded = await store.recordObservation({ applicationId: 'app-demo', observedHash: 'observed-hash-1', payload: baseObservation(), observedAt: T0 });
        const fetched = await store.getObservation(recorded.id);
        expect(fetched?.payload).toEqual(baseObservation());
      });

      it('lists newest observations first with a limit', async () => {
        const store = harness.create();
        await seedApplication(store);
        await store.recordObservation({ applicationId: 'app-demo', observedHash: 'h-1', payload: baseObservation(), observedAt: '2026-08-04T00:00:01.000Z' });
        await store.recordObservation({ applicationId: 'app-demo', observedHash: 'h-2', payload: { ...baseObservation(), observedHash: 'h-2' }, observedAt: '2026-08-04T00:00:02.000Z' });
        const rows = await store.listObservations('app-demo', { limit: 1 });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.observedHash).toBe('h-2');
        await expect(store.recordObservation({ applicationId: 'missing', observedHash: 'h', payload: baseObservation() })).rejects.toThrow();
      });
    });

    describe('plans and plan operations', () => {
      it('stores plans idempotently per fingerprint', async () => {
        const store = harness.create();
        await seedApplication(store);
        const first = await store.savePlan({ applicationId: 'app-demo', plan: basePlan() });
        const replay = await store.savePlan({ applicationId: 'app-demo', plan: basePlan() });
        expect(replay.id).toBe(first.id);
        expect((await store.getPlan(first.id))?.plan.fingerprint).toBe('plan-fingerprint-1');
        expect((await store.getPlanByFingerprint('app-demo', 'plan-fingerprint-1'))?.id).toBe(first.id);
      });

      it('rejects a different plan reusing a fingerprint', async () => {
        const store = harness.create();
        await seedApplication(store);
        await store.savePlan({ applicationId: 'app-demo', plan: basePlan() });
        const different = basePlan();
        different.result = 'DESTRUCTIVE';
        await expect(store.savePlan({ applicationId: 'app-demo', plan: different })).rejects.toThrow();
      });

      it('replaces plan operations atomically', async () => {
        const store = harness.create();
        await seedApplication(store);
        const plan = await store.savePlan({ applicationId: 'app-demo', plan: basePlan() });
        const firstOps = [baseOperation()];
        const secondOps = [{ ...baseOperation(), id: 'op-2', action: 'CREATE' as const, after: { name: 'created' } }];
        await store.replacePlanOperations(plan.id, firstOps);
        expect(await store.listPlanOperations(plan.id)).toEqual(firstOps);
        await store.replacePlanOperations(plan.id, secondOps);
        expect(await store.listPlanOperations(plan.id)).toEqual(secondOps);
        await expect(store.replacePlanOperations('missing-plan', firstOps)).rejects.toThrow();
      });
    });

    describe('workflow runs', () => {
      it('starts runs idempotently by key and payload', async () => {
        const store = harness.create();
        await seedApplication(store);
        const first = await store.startWorkflowRun({ applicationId: 'app-demo', workflowType: 'apply', idempotencyKey: 'ik-apply-1', payloadHash: 'payload-a' });
        expect(first.status).toBe('QUEUED');
        const replay = await store.startWorkflowRun({ applicationId: 'app-demo', workflowType: 'apply', idempotencyKey: 'ik-apply-1', payloadHash: 'payload-a' });
        expect(replay.id).toBe(first.id);
        await expect(store.startWorkflowRun({ applicationId: 'app-demo', workflowType: 'apply', idempotencyKey: 'ik-apply-1', payloadHash: 'payload-B' })).rejects.toThrow();
      });

      it('preserves omitted patch fields and allows explicit clearing', async () => {
        const store = harness.create();
        await seedApplication(store);
        const run = await store.startWorkflowRun({ applicationId: 'app-demo', workflowType: 'apply', idempotencyKey: 'ik-patch', payloadHash: 'p' });
        await store.updateWorkflowRun(run.id, { status: 'PROMOTING', completedAt: '2026-08-04T00:00:03.000Z', errorCode: 'LP-X' });
        await store.updateWorkflowRun(run.id, { status: 'SUCCEEDED' });
        const row = await store.getWorkflowRun(run.id);
        expect(row?.status).toBe('SUCCEEDED');
        expect(row?.completedAt).toBe('2026-08-04T00:00:03.000Z');
        expect(row?.errorCode).toBe('LP-X');
        await store.updateWorkflowRun(run.id, { completedAt: null });
        expect((await store.getWorkflowRun(run.id))?.completedAt).toBeNull();
      });

      it('updates runs and lists open runs', async () => {
        const store = harness.create();
        await seedApplication(store);
        const run = await store.startWorkflowRun({ applicationId: 'app-demo', workflowType: 'apply', idempotencyKey: 'ik-1', payloadHash: 'p' });
        await store.updateWorkflowRun(run.id, { status: 'PROMOTING' });
        expect((await store.getWorkflowRun(run.id))?.status).toBe('PROMOTING');
        await store.updateWorkflowRun(run.id, { status: 'SUCCEEDED', completedAt: '2026-08-04T00:00:05.000Z' });
        expect(await store.listOpenWorkflowRuns('app-demo')).toHaveLength(0);
        await store.startWorkflowRun({ applicationId: 'app-demo', workflowType: 'reconcile', idempotencyKey: 'ik-2', payloadHash: 'p' });
        const open = await store.listOpenWorkflowRuns('app-demo');
        expect(open).toHaveLength(1);
        expect(open[0]?.workflowType).toBe('reconcile');
        await expect(store.updateWorkflowRun('missing', { status: 'FAILED' })).rejects.toThrow();
        await expect(store.startWorkflowRun({ applicationId: 'missing', workflowType: 'apply', idempotencyKey: 'ik-3', payloadHash: 'p' })).rejects.toThrow();
      });

      it('atomically cancels exactly a QUEUED run and appends an immutable audit event', async () => {
        const store = harness.create();
        await seedApplication(store);
        const run = await store.startWorkflowRun({ applicationId: 'app-demo', workflowType: 'apply', idempotencyKey: 'ik-cancel', payloadHash: 'p' });
        const canceledAt = '2026-08-04T00:00:09.000Z';
        const canceled = await store.cancelWorkflowRun({ id: run.id, actor: 'operator:dashboard', idempotencyKey: 'cancel-key-1', canceledAt });
        expect(canceled).toMatchObject({ id: run.id, status: 'CANCELED', completedAt: canceledAt, errorCode: null });
        const row = await store.getWorkflowRun(run.id);
        expect(row?.status).toBe('CANCELED');
        expect(row?.completedAt).toBe(canceledAt);
        // The run is terminal: it no longer appears as open.
        expect(await store.listOpenWorkflowRuns('app-demo')).toHaveLength(0);
        // Exactly one immutable audit event records the cancel with the
        // operation id and idempotency key.
        const events = await store.listAudit('app-demo');
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ actor: 'operator:dashboard', action: 'OPERATOR_CANCEL', applicationId: 'app-demo' });
        expect(events[0]?.details).toEqual({ operationId: run.id, idempotencyKey: 'cancel-key-1', status: 'CANCELED' });
        expect(events[0]?.createdAt).toBe(canceledAt);
      });

      it('never cancels a RUNNING, mid-machine, or terminal run', async () => {
        const store = harness.create();
        await seedApplication(store);
        const running = await store.startWorkflowRun({ applicationId: 'app-demo', workflowType: 'apply', idempotencyKey: 'ik-running', payloadHash: 'p' });
        await store.updateWorkflowRun(running.id, { status: 'RUNNING' });
        await expect(store.cancelWorkflowRun({ id: running.id, actor: 'operator:dashboard', idempotencyKey: 'k-running' })).rejects.toMatchObject({ platform: { code: 'LP-DB-CANCEL-NOT-QUEUED', class: 'CONFLICT' } });
        expect((await store.getWorkflowRun(running.id))?.status).toBe('RUNNING');
        const midMachine = await store.startWorkflowRun({ applicationId: 'app-demo', workflowType: 'apply', idempotencyKey: 'ik-mid', payloadHash: 'p' });
        await store.updateWorkflowRun(midMachine.id, { status: 'PROMOTING' });
        await expect(store.cancelWorkflowRun({ id: midMachine.id, actor: 'operator:dashboard', idempotencyKey: 'k-mid' })).rejects.toMatchObject({ platform: { code: 'LP-DB-CANCEL-NOT-QUEUED' } });
        expect((await store.getWorkflowRun(midMachine.id))?.status).toBe('PROMOTING');
        const finished = await store.startWorkflowRun({ applicationId: 'app-demo', workflowType: 'apply', idempotencyKey: 'ik-finished', payloadHash: 'p' });
        await store.updateWorkflowRun(finished.id, { status: 'SUCCEEDED', completedAt: '2026-08-04T00:00:05.000Z' });
        await expect(store.cancelWorkflowRun({ id: finished.id, actor: 'operator:dashboard', idempotencyKey: 'k-finished' })).rejects.toMatchObject({ platform: { code: 'LP-DB-CANCEL-NOT-QUEUED' } });
        expect((await store.getWorkflowRun(finished.id))?.status).toBe('SUCCEEDED');
        // A canceled run is terminal too: canceling it again is a conflict,
        // never a second state change.
        const canceled = await store.startWorkflowRun({ applicationId: 'app-demo', workflowType: 'apply', idempotencyKey: 'ik-already', payloadHash: 'p' });
        await store.cancelWorkflowRun({ id: canceled.id, actor: 'operator:dashboard', idempotencyKey: 'k-1', canceledAt: '2026-08-04T00:00:09.000Z' });
        await expect(store.cancelWorkflowRun({ id: canceled.id, actor: 'operator:dashboard', idempotencyKey: 'k-2', canceledAt: '2026-08-04T00:00:10.000Z' })).rejects.toMatchObject({ platform: { code: 'LP-DB-CANCEL-NOT-QUEUED' } });
        expect((await store.getWorkflowRun(canceled.id))?.completedAt).toBe('2026-08-04T00:00:09.000Z');
        // Failed rejections wrote no audit events.
        expect(await store.listAuditAll()).toHaveLength(1);
        await expect(store.cancelWorkflowRun({ id: 'missing-run', actor: 'operator:dashboard', idempotencyKey: 'k-missing' })).rejects.toThrow();
      });
    });

    describe('workflow steps', () => {
      it('round-trips serializable step results and errors', async () => {
        const store = harness.create();
        await seedApplication(store);
        const run = await store.startWorkflowRun({ applicationId: 'app-demo', workflowType: 'apply', idempotencyKey: 'ik-steps', payloadHash: 'p' });
        const result = { project: { id: 'prj_demo', nested: [1, 2, { three: true }] }, url: 'https://demo.example.com' };
        await store.recordWorkflowStep({ workflowId: run.id, stepId: 'ensuring-project', status: 'SUCCEEDED', attempt: 1, preconditionHash: 'pre-1', result });
        const step = await store.getWorkflowStep(run.id, 'ensuring-project');
        expect(step?.status).toBe('SUCCEEDED');
        expect(step?.result).toEqual(result);
        await store.recordWorkflowStep({ workflowId: run.id, stepId: 'waiting', status: 'FAILED', attempt: 2, preconditionHash: 'pre-1', error: { name: 'ProviderError', message: 'boom' } });
        expect((await store.getWorkflowStep(run.id, 'waiting'))?.error).toEqual({ name: 'ProviderError', message: 'boom' });
        expect(await store.listWorkflowSteps(run.id)).toHaveLength(2);
        await expect(store.recordWorkflowStep({ workflowId: 'missing-run', stepId: 's', status: 'RUNNING', attempt: 1, preconditionHash: 'p' })).rejects.toThrow();
      });

      it('rejects non-serializable step results', async () => {
        const store = harness.create();
        await seedApplication(store);
        const run = await store.startWorkflowRun({ applicationId: 'app-demo', workflowType: 'apply', idempotencyKey: 'ik-bad', payloadHash: 'p' });
        await expect(store.recordWorkflowStep({ workflowId: run.id, stepId: 's', status: 'SUCCEEDED', attempt: 1, preconditionHash: 'p', result: { secret: new SensitiveValue('hunter2') } })).rejects.toThrow();
      });
    });

    describe('deployments and known-good', () => {
      const deployment = { id: 'dep-1', applicationId: 'app-demo', projectId: 'prj_demo', environment: 'production' as const, repository: 'owner/repo', commitSha: 'sha-1', desiredGeneration: 3, state: 'READY' as const, url: 'https://demo.example.com', createdAt: T0 };

      it('records deployments and lists by environment', async () => {
        const store = harness.create();
        await seedApplication(store);
        await store.recordDeployment(deployment);
        const rows = await store.listDeployments('app-demo', { environment: 'production' });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.commitSha).toBe('sha-1');
        expect(await store.listDeployments('app-demo', { environment: 'staging' })).toHaveLength(0);
        await expect(store.recordDeployment({ ...deployment, applicationId: 'missing' })).rejects.toThrow();
      });

      it('keeps exactly one known-good deployment per environment', async () => {
        const store = harness.create();
        await seedApplication(store);
        await store.recordDeployment(deployment);
        await store.recordDeployment({ ...deployment, id: 'dep-2', commitSha: 'sha-2', url: 'https://demo-v2.example.com' });
        await store.recordKnownGoodDeployment('app-demo', 'production', 'dep-1');
        const first = await store.getKnownGoodDeployment('app-demo', 'production');
        expect(first?.id).toBe('dep-1');
        expect(first?.state).toBe('CURRENT');
        await store.recordKnownGoodDeployment('app-demo', 'production', 'dep-2');
        const second = await store.getKnownGoodDeployment('app-demo', 'production');
        expect(second?.id).toBe('dep-2');
        expect((await store.getDeployment('dep-1'))?.state).toBe('SUPERSEDED');
        const current = (await store.listDeployments('app-demo', { environment: 'production' })).filter((row) => row.state === 'CURRENT');
        expect(current).toHaveLength(1);
        expect(await store.getKnownGoodDeployment('app-demo', 'staging')).toBeNull();
        await expect(store.recordKnownGoodDeployment('app-demo', 'production', 'missing-dep')).rejects.toThrow();
        await expect(store.recordKnownGoodDeployment('app-demo', 'staging', 'dep-1')).rejects.toThrow();
      });
    });

    describe('promotions', () => {
      it('records promotion history', async () => {
        const store = harness.create();
        await seedApplication(store);
        await store.recordDeployment({ id: 'dep-1', applicationId: 'app-demo', projectId: 'prj_demo', environment: 'production', repository: 'owner/repo', commitSha: 'sha-1', desiredGeneration: 3, state: 'READY', url: 'https://demo.example.com', createdAt: T0 });
        const promotion = await store.recordPromotion({ applicationId: 'app-demo', deploymentId: 'dep-1', result: 'PROMOTED', promotedAt: '2026-08-04T00:00:10.000Z' });
        expect(promotion.previousDeploymentId).toBeNull();
        expect(await store.listPromotions('app-demo')).toHaveLength(1);
        await expect(store.recordPromotion({ applicationId: 'app-demo', deploymentId: 'missing-dep', result: 'PROMOTED' })).rejects.toThrow();
      });
    });

    describe('health checks', () => {
      it('round-trips full health records including assertions', async () => {
        const store = harness.create();
        await seedApplication(store);
        const check = baseHealthCheck();
        await store.recordHealthCheck(check);
        const fetched = await store.getHealthCheck('hc-1');
        expect(fetched).toEqual(check);
        expect(await store.listHealthChecksForDeployment('dep-1')).toEqual([check]);
        await expect(store.recordHealthCheck({ ...check, applicationId: 'missing' })).rejects.toThrow();
      });

      it('lists history newest-first with filters', async () => {
        const store = harness.create();
        await seedApplication(store);
        await store.recordHealthCheck(baseHealthCheck({ id: 'hc-1', checkedAt: '2026-08-04T00:00:01.000Z', result: 'PASSED' }));
        await store.recordHealthCheck(baseHealthCheck({ id: 'hc-2', checkedAt: '2026-08-04T00:00:02.000Z', result: 'FAILED', statusCode: 500 }));
        await store.recordHealthCheck(baseHealthCheck({ id: 'hc-3', environment: 'preview', deploymentId: 'dep-9', checkedAt: '2026-08-04T00:00:03.000Z', result: 'PASSED' }));
        const production = await store.listHealthChecks('app-demo', { environment: 'production' });
        expect(production.map((row) => row.id)).toEqual(['hc-2', 'hc-1']);
        expect((await store.listHealthChecks('app-demo', { limit: 1 }))[0]?.id).toBe('hc-3');
      });
    });

    describe('drift events', () => {
      it('records, lists, and resolves drift', async () => {
        const store = harness.create();
        await seedApplication(store);
        const event = await store.recordDriftEvent({ applicationId: 'app-demo', fingerprint: 'fp-drift-1', category: 'MANUAL_CHANGE', payload: { resource: 'project' }, observedAt: T0 });
        expect(event.resolvedAt).toBeNull();
        expect(await store.listDriftEvents('app-demo')).toHaveLength(1);
        const resolved = await store.resolveDriftEvent(event.id, '2026-08-04T00:01:00.000Z');
        expect(resolved.resolvedAt).toBe('2026-08-04T00:01:00.000Z');
        expect(await store.listDriftEvents('app-demo')).toHaveLength(0);
        expect(await store.listDriftEvents('app-demo', { includeResolved: true })).toHaveLength(1);
        await expect(store.resolveDriftEvent('missing', T0)).rejects.toThrow();
      });
    });

    describe('reconciliation requests', () => {
      it('keeps one open request per application and fingerprint', async () => {
        const store = harness.create();
        await seedApplication(store);
        const first = await store.openReconciliationRequest({ applicationId: 'app-demo', fingerprint: 'fp-1', mode: 'restore-desired-state', pullRequestUrl: 'https://github.com/owner/repo/pull/7', openedAt: T0 });
        expect(first.status).toBe('OPEN');
        const duplicate = await store.openReconciliationRequest({ applicationId: 'app-demo', fingerprint: 'fp-1', mode: 'restore-desired-state', pullRequestUrl: 'https://github.com/owner/repo/pull/7' });
        expect(duplicate.id).toBe(first.id);
        expect((await store.getOpenReconciliationRequest('app-demo', 'fp-1'))?.id).toBe(first.id);
        const other = await store.openReconciliationRequest({ applicationId: 'app-demo', fingerprint: 'fp-2', mode: 'adopt-observed-state' });
        expect(other.id).not.toBe(first.id);
      });

      it('reopens the same request after resolution', async () => {
        const store = harness.create();
        await seedApplication(store);
        const first = await store.openReconciliationRequest({ applicationId: 'app-demo', fingerprint: 'fp-1', mode: 'restore-desired-state', pullRequestUrl: 'https://github.com/owner/repo/pull/7' });
        const resolved = await store.resolveReconciliationRequest(first.id, 'RESOLVED', '2026-08-04T00:01:00.000Z');
        expect(resolved.status).toBe('RESOLVED');
        expect(await store.getOpenReconciliationRequest('app-demo', 'fp-1')).toBeNull();
        const reopened = await store.openReconciliationRequest({ applicationId: 'app-demo', fingerprint: 'fp-1', mode: 'restore-desired-state', pullRequestUrl: 'https://github.com/owner/repo/pull/9' });
        expect(reopened.id).toBe(first.id);
        expect(reopened.status).toBe('OPEN');
        expect(reopened.pullRequestUrl).toBe('https://github.com/owner/repo/pull/9');
        expect(await store.listReconciliationRequests('app-demo')).toHaveLength(1);
        await expect(store.resolveReconciliationRequest('missing', 'RESOLVED')).rejects.toThrow();
      });
    });

    describe('provider errors', () => {
      it('round-trips typed provider errors without raw bodies', async () => {
        const store = harness.create();
        await seedApplication(store);
        const recorded = await store.recordProviderError({ applicationId: 'app-demo', operationId: 'op-1', provider: 'vercel', code: 'LP-VERCEL-BUILD-FAILED', class: 'BUILD_FAILURE', message: 'Build failed for project demo', retryable: false, safeDetails: { deploymentId: 'dep-1' }, causeFingerprint: 'cause-1', createdAt: T0 });
        expect(recorded.code).toBe('LP-VERCEL-BUILD-FAILED');
        expect(recorded.safeDetails).toEqual({ deploymentId: 'dep-1' });
        expect(await store.listProviderErrors('app-demo')).toHaveLength(1);
        expect(await store.listProviderErrorsForOperation('op-1')).toHaveLength(1);
      });

      it('never persists sensitive values in error details', async () => {
        const store = harness.create();
        await seedApplication(store);
        await expect(store.recordProviderError({ applicationId: 'app-demo', code: 'LP-SECRET-LEAK', class: 'INTERNAL', message: 'boom', retryable: false, safeDetails: { token: new SensitiveValue('super-secret') } })).rejects.toThrow();
        expect(await store.listProviderErrors('app-demo')).toHaveLength(0);
      });

      it('persists remediation guidance with the stable classification', async () => {
        const store = harness.create();
        await seedApplication(store);
        const recorded = await store.recordProviderError({ applicationId: 'app-demo', code: 'LP-VERCEL-AUTH-401', class: 'AUTHENTICATION', message: 'unauthorized', retryable: false, remediation: 'Rotate the Vercel token.' });
        expect(recorded.remediation).toBe('Rotate the Vercel token.');
        expect((await store.listProviderErrors('app-demo'))[0]?.remediation).toBe('Rotate the Vercel token.');
      });
    });

    describe('incidents and alerts', () => {
      it('upserts one incident per (type, fingerprint) and reopens on refire', async () => {
        const store = harness.create();
        await seedApplication(store);
        const first = await store.recordIncident({ type: 'CONTROLLER_ERROR_RATE', fingerprint: 'fp-1', severity: 'warning', applicationId: 'app-demo', message: 'error rate high', details: { rate: 0.4 }, firedAt: T0 });
        expect(first.firstSeenAt).toBe(T0);
        const duplicate = await store.recordIncident({ type: 'CONTROLLER_ERROR_RATE', fingerprint: 'fp-1', severity: 'warning', applicationId: 'app-demo', message: 'error rate high again', details: { rate: 0.6 }, firedAt: '2026-08-04T01:00:00.000Z' });
        expect(duplicate.id).toBe(first.id);
        expect(duplicate.firstSeenAt).toBe(T0);
        expect(duplicate.lastFiredAt).toBe('2026-08-04T01:00:00.000Z');
        expect(duplicate.resolvedAt).toBeNull();
        const other = await store.recordIncident({ type: 'DLQ', fingerprint: 'q:1', severity: 'critical', message: 'dropped', firedAt: T0 });
        expect(other.id).not.toBe(first.id);
        expect(await store.listIncidents({ openOnly: true })).toHaveLength(2);
        expect(await store.listIncidents({ type: 'DLQ' })).toHaveLength(1);
      });

      it('lists open incidents, resolves them, and keeps history', async () => {
        const store = harness.create();
        await seedApplication(store);
        await store.recordIncident({ type: 'CREDENTIAL_EXPIRY', fingerprint: 'cred-1', severity: 'warning', message: 'token expiring', firedAt: T0 });
        const resolved = await store.resolveIncident((await store.listIncidents())[0]!.id, '2026-08-04T02:00:00.000Z');
        expect(resolved.resolvedAt).toBe('2026-08-04T02:00:00.000Z');
        expect(await store.listIncidents({ openOnly: true })).toHaveLength(0);
        expect(await store.listIncidents()).toHaveLength(1);
        await expect(store.resolveIncident('missing')).rejects.toThrow();
      });

      it('records delivery failures visibly on the incident row', async () => {
        const store = harness.create();
        const incident = await store.recordIncident({ type: 'DLQ', fingerprint: 'q:2', severity: 'critical', message: 'dropped', delivery: { comment: { delivered: false, error: 'LP-GITHUB-COMMENT-WRITE-500' } }, firedAt: T0 });
        expect(incident.delivery).toEqual({ comment: { delivered: false, error: 'LP-GITHUB-COMMENT-WRITE-500' } });
        expect((await store.getIncident('DLQ', 'q:2'))?.delivery).toEqual(incident.delivery);
      });
    });

    describe('metric snapshots', () => {
      it('stores bounded snapshots and lists them newest-first', async () => {
        const store = harness.create();
        const first = await store.recordMetricSnapshot({ metric: 'failures', total: 2, rate: null, windowSeconds: 1800, labels: { provider: 'vercel', workflow: 'apply' }, capturedAt: T0 });
        const second = await store.recordMetricSnapshot({ metric: 'provider_error_rate', total: 1, rate: 0.1, windowSeconds: 1800, labels: {}, capturedAt: '2026-08-04T01:00:00.000Z' });
        expect(first.id).not.toBe(second.id);
        const all = await store.listMetricSnapshots();
        expect(all.map((row) => row.capturedAt)).toEqual(['2026-08-04T01:00:00.000Z', T0]);
        expect(await store.listMetricSnapshots({ metric: 'provider_error_rate' })).toHaveLength(1);
      });
    });

    describe('webhook dedupe', () => {
      it('persists the first receipt and ignores duplicates', async () => {
        const store = harness.create();
        const first = await store.persistWebhookReceipt({ provider: 'vercel', eventId: 'evt-1', payload: { deployment: { id: 'dep-1' } }, receivedAt: T0 });
        expect(first.inserted).toBe(true);
        const duplicate = await store.persistWebhookReceipt({ provider: 'vercel', eventId: 'evt-1', payload: { deployment: { id: 'dep-1' } }, receivedAt: '2026-08-04T00:00:01.000Z' });
        expect(duplicate.inserted).toBe(false);
        expect(duplicate.receipt.payload).toEqual({ deployment: { id: 'dep-1' } });
        const other = await store.persistWebhookReceipt({ provider: 'vercel', eventId: 'evt-2', payload: { deployment: { id: 'dep-2' } } });
        expect(other.inserted).toBe(true);
        expect((await store.getWebhookReceipt('vercel', 'evt-2'))?.eventId).toBe('evt-2');
      });

      it('marks a receipt as dispatched exactly once (first writer wins)', async () => {
        const store = harness.create();
        const persisted = await store.persistWebhookReceipt({ provider: 'vercel', eventId: 'evt-1', payload: { eventId: 'evt-1', type: 'deployment.created' }, receivedAt: T0 });
        expect(persisted.receipt.dispatchedAt).toBeNull();
        const marked = await store.markWebhookReceiptDispatched('vercel', 'evt-1');
        expect(marked?.dispatchedAt).toBeDefined();
        expect(marked?.eventId).toBe('evt-1');
        // Idempotent: a second mark keeps the first timestamp.
        const again = await store.markWebhookReceiptDispatched('vercel', 'evt-1');
        expect(again?.dispatchedAt).toBe(marked?.dispatchedAt);
        // The receipt readback exposes the marker.
        expect((await store.getWebhookReceipt('vercel', 'evt-1'))?.dispatchedAt).toBe(marked?.dispatchedAt);
        // Unknown receipts stay null-returning.
        expect(await store.markWebhookReceiptDispatched('vercel', 'missing')).toBeNull();
      });
    });

    describe('cleanup jobs', () => {
      it('enqueues, claims, and completes', async () => {
        const store = harness.create();
        await seedApplication(store);
        const job = await store.enqueueCleanupJob({ applicationId: 'app-demo', providerResourceId: 'prj_demo', expiresAt: '2026-09-04T00:00:00.000Z' });
        expect(job.status).toBe('QUEUED');
        expect(job.attempts).toBe(0);
        const claimed = await store.claimCleanupJob(job.id);
        expect(claimed.status).toBe('RUNNING');
        expect(claimed.attempts).toBe(1);
        await expect(store.claimCleanupJob(job.id)).rejects.toThrow();
        const completed = await store.completeCleanupJob(job.id, 'SUCCEEDED');
        expect(completed.status).toBe('SUCCEEDED');
        expect(await store.listPendingCleanupJobs()).toHaveLength(0);
        await expect(store.claimCleanupJob('missing')).rejects.toThrow();
        await expect(store.enqueueCleanupJob({ applicationId: 'missing', providerResourceId: 'x', expiresAt: '2026-09-04T00:00:00.000Z' })).rejects.toThrow();
      });

      it('records failures with the last error', async () => {
        const store = harness.create();
        await seedApplication(store);
        const job = await store.enqueueCleanupJob({ applicationId: 'app-demo', providerResourceId: 'prj_demo', expiresAt: '2026-09-04T00:00:00.000Z' });
        await store.claimCleanupJob(job.id);
        const failed = await store.completeCleanupJob(job.id, 'FAILED', 'LP-DNS-DELETE-FAILED');
        expect(failed.status).toBe('FAILED');
        expect(failed.lastError).toBe('LP-DNS-DELETE-FAILED');
        const again = await store.completeCleanupJob(job.id, 'SUCCEEDED');
        expect(again.status).toBe('FAILED');
      });
    });

    describe('tombstones', () => {
      async function tombstoneApp(store: LaunchpadStore): Promise<void> {
        await seedApplication(store);
        await store.setLifecycleState('app-demo', 'decommissioning');
        await store.setLifecycleState('app-demo', 'approved-for-deletion');
        await store.setLifecycleState('app-demo', 'deleted');
      }

      it('tombstones only deleted applications', async () => {
        const store = harness.create();
        await seedApplication(store);
        await expect(store.createTombstone({ applicationId: 'app-demo', domain: 'demo.example.com', retainUntil: '2027-08-04T00:00:00.000Z' })).rejects.toThrow();
        await tombstoneApp(store);
        const tombstone = await store.createTombstone({ applicationId: 'app-demo', domain: 'demo.example.com', retainUntil: '2027-08-04T00:00:00.000Z' });
        expect(tombstone.domain).toBe('demo.example.com');
        expect(await store.isTombstoned('app-demo')).toBe(true);
        expect(await store.isDomainTombstoned('demo.example.com')).toBe(true);
        await expect(store.createTombstone({ applicationId: 'app-demo', domain: 'demo.example.com', retainUntil: '2027-08-04T00:00:00.000Z' })).rejects.toThrow();
      });

      it('blocks application id and domain reuse', async () => {
        const store = harness.create();
        await tombstoneApp(store);
        await store.createTombstone({ applicationId: 'app-demo', domain: 'demo.example.com', retainUntil: '2027-08-04T00:00:00.000Z' });
        await expect(store.upsertApplication(baseApplication())).rejects.toThrow(/tombstone/i);
        await expect(store.upsertApplication({ ...baseApplication(), id: 'app-other', domain: 'demo.example.com' })).rejects.toThrow(/tombstone/i);
        expect(await store.getTombstone('missing')).toBeNull();
      });
    });

    describe('audit events', () => {
      it('appends chronologically and filters by application', async () => {
        const store = harness.create();
        await seedApplication(store);
        const first = await store.appendAudit({ actor: 'operator:alice', action: 'LIFECYCLE_CHANGED', applicationId: 'app-demo', details: { from: 'active', to: 'decommissioning' }, createdAt: T0 });
        const second = await store.appendAudit({ actor: 'operator:alice', action: 'APPROVAL_CREATED', applicationId: 'app-demo', details: { approvalId: 'ap-1' }, createdAt: '2026-08-04T00:00:01.000Z' });
        await store.appendAudit({ actor: 'operator:bob', action: 'PLATFORM_EVENT', details: { note: 'global' }, createdAt: '2026-08-04T00:00:02.000Z' });
        const events = await store.listAudit('app-demo');
        expect(events.map((event) => event.id)).toEqual([first.id, second.id]);
        expect(events[0]?.details).toEqual({ from: 'active', to: 'decommissioning' });
        expect(await store.listAuditAll()).toHaveLength(3);
        expect((await store.listAuditAll({ limit: 2 })).map((event) => event.action)).toEqual(['APPROVAL_CREATED', 'PLATFORM_EVENT']);
      });

      it('is append-only: no update or delete surface exists', async () => {
        const store = harness.create();
        const typed = store as unknown as Record<string, unknown>;
        expect(typeof typed.appendAudit).toBe('function');
        expect(typed.updateAudit).toBeUndefined();
        expect(typed.deleteAudit).toBeUndefined();
        expect(typed.clearAudit).toBeUndefined();
      });

      it('generates unique default ids across store instances for identical events', async () => {
        const first = harness.create();
        const second = harness.create();
        const events = await Promise.all([
          first.appendAudit({ actor: 'operator:alice', action: 'DEPLOY_REQUESTED', applicationId: 'app-demo', details: { note: 'same' }, createdAt: T0 }),
          second.appendAudit({ actor: 'operator:alice', action: 'DEPLOY_REQUESTED', applicationId: 'app-demo', details: { note: 'same' }, createdAt: T0 }),
        ]);
        expect(events[0]?.id).not.toBe(events[1]?.id);
        for (const event of events) {
          expect(event.id).toMatch(/^audit-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        }
        expect(await first.listAuditAll()).toHaveLength(1);
        expect(await second.listAuditAll()).toHaveLength(1);
      });

      it('retains every concurrent identical append within one instance', async () => {
        const store = harness.create();
        await seedApplication(store);
        const events = await Promise.all(Array.from({ length: 8 }, () => store.appendAudit({ actor: 'operator:alice', action: 'DEPLOY_REQUESTED', applicationId: 'app-demo', details: {}, createdAt: T0 })));
        expect(new Set(events.map((event) => event.id)).size).toBe(8);
        expect(await store.listAuditAll()).toHaveLength(8);
      });

      it('uses explicit ids verbatim', async () => {
        const store = harness.create();
        await seedApplication(store);
        const event = await store.appendAudit({ id: 'audit-explicit-1', actor: 'operator:alice', action: 'DEPLOY_REQUESTED', applicationId: 'app-demo', details: {}, createdAt: T0 });
        expect(event.id).toBe('audit-explicit-1');
        expect((await store.listAuditAll())[0]?.id).toBe('audit-explicit-1');
      });
    });

    describe('credentials metadata', () => {
      it('stores fingerprints, never values, and tracks status', async () => {
        const store = harness.create();
        const row = await store.upsertCredentialMetadata({ id: 'cred-vercel', provider: 'vercel', purpose: 'read-write-token', valueFingerprint: 'fp-token-1', lastCheckedAt: T0, status: 'VALID' });
        expect(row.valueFingerprint).toBe('fp-token-1');
        expect(row).not.toHaveProperty('value');
        await store.upsertCredentialMetadata({ id: 'cred-vercel', provider: 'vercel', purpose: 'read-write-token', valueFingerprint: 'fp-token-2', lastCheckedAt: T0, status: 'VALID' });
        expect((await store.getCredentialMetadata('cred-vercel'))?.valueFingerprint).toBe('fp-token-2');
        await store.upsertCredentialMetadata({ id: 'cred-cf', provider: 'cloudflare', purpose: 'dns-zone-token', lastCheckedAt: T0, status: 'EXPIRING_SOON', expiresAt: '2026-09-01T00:00:00.000Z' });
        expect(await store.listCredentialsMetadata('vercel')).toHaveLength(1);
        expect(await store.listCredentialsMetadata()).toHaveLength(2);
        const updated = await store.updateCredentialStatus('cred-vercel', 'EXPIRED', '2026-08-05T00:00:00.000Z');
        expect(updated.status).toBe('EXPIRED');
        await expect(store.updateCredentialStatus('missing', 'REVOKED', T0)).rejects.toThrow();
      });
    });

    describe('locks', () => {
      it('enforces single-owner application and domain locks', async () => {
        const store = harness.create();
        expect(await store.acquireLock('application:app-demo', 'wf-1', 60)).toBe(true);
        expect(await store.acquireLock('application:app-demo', 'wf-2', 60)).toBe(false);
        expect(await store.acquireLock('application:app-demo', 'wf-1', 60)).toBe(true);
        expect(await store.acquireLock('domain:demo.example.com', 'wf-2', 60)).toBe(true);
        expect(await store.releaseLock('application:app-demo', 'wf-2')).toBe(false);
        expect(await store.releaseLock('application:app-demo', 'wf-1')).toBe(true);
        expect(await store.acquireLock('application:app-demo', 'wf-2', 60)).toBe(true);
      });

      it('preempts expired locks and rejects invalid keys', async () => {
        const store = harness.create();
        await expect(store.acquireLock('project:demo', 'wf-1', 60)).rejects.toThrow();
        expect(await store.acquireLock('application:app-demo', 'wf-1', 60)).toBe(true);
        harness.advance(61_000);
        expect(await store.acquireLock('application:app-demo', 'wf-2', 60)).toBe(true);
        expect(await store.renewLock('application:app-demo', 'wf-1', 60)).toBe(false);
      });

      it('renews and reports lock records', async () => {
        const store = harness.create();
        expect(await store.acquireLock('domain:demo.example.com', 'wf-1', 60)).toBe(true);
        expect(await store.renewLock('domain:demo.example.com', 'wf-1', 60)).toBe(true);
        expect(await store.renewLock('domain:demo.example.com', 'wf-2', 60)).toBe(false);
        const lock = await store.getLock('domain:demo.example.com');
        expect(lock?.ownerId).toBe('wf-1');
        expect(lock && lock.expiresAt > lock.acquiredAt).toBe(true);
        harness.advance(61_000);
        expect(await store.renewLock('domain:demo.example.com', 'wf-1', 60)).toBe(false);
        expect((await store.getLock('domain:demo.example.com'))?.expiresAt).toBeDefined();
      });
    });

    describe('idempotent requests', () => {
      it('registers once and rejects payload reuse', async () => {
        const store = harness.create();
        await seedApplication(store);
        const run = await store.startWorkflowRun({ applicationId: 'app-demo', workflowType: 'apply', idempotencyKey: 'ik-request-1', payloadHash: 'payload-1' });
        await store.registerIdempotentRequest({ idempotencyKey: 'req-key-1', operationId: run.id, payloadHash: 'payload-1' });
        const replay = await store.registerIdempotentRequest({ idempotencyKey: 'req-key-1', operationId: run.id, payloadHash: 'payload-1' });
        expect(replay.operationId).toBe(run.id);
        await expect(store.registerIdempotentRequest({ idempotencyKey: 'req-key-1', operationId: run.id, payloadHash: 'payload-2' })).rejects.toThrow();
        await expect(store.registerIdempotentRequest({ idempotencyKey: 'req-key-2', operationId: 'missing-run', payloadHash: 'p' })).rejects.toThrow();
      });
    });

    describe('plan review attestations', () => {
      function baseAttestation(): Parameters<LaunchpadStore['savePlanReviewAttestation']>[0] {
        return { applicationId: 'app-demo', prHeadSourceCommit: 'a'.repeat(40), desiredHash: 'd'.repeat(64), generation: 3, planFingerprint: 'plan-fp-1', reviewFingerprint: 'review-fp-1', repository: 'acme/demo', actor: 'alice', workflowRef: 'acme/demo/.github/workflows/preview.yml@refs/heads/main', createdAt: T0 };
      }

      it('stores attestations idempotently per (application, review fingerprint)', async () => {
        const store = harness.create();
        await seedApplication(store);
        const first = await store.savePlanReviewAttestation(baseAttestation());
        expect(first.inserted).toBe(true);
        expect(first.attestation).toMatchObject({ applicationId: 'app-demo', prHeadSourceCommit: 'a'.repeat(40), desiredHash: 'd'.repeat(64), generation: 3, planFingerprint: 'plan-fp-1', reviewFingerprint: 'review-fp-1', repository: 'acme/demo', actor: 'alice', workflowRef: 'acme/demo/.github/workflows/preview.yml@refs/heads/main' });
        expect(first.attestation.id).toBe(stableId('plan-review', 'app-demo', 'review-fp-1'));
        const replay = await store.savePlanReviewAttestation(baseAttestation());
        expect(replay.inserted).toBe(false);
        expect(replay.attestation.id).toBe(first.attestation.id);
        // A replay that keeps the same review fingerprint but changes the
        // desired-state binding fails closed.
        await expect(store.savePlanReviewAttestation({ ...baseAttestation(), desiredHash: 'e'.repeat(64) })).rejects.toThrow();
        await expect(store.savePlanReviewAttestation({ ...baseAttestation(), generation: 9 })).rejects.toThrow();
        await expect(store.savePlanReviewAttestation({ ...baseAttestation(), planFingerprint: 'plan-fp-2' })).rejects.toThrow();
        await expect(store.savePlanReviewAttestation({ ...baseAttestation(), repository: 'evil/demo' })).rejects.toThrow();
        expect(await store.getPlanReviewAttestation('app-demo', 'review-fp-1')).toMatchObject({ desiredHash: 'd'.repeat(64) });
        expect(await store.getPlanReviewAttestation('app-demo', 'review-fp-other')).toBeNull();
        expect((await store.listPlanReviewAttestations('app-demo'))[0]?.reviewFingerprint).toBe('review-fp-1');
        await expect(store.savePlanReviewAttestation({ ...baseAttestation(), applicationId: 'missing' })).rejects.toThrow();
      });

      it('stores one attestation per review fingerprint and lists newest first', async () => {
        const store = harness.create();
        await seedApplication(store);
        const first = await store.savePlanReviewAttestation({ ...baseAttestation(), reviewFingerprint: 'review-1', createdAt: '2026-08-04T00:00:00.000Z' });
        const second = await store.savePlanReviewAttestation({ ...baseAttestation(), reviewFingerprint: 'review-2', planFingerprint: 'plan-fp-2', desiredHash: 'e'.repeat(64), createdAt: '2026-08-04T01:00:00.000Z' });
        expect(first.attestation.id).not.toBe(second.attestation.id);
        const rows = await store.listPlanReviewAttestations('app-demo');
        expect(rows.map((row) => row.reviewFingerprint)).toEqual(['review-2', 'review-1']);
      });
    });

    describe('deletion approvals', () => {
      it('stores only token fingerprints and consumes once', async () => {
        const store = harness.create();
        await seedApplication(store);
        const approval = await store.createDeletionApproval({ applicationId: 'app-demo', token: 'approval-token-1', requestedBy: 'operator:alice', expiresAt: '2026-09-01T00:00:00.000Z', createdAt: T0 });
        expect(approval.status).toBe('PENDING');
        expect(approval).not.toHaveProperty('token');
        expect(approval.tokenHash).toBe(await sha256Hex('approval-token-1'));
        const consumed = await store.consumeDeletionApproval('app-demo', 'approval-token-1', '2026-08-05T00:00:00.000Z');
        expect(consumed.status).toBe('USED');
        expect(consumed.usedAt).toBe('2026-08-05T00:00:00.000Z');
        await expect(store.consumeDeletionApproval('app-demo', 'approval-token-1')).rejects.toThrow();
        await expect(store.consumeDeletionApproval('app-demo', 'wrong-token')).rejects.toThrow();
      });

      it('rejects expired and revoked approvals', async () => {
        const store = harness.create();
        await seedApplication(store);
        await store.createDeletionApproval({ applicationId: 'app-demo', token: 'token-old', expiresAt: '2026-08-01T00:00:00.000Z' });
        await expect(store.consumeDeletionApproval('app-demo', 'token-old')).rejects.toThrow();
        await store.createDeletionApproval({ applicationId: 'app-demo', token: 'token-revoke', expiresAt: '2026-09-01T00:00:00.000Z' });
        const revokeHash = await sha256Hex('token-revoke');
        const revoked = await store.revokeDeletionApproval((await store.listDeletionApprovals('app-demo')).find((row) => row.tokenHash === revokeHash)?.id ?? '');
        expect(revoked.status).toBe('REVOKED');
        await expect(store.consumeDeletionApproval('app-demo', 'token-revoke')).rejects.toThrow();
        await expect(store.revokeDeletionApproval(revoked.id)).rejects.toThrow();
        await expect(store.createDeletionApproval({ applicationId: 'app-demo', token: 'token-revoke', expiresAt: '2026-09-01T00:00:00.000Z' })).rejects.toThrow();
        await expect(store.consumeDeletionApproval('missing', 'token-x')).rejects.toThrow();
      });
    });

    describe('dashboard query models', () => {
      it('listApplications reports truthful joined state', async () => {
        const store = harness.create();
        await seedApplication(store);
        await store.recordDeployment({ id: 'dep-1', applicationId: 'app-demo', projectId: 'prj_demo', environment: 'production', repository: 'owner/repo', commitSha: 'sha-1', desiredGeneration: 3, state: 'READY', url: 'https://demo.example.com', createdAt: T0 });
        await store.recordKnownGoodDeployment('app-demo', 'production', 'dep-1', '2026-08-04T00:00:10.000Z');
        await store.recordHealthCheck(baseHealthCheck());
        const run = await store.startWorkflowRun({ applicationId: 'app-demo', workflowType: 'apply', idempotencyKey: 'ik-dash', payloadHash: 'p' });
        await store.updateWorkflowRun(run.id, { status: 'PROMOTING' });
        const first = await store.openReconciliationRequest({ applicationId: 'app-demo', fingerprint: 'fp-1', mode: 'restore-desired-state', pullRequestUrl: 'https://github.com/owner/repo/pull/7' });
        await store.resolveReconciliationRequest(first.id, 'RESOLVED', '2026-08-04T00:05:00.000Z');
        await store.openReconciliationRequest({ applicationId: 'app-demo', fingerprint: 'fp-2', mode: 'restore-desired-state', pullRequestUrl: 'https://github.com/owner/repo/pull/9' });
        const rows = await store.listApplications();
        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row).toMatchObject({ application: 'app-demo', owner: 'team-launchpad', sync: 'SYNCED', health: 'HEALTHY', deployment: 'CURRENT', currentDeploymentCommit: 'sha-1', productionUrl: 'https://demo.example.com', activeOperation: 'PROMOTING', openPrOrIncident: 'https://github.com/owner/repo/pull/9', lastSuccessfulReconciliation: '2026-08-04T00:05:00.000Z' });
        expect(await store.listApplications()).toHaveLength(1);
      });

      it('listApplications is empty before any application exists', async () => {
        const store = harness.create();
        expect(await store.listApplications()).toEqual([]);
      });

      it('getApplicationDetail joins application, known-good, health, and runs', async () => {
        const store = harness.create();
        await seedApplication(store);
        await store.recordDeployment({ id: 'dep-1', applicationId: 'app-demo', projectId: 'prj_demo', environment: 'production', repository: 'owner/repo', commitSha: 'sha-1', desiredGeneration: 3, state: 'READY', url: 'https://demo.example.com', createdAt: T0 });
        await store.recordKnownGoodDeployment('app-demo', 'production', 'dep-1');
        await store.recordHealthCheck(baseHealthCheck());
        await store.startWorkflowRun({ applicationId: 'app-demo', workflowType: 'reconcile', idempotencyKey: 'ik-open', payloadHash: 'p' });
        await store.startWorkflowRun({ applicationId: 'app-demo', workflowType: 'apply', idempotencyKey: 'ik-done', payloadHash: 'p' }).then((run) => store.updateWorkflowRun(run.id, { status: 'SUCCEEDED' }));
        const detail = await store.getApplicationDetail('app-demo');
        expect(detail.application?.id).toBe('app-demo');
        expect(detail.knownGoodDeployment?.id).toBe('dep-1');
        expect(detail.latestHealthCheck?.id).toBe('hc-1');
        expect(detail.openWorkflowRuns.map((run) => run.workflowType)).toEqual(['reconcile']);
        expect(detail.recentWorkflowRuns).toHaveLength(2);
        const missing = await store.getApplicationDetail('missing');
        expect(missing.application).toBeNull();
        expect(missing.openWorkflowRuns).toEqual([]);
      });
    });

    describe('id determinism', () => {
      it('derives deterministic ids from stable inputs', async () => {
        const store = harness.create();
        await seedApplication(store);
        const run = await store.startWorkflowRun({ applicationId: 'app-demo', workflowType: 'apply', idempotencyKey: 'ik-deterministic', payloadHash: 'p' });
        expect(run.id).toBe(stableId('workflow-run', 'app-demo', 'ik-deterministic'));
        const plan = await store.savePlan({ applicationId: 'app-demo', plan: basePlan() });
        expect(plan.id).toBe(stableId('plan', 'app-demo', 'plan-fingerprint-1'));
        const approval = await store.createDeletionApproval({ applicationId: 'app-demo', token: 'tok', expiresAt: '2026-09-01T00:00:00.000Z' });
        expect(approval.id).toBe(stableId('deletion-approval', 'app-demo', await sha256Hex('tok')));
      });
    });
  });
}

/**
 * Default registration: this file is itself a runnable suite against the
 * in-memory store, so loading it directly executes every shared assertion.
 * The store-specific suites (memory.test.ts, d1.test.ts) import the same
 * `runStoreContractSuite` and run it against their own harnesses.
 */
let defaultNow = new Date(T0);
runStoreContractSuite('in-memory (shared suite)', {
  create: () => new InMemoryLaunchpadStore({ now: () => defaultNow }),
  now: () => defaultNow,
  advance: (milliseconds: number) => {
    defaultNow = new Date(defaultNow.getTime() + milliseconds);
  },
});
