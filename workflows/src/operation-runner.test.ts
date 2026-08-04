import { expect, it } from 'vitest';
import { InMemoryDatabase, LaunchpadRepositories } from '@launchpad/database';
import { DurableOperationRunner } from './index.js';

it('persists steps and resumes completed work without duplication', async () => {
  const repositories = new LaunchpadRepositories(new InMemoryDatabase());
  const runner = new DurableOperationRunner(repositories);
  let firstRuns = 0;
  let secondRuns = 0;
  const first = await runner.run({ applicationId: 'app', workflowId: 'wf', action: 'APPLY', idempotencyKey: 'apply-1', payloadHash: 'payload', steps: [
    { id: 'first', preconditionHash: 'a', run: async () => { firstRuns += 1; return { ok: true }; } },
    { id: 'second', preconditionHash: 'b', run: async () => { secondRuns += 1; return { ok: true }; } },
  ] });
  const second = await runner.run({ applicationId: 'app', workflowId: 'wf', action: 'APPLY', idempotencyKey: 'apply-1', payloadHash: 'payload', steps: [
    { id: 'first', preconditionHash: 'a', run: async () => { firstRuns += 1; return { ok: true }; } },
    { id: 'second', preconditionHash: 'b', run: async () => { secondRuns += 1; return { ok: true }; } },
  ] });
  expect(first.status).toBe('SUCCEEDED');
  expect(second.status).toBe('SUCCEEDED');
  expect(firstRuns).toBe(1);
  expect(secondRuns).toBe(1);
});

it('records a failed step instead of reporting success', async () => {
  const repositories = new LaunchpadRepositories(new InMemoryDatabase());
  const runner = new DurableOperationRunner(repositories);
  const result = await runner.run({ applicationId: 'app', workflowId: 'wf-fail', action: 'APPLY', idempotencyKey: 'apply-fail', payloadHash: 'payload', steps: [{ id: 'failure', preconditionHash: 'a', run: async () => { throw new Error('boom'); } }] });
  expect(result.status).toBe('FAILED');
  expect(result.failedStep).toBe('failure');
});
