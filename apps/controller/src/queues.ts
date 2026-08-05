import { metricWorkflowOf, type MetricsRegistry } from '@launchpad/shared';

export const QUEUE_ENVELOPE_VERSION = 1 as const;
export const DEAD_LETTER_QUEUE = 'launchpad-dead-letter';
export const QUEUE_KINDS = ['provider-event', 'health-check'] as const;
export type QueueKind = (typeof QUEUE_KINDS)[number];

/**
 * Versioned envelope for every message sent through a Launchpad queue.
 * The envelope id is the deterministic idempotency key: consumers derive
 * durable instance ids from it so redeliveries of the same message never
 * start a second operation.
 */
export interface QueueEnvelope<T extends object = Record<string, unknown>> {
  version: 1;
  kind: QueueKind;
  id: string;
  createdAt: string;
  payload: T;
}

/**
 * Sanitized provider-event payload (webhook trigger, never final state):
 * only the event id/type and non-secret provider resource identifiers.
 * The raw provider body is never enqueued or persisted. `applicationId` is
 * intentionally absent: the consumer fans out to managed applications itself.
 */
export interface ProviderEventPayload {
  eventId: string;
  type: string;
  projectId?: string;
  deploymentId?: string;
  teamId?: string;
  [key: string]: unknown;
}

export interface QueueMessage { id: string; body: unknown; attempts: number; }
export interface QueueBatch { queue: string; messages: QueueMessage[]; ack(message: QueueMessage): void; retry(message: QueueMessage): void; }
export interface QueueOutcome { acknowledged: number; retried: number; incidents: number; }

export type QueueErrorClass = 'transient' | 'permanent' | 'malformed';

/** Typed queue failure with a stable code and a redacted, controlled message. */
export class QueueFailure extends Error {
  readonly code: string;
  readonly errorClass: QueueErrorClass;

  constructor(code: string, errorClass: QueueErrorClass, message: string) {
    super(message);
    this.name = code;
    this.code = code;
    this.errorClass = errorClass;
  }
}

/** Visible incident record created instead of silently discarding a message. Safe fields only. */
export interface IncidentRequest {
  messageId: string;
  queue: string;
  envelopeId: string | null;
  kind: string | null;
  applicationId: string | null;
  attempts: number;
  code: string;
  errorClass: QueueErrorClass;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface QueuePersistence {
  recordIncident(request: IncidentRequest): Promise<void> | void;
}

export interface QueueDispatcher {
  dispatch(envelope: QueueEnvelope): Promise<void>;
}

export interface QueueDependencies {
  dispatch?: QueueDispatcher;
  persist?: QueuePersistence;
  now?: () => Date;
  /** Bounded metrics registry; records successes/failures/retries/DLQ per message. */
  metrics?: MetricsRegistry;
}

function queueEnvelopeError(reason: string): QueueFailure {
  return new QueueFailure('LP-QUEUE-ENVELOPE-INVALID', 'malformed', `Invalid queue envelope: ${reason}.`);
}

export function createQueueEnvelope<T extends object>(input: { kind: QueueKind; id: string; payload: T; now?: Date }): QueueEnvelope<T> {
  return { version: QUEUE_ENVELOPE_VERSION, kind: input.kind, id: input.id, createdAt: (input.now ?? new Date()).toISOString(), payload: input.payload };
}

/** Parses and validates a versioned queue envelope. Throws QueueFailure ('malformed') on any invalid required field. */
export function parseQueueEnvelope(value: unknown): QueueEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw queueEnvelopeError('expected an object envelope');
  const record = value as Record<string, unknown>;
  if (record.version !== QUEUE_ENVELOPE_VERSION) throw queueEnvelopeError(`unsupported version '${String(record.version)}'`);
  if (typeof record.kind !== 'string' || !(QUEUE_KINDS as readonly string[]).includes(record.kind)) throw queueEnvelopeError(`unsupported kind '${String(record.kind)}'`);
  if (typeof record.id !== 'string' || record.id.length === 0) throw queueEnvelopeError('id must be a non-empty string');
  if (typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))) throw queueEnvelopeError('createdAt must be an ISO-8601 timestamp');
  if (typeof record.payload !== 'object' || record.payload === null || Array.isArray(record.payload)) throw queueEnvelopeError('payload must be an object');
  const payload = record.payload as Record<string, unknown>;
  // applicationId is required for application-scoped kinds (health-check);
  // provider-event envelopes carry a sanitized event and are fanned out to
  // managed applications by the consumer, so they have no applicationId.
  if (record.kind !== 'provider-event' && (typeof payload.applicationId !== 'string' || payload.applicationId.length === 0)) throw queueEnvelopeError('payload.applicationId must be a non-empty string');
  return { version: QUEUE_ENVELOPE_VERSION, kind: record.kind as QueueKind, id: record.id, createdAt: record.createdAt, payload: payload as QueueEnvelope['payload'] };
}

