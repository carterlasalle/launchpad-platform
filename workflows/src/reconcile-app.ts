import { accessDesired, buildPlan, redactEnvironmentSpec, secretBindingFingerprint, variableFingerprint, type DesiredApplication, type DriftRecord, type EnvironmentName, type ObservedApplication, type ObservedResource, type PlatformPlan, type ProviderCapabilities } from '@launchpad/core';
import { loadCatalog } from '@launchpad/catalog';
import type { LaunchpadStore, ReconciliationMode, SyncStatus } from '@launchpad/database';
import { canonicalJson, idempotencyKey, sha256Hex, stableId } from '@launchpad/shared';
import { ProviderRequestError, type DnsProvider, type ProjectProvider, type ProviderContext, type SourceProvider } from '@launchpad/provider-contract';
import { DurableOperationRunner, errorCodeOf, type DurableStep, type OperationRunResult, type StepOutcome } from './operation-runner.js';
import { WorkflowFailure } from './apply-app.js';
import { satisfiedProjection } from '@launchpad/core';
import { stringify } from 'yaml';

export type { DriftRecord } from '@launchpad/core';

/**
 * Granular reconciliation workflow (master plan sections 18 and 22.3). One
 * durable step per phase, all persisted through the D1 `LaunchpadStore`:
 *
 *   resolve-main -> load-desired -> observe-live-state -> diff-plan
 *     -> persist-status -> open-or-update-pr -> report
 *
 * Git remains the desired-state source: the workflow reads the catalog
 * manifest at the latest protected control-repository main commit, compares
 * it against live GitHub/Vercel/Cloudflare observations through the full
 * planner (desired + observed + capabilities + ownership), persists status
 * and drift events, and opens or updates exactly one reconciliation PR per
 * application and stable drift fingerprint. Access and read failures are
 * represented as UNKNOWN or BLOCKED — never SYNCED — and reconciliation
 * never mutates providers or destroys resources.
 */

export const RECONCILE_VERSION = 1 as const;
export const RECONCILE_KIND = 'reconcile' as const;

export type ReconcileMode = 'open-pr' | 'restore-desired-state' | 'adopt-observed-state';

export type ReconcileSyncStatus = 'SYNCED' | 'OUT_OF_SYNC' | 'BLOCKED' | 'UNKNOWN';

/** Safe, typed provider/source access failure; never carries provider bodies or secrets. */
export interface AccessError { provider: string; code: string; message: string; }

export interface ManifestError { code: string; kind: 'access' | 'missing' | 'invalid'; message: string; }

export interface ReconcileBase {
  version: typeof RECONCILE_VERSION;
  kind: typeof RECONCILE_KIND;
  applicationId: string;
  /** Payload-provided exact control-repo main SHA, or null for scheduled cron triggers (resolved by the workflow). */
  sourceCommit: string | null;
  mode: ReconcileMode;
  shard: number;
  shardCount: number;
  triggeredAt: string;
  workflowId: string;
  idempotencyKey: string;
  payloadHash: string;
}

/** The payload-hash formula shared with scheduled/manual dispatch (cron has no sourceCommit; it is resolved inside the workflow). */
export async function reconcilePayloadHash(input: { applicationId: string; mode: ReconcileMode; shard: number; shardCount: number; triggeredAt: string }): Promise<string> {
  return sha256Hex(canonicalJson({ version: RECONCILE_VERSION, kind: RECONCILE_KIND, applicationId: input.applicationId, mode: input.mode, shard: input.shard, shardCount: input.shardCount, triggeredAt: input.triggeredAt }));
}

export async function makeReconcileBase(input: { applicationId: string; sourceCommit: string | null; mode: ReconcileMode; shard: number; shardCount: number; triggeredAt: string; workflowId: string; idempotencyKey: string }): Promise<ReconcileBase> {
  return {
    version: RECONCILE_VERSION,
    kind: RECONCILE_KIND,
    applicationId: input.applicationId,
    sourceCommit: input.sourceCommit,
    mode: input.mode,
    shard: input.shard,
    shardCount: input.shardCount,
    triggeredAt: input.triggeredAt,
    workflowId: input.workflowId,
    idempotencyKey: input.idempotencyKey,
    payloadHash: await reconcilePayloadHash(input),
  };
}

export interface ReconcileRuntime { store: LaunchpadStore; provider: ProjectProvider & DnsProvider; }

export type ReconcilePhaseName =
  | 'resolve-main' | 'load-desired' | 'observe-live-state' | 'diff-plan'
  | 'persist-status' | 'open-or-update-pr' | 'report';

export const RECONCILE_PHASES: readonly ReconcilePhaseName[] = [
  'resolve-main', 'load-desired', 'observe-live-state', 'diff-plan',
  'persist-status', 'open-or-update-pr', 'report',
];

// ---------------------------------------------------------------------------
// Phase results (all JSON-serializable; never carry raw secret values)
// ---------------------------------------------------------------------------

export interface ResolveMainResult { sourceCommit: string | null; source: 'payload' | 'ref' | null; error: { code: string; message: string } | null; }
export interface ReconcileLoadDesiredResult { desired: DesiredApplication | null; rawManifest: string | null; manifestError: ManifestError | null; }
export interface ReconcileObserveLiveStateResult { observed: ObservedApplication | null; capabilities: ProviderCapabilities | null; accessErrors: AccessError[]; baselinedKeys: string[]; }
export interface DiffPlanResult {
  status: ReconcileSyncStatus;
  plan: PlatformPlan | null;
  drift: DriftRecord[];
  driftFingerprint: string | null;
  blockedReason: string | null;
  accessErrors: AccessError[];
}
export interface PersistStatusResult { status: SyncStatus; observationId: string | null; planId: string | null; driftEventId: string | null; resolvedDriftEvents: number; resolvedRequests: number; }
export interface OpenOrUpdatePrResult {
  pullRequest: { number: number; url: string } | null;
  reconciliationRequestId: string | null;
  branch: string | null;
  operation: ReconciliationMode | null;
  manifest: string | null;
  skipped: boolean;
}
export interface ReconcileReportSummary {
  status: ReconcileSyncStatus;
  sourceCommit: string | null;
  driftFingerprint: string | null;
  pullRequest: { number: number; url: string } | null;
  operation: ReconciliationMode | null;
  driftCount: number;
  accessErrors: AccessError[];
  blockedReason: string | null;
}
export interface ReconcileReportResult { reported: true; }

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

function nowIso(now: string | undefined): string {
  return now ?? new Date().toISOString();
}

/** Typed access to a persisted step output; the machine's explicit input-passing contract. */
function stepOutput<T>(outputs: Readonly<Record<string, unknown>>, stepId: string): T {
  const value = outputs[stepId];
  if (value === null || value === undefined) throw new WorkflowFailure('LP-WORKFLOW-STEP-INPUT-MISSING', `Step '${stepId}' has no persisted output; the machine resumed from an inconsistent boundary.`);
  return value as T;
}

