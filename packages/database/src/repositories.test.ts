import { expect, it } from 'vitest';
import { InMemoryDatabase, LaunchpadRepositories } from './index.js';

it('stores idempotent operations and durable workflow steps', async () => {
  const repositories = new LaunchpadRepositories(new InMemoryDatabase());
  const first = repositories.startOperation({ applicationId: 'app', workflowId: 'wf', action: 'APPLY', idempotencyKey: 'same', payloadHash: 'payload' });
  const second = repositories.startOperation({ applicationId: 'app', workflowId: 'wf', action: 'APPLY', idempotencyKey: 'same', payloadHash: 'payload' });
  expect(second.id).toBe(first.id);
  repositories.recordStep({ operationId: first.id, stepId: 'project', status: 'SUCCEEDED', attempt: 1, preconditionHash: 'p', result: { id: 'prj' }, error: null });
  expect(repositories.getStep(first.id, 'project')?.status).toBe('SUCCEEDED');
});

it('enforces application and domain lock ownership', () => {
  const repositories = new LaunchpadRepositories(new InMemoryDatabase());
  expect(repositories.acquireLock('application:app', 'wf-1', 60)).toBe(true);
  expect(repositories.acquireLock('application:app', 'wf-2', 60)).toBe(false);
  expect(repositories.releaseLock('application:app', 'wf-2')).toBe(false);
  expect(repositories.releaseLock('application:app', 'wf-1')).toBe(true);
  expect(repositories.acquireLock('application:app', 'wf-2', 60)).toBe(true);
});

it('keeps audit events append-only and records tombstones', () => {
  const repositories = new LaunchpadRepositories(new InMemoryDatabase());
  const event = repositories.appendAudit({ actor: 'operator:test', action: 'DECOMMISSION_REQUESTED', applicationId: 'app', details: { reason: 'test' } });
  expect(repositories.listAudit('app')).toEqual([event]);
  const tombstone = repositories.createTombstone({ applicationId: 'app', domain: 'app.example.com', deletedAt: '2026-08-04T00:00:00.000Z', retainUntil: '2026-09-04T00:00:00.000Z' });
  expect(repositories.isTombstoned('app')).toBe(true);
  expect(tombstone.domain).toBe('app.example.com');
});
