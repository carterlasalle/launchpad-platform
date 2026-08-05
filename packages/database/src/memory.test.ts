import { describe, it, expect } from 'vitest';
import { runStoreContractSuite, T0 } from './contract.test.js';
import { InMemoryLaunchpadStore } from './memory.js';

describe('InMemoryLaunchpadStore', () => {
  let current = new Date(T0);
  const harness = {
    create: () => new InMemoryLaunchpadStore({ now: () => current }),
    now: () => current,
    advance: (milliseconds: number) => {
      current = new Date(current.getTime() + milliseconds);
    },
  };
  runStoreContractSuite('in-memory', harness);
});

describe('InMemoryLaunchpadStore audit ids', () => {
  it('keeps explicit audit id replay behavior (duplicate rows retained)', async () => {
    const store = new InMemoryLaunchpadStore({ now: () => new Date(T0) });
    const first = await store.appendAudit({ id: 'audit-explicit-replay', actor: 'operator:alice', action: 'DEPLOY_REQUESTED', applicationId: 'app-demo', details: {}, createdAt: T0 });
    const replay = await store.appendAudit({ id: 'audit-explicit-replay', actor: 'operator:alice', action: 'DEPLOY_REQUESTED', applicationId: 'app-demo', details: {}, createdAt: T0 });
    expect(first.id).toBe('audit-explicit-replay');
    expect(replay.id).toBe('audit-explicit-replay');
    expect(await store.listAuditAll()).toHaveLength(2);
  });
});
