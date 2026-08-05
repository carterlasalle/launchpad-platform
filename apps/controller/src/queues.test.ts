import { describe, expect, it } from 'vitest';
import { classifyQueueError, createHttpQueueDispatcher, createProviderEventFanout, createQueueEnvelope, createReconciliationEnvelope, createReconciliationWorkflowDispatcher, DEAD_LETTER_QUEUE, dispatchScheduledReconciliation, handleQueue, parseProviderEventFanoutLimit, parseProviderEventShardCount, parseQueueEnvelope, parseReconciliationEnvelope, parseReconciliationShardCount, providerEventReconciliationParams, reconciliationInstanceId, QueueFailure, type IncidentRequest, type ProviderEventFanOutcome, type ProviderEventFanout, type ProviderEventFanoutDependencies, type QueueBatch, type QueueDispatcher, type QueueEnvelope, type QueuePersistence, type ReconciliationDispatcher, type ReconciliationEnvelope } from './queues.js';

const NOW = new Date('2026-08-04T08:30:00.000Z');

function envelope(kind: QueueEnvelope['kind'] = 'provider-event', id = 'evt-1'): QueueEnvelope {
  return createQueueEnvelope({ kind, id, payload: { applicationId: 'tokentest' }, now: NOW });
}

function batch(messages: Array<{ id: string; body: unknown; attempts: number }>, queue = 'launchpad-provider-events'): { batch: QueueBatch; acked: string[]; retried: string[] } {
  const acked: string[] = [];
  const retried: string[] = [];
  return { batch: { queue, messages, ack: (message) => { acked.push(message.id); }, retry: (message) => { retried.push(message.id); } }, acked, retried };
}

function persistence(incidents: IncidentRequest[]): QueuePersistence {
  return { recordIncident: (request) => { incidents.push(request); } };
}

function dispatcher(behavior: (value: QueueEnvelope) => Promise<void> | void): QueueDispatcher {
  return { dispatch: (value) => Promise.resolve(behavior(value)) };
}

describe('parseQueueEnvelope', () => {
  it('parses a valid versioned envelope', () => {
    const value = envelope();
    expect(parseQueueEnvelope(value)).toEqual(value);
  });

  it('rejects malformed envelopes with a typed failure', () => {
    const valid = { version: 1, kind: 'provider-event', id: 'evt-1', createdAt: '2026-08-04T08:30:00.000Z', payload: { eventId: 'evt-1', type: 'deployment.created' } };
    const cases: unknown[] = [
      null,
      'text',
      { ...valid, version: 2 },
      { ...valid, kind: 'webhook' },
      { ...valid, id: '' },
      { ...valid, createdAt: 'not-a-date' },
      { ...valid, payload: null },
      // applicationId stays mandatory for application-scoped kinds.
      { ...valid, kind: 'health-check', payload: {} },
      { ...valid, kind: 'health-check', payload: { applicationId: '' } },
    ];
    for (const value of cases) expect(() => parseQueueEnvelope(value)).toThrowError(QueueFailure);
    expect(() => parseQueueEnvelope(valid)).not.toThrow();
  });

  it('accepts a sanitized provider-event payload without an applicationId', () => {
    const value = envelope('provider-event', 'webhook:vercel:evt-1');
    expect(value.payload.applicationId).toBe('tokentest');
    const sanitized = createQueueEnvelope({ kind: 'provider-event', id: 'webhook:vercel:evt-1', payload: { eventId: 'evt-1', type: 'deployment.created', deploymentId: 'dpl_1' }, now: NOW });
    expect(parseQueueEnvelope(sanitized)).toEqual(sanitized);
  });
});