/** Unknown errors are transient: retry first, then the dead-letter path creates the visible record. */
export function classifyQueueError(error: unknown): QueueErrorClass {
  return error instanceof QueueFailure ? error.errorClass : 'transient';
}

/**
 * Fail-closed QueueFailure whose message surfaces the stable code in front of
 * the causal message. Used for configuration/validation errors that abort
 * processing before anything is acknowledged or persisted.
 */
function failClosed(code: string, errorClass: QueueErrorClass, message: string): QueueFailure {
  return new QueueFailure(code, errorClass, `${code}: ${message}`);
}

const RETRYABLE_HTTP_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export interface HttpQueueDispatchOptions {
  internalUrl: string | undefined;
  internalToken: string | undefined;
  fetchImpl?: typeof fetch;
}

/** Default dispatcher: forwards the envelope to the internal workflow endpoint, forwarding the envelope id as the idempotency key. */
export function createHttpQueueDispatcher(options: HttpQueueDispatchOptions): QueueDispatcher {
  const baseUrl = options.internalUrl?.replace(/\/$/, '');
  const internalToken = options.internalToken;
  if (!baseUrl || !internalToken) throw failClosed('LP-QUEUE-DISPATCH-CONFIG-MISSING', 'permanent', 'CONTROLLER_INTERNAL_URL and CONTROLLER_INTERNAL_TOKEN must be configured.');
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async dispatch(envelope: QueueEnvelope): Promise<void> {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/internal/workflows/${envelope.kind}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-launchpad-workflow-token': internalToken, 'idempotency-key': envelope.id },
          body: JSON.stringify({ ...envelope.payload, idempotencyKey: envelope.id }),
        });
      } catch {
        throw new QueueFailure('LP-QUEUE-DISPATCH-NETWORK', 'transient', 'Internal workflow dispatch failed before a response.');
      }
      if (response.ok) return;
      if (RETRYABLE_HTTP_STATUS.has(response.status)) throw new QueueFailure('LP-QUEUE-DISPATCH-RETRYABLE', 'transient', `Internal workflow dispatch returned ${response.status}.`);
      throw new QueueFailure('LP-QUEUE-DISPATCH-PERMANENT', 'permanent', `Internal workflow dispatch rejected the envelope with ${response.status}.`);
    },
  };
}

async function persistIncident(input: { message: QueueMessage; queue: string; envelope: QueueEnvelope | null; failure: QueueFailure; attempts: number; now: () => Date }, dependencies: QueueDependencies): Promise<void> {
  if (!dependencies.persist) throw failClosed('LP-QUEUE-INCIDENT-PERSIST-UNCONFIGURED', 'transient', 'No queue persistence is configured; refusing to acknowledge a failed message.');
  const request: IncidentRequest = {
    messageId: input.message.id,
    queue: input.queue,
    envelopeId: input.envelope?.id ?? null,
    kind: input.envelope?.kind ?? null,
    applicationId: typeof input.envelope?.payload.applicationId === 'string' ? input.envelope.payload.applicationId : null,
    attempts: input.attempts,
    code: input.failure.code,
    errorClass: input.failure.errorClass,
    details: { cause: input.failure.message },
    createdAt: input.now().toISOString(),
  };
  await dependencies.persist.recordIncident(request);
}