/** Optional accessor for reporting paths where a later step may never have run. */
function tryStepOutput<T>(outputs: Readonly<Record<string, unknown>>, stepId: string): T | undefined {
  if (!(stepId in outputs)) return undefined;
  return stepOutput<T>(outputs, stepId);
}

async function ensureApplication(store: LaunchpadStore, applicationId: string): Promise<void> {
  if (await store.getApplication(applicationId)) return;
  await store.upsertApplication({ id: applicationId, displayName: applicationId, sourcePath: `catalog/apps/${applicationId}.yaml`, desiredGeneration: 0, desiredHash: '', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active', owners: [] });
}

function isEnabledEnvironment(spec: DesiredApplication['environments'][EnvironmentName] | undefined): spec is NonNullable<DesiredApplication['environments'][EnvironmentName]> {
  return spec !== undefined && spec.enabled !== false;
}

/** Bounded, redaction-safe rendering of a planned before/after pair for the PR body. */
function boundedJson(value: unknown): string {
  const rendered = JSON.stringify(value);
  return rendered === undefined ? 'null' : rendered.length > 160 ? `${rendered.slice(0, 160)}…` : rendered;
}

/** Provider noise keys that never participate in drift fingerprints or adopted values. */
const PROVIDER_NOISE_KEYS = new Set(['id', 'teamId', 'updatedAt', 'createdAt', 'link']);

function withoutProviderNoise(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (PROVIDER_NOISE_KEYS.has(key)) continue;
    out[key] = typeof item === 'object' && item !== null && !Array.isArray(item) ? withoutProviderNoise(item) : item;
  }
  return out;
}

/**
 * Stable reconcile drift fingerprint: the planner's drift records plus the
 * before/after values of the matching operations, canonicalized (sorted keys,
 * sorted records) with provider noise excluded. Equivalent drift — the same
 * records with the same values, regardless of provider ordering or
 * timestamps — fingerprints identically; genuinely different drift values
 * produce a different fingerprint and therefore a different PR.
 */
export async function driftFingerprintOf(plan: PlatformPlan): Promise<string> {
  const byKey = new Map(plan.operations.map((operation) => [operation.resourceKey, operation]));
  const records = (plan.drift?.records ?? []).map((record) => {
    const operation = byKey.get(record.resourceKey);
    return {
      resourceKey: record.resourceKey,
      category: record.category,
      detail: record.detail,
      before: withoutProviderNoise(operation?.before ?? null),
      after: withoutProviderNoise(operation?.after ?? null),
    };
  });
  return sha256Hex(canonicalJson(records));
}

// ---------------------------------------------------------------------------
// Phase functions
// ---------------------------------------------------------------------------

/**
 * Loads the latest protected control-repository main commit. Payload-provided
 * sourceCommits (manual/operator dispatches) are validated and used as-is;
 * scheduled cron triggers resolve the ref through the source provider. A
 * resolution failure is a typed read failure surfaced as UNKNOWN by the diff
 * phase — never SYNCED.
 */
export async function reconcileResolveMain(input: { base: ReconcileBase; source: SourceProvider; controlRepository: string; context: ProviderContext }): Promise<ResolveMainResult> {
  if (input.base.sourceCommit !== null) {
    if (!COMMIT_SHA_PATTERN.test(input.base.sourceCommit)) throw new WorkflowFailure('LP-RECONCILE-PAYLOAD-INVALID', 'sourceCommit must be a 40-hex commit sha.');
    return { sourceCommit: input.base.sourceCommit, source: 'payload', error: null };
  }
  if (!input.source.resolveRef) {
    return { sourceCommit: null, source: null, error: { code: 'LP-RECONCILE-REF-RESOLVE-UNAVAILABLE', message: 'The source provider cannot resolve the control-repository main ref.' } };
  }
  try {
    const ref = await input.source.resolveRef(input.controlRepository, 'main', input.context);
    if (!COMMIT_SHA_PATTERN.test(ref.sha)) return { sourceCommit: null, source: 'ref', error: { code: 'LP-RECONCILE-REF-MALFORMED', message: 'The control-repository main ref did not resolve to a commit sha.' } };
    return { sourceCommit: ref.sha, source: 'ref', error: null };
  } catch (error) {
    return { sourceCommit: null, source: 'ref', error: { code: errorCodeOf(error) ?? 'LP-RECONCILE-REF-RESOLVE-FAILED', message: 'The control-repository main ref could not be resolved.' } };
  }
}

/**
 * Reads the catalog desired state at the resolved main commit. Read failures
 * are classified: provider access loss is UNKNOWN, a missing or invalid
 * manifest is BLOCKED — neither ever reports SYNCED.
 */
export async function reconcileLoadDesired(input: { base: ReconcileBase; source: SourceProvider; controlRepository: string; manifestPath: string; sourceCommit: string | null; context: ProviderContext }): Promise<ReconcileLoadDesiredResult> {
  if (input.sourceCommit === null) {
    return { desired: null, rawManifest: null, manifestError: { code: 'LP-RECONCILE-REF-RESOLVE-FAILED', kind: 'access', message: 'No control-repository main commit could be resolved; the manifest cannot be read.' } };
  }
  let content: string;
  try {
    content = await input.source.readFile(input.controlRepository, input.sourceCommit, input.manifestPath, input.context);
  } catch (error) {
    const notFound = error instanceof ProviderRequestError && error.class === 'NOT_FOUND';
    return {
      desired: null,
      rawManifest: null,
      manifestError: notFound
        ? { code: errorCodeOf(error) ?? 'LP-CONTROL-MANIFEST-NOT_FOUND', kind: 'missing', message: `The manifest '${input.manifestPath}' does not exist in the control repository.` }
        : { code: errorCodeOf(error) ?? 'LP-CONTROL-MANIFEST-READ-FAILED', kind: 'access', message: `The manifest '${input.manifestPath}' could not be read from the control repository.` },
    };
  }
  const catalog = loadCatalog([{ path: input.manifestPath, content }]);
  if (catalog.issues.length > 0) {
    return { desired: null, rawManifest: null, manifestError: { code: `LP-CONTROL-MANIFEST-INVALID:${catalog.issues[0]?.code ?? 'unknown'}`, kind: 'invalid', message: `Catalog validation failed for ${input.manifestPath}: ${catalog.issues[0]?.code ?? 'unknown'}.` } };
  }
  const desired = catalog.applications.find((application) => application.metadata.id === input.base.applicationId);
  if (!desired) {
    return { desired: null, rawManifest: null, manifestError: { code: 'LP-CONTROL-APPLICATION-NOT_FOUND', kind: 'missing', message: `No manifest for application '${input.base.applicationId}' exists in the control repository.` } };
  }
  return { desired, rawManifest: content, manifestError: null };
}

/**
 * Live GitHub/Vercel/Cloudflare observations. The project, settings, and DNS
 * records are observed live; resources the provider contract does not read
 * back (repository declaration, git connection, environment variables,
 * deployment pipeline) are projected from the manifest exactly as the apply
 * pipeline leaves them, so an applied application never shows phantom drift.
 * Every live read failure is captured as a typed access error that forces
 * UNKNOWN in the diff phase.
 */
export async function reconcileObserveLiveState(input: { base: ReconcileBase; store: LaunchpadStore; provider: ProjectProvider & DnsProvider; desired: DesiredApplication | null; context: ProviderContext; now?: string }): Promise<ReconcileObserveLiveStateResult> {
  if (input.desired === null) return { observed: null, capabilities: null, accessErrors: [], baselinedKeys: [] };
  const desired = input.desired;
  const accessErrors: AccessError[] = [];
  const baselinedKeys: string[] = [];
  const observedAt = nowIso(input.now);

  let capabilities: ProviderCapabilities | null = null;
  try {
    capabilities = await input.provider.capabilities(input.context);
  } catch (error) {
    accessErrors.push({ provider: 'vercel', code: errorCodeOf(error) ?? 'LP-VERCEL-CAPABILITIES-FAILED', message: 'The Vercel capability snapshot could not be read.' });
  }

  const resources: ObservedResource[] = [];
  let project: ObservedResource | null = null;
  try {
    project = await input.provider.observeProject({ projectId: desired.metadata.id }, input.context);
  } catch (error) {
    accessErrors.push({ provider: 'vercel', code: errorCodeOf(error) ?? 'LP-VERCEL-OBSERVE-FAILED', message: 'The Vercel project could not be observed.' });
  }
  if (project) {
    resources.push(project);
    // `vercel.settings` is deliberately not pushed: the planner falls back to
    // the project resource for settings comparison (extracting only declared
    // settings keys), matching the apply pipeline exactly.
  }

  for (const domain of desired.domains.filter((candidate) => candidate.environment === 'production')) {
    // The Vercel domain attachment and its verification are not read back by
    // the observe contract; they are projected so an applied application
    // never shows phantom drift. The DNS record below is observed live.
    const domainKey = `vercel.domain.${domain.hostname}`;
    const domainProjection = satisfiedProjection({ hostname: domain.hostname, environment: domain.environment, canonical: domain.canonical ?? false, mode: domain.cloudflare.mode, ttl: domain.cloudflare.ttl, zoneRef: domain.cloudflare.zoneRef });
    resources.push({ provider: 'vercel', resourceType: 'project-domain', resourceKey: domainKey, providerResourceId: `${desired.metadata.id}:${domain.hostname}`, configuration: domainProjection, ownershipFingerprint: null, observedAt });
    baselinedKeys.push(domainKey);
    const verifyKey = `domain.verification.${domain.hostname}`;
    resources.push({ provider: 'vercel', resourceType: 'domain-verification', resourceKey: verifyKey, providerResourceId: `${desired.metadata.id}:${domain.hostname}`, configuration: { hostname: domain.hostname, verified: true }, ownershipFingerprint: null, observedAt });
    baselinedKeys.push(verifyKey);
    try {
      const zone = await input.provider.observeZone(domain.cloudflare.zoneRef, input.context);
      const record = await input.provider.observeRecord(zone.zoneId, domain.hostname, input.context);
      if (record) {
        resources.push({ provider: 'cloudflare', resourceType: 'dns-record', resourceKey: `cloudflare.dns.${domain.hostname}`, providerResourceId: record.id, configuration: { zoneRef: domain.cloudflare.zoneRef, mode: domain.cloudflare.mode, ttl: domain.cloudflare.ttl, proxied: domain.cloudflare.mode === 'proxied' }, ownershipFingerprint: record.ownershipFingerprint, observedAt });
      }
    } catch (error) {
      accessErrors.push({ provider: 'cloudflare', code: errorCodeOf(error) ?? 'LP-CLOUDFLARE-OBSERVE-FAILED', message: `Cloudflare state for '${domain.hostname}' could not be observed.` });
    }
  }

  // Resources the provider contract does not read back are projected from the
  // manifest (redacted fingerprints only for variables/secrets).
  const repositoryProjection = satisfiedProjection(desired.repository as unknown as Record<string, unknown>);
  resources.push({ provider: 'github', resourceType: 'repository', resourceKey: 'github.repository', providerResourceId: desired.repository.name, configuration: repositoryProjection, ownershipFingerprint: null, observedAt });
  baselinedKeys.push('github.repository');

  const accessProjection = satisfiedProjection(accessDesired(desired));
  resources.push({ provider: 'github', resourceType: 'repository-access', resourceKey: 'github.repository-access', providerResourceId: desired.repository.name, configuration: accessProjection, ownershipFingerprint: null, observedAt });
  baselinedKeys.push('github.repository-access');

  const gitProjection = satisfiedProjection({ connected: desired.vercel.project.git.connected, productionBranch: desired.vercel.project.git.productionBranch, repository: desired.repository.name } as unknown as Record<string, unknown>);
  resources.push({ provider: 'vercel', resourceType: 'git-connection', resourceKey: 'vercel.git', providerResourceId: desired.repository.name, configuration: gitProjection, ownershipFingerprint: null, observedAt });
  baselinedKeys.push('vercel.git');

  for (const [environment, spec] of Object.entries(desired.environments)) {
    if (!isEnabledEnvironment(spec)) continue;
    const envKey = `vercel.environment.${environment}`;
    resources.push({ provider: 'vercel', resourceType: 'environment', resourceKey: envKey, providerResourceId: `${desired.metadata.id}:${environment}`, configuration: satisfiedProjection(spec as unknown as Record<string, unknown>), ownershipFingerprint: null, observedAt });
    baselinedKeys.push(envKey);
    for (const [name, binding] of Object.entries(spec.variables ?? {})) {
      const varKey = `vercel.variable.${environment}.${name}`;
      resources.push({
        provider: 'vercel', resourceType: 'environment-variable', resourceKey: varKey, providerResourceId: `${desired.metadata.id}:${environment}:${name}`,
        configuration: { fingerprint: variableFingerprint(environment, name, binding), sensitive: typeof binding !== 'string' },
        ownershipFingerprint: null, observedAt,
      });
      baselinedKeys.push(varKey);
    }
  }
  for (const binding of desired.secrets) {
    for (const environment of binding.environments) {
      if (!isEnabledEnvironment(desired.environments[environment])) continue;
      const varKey = `vercel.variable.${environment}.${binding.name}`;
      if (baselinedKeys.includes(varKey)) continue;
      resources.push({
        provider: 'vercel', resourceType: 'environment-variable', resourceKey: varKey, providerResourceId: `${desired.metadata.id}:${environment}:${binding.name}`,
        configuration: { fingerprint: secretBindingFingerprint(environment, binding), sensitive: binding.sensitive ?? binding.source !== undefined },
        ownershipFingerprint: null, observedAt,
      });
      baselinedKeys.push(varKey);
    }
  }

  const productionDesired = desired.environments.production;
  if (isEnabledEnvironment(productionDesired)) {
    const productionProjection = satisfiedProjection(redactEnvironmentSpec(productionDesired, 'production') as unknown as Record<string, unknown>);
    resources.push({ provider: 'vercel', resourceType: 'deployment', resourceKey: 'production.candidate', providerResourceId: `${desired.metadata.id}:production:candidate`, configuration: productionProjection, ownershipFingerprint: null, observedAt });
    resources.push({ provider: 'vercel', resourceType: 'health-check', resourceKey: 'production.health', providerResourceId: `${desired.metadata.id}:production:health`, configuration: satisfiedProjection(productionDesired.health as unknown as Record<string, unknown>), ownershipFingerprint: null, observedAt });
    resources.push({ provider: 'vercel', resourceType: 'promotion', resourceKey: 'production.promotion', providerResourceId: `${desired.metadata.id}:production:promotion`, configuration: satisfiedProjection((productionDesired.release ?? {}) as unknown as Record<string, unknown>), ownershipFingerprint: null, observedAt });
    resources.push({ provider: 'vercel', resourceType: 'health-check', resourceKey: 'production.post-health', providerResourceId: `${desired.metadata.id}:production:post-health`, configuration: satisfiedProjection(productionDesired.health as unknown as Record<string, unknown>), ownershipFingerprint: null, observedAt });
    baselinedKeys.push('production.candidate', 'production.health', 'production.promotion', 'production.post-health');
  }

  // Baselined resources are manifest-derived and deterministically owned by
  // this application (stable across checks); live-observed resources keep
  // their provider ownership evidence untouched.
  for (const resource of resources) {
    if (baselinedKeys.includes(resource.resourceKey)) {
      resource.ownershipFingerprint = stableId('ownership', resource.resourceType, resource.resourceKey);
    }
  }

  const deploymentRows = await input.store.listDeployments(input.base.applicationId, { limit: 50 });
  const deployments = deploymentRows.map((row) => ({ id: row.id, projectId: row.projectId, environment: row.environment, repository: row.repository, commitSha: row.commitSha, desiredGeneration: row.desiredGeneration, state: row.state === 'SUPERSEDED' ? 'REJECTED' : row.state, url: row.url, createdAt: row.createdAt }));
  const latestChecks = await input.store.listHealthChecks(input.base.applicationId, { limit: 1 });
  const application = await input.store.getApplication(input.base.applicationId);
  const generation = await input.store.getDesiredGeneration(input.base.applicationId);

  const observed: ObservedApplication = {
    applicationId: input.base.applicationId,
    observedAt: observedAt,
    desiredGeneration: generation?.generation ?? 0,
    desiredHash: generation?.desiredHash ?? '',
    observedHash: '',
    lifecycleState: application?.lifecycleState ?? null,
    resources,
    deployments,
    health: latestChecks[0] === undefined ? { status: 'UNKNOWN', latest: null } : { status: latestChecks[0].result === 'PASSED' ? 'HEALTHY' : 'UNHEALTHY', latest: latestChecks[0] },
  };
  return { observed, capabilities, accessErrors, baselinedKeys };
}

/**
 * Full desired/observed/capability/ownership planner diff in reconcile mode.
 * Any access error forces UNKNOWN; a missing or invalid manifest forces
 * BLOCKED; real drift produces OUT_OF_SYNC with the planner's stable drift
 * fingerprint (canonical, ordering- and timestamp-independent). Drift never
 * authorizes destruction: an approved-deletion manifest yields BLOCKED.
 */
export async function reconcileDiffPlan(input: { base: ReconcileBase; store: LaunchpadStore; desired: DesiredApplication | null; observed: ObservedApplication | null; capabilities: ProviderCapabilities | null; accessErrors: AccessError[]; manifestError: ManifestError | null; context: ProviderContext; now?: string }): Promise<DiffPlanResult> {
  if (input.accessErrors.length > 0 || input.manifestError?.kind === 'access') {
    return { status: 'UNKNOWN', plan: null, drift: [], driftFingerprint: null, blockedReason: null, accessErrors: input.accessErrors };
  }
  if (input.desired === null || input.observed === null || input.capabilities === null) {
    const blockedReason = input.manifestError?.kind === 'invalid' ? 'LP-CONTROL-MANIFEST-INVALID' : 'BLOCKED_MISSING_MANIFEST';
    return { status: 'BLOCKED', plan: null, drift: [], driftFingerprint: null, blockedReason, accessErrors: [] };
  }
  const ownership: Record<string, string> = {};
  for (const resource of await input.store.listResources(input.base.applicationId)) {
    ownership[resource.resourceKey] = resource.ownershipFingerprint ?? '';
  }
  const plan = await buildPlan({
    desired: input.desired,
    observed: input.observed,
    capabilities: input.capabilities,
    sourceCommit: input.base.sourceCommit ?? '',
    desiredGeneration: input.observed.desiredGeneration,
    ownership,
    mode: 'reconcile',
    now: nowIso(input.now),
  });
  // `drift` is optional in the plan schema; only a present, non-null summary
  // with detected records may claim OUT_OF_SYNC — an absent summary falls
  // through to the READY/BLOCKED verdict below (fail-closed, never a default).
  const drift = plan.drift;
  if (drift !== null && drift !== undefined && drift.detected && drift.records.length > 0) {
    const driftFingerprint = await driftFingerprintOf(plan);
    return { status: 'OUT_OF_SYNC', plan, drift: drift.records, driftFingerprint, blockedReason: plan.result === 'BLOCKED' ? (plan.blockedReason ?? null) : null, accessErrors: [] };
  }
  if (plan.result !== 'READY') {
    return { status: 'BLOCKED', plan, drift: [], driftFingerprint: null, blockedReason: plan.blockedReason ?? null, accessErrors: [] };
  }
  return { status: 'SYNCED', plan, drift: [], driftFingerprint: null, blockedReason: null, accessErrors: [] };
}

/**
 * Persists the reconcile verdict to D1: application sync status, live
 * observation, plan, drift event (or resolution when back to SYNCED), and
 * audit. Access/read failures persist as UNKNOWN; nothing here is ever
 * inferred as SYNCED without a clean planner diff.
 */
export async function reconcilePersistStatus(input: { base: ReconcileBase; store: LaunchpadStore; diff: DiffPlanResult; observed: ObservedApplication | null; context: ProviderContext; now?: string }): Promise<PersistStatusResult> {
  const now = nowIso(input.now);
  await ensureApplication(input.store, input.base.applicationId);
  const syncStatus: SyncStatus = input.diff.status === 'OUT_OF_SYNC' ? 'OUT_OF_SYNC' : input.diff.status === 'BLOCKED' ? 'BLOCKED' : input.diff.status === 'UNKNOWN' ? 'UNKNOWN' : 'SYNCED';
  await input.store.updateApplicationStatus(input.base.applicationId, { syncStatus, updatedAt: now });

  let observationId: string | null = null;
  if (input.observed !== null) {
    const observedHash = await sha256Hex(canonicalJson({
      resources: input.observed.resources.map((resource) => ({ provider: resource.provider, resourceType: resource.resourceType, resourceKey: resource.resourceKey, configuration: resource.configuration })).sort((left, right) => left.resourceKey.localeCompare(right.resourceKey)),
      deployments: input.observed.deployments.map((deployment) => ({ id: deployment.id, environment: deployment.environment, commitSha: deployment.commitSha, state: deployment.state })),
    }));
    const record = await input.store.recordObservation({ applicationId: input.base.applicationId, observedHash, payload: input.observed, observedAt: now });
    observationId = record.id;
  }

  let planId: string | null = null;
  if (input.diff.plan !== null) {
    // Plans are content-addressed by fingerprint; an identical recomputed plan
    // (same inputs, later timestamp) is reused, never re-saved with a
    // conflicting payload.
    const existingPlan = await input.store.getPlanByFingerprint(input.base.applicationId, input.diff.plan.fingerprint);
    if (existingPlan !== null) {
      planId = existingPlan.id;
    } else {
      const saved = await input.store.savePlan({ applicationId: input.base.applicationId, plan: input.diff.plan, createdAt: now });
      planId = saved.id;
    }
  }

  let driftEventId: string | null = null;
  let resolvedDriftEvents = 0;
  let resolvedRequests = 0;
  if (syncStatus === 'SYNCED') {
    const openEvents = await input.store.listDriftEvents(input.base.applicationId, { includeResolved: false });
    for (const event of openEvents) {
      await input.store.resolveDriftEvent(event.id, now);
      resolvedDriftEvents += 1;
    }
    for (const request of await input.store.listReconciliationRequests(input.base.applicationId)) {
      if (request.status !== 'OPEN') continue;
      await input.store.resolveReconciliationRequest(request.id, 'SUPERSEDED', now);
      resolvedRequests += 1;
    }
  } else {
    const fingerprint = input.diff.driftFingerprint ?? stableId('reconcile-unknown', input.base.applicationId, input.base.sourceCommit ?? '', input.base.triggeredAt);
    const record = await input.store.recordDriftEvent({
      applicationId: input.base.applicationId,
      fingerprint,
      category: syncStatus,
      payload: { sourceCommit: input.base.sourceCommit, status: syncStatus, drift: input.diff.drift, blockedReason: input.diff.blockedReason, accessErrors: input.diff.accessErrors, observedAt: now },
      observedAt: now,
    });
    driftEventId = record.id;
  }

  await input.store.appendAudit({
    actor: `${input.context.actor.kind}:${input.context.actor.id}`,
    action: 'RECONCILE_STATUS',
    applicationId: input.base.applicationId,
    details: { status: syncStatus, sourceCommit: input.base.sourceCommit, driftFingerprint: input.diff.driftFingerprint, blockedReason: input.diff.blockedReason, driftCount: input.diff.drift.length, accessErrors: input.diff.accessErrors, triggeredAt: input.base.triggeredAt },
    createdAt: now,
  });
  return { status: syncStatus, observationId, planId, driftEventId, resolvedDriftEvents, resolvedRequests };
}

/**
 * Schema-valid adopted manifest: the desired manifest with live-observed
 * project values overlaid, preserving every unrelated desired field.
 */
export function adoptObservedState(input: { desired: DesiredApplication; observed: ObservedApplication }): DesiredApplication {
  const project = input.observed.resources.find((resource) => resource.resourceKey === 'vercel.project' || resource.resourceKey === input.desired.metadata.id);
  const observedConfig = project?.configuration ?? {};
  const pick = (key: string, fallback: unknown): unknown => (key in observedConfig ? observedConfig[key] : fallback);
  const pickPrefixed = (prefix: string, fallback: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...fallback };
    for (const [key, value] of Object.entries(observedConfig)) {
      if (!key.startsWith(prefix)) continue;
      out[key.slice(prefix.length)] = value;
    }
    return out;
  };
  const projectSpec = input.desired.vercel.project;
  const nextProject = {
    ...projectSpec,
    name: pick('name', projectSpec.name) as string,
    framework: pick('framework', projectSpec.framework) as string | null,
    rootDirectory: pick('rootDirectory', projectSpec.rootDirectory) as string,
    nodeVersion: pick('nodeVersion', projectSpec.nodeVersion) as string | null,
    build: {
      ...projectSpec.build,
      installCommand: pick('installCommand', projectSpec.build.installCommand) as string | null,
      buildCommand: pick('buildCommand', projectSpec.build.buildCommand) as string | null,
      outputDirectory: pick('outputDirectory', projectSpec.build.outputDirectory) as string | null,
      developmentCommand: pick('developmentCommand', projectSpec.build.developmentCommand) as string | null,
      ignoredBuildStep: pick('ignoredBuildStep', projectSpec.build.ignoredBuildStep) as string | null,
    },
    deployment: {
      ...projectSpec.deployment,
      autoAssignProductionDomains: pick('autoAssignProductionDomains', projectSpec.deployment.autoAssignProductionDomains) as boolean,
    },
    regions: { ...projectSpec.regions, functions: pick('functions', projectSpec.regions.functions) as string[] },
    protection: pickPrefixed('protection.', projectSpec.protection) as Record<string, string>,
    settings: pickPrefixed('settings.', projectSpec.settings) as Record<string, boolean | string | number | null>,
  };
  return { ...input.desired, vercel: { ...input.desired.vercel, project: nextProject } };
}