describe('handleQueue', () => {
  it('acknowledges a message only after a successful dispatch', async () => {
    const { batch: queueBatch, acked, retried } = batch([{ id: 'm1', body: envelope(), attempts: 1 }]);
    const outcome = await handleQueue(queueBatch, { dispatch: dispatcher(async () => undefined), persist: persistence([]) });
    expect(outcome).toEqual({ acknowledged: 1, retried: 0, incidents: 0 });
    expect(acked).toEqual(['m1']);
    expect(retried).toEqual([]);
  });

  it('retries transient dispatch failures without acknowledging', async () => {
    const incidents: IncidentRequest[] = [];
    const { batch: queueBatch, acked, retried } = batch([{ id: 'm1', body: envelope(), attempts: 1 }]);
    const outcome = await handleQueue(queueBatch, { dispatch: dispatcher(() => { throw new QueueFailure('LP-QUEUE-DISPATCH-RETRYABLE', 'transient', 'upstream unavailable'); }), persist: persistence(incidents) });
    expect(outcome).toEqual({ acknowledged: 0, retried: 1, incidents: 0 });
    expect(retried).toEqual(['m1']);
    expect(acked).toEqual([]);
    expect(incidents).toEqual([]);
  });

  it('treats unknown dispatch errors as transient', () => {
    expect(classifyQueueError(new Error('boom'))).toBe('transient');
    expect(classifyQueueError(new QueueFailure('LP-X', 'permanent', 'x'))).toBe('permanent');
  });

  it('acknowledges a provider-event message only after the fan-out outcome is durably recorded', async () => {
    const incidents: IncidentRequest[] = [];
    const { batch: queueBatch, acked, retried } = batch([{ id: 'm1', body: createQueueEnvelope({ kind: 'provider-event', id: 'webhook:vercel:evt-fanout', payload: { eventId: 'evt-fanout', type: 'deployment.created' }, now: NOW }), attempts: 1 }]);
    const fanout = createProviderEventFanout({ limit: 10, dependencies: { listManagedApplications: async () => ['alpha'], dispatchReconciliation: async () => ({ instanceId: 'reconcile-alpha' }), recordOutcome: async () => undefined } });
    const outcome = await handleQueue(queueBatch, { dispatch: { dispatch: async (envelope) => { await fanout.dispatch(envelope); } }, persist: persistence(incidents) });
    expect(outcome).toEqual({ acknowledged: 1, retried: 0, incidents: 0 });
    expect(acked).toEqual(['m1']);
    expect(retried).toEqual([]);
  });

  it('retries a provider-event message when the fan-out fails transiently and never acknowledges', async () => {
    const incidents: IncidentRequest[] = [];
    const { batch: queueBatch, acked, retried } = batch([{ id: 'm2', body: createQueueEnvelope({ kind: 'provider-event', id: 'webhook:vercel:evt-fanout', payload: { eventId: 'evt-fanout', type: 'deployment.created' }, now: NOW }), attempts: 1 }]);
    const fanout = createProviderEventFanout({ limit: 10, dependencies: { listManagedApplications: async () => ['alpha'], dispatchReconciliation: async () => { throw new QueueFailure('LP-QUEUE-DISPATCH-RETRYABLE', 'transient', 'LP-QUEUE-DISPATCH-RETRYABLE: upstream unavailable'); }, recordOutcome: async () => undefined } });
    const outcome = await handleQueue(queueBatch, { dispatch: { dispatch: async (envelope) => { await fanout.dispatch(envelope); } }, persist: persistence(incidents) });
    expect(outcome).toEqual({ acknowledged: 0, retried: 1, incidents: 0 });
    expect(retried).toEqual(['m2']);
    expect(acked).toEqual([]);
    expect(incidents).toEqual([]);
  });

  it('records an incident and acknowledges a permanently rejected message', async () => {
    const incidents: IncidentRequest[] = [];
    const { batch: queueBatch, acked, retried } = batch([{ id: 'm1', body: envelope(), attempts: 4 }]);
    const outcome = await handleQueue(queueBatch, { dispatch: dispatcher(() => { throw new QueueFailure('LP-QUEUE-DISPATCH-PERMANENT', 'permanent', 'rejected with 400.'); }), persist: persistence(incidents) });
    expect(outcome).toEqual({ acknowledged: 1, retried: 0, incidents: 1 });
    expect(acked).toEqual(['m1']);
    expect(retried).toEqual([]);
    expect(incidents[0]).toMatchObject({ messageId: 'm1', queue: 'launchpad-provider-events', envelopeId: 'evt-1', kind: 'provider-event', applicationId: 'tokentest', attempts: 4, code: 'LP-QUEUE-DISPATCH-PERMANENT', errorClass: 'permanent' });
  });

  it('records an incident for a malformed envelope instead of dropping it', async () => {
    const incidents: IncidentRequest[] = [];
    const { batch: queueBatch, acked, retried } = batch([{ id: 'm1', body: { version: 1, kind: 'provider-event' }, attempts: 2 }]);
    const outcome = await handleQueue(queueBatch, { dispatch: dispatcher(async () => undefined), persist: persistence(incidents) });
    expect(outcome).toEqual({ acknowledged: 1, retried: 0, incidents: 1 });
    expect(acked).toEqual(['m1']);
    expect(retried).toEqual([]);
    expect(incidents[0]).toMatchObject({ messageId: 'm1', envelopeId: null, code: 'LP-QUEUE-ENVELOPE-INVALID', errorClass: 'malformed' });
  });

  it('creates an incident request for dead-lettered messages instead of letting them disappear', async () => {
    const incidents: IncidentRequest[] = [];
    const { batch: queueBatch, acked } = batch([{ id: 'dlq-1', body: envelope('health-check', 'hc-9'), attempts: 6 }], DEAD_LETTER_QUEUE);
    const outcome = await handleQueue(queueBatch, { dispatch: dispatcher(() => { throw new Error('must not dispatch'); }), persist: persistence(incidents) });
    expect(outcome).toEqual({ acknowledged: 1, retried: 0, incidents: 1 });
    expect(acked).toEqual(['dlq-1']);
    expect(incidents[0]).toMatchObject({ messageId: 'dlq-1', queue: DEAD_LETTER_QUEUE, envelopeId: 'hc-9', kind: 'health-check', attempts: 6, code: 'LP-QUEUE-RETRY-EXHAUSTED', errorClass: 'permanent' });
  });

  it('records an incident even when the dead-lettered body is malformed', async () => {
    const incidents: IncidentRequest[] = [];
    const { batch: queueBatch, acked } = batch([{ id: 'dlq-2', body: 'garbage', attempts: 6 }], DEAD_LETTER_QUEUE);
    const outcome = await handleQueue(queueBatch, { dispatch: dispatcher(async () => undefined), persist: persistence(incidents) });
    expect(outcome).toEqual({ acknowledged: 1, retried: 0, incidents: 1 });
    expect(acked).toEqual(['dlq-2']);
    expect(incidents[0]).toMatchObject({ messageId: 'dlq-2', code: 'LP-QUEUE-ENVELOPE-INVALID', errorClass: 'malformed' });
  });

  it('fails closed when no persistence is configured instead of acknowledging', async () => {
    const { batch: queueBatch, acked } = batch([{ id: 'm1', body: { nope: true }, attempts: 1 }]);
    await expect(handleQueue(queueBatch, { dispatch: dispatcher(async () => undefined) })).rejects.toThrow('LP-QUEUE-INCIDENT-PERSIST-UNCONFIGURED');
    expect(acked).toEqual([]);
  });

  it('fails closed when no dispatcher is configured', async () => {
    const { batch: queueBatch, acked } = batch([{ id: 'm1', body: envelope(), attempts: 1 }]);
    await expect(handleQueue(queueBatch, { persist: persistence([]) })).rejects.toThrow('LP-QUEUE-DISPATCH-UNCONFIGURED');
    expect(acked).toEqual([]);
  });

  it('propagates a persistence failure so the message is redelivered', async () => {
    const { batch: queueBatch, acked } = batch([{ id: 'm1', body: { bad: true }, attempts: 1 }]);
    const failing: QueuePersistence = { recordIncident: () => { throw new Error('storage down'); } };
    await expect(handleQueue(queueBatch, { dispatch: dispatcher(async () => undefined), persist: failing })).rejects.toThrow('storage down');
    expect(acked).toEqual([]);
  });
});