/** Terminal path: a message that exhausted retries becomes an incident request. It is never dropped silently. */
async function handleDeadLetterMessage(message: QueueMessage, queue: string, dependencies: QueueDependencies, now: () => Date): Promise<void> {
  let envelope: QueueEnvelope | null = null;
  let failure: QueueFailure | null = null;
  try {
    envelope = parseQueueEnvelope(message.body);
  } catch (error) {
    failure = error instanceof QueueFailure ? error : new QueueFailure('LP-QUEUE-ENVELOPE-INVALID', 'malformed', 'Envelope could not be parsed.');
  }
  await persistIncident({ message, queue, envelope, failure: failure ?? new QueueFailure('LP-QUEUE-RETRY-EXHAUSTED', 'permanent', 'Message exhausted its retry budget on the source queue.'), attempts: message.attempts, now }, dependencies);
}

/**
 * Processes one queue batch with fail-closed verdicts:
 * - success -> ack
 * - transient failure -> retry
 * - permanent or malformed failure -> record an incident request, then ack (visible, never silent)
 * - dead-letter queue -> always create an incident request, then ack
 * A missing persistence or dispatcher, or a failing persistence, throws so the
 * platform redelivers instead of acknowledging.
 */
export async function handleQueue(batch: QueueBatch, dependencies: QueueDependencies = {}): Promise<QueueOutcome> {
  const now = dependencies.now ?? (() => new Date());
  const outcome: QueueOutcome = { acknowledged: 0, retried: 0, incidents: 0 };
  for (const message of batch.messages) {
    if (batch.queue === DEAD_LETTER_QUEUE) {
      await handleDeadLetterMessage(message, batch.queue, dependencies, now);
      batch.ack(message);
      outcome.acknowledged += 1;
      outcome.incidents += 1;
      dependencies.metrics?.increment('dlq_count');
      dependencies.metrics?.increment('failures', { workflow: 'other' });
      continue;
    }
    let envelope: QueueEnvelope;
    try {
      envelope = parseQueueEnvelope(message.body);
    } catch (error) {
      const failure = error instanceof QueueFailure ? error : new QueueFailure('LP-QUEUE-ENVELOPE-INVALID', 'malformed', 'Envelope could not be parsed.');
      await persistIncident({ message, queue: batch.queue, envelope: null, failure, attempts: message.attempts, now }, dependencies);
      batch.ack(message);
      outcome.acknowledged += 1;
      outcome.incidents += 1;
      dependencies.metrics?.increment('failures', { workflow: 'other' });
      continue;
    }
    if (!dependencies.dispatch) throw failClosed('LP-QUEUE-DISPATCH-UNCONFIGURED', 'transient', 'No queue dispatcher is configured; refusing to acknowledge messages.');
    try {
      await dependencies.dispatch.dispatch(envelope);
      batch.ack(message);
      outcome.acknowledged += 1;
      dependencies.metrics?.increment('successes', { workflow: metricWorkflowOf(envelope.kind) });
    } catch (error) {
      if (classifyQueueError(error) === 'transient') {
        batch.retry(message);
        outcome.retried += 1;
        dependencies.metrics?.increment('retries', { workflow: metricWorkflowOf(envelope.kind) });
      } else {
        const failure = error instanceof QueueFailure ? error : new QueueFailure('LP-QUEUE-DISPATCH-FAILED', 'permanent', 'Internal workflow dispatch failed with an unknown error.');
        await persistIncident({ message, queue: batch.queue, envelope, failure, attempts: message.attempts, now }, dependencies);
        batch.ack(message);
        outcome.acknowledged += 1;
        outcome.incidents += 1;
        dependencies.metrics?.increment('failures', { workflow: metricWorkflowOf(envelope.kind) });
      }
    }
  }
  return outcome;
}

