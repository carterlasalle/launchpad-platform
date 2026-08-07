import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { stringify as yamlStringify } from 'yaml';
import { InMemoryDatabase, LaunchpadRepositories, TERMINAL_WORKFLOW_STATUSES, type ApplicationRecord, type AuditAppend, type CredentialMetadataRecord, type DeploymentRow, type DriftEventRecord, type LaunchpadStore, type WorkflowRunRecord, type WorkflowStepRecord, type WorkflowStatus } from '@launchpad/database';
import { loadCatalog, parseZoneRegistry, ZONE_REGISTRY_FILE } from '@launchpad/catalog';
import { LaunchpadError, planReviewFingerprint, type HealthCheckRecord, type PlatformPlan } from '@launchpad/core';
import { ALERT_TYPES, canonicalJson, metricWorkflowOf, redactText, sha256Hex, stableId, type AlertType as AlertIncidentType, type LaunchpadLogger, type MetricsRegistry } from '@launchpad/shared';
import { assertTombstoneReuseAllowed } from '@launchpad/workflows';
import { assertOidcBinding, bindOidcBody, extractOidcToken, OidcBindingError, pullRequestNumberFromClaims, verifyGithubOidc, type GithubOidcClaims, type OidcBinding } from './auth/oidc.js';
import { timingSafeEqual } from './auth/timing.js';
import { verifyWebhookSignature } from './auth/webhooks.js';
import { dashboardAssetBindingResponse, dashboardAssetResponse, type DashboardAsset } from './dashboard.js';
import type { ControllerEnv, OidcConfig, WorkflowBinding } from './env.js';
import { recordPermanentFailure, type ObservabilityDeps } from './observability.js';
import { createQueueEnvelope, createReconciliationEnvelope, createReconciliationWorkflowDispatcher, type ProviderEventPayload } from './queues.js';

export type WorkflowHandler = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface ControllerDependencies {
  operatorToken: string;
  oidc?: OidcConfig | undefined;
  webhookSecret?: string | undefined;
  internalWorkflowToken?: string | undefined;
  /** Controller-owned GitHub credential used for server-side PR head verification; never exposed to callers. */
  githubToken?: string | undefined;
  controlCatalogRoot?: string | undefined;
  /** Control repository (`owner/name`) that holds the desired-state catalog; dashboard config changes open PRs against it. */
  controlRepository?: string | undefined;
  repositories?: LaunchpadRepositories | undefined;
  store?: LaunchpadStore | undefined;
  workflowHandlers?: Record<string, WorkflowHandler> | undefined;
  dashboardAssets?: Record<string, DashboardAsset> | (() => Promise<Record<string, DashboardAsset>>) | undefined;
  /** Structured JSON logger; failures are logged with correlation fields and redacted values. */
  logger?: LaunchpadLogger | undefined;
  /** Bounded metrics registry; dispatch outcomes are recorded per workflow kind. */
  metrics?: MetricsRegistry | undefined;
  /** Failure observability: typed error persistence, incidents, alerts, GitHub fan-out. */
  observability?: ObservabilityDeps | undefined;
}

type AppEnv = ControllerEnv & { Variables: { oidcClaims: GithubOidcClaims; operatorActor: string } };

/** The Cloudflare Workflow binding used for each enqueue kind. */
const WORKFLOW_BINDING_BY_KIND: Record<string, keyof ControllerEnv['Bindings']> = {
  apply: 'APPLY_WORKFLOW',
  preview: 'PREVIEW_WORKFLOW',
  'app-preview': 'PREVIEW_WORKFLOW',
  'app-preview-status': 'APP_PREVIEW_STATUS_WORKFLOW',
  reconcile: 'RECONCILE_WORKFLOW',
  decommission: 'DECOMMISSION_WORKFLOW',
};

function bearer(request: Request): string | null {
  const value = request.headers.get('authorization');
  return value?.startsWith('Bearer ') ? value.slice('Bearer '.length) : null;
}

function correlationId(context: Context<AppEnv>): string {
  const header = context.req.header('x-correlation-id');
  return header && header.length > 0 ? header : crypto.randomUUID();
}

function errorResponse(context: Context<AppEnv>, code: string, message: string, status: number, retryable: boolean): Response {
  return context.json({ error: { code, message, retryable, correlationId: correlationId(context) } }, status as Parameters<Context<AppEnv>['json']>[1]);
}

async function readJsonObject(context: Context<AppEnv>): Promise<Record<string, unknown> | null> {
  try {
    const value = await context.req.json<unknown>();
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function repositoryIdentityField(body: Record<string, unknown>, key: 'repositoryId' | 'ownerId'): string | undefined {
  const value = body[key];
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

/**
 * Parses the OPERATOR_TOKENS JSON object (actor name -> bearer token).
 * Malformed configuration fails closed: a non-object, an empty actor name,
 * or a non-string/empty token is a deployment error, not a silently ignored
 * mapping. Returns an empty map when the variable is unset.
 */
export function parseOperatorTokens(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('LP-OPERATOR-TOKENS-INVALID');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('LP-OPERATOR-TOKENS-INVALID');
  const map: Record<string, string> = {};
  for (const [actor, token] of Object.entries(parsed as Record<string, unknown>)) {
    if (actor.length === 0 || typeof token !== 'string' || token.length === 0) throw new Error('LP-OPERATOR-TOKENS-INVALID');
    map[actor] = token;
  }
  return map;
}

/**
 * Resolves the authenticated operator actor from the presented bearer token.
 * The legacy single token (OPERATOR_TOKEN / SECRETS_OPERATOR_TOKEN) maps to
 * the actor 'operator'; OPERATOR_TOKENS maps each actor to its own token.
 * Returns null when the token matches nothing. Every comparison is
 * timing-safe (see auth/timing.ts). Throws LP-OPERATOR-TOKENS-INVALID on a
 * malformed OPERATOR_TOKENS value (fail closed on deployment misconfig).
 */
export function resolveOperatorActor(legacyToken: string, mappedRaw: string | undefined, presented: string | null): string | null {
  if (!presented) return null;
  const mapped = parseOperatorTokens(mappedRaw);
  if (legacyToken.length > 0 && timingSafeEqual(legacyToken, presented)) return 'operator';
  for (const [actor, token] of Object.entries(mapped)) {
    if (timingSafeEqual(token, presented)) return actor;
  }
  return null;
}

/** The audit principal for the authenticated operator (never caller-declared). */
function operatorPrincipal(context: Context<AppEnv>): string {
  return `operator:${context.get('operatorActor')}`;
}

/**
 * Operator authorization for every dashboard read and mutation.
 *
 * The operator model authenticates a bearer token to a resolved actor
 * identity: the legacy single token maps to the actor 'operator', and the
 * optional OPERATOR_TOKENS JSON map authenticates additional named actors.
 * Authorization fails CLOSED — any other or absent credential is rejected,
 * and the token is never read from cookies. The resolved actor is exposed on
 * the request (context variable `operatorActor`) and is the ONLY identity
 * audit events record for operator routes; caller-declared strings are never
 * trusted as the principal.
 *
 * CSRF does not apply to these routes by design: the browser never receives
 * ambient credentials (no cookies, no Authorization auto-attach). The
 * dashboard session token lives in sessionStorage and is attached explicitly
 * as an `Authorization: Bearer` header by the SPA client, so a cross-site
 * request from another origin cannot carry the credential and cannot forge
 * a state-changing request. The same reasoning keeps the routes safe from
 * form/link-based CSRF and login-CSRF: there is nothing ambient to exploit.
 * When operator roles are introduced, the authorization hook belongs here:
 * every route below mounts this middleware, so a role check can be added in
 * one place.
 */
function operatorMiddleware(dependencies: ControllerDependencies): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    const env = context.env as ControllerEnv['Bindings'] | undefined;
    if (!dependencies.operatorToken && !env?.OPERATOR_TOKENS) return errorResponse(context, 'LP-OPERATOR-AUTH-REQUIRED', 'Operator authentication is required.', 401, false);
    let actor: string | null;
    try {
      actor = resolveOperatorActor(dependencies.operatorToken, env?.OPERATOR_TOKENS, bearer(context.req.raw));
    } catch {
      return errorResponse(context, 'LP-OPERATOR-TOKENS-INVALID', 'The operator token configuration is invalid; refusing operator access.', 503, false);
    }
    if (actor === null) return errorResponse(context, 'LP-OPERATOR-AUTH-REQUIRED', 'Operator authentication is required.', 401, false);
    context.set('operatorActor', actor);
    await next();
  };
}

/** Stable, redacted workflow error envelope: no provider bodies, no secrets (contract: { error: { code, message, retryable, correlationId } }). */
export interface WorkflowErrorEnvelope { error: { code: string; message: string; retryable: boolean; correlationId: string | null }; }

function errorCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  if ('code' in error) {
    const code = error.code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  if (error instanceof Error && error.name !== 'Error') return error.name;
  return null;
}

function namedError(code: string, message: string): Error {
  const error = new Error(message);
  error.name = code;
  return error;
}

export function workflowErrorEnvelope(error: unknown, correlationId: string | null): WorkflowErrorEnvelope {
  const code = errorCodeOf(error) ?? (error instanceof Error ? error.name : 'LP-INTERNAL');
  const message = error instanceof Error ? error.message : 'Unknown controller failure.';
  const retryable = typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === true;
  return { error: { code, message, retryable, correlationId } };
}

export function statusForWorkflowError(error: unknown): ContentfulStatusCode {
  const code = errorCodeOf(error) ?? '';
  if (code.includes('TIMEOUT')) return 504;
  if (code.includes('MALFORMED')) return 502;
  if (code.includes('NOT_FOUND')) return 404;
  if (code.includes('MISMATCH') || code.includes('SCOPE')) return 409;
  return 500;
}

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

function validateAppPreviewStatusPayload(body: Record<string, unknown>, applicationId: string): Error | null {
  if (body.version !== 1) return namedError('LP-PAYLOAD-VERSION-UNSUPPORTED', 'Unsupported payload version; expected version 1.');
  if (body.applicationId !== applicationId || typeof body.applicationId !== 'string' || body.applicationId.length === 0) return namedError('LP-PAYLOAD-APPLICATION-ID-MISMATCH', 'applicationId must match the route application.');
  if (typeof body.sourceCommit !== 'string' || !COMMIT_SHA_PATTERN.test(body.sourceCommit)) return namedError('LP-PAYLOAD-COMMIT-INVALID', 'sourceCommit must be a 40-character commit SHA.');
  if (typeof body.repository !== 'string' || body.repository.length === 0) return namedError('LP-PAYLOAD-REPOSITORY-MISSING', 'repository is required.');
  if (body.repositoryId === undefined || body.repositoryOwnerId === undefined) return namedError('LP-PAYLOAD-REPOSITORY-IDENTITY-MISSING', 'repositoryId and repositoryOwnerId are required.');
  if (typeof body.event !== 'string' || body.event.length === 0) return namedError('LP-PAYLOAD-EVENT-MISSING', 'event is required.');
  return null;
}

/** Verifies the GitHub Actions OIDC bearer token (signature, issuer, audience, time, allowlists) and exposes its claims. */
export function oidcMiddleware(dependencies: ControllerDependencies): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    if (!dependencies.oidc) return errorResponse(context, 'LP-OIDC-CONFIG-MISSING', 'OIDC is not configured for this controller.', 503, false);
    const token = extractOidcToken(bearer(context.req.raw));
    if (!token) return errorResponse(context, 'LP-OIDC-TOKEN-MISSING', 'A GitHub Actions OIDC bearer token is required.', 401, false);
    let claims: GithubOidcClaims;
    try {
      claims = await verifyGithubOidc(token, dependencies.oidc);
    } catch {
      return errorResponse(context, 'LP-OIDC-VERIFICATION-FAILED', 'OIDC token verification failed.', 401, false);
    }
    // Control-repository gate: every control-plane OIDC ingress (plan
    // attestation, preview/apply enqueue, operation polling) must be driven
    // by a workflow running in the configured CONTROL_REPOSITORY. When the
    // repository is configured, a token minted for any other repository is
    // rejected outright. The cross-repo preview/status endpoint used by
    // application repositories performs its own verification below and is
    // deliberately NOT subject to this gate.
    if (dependencies.controlRepository && claims.repository !== dependencies.controlRepository) {
      return errorResponse(context, 'LP-OIDC-REPOSITORY-NOT-CONTROL', 'The OIDC token repository is not the configured control repository.', 401, false);
    }
    context.set('oidcClaims', claims);
    await next();
  };
}

/**
 * Canonical payload identity hash recorded for every durable operation.
 * The exact byte value is a cross-file contract: workflow machines call
 * `startWorkflowRun` with the same idempotency key and payload hash on every
 * phase dispatch, so both sides MUST compute the identical formula. Absent
 * optional fields are omitted (never `undefined`).
 */
export interface WorkflowIdentityHashInput {
  version: number;
  kind: string;
  applicationId: string;
  sourceCommit: string;
  desiredGeneration?: number;
  planFingerprint?: string;
}

export async function workflowPayloadHash(input: WorkflowIdentityHashInput): Promise<string> {
  const identity: Record<string, unknown> = { version: input.version, kind: input.kind, applicationId: input.applicationId, sourceCommit: input.sourceCommit };
  if (input.desiredGeneration !== undefined) identity.desiredGeneration = input.desiredGeneration;
  if (input.planFingerprint !== undefined) identity.planFingerprint = input.planFingerprint;
  return sha256Hex(canonicalJson(identity));
}

/** Safe, redacted projection of a workflow result for OIDC pollers. Never exposes raw provider bodies. */
export interface SafeOperationResult { previewUrl: string | null; buildState: string | null; healthState: string | null; }

export function projectSafeOperationResult(result: unknown): SafeOperationResult | null {
  if (typeof result !== 'object' || result === null) return null;
  const record = result as Record<string, unknown>;
  const deployment = typeof record.deployment === 'object' && record.deployment !== null ? (record.deployment as Record<string, unknown>) : null;
  const health = typeof record.health === 'object' && record.health !== null ? (record.health as Record<string, unknown>) : null;
  return {
    previewUrl: deployment && typeof deployment.url === 'string' ? deployment.url : null,
    buildState: deployment && typeof deployment.state === 'string' ? deployment.state : null,
    healthState: health && typeof health.result === 'string' ? health.result : (health && typeof health.status === 'string' ? health.status : null),
  };
}

/** Maps a persisted-operation failure onto the typed error envelope. */
function mapEnqueueError(context: Context<AppEnv>, error: unknown): Response {
  if (error instanceof OidcBindingError) return errorResponse(context, error.code, error.message, 401, false);
  if (error instanceof LaunchpadError) {
    if (error.platform.code === 'LP-DB-IDEMPOTENCY-REUSED') return errorResponse(context, 'LP-IDEMPOTENCY-CONFLICT', 'This idempotency key was already used with a different payload.', 409, false);
    if (error.platform.code === 'LP-DB-TOMBSTONE-REUSE-BLOCKED') return errorResponse(context, 'LP-APPLICATION-TOMBSTONED', 'The application is tombstoned and cannot be operated on.', 409, false);
    return errorResponse(context, 'LP-OPERATION-PERSIST-FAILED', 'The operation could not be durably recorded.', 500, true);
  }
  return errorResponse(context, 'LP-INTERNAL-ERROR', 'An internal error occurred.', 500, true);
}

/**
 * Registers a minimal application record on the first claim-bound operation.
 * The durable machines replace it with authoritative manifest data later; the
 * row is inert (UNKNOWN state, no provider access) and tombstoned/deleted
 * applications fail closed at the store level.
 */
export async function ensureApplicationRegistered(store: LaunchpadStore, applicationId: string, catalogRoot: string | undefined, sourcePath?: string): Promise<void> {
  const existing = await store.getApplication(applicationId);
  if (existing) {
    if (sourcePath && sourcePath !== existing.sourcePath) await store.upsertApplication({ ...existing, sourcePath });
    return;
  }
  await store.upsertApplication({
    id: applicationId,
    displayName: applicationId,
    sourcePath: sourcePath ?? `${(catalogRoot ?? 'catalog/apps').replace(/\/$/, '')}/${applicationId}.yaml`,
    desiredGeneration: 0,
    desiredHash: '',
    syncStatus: 'UNKNOWN',
    healthStatus: 'UNKNOWN',
    lifecycleState: 'active',
  });
}

function declaredManifestPath(body: Record<string, unknown>): string | null {
  if (typeof body.manifestPath === 'string' && body.manifestPath.length > 0) return body.manifestPath;
  const desired = body.desired;
  if (desired !== null && typeof desired === 'object' && !Array.isArray(desired)) {
    const sourcePath = (desired as Record<string, unknown>).sourcePath;
    if (typeof sourcePath === 'string' && sourcePath.length > 0) return sourcePath;
  }
  return null;
}

function isCatalogManifestPath(path: string, catalogRoot: string | undefined): boolean {
  const root = (catalogRoot ?? 'catalog/apps').replace(/\/$/, '');
  return path.startsWith(`${root}/`) && !path.includes('..') && /\.ya?ml$/.test(path);
}

/** Server-side verification that the submitted sourceCommit is the PR head, using the controller's own GitHub credential. */
async function verifyPullRequestHead(dependencies: ControllerDependencies, input: { repository: string; prNumber: number | string; sourceCommit: string }): Promise<{ ok: boolean; code: string; message: string; retryable: boolean }> {
  if (!dependencies.githubToken) return { ok: false, code: 'LP-OIDC-PR-VERIFICATION-UNAVAILABLE', message: 'PR head verification is unavailable because the controller GitHub token is not configured.', retryable: false };
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${input.repository}/pulls/${encodeURIComponent(String(input.prNumber))}`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${dependencies.githubToken}`, 'user-agent': 'launchpad-control-plane', 'x-github-api-version': '2022-11-28' },
    });
  } catch {
    return { ok: false, code: 'LP-OIDC-PR-HEAD-UNVERIFIABLE', message: 'The pull request head could not be verified.', retryable: true };
  }
  if (!response.ok) return { ok: false, code: 'LP-OIDC-PR-HEAD-UNVERIFIABLE', message: 'The pull request head could not be verified.', retryable: response.status === 408 || response.status === 429 || response.status >= 500 };
  try {
    const pullRequest = await response.json() as { head?: { sha?: unknown } };
    if (typeof pullRequest.head?.sha !== 'string' || pullRequest.head.sha !== input.sourceCommit) {
      return { ok: false, code: 'LP-OIDC-CLAIM-MISMATCH-SOURCECOMMIT', message: 'The submitted sourceCommit is not the current pull request head.', retryable: false };
    }
  } catch {
    return { ok: false, code: 'LP-OIDC-PR-HEAD-UNVERIFIABLE', message: 'The pull request head could not be verified.', retryable: true };
  }
  return { ok: true, code: '', message: '', retryable: false };
}

