import { expect, it } from 'vitest';
import { InMemoryLaunchpadStore } from '@launchpad/database';
import { DurableOperationRunner } from './index.js';

async function seededStore(): Promise<InMemoryLaunchpadStore> {
  const store = new InMemoryLaunchpadStore();
  await store.upsertApplication({ id: 'app', displayName: 'App', sourcePath: 'catalog/apps/app.yaml', desiredGeneration: 1, desiredHash: '', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
  return store;
}

const runInput = (steps: Parameters<DurableOperationRunner['run']>[0]['steps'], overrides: Partial<Parameters<DurableOperationRunner['run']>[0]> = {}) => ({
  applicationId: 'app', workflowId: 'wf', action: 'APPLY', idempotencyKey: 'apply-1', payloadHash: 'payload', steps,
  sleep: async () => undefined,
  ...overrides,
});

it('persists steps and resumes completed work without duplication', async () => {
  const store = await seededStore();
  const runner = new DurableOperationRunner(store);
  let firstRuns = 0;
  let secondRuns = 0;
  const steps = [
    { id: 'first', preconditionHash: 'a', run: async () => { firstRuns += 1; return { ok: true }; } },
    { id: 'second', preconditionHash: 'b', run: async () => { secondRuns += 1; return { ok: true }; } },
  ];
  const first = await runner.run(runInput(steps));
  const second = await runner.run(runInput(steps));
  expect(first.status).toBe('SUCCEEDED');
  expect(second.status).toBe('SUCCEEDED');
  expect(firstRuns).toBe(1);
  expect(secondRuns).toBe(1);
  expect(second.outputs).toEqual(first.outputs);
});

it('passes persisted outputs of prior steps explicitly to later steps', async () => {
  const store = await seededStore();
  const runner = new DurableOperationRunner(store);
  const seen: unknown[] = [];
  const run = await runner.run(runInput([
    { id: 'producer', preconditionHash: 'a', run: async () => ({ value: 42 }) },
    { id: 'consumer', preconditionHash: 'b', run: async (_attempt, stepContext) => { seen.push(stepContext.outputs['producer']); return { consumed: true }; } },
  ]));
  expect(run.status).toBe('SUCCEEDED');
  expect(seen).toEqual([{ value: 42 }]);
});

it('records a failed step instead of reporting success', async () => {
  const store = await seededStore();
  const runner = new DurableOperationRunner(store);
  const result = await runner.run(runInput([{ id: 'failure', preconditionHash: 'a', run: async () => { throw new Error('boom'); } }]));
  expect(result.status).toBe('FAILED');
  expect(result.failedStep).toBe('failure');
  expect((await store.getWorkflowRun(result.operationId))?.status).toBe('FAILED');
  expect((await store.getWorkflowStep(result.operationId, 'failure'))?.status).toBe('FAILED');
});

it('retries only typed retryable failures with bounded attempts', async () => {
  const store = await seededStore();
  const runner = new DurableOperationRunner(store);
  let attempts = 0;
  const result = await runner.run(runInput([
    { id: 'flaky', preconditionHash: 'a', retry: { maxAttempts: 3, baseDelayMs: 1 }, run: async () => { attempts += 1; if (attempts < 3) throw Object.assign(new Error('transient'), { retryable: true, name: 'LP-TRANSIENT' }); return { ok: true }; } },
  ]));
  expect(result.status).toBe('SUCCEEDED');
  expect(attempts).toBe(3);
  const step = await store.getWorkflowStep(result.operationId, 'flaky');
  expect(step?.status).toBe('SUCCEEDED');
  expect(step?.attempt).toBe(3);
});

it('runs the recovery step on failure and keeps the run failed', async () => {
  const store = await seededStore();
  const runner = new DurableOperationRunner(store);
  const result = await runner.run({
    ...runInput([{ id: 'gate', preconditionHash: 'a', run: async () => { throw Object.assign(new Error('gate failed'), { name: 'LP-GATE-FAILED' }); } }]),
    onFailure: async ({ failedStep }) => ({ rollback: { deploymentId: 'dpl_old', restored: true }, failedStep }),
  });
  expect(result.status).toBe('FAILED');
  expect(result.failedStep).toBe('gate');
  expect(result.recovery).toEqual({ rollback: { deploymentId: 'dpl_old', restored: true }, failedStep: 'gate' });
  expect((await store.getWorkflowStep(result.operationId, 'recover-on-failure'))?.status).toBe('SUCCEEDED');
  expect((await store.getWorkflowRun(result.operationId))?.status).toBe('FAILED');
});

it('releases locks in finally paths and records the release step', async () => {
  const store = await seededStore();
  const runner = new DurableOperationRunner(store);
  let released = false;
  const result = await runner.run({ ...runInput([{ id: 'only', preconditionHash: 'a', run: async () => ({ ok: true }) }]), releaseLocks: async () => { released = true; } });
  expect(result.status).toBe('SUCCEEDED');
  expect(released).toBe(true);
  expect((await store.getWorkflowStep(result.operationId, 'release-locks'))?.status).toBe('SUCCEEDED');
});

it('rejects duplicate idempotency keys carrying a different payload', async () => {
  const store = await seededStore();
  const runner = new DurableOperationRunner(store);
  const input = runInput([{ id: 'only', preconditionHash: 'a', run: async () => ({ ok: true }) }]);
  await runner.run(input);
  await expect(runner.run({ ...input, payloadHash: 'different-payload' })).rejects.toThrow('already used with a different payload');
});