describe('createHttpQueueDispatcher', () => {
  it('resolves on a successful internal dispatch and forwards the envelope id as the idempotency key', async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const http = createHttpQueueDispatcher({ internalUrl: 'https://internal.test/', internalToken: 'token', fetchImpl: async (input, init) => { seen.push({ url: String(input), body: String(init?.body ?? '') }); return new Response('ok', { status: 200 }); } });
    await expect(http.dispatch(envelope())).resolves.toBeUndefined();
    expect(seen[0]?.url).toBe('https://internal.test/internal/workflows/provider-event');
    expect(JSON.parse(seen[0]?.body ?? '{}')).toMatchObject({ applicationId: 'tokentest', idempotencyKey: 'evt-1' });
  });

  it('classifies retryable and permanent HTTP outcomes', async () => {
    const transient = createHttpQueueDispatcher({ internalUrl: 'https://internal.test', internalToken: 'token', fetchImpl: async () => new Response('nope', { status: 503 }) });
    await expect(transient.dispatch(envelope())).rejects.toMatchObject({ code: 'LP-QUEUE-DISPATCH-RETRYABLE', errorClass: 'transient' });
    const rateLimited = createHttpQueueDispatcher({ internalUrl: 'https://internal.test', internalToken: 'token', fetchImpl: async () => new Response('nope', { status: 429 }) });
    await expect(rateLimited.dispatch(envelope())).rejects.toMatchObject({ errorClass: 'transient' });
    const permanent = createHttpQueueDispatcher({ internalUrl: 'https://internal.test', internalToken: 'token', fetchImpl: async () => new Response('nope', { status: 404 }) });
    await expect(permanent.dispatch(envelope())).rejects.toMatchObject({ code: 'LP-QUEUE-DISPATCH-PERMANENT', errorClass: 'permanent' });
  });

  it('classifies network failures as transient', async () => {
    const network = createHttpQueueDispatcher({ internalUrl: 'https://internal.test', internalToken: 'token', fetchImpl: async () => { throw new TypeError('ECONNREFUSED'); } });
    await expect(network.dispatch(envelope())).rejects.toMatchObject({ code: 'LP-QUEUE-DISPATCH-NETWORK', errorClass: 'transient' });
  });

  it('fails closed when dispatch configuration is missing', () => {
    expect(() => createHttpQueueDispatcher({ internalUrl: undefined, internalToken: undefined })).toThrow('LP-QUEUE-DISPATCH-CONFIG-MISSING');
  });
});