/**
 * The OIDC operation-start audit event. It is the persisted claim binding
 * that authorizes later claim-scoped polling of the operation; replaying the
 * same idempotent request never duplicates it. The full (safe, claim-bound)
 * enqueue params are recorded so an operator can replay a failed operation
 * through the retry action without re-deriving provider inputs.
 */
async function appendOperationAudit(store: LaunchpadStore, input: { applicationId: string; operationId: string; workflowId: string; kind: string; claims: GithubOidcClaims; binding: OidcBinding; params?: Record<string, unknown> }): Promise<void> {
  const details: Record<string, unknown> = {
    repositoryId: input.binding.repositoryId ?? input.claims.repository_id,
    ownerId: input.binding.ownerId ?? input.claims.repository_owner_id,
    repository: input.binding.repository ?? input.claims.repository,
    workflowRef: input.binding.workflowRef ?? input.claims.workflow_ref,
    event: input.binding.event ?? input.claims.event_name,
    sourceCommit: input.binding.sourceCommit,
  };
  if (input.binding.prNumber !== undefined && input.binding.prNumber !== null) details.prNumber = input.binding.prNumber;
  if (input.binding.ref !== undefined && input.binding.ref !== null) details.ref = input.binding.ref;
  const actor = input.binding.actor ?? input.claims.actor;
  if (actor !== undefined) details.actor = actor;
  if (input.params !== undefined) details.params = input.params;
  const id = stableId('audit', input.applicationId, 'OIDC_OPERATION_START', input.operationId);
  const alreadyRecorded = (await store.listAudit(input.applicationId)).some((event) => event.id === id);
  if (alreadyRecorded) return;
  try {
    await store.appendAudit({ id, actor: `oidc:${String(actor ?? details.repository ?? 'workflow')}`, action: 'OIDC_OPERATION_START', applicationId: input.applicationId, details: { ...details, operationId: input.operationId, workflowId: input.workflowId, kind: input.kind } });
  } catch {
    const raced = (await store.listAudit(input.applicationId)).some((event) => event.id === id);
    if (!raced) throw new Error('LP-AUDIT-APPEND-FAILED');
  }
}

/**
 * Records the durable operation (workflow run + idempotent-request ledger),
 * creates the Cloudflare Workflow instance, and returns the 202 contract.
 * A 202 is only possible after D1 state and the workflow instance both exist.
 */
async function enqueueDurableOperation(context: Context<AppEnv>, dependencies: ControllerDependencies, input: { kind: string; applicationId: string; idempotencyKey: string; params: Record<string, unknown>; claims: GithubOidcClaims; binding: OidcBinding }): Promise<Response> {
  const store = dependencies.store;
  if (!store) return errorResponse(context, 'LP-PERSISTENCE-CONFIG-MISSING', 'Durable persistence is not configured; refusing to enqueue.', 503, false);
  const bindingName = WORKFLOW_BINDING_BY_KIND[input.kind];
  const workflow = bindingName ? (context.env[bindingName] as WorkflowBinding | undefined) : undefined;
  if (!workflow) return errorResponse(context, 'LP-WORKFLOW-BINDING-MISSING', `No workflow binding is configured for '${input.kind}'.`, 503, false);
  const hashInput: WorkflowIdentityHashInput = {
    version: 1,
    kind: input.kind,
    applicationId: input.applicationId,
    sourceCommit: typeof input.params.sourceCommit === 'string' ? input.params.sourceCommit : '',
  };
  if (typeof input.params.desiredGeneration === 'number') hashInput.desiredGeneration = input.params.desiredGeneration;
  if (typeof input.params.planFingerprint === 'string') hashInput.planFingerprint = input.params.planFingerprint;
  const payloadHash = await workflowPayloadHash(hashInput);
  let run: WorkflowRunRecord;
  try {
    await ensureApplicationRegistered(store, input.applicationId, dependencies.controlCatalogRoot, typeof input.params.manifestPath === 'string' ? input.params.manifestPath : undefined);
    run = await store.startWorkflowRun({ applicationId: input.applicationId, workflowType: input.kind, idempotencyKey: input.idempotencyKey, payloadHash });
    // A terminal run is immutable and its workflow instance already exists:
    // a QUEUED/RUNNING/SUCCEEDED replay is returned as-is (the caller dedupes
    // on the response), while a FAILED/BLOCKED run is retried under a fresh
    // derived key so the same logical operation can be re-enqueued without
    // losing the original run or its audit trail.
    let retryAttempt = 1;
    while (run.status === 'FAILED' || run.status === 'BLOCKED') {
      run = await store.startWorkflowRun({ applicationId: input.applicationId, workflowType: input.kind, idempotencyKey: `${input.idempotencyKey}:retry:${retryAttempt}`, payloadHash });
      retryAttempt += 1;
    }
    await store.registerIdempotentRequest({ idempotencyKey: input.idempotencyKey, operationId: run.id, payloadHash });
  } catch (error) {
    return mapEnqueueError(context, error);
  }
  if (run.status !== 'QUEUED') {
    // Replay of an already-enqueued or completed operation: report the
    // recorded run without dispatching a duplicate workflow instance.
    return context.json({ workflowId: run.id, operationId: run.id, status: run.status, replayed: true }, 202);
  }
  const workflowId = `lp-${input.kind}-${run.id}`;
  let instance: { id: string };
  try {
    instance = await workflow.create({ id: workflowId, params: { ...input.params, operationId: run.id, workflowId } });
  } catch {
    return errorResponse(context, 'LP-WORKFLOW-CREATE-FAILED', 'The durable workflow could not be started.', 503, true);
  }
  try {
    await appendOperationAudit(store, { applicationId: input.applicationId, operationId: run.id, workflowId: instance.id, kind: input.kind, claims: input.claims, binding: input.binding, params: input.params });
  } catch {
    return errorResponse(context, 'LP-AUDIT-APPEND-FAILED', 'The operation could not be bound to its caller.', 500, true);
  }
  return context.json({ workflowId: instance.id, operationId: run.id, status: 'QUEUED' }, 202);
}

/**
 * Verifies the OIDC token, binds every declared identity claim (repository,
 * repository/owner IDs, workflow ref, event, PR number, commit, ref, actor,
 * application) against the route and body, verifies PR head commits
 * server-side, and enqueues the durable workflow. Nothing is written to D1
 * and no provider is touched before all bindings pass.
 */
async function enqueueOidcOperation(context: Context<AppEnv>, dependencies: ControllerDependencies, options: { kind: string; applicationIdFromRoute?: string; body: Record<string, unknown> }): Promise<Response> {
  const claims = context.get('oidcClaims');
  const body = options.body;
  const applicationId = typeof body.applicationId === 'string' && body.applicationId.length > 0 ? body.applicationId : null;
  if (!applicationId) return errorResponse(context, 'LP-OIDC-BINDING-MISSING-APPLICATIONID', 'The request body must declare a non-empty applicationId.', 400, false);
  if (options.applicationIdFromRoute !== undefined && applicationId !== options.applicationIdFromRoute) {
    return errorResponse(context, 'LP-OIDC-CLAIM-MISMATCH-APPLICATIONID', 'The route application does not match the request body applicationId.', 401, false);
  }
  const stringField = (key: string): string | undefined => (typeof body[key] === 'string' && (body[key] as string).length > 0 ? (body[key] as string) : undefined);
  const manifestPath = declaredManifestPath(body);
  if (manifestPath !== null && !isCatalogManifestPath(manifestPath, dependencies.controlCatalogRoot)) return errorResponse(context, 'LP-MANIFEST-PATH-INVALID', 'The declared manifest path must remain inside the configured catalog root.', 400, false);
  const binding: OidcBinding = { applicationId };
  const repository = stringField('repository');
  if (repository) binding.repository = repository;
  const repositoryId = repositoryIdentityField(body, 'repositoryId');
  if (repositoryId) binding.repositoryId = repositoryId;
  const ownerId = repositoryIdentityField(body, 'ownerId');
  if (ownerId) binding.ownerId = ownerId;
  const workflowRef = stringField('workflowRef');
  if (workflowRef) binding.workflowRef = workflowRef;
  const declaredEvent = stringField('event');
  if (declaredEvent) binding.event = declaredEvent;
  if (typeof body.prNumber === 'number' || typeof body.prNumber === 'string') binding.prNumber = body.prNumber;
  const declaredSourceCommit = stringField('sourceCommit');
  if (declaredSourceCommit) binding.sourceCommit = declaredSourceCommit;
  const declaredRef = stringField('ref');
  if (declaredRef) binding.ref = declaredRef;
  const declaredActor = stringField('actor');
  if (declaredActor) binding.actor = declaredActor;
  try {
    assertOidcBinding(claims, binding);
  } catch (error) {
    return mapEnqueueError(context, error);
  }
  for (const field of ['repository', 'repositoryId', 'ownerId', 'workflowRef'] as const) {
    if (binding[field] === undefined || binding[field] === null) {
      return errorResponse(context, `LP-OIDC-BINDING-MISSING-${field.toUpperCase()}`, `The request must declare ${field}.`, 400, false);
    }
  }
  const idempotencyKey = stringField('idempotencyKey');
  if (!idempotencyKey) return errorResponse(context, 'LP-IDEMPOTENCY-KEY-REQUIRED', 'Durable operations require an idempotencyKey.', 400, false);
  const sourceCommit = binding.sourceCommit;
  if (!sourceCommit) return errorResponse(context, 'LP-OIDC-BINDING-MISSING-SOURCECOMMIT', 'The request must declare the exact sourceCommit.', 400, false);
  const event = binding.event ?? claims.event_name;
  if (event === 'pull_request') {
    if (binding.prNumber === undefined || binding.prNumber === null) return errorResponse(context, 'LP-OIDC-BINDING-MISSING-PRNUMBER', 'pull_request operations must declare the prNumber.', 400, false);
    const repository = binding.repository ?? claims.repository;
    if (!repository) return errorResponse(context, 'LP-OIDC-CLAIM-MISSING-REPOSITORY', 'The OIDC token is missing the repository claim.', 401, false);
    const verdict = await verifyPullRequestHead(dependencies, { repository, prNumber: binding.prNumber, sourceCommit });
    if (!verdict.ok) return errorResponse(context, verdict.code, verdict.message, verdict.retryable ? 503 : 401, verdict.retryable);
  }
  const desiredGeneration = typeof body.desiredGeneration === 'number' ? body.desiredGeneration : undefined;
  const planFingerprint = stringField('planFingerprint');
  const params: Record<string, unknown> = {
    version: 1,
    kind: options.kind,
    applicationId,
    sourceCommit,
    idempotencyKey,
    repositoryId: binding.repositoryId ?? claims.repository_id,
    ownerId: binding.ownerId ?? claims.repository_owner_id,
    repository: binding.repository ?? claims.repository,
    workflowRef: binding.workflowRef ?? claims.workflow_ref,
    event,
    ...(binding.prNumber !== undefined && binding.prNumber !== null ? { prNumber: binding.prNumber } : {}),
    ...(binding.ref !== undefined && binding.ref !== null ? { ref: binding.ref } : {}),
    actor: binding.actor ?? claims.actor ?? 'workflow',
    ...(desiredGeneration !== undefined ? { desiredGeneration } : {}),
    ...(planFingerprint ? { planFingerprint } : {}),
    ...(typeof body.correlationId === 'string' ? { correlationId: body.correlationId } : {}),
    ...(options.kind === 'preview' && typeof body.desired === 'object' && body.desired !== null ? { desired: body.desired } : {}),
    ...(manifestPath !== null ? { manifestPath } : {}),
    ...(typeof body.pullRequestNumber === 'number' ? { pullRequestNumber: body.pullRequestNumber } : {}),
    ...(typeof body.revision === 'number' ? { revision: body.revision } : {}),
  };
  return enqueueDurableOperation(context, dependencies, { kind: options.kind, applicationId, idempotencyKey, params, claims, binding });
}

const DESIRED_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Synchronous reviewed-plan attestation (plan-approval gate). Verifies the
 * OIDC token (middleware), binds every declared identity claim, requires a
 * pull_request event with a server-side-verified PR head, validates that the
 * submitted plan is the exact PR-head plan (application, source commit,
 * fingerprint, generation), recomputes the source-commit-neutral review
 * fingerprint from the plan itself (never trusting a client-provided value),
 * and persists the attestation idempotently. Returns 200 only after the
 * attestation row is durably stored; nothing is written to D1 before every
 * binding passes.
 */
async function verifyReviewedPlan(context: Context<AppEnv>, dependencies: ControllerDependencies, body: Record<string, unknown>): Promise<Response> {
  const claims = context.get('oidcClaims');
  const store = dependencies.store;
  if (!store) return errorResponse(context, 'LP-PERSISTENCE-CONFIG-MISSING', 'Durable persistence is not configured; refusing to record a plan review.', 503, false);
  const stringField = (key: string): string | undefined => (typeof body[key] === 'string' && (body[key] as string).length > 0 ? (body[key] as string) : undefined);
  const manifestPath = declaredManifestPath(body);
  if (manifestPath !== null && !isCatalogManifestPath(manifestPath, dependencies.controlCatalogRoot)) return errorResponse(context, 'LP-MANIFEST-PATH-INVALID', 'The declared manifest path must remain inside the configured catalog root.', 400, false);
  const applicationId = stringField('applicationId');
  if (!applicationId) return errorResponse(context, 'LP-OIDC-BINDING-MISSING-APPLICATIONID', 'The request body must declare a non-empty applicationId.', 400, false);
  const sourceCommit = stringField('sourceCommit');
  if (!sourceCommit || !COMMIT_SHA_PATTERN.test(sourceCommit)) return errorResponse(context, 'LP-PAYLOAD-COMMIT-INVALID', 'sourceCommit must be a 40-character commit SHA.', 400, false);
  const planFingerprint = stringField('planFingerprint');
  if (!planFingerprint) return errorResponse(context, 'LP-PLAN-FINGERPRINT-REQUIRED', 'Plan review requires the exact planFingerprint.', 400, false);
  const desiredHash = stringField('desiredHash');
  if (!desiredHash || !DESIRED_HASH_PATTERN.test(desiredHash)) return errorResponse(context, 'LP-PLAN-REVIEW-DESIRED-HASH-INVALID', 'desiredHash must be the sha256 of the redacted desired manifest.', 400, false);
  const desiredGeneration = body.desiredGeneration;
  if (typeof desiredGeneration !== 'number' || !Number.isInteger(desiredGeneration) || desiredGeneration < 1) return errorResponse(context, 'LP-DESIRED-GENERATION-REQUIRED', 'Plan review requires a positive integer desiredGeneration.', 400, false);
  const rawPlan = body.plan;
  if (typeof rawPlan !== 'object' || rawPlan === null || Array.isArray(rawPlan)) return errorResponse(context, 'LP-PLAN-REVIEW-PLAN-INVALID', 'Plan review requires the real plan object.', 400, false);
  const plan = rawPlan as Record<string, unknown>;
  if (plan.applicationId !== applicationId || plan.sourceCommit !== sourceCommit || plan.fingerprint !== planFingerprint || plan.desiredGeneration !== desiredGeneration) {
    return errorResponse(context, 'LP-PLAN-REVIEW-PLAN-MISMATCH', 'The submitted plan does not bind this application, source commit, fingerprint, and generation.', 400, false);
  }
  if (
    plan.schemaVersion !== 'launchpad.plan/v1'
    || typeof plan.createdAt !== 'string'
    || typeof plan.observedStateHash !== 'string'
    || plan.observedStateHash.length === 0
    || typeof plan.capabilitySnapshotHash !== 'string'
    || plan.capabilitySnapshotHash.length === 0
    || !Array.isArray(plan.operations)
    || !Array.isArray(plan.downstreamEffects)
    || !Array.isArray(plan.policyResults)
    || (plan.result !== 'READY' && plan.result !== 'BLOCKED' && plan.result !== 'DESTRUCTIVE')
  ) {
    return errorResponse(context, 'LP-PLAN-REVIEW-PLAN-INVALID', 'The submitted plan is missing required canonical fields.', 400, false);
  }
  const binding: OidcBinding = { applicationId };
  const repository = stringField('repository');
  if (repository) binding.repository = repository;
  const repositoryId = repositoryIdentityField(body, 'repositoryId');
  if (repositoryId) binding.repositoryId = repositoryId;
  const ownerId = repositoryIdentityField(body, 'ownerId');
  if (ownerId) binding.ownerId = ownerId;
  const workflowRef = stringField('workflowRef');
  if (workflowRef) binding.workflowRef = workflowRef;
  const declaredEvent = stringField('event');
  if (declaredEvent) binding.event = declaredEvent;
  if (typeof body.prNumber === 'number' || typeof body.prNumber === 'string') binding.prNumber = body.prNumber;
  const declaredRef = stringField('ref');
  if (declaredRef) binding.ref = declaredRef;
  const declaredActor = stringField('actor');
  if (declaredActor) binding.actor = declaredActor;
  try {
    assertOidcBinding(claims, binding);
  } catch (error) {
    return mapEnqueueError(context, error);
  }
  for (const field of ['repository', 'repositoryId', 'ownerId', 'workflowRef'] as const) {
    if (binding[field] === undefined || binding[field] === null) {
      return errorResponse(context, `LP-OIDC-BINDING-MISSING-${field.toUpperCase()}`, `The request must declare ${field}.`, 400, false);
    }
  }
  const event = binding.event ?? claims.event_name;
  if (event !== 'pull_request') return errorResponse(context, 'LP-PLAN-REVIEW-REQUIRES-PULL-REQUEST', 'Plan reviews are only recorded for pull_request workflows.', 400, false);
  if (binding.prNumber === undefined || binding.prNumber === null) return errorResponse(context, 'LP-OIDC-BINDING-MISSING-PRNUMBER', 'pull_request plan reviews must declare the prNumber.', 400, false);
  const reviewedRepository = binding.repository ?? claims.repository;
  if (!reviewedRepository) return errorResponse(context, 'LP-OIDC-CLAIM-MISSING-REPOSITORY', 'The OIDC token is missing the repository claim.', 401, false);
  const verdict = await verifyPullRequestHead(dependencies, { repository: reviewedRepository, prNumber: binding.prNumber, sourceCommit });
  if (!verdict.ok) return errorResponse(context, verdict.code, verdict.message, verdict.retryable ? 503 : 401, verdict.retryable);
  const reviewFingerprint = await planReviewFingerprint(plan as unknown as PlatformPlan);
  const actor = binding.actor ?? claims.actor ?? 'workflow';
  try {
    await ensureApplicationRegistered(store, applicationId, dependencies.controlCatalogRoot, manifestPath ?? undefined);
    const { inserted, attestation } = await store.savePlanReviewAttestation({
      applicationId,
      prHeadSourceCommit: sourceCommit,
      desiredHash,
      generation: desiredGeneration,
      planFingerprint,
      reviewFingerprint,
      repository: reviewedRepository,
      actor,
      workflowRef: binding.workflowRef ?? claims.workflow_ref ?? '',
    });
    await store.appendAudit({ actor: `oidc:${actor}`, action: inserted ? 'PLAN_REVIEW_ATTESTED' : 'PLAN_REVIEW_DEDUPLICATED', applicationId, details: { applicationId, sourceCommit, prNumber: binding.prNumber, desiredGeneration, reviewFingerprint, deduplicated: !inserted } });
    return context.json({ accepted: true, deduplicated: !inserted, attestationId: attestation.id, applicationId, sourceCommit, desiredGeneration, desiredHash, planFingerprint, reviewFingerprint, createdAt: attestation.createdAt }, 200);
  } catch (error) {
    return mapEnqueueError(context, error);
  }
}