/**
 * Versioned per-application reconciliation envelope dispatched by the
 * scheduled cron. Shards are stable: the same application always lands on the
 * same shard for a given shardCount, so shard-targeted recovery is possible.
 * `sourceCommit` is optional for cron triggers (the desired state is the
 * control-repository main commit, resolved by the reconcile business layer);
 * direct dispatches include it.
 */
export interface ReconciliationEnvelope {
  version: 1;
  kind: 'reconcile';
  applicationId: string;
  sourceCommit?: string;
  shard: number;
  shardCount: number;
  triggeredAt: string;
  /** Tolerates extra workflow-payload fields; keeps the envelope assignable to WorkflowPayload. */
  [key: string]: unknown;
}

function reconciliationEnvelopeError(reason: string): QueueFailure {
  return new QueueFailure('LP-RECONCILIATION-ENVELOPE-INVALID', 'malformed', `Invalid reconciliation envelope: ${reason}.`);
}

export function createReconciliationEnvelope(input: { applicationId: string; sourceCommit?: string; shard: number; shardCount: number; now: Date }): ReconciliationEnvelope {
  return { version: 1, kind: 'reconcile', applicationId: input.applicationId, ...(input.sourceCommit ? { sourceCommit: input.sourceCommit } : {}), shard: input.shard, shardCount: input.shardCount, triggeredAt: input.now.toISOString() };
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Parses and validates a versioned reconciliation envelope. Throws QueueFailure ('malformed') on any invalid required field. */
export function parseReconciliationEnvelope(value: unknown): ReconciliationEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw reconciliationEnvelopeError('expected an object envelope');
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw reconciliationEnvelopeError(`unsupported version '${String(record.version)}'`);
  if (record.kind !== 'reconcile') throw reconciliationEnvelopeError(`unsupported kind '${String(record.kind)}'`);
  if (typeof record.applicationId !== 'string' || record.applicationId.length === 0) throw reconciliationEnvelopeError('applicationId must be a non-empty string');
  if (record.sourceCommit !== undefined && (typeof record.sourceCommit !== 'string' || record.sourceCommit.length === 0)) throw reconciliationEnvelopeError('sourceCommit must be a non-empty string when present');
  if (typeof record.shard !== 'number' || !Number.isInteger(record.shard) || record.shard < 0) throw reconciliationEnvelopeError('shard must be a non-negative integer');
  if (typeof record.shardCount !== 'number' || !Number.isInteger(record.shardCount) || record.shardCount < 1) throw reconciliationEnvelopeError('shardCount must be a positive integer');
  if (record.shard >= record.shardCount) throw reconciliationEnvelopeError('shard must be less than shardCount');
  if (typeof record.triggeredAt !== 'string' || !ISO_TIMESTAMP.test(record.triggeredAt) || Number.isNaN(Date.parse(record.triggeredAt))) throw reconciliationEnvelopeError('triggeredAt must be an ISO-8601 timestamp');
  return { version: 1, kind: 'reconcile', applicationId: record.applicationId, ...(record.sourceCommit ? { sourceCommit: record.sourceCommit } : {}), shard: record.shard, shardCount: record.shardCount, triggeredAt: record.triggeredAt };
}

/** Deterministic per (application, shard, trigger) instance id: redeliveries of the same cron share one durable workflow instance. */
export function reconciliationInstanceId(envelope: ReconciliationEnvelope): string {
  return `reconcile-${envelope.applicationId}-s${envelope.shard}-of${envelope.shardCount}-${envelope.triggeredAt.replace(/[:.]/g, '-')}`;
}

export interface WorkflowInstanceCreator { create(input: { id: string; params: unknown }): Promise<{ id: string }>; }

export interface ReconciliationDispatcher {
  dispatch(envelope: ReconciliationEnvelope): Promise<{ instanceId: string }>;
}

export function createReconciliationWorkflowDispatcher(workflow: WorkflowInstanceCreator | undefined): ReconciliationDispatcher {
  if (!workflow) throw failClosed('LP-RECONCILIATION-WORKFLOW-BINDING-MISSING', 'permanent', 'The RECONCILE_WORKFLOW binding is not configured.');
  return {
    async dispatch(envelope: ReconciliationEnvelope): Promise<{ instanceId: string }> {
      const instanceId = reconciliationInstanceId(envelope);
      const instance = await workflow.create({ id: instanceId, params: envelope });
      return { instanceId: instance.id };
    },
  };
}