function reconciliationRequestYaml(input: { applicationId: string; observedAt: string; desiredGeneration: number; operation: ReconciliationMode; driftFingerprint: string; sourceCommit: string | null }): string {
  return [
    'apiVersion: launchpad.dev/v1',
    'kind: ReconciliationRequest',
    'metadata:',
    `  app: ${input.applicationId}`,
    `  observedAt: ${input.observedAt}`,
    'spec:',
    `  desiredGeneration: ${input.desiredGeneration}`,
    '  reason: external-drift',
    `  operation: ${input.operation}`,
    `  driftFingerprint: sha256:${input.driftFingerprint}`,
    ...(input.sourceCommit !== null ? [`  sourceCommit: ${input.sourceCommit}`] : []),
    '',
  ].join('\n');
}

function reconciliationPrBody(input: { applicationId: string; controlRepository: string; sourceCommit: string | null; driftFingerprint: string; operation: ReconciliationMode; plan: PlatformPlan; drift: DriftRecord[] }): string {
  const lines = [
    '## Launchpad reconciliation',
    '',
    `Application: ${input.applicationId}`,
    `Control repository: ${input.controlRepository} (base main commit ${input.sourceCommit ?? 'unresolved'})`,
    `Drift fingerprint: ${input.driftFingerprint}`,
    `Operation: ${input.operation}`,
    '',
    '### Detected drift',
    '',
  ];
  const byKey = new Map(input.plan.operations.map((operation) => [operation.resourceKey, operation]));
  for (const record of input.drift) {
    lines.push(`- \`${record.resourceKey}\` — ${record.category}: ${record.detail}`);
    const operation = byKey.get(record.resourceKey);
    if (operation !== undefined) {
      lines.push(`  - Desired: \`${boundedJson(operation.after)}\``);
      lines.push(`  - Actual: \`${boundedJson(operation.before)}\``);
    }
  }
  lines.push(
    '',
    input.operation === 'adopt-observed-state'
      ? 'This PR adopts the observed provider state into the control repository after review; unrelated desired fields are preserved.'
      : 'This PR restores the Git-defined state after review. Merging it runs the normal plan, preview, review, and apply gates.',
    '',
  );
  return lines.join('\n');
}