/** Redacts a handler failure into the stable envelope shape; never leaks provider bodies. Typed errors (name = LP-CODE) keep their code so the durable run, observability, and pollers agree on the failure. */
function redactHandlerError(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof Error && error.name !== 'Error' && /^LP-[\w-]+$/.test(error.name)) {
    return { code: error.name, message: error.message, retryable: true };
  }
  if (error instanceof Error && /^LP-[\w-]+/.test(error.message)) {
    return { code: error.message.split(':')[0] ?? 'LP-WORKFLOW-STEP-FAILED', message: error.message, retryable: true };
  }
  return { code: 'LP-WORKFLOW-STEP-FAILED', message: 'The workflow step failed.', retryable: true };
}

/**
 * Persists the terminal marker for handler-driven workflow kinds, but only
 * when no granular machine is tracking the run (a machine records its own
 * steps and status through the store). Idempotent across step retries.
 */
async function persistInternalOutcome(dependencies: ControllerDependencies, payload: Record<string, unknown>, status: 'SUCCEEDED' | 'FAILED', result: unknown, error: { code: string; message: string } | null): Promise<void> {
  const store = dependencies.store;
  const operationId = typeof payload.operationId === 'string' && payload.operationId.length > 0 ? payload.operationId : null;
  if (!store || !operationId) return;
  const run = await store.getWorkflowRun(operationId);
  if (!run) return;
  const steps = await store.listWorkflowSteps(operationId);
  const attempt = typeof payload.attempt === 'number' ? payload.attempt : 1;
  if (status === 'SUCCEEDED') {
    if (run.status === 'SUCCEEDED') return;
    const executeStep = steps.length === 1 ? steps[0] : undefined;
    const machineOwned = steps.length > 0 && executeStep?.stepId !== 'execute';
    if (machineOwned) return;
    await store.recordWorkflowStep({ workflowId: operationId, stepId: 'execute', status: 'SUCCEEDED', attempt, preconditionHash: run.payloadHash, result });
    await store.updateWorkflowRun(operationId, { status: 'SUCCEEDED', completedAt: new Date().toISOString(), errorCode: null });
  } else {
    if (run.status !== 'QUEUED' || steps.length !== 0) return;
    await store.recordWorkflowStep({ workflowId: operationId, stepId: 'execute', status: 'FAILED', attempt, preconditionHash: run.payloadHash, error });
    await store.updateWorkflowRun(operationId, { status: 'FAILED', completedAt: new Date().toISOString(), errorCode: error?.code ?? 'LP-WORKFLOW-STEP-FAILED' });
  }
}

async function dispatchInternal(context: Context<AppEnv>, dependencies: ControllerDependencies, phase: string | null): Promise<Response> {
  const payload = await readJsonObject(context);
  if (!payload) return errorResponse(context, 'LP-REQUEST-BODY-INVALID', 'The request body must be a JSON object.', 400, false);
  const applicationId = typeof payload.applicationId === 'string' && payload.applicationId.length > 0 ? payload.applicationId : null;
  if (!applicationId) return errorResponse(context, 'LP-WORKFLOW-PAYLOAD-MISSING-APPLICATIONID', 'applicationId is required.', 400, false);
  const kind = context.req.param('kind');
  if (!kind) return errorResponse(context, 'LP-WORKFLOW-KIND-MISSING', 'Workflow kind is required.', 400, false);
  const handler = phase ? (dependencies.workflowHandlers?.[`${kind}/${phase}`] ?? dependencies.workflowHandlers?.[kind]) : dependencies.workflowHandlers?.[kind];
  if (handler) {
    const startedAt = Date.now();
    const failureContext = {
      applicationId,
      operationId: typeof payload.operationId === 'string' ? payload.operationId : null,
      workflowId: typeof payload.workflowId === 'string' ? payload.workflowId : null,
      correlationId: typeof payload.correlationId === 'string' ? payload.correlationId : null,
      step: phase ?? null,
      kind,
      repository: typeof payload.repository === 'string' ? payload.repository : null,
      pullRequestNumber: typeof payload.prNumber === 'number' || typeof payload.prNumber === 'string' ? payload.prNumber : (typeof payload.pullRequestNumber === 'number' ? payload.pullRequestNumber : null),
      sourceCommit: typeof payload.sourceCommit === 'string' ? payload.sourceCommit : null,
      provider: kind === 'reconcile' ? 'github' : kind === 'apply' || kind === 'preview' || kind === 'app-preview' || kind === 'app-preview-status' || kind === 'decommission' ? 'vercel' : null,
    } as const;
    try {
      const result = await handler(payload);
      await persistInternalOutcome(dependencies, payload, 'SUCCEEDED', result, null);
      dependencies.metrics?.increment('successes', { workflow: metricWorkflowOf(kind) });
      dependencies.metrics?.recordDuration(Date.now() - startedAt, { workflow: metricWorkflowOf(kind) });
      return context.json(result);
    } catch (error) {
      const redacted = redactHandlerError(error);
      await persistInternalOutcome(dependencies, payload, 'FAILED', null, { code: redacted.code, message: redacted.message });
      dependencies.metrics?.increment('failures', { workflow: metricWorkflowOf(kind) });
      if (kind === 'preview-cleanup') dependencies.metrics?.increment('preview_cleanup_failures');
      if (dependencies.observability) {
        await recordPermanentFailure(dependencies.observability, { ...failureContext, error });
      } else {
        dependencies.logger?.error('workflow step failed', { applicationId, step: phase ?? null, errorCode: redacted.code, retryable: redacted.retryable, correlationId: failureContext.correlationId, workflowId: failureContext.workflowId, operationId: failureContext.operationId, kind });
      }
      return errorResponse(context, redacted.code, redacted.message, 500, redacted.retryable);
    }
  }
  // Handler-less kinds (queue-dispatched envelopes) keep the legacy operation
  // record; the queue itself provides durability for these.
  const repositories = dependencies.repositories ?? new LaunchpadRepositories(new InMemoryDatabase());
  const operation = repositories.startOperation({ applicationId, workflowId: crypto.randomUUID(), action: kind.toUpperCase(), idempotencyKey: typeof payload.idempotencyKey === 'string' ? payload.idempotencyKey : crypto.randomUUID(), payloadHash: `${kind}:${applicationId}` });
  return context.json({ workflowId: operation.id, status: operation.status }, 202);
}

// ---------------------------------------------------------------------------
// Operator dashboard reads, direct recovery actions, and PR-only config
// changes (master plan sections 21.2, 23, 27).
//
// Every dashboard response is derived from persisted rows through the
// LaunchpadStore. Status dimensions (sync / health / deployment / operation)
// are serialized verbatim from the store: a provider read failure is recorded
// as UNKNOWN/BLOCKED by the observers and is NEVER upgraded to HEALTHY/SYNCED
// here. List queries are bounded, and truncation is reported truthfully.
// Config changes only open control-repository pull requests — no provider is
// mutated from a dashboard request. Direct provider access is limited to the
// three allowed recovery actions (retry failed step, recheck health, rollback
// to known-good), and each is idempotent, audited, and store-backed.
// ---------------------------------------------------------------------------

const DASHBOARD_DEFAULT_LIMIT = 50;
const DASHBOARD_MAX_LIMIT = 200;
const DASHBOARD_CATALOG_MAX_LIMIT = 500;

function parseListLimit(value: string | undefined, fallback: number, max: number): number | null {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return Math.min(parsed, max);
}

/** Fetches at most `limit + 1` rows so truncation can be reported truthfully. */
async function boundedRows<T>(fetchRows: (limit: number) => Promise<T[]>, limit: number): Promise<{ rows: T[]; truncated: boolean }> {
  const rows = await fetchRows(limit + 1);
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

function byStartedAscending(left: { startedAt: string }, right: { startedAt: string }): number {
  return left.startedAt.localeCompare(right.startedAt);
}

/** A workflow run as the dashboard sees it: action is the machine kind, verbatim. */
interface OperationView {
  id: string;
  workflowId: string;
  applicationId: string;
  action: string;
  status: string;
  idempotencyKey: string;
  payloadHash: string;
  startedAt: string;
  completedAt: string | null;
  errorCode: string | null;
}

function operationView(run: WorkflowRunRecord): OperationView {
  return { id: run.id, workflowId: run.id, applicationId: run.applicationId, action: run.workflowType, status: run.status, idempotencyKey: run.idempotencyKey, payloadHash: run.payloadHash, startedAt: run.startedAt, completedAt: run.completedAt, errorCode: run.errorCode };
}

/** Application summary for the dashboard; statuses come from the store row verbatim. */
interface ApplicationSummaryView {
  application: string;
  displayName: string;
  owners: string[];
  owner: string;
  sync: string;
  health: string;
  deployment: string | null;
  currentDeploymentCommit: string | null;
  productionUrl: string | null;
  latestHealthCheck: { result: string; checkedAt: string } | null;
  desiredGeneration: number;
  lifecycleState: string;
  sourcePath: string;
  updatedAt: string;
}

function applicationSummaryView(app: ApplicationRecord, knownGood: DeploymentRow | null, latestHealth: HealthCheckRecord | null): ApplicationSummaryView {
  return {
    application: app.id,
    displayName: app.displayName,
    owners: app.owners,
    owner: app.owners[0] ?? 'unassigned',
    sync: app.syncStatus,
    health: app.healthStatus,
    deployment: knownGood?.state ?? null,
    currentDeploymentCommit: knownGood?.commitSha ?? null,
    productionUrl: knownGood?.url ?? null,
    latestHealthCheck: latestHealth ? { result: latestHealth.result, checkedAt: latestHealth.checkedAt } : null,
    desiredGeneration: app.desiredGeneration,
    lifecycleState: app.lifecycleState,
    sourcePath: app.sourcePath,
    updatedAt: app.updatedAt,
  };
}

/** Redacted step error projection: only bounded, structurally redacted code/message strings ever leave the API. */
export function stepErrorView(error: unknown): { code: string | null; message: string | null } | null {
  if (error === null || error === undefined) return null;
  if (typeof error === 'string') return { code: null, message: redactText(error.slice(0, 500)) };
  if (typeof error === 'object' && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    const code = typeof record.code === 'string' ? redactText(record.code).slice(0, 100) : null;
    const message = typeof record.message === 'string' ? redactText(record.message).slice(0, 500) : null;
    if (code === null && message === null) return null;
    return { code, message };
  }
  return null;
}

function workflowStepView(step: WorkflowStepRecord): { stepId: string; status: string; attempt: number; preconditionHash: string; result: SafeOperationResult | null; error: { code: string | null; message: string | null } | null } {
  return { stepId: step.stepId, status: step.status, attempt: step.attempt, preconditionHash: step.preconditionHash, result: projectSafeOperationResult(step.result), error: stepErrorView(step.error) };
}

function healthCheckView(check: HealthCheckRecord): { environment: string; url: string; result: string; statusCode: number | null; latencyMs: number | null; checkedAt: string; errorCode: string | null } {
  return { environment: check.environment, url: check.url, result: check.result, statusCode: check.statusCode, latencyMs: check.latencyMs, checkedAt: check.checkedAt, errorCode: check.errorCode };
}

function driftEventView(event: DriftEventRecord): Record<string, unknown> {
  return { id: event.id, fingerprint: event.fingerprint, category: event.category, observedAt: event.observedAt, resolvedAt: event.resolvedAt, ...(typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload) ? event.payload : {}) };
}

function credentialMetadataView(credential: CredentialMetadataRecord): { id: string; provider: string; purpose: string; valueFingerprint: string | null; expiresAt: string | null; lastCheckedAt: string; status: string } {
  return { id: credential.id, provider: credential.provider, purpose: credential.purpose, valueFingerprint: credential.valueFingerprint, expiresAt: credential.expiresAt, lastCheckedAt: credential.lastCheckedAt, status: credential.status };
}

/** Appends an audit event with a caller-chosen deterministic id; replays never duplicate it. */
async function appendAuditOnce(store: LaunchpadStore, input: AuditAppend): Promise<void> {
  const id = input.id ?? stableId('audit', input.actor, input.action, input.applicationId ?? 'platform', crypto.randomUUID());
  const scope = input.applicationId ?? 'platform';
  const alreadyRecorded = (await store.listAudit(scope)).some((event) => event.id === id);
  if (alreadyRecorded) return;
  try {
    await store.appendAudit({ ...input, id });
  } catch {
    const raced = (await store.listAudit(scope)).some((event) => event.id === id);
    if (!raced) throw new Error('LP-AUDIT-APPEND-FAILED');
  }
}

/** The idempotency key a retry of `operationId` uses; deterministic so replays never duplicate the retry. */
function retryIdempotencyKey(operationId: string): string {
  return `retry:${operationId}`;
}

/**
 * Direct action: retry a failed durable operation by replaying the exact
 * claim-bound enqueue params recorded in its start audit event. The retry is
 * a NEW workflow run with a deterministic idempotency key, so replaying this
 * action returns the same retry run instead of duplicating work.
 */
async function runRetryAction(context: Context<AppEnv>, dependencies: ControllerDependencies, applicationId: string, body: Record<string, unknown>): Promise<Response> {
  const store = dependencies.store;
  if (!store) return errorResponse(context, 'LP-PERSISTENCE-CONFIG-MISSING', 'Durable persistence is not configured.', 503, false);
  const operationId = typeof body.operationId === 'string' && body.operationId.length > 0 ? body.operationId : null;
  if (!operationId) return errorResponse(context, 'LP-RETRY-OPERATION-ID-REQUIRED', 'Retry requires the failed operationId.', 400, false);
  const run = await store.getWorkflowRun(operationId);
  if (!run || run.applicationId !== applicationId) return errorResponse(context, 'LP-OPERATION-NOT-FOUND', 'The operation was not found.', 404, false);
  if (run.status !== 'FAILED' && run.status !== 'BLOCKED') return errorResponse(context, 'LP-RETRY-NOT-FAILED', `Only failed or blocked operations can be retried; this operation is ${run.status}.`, 409, false);
  const startEvent = (await store.listAudit(applicationId)).find((event) => event.action === 'OIDC_OPERATION_START' && typeof event.details === 'object' && event.details !== null && event.details.operationId === operationId);
  const details = startEvent && typeof startEvent.details === 'object' && startEvent.details !== null ? startEvent.details : null;
  const recordedParams = details === null ? null : details.params;
  const params = typeof recordedParams === 'object' && recordedParams !== null && !Array.isArray(recordedParams) ? (recordedParams as Record<string, unknown>) : null;
  if (!params) return errorResponse(context, 'LP-RETRY-PARAMS-UNAVAILABLE', 'The original enqueue params for this operation are not recorded; it cannot be replayed.', 409, false);
  // Fail closed on malformed records: the replay needs the exact claim-bound
  // sourceCommit for its identity hash — never a guessed value.
  const sourceCommit = typeof params.sourceCommit === 'string' && params.sourceCommit.length > 0 ? params.sourceCommit : null;
  if (sourceCommit === null) return errorResponse(context, 'LP-RETRY-PARAMS-MALFORMED', 'The recorded enqueue params are missing the sourceCommit needed to replay this operation; it cannot be replayed.', 409, false);
  const kind = run.workflowType;
  const bindingName = WORKFLOW_BINDING_BY_KIND[kind];
  const workflow = bindingName ? (context.env[bindingName] as WorkflowBinding | undefined) : undefined;
  if (!workflow) return errorResponse(context, 'LP-RETRY-KIND-NOT-RETRYABLE', `Operations of kind '${kind}' have no durable retry path.`, 409, false);
  const idempotencyKey = retryIdempotencyKey(operationId);
  const hashInput: WorkflowIdentityHashInput = { version: 1, kind, applicationId, sourceCommit };
  if (typeof params.desiredGeneration === 'number') hashInput.desiredGeneration = params.desiredGeneration;
  if (typeof params.planFingerprint === 'string') hashInput.planFingerprint = params.planFingerprint;
  const payloadHash = await workflowPayloadHash(hashInput);
  let retryRun: WorkflowRunRecord;
  try {
    retryRun = await store.startWorkflowRun({ applicationId, workflowType: kind, idempotencyKey, payloadHash });
    await store.registerIdempotentRequest({ idempotencyKey, operationId: retryRun.id, payloadHash });
  } catch (error) {
    return mapEnqueueError(context, error);
  }
  if (retryRun.status === 'FAILED' || retryRun.status === 'BLOCKED') return errorResponse(context, 'LP-RETRY-RETRY-NEEDS-FRESH-KEY', 'A previous retry of this operation failed; open a new retry with a fresh idempotencyKey to attempt it again.', 409, false);
  const workflowId = `lp-${kind}-${retryRun.id}`;
  let instance: { id: string };
  try {
    instance = await workflow.create({ id: workflowId, params: { ...params, operationId: retryRun.id, workflowId } });
  } catch {
    return errorResponse(context, 'LP-WORKFLOW-CREATE-FAILED', 'The retry workflow could not be started.', 503, true);
  }
  await appendAuditOnce(store, { id: stableId('audit', applicationId, 'OPERATOR_RETRY', operationId), actor: operatorPrincipal(context), action: 'OPERATOR_RETRY', applicationId, details: { operationId, retryOperationId: retryRun.id, kind, sourceCommit, workflowId: instance.id, idempotencyKey } });
  return context.json({ workflowId, operationId: retryRun.id, status: retryRun.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'QUEUED', retriedOperationId: operationId }, 202);
}