describe('reconciliation envelopes', () => {
  it('builds a valid versioned per-application cron envelope', () => {
    const value = createReconciliationEnvelope({ applicationId: 'tokentest', shard: 0, shardCount: 2, now: NOW });
    expect(value).toEqual({ version: 1, kind: 'reconcile', applicationId: 'tokentest', shard: 0, shardCount: 2, triggeredAt: '2026-08-04T08:30:00.000Z' });
    expect(parseReconciliationEnvelope(value)).toEqual(value);
  });

  it('accepts an optional source commit for direct dispatches', () => {
    const value = createReconciliationEnvelope({ applicationId: 'tokentest', sourceCommit: 'a'.repeat(40), shard: 0, shardCount: 1, now: NOW });
    expect(parseReconciliationEnvelope(value).sourceCommit).toBe('a'.repeat(40));
  });

  it('rejects malformed reconciliation envelopes', () => {
    const base = { version: 1, kind: 'reconcile', applicationId: 'tokentest', shard: 0, shardCount: 2, triggeredAt: '2026-08-04T08:30:00.000Z' };
    const cases: unknown[] = [
      null,
      { ...base, version: 2 },
      { ...base, kind: 'apply' },
      { ...base, applicationId: '' },
      { ...base, shard: -1 },
      { ...base, shard: 1.5 },
      { ...base, shardCount: 0 },
      { ...base, shard: 2, shardCount: 2 },
      { ...base, triggeredAt: 'yesterday' },
      { ...base, sourceCommit: '' },
    ];
    for (const value of cases) expect(() => parseReconciliationEnvelope(value)).toThrowError(QueueFailure);
    expect(() => parseReconciliationEnvelope(base)).not.toThrow();
  });

  it('derives a deterministic per-trigger instance id', () => {
    const value = createReconciliationEnvelope({ applicationId: 'tokentest', shard: 1, shardCount: 2, now: NOW });
    expect(reconciliationInstanceId(value)).toBe('reconcile-tokentest-s1-of2-2026-08-04T08-30-00-000Z');
    expect(reconciliationInstanceId(value)).toBe(reconciliationInstanceId(createReconciliationEnvelope({ applicationId: 'tokentest', shard: 1, shardCount: 2, now: NOW })));
  });
});