/**
 * Opens or updates exactly one reconciliation PR per application and drift
 * fingerprint. The PR targets the control repository, bases the branch on
 * the protected main SHA the diff was computed against, and writes the
 * recognized catalog manifest (`catalog/apps/<id>.yaml`) plus a generated
 * `ReconciliationRequest`. Repeated checks update the same PR; silent
 * restore (auto-restore) and any provider mutation are refused.
 */
export async function reconcileOpenOrUpdatePr(input: { base: ReconcileBase; store: LaunchpadStore; source: SourceProvider; controlRepository: string; manifestPath: string; rawManifest: string | null; desired: DesiredApplication | null; observed: ObservedApplication | null; diff: DiffPlanResult; context: ProviderContext; now?: string }): Promise<OpenOrUpdatePrResult> {
  if (input.diff.status !== 'OUT_OF_SYNC' || input.diff.driftFingerprint === null || input.desired === null || input.observed === null) {
    return { pullRequest: null, reconciliationRequestId: null, branch: null, operation: null, manifest: null, skipped: true };
  }
  const operation: ReconciliationMode = input.base.mode === 'adopt-observed-state' ? 'adopt-observed-state' : 'restore-desired-state';
  const driftFingerprint = input.diff.driftFingerprint;
  const shortFingerprint = stableId('reconcile', input.base.applicationId, driftFingerprint);
  const branch = `reconcile/${input.base.applicationId}/${shortFingerprint}`;
  const now = nowIso(input.now);

  let catalogFile: string;
  if (operation === 'adopt-observed-state') {
    const adopted = adoptObservedState({ desired: input.desired, observed: input.observed });
    // `sourcePath` is a loader-injected field, not part of the manifest schema.
    const { sourcePath: _sourcePath, ...adoptedRecord } = adopted;
    catalogFile = stringify(adoptedRecord as unknown as Record<string, unknown>, { indent: 2 });
    const validation = loadCatalog([{ path: input.manifestPath, content: catalogFile }]);
    if (validation.issues.length > 0 || validation.applications.length !== 1) {
      throw new WorkflowFailure('LP-RECONCILE-ADOPT-INVALID', `The adopted manifest for ${input.base.applicationId} failed catalog validation (${validation.issues[0]?.code ?? 'unknown'}); refusing to open the adoption PR.`);
    }
  } else {
    if (input.rawManifest === null) throw new WorkflowFailure('LP-RECONCILE-RESTORE-MANIFEST-MISSING', 'The restore PR requires the manifest content read at the base main commit.');
    catalogFile = input.rawManifest;
  }

  const requestFile = `reconciliation/${input.base.applicationId}.yaml`;
  const requestYaml = reconciliationRequestYaml({
    applicationId: input.base.applicationId,
    observedAt: now,
    desiredGeneration: input.observed.desiredGeneration,
    operation,
    driftFingerprint,
    sourceCommit: input.base.sourceCommit,
  });
  const files: Record<string, string> = {
    [input.manifestPath]: catalogFile,
    [requestFile]: requestYaml,
  };

  const plan = input.diff.plan;
  if (plan === null) throw new WorkflowFailure('LP-RECONCILE-PLAN-MISSING', 'An OUT_OF_SYNC verdict requires the planner plan for the PR body.');
  const body = reconciliationPrBody({
    applicationId: input.base.applicationId,
    controlRepository: input.controlRepository,
    sourceCommit: input.base.sourceCommit,
    driftFingerprint,
    operation,
    plan,
    drift: input.diff.drift,
  });
  const title = `reconcile: ${input.base.applicationId} drift ${shortFingerprint}`;
  const pullRequest = await input.source.createOrUpdatePullRequest({
    repository: input.controlRepository,
    branch,
    title,
    body,
    files,
    ...(input.base.sourceCommit !== null ? { baseSha: input.base.sourceCommit } : {}),
  }, input.context);
  const request = await input.store.openReconciliationRequest({
    applicationId: input.base.applicationId,
    fingerprint: driftFingerprint,
    mode: operation,
    pullRequestNumber: pullRequest.number,
    pullRequestUrl: pullRequest.url,
    openedAt: now,
  });
  return { pullRequest, reconciliationRequestId: request.id, branch, operation, manifest: catalogFile, skipped: false };
}