export function parseReconciliationShardCount(value: string | undefined): number {
  if (value === undefined || value === '') return 1;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw failClosed('LP-RECONCILIATION-SHARD-COUNT-INVALID', 'permanent', `RECONCILIATION_SHARD_COUNT must be a positive integer, got '${value}'.`);
  return parsed;
}

// ---------------------------------------------------------------------------
// Provider-event consumer fan-out (webhook trigger contract).
//
// A provider-event envelope is a trigger, never final state: the consumer
// durably dispatches provider-backed reconciliation for managed applications
// (bounded and sharded) and records the outcome BEFORE the message may be
// acknowledged. The payload's deployment state is never trusted or echoed.
// ---------------------------------------------------------------------------

/** Durable outcome of one provider-event fan-out, recorded before ack. */
export interface ProviderEventFanOutcome {
  eventId: string;
  type: string;
  /** Managed applications considered for the fan-out. */
  applications: number;
  /** Reconciliation workflow instances durably created. */
  dispatched: number;
}

export interface ProviderEventFanoutDependencies {
  /** All managed application ids (the fan-out bounds and shards them). */
  listManagedApplications(): Promise<string[]>;
  /** Creates one durable reconciliation instance for a managed application; deterministic per (envelope, application) so redeliveries deduplicate. */
  dispatchReconciliation(input: { applicationId: string; envelope: QueueEnvelope }): Promise<{ instanceId: string }>;
  /** Durably records the fan-out outcome (idempotent per event id); a throw prevents the ack. */
  recordOutcome(outcome: ProviderEventFanOutcome): Promise<void>;
}

export interface ProviderEventFanoutOptions {
  /** Bounded fan-out: at most this many reconciliation instances per event. */
  limit: number;
  /** Deterministic shard assignment: when > 1, each consumer reconciles only its stable share of sorted managed applications. */
  shardCount?: number;
  dependencies: ProviderEventFanoutDependencies;
}

export interface ProviderEventFanout {
  dispatch(envelope: QueueEnvelope): Promise<ProviderEventFanOutcome>;
}

/**
 * Builds the reconciliation params for one managed application from a
 * provider-event envelope. The reconciliation envelope derives its trigger
 * deterministically from the envelope's createdAt (so redeliveries produce
 * the same instance id) and carries only sanitized event metadata. The
 * webhook payload's deployment state is never trusted or echoed.
 */
export function providerEventReconciliationParams(envelope: QueueEnvelope, applicationId: string): ReconciliationEnvelope {
  const eventId = typeof envelope.payload.eventId === 'string' ? envelope.payload.eventId : 'unknown';
  const type = typeof envelope.payload.type === 'string' ? envelope.payload.type : 'unknown';
  const reconciliation = createReconciliationEnvelope({ applicationId, shard: 0, shardCount: 1, now: new Date(envelope.createdAt) });
  return { ...reconciliation, trigger: 'provider-event', providerEvent: { eventId, type } };
}

/** Deterministic integer shard for an envelope id; redeliveries always land on the same shard. */
function stableShard(value: string, shardCount: number): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % shardCount;
}

export function parseProviderEventFanoutLimit(value: string | undefined): number {
  if (value === undefined || value === '') return 100;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) throw failClosed('LP-PROVIDER-EVENT-FANOUT-LIMIT-INVALID', 'permanent', `PROVIDER_EVENT_FANOUT_LIMIT must be an integer in [1, 1000], got '${value}'.`);
  return parsed;
}

export function parseProviderEventShardCount(value: string | undefined): number {
  if (value === undefined || value === '') return 1;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw failClosed('LP-PROVIDER-EVENT-SHARD-COUNT-INVALID', 'permanent', `PROVIDER_EVENT_SHARD_COUNT must be a positive integer, got '${value}'.`);
  return parsed;
}