describe('scheduled reconciliation dispatch', () => {
  it('dispatches one envelope per application with stable shards', async () => {
    const dispatched: ReconciliationEnvelope[] = [];
    const dispatcherRef: ReconciliationDispatcher = { dispatch: async (value) => { dispatched.push(value); return { instanceId: reconciliationInstanceId(value) }; } };
    const result = await dispatchScheduledReconciliation({ applicationIds: ['zeta', 'alpha', 'beta'], shardCount: 2, now: NOW, dispatcher: dispatcherRef });
    expect(result).toEqual({ dispatched: 3 });
    expect(dispatched.map((value) => [value.applicationId, value.shard, value.shardCount])).toEqual([['alpha', 0, 2], ['beta', 1, 2], ['zeta', 0, 2]]);
    for (const value of dispatched) expect(parseReconciliationEnvelope(value)).toEqual(value);
  });

  it('propagates dispatcher failures without dropping applications', async () => {
    const failing: ReconciliationDispatcher = { dispatch: async () => { throw new QueueFailure('LP-QUEUE-DISPATCH-RETRYABLE', 'transient', 'LP-QUEUE-DISPATCH-RETRYABLE: upstream unavailable'); } };
    await expect(dispatchScheduledReconciliation({ applicationIds: ['alpha', 'beta'], dispatcher: failing })).rejects.toThrow('LP-QUEUE-DISPATCH-RETRYABLE');
  });

  it('rejects invalid shard counts', async () => {
    const dispatcherRef: ReconciliationDispatcher = { dispatch: async () => ({ instanceId: 'x' }) };
    await expect(dispatchScheduledReconciliation({ applicationIds: ['alpha'], shardCount: 0, dispatcher: dispatcherRef })).rejects.toThrow('LP-RECONCILIATION-SHARD-COUNT-INVALID');
    expect(parseReconciliationShardCount('2')).toBe(2);
    expect(parseReconciliationShardCount(undefined)).toBe(1);
    expect(() => parseReconciliationShardCount('nope')).toThrow('LP-RECONCILIATION-SHARD-COUNT-INVALID');
  });

  it('fails closed when the reconcile workflow binding is missing', () => {
    expect(() => createReconciliationWorkflowDispatcher(undefined)).toThrow('LP-RECONCILIATION-WORKFLOW-BINDING-MISSING');
  });

  it('creates workflow instances with deterministic ids', async () => {
    const created: Array<{ id: string; params: unknown }> = [];
    const workflow = { create: async (input: { id: string; params: unknown }) => { created.push(input); return { id: input.id }; } };
    const dispatcherRef = createReconciliationWorkflowDispatcher(workflow);
    const value = createReconciliationEnvelope({ applicationId: 'tokentest', shard: 0, shardCount: 1, now: NOW });
    await expect(dispatcherRef.dispatch(value)).resolves.toEqual({ instanceId: reconciliationInstanceId(value) });
    expect(created).toEqual([{ id: reconciliationInstanceId(value), params: value }]);
  });
});