export async function reconcileReport(input: { base: ReconcileBase; store: LaunchpadStore; context: ProviderContext; summary: ReconcileReportSummary }): Promise<ReconcileReportResult> {
  await input.store.appendAudit({
    actor: `${input.context.actor.kind}:${input.context.actor.id}`,
    action: 'RECONCILE_COMPLETE',
    applicationId: input.base.applicationId,
    details: { ...input.summary, triggeredAt: input.base.triggeredAt, shard: input.base.shard, shardCount: input.base.shardCount },
  });
  return { reported: true };
}

// ---------------------------------------------------------------------------
// Step factory: maps a phase name to a durable, deterministic step
// ---------------------------------------------------------------------------

export interface ReconcileStepContext {
  base: ReconcileBase;
  context: ProviderContext;
  runtime?: ReconcileRuntime;
  source?: SourceProvider;
  controlRepository?: string;
  manifestPath?: string;
  /** Resolved control-repo main SHA (payload-carried for phase dispatch; unknown at build time for cron triggers). */
  sourceCommit?: string | null;
  desired?: DesiredApplication | null;
  observed?: ObservedApplication | null;
  capabilities?: ProviderCapabilities | null;
  accessErrors?: AccessError[];
  manifestError?: ManifestError | null;
  rawManifest?: string | null;
  diff?: DiffPlanResult;
  summary?: ReconcileReportSummary;
  now?: string;
}