/**
 * Direct action: recheck production health. Runs through the durable
 * health-check handler when one is registered (synchronous, bounded, and
 * D1-persisted), otherwise enqueues a versioned HEALTH_CHECKS envelope.
 * Deterministic idempotency keys keep replays from spawning duplicate checks.
 */
async function runRecheckAction(context: Context<AppEnv>, dependencies: ControllerDependencies, applicationId: string, body: Record<string, unknown>): Promise<Response> {
  const store = dependencies.store;
  if (!store) return errorResponse(context, 'LP-PERSISTENCE-CONFIG-MISSING', 'Durable persistence is not configured.', 503, false);
  const handler = dependencies.workflowHandlers?.['health-check'];
  const queue = context.env.HEALTH_CHECKS as { send(message: unknown): Promise<void> } | undefined;
  if (!handler && !queue) return errorResponse(context, 'LP-WORKFLOW-BINDING-MISSING', 'No health-check handler or queue is configured for this controller.', 503, false);
  const sourceCommit = typeof body.sourceCommit === 'string' && body.sourceCommit.length > 0 ? body.sourceCommit : null;
  const declaredKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey.length > 0 ? body.idempotencyKey : context.req.header('idempotency-key');
  const idempotencyKey = declaredKey ?? stableId('recheck', applicationId, sourceCommit ?? 'latest');
  const existingRequest = await store.getIdempotentRequest(idempotencyKey);
  if (existingRequest) {
    // Replay of an already-issued recheck: report the recorded operation
    // without dispatching a duplicate check.
    const existingRun = await store.getWorkflowRun(existingRequest.operationId);
    return context.json({ workflowId: existingRequest.operationId, operationId: existingRequest.operationId, status: existingRun?.status ?? 'QUEUED', replay: true }, 202);
  }
  const payloadHash = await workflowPayloadHash({ version: 1, kind: 'health-check', applicationId, sourceCommit: sourceCommit ?? '' });
  let run: WorkflowRunRecord;
  try {
    run = await store.startWorkflowRun({ applicationId, workflowType: 'health-check', idempotencyKey, payloadHash });
    await store.registerIdempotentRequest({ idempotencyKey, operationId: run.id, payloadHash });
  } catch (error) {
    return mapEnqueueError(context, error);
  }
  if (run.status === 'FAILED') return errorResponse(context, 'LP-RECHECK-RETRY-NEEDS-FRESH-KEY', 'A previous recheck with this key failed; use a fresh idempotencyKey to run another.', 409, false);
  if (run.status !== 'QUEUED') return context.json({ workflowId: run.id, operationId: run.id, status: run.status }, 202);
  const payload = { applicationId, operationId: run.id, workflowId: run.id, ...(sourceCommit ? { sourceCommit } : {}) };
  let dispatched: 'handler' | 'queue';
  if (handler) {
    try {
      const result = await handler(payload);
      await persistInternalOutcome(dependencies, payload, 'SUCCEEDED', result, null);
    } catch (error) {
      const redacted = redactHandlerError(error);
      await persistInternalOutcome(dependencies, payload, 'FAILED', null, { code: redacted.code, message: redacted.message });
      return errorResponse(context, redacted.code, redacted.message, 500, redacted.retryable);
    }
    dispatched = 'handler';
  } else {
    const envelope = createQueueEnvelope({ kind: 'health-check', id: run.id, payload });
    try {
      await queue?.send(envelope);
    } catch {
      return errorResponse(context, 'LP-RECHECK-DISPATCH-FAILED', 'The health check could not be dispatched to the queue.', 503, true);
    }
    dispatched = 'queue';
  }
  await appendAuditOnce(store, { id: stableId('audit', applicationId, 'OPERATOR_RECHECK', idempotencyKey), actor: operatorPrincipal(context), action: 'OPERATOR_RECHECK', applicationId, details: { operationId: run.id, sourceCommit, idempotencyKey, dispatched } });
  const finalRun = await store.getWorkflowRun(run.id);
  return context.json({ workflowId: run.id, operationId: run.id, status: finalRun?.status ?? run.status, dispatched }, 202);
}

/**
 * Direct action: roll back the current production deployment to the recorded
 * known-good deployment. Executes the `rollback` workflow handler (the only
 * provider mutation a dashboard request may trigger) and persists the outcome
 * as a durable operation with deterministic idempotency. Replays of the same
 * request return the recorded result without touching the provider again.
 */
async function runRollbackAction(context: Context<AppEnv>, dependencies: ControllerDependencies, applicationId: string, body: Record<string, unknown>): Promise<Response> {
  const store = dependencies.store;
  if (!store) return errorResponse(context, 'LP-PERSISTENCE-CONFIG-MISSING', 'Durable persistence is not configured.', 503, false);
  const application = await store.getApplication(applicationId);
  if (!application) return errorResponse(context, 'LP-APPLICATION-NOT-FOUND', `No application '${applicationId}' is registered.`, 404, false);
  if (await store.isTombstoned(applicationId)) return errorResponse(context, 'LP-APPLICATION-TOMBSTONED', 'The application is tombstoned and cannot be operated on.', 409, false);
  const knownGood = await store.getKnownGoodDeployment(applicationId, 'production');
  if (!knownGood) return errorResponse(context, 'LP-ROLLBACK-NO-KNOWN-GOOD', 'No known-good production deployment is recorded; rollback is unavailable.', 409, false);
  const declared = typeof body.deploymentId === 'string' && body.deploymentId.length > 0 ? body.deploymentId : null;
  const failedDeploymentId = declared ?? (await store.listDeployments(applicationId, { environment: 'production', limit: 1 }))[0]?.id ?? null;
  if (!failedDeploymentId) return errorResponse(context, 'LP-ROLLBACK-NO-CURRENT-DEPLOYMENT', 'No current production deployment is recorded.', 409, false);
  if (failedDeploymentId === knownGood.id) return errorResponse(context, 'LP-ROLLBACK-ALREADY-KNOWN-GOOD', 'The current production deployment is already the known-good deployment.', 409, false);
  const failed = await store.getDeployment(failedDeploymentId);
  if (!failed || failed.applicationId !== applicationId || failed.environment !== 'production') return errorResponse(context, 'LP-DEPLOYMENT-NOT-FOUND', 'The deployment to roll back from was not found.', 404, false);
  const handler = dependencies.workflowHandlers?.['rollback'];
  if (!handler) return errorResponse(context, 'LP-ROLLBACK-HANDLER-UNAVAILABLE', 'The rollback handler is not configured; refusing a direct provider mutation.', 503, false);
  const declaredKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey.length > 0 ? body.idempotencyKey : context.req.header('idempotency-key');
  const idempotencyKey = declaredKey ?? stableId('rollback', applicationId, knownGood.id, failedDeploymentId);
  const payloadHash = await workflowPayloadHash({ version: 1, kind: 'rollback', applicationId, sourceCommit: failed.commitSha });
  let run: WorkflowRunRecord;
  try {
    run = await store.startWorkflowRun({ applicationId, workflowType: 'rollback', idempotencyKey, payloadHash });
    await store.registerIdempotentRequest({ idempotencyKey, operationId: run.id, payloadHash });
  } catch (error) {
    return mapEnqueueError(context, error);
  }
  if (run.status === 'SUCCEEDED') {
    const steps = await store.listWorkflowSteps(run.id);
    const execute = steps.find((step) => step.stepId === 'execute');
    return context.json({ workflowId: run.id, operationId: run.id, status: run.status, replayed: true, result: execute ? projectSafeOperationResult(execute.result) : null }, 200);
  }
  if (run.status === 'FAILED') return errorResponse(context, 'LP-ROLLBACK-RETRY-NEEDS-FRESH-KEY', 'A previous rollback with this key failed; use a fresh idempotencyKey to attempt it again.', 409, false);
  const payload = { applicationId, failedDeploymentId, knownGoodDeploymentId: knownGood.id, operationId: run.id, workflowId: run.id, sourceCommit: failed.commitSha };
  try {
    const result = await handler(payload);
    await persistInternalOutcome(dependencies, payload, 'SUCCEEDED', result, null);
  } catch (error) {
    const redacted = redactHandlerError(error);
    await persistInternalOutcome(dependencies, payload, 'FAILED', null, { code: redacted.code, message: redacted.message });
    return errorResponse(context, redacted.code, redacted.message, 500, redacted.retryable);
  }
  await appendAuditOnce(store, { id: stableId('audit', applicationId, 'OPERATOR_ROLLBACK', idempotencyKey), actor: operatorPrincipal(context), action: 'OPERATOR_ROLLBACK', applicationId, details: { operationId: run.id, failedDeploymentId, knownGoodDeploymentId: knownGood.id, sourceCommit: failed.commitSha, idempotencyKey } });
  const finalRun = await store.getWorkflowRun(run.id);
  return context.json({ workflowId: run.id, operationId: run.id, status: finalRun?.status ?? run.status, failedDeploymentId, knownGoodDeploymentId: knownGood.id }, 200);
}

/** The conflict response for a cancel of a run that is not QUEUED; `null` means the status is cancelable. */
function cancelStatusConflict(context: Context<AppEnv>, status: string): Response | null {
  if (status === 'RUNNING') return errorResponse(context, 'LP-CANCEL-RUNNING', 'The operation is RUNNING; canceling a running operation is not allowed.', 409, false);
  if (TERMINAL_WORKFLOW_STATUSES.includes(status as WorkflowStatus)) return errorResponse(context, 'LP-CANCEL-TERMINAL', `The operation already reached a terminal state (${status}) and cannot be canceled.`, 409, false);
  if (status !== 'QUEUED') return errorResponse(context, 'LP-CANCEL-NOT-QUEUED', `Only QUEUED operations can be canceled; this operation is ${status}.`, 409, false);
  return null;
}

/**
 * Direct action: cancel a QUEUED durable operation. The QUEUED -> CANCELED
 * transition and its immutable audit event are applied atomically by the
 * store; RUNNING, mid-machine, and terminal runs are refused with a conflict
 * and nothing is written. Requires the operationId and an idempotency key
 * (body field or `idempotency-key` header); replays of a successful cancel
 * return the recorded result without a second state change or audit event.
 */
async function runCancelAction(context: Context<AppEnv>, dependencies: ControllerDependencies, applicationId: string, body: Record<string, unknown>): Promise<Response> {
  const store = dependencies.store;
  if (!store) return errorResponse(context, 'LP-PERSISTENCE-CONFIG-MISSING', 'Durable persistence is not configured.', 503, false);
  const operationId = typeof body.operationId === 'string' && body.operationId.length > 0 ? body.operationId : null;
  if (!operationId) return errorResponse(context, 'LP-CANCEL-OPERATION-ID-REQUIRED', 'Cancel requires the operationId of the queued workflow run.', 400, false);
  const declaredKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey.length > 0 ? body.idempotencyKey : context.req.header('idempotency-key');
  if (!declaredKey) return errorResponse(context, 'LP-IDEMPOTENCY-KEY-REQUIRED', 'Cancel requires an idempotencyKey (body field or idempotency-key header).', 400, false);
  const run = await store.getWorkflowRun(operationId);
  if (!run) return errorResponse(context, 'LP-OPERATION-NOT-FOUND', 'The operation was not found.', 404, false);
  if (run.applicationId !== applicationId) return errorResponse(context, 'LP-CANCEL-OPERATION-FOREIGN', 'The operation belongs to a different application; refusing to cancel it.', 409, false);
  // Replay of an already-issued cancel: report the recorded operation
  // without a second state change or audit event.
  const existingRequest = await store.getIdempotentRequest(declaredKey);
  if (existingRequest) {
    if (existingRequest.operationId !== operationId) return errorResponse(context, 'LP-IDEMPOTENCY-CONFLICT', 'This idempotency key was already used with a different operation.', 409, false);
    const existingRun = await store.getWorkflowRun(existingRequest.operationId);
    return context.json({ workflowId: existingRequest.operationId, operationId: existingRequest.operationId, status: existingRun?.status ?? 'CANCELED', replay: true }, 200);
  }
  const statusConflict = cancelStatusConflict(context, run.status);
  if (statusConflict) return statusConflict;
  try {
    await store.cancelWorkflowRun({ id: operationId, actor: operatorPrincipal(context), idempotencyKey: declaredKey, auditId: stableId('audit', applicationId, 'OPERATOR_CANCEL', declaredKey), canceledAt: new Date().toISOString() });
    await store.registerIdempotentRequest({ idempotencyKey: declaredKey, operationId, payloadHash: run.payloadHash });
  } catch (error) {
    if (error instanceof LaunchpadError && error.platform.code === 'LP-DB-CANCEL-NOT-QUEUED') {
      // The run left QUEUED between the guard and the atomic transition
      // (e.g. the workflow consumer picked it up): fail closed, never cancel.
      const raced = await store.getWorkflowRun(operationId);
      const status = raced?.status ?? run.status;
      return cancelStatusConflict(context, status) ?? errorResponse(context, 'LP-CANCEL-NOT-QUEUED', `The operation is ${status}; only QUEUED operations can be canceled.`, 409, false);
    }
    if (error instanceof LaunchpadError && error.platform.code === 'LP-DB-IDEMPOTENCY-REUSED') return errorResponse(context, 'LP-IDEMPOTENCY-CONFLICT', 'This idempotency key was already used with a different payload.', 409, false);
    return mapEnqueueError(context, error);
  }
  return context.json({ workflowId: operationId, operationId, status: 'CANCELED', replay: false }, 200);
}

// --- PR-only config changes ------------------------------------------------

const CONFIG_CHANGE_KINDS = ['root', 'framework', 'domain', 'proxy', 'env', 'adopt', 'restore'] as const;
type ConfigChangeKind = (typeof CONFIG_CHANGE_KINDS)[number];

const ENVIRONMENT_NAMES = ['preview', 'staging', 'production'] as const;
type EnvironmentNameValue = (typeof ENVIRONMENT_NAMES)[number];

function isEnvironmentName(value: unknown): value is EnvironmentNameValue {
  return typeof value === 'string' && (ENVIRONMENT_NAMES as readonly string[]).includes(value);
}

const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const VARIABLE_NAME_PATTERN = /^[A-Z][A-Z0-9_]{1,127}$/;
const ZONE_REF_PATTERN = /^config:\/\/cloudflare\//;

function splitControlRepository(repository: string): { owner: string; name: string } | null {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository);
  if (!match || match[1] === undefined || match[2] === undefined) return null;
  return { owner: match[1], name: match[2] };
}

function encodePath(path: string): string {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function base64EncodeUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  return btoa(binary);
}

function base64DecodeUtf8(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

interface ControlFile {
  content: string;
  sha: string;
}

function githubHeaders(dependencies: ControllerDependencies): Record<string, string> {
  return { accept: 'application/vnd.github+json', authorization: `Bearer ${dependencies.githubToken ?? ''}`, 'user-agent': 'launchpad-control-plane', 'x-github-api-version': '2022-11-28' };
}

function retryableError(code: string, message: string): Error {
  return Object.assign(namedError(code, message), { retryable: true });
}

/** Reads one control-repository file at a ref through the controller's own GitHub credential. */
async function readControlFile(dependencies: ControllerDependencies, path: string, ref: string): Promise<ControlFile> {
  const parts = splitControlRepository(dependencies.controlRepository ?? '');
  if (!parts) throw namedError('LP-CONTROL-REPOSITORY-INVALID', 'The configured control repository is not owner/name.');
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${parts.owner}/${parts.name}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, { headers: githubHeaders(dependencies) });
  } catch {
    throw retryableError('LP-CONTROL-REPOSITORY-UNREACHABLE', 'The control repository could not be reached.');
  }
  if (response.status === 404) throw namedError('LP-CONTROL-MANIFEST-NOT-FOUND', `The control manifest ${path} does not exist on ${ref}.`);
  if (!response.ok) throw retryableError('LP-CONTROL-REPOSITORY-READ-FAILED', 'The control repository could not be read.');
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw namedError('LP-CONTROL-REPOSITORY-MALFORMED', 'The control repository returned a malformed response.');
  }
  if (typeof data !== 'object' || data === null) throw namedError('LP-CONTROL-REPOSITORY-MALFORMED', 'The control repository returned a malformed response.');
  const record = data as Record<string, unknown>;
  if (typeof record.content !== 'string' || record.encoding !== 'base64' || typeof record.sha !== 'string') throw namedError('LP-CONTROL-REPOSITORY-MALFORMED', 'The control repository returned a malformed file.');
  return { content: base64DecodeUtf8(record.content), sha: record.sha };
}

/**
 * Zone registry path inside the control repository: the registry lives
 * beside the application manifests (the parent of CONTROL_CATALOG_ROOT joined
 * with zones.yaml; default catalog/apps -> catalog/zones.yaml).
 */