describe('createProviderEventFanout', () => {
  function eventEnvelope(overrides: Record<string, unknown> = {}): QueueEnvelope {
    return createQueueEnvelope({
      kind: 'provider-event',
      id: 'webhook:vercel:evt-1',
      payload: { eventId: 'evt-1', type: 'deployment.created', deploymentId: 'dpl_1', projectId: 'prj_1', ...overrides },
      now: NOW,
    });
  }

  function fanout(overrides: Partial<ProviderEventFanoutDependencies> = {}, options: { limit?: number; shardCount?: number } = {}): { fanoutRef: ProviderEventFanout; dispatched: Array<{ applicationId: string; envelope: QueueEnvelope }>; outcomes: ProviderEventFanOutcome[] } {
    const dispatched: Array<{ applicationId: string; envelope: QueueEnvelope }> = [];
    const outcomes: ProviderEventFanOutcome[] = [];
    const fanoutRef = createProviderEventFanout({
      limit: options.limit ?? 100,
      ...(options.shardCount !== undefined ? { shardCount: options.shardCount } : {}),
      dependencies: {
        listManagedApplications: async () => ['zeta', 'alpha', 'beta'],
        dispatchReconciliation: async (input) => { dispatched.push(input); return { instanceId: `provider-event-${input.envelope.id}-${input.applicationId}` }; },
        recordOutcome: async (outcome) => { outcomes.push(outcome); },
        ...overrides,
      },
    });
    return { fanoutRef, dispatched, outcomes };
  }

  it('fans out one durable reconciliation dispatch per managed application, ignoring payload state', async () => {
    const { fanoutRef, dispatched, outcomes } = fanout();
    const envelope = eventEnvelope({ state: 'READY', url: 'https://deploy.example/secret', token: 'launchpad-canary-e71a' });
    const outcome = await fanoutRef.dispatch(envelope);
    expect(dispatched.map((entry) => entry.applicationId)).toEqual(['alpha', 'beta', 'zeta']);
    for (const entry of dispatched) expect(entry.envelope).toBe(envelope);
    expect(outcome).toEqual({ eventId: 'evt-1', type: 'deployment.created', applications: 3, dispatched: 3 });
    expect(outcomes).toEqual([outcome]);
  });

  it('bounds the fan-out to the configured limit', async () => {
    const { fanoutRef, dispatched, outcomes } = fanout({}, { limit: 2 });
    const outcome = await fanoutRef.dispatch(eventEnvelope());
    expect(dispatched.map((entry) => entry.applicationId)).toEqual(['alpha', 'beta']);
    expect(outcome).toEqual({ eventId: 'evt-1', type: 'deployment.created', applications: 3, dispatched: 2 });
    expect(outcomes).toEqual([outcome]);
  });

  it('records provider events without reconciliation dispatch while automatic reconciliation is disabled', async () => {
    const dispatched: Array<{ applicationId: string; envelope: QueueEnvelope }> = [];
    const outcomes: ProviderEventFanOutcome[] = [];
    const options = {
      limit: 100,
      enabled: false,
      dependencies: {
        listManagedApplications: async () => ['alpha', 'beta'],
        dispatchReconciliation: async (input: { applicationId: string; envelope: QueueEnvelope }) => {
          dispatched.push(input);
          return { instanceId: input.applicationId };
        },
        recordOutcome: async (outcome: ProviderEventFanOutcome) => { outcomes.push(outcome); },
      },
    };
    const disabledFanout = createProviderEventFanout(options);

    await expect(disabledFanout.dispatch(eventEnvelope())).resolves.toEqual({ eventId: 'evt-1', type: 'deployment.created', applications: 2, dispatched: 0 });
    expect(dispatched).toEqual([]);
    expect(outcomes).toEqual([{ eventId: 'evt-1', type: 'deployment.created', applications: 2, dispatched: 0 }]);
  });

  it('assigns deterministic shards from the envelope id so redeliveries hit the same applications', async () => {
    const first = fanout({}, { shardCount: 2 });
    await first.fanoutRef.dispatch(eventEnvelope());
    expect(first.dispatched).toHaveLength(2);
    const second = fanout({}, { shardCount: 2 });
    await second.fanoutRef.dispatch(eventEnvelope());
    expect(second.dispatched.map((entry) => entry.applicationId)).toEqual(first.dispatched.map((entry) => entry.applicationId));
    expect(first.outcomes[0]?.dispatched).toBe(2);
    expect(second.outcomes[0]?.dispatched).toBe(first.outcomes[0]?.dispatched);
  });

  it('rejects a non-provider-event envelope permanently', async () => {
    const { fanoutRef, dispatched, outcomes } = fanout();
    const health = createQueueEnvelope({ kind: 'health-check', id: 'hc-1', payload: { applicationId: 'app-demo' }, now: NOW });
    await expect(fanoutRef.dispatch(health)).rejects.toMatchObject({ code: 'LP-PROVIDER-EVENT-KIND-INVALID', errorClass: 'permanent' });
    expect(dispatched).toEqual([]);
    expect(outcomes).toEqual([]);
  });

  it('fails closed on an envelope without an event id', async () => {
    const { fanoutRef, outcomes } = fanout();
    const bad = createQueueEnvelope({ kind: 'provider-event', id: 'webhook:vercel:evt-x', payload: { type: 'deployment.created' }, now: NOW });
    await expect(fanoutRef.dispatch(bad)).rejects.toMatchObject({ code: 'LP-PROVIDER-EVENT-ID-MISSING', errorClass: 'permanent' });
    expect(outcomes).toEqual([]);
  });

  it('records no outcome when a reconciliation dispatch fails, so the message retries', async () => {
    const { fanoutRef, outcomes } = fanout({
      dispatchReconciliation: async (input) => {
        if (input.applicationId === 'beta') throw new QueueFailure('LP-QUEUE-DISPATCH-RETRYABLE', 'transient', 'LP-QUEUE-DISPATCH-RETRYABLE: upstream unavailable');
        return { instanceId: 'x' };
      },
    });
    await expect(fanoutRef.dispatch(eventEnvelope())).rejects.toMatchObject({ code: 'LP-QUEUE-DISPATCH-RETRYABLE', errorClass: 'transient' });
    expect(outcomes).toEqual([]);
  });

  it('propagates outcome-recording failures so the message is never acknowledged', async () => {
    const { fanoutRef, dispatched } = fanout({ recordOutcome: async () => { throw new Error('storage down'); } });
    await expect(fanoutRef.dispatch(eventEnvelope())).rejects.toThrow('storage down');
    expect(dispatched).toHaveLength(3);
  });

  it('rejects invalid fan-out configuration', () => {
    expect(() => createProviderEventFanout({ limit: 0, dependencies: { listManagedApplications: async () => [], dispatchReconciliation: async () => ({ instanceId: 'x' }), recordOutcome: async () => undefined } })).toThrow('LP-PROVIDER-EVENT-FANOUT-LIMIT-INVALID');
    expect(() => createProviderEventFanout({ limit: 10, shardCount: 0, dependencies: { listManagedApplications: async () => [], dispatchReconciliation: async () => ({ instanceId: 'x' }), recordOutcome: async () => undefined } })).toThrow('LP-PROVIDER-EVENT-SHARD-COUNT-INVALID');
  });

  it('parses and validates fan-out environment settings', () => {
    expect(parseProviderEventFanoutLimit('50')).toBe(50);
    expect(parseProviderEventFanoutLimit(undefined)).toBe(100);
    expect(parseProviderEventFanoutLimit('')).toBe(100);
    expect(() => parseProviderEventFanoutLimit('0')).toThrow('LP-PROVIDER-EVENT-FANOUT-LIMIT-INVALID');
    expect(() => parseProviderEventFanoutLimit('1001')).toThrow('LP-PROVIDER-EVENT-FANOUT-LIMIT-INVALID');
    expect(parseProviderEventShardCount('3')).toBe(3);
    expect(parseProviderEventShardCount(undefined)).toBe(1);
    expect(() => parseProviderEventShardCount('nope')).toThrow('LP-PROVIDER-EVENT-SHARD-COUNT-INVALID');
  });
});