function requireSource(ctx: ReconcileStepContext): SourceProvider {
  if (!ctx.source) throw new WorkflowFailure('LP-WORKFLOW-PAYLOAD-MISSING', 'Phase requires the source provider.');
  return ctx.source;
}

function requireControlRepository(ctx: ReconcileStepContext): string {
  if (!ctx.controlRepository) throw new WorkflowFailure('LP-CONTROL-REPOSITORY-CONFIG-MISSING', 'Phase requires the control repository.');
  return ctx.controlRepository;
}

function requireManifestPath(ctx: ReconcileStepContext): string {
  if (!ctx.manifestPath) throw new WorkflowFailure('LP-WORKFLOW-PAYLOAD-MISSING', 'Phase requires the manifest path.');
  return ctx.manifestPath;
}

function requireRuntime(ctx: ReconcileStepContext): ReconcileRuntime {
  if (!ctx.runtime) throw new WorkflowFailure('LP-WORKFLOW-PAYLOAD-MISSING', 'Phase requires the reconcile runtime.');
  return ctx.runtime;
}

function requireDiff(ctx: ReconcileStepContext): DiffPlanResult {
  if (!ctx.diff) throw new WorkflowFailure('LP-WORKFLOW-PAYLOAD-MISSING', 'Phase requires the diff-plan result.');
  return ctx.diff;
}