export function zoneRegistryPathFor(catalogRoot: string | undefined): string {
  const segments = (catalogRoot ?? 'catalog/apps').replace(/\/$/, '').split('/');
  segments.pop();
  segments.push(ZONE_REGISTRY_FILE);
  return segments.join('/');
}

/**
 * Reads and parses the control-repository zone registry at a ref. Fails
 * closed on a missing (LP-ZONE-REGISTRY-MISSING) or malformed
 * (LP-ZONE-REGISTRY-INVALID) registry; both errors carry the registry path.
 */
async function readZoneRegistryFromControl(dependencies: ControllerDependencies, ref: string): Promise<string[]> {
  const path = zoneRegistryPathFor(dependencies.controlCatalogRoot);
  let file: ControlFile;
  try {
    file = await readControlFile(dependencies, path, ref);
  } catch (error) {
    const code = errorCodeOf(error) === 'LP-CONTROL-MANIFEST-NOT-FOUND' ? 'LP-ZONE-REGISTRY-MISSING' : 'LP-ZONE-REGISTRY-UNREADABLE';
    const detail = error instanceof Error ? error.message : 'The zone registry could not be read.';
    const failure = namedError(code, `The zone registry ${path} could not be read at ${ref}: ${detail}`);
    if (typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === true) Object.assign(failure, { retryable: true });
    throw failure;
  }
  const parsed = parseZoneRegistry(file.content, path);
  if (parsed.issues.length > 0) {
    const first = parsed.issues[0];
    throw namedError('LP-ZONE-REGISTRY-INVALID', `The zone registry ${path} is invalid (${first?.code ?? 'LP-ZONE-REGISTRY-INVALID'} at ${path}:${first?.line ?? 1}:${first?.column ?? 1}).`);
  }
  return parsed.zones;
}

/**
 * Opens (or reuses) a control-repository pull request carrying the given
 * files on a deterministic branch. Idempotent by construction: an existing
 * branch is updated in place and an open PR for the same head is reused.
 */
async function createControlPullRequest(dependencies: ControllerDependencies, input: { branch: string; title: string; body: string; files: Record<string, string> }): Promise<{ number: number; url: string }> {
  const parts = splitControlRepository(dependencies.controlRepository ?? '');
  if (!parts) throw namedError('LP-CONTROL-REPOSITORY-INVALID', 'The configured control repository is not owner/name.');
  const base = `https://api.github.com/repos/${parts.owner}/${parts.name}`;
  const call = async (path: string, init?: RequestInit): Promise<Response> => {
    try {
      return await fetch(`${base}${path}`, { ...init, headers: { ...githubHeaders(dependencies), ...(init?.body ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) } });
    } catch {
      throw retryableError('LP-CONTROL-REPOSITORY-UNREACHABLE', 'The control repository could not be reached.');
    }
  };
  const repository = await call('');
  if (!repository.ok) throw retryableError('LP-CONTROL-REPOSITORY-READ-FAILED', 'The control repository could not be read.');
  const repositoryData = await repository.json() as { default_branch?: unknown };
  const defaultBranch = typeof repositoryData.default_branch === 'string' && repositoryData.default_branch.length > 0 ? repositoryData.default_branch : 'main';
  const ref = await call(`/git/ref/heads/${encodeURIComponent(defaultBranch)}`);
  if (!ref.ok) throw retryableError('LP-CONTROL-REPOSITORY-READ-FAILED', 'The control repository default branch could not be read.');
  const refData = await ref.json() as { object?: { sha?: unknown } };
  const baseSha = refData.object && typeof refData.object.sha === 'string' ? refData.object.sha : null;
  if (!baseSha) throw namedError('LP-CONTROL-REPOSITORY-MALFORMED', 'The control repository returned a malformed branch ref.');
  const branchRef = await call('/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha: baseSha }) });
  if (!branchRef.ok && branchRef.status !== 422) throw retryableError('LP-CONTROL-PR-CREATE-FAILED', 'The control-repository branch could not be created.');
  for (const [path, content] of Object.entries(input.files)) {
    const existing = await call(`/contents/${encodePath(path)}?ref=${encodeURIComponent(input.branch)}`);
    let sha: string | undefined;
    if (existing.ok) {
      const existingData = await existing.json() as { sha?: unknown };
      if (typeof existingData.sha === 'string') sha = existingData.sha;
    } else if (existing.status !== 404) {
      throw retryableError('LP-CONTROL-PR-CREATE-FAILED', 'The control-repository file could not be read.');
    }
    const put = await call(`/contents/${encodePath(path)}`, { method: 'PUT', body: JSON.stringify({ message: `chore(launchpad): ${input.title}`, content: base64EncodeUtf8(content), branch: input.branch, ...(sha ? { sha } : {}) }) });
    if (!put.ok) throw retryableError('LP-CONTROL-PR-CREATE-FAILED', 'The control-repository file could not be updated.');
  }
  const open = await call(`/pulls?state=open&head=${encodeURIComponent(`${parts.owner}:${input.branch}`)}`);
  if (!open.ok) throw retryableError('LP-CONTROL-PR-CREATE-FAILED', 'The control-repository pull request could not be listed.');
  const openData = await open.json() as Array<{ number?: unknown; html_url?: unknown }>;
  if (Array.isArray(openData) && openData[0] && typeof openData[0].number === 'number' && typeof openData[0].html_url === 'string') {
    return { number: openData[0].number, url: openData[0].html_url };
  }
  const created = await call('/pulls', { method: 'POST', body: JSON.stringify({ title: input.title, body: input.body, head: input.branch, base: defaultBranch }) });
  if (!created.ok) throw retryableError('LP-CONTROL-PR-CREATE-FAILED', 'The control-repository pull request could not be opened.');
  const createdData = await created.json() as { number?: unknown; html_url?: unknown };
  if (typeof createdData.number !== 'number' || typeof createdData.html_url !== 'string') throw namedError('LP-CONTROL-REPOSITORY-MALFORMED', 'The control repository returned a malformed pull request.');
  return { number: createdData.number, url: createdData.html_url };
}

/** Validates the change-specific inputs and returns the canonical, safe params that fingerprint the change. */
function configChangeParams(change: ConfigChangeKind, body: Record<string, unknown>): { params: Record<string, unknown>; error: string | null } {
  const params: Record<string, unknown> = { change };
  switch (change) {
    case 'root': {
      const value = typeof body.value === 'string' && body.value.length > 0 ? body.value : null;
      if (!value) return { params, error: 'LP-CHANGE-VALUE-REQUIRED' };
      params.value = value;
      return { params, error: null };
    }
    case 'framework': {
      if (body.value !== null && typeof body.value !== 'string') return { params, error: 'LP-CHANGE-VALUE-INVALID' };
      params.value = body.value ?? null;
      return { params, error: null };
    }
    case 'domain': {
      const hostname = typeof body.hostname === 'string' ? body.hostname.trim() : '';
      if (!HOSTNAME_PATTERN.test(hostname)) return { params, error: 'LP-CHANGE-DOMAIN-HOSTNAME-INVALID' };
      const environment = isEnvironmentName(body.environment) ? body.environment : 'production';
      const remove = body.remove === true;
      params.hostname = hostname;
      params.environment = environment;
      params.remove = remove;
      if (!remove) {
        const zoneRef = typeof body.zoneRef === 'string' && ZONE_REF_PATTERN.test(body.zoneRef) ? body.zoneRef : null;
        if (!zoneRef) return { params, error: 'LP-CHANGE-DOMAIN-ZONEREF-REQUIRED' };
        const mode = body.mode === 'proxied' || body.mode === 'dns-only' ? body.mode : body.mode === undefined ? 'dns-only' : null;
        if (!mode) return { params, error: 'LP-CHANGE-DOMAIN-MODE-INVALID' };
        const ttl = body.ttl === 'auto' ? 'auto' : typeof body.ttl === 'number' && Number.isInteger(body.ttl) && body.ttl >= 60 ? body.ttl : 'auto';
        params.zoneRef = zoneRef;
        params.mode = mode;
        params.ttl = ttl;
        params.canonical = body.canonical === true;
      }
      return { params, error: null };
    }
    case 'proxy': {
      const hostname = typeof body.hostname === 'string' ? body.hostname.trim() : '';
      if (!HOSTNAME_PATTERN.test(hostname)) return { params, error: 'LP-CHANGE-PROXY-HOSTNAME-INVALID' };
      const value = body.value === 'proxied' || body.value === 'dns-only' ? body.value : null;
      if (!value) return { params, error: 'LP-CHANGE-PROXY-VALUE-INVALID' };
      params.hostname = hostname;
      params.value = value;
      return { params, error: null };
    }
    case 'env': {
      if (!isEnvironmentName(body.environment)) return { params, error: 'LP-CHANGE-ENV-ENVIRONMENT-INVALID' };
      const name = typeof body.name === 'string' ? body.name : '';
      if (!VARIABLE_NAME_PATTERN.test(name)) return { params, error: 'LP-CHANGE-ENV-NAME-INVALID' };
      const remove = body.remove === true;
      params.environment = body.environment;
      params.name = name;
      params.remove = remove;
      if (!remove) {
        const value = typeof body.value === 'string' ? body.value : null;
        const secretRef = typeof body.secretRef === 'string' && body.secretRef.length > 0 ? body.secretRef : null;
        if (value === null && secretRef === null) return { params, error: 'LP-CHANGE-ENV-VALUE-REQUIRED' };
        if (value !== null && secretRef !== null) return { params, error: 'LP-CHANGE-ENV-VALUE-AMBIGUOUS' };
        if (value !== null) params.value = value;
        else params.secretRef = secretRef;
      }
      return { params, error: null };
    }
    case 'adopt':
    case 'restore':
      return { params, error: null };
  }
}

/** Extracts the observed root directory from the latest persisted observation payload. */
function observedRootDirectory(observed: unknown): string | null {
  if (typeof observed !== 'object' || observed === null) return null;
  const resources = (observed as Record<string, unknown>).resources;
  if (!Array.isArray(resources)) return null;
  for (const resource of resources) {
    if (typeof resource !== 'object' || resource === null) continue;
    const record = resource as Record<string, unknown>;
    if (record.resourceType !== 'vercel.project' && record.resourceKey !== 'vercel.project') continue;
    const configuration = record.configuration;
    if (typeof configuration !== 'object' || configuration === null) return null;
    const rootDirectory = (configuration as Record<string, unknown>).rootDirectory;
    return typeof rootDirectory === 'string' && rootDirectory.length > 0 ? rootDirectory : null;
  }
  return null;
}

function restoreRequestYaml(applicationId: string, desiredGeneration: number, fingerprint: string): string {
  return `apiVersion: launchpad.dev/v1\nkind: ReconciliationRequest\nmetadata:\n  app: ${applicationId}\nspec:\n  desiredGeneration: ${desiredGeneration}\n  operation: restore-desired-state\n  driftFingerprint: ${fingerprint}\n`;
}

/**
 * Applies a config change as a control-repository PR — never as a direct
 * provider mutation. The changed manifest is validated with the same catalog
 * loader the workflows use before the PR is opened; the request is
 * fingerprinted so identical replays return the same PR.
 */
async function applyConfigChange(context: Context<AppEnv>, dependencies: ControllerDependencies, applicationId: string, change: ConfigChangeKind, body: Record<string, unknown>): Promise<Response> {
  const store = dependencies.store;
  if (!store) return errorResponse(context, 'LP-PERSISTENCE-CONFIG-MISSING', 'Durable persistence is not configured.', 503, false);
  if (!dependencies.githubToken) return errorResponse(context, 'LP-GITHUB-CONFIG-MISSING', 'Control-repository changes require the controller GitHub credential.', 503, false);
  if (!dependencies.controlRepository) return errorResponse(context, 'LP-CONTROL-REPOSITORY-CONFIG-MISSING', 'The control repository is not configured.', 503, false);
  const application = await store.getApplication(applicationId);
  if (!application) return errorResponse(context, 'LP-APPLICATION-NOT-FOUND', `No application '${applicationId}' is registered.`, 404, false);
  if (await store.isTombstoned(applicationId)) return errorResponse(context, 'LP-APPLICATION-TOMBSTONED', 'The application is tombstoned; its manifest cannot be changed.', 409, false);
  const { params, error } = configChangeParams(change, body);
  if (error) return errorResponse(context, error, 'The change request is missing required or contains invalid fields.', 400, false);
  const requestFingerprint = stableId('config-change', applicationId, change, canonicalJson(params));
  const branch = `launchpad/${change}/${applicationId}/${requestFingerprint.slice(0, 12)}`;
  // The deterministic audit id IS the idempotency record: replays of the same
  // change find the recorded event and return its PR without opening a new
  // one (GitHub-side branch/PR reuse covers the race window).
  const auditId = stableId('audit', applicationId, `CONFIG_CHANGE_${change.toUpperCase()}`, requestFingerprint);
  const existingEvent = (await store.listAudit(applicationId)).find((event) => event.id === auditId);
  if (existingEvent) {
    // Fail closed on malformed recorded details: a replay must reproduce the
    // exact recorded PR, never a partially-guessed one.
    const details = typeof existingEvent.details === 'object' && existingEvent.details !== null ? existingEvent.details : null;
    if (details === null || typeof details.pullRequestUrl !== 'string') {
      return errorResponse(context, 'LP-CHANGE-RECORD-MISSING', 'The change was recorded but its pull request cannot be recovered; open a new change request.', 409, false);
    }
    return context.json({ applicationId, change, replay: true, pullRequest: { url: details.pullRequestUrl, branch: typeof details.branch === 'string' ? details.branch : null, number: typeof details.pullRequestNumber === 'number' ? details.pullRequestNumber : null } });
  }
  const manifestPath = `${(dependencies.controlCatalogRoot ?? 'catalog/apps').replace(/\/$/, '')}/${applicationId}.yaml`;
  let manifest: ControlFile;
  try {
    manifest = await readControlFile(dependencies, manifestPath, 'main');
  } catch (error) {
    const code = errorCodeOf(error) ?? 'LP-CONTROL-MANIFEST-UNREADABLE';
    const message = error instanceof Error ? error.message : 'The control manifest could not be read.';
    return errorResponse(context, code, message, code === 'LP-CONTROL-MANIFEST-NOT-FOUND' ? 404 : 503, typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === true);
  }
  let zones: string[];
  try {
    zones = await readZoneRegistryFromControl(dependencies, 'main');
  } catch (error) {
    const code = errorCodeOf(error) ?? 'LP-ZONE-REGISTRY-UNREADABLE';
    const message = error instanceof Error ? error.message : 'The zone registry could not be read.';
    const status = code === 'LP-ZONE-REGISTRY-MISSING' ? 404 : code === 'LP-ZONE-REGISTRY-INVALID' ? 422 : 503;
    return errorResponse(context, code, message, status, typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === true);
  }
  const catalog = loadCatalog([{ path: manifestPath, content: manifest.content }], { zones });
  if (catalog.issues.length > 0) return errorResponse(context, 'LP-CONTROL-MANIFEST-INVALID', `The control manifest for ${applicationId} failed validation (${catalog.issues[0]?.code ?? 'unknown'}).`, 422, false);
  const desired = catalog.applications.find((candidate) => candidate.metadata.id === applicationId);
  if (!desired) return errorResponse(context, 'LP-CONTROL-APPLICATION-NOT_FOUND', `No catalog application '${applicationId}' exists.`, 404, false);

  const next = structuredClone(desired) as {
    sourcePath?: string;
    vercel: { project: { rootDirectory: string; framework: string | null } };
    domains: Array<{ hostname: string; environment: string; canonical?: boolean; redirects: string[]; cloudflare: { zoneRef: string; mode: string; ttl: unknown; proxy?: Record<string, unknown> } }>;
    environments: Partial<Record<EnvironmentNameValue, { variables?: Record<string, unknown> }>>;
  };
  delete next.sourcePath;

  const summary: string[] = [];
  let files: Record<string, string> | null = null;
  switch (change) {
    case 'root':
      next.vercel.project.rootDirectory = params.value as string;
      summary.push(`vercel.project.rootDirectory: ${JSON.stringify(params.value)}`);
      break;
    case 'framework':
      next.vercel.project.framework = params.value as string | null;
      summary.push(`vercel.project.framework: ${JSON.stringify(params.value)}`);
      break;
    case 'domain': {
      const hostname = params.hostname as string;
      if (params.remove === true) {
        const index = next.domains.findIndex((domain) => domain.hostname === hostname);
        if (index < 0) return errorResponse(context, 'LP-DOMAIN-NOT-FOUND', `No domain '${hostname}' is declared for ${applicationId}.`, 404, false);
        next.domains.splice(index, 1);
        summary.push(`domains: removed ${hostname}`);
      } else {
        if (next.domains.some((domain) => domain.hostname === hostname)) return errorResponse(context, 'LP-DOMAIN-EXISTS', `Domain '${hostname}' is already declared.`, 409, false);
        const proxyBlock = params.mode === 'proxied' ? { acknowledgeDoubleCdn: true, bypassWellKnownPaths: true, verifyConnectingIpHeader: false, cachePolicy: 'standard' } : undefined;
        next.domains.push({ hostname, environment: params.environment as string, ...(params.canonical === true ? { canonical: true } : {}), cloudflare: { zoneRef: params.zoneRef as string, mode: params.mode as string, ttl: params.ttl, ...(proxyBlock ? { proxy: proxyBlock } : {}) }, redirects: [] });
        summary.push(`domains: added ${hostname} (${params.environment as string}, ${params.mode as string})`);
      }
      break;
    }
    case 'proxy': {
      const hostname = params.hostname as string;
      const domain = next.domains.find((candidate) => candidate.hostname === hostname);
      if (!domain) return errorResponse(context, 'LP-DOMAIN-NOT-FOUND', `No domain '${hostname}' is declared for ${applicationId}.`, 404, false);
      domain.cloudflare.mode = params.value as string;
      if (params.value === 'proxied') domain.cloudflare.proxy = { acknowledgeDoubleCdn: true, bypassWellKnownPaths: true, verifyConnectingIpHeader: false, cachePolicy: 'standard' };
      else delete domain.cloudflare.proxy;
      summary.push(`domains.${hostname}.cloudflare.mode: ${params.value as string}`);
      break;
    }
    case 'env': {
      const environment = params.environment as EnvironmentNameValue;
      const environmentSpec = next.environments[environment];
      if (!environmentSpec) return errorResponse(context, 'LP-ENVIRONMENT-NOT-FOUND', `Environment '${environment}' is not declared for ${applicationId}.`, 404, false);
      const variables = { ...(environmentSpec.variables ?? {}) };
      const name = params.name as string;
      if (params.remove === true) {
        if (!(name in variables)) return errorResponse(context, 'LP-ENV-VARIABLE-NOT-FOUND', `Variable '${name}' is not declared for ${environment}.`, 404, false);
        delete variables[name];
        summary.push(`environments.${environment}.variables.${name}: removed`);
      } else if (typeof params.value === 'string') {
        variables[name] = params.value;
        summary.push(`environments.${environment}.variables.${name}: set value`);
      } else {
        variables[name] = { secretRef: params.secretRef as string, sensitive: true };
        summary.push(`environments.${environment}.variables.${name}: set secretRef ${params.secretRef as string}`);
      }
      environmentSpec.variables = variables;
      break;
    }
    case 'adopt': {
      const observations = await store.listObservations(applicationId, { limit: 1 });
      const observation = observations[0] ?? null;
      const observedRoot = observation && typeof observation.payload === 'object' && observation.payload !== null ? observedRootDirectory(observation.payload) : null;
      if (!observedRoot) return errorResponse(context, 'LP-ADOPT-NO-OBSERVATION', 'No usable observed state is recorded for this application; adopt is unavailable.', 409, false);
      next.vercel.project.rootDirectory = observedRoot;
      summary.push(`vercel.project.rootDirectory: adopt observed ${JSON.stringify(observedRoot)}`);
      break;
    }
    case 'restore':
      files = { [`reconciliation/${applicationId}.yaml`]: restoreRequestYaml(applicationId, application.desiredGeneration, requestFingerprint) };
      summary.push(`reconciliation/${applicationId}.yaml: restore-desired-state request`);
      break;
  }

  const title = change === 'restore' ? `launchpad: restore desired state for ${applicationId}` : `launchpad: ${change} change for ${applicationId}`;
  if (files === null) {
    // JSON round-trip breaks shared object references (the loader reuses one
    // default health object across environments); without it `yaml` emits
    // anchors/aliases, which the catalog loader rejects.
    const yamlContent = yamlStringify(JSON.parse(JSON.stringify(next)));
    const proposed = loadCatalog([{ path: manifestPath, content: yamlContent }], { zones });
    if (proposed.issues.length > 0) return errorResponse(context, 'LP-CHANGE-INVALID-MANIFEST', `The proposed change produces an invalid manifest (${proposed.issues[0]?.code ?? 'unknown'}).`, 422, false);
    files = { [manifestPath]: yamlContent };
  }
  const bodyText = `## Launchpad change request\n\nApplication: ${applicationId}\nChange: ${change}\nRequest fingerprint: ${requestFingerprint}\n\n${summary.map((line) => `- ${line}`).join('\n')}\n\nThis pull request updates the control repository only. No provider is mutated by this dashboard action; the change applies when the updated manifest is reviewed, merged, and reconciled.`;
  let pullRequest: { number: number; url: string };
  try {
    pullRequest = await createControlPullRequest(dependencies, { branch, title, body: bodyText, files });
  } catch (error) {
    const code = errorCodeOf(error) ?? 'LP-CONTROL-PR-CREATE-FAILED';
    const message = error instanceof Error ? error.message : 'The control-repository pull request could not be opened.';
    return errorResponse(context, code, message, 503, typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === true);
  }
  try {
    await appendAuditOnce(store, { id: auditId, actor: operatorPrincipal(context), action: `CONFIG_CHANGE_${change.toUpperCase()}`, applicationId, details: { change, requestFingerprint, branch, pullRequestNumber: pullRequest.number, pullRequestUrl: pullRequest.url, params } });
  } catch {
    return errorResponse(context, 'LP-CHANGE-RECORD-FAILED', 'The pull request was created but the change could not be durably recorded.', 500, true);
  }
  return context.json({ applicationId, change, replay: false, pullRequest: { number: pullRequest.number, url: pullRequest.url, branch } });
}

// ---------------------------------------------------------------------------
// Vercel webhook contract (master plan webhook section).
//
// A webhook payload is a trigger, never final state. The controller persists
// ONLY a sanitized projection (event id/type and non-secret provider resource
// identifiers), enqueues one sanitized versioned provider-event envelope, and
// the durable queue consumer triggers provider-backed reconciliation. Raw
// bodies never reach D1, the queue, audits, logs, or errors.
// ---------------------------------------------------------------------------

/** Sanitized provider-event projection; never the raw webhook body. */
export type SanitizedProviderEvent = {
  eventId: string;
  type: string;
  projectId?: string;
  deploymentId?: string;
  teamId?: string;
};

function objectField(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Accepts only bounded non-empty string identifiers; everything else is dropped. */
function identifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : undefined;
}

/**
 * Extracts only the event id/type and non-secret provider resource
 * identifiers from a verified Vercel webhook body. Accepts both the
 * event-payload shape (`payload.deploymentId`) and the nested-object shape
 * (`project.id` / `deployment.id` / `team.id`). Values are bounded strings;
 * nested objects, URLs, tokens, and unknown fields are never carried.
 */
export function sanitizeVercelWebhookEvent(payload: Record<string, unknown>, eventId: string, eventType: string): SanitizedProviderEvent {
  const event: SanitizedProviderEvent = { eventId, type: eventType };
  const vercelPayload = objectField(payload.payload);
  const candidates: Array<[keyof SanitizedProviderEvent, unknown]> = [
    ['projectId', objectField(payload.project)?.id],
    ['projectId', vercelPayload?.projectId],
    ['projectId', payload.projectId],
    ['deploymentId', objectField(payload.deployment)?.id],
    ['deploymentId', vercelPayload?.deploymentId],
    ['deploymentId', payload.deploymentId],
    ['teamId', objectField(payload.team)?.id],
    ['teamId', vercelPayload?.teamId],
    ['teamId', payload.teamId],
  ];
  for (const [key, value] of candidates) {
    const id = identifier(value);
    if (id !== undefined && event[key] === undefined) event[key] = id;
  }
  return event;
}

/**
 * Parses the WEBHOOK_MAX_AGE_SECONDS freshness window (default 300 seconds).
 * An invalid configured value fails closed (throws) so a deployment mistake
 * cannot silently widen the window.
 */
export function parseWebhookMaxAgeSeconds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 300;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error('LP-WEBHOOK-MAX-AGE-INVALID');
  return parsed;
}