/**
 * Provider-event consumer: fans out one sanitized envelope into durable
 * reconciliation instances for managed applications. Deterministic ordering
 * (sorted ids) and shard assignment (envelope-id hash) keep redeliveries
 * identical; the outcome is recorded only after every dispatch succeeded, so
 * an acknowledgement implies durable dispatch. Payload state is ignored.
 */
export function createProviderEventFanout(options: ProviderEventFanoutOptions): ProviderEventFanout {
  const limit = options.limit;
  const shardCount = options.shardCount ?? 1;
  if (!Number.isInteger(limit) || limit < 1) throw failClosed('LP-PROVIDER-EVENT-FANOUT-LIMIT-INVALID', 'permanent', `The provider-event fan-out limit must be a positive integer, got '${String(limit)}'.`);
  if (!Number.isInteger(shardCount) || shardCount < 1) throw failClosed('LP-PROVIDER-EVENT-SHARD-COUNT-INVALID', 'permanent', `The provider-event shard count must be a positive integer, got '${String(shardCount)}'.`);
  return {
    async dispatch(envelope: QueueEnvelope): Promise<ProviderEventFanOutcome> {
      if (envelope.kind !== 'provider-event') throw failClosed('LP-PROVIDER-EVENT-KIND-INVALID', 'permanent', `Expected a provider-event envelope, got '${envelope.kind}'.`);
      const eventId = typeof envelope.payload.eventId === 'string' && envelope.payload.eventId.length > 0 ? envelope.payload.eventId : null;
      if (eventId === null) throw failClosed('LP-PROVIDER-EVENT-ID-MISSING', 'permanent', 'The provider-event envelope payload must declare a non-empty eventId.');
      const type = typeof envelope.payload.type === 'string' && envelope.payload.type.length > 0 ? envelope.payload.type.slice(0, 64) : 'unknown';
      const shard = stableShard(envelope.id, shardCount);
      const applicationIds = [...(await options.dependencies.listManagedApplications())].sort();
      let dispatched = 0;
      for (let index = 0; index < applicationIds.length; index += 1) {
        const applicationId = applicationIds[index];
        if (typeof applicationId !== 'string' || applicationId.length === 0) throw new QueueFailure('LP-PROVIDER-EVENT-APPLICATION-ID-INVALID', 'permanent', 'Managed application ids must be non-empty strings.');
        if (shardCount > 1 && index % shardCount !== shard) continue;
        await options.dependencies.dispatchReconciliation({ applicationId, envelope });
        dispatched += 1;
        if (dispatched >= limit) break;
      }
      const outcome: ProviderEventFanOutcome = { eventId, type, applications: applicationIds.length, dispatched };
      await options.dependencies.recordOutcome(outcome);
      return outcome;
    },
  };
}

export interface ScheduledReconciliationInput {
  applicationIds: readonly string[];
  shardCount?: number;
  now?: Date;
  dispatcher: ReconciliationDispatcher;
}

/** Dispatches one valid versioned envelope per application, sorted for stable shard assignment. Failures propagate: no application is silently skipped. */
export async function dispatchScheduledReconciliation(input: ScheduledReconciliationInput): Promise<{ dispatched: number }> {
  const shardCount = input.shardCount ?? 1;
  if (!Number.isInteger(shardCount) || shardCount < 1) throw failClosed('LP-RECONCILIATION-SHARD-COUNT-INVALID', 'permanent', `shardCount must be a positive integer, got '${String(input.shardCount)}'.`);
  const applicationIds = [...input.applicationIds].sort();
  const now = input.now ?? new Date();
  let dispatched = 0;
  for (const applicationId of applicationIds) {
    if (typeof applicationId !== 'string' || applicationId.length === 0) throw new QueueFailure('LP-RECONCILIATION-APPLICATION-ID-INVALID', 'permanent', 'applicationIds must contain non-empty strings.');
    const envelope = createReconciliationEnvelope({ applicationId, shard: dispatched % shardCount, shardCount, now });
    await input.dispatcher.dispatch(envelope);
    dispatched += 1;
  }
  return { dispatched };
}