export function reconcileStep(name: ReconcilePhaseName, ctx: ReconcileStepContext): DurableStep {
  const base = ctx.base;
  switch (name) {
    case 'resolve-main':
      return { id: name, preconditionHash: canonicalJson({ applicationId: base.applicationId, payloadSourceCommit: base.sourceCommit, controlRepository: ctx.controlRepository ?? null, triggeredAt: base.triggeredAt }), run: async () => reconcileResolveMain({ base, source: requireSource(ctx), controlRepository: requireControlRepository(ctx), context: ctx.context }) };
    case 'load-desired':
      return { id: name, preconditionHash: canonicalJson({ applicationId: base.applicationId, sourceCommit: base.sourceCommit, controlRepository: ctx.controlRepository ?? null, manifestPath: ctx.manifestPath ?? null }), run: async () => reconcileLoadDesired({ base, source: requireSource(ctx), controlRepository: requireControlRepository(ctx), manifestPath: requireManifestPath(ctx), sourceCommit: ctx.sourceCommit ?? null, context: ctx.context }) };
    case 'observe-live-state':
      return { id: name, preconditionHash: canonicalJson({ applicationId: base.applicationId, sourceCommit: base.sourceCommit }), run: async () => {
        const runtime = requireRuntime(ctx);
        return reconcileObserveLiveState({ base, store: runtime.store, provider: runtime.provider, desired: ctx.desired ?? null, context: ctx.context, ...(ctx.now !== undefined ? { now: ctx.now } : {}) });
      } };
    case 'diff-plan':
      return { id: name, preconditionHash: canonicalJson({ applicationId: base.applicationId, sourceCommit: base.sourceCommit }), run: async () => reconcileDiffPlan({ base, store: requireRuntime(ctx).store, desired: ctx.desired ?? null, observed: ctx.observed ?? null, capabilities: ctx.capabilities ?? null, accessErrors: ctx.accessErrors ?? [], manifestError: ctx.manifestError ?? null, context: ctx.context, ...(ctx.now !== undefined ? { now: ctx.now } : {}) }) };
    case 'persist-status':
      return { id: name, preconditionHash: canonicalJson({ applicationId: base.applicationId, sourceCommit: base.sourceCommit }), run: async () => reconcilePersistStatus({ base, store: requireRuntime(ctx).store, diff: requireDiff(ctx), observed: ctx.observed ?? null, context: ctx.context, ...(ctx.now !== undefined ? { now: ctx.now } : {}) }) };
    case 'open-or-update-pr':
      return { id: name, preconditionHash: canonicalJson({ applicationId: base.applicationId, sourceCommit: base.sourceCommit, mode: base.mode }), run: async () => reconcileOpenOrUpdatePr({ base, store: requireRuntime(ctx).store, source: requireSource(ctx), controlRepository: requireControlRepository(ctx), manifestPath: requireManifestPath(ctx), rawManifest: ctx.rawManifest ?? null, desired: ctx.desired ?? null, observed: ctx.observed ?? null, diff: requireDiff(ctx), context: ctx.context, ...(ctx.now !== undefined ? { now: ctx.now } : {}) }) };
    case 'report':
      return { id: name, preconditionHash: canonicalJson({ applicationId: base.applicationId, sourceCommit: base.sourceCommit }), run: async () => {
        const diff = requireDiff(ctx);
        const summary: ReconcileReportSummary = {
          status: diff.status,
          sourceCommit: base.sourceCommit,
          driftFingerprint: diff.driftFingerprint,
          pullRequest: ctx.summary?.pullRequest ?? null,
          operation: ctx.summary?.operation ?? null,
          driftCount: diff.drift.length,
          accessErrors: diff.accessErrors,
          blockedReason: diff.blockedReason,
        };
        return reconcileReport({ base, store: requireRuntime(ctx).store, context: ctx.context, summary });
      } };
  }
}

// ---------------------------------------------------------------------------
// Composed machine + entry points
// ---------------------------------------------------------------------------

export interface ReconcileWorkflowInput {
  store: LaunchpadStore;
  provider: ProjectProvider & DnsProvider;
  source: SourceProvider;
  controlRepository: string;
  manifestPath?: string;
  applicationId: string;
  sourceCommit?: string | null;
  mode?: ReconcileMode;
  shard?: number;
  shardCount?: number;
  triggeredAt?: string;
  context: ProviderContext;
  now?: string;
}

export interface ReconcileResult {
  status: ReconcileSyncStatus;
  sourceCommit: string | null;
  drift: DriftRecord[];
  driftFingerprint: string | null;
  pullRequest: { number: number; url: string } | null;
  operation: ReconciliationMode | null;
  manifest: string | null;
  blockedReason: string | null;
  accessErrors: AccessError[];
}

export interface ReconcileWorkflowResult {
  status: 'SUCCEEDED' | 'FAILED';
  operationId: string | null;
  result: ReconcileResult | null;
  failedStep: string | null;
  errorCode: string | null;
}

export interface ReconcileMachineInput {
  runtime: ReconcileRuntime;
  base: ReconcileBase;
  source: SourceProvider;
  controlRepository: string;
  manifestPath: string;
  context: ProviderContext;
  now?: string;
}

export interface ReconcileMachine {
  steps: DurableStep[];
}