/**
 * The Vercel webhook event timestamp, in seconds. The raw (HMAC-covered)
 * payload carries a top-level `createdAt` epoch-milliseconds field, which is
 * the only usable creation timestamp the route receives (the sanitized
 * projection intentionally drops it). Returns null when the field is absent
 * or not a positive finite number; the caller fails closed on null because
 * the freshness gate cannot be enforced without a timestamp.
 */
export function webhookEventTimestampSeconds(payload: Record<string, unknown>): number | null {
  const createdAt = payload.createdAt;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) return null;
  return createdAt / 1000;
}

/** Clock-skew allowance for webhook timestamps: events "from the future" beyond this are rejected. */
const WEBHOOK_FUTURE_SKEW_SECONDS = 60;

/**
 * Enqueues one sanitized provider-event envelope to PROVIDER_EVENTS and marks
 * the durable receipt as dispatched (first writer wins). The 202 contract is
 * only reachable after the receipt row is durably readable AND the envelope
 * is sent AND the dispatch marker is durably recorded: a replay with a
 * missing marker heals the send, a replay with a marker never sends twice.
 */
async function enqueueProviderEvent(context: Context<AppEnv>, dependencies: ControllerDependencies, event: SanitizedProviderEvent): Promise<void> {
  const queue = context.env.PROVIDER_EVENTS;
  if (!queue) throw new Error('LP-WEBHOOK-QUEUE-CONFIG-MISSING');
  const store = dependencies.store;
  if (!store) throw new Error('LP-WEBHOOK-STORE-CONFIG-MISSING');
  const envelope = createQueueEnvelope<ProviderEventPayload>({ kind: 'provider-event', id: `webhook:vercel:${event.eventId}`, payload: event });
  await queue.send(envelope);
  const marked = await store.markWebhookReceiptDispatched('vercel', event.eventId);
  if (!marked) throw new Error('LP-WEBHOOK-RECEIPT-MARK-DISPATCH-FAILED');
}