describe('provider-event reconciliation dispatch', () => {
  it('derives a reconciliation-shaped envelope per managed application and never trusts payload state', () => {
    const envelope = createQueueEnvelope({
      kind: 'provider-event',
      id: 'webhook:vercel:evt-fanout',
      // Deployment state and canary values in the payload must never be
      // trusted or echoed into the reconciliation dispatch.
      payload: { eventId: 'evt-fanout', type: 'deployment.ready', deploymentId: 'dpl_1', projectId: 'prj_1', state: 'READY', url: 'https://deploy.example/private', token: 'launchpad-canary-e71a' },
      now: NOW,
    });
    const params = providerEventReconciliationParams(envelope, 'app-demo');
    expect(params).toMatchObject({
      version: 1,
      kind: 'reconcile',
      applicationId: 'app-demo',
      shard: 0,
      shardCount: 1,
      triggeredAt: NOW.toISOString(),
      trigger: 'provider-event',
      providerEvent: { eventId: 'evt-fanout', type: 'deployment.ready' },
    });
    const serialized = JSON.stringify(params);
    expect(serialized).not.toContain('launchpad-canary-e71a');
    expect(serialized).not.toContain('deploy.example');
    expect(serialized).not.toContain('READY');
    expect(serialized).not.toContain('dpl_1');
    expect(parseReconciliationEnvelope(params)).toMatchObject({ applicationId: 'app-demo', triggeredAt: NOW.toISOString() });
  });

  it('dispatches with a deterministic instance id per (envelope, application), so redeliveries never duplicate', async () => {
    const created: Array<{ id: string; params: unknown }> = [];
    const workflow = { create: async (input: { id: string; params: unknown }) => { created.push(input); return { id: input.id }; } };
    const dispatcher = createReconciliationWorkflowDispatcher(workflow);
    const envelope = createQueueEnvelope({ kind: 'provider-event', id: 'webhook:vercel:evt-fanout', payload: { eventId: 'evt-fanout', type: 'deployment.ready' }, now: NOW });
    const first = await dispatcher.dispatch(providerEventReconciliationParams(envelope, 'app-demo'));
    const second = await dispatcher.dispatch(providerEventReconciliationParams(envelope, 'app-demo'));
    expect(second.instanceId).toBe(first.instanceId);
    expect(first.instanceId).toBe('reconcile-app-demo-s0-of1-2026-08-04T08-30-00-000Z');
    // A different event (different createdAt) or application gets its own instance.
    const later = await dispatcher.dispatch(providerEventReconciliationParams(createQueueEnvelope({ kind: 'provider-event', id: 'webhook:vercel:evt-later', payload: { eventId: 'evt-later', type: 'deployment.ready' }, now: new Date('2026-08-04T09:00:00.000Z') }), 'app-demo'));
    expect(later.instanceId).not.toBe(first.instanceId);
    const otherApp = await dispatcher.dispatch(providerEventReconciliationParams(envelope, 'app-other'));
    expect(otherApp.instanceId).not.toBe(first.instanceId);
    expect(created).toHaveLength(4);
    for (const input of created) expect(parseReconciliationEnvelope(input.params)).toBeTruthy();
  });
});