/** Composes the 22.3 machine. Steps consume persisted outputs explicitly via `context.outputs`. */
export function buildReconcileMachine(input: ReconcileMachineInput): ReconcileMachine {
  const { runtime, base, source, controlRepository, manifestPath, context } = input;
  const now = input.now;
  const steps: DurableStep[] = [
    reconcileStep('resolve-main', { base, context, runtime, source, controlRepository, manifestPath, ...(now !== undefined ? { now } : {}) }),
    {
      id: 'load-desired',
      preconditionHash: canonicalJson({ applicationId: base.applicationId, sourceCommit: base.sourceCommit, controlRepository, manifestPath }),
      run: async (_attempt, stepContext) => {
        const resolved = stepOutput<ResolveMainResult>(stepContext.outputs, 'resolve-main');
        return reconcileLoadDesired({ base, source, controlRepository, manifestPath, sourceCommit: resolved.sourceCommit, context });
      },
    },
    {
      id: 'observe-live-state',
      preconditionHash: canonicalJson({ applicationId: base.applicationId, sourceCommit: base.sourceCommit }),
      run: async (_attempt, stepContext) => {
        const loaded = stepOutput<ReconcileLoadDesiredResult>(stepContext.outputs, 'load-desired');
        return reconcileObserveLiveState({ base, store: runtime.store, provider: runtime.provider, desired: loaded.desired, context, ...(now !== undefined ? { now } : {}) });
      },
    },
    {
      id: 'diff-plan',
      preconditionHash: canonicalJson({ applicationId: base.applicationId, sourceCommit: base.sourceCommit }),
      run: async (_attempt, stepContext) => {
        const loaded = stepOutput<ReconcileLoadDesiredResult>(stepContext.outputs, 'load-desired');
        const live = stepOutput<ReconcileObserveLiveStateResult>(stepContext.outputs, 'observe-live-state');
        return reconcileDiffPlan({ base, store: runtime.store, desired: loaded.desired, observed: live.observed, capabilities: live.capabilities, accessErrors: live.accessErrors, manifestError: loaded.manifestError, context, ...(now !== undefined ? { now } : {}) });
      },
    },
    {
      id: 'persist-status',
      preconditionHash: canonicalJson({ applicationId: base.applicationId, sourceCommit: base.sourceCommit }),
      run: async (_attempt, stepContext) => {
        const diff = stepOutput<DiffPlanResult>(stepContext.outputs, 'diff-plan');
        const live = stepOutput<ReconcileObserveLiveStateResult>(stepContext.outputs, 'observe-live-state');
        return reconcilePersistStatus({ base, store: runtime.store, diff, observed: live.observed, context, ...(now !== undefined ? { now } : {}) });
      },
    },
    {
      id: 'open-or-update-pr',
      preconditionHash: canonicalJson({ applicationId: base.applicationId, sourceCommit: base.sourceCommit, mode: base.mode }),
      run: async (_attempt, stepContext) => {
        const diff = stepOutput<DiffPlanResult>(stepContext.outputs, 'diff-plan');
        const loaded = stepOutput<ReconcileLoadDesiredResult>(stepContext.outputs, 'load-desired');
        const live = stepOutput<ReconcileObserveLiveStateResult>(stepContext.outputs, 'observe-live-state');
        const resolved = stepOutput<ResolveMainResult>(stepContext.outputs, 'resolve-main');
        // The PR bases the branch on the resolved protected main SHA (the
        // commit the diff was computed against), never the payload default.
        const baseWithSource = resolved.sourceCommit !== null ? { ...base, sourceCommit: resolved.sourceCommit } : base;
        return reconcileOpenOrUpdatePr({ base: baseWithSource, store: runtime.store, source, controlRepository, manifestPath, rawManifest: loaded.rawManifest, desired: loaded.desired, observed: live.observed, diff, context, ...(now !== undefined ? { now } : {}) });
      },
    },
    {
      id: 'report',
      preconditionHash: canonicalJson({ applicationId: base.applicationId, sourceCommit: base.sourceCommit }),
      run: async (_attempt, stepContext) => {
        const diff = stepOutput<DiffPlanResult>(stepContext.outputs, 'diff-plan');
        const pr = tryStepOutput<OpenOrUpdatePrResult>(stepContext.outputs, 'open-or-update-pr');
        const resolved = tryStepOutput<ResolveMainResult>(stepContext.outputs, 'resolve-main');
        const summary: ReconcileReportSummary = {
          status: diff.status,
          sourceCommit: resolved?.sourceCommit ?? base.sourceCommit,
          driftFingerprint: diff.driftFingerprint,
          pullRequest: pr?.pullRequest ?? null,
          operation: pr?.operation ?? null,
          driftCount: diff.drift.length,
          accessErrors: diff.accessErrors,
          blockedReason: diff.blockedReason,
        };
        return reconcileReport({ base, store: runtime.store, context, summary });
      },
    },
  ];
  return { steps };
}

/** Runs a single durable phase through the store (controller internal dispatch path). */
export async function runReconcilePhase(input: { store: LaunchpadStore; base: ReconcileBase; context: ProviderContext; step: DurableStep; sleep?: (delayMs: number) => Promise<void> }, options: { complete?: boolean } = {}): Promise<StepOutcome> {
  const runner = new DurableOperationRunner(input.store);
  return runner.executeStep({ applicationId: input.base.applicationId, workflowId: input.base.workflowId, action: 'RECONCILE', idempotencyKey: input.base.idempotencyKey, payloadHash: input.base.payloadHash, steps: [input.step], ...(input.sleep !== undefined ? { sleep: input.sleep } : {}) }, input.step, undefined, options);
}

export async function runReconcileWorkflow(input: ReconcileWorkflowInput): Promise<ReconcileWorkflowResult> {
  const shard = input.shard ?? 0;
  const shardCount = input.shardCount ?? 1;
  const triggeredAt = input.triggeredAt ?? new Date().toISOString();
  const mode: ReconcileMode = input.mode ?? 'open-pr';
  const base = await makeReconcileBase({
    applicationId: input.applicationId,
    sourceCommit: input.sourceCommit ?? null,
    mode,
    shard,
    shardCount,
    triggeredAt,
    workflowId: input.context.workflowId,
    idempotencyKey: idempotencyKey('reconcile', input.applicationId, triggeredAt, String(shard), String(shardCount)),
  });
  const manifestPath = input.manifestPath ?? `catalog/apps/${input.applicationId}.yaml`;
  const runtime: ReconcileRuntime = { store: input.store, provider: input.provider };
  const machine = buildReconcileMachine({ runtime, base, source: input.source, controlRepository: input.controlRepository, manifestPath, context: input.context, ...(input.now !== undefined ? { now: input.now } : {}) });
  const runner = new DurableOperationRunner(input.store);
  const run = await runner.run({ applicationId: base.applicationId, workflowId: base.workflowId, action: 'RECONCILE', idempotencyKey: base.idempotencyKey, payloadHash: base.payloadHash, steps: machine.steps });
  return reconcileWorkflowResult(run);
}

function reconcileWorkflowResult(run: OperationRunResult): ReconcileWorkflowResult {
  const resolved = tryStepOutput<ResolveMainResult>(run.outputs, 'resolve-main');
  const diff = tryStepOutput<DiffPlanResult>(run.outputs, 'diff-plan');
  const pr = tryStepOutput<OpenOrUpdatePrResult>(run.outputs, 'open-or-update-pr');
  const result: ReconcileResult | null = diff === undefined
    ? null
    : {
        status: diff.status,
        sourceCommit: resolved?.sourceCommit ?? null,
        drift: diff.drift,
        driftFingerprint: diff.driftFingerprint,
        pullRequest: pr?.pullRequest ?? null,
        operation: pr?.operation ?? null,
        manifest: pr?.manifest ?? null,
        blockedReason: diff.blockedReason,
        accessErrors: diff.accessErrors,
      };
  return { status: run.status, operationId: run.operationId, result, failedStep: run.failedStep, errorCode: errorCodeOf(run.error) };
}