export function createControllerApp(dependencies: ControllerDependencies): Hono<AppEnv> {
  const repositories = dependencies.repositories ?? new LaunchpadRepositories(new InMemoryDatabase());
  const resolveDashboardAsset = async (context: Context<AppEnv>): Promise<Response | null> => {
    const configured = dependencies.dashboardAssets;
    if (configured !== undefined) {
      const assets = typeof configured === 'function' ? await configured() : configured;
      return dashboardAssetResponse(context.req.path, assets);
    }
    const binding = context.env?.ASSETS;
    return binding === undefined ? null : dashboardAssetBindingResponse(context.req.url, binding);
  };
  const app = new Hono<AppEnv>();
  app.get('/healthz', (context) => context.json({ status: 'ok', service: 'launchpad-control-plane' }));
  app.get('/', async (context) => {
    try {
      const response = await resolveDashboardAsset(context);
      return response ?? errorResponse(context, 'LP-DASHBOARD-UNAVAILABLE', 'Dashboard assets are unavailable.', 503, false);
    } catch {
      return errorResponse(context, 'LP-DASHBOARD-UNAVAILABLE', 'Dashboard assets are unavailable.', 503, false);
    }
  });

  // Operator-authenticated dashboard reads and mutations (master plan 21.2).
  // Every read derives from D1 through the LaunchpadStore; statuses are
  // serialized verbatim (provider read failures surface as UNKNOWN/BLOCKED,
  // never as HEALTHY/SYNCED). List queries are bounded and truncation is
  // reported truthfully.
  app.get('/v1/applications', operatorMiddleware(dependencies), async (context) => {
    if (!dependencies.store) return errorResponse(context, 'LP-PERSISTENCE-CONFIG-MISSING', 'Durable persistence is not configured.', 503, false);
    const limit = parseListLimit(context.req.query('limit'), DASHBOARD_CATALOG_MAX_LIMIT, DASHBOARD_CATALOG_MAX_LIMIT);
    if (limit === null) return errorResponse(context, 'LP-QUERY-LIMIT-INVALID', 'limit must be a positive integer.', 400, false);
    const { rows, truncated } = await boundedRows((n) => dependencies.store!.listApplications().then((all) => all.slice(0, n)), limit);
    return context.json({ applications: rows, limit, truncated });
  });
  app.get('/v1/applications/:id', operatorMiddleware(dependencies), async (context) => {
    if (!dependencies.store) return errorResponse(context, 'LP-PERSISTENCE-CONFIG-MISSING', 'Durable persistence is not configured.', 503, false);
    const applicationId = context.req.param('id');
    const detail = await dependencies.store.getApplicationDetail(applicationId);
    if (!detail.application) return errorResponse(context, 'LP-APPLICATION-NOT-FOUND', `No application '${applicationId}' is registered.`, 404, false);
    const seen = new Set<string>();
    const operations = [...detail.openWorkflowRuns, ...detail.recentWorkflowRuns].filter((run) => (seen.has(run.id) ? false : (seen.add(run.id), true))).sort(byStartedAscending).map(operationView);
    return context.json({ application: applicationSummaryView(detail.application, detail.knownGoodDeployment, detail.latestHealthCheck), operations, knownGoodDeployment: detail.knownGoodDeployment, latestHealthCheck: detail.latestHealthCheck ? healthCheckView(detail.latestHealthCheck) : null });
  });
  app.get('/v1/applications/:id/resources', operatorMiddleware(dependencies), async (context) => {
    if (!dependencies.store) return errorResponse(context, 'LP-PERSISTENCE-CONFIG-MISSING', 'Durable persistence is not configured.', 503, false);
    const applicationId = context.req.param('id');
    const limit = parseListLimit(context.req.query('limit'), DASHBOARD_DEFAULT_LIMIT, DASHBOARD_MAX_LIMIT);
    if (limit === null) return errorResponse(context, 'LP-QUERY-LIMIT-INVALID', 'limit must be a positive integer.', 400, false);
    const observations = await dependencies.store.listObservations(applicationId, { limit: 1 });
    const observedPayload = observations[0] && typeof observations[0].payload === 'object' && observations[0].payload !== null ? observations[0].payload : null;
    const observedResources = observedPayload && Array.isArray(observedPayload.resources) ? observedPayload.resources : [];
    const { rows, truncated } = await boundedRows((n) => dependencies.store!.listResources(applicationId, { includeReleased: false }).then((all) => all.slice(0, n)), limit);
    const resources = rows.map((resource) => {
      const observed = observedResources.find((candidate) => candidate.providerResourceId === resource.providerResourceId) ?? null;
      return { provider: resource.provider, resourceType: resource.resourceType, providerResourceId: resource.providerResourceId, resourceKey: resource.resourceKey, configuration: observed && typeof observed.configuration === 'object' && observed.configuration !== null ? observed.configuration : {}, ownershipFingerprint: resource.ownershipFingerprint, status: resource.status, desiredGeneration: resource.desiredGeneration, observedAt: resource.lastSeenAt };
    });
    return context.json({ applicationId, resources, limit, truncated });
  });
  app.get('/v1/applications/:id/plan', operatorMiddleware(dependencies), async (context) => {
    if (!dependencies.store) return errorResponse(context, 'LP-PERSISTENCE-CONFIG-MISSING', 'Durable persistence is not configured.', 503, false);
    const applicationId = context.req.param('id');
    const limit = parseListLimit(context.req.query('limit'), DASHBOARD_DEFAULT_LIMIT, DASHBOARD_MAX_LIMIT);
    if (limit === null) return errorResponse(context, 'LP-QUERY-LIMIT-INVALID', 'limit must be a positive integer.', 400, false);
    const { rows, truncated } = await boundedRows((n) => dependencies.store!.listPlans(applicationId, { limit: n }), limit);
    const plans: Array<Record<string, unknown>> = [];
    for (const plan of rows) {
      const operations = await dependencies.store.listPlanOperations(plan.id);
      plans.push({ id: plan.id, fingerprint: plan.fingerprint, sourceCommit: plan.sourceCommit, result: plan.result, createdAt: plan.createdAt, operationCount: operations.length, operations: operations.slice(0, 25).map((operation) => ({ id: operation.id, resourceKey: operation.resourceKey, action: operation.action, destructive: operation.destructive })) });
    }
    return context.json({ applicationId, plans, limit, truncated });
  });
  app.get('/v1/applications/:id/operations', operatorMiddleware(dependencies), async (context) => {
    if (!dependencies.store) return errorResponse(context, 'LP-PERSISTENCE-CONFIG-MISSING', 'Durable persistence is not configured.', 503, false);
    const applicationId = context.req.param('id');
    const limit = parseListLimit(context.req.query('limit'), DASHBOARD_DEFAULT_LIMIT, DASHBOARD_MAX_LIMIT);
    if (limit === null) return errorResponse(context, 'LP-QUERY-LIMIT-INVALID', 'limit must be a positive integer.', 400, false);
    const { rows, truncated } = await boundedRows((n) => dependencies.store!.listWorkflowRuns(applicationId, { limit: n }), limit);
    return context.json({ applicationId, operations: rows.sort(byStartedAscending).map(operationView), limit, truncated });
  });
  app.get('/v1/applications/:id/operations/:operationId', operatorMiddleware(dependencies), async (context) => {
    if (!dependencies.store) return errorResponse(context, 'LP-PERSISTENCE-CONFIG-MISSING', 'Durable persistence is not configured.', 503, false);
    const applicationId = context.req.param('id');
    const operationId = context.req.param('operationId');
    const run = await dependencies.store.getWorkflowRun(operationId);
    if (!run || run.applicationId !== applicationId) return errorResponse(context, 'LP-OPERATION-NOT-FOUND', 'The operation was not found.', 404, false);
    const steps = (await dependencies.store.listWorkflowSteps(operationId)).map(workflowStepView);
    return context.json({ applicationId, operation: operationView(run), steps });
  });
  app.get('/v1/applications/:id/deployments', operatorMiddleware(dependencies), async (context) => {
    if (!dependencies.store) return errorResponse(context, 'LP-PERSISTENCE-CONFIG-MISSING', 'Durable persistence is not configured.', 503, false);
    const applicationId = context.req.param('id');
    const limit = parseListLimit(context.req.query('limit'), DASHBOARD_DEFAULT_LIMIT, DASHBOARD_MAX_LIMIT);
    if (limit === null) return errorResponse(context, 'LP-QUERY-LIMIT-INVALID', 'limit must be a positive integer.', 400, false);
    const { rows, truncated } = await boundedRows((n) => dependencies.store!.listDeployments(applicationId, { limit: n }), limit);
    return context.json({ applicationId, deployments: rows.map((deployment) => ({ id: deployment.id, environment: deployment.environment, commitSha: deployment.commitSha, state: deployment.state, url: deployment.url, createdAt: deployment.createdAt })), limit, truncated });
  });
  app.get('/v1/applications/:id/health', operatorMiddleware(dependencies), async (context) => {
    if (!dependencies.store) return errorResponse(context, 'LP-PERSISTENCE-CONFIG-MISSING', 'Durable persistence is not configured.', 503, false);
    const applicationId = context.req.param('id');
    const limit = parseListLimit(context.req.query('limit'), DASHBOARD_DEFAULT_LIMIT, DASHBOARD_MAX_LIMIT);
    if (limit === null) return errorResponse(context, 'LP-QUERY-LIMIT-INVALID', 'limit must be a positive integer.', 400, false);
    const { rows, truncated } = await boundedRows((n) => dependencies.store!.listHealthChecks(applicationId, { limit: n }), limit);
    return context.json({ applicationId, checks: rows.map(healthCheckView), limit, truncated });
  });
  app.get('/v1/applications/:id/drift', operatorMiddleware(dependencies), async (context) => {
    if (!dependencies.store) return errorResponse(context, 'LP-PERSISTENCE-CONFIG-MISSING', 'Durable persistence is not configured.', 503, false);
    const applicationId = context.req.param('id');
    const limit = parseListLimit(context.req.query('limit'), DASHBOARD_DEFAULT_LIMIT, DASHBOARD_MAX_LIMIT);
    if (limit === null) return errorResponse(context, 'LP-QUERY-LIMIT-INVALID', 'limit must be a positive integer.', 400, false);
    const { rows, truncated } = await boundedRows((n) => dependencies.store!.listDriftEvents(applicationId, { includeResolved: true, limit: n }), limit);
    return context.json({ applicationId, drift: rows.map(driftEventView), limit, truncated });
  });
  app.get('/v1/applications/:id/audit', operatorMiddleware(dependencies), async (context) => {
    if (!dependencies.store) return errorResponse(context, 'LP-PERSISTENCE-CONFIG-MISSING', 'Durable persistence is not configured.', 503, false);
    const applicationId = context.req.param('id');
    const limit = parseListLimit(context.req.query('limit'), DASHBOARD_DEFAULT_LIMIT, DASHBOARD_MAX_LIMIT);
    if (limit === null) return errorResponse(context, 'LP-QUERY-LIMIT-INVALID', 'limit must be a positive integer.', 400, false);
    const { rows, truncated } = await boundedRows((n) => dependencies.store!.listAudit(applicationId, { limit: n }), limit);
    return context.json({ applicationId, events: rows, limit, truncated });
  });
  app.get('/v1/credentials', operatorMiddleware(dependencies), async (context) => {
    if (!dependencies.store) return errorResponse(context, 'LP-PERSISTENCE-CONFIG-MISSING', 'Durable persistence is not configured.', 503, false);
    const limit = parseListLimit(context.req.query('limit'), DASHBOARD_DEFAULT_LIMIT, DASHBOARD_MAX_LIMIT);
    if (limit === null) return errorResponse(context, 'LP-QUERY-LIMIT-INVALID', 'limit must be a positive integer.', 400, false);
    const { rows, truncated } = await boundedRows((n) => dependencies.store!.listCredentialsMetadata().then((all) => all.slice(0, n)), limit);
    return context.json({ credentials: rows.map(credentialMetadataView), limit, truncated });
  });
  app.post('/v1/applications/:id/changes/propose', operatorMiddleware(dependencies), async (context) => {
    const body = await readJsonObject(context);
    const operation = repositories.startOperation({ applicationId: context.req.param('id'), workflowId: crypto.randomUUID(), action: 'PROPOSE_CHANGE', idempotencyKey: context.req.header('idempotency-key') ?? crypto.randomUUID(), payloadHash: typeof body?.payloadHash === 'string' ? body.payloadHash : 'propose-change' });
    repositories.appendAudit({ actor: operatorPrincipal(context), action: 'PROPOSE_CHANGE', applicationId: context.req.param('id'), details: { operationId: operation.id } });
    return context.json({ workflowId: operation.id, status: operation.status }, 202);
  });
  app.post('/v1/applications/:id/actions/retry', operatorMiddleware(dependencies), async (context) => {
    const body = await readJsonObject(context);
    if (!body) return errorResponse(context, 'LP-REQUEST-BODY-INVALID', 'The request body must be a JSON object.', 400, false);
    return runRetryAction(context, dependencies, context.req.param('id'), body);
  });
  app.post('/v1/applications/:id/actions/recheck', operatorMiddleware(dependencies), async (context) => {
    const body = await readJsonObject(context);
    if (!body) return errorResponse(context, 'LP-REQUEST-BODY-INVALID', 'The request body must be a JSON object.', 400, false);
    return runRecheckAction(context, dependencies, context.req.param('id'), body);
  });
  app.post('/v1/applications/:id/actions/rollback', operatorMiddleware(dependencies), async (context) => {
    const body = await readJsonObject(context);
    if (!body) return errorResponse(context, 'LP-REQUEST-BODY-INVALID', 'The request body must be a JSON object.', 400, false);
    return runRollbackAction(context, dependencies, context.req.param('id'), body);
  });
  app.post('/v1/applications/:id/actions/cancel', operatorMiddleware(dependencies), async (context) => {
    const body = await readJsonObject(context);
    if (!body) return errorResponse(context, 'LP-REQUEST-BODY-INVALID', 'The request body must be a JSON object.', 400, false);
    return runCancelAction(context, dependencies, context.req.param('id'), body);
  });

  // Config changes are PR-only: each route opens a control-repository pull
  // request carrying the manifest (or reconciliation-request) change and
  // returns its URL. No provider is mutated from a dashboard request.
  for (const change of CONFIG_CHANGE_KINDS) {
    app.post(`/v1/applications/:id/changes/${change}`, operatorMiddleware(dependencies), async (context) => {
      const body = await readJsonObject(context);
      if (!body) return errorResponse(context, 'LP-REQUEST-BODY-INVALID', 'The request body must be a JSON object.', 400, false);
      return applyConfigChange(context, dependencies, context.req.param('id'), change, body);
    });
  }

  // Operator-triggered manual reconciliation dispatches one durable
  // RECONCILE_WORKFLOW instance per application. GitHub-scheduled callers
  // declare automatic=true and are gated by the deployed runtime flag.
  app.post('/v1/cli/reconcile', operatorMiddleware(dependencies), async (context) => {
    const body = await readJsonObject(context);
    const automatic = body?.automatic === true;
    if (automatic && context.env.LAUNCHPAD_CONTROL_PLANE_ENABLED !== 'true') {
      return errorResponse(context, 'LP-CONTROL-PLANE-DISABLED', 'Automatic reconciliation is disabled until the deployed control-plane runtime gate is exactly true.', 409, false);
    }
    const applicationIds = Array.isArray(body?.applicationIds) ? body.applicationIds.filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0) : [];
    if (applicationIds.length === 0) return errorResponse(context, 'LP-RECONCILE-APPLICATION-IDS-REQUIRED', 'applicationIds must be a non-empty array of application ids.', 400, false);
    const sourceCommit = typeof body?.sourceCommit === 'string' && /^[0-9a-f]{40}$/.test(body.sourceCommit) ? body.sourceCommit : undefined;
    const workflow = context.env.RECONCILE_WORKFLOW as WorkflowBinding | undefined;
    if (!workflow) return errorResponse(context, 'LP-WORKFLOW-BINDING-MISSING', 'No workflow binding is configured for reconciliation.', 503, false);
    const dispatcher = createReconciliationWorkflowDispatcher(workflow);
    const now = new Date();
    const instanceIds: string[] = [];
    for (const applicationId of applicationIds) {
      const envelope = createReconciliationEnvelope({ applicationId, shard: 0, shardCount: 1, now, ...(sourceCommit !== undefined ? { sourceCommit } : {}) });
      const instance = await dispatcher.dispatch(envelope);
      instanceIds.push(instance.instanceId);
    }
    await dependencies.store?.appendAudit({ actor: automatic ? 'automation:github-actions' : operatorPrincipal(context), action: 'RECONCILE_REQUESTED', applicationId: 'platform', details: { applicationIds, sourceCommit: sourceCommit ?? null, instanceIds, automatic } });
    return context.json({ status: 'QUEUED', instanceIds, applicationIds }, 202);
  });

  // Reviewed lifecycle actions (master plan 19). Every config change goes
  // through a control-repository PR; the destroy is the only path that
  // mutates providers, and it requires a single-use approval token.
  const callHandler = async (context: Context<AppEnv>, kind: string, body: Record<string, unknown>): Promise<Response> => {
    const handler = dependencies.workflowHandlers?.[kind];
    if (!handler) return errorResponse(context, 'LP-DECOMMISSION-HANDLER-UNAVAILABLE', `The ${kind} handler is unavailable.`, 503, false);
    try {
      return context.json(await handler({ applicationId: context.req.param('id'), ...body }));
    } catch (error) {
      return context.json(workflowErrorEnvelope(error, correlationId(context)), statusForWorkflowError(error));
    }
  };

  // First deletion PR: decommissioning lifecycle + impact report (promotion
  // stops, service stays, cooling-off begins).
  app.post('/v1/applications/:id/decommission', operatorMiddleware(dependencies), async (context) => {
    const body = await readJsonObject(context);
    if (!body) return errorResponse(context, 'LP-REQUEST-BODY-INVALID', 'The request body must be a JSON object.', 400, false);
    return callHandler(context, 'decommission/plan', body);
  });

  // Issues a single-use deletion approval; the plaintext token is returned
  // exactly once and only its SHA-256 fingerprint is persisted.
  app.post('/v1/applications/:id/decommission/approval', operatorMiddleware(dependencies), async (context) => {
    const body = await readJsonObject(context);
    if (!body) return errorResponse(context, 'LP-REQUEST-BODY-INVALID', 'The request body must be a JSON object.', 400, false);
    return callHandler(context, 'decommission/approval', body);
  });

  // Reviewed recovery PR: decommissioning -> active before deletion approval.
  app.post('/v1/applications/:id/decommission/reactivate', operatorMiddleware(dependencies), async (context) => {
    const body = await readJsonObject(context);
    if (!body) return errorResponse(context, 'LP-REQUEST-BODY-INVALID', 'The request body must be a JSON object.', 400, false);
    return callHandler(context, 'decommission/reactivate', body);
  });

  // Final destroy: enqueues the durable DecommissionApplicationWorkflow,
  // which revalidates the approved manifest, consumes the single-use token,
  // checks dependents/locks, and runs the ordered teardown. The plaintext
  // token is carried only in the ephemeral workflow payload and is never
  // written to D1, audit, or logs.
  app.post('/v1/applications/:id/delete', operatorMiddleware(dependencies), async (context) => {
    const applicationId = context.req.param('id');
    const body = await readJsonObject(context);
    if (!body) return errorResponse(context, 'LP-REQUEST-BODY-INVALID', 'The request body must be a JSON object.', 400, false);
    const store = dependencies.store;
    if (!store) return errorResponse(context, 'LP-PERSISTENCE-CONFIG-MISSING', 'Durable persistence is not configured; refusing to enqueue.', 503, false);
    const approvalId = typeof body.approvalId === 'string' && body.approvalId.length > 0 ? body.approvalId : null;
    const approvalToken = typeof body.approvalToken === 'string' && body.approvalToken.length > 0 ? body.approvalToken : null;
    const sourceCommit = typeof body.sourceCommit === 'string' && body.sourceCommit.length > 0 ? body.sourceCommit : null;
    const domain = typeof body.domain === 'string' && body.domain.length > 0 ? body.domain : null;
    const actor = typeof body.actor === 'string' && body.actor.length > 0 ? body.actor : 'dashboard';
    if (!approvalId) return errorResponse(context, 'LP-DELETE-APPROVAL-ID-REQUIRED', 'Deletion requires the approvalId returned at approval issuance.', 400, false);
    if (!approvalToken) return errorResponse(context, 'LP-DELETE-TOKEN-REQUIRED', 'Deletion requires the single-use approval token.', 400, false);
    if (sourceCommit === null || !/^[0-9a-f]{40}$/.test(sourceCommit)) return errorResponse(context, 'LP-DELETE-COMMIT-INVALID', 'Deletion requires the 40-hex approved sourceCommit.', 400, false);
    if (!domain) return errorResponse(context, 'LP-DELETE-DOMAIN-REQUIRED', 'Deletion requires the approved production domain.', 400, false);
    const idempotencyKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey.length > 0 ? body.idempotencyKey : `delete:${applicationId}:${approvalId}:${sourceCommit}`;
    const bindingName = WORKFLOW_BINDING_BY_KIND.decommission;
    const workflow = bindingName ? (context.env[bindingName] as WorkflowBinding | undefined) : undefined;
    if (!workflow) return errorResponse(context, 'LP-WORKFLOW-BINDING-MISSING', `No workflow binding is configured for 'decommission'.`, 503, false);
    const payloadHash = await workflowPayloadHash({ version: 1, kind: 'decommission', applicationId, sourceCommit });
    let run: WorkflowRunRecord;
    try {
      await ensureApplicationRegistered(store, applicationId, dependencies.controlCatalogRoot);
      run = await store.startWorkflowRun({ applicationId, workflowType: 'decommission', idempotencyKey, payloadHash });
      await store.registerIdempotentRequest({ idempotencyKey, operationId: run.id, payloadHash });
    } catch (error) {
      return mapEnqueueError(context, error);
    }
    const workflowId = `lp-decommission-${run.id}`;
    let instance: { id: string };
    try {
      instance = await workflow.create({ id: workflowId, params: { version: 1, kind: 'decommission', applicationId, idempotencyKey, operationId: run.id, workflowId, approvalId, approvalToken, sourceCommit, domain, actor, now: new Date().toISOString() } });
    } catch {
      return errorResponse(context, 'LP-WORKFLOW-CREATE-FAILED', 'The durable workflow could not be started.', 503, true);
    }
    const auditId = stableId('audit', applicationId, 'DELETE_REQUESTED', run.id);
    if (!(await store.listAudit(applicationId)).some((event) => event.id === auditId)) {
      try {
        await store.appendAudit({ id: auditId, actor: operatorPrincipal(context), action: 'DELETE_REQUESTED', applicationId, details: { operationId: run.id, workflowId: instance.id, approvalId, sourceCommit, domain } });
      } catch {
        // Idempotent retry; the token is never written to audit details.
      }
    }
    return context.json({ workflowId: instance.id, operationId: run.id, status: 'QUEUED' }, 202);
  });

  // Reviewed tombstone override path (TR-LIFE-006): releases a tombstone once
  // retention elapses or review evidence is supplied, so a deleted app ID or
  // domain can be registered again.
  app.post('/v1/applications/:id/tombstone/release', operatorMiddleware(dependencies), async (context) => {
    const applicationId = context.req.param('id');
    const body = await readJsonObject(context);
    if (!body) return errorResponse(context, 'LP-REQUEST-BODY-INVALID', 'The request body must be a JSON object.', 400, false);
    const store = dependencies.store;
    if (!store) return errorResponse(context, 'LP-PERSISTENCE-CONFIG-MISSING', 'Durable persistence is not configured.', 503, false);
    const domain = typeof body.domain === 'string' && body.domain.length > 0 ? body.domain : null;
    if (!domain) return errorResponse(context, 'LP-TOMBSTONE-RELEASE-DOMAIN-REQUIRED', 'Tombstone release requires the application domain.', 400, false);
    const rawOverride = typeof body.override === 'object' && body.override !== null ? body.override as Record<string, unknown> : null;
    const override = rawOverride === null
      ? null
      : {
          reviewedBy: typeof rawOverride.reviewedBy === 'string' ? rawOverride.reviewedBy : '',
          reviewedAt: typeof rawOverride.reviewedAt === 'string' ? rawOverride.reviewedAt : '',
          reason: typeof rawOverride.reason === 'string' ? rawOverride.reason : '',
          ...(typeof rawOverride.evidenceUrl === 'string' && rawOverride.evidenceUrl.length > 0 ? { evidenceUrl: rawOverride.evidenceUrl } : {}),
        };
    const verdict = await assertTombstoneReuseAllowed({ store, applicationId, domain, now: new Date().toISOString(), override });
    if (!verdict.allowed) return context.json({ applicationId, domain, allowed: false, code: verdict.code, message: verdict.message, retainUntil: verdict.retainUntil }, 409);
    try {
      await store.appendAudit({ actor: operatorPrincipal(context), action: 'TOMBSTONE_RELEASED', applicationId, details: { domain, ...(override ?? {}) } });
    } catch {
      // Idempotent retry-safe; the release itself already succeeded.
    }
    return context.json({ applicationId, domain, allowed: true, released: verdict.released, retainUntil: verdict.retainUntil });
  });

  // Operator CLI command dispatch (gzg.9). Only commands with a dedicated
  // safe implementation are whitelisted; every other command fails closed
  // with a typed error instead of faking a durable enqueue (the previous
  // generic stub answered 202 for ANY command while doing nothing durable —
  // e.g. the CLI `destroy` command silently reported success without ever
  // running the reviewed destroy lifecycle). `/v1/cli/reconcile` is a real
  // route registered above, so it never reaches this fallback. Commands are
  // deliberately added one at a time together with their operator-identity
  // audit and durable operation recording; destructive commands must use the
  // reviewed lifecycle routes (/v1/applications/:id/delete, runbook
  // docs/runbooks/deletion.md).
  const CLI_COMMAND_WHITELIST: ReadonlySet<string> = new Set([]);
  app.post('/v1/cli/:command', operatorMiddleware(dependencies), async (context) => {
    const command = context.req.param('command');
    if (!CLI_COMMAND_WHITELIST.has(command)) {
      return errorResponse(context, 'LP-CLI-COMMAND-UNSUPPORTED', `The CLI command '${command}' has no dedicated controller implementation. Use the documented dashboard or lifecycle routes.`, 404, false);
    }
    return errorResponse(context, 'LP-CLI-COMMAND-UNSUPPORTED', `The CLI command '${command}' is not implemented.`, 404, false);
  });

  // Failure observability surfaces (operator-authenticated): incidents and
  // metric snapshots (credential metadata is served by /v1/credentials in the
  // dashboard section above). Read models return only persisted safe data —
  // never secret values or raw provider bodies.
  app.get('/v1/incidents', operatorMiddleware(dependencies), async (context) => {
    const store = dependencies.store;
    const openOnly = context.req.query('open') === '1';
    const type = context.req.query('type');
    const incidents = store
      ? await store.listIncidents({ limit: 100, openOnly, ...((ALERT_TYPES as readonly string[]).includes(type ?? '') ? { type: type as AlertIncidentType } : {}) })
      : repositories.listIncidents();
    return context.json({ incidents });
  });
  app.get('/v1/incidents/:id', operatorMiddleware(dependencies), async (context) => {
    const store = dependencies.store;
    const incident = store ? (await store.listIncidents({ limit: 1000 })).find((candidate) => candidate.id === context.req.param('id')) ?? null : repositories.listIncidents().find((candidate) => candidate.id === context.req.param('id')) ?? null;
    if (!incident) return errorResponse(context, 'LP-INCIDENT-NOT-FOUND', 'The incident was not found.', 404, false);
    return context.json({ incident });
  });
  app.post('/v1/incidents/:id/resolve', operatorMiddleware(dependencies), async (context) => {
    const store = dependencies.store;
    if (!store) return errorResponse(context, 'LP-PERSISTENCE-CONFIG-MISSING', 'Durable persistence is not configured.', 503, false);
    try {
      const incident = await store.resolveIncident(context.req.param('id'));
      await store.appendAudit({ actor: operatorPrincipal(context), action: 'INCIDENT_RESOLVED', applicationId: incident.applicationId, details: { incidentId: incident.id, type: incident.type, fingerprint: incident.fingerprint } });
      return context.json({ incident });
    } catch {
      return errorResponse(context, 'LP-INCIDENT-NOT-FOUND', 'The incident was not found.', 404, false);
    }
  });
  app.get('/v1/metrics', operatorMiddleware(dependencies), async (context) => {
    const store = dependencies.store;
    const metric = context.req.query('metric');
    return context.json({ snapshots: store ? await store.listMetricSnapshots({ limit: 200, ...(metric && metric.length > 0 ? { metric } : {}) }) : [] });
  });

  // Workflow-authenticated synchronous evidence endpoint (reusable preview gate).
  // Registered before the operator routes: OIDC-only, never the operator token.
  app.post('/v1/applications/:id/preview/status', async (context) => {
    const correlationId = context.req.header('x-correlation-id') ?? crypto.randomUUID();
    if (!dependencies.oidc) return context.json(workflowErrorEnvelope(new Error('LP-OIDC-NOT-CONFIGURED'), correlationId), 503);
    let claims: GithubOidcClaims;
    try {
      claims = await verifyGithubOidc(bearer(context.req.raw), dependencies.oidc);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'OIDC verification failed';
      return context.json(workflowErrorEnvelope(namedError('LP-OIDC-INVALID', message), correlationId), 401);
    }
    let body: Record<string, unknown>;
    try {
      body = await context.req.json<Record<string, unknown>>();
    } catch {
      return context.json(workflowErrorEnvelope(new Error('LP-PAYLOAD-INVALID-JSON'), correlationId), 400);
    }
    const applicationId = context.req.param('id');
    const invalid = validateAppPreviewStatusPayload(body, applicationId);
    if (invalid) return context.json(workflowErrorEnvelope(invalid, correlationId), 400);
    try {
      bindOidcBody(claims, body);
    } catch (error) {
      return context.json(workflowErrorEnvelope(error instanceof Error ? error : new Error('LP-OIDC-CLAIM-MISMATCH'), correlationId), 403);
    }
    const handler = dependencies.workflowHandlers?.['app-preview-status'];
    if (!handler) return context.json(workflowErrorEnvelope(new Error('LP-PREVIEW-STATUS-HANDLER-UNAVAILABLE'), correlationId), 503);
    try {
      return context.json(await handler({ ...body, applicationId, correlationId }), 200);
    } catch (error) {
      return context.json(workflowErrorEnvelope(error, correlationId), statusForWorkflowError(error));
    }
  });

  // Reviewed-plan attestation (plan-approval gate): validates the OIDC token,
  // binds the declared identity claims, verifies the submitted sourceCommit
  // is the current PR head server-side, and persists the automated review
  // attestation idempotently (one row per application and source-commit-
  // neutral review fingerprint) before returning success. Never enqueues a
  // workflow: the attestation is the durable review evidence a merged apply
  // requires for the exact desired state.
  app.post('/v1/plans/verify', oidcMiddleware(dependencies), async (context) => {
    const body = await readJsonObject(context);
    if (!body) return errorResponse(context, 'LP-REQUEST-BODY-INVALID', 'The request body must be a JSON object.', 400, false);
    return verifyReviewedPlan(context, dependencies, body);
  });
  app.post('/v1/applications/:id/preview/verify', oidcMiddleware(dependencies), async (context) => {
    const body = await readJsonObject(context);
    if (!body) return errorResponse(context, 'LP-REQUEST-BODY-INVALID', 'The request body must be a JSON object.', 400, false);
    // Catalog previews carry the loaded DesiredApplication and run the
    // shadow-preview machine; app-repository status payloads (no desired
    // block) run the dedicated AppPreviewStatusWorkflow machine instead.
    const kind = typeof body.desired === 'object' && body.desired !== null ? 'preview' : 'app-preview-status';
    return enqueueOidcOperation(context, dependencies, { kind, applicationIdFromRoute: context.req.param('id'), body });
  });
  app.post('/v1/applications/:id/health/run', oidcMiddleware(dependencies), async (context) => {
    const body = await readJsonObject(context);
    if (!body) return errorResponse(context, 'LP-REQUEST-BODY-INVALID', 'The request body must be a JSON object.', 400, false);
    return enqueueOidcOperation(context, dependencies, { kind: 'app-preview-status', applicationIdFromRoute: context.req.param('id'), body });
  });
  app.post('/v1/applications/:id/apply', oidcMiddleware(dependencies), async (context) => {
    if (context.env.LAUNCHPAD_CONTROL_PLANE_ENABLED !== 'true') {
      return errorResponse(context, 'LP-CONTROL-PLANE-DISABLED', 'Automatic apply is disabled until the deployed control-plane runtime gate is exactly true.', 409, false);
    }
    const body = await readJsonObject(context);
    if (!body) return errorResponse(context, 'LP-REQUEST-BODY-INVALID', 'The request body must be a JSON object.', 400, false);
    if (typeof body.planFingerprint !== 'string' || body.planFingerprint.length === 0) return errorResponse(context, 'LP-PLAN-FINGERPRINT-REQUIRED', 'Apply requires a planFingerprint bound to the exact source commit.', 400, false);
    if (typeof body.desiredGeneration !== 'number' || !Number.isInteger(body.desiredGeneration) || body.desiredGeneration < 1) return errorResponse(context, 'LP-DESIRED-GENERATION-REQUIRED', 'Apply requires a positive integer desiredGeneration.', 400, false);
    return enqueueOidcOperation(context, dependencies, { kind: 'apply', applicationIdFromRoute: context.req.param('id'), body });
  });

  // Claim-scoped operation polling for Actions OIDC callers (no operator token in PR jobs).
  app.get('/v1/operations/:operationId', oidcMiddleware(dependencies), async (context) => {
    const store = dependencies.store;
    if (!store) return errorResponse(context, 'LP-PERSISTENCE-CONFIG-MISSING', 'Durable persistence is not configured.', 503, false);
    const claims = context.get('oidcClaims');
    const operationId = context.req.param('operationId');
    const run = await store.getWorkflowRun(operationId);
    if (!run) return errorResponse(context, 'LP-OPERATION-NOT-FOUND', 'The operation was not found.', 404, false);
    const startEvent = (await store.listAudit(run.applicationId)).find((event) => event.action === 'OIDC_OPERATION_START' && typeof event.details === 'object' && event.details !== null && event.details.operationId === operationId);
    if (!startEvent) return errorResponse(context, 'LP-OIDC-OPERATION-NOT-BOUND', 'The operation is not bound to an OIDC-authenticated workflow.', 403, false);
    // Structurally narrow the persisted audit details before binding any
    // identity field: malformed records fail closed as unbound, never with
    // guessed claim values.
    const details = typeof startEvent.details === 'object' && startEvent.details !== null ? startEvent.details : null;
    if (details === null) return errorResponse(context, 'LP-OIDC-OPERATION-NOT-BOUND', 'The operation is not bound to an OIDC-authenticated workflow.', 403, false);
    const repositoryId = details.repositoryId;
    const repository = details.repository;
    const ownerId = details.ownerId;
    const eventName = details.event;
    const prNumber = details.prNumber;
    const actor = details.actor;
    if (repositoryId === undefined || repository === undefined || ownerId === undefined || claims.repository_id !== String(repositoryId) || claims.repository !== repository || claims.repository_owner_id !== String(ownerId)) {
      return errorResponse(context, 'LP-OIDC-OPERATION-NOT-BOUND', 'The OIDC token is not bound to this operation.', 403, false);
    }
    if (actor !== undefined && claims.actor !== actor) return errorResponse(context, 'LP-OIDC-OPERATION-NOT-BOUND', 'The OIDC token is not bound to this operation.', 403, false);
    if (eventName === 'pull_request') {
      if (claims.event_name !== 'pull_request' || prNumber === undefined || pullRequestNumberFromClaims(claims) !== String(prNumber)) return errorResponse(context, 'LP-OIDC-OPERATION-NOT-BOUND', 'The OIDC token is not bound to this operation.', 403, false);
    } else {
      const sourceCommit = details.sourceCommit;
      if (typeof sourceCommit !== 'string' || claims.sha !== sourceCommit) return errorResponse(context, 'LP-OIDC-OPERATION-NOT-BOUND', 'The OIDC token is not bound to this operation.', 403, false);
    }
    const steps = await store.listWorkflowSteps(operationId);
    const executeStep = steps.length === 1 ? steps[0] : undefined;
    const status = (TERMINAL_WORKFLOW_STATUSES as readonly string[]).includes(run.status)
      ? run.status
      : run.status === 'QUEUED' && executeStep?.stepId === 'execute'
        ? (executeStep.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED')
        : run.status;
    const execute = steps.find((step) => step.stepId === 'execute' && step.status === 'SUCCEEDED');
    // Granular preview machines persist per-stage steps rather than a single
    // execute step; project the deployment/health evidence from those stages.
    const waited = steps.find((step) => step.stepId === 'wait-for-build' && step.status === 'SUCCEEDED');
    const healthStep = steps.find((step) => step.stepId === 'health-check' && step.status === 'SUCCEEDED');
    const waitedResult = waited !== undefined && waited.result !== null && typeof waited.result === 'object' ? waited.result as Record<string, unknown> : null;
    const deployment = waitedResult !== null && typeof waitedResult.deployment === 'object' && waitedResult.deployment !== null ? waitedResult.deployment : null;
    const health = healthStep?.result ?? null;
    const result = execute !== undefined
      ? projectSafeOperationResult(execute.result)
      : deployment !== null || health !== null
        ? projectSafeOperationResult({ deployment, health })
        : null;
    return context.json({
      operationId,
      workflowId: typeof details.workflowId === 'string' ? details.workflowId : operationId,
      applicationId: run.applicationId,
      kind: run.workflowType,
      status,
      errorCode: run.errorCode,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      sourceCommit: typeof details.sourceCommit === 'string' ? details.sourceCommit : null,
      result,
    });
  });

  // Internal workflow phase dispatch (CONTROLLER_INTERNAL_TOKEN only).
  // The presented header is compared in constant time (auth/timing.ts).
  const internalMiddleware = (): MiddlewareHandler<AppEnv> => async (context, next) => {
    const expected = dependencies.internalWorkflowToken;
    const presented = context.req.header('x-launchpad-workflow-token');
    const unauthorized = () => errorResponse(context, 'LP-WORKFLOW-AUTH-REQUIRED', 'Workflow authentication is required.', 401, false);
    if (typeof expected !== 'string' || typeof presented !== 'string') return unauthorized();
    if (!timingSafeEqual(expected, presented)) return unauthorized();
    await next();
  };
  app.post('/internal/workflows/:kind', internalMiddleware(), (context) => dispatchInternal(context, dependencies, null));
  app.post('/internal/workflows/:kind/:phase', internalMiddleware(), (context) => dispatchInternal(context, dependencies, context.req.param('phase')));

  app.post('/webhooks/vercel', async (context) => {
    const body = await context.req.text();
    if (!(await verifyWebhookSignature(body, context.req.header('x-vercel-signature') ?? null, dependencies.webhookSecret))) {
      dependencies.logger?.warn('webhook signature invalid', { provider: 'vercel', step: 'webhook/vercel', errorCode: 'LP-WEBHOOK-SIGNATURE-INVALID' });
      return errorResponse(context, 'LP-WEBHOOK-SIGNATURE-INVALID', 'Invalid webhook signature.', 401, false);
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return errorResponse(context, 'LP-WEBHOOK-PAYLOAD-INVALID', 'The webhook payload must be JSON.', 400, false);
    }
    // Bounded freshness window (gzg.5): the HMAC-covered payload carries the
    // event creation time as top-level `createdAt` (epoch milliseconds).
    // Replays of ancient deliveries, and payloads with impossible future
    // timestamps, are rejected before any receipt/envelope/audit state is
    // written. A missing/unusable timestamp fails closed because the gate
    // cannot be enforced. `sanitizeVercelWebhookEvent` intentionally does not
    // carry `createdAt` forward, so this check is the only place the raw
    // timestamp is consumed.
    let maxAgeSeconds: number;
    try {
      maxAgeSeconds = parseWebhookMaxAgeSeconds((context.env as ControllerEnv['Bindings'] | undefined)?.WEBHOOK_MAX_AGE_SECONDS);
    } catch {
      return errorResponse(context, 'LP-WEBHOOK-MAX-AGE-INVALID', 'WEBHOOK_MAX_AGE_SECONDS must be a non-negative integer of seconds.', 503, false);
    }
    const eventTimestampSeconds = webhookEventTimestampSeconds(payload);
    if (eventTimestampSeconds === null) return errorResponse(context, 'LP-WEBHOOK-TIMESTAMP-MISSING', 'The webhook payload must declare a numeric createdAt timestamp.', 400, false);
    const nowSeconds = Date.now() / 1000;
    if (eventTimestampSeconds > nowSeconds + WEBHOOK_FUTURE_SKEW_SECONDS) {
      dependencies.logger?.warn('webhook timestamp in the future', { provider: 'vercel', step: 'webhook/vercel', errorCode: 'LP-WEBHOOK-TIMESTAMP-FUTURE' });
      return errorResponse(context, 'LP-WEBHOOK-TIMESTAMP-FUTURE', 'The webhook event timestamp is impossibly far in the future.', 400, false);
    }
    if (nowSeconds - eventTimestampSeconds > maxAgeSeconds) {
      dependencies.logger?.warn('webhook event outside the freshness window', { provider: 'vercel', step: 'webhook/vercel', errorCode: 'LP-WEBHOOK-EVENT-STALE', eventAgeSeconds: Math.floor(nowSeconds - eventTimestampSeconds), maxAgeSeconds });
      return errorResponse(context, 'LP-WEBHOOK-EVENT-STALE', 'The webhook event is older than the configured freshness window.', 401, false);
    }
    const store = dependencies.store;
    if (!store) return errorResponse(context, 'LP-PERSISTENCE-CONFIG-MISSING', 'Durable persistence is not configured; refusing to accept webhooks.', 503, false);
    const eventId = typeof payload.id === 'string' && payload.id.length > 0 ? payload.id : null;
    if (!eventId) return errorResponse(context, 'LP-WEBHOOK-EVENT-ID-MISSING', 'The webhook payload must declare an id.', 400, false);
    const eventType = typeof payload.type === 'string' && payload.type.length > 0 ? payload.type.slice(0, 64) : 'deployment';
    const sanitized = sanitizeVercelWebhookEvent(payload, eventId, eventType);
    try {
      const { inserted, receipt } = await store.persistWebhookReceipt({ provider: 'vercel', eventId, payload: sanitized });
      // Follow-up state read: acknowledge only after the receipt row is durably
      // readable, so a replay of this event always deduplicates against it.
      const followUp = await store.getWebhookReceipt('vercel', eventId);
      if (!followUp || followUp.receivedAt !== receipt.receivedAt) throw new Error('LP-WEBHOOK-RECEIPT-READBACK-FAILED');
      // Send exactly once: first delivery enqueues; a replay enqueues again
      // only when the previous send never completed (no dispatch marker), and
      // never when the marker proves the envelope was already sent.
      if (inserted || followUp.dispatchedAt === null) {
        await enqueueProviderEvent(context, dependencies, sanitized);
      }
      await store.appendAudit({ actor: 'webhook:vercel', action: inserted ? 'WEBHOOK_RECEIVED' : 'WEBHOOK_DEDUPLICATED', applicationId: null, details: { eventId, type: eventType } });
      dependencies.metrics?.increment('successes', { workflow: 'webhook' });
      dependencies.logger?.info(inserted ? 'webhook received' : 'webhook deduplicated', { provider: 'vercel', step: 'webhook/vercel', applicationId: null, correlationId: context.req.header('x-correlation-id') ?? null });
      return context.json({ accepted: true, deduplicated: !inserted, receivedAt: receipt.receivedAt }, 202);
    } catch (error) {
      dependencies.metrics?.increment('failures', { workflow: 'webhook' });
      if (dependencies.observability) {
        await recordPermanentFailure(dependencies.observability, { error, kind: 'webhook', applicationId: null, provider: 'platform', step: 'webhook/vercel', correlationId: context.req.header('x-correlation-id') ?? null });
      } else {
        dependencies.logger?.error('webhook receipt persistence failed', { provider: 'vercel', step: 'webhook/vercel', errorCode: 'LP-WEBHOOK-PERSIST-FAILED', retryable: true });
      }
      return errorResponse(context, 'LP-WEBHOOK-PERSIST-FAILED', 'The webhook receipt could not be durably recorded and dispatched; retry the delivery.', 503, true);
    }
  });
  app.onError((error, context) => {
    dependencies.logger?.error('controller internal error', { correlationId: context.req.header('x-correlation-id') ?? null, errorCode: error instanceof Error && error.name !== 'Error' ? error.name : 'LP-CONTROLLER-INTERNAL-ERROR', message: error instanceof Error ? error.message : 'Unknown controller error.', retryable: true });
    dependencies.metrics?.increment('failures', { workflow: 'other' });
    return errorResponse(context, 'LP-INTERNAL-ERROR', 'An internal error occurred.', 500, true);
  });
  app.notFound(async (context) => {
    try {
      const response = await resolveDashboardAsset(context);
      if (response !== null) return response;
    } catch {
      // Asset loading failed — fall through to a JSON 404.
    }
    return errorResponse(context, 'LP-NOT-FOUND', 'Not found.', 404, false);
  });
  return app;
}
