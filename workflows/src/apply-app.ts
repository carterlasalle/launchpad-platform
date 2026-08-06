import { buildPlan, buildPlanObservedState, canonicalEqual, desiredStateHash, planReviewFingerprint, secretBindingFingerprint, satisfiedProjection, type DesiredApplication, type DeploymentRecord, type EnvironmentName, type HealthCheckRecord, type HealthSpec, type ObservedApplication, type ObservedResource, type PlanDnsObservation, type PlatformPlan, type ProviderCapabilities } from '@launchpad/core';
import { loadCatalog } from '@launchpad/catalog';
import { checkHealth } from '@launchpad/health';
import { canonicalJson, idempotencyKey, sha256Hex, stableId, type SensitiveValue } from '@launchpad/shared';
import type { LaunchpadStore } from '@launchpad/database';
import type { DnsProvider, MutationResult, ProjectProvider, ProjectSpec, ProviderContext, PromotionResult, RequiredDnsRecord, RollbackResult, SecretProvider, SourceProvider, TlsReadinessState, VercelDomainVerificationState } from '@launchpad/provider-contract';
import { DurableOperationRunner, errorCodeOf, type DurableStep, type OperationRunResult, type StepOutcome } from './operation-runner.js';

/**
 * Granular apply state machine (master plan section 22.1). One durable step
 * per provider mutation / readback / poll / gate; every step persists its
 * start/attempt/result/error through `LaunchpadStore` and passes its output
 * explicitly to the next step. Nothing is retained in process memory across
 * steps, so a Worker restart resumes from the last persisted boundary.
 *
 * Freshness contract: desired state is reloaded from the exact `sourceCommit`
 * (controller `load-desired` phase), live provider state is observed, the
 * plan is recomputed, and ALL freshness bindings (applicationId,
 * sourceCommit, desiredGeneration, plan fingerprint — which covers
 * observedStateHash, capabilitySnapshotHash and ownership) are verified
 * before the first provider write. Destructive operations are rejected
 * before locks or writes.
 */

export class WorkflowFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | null;

  constructor(code: string, message: string, retryable = false, details: Record<string, unknown> | null = null) {
    super(message);
    this.name = code;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export const APPLY_VERSION = 1 as const;
export const APPLY_KIND = 'apply' as const;

export interface ApplyBase {
  version: typeof APPLY_VERSION;
  kind: typeof APPLY_KIND;
  applicationId: string;
  sourceCommit: string;
  planFingerprint: string;
  desiredGeneration: number;
  idempotencyKey: string;
  workflowId: string;
  payloadHash: string;
}

/** The payload-hash formula shared with the controller ingress (OIDC contract). */
export async function applyPayloadHash(input: { applicationId: string; sourceCommit: string; planFingerprint: string; desiredGeneration: number }): Promise<string> {
  return sha256Hex(canonicalJson({ version: APPLY_VERSION, kind: APPLY_KIND, applicationId: input.applicationId, sourceCommit: input.sourceCommit, desiredGeneration: input.desiredGeneration, planFingerprint: input.planFingerprint }));
}

export async function makeApplyBase(input: { applicationId: string; sourceCommit: string; planFingerprint: string; desiredGeneration: number; idempotencyKey: string; workflowId: string }): Promise<ApplyBase> {
  return { version: APPLY_VERSION, kind: APPLY_KIND, applicationId: input.applicationId, sourceCommit: input.sourceCommit, planFingerprint: input.planFingerprint, desiredGeneration: input.desiredGeneration, idempotencyKey: input.idempotencyKey, workflowId: input.workflowId, payloadHash: await applyPayloadHash(input) };
}

export interface HeldLocks { applicationId: string; ownerId: string; leaseSeconds: number; application: string; domains: string[]; }

/** Lock resource keys derived from held locks: application key plus one domain key per hostname. */
export function lockKeys(locks: HeldLocks): string[] {
  return [locks.application, ...locks.domains.map((hostname) => `domain:${hostname}`)];
}

export interface ApplyRuntime {
  store: LaunchpadStore;
  provider: ProjectProvider & DnsProvider;
  secrets?: SecretProvider;
  fetchImpl?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
}

export type ApplyPhaseName =
  | 'validate-request' | 'load-desired' | 'observe-live-state' | 'replan-verify' | 'no-destroy-gate' | 'acquire-locks'
  | 'ensure-project' | 'ensure-git' | 'ensure-settings' | 'resolve-secrets' | 'ensure-environments'
  | 'ensure-domains' | 'ensure-dns' | 'verify-authoritative' | 'verify-vercel-domain' | 'verify-tls'
  | 'create-candidate' | 'wait-candidate' | 'proxy-compatibility' | 'candidate-health' | 'promote' | 'production-health'
  | 'record-known-good' | 'report' | 'release-locks' | 'recover-on-failure';

export const APPLY_PHASES: readonly ApplyPhaseName[] = [
  'validate-request', 'load-desired', 'observe-live-state', 'replan-verify', 'no-destroy-gate', 'acquire-locks',
  'ensure-project', 'ensure-git', 'ensure-settings', 'resolve-secrets', 'ensure-environments',
  'ensure-domains', 'ensure-dns', 'verify-authoritative', 'verify-vercel-domain', 'verify-tls',
  'create-candidate', 'wait-candidate', 'proxy-compatibility', 'candidate-health', 'promote', 'production-health',
  'record-known-good', 'report', 'release-locks', 'recover-on-failure',
];

const LOCK_LEASE_SECONDS = 900;
const CANDIDATE_WAIT_TIMEOUT_MS = 300_000;
const CANDIDATE_WAIT_POLL_MS = 2_000;
export const DEFAULT_HEALTH_SPEC: HealthSpec = { path: '/api/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 10, attempts: 1, intervalSeconds: 0 };

// ---------------------------------------------------------------------------
// Phase results (all JSON-serializable; never carry raw secret values)
// ---------------------------------------------------------------------------

export interface ValidateRequestResult { accepted: true; }
export interface LoadDesiredResult { desired: DesiredApplication; }
export interface ObserveLiveStateResult { observed: ObservedApplication; capabilities: ProviderCapabilities; }
export interface ReplanVerifyResult { plan: PlatformPlan; checks: { applicationId: boolean; sourceCommit: boolean; desiredGeneration: boolean; fingerprint: boolean; result: PlatformPlan['result']; }; }
export interface NoDestroyGateResult { accepted: true; }
export interface AcquireLocksResult { locks: HeldLocks; }
export interface EnsureProjectResult { mutation: MutationResult<ObservedResource>; verified: ObservedResource; }
export interface EnsureGitResult { mutation: MutationResult<ObservedResource>; }
export interface EnsureSettingsResult { verified: boolean; mismatches: string[]; }
export interface ResolveSecretsResult { bindings: Array<{ name: string; environments: EnvironmentName[]; fingerprint: string }>; }
export interface EnsureEnvironmentsResult { environment: 'production'; skipped: boolean; mutation: { changed: boolean; operationId: string } | null; fingerprints: Record<string, string>; resolved: Array<{ name: string; environments: EnvironmentName[]; fingerprint: string }>; }
export interface EnsureDomainsResult { domains: Array<{ hostname: string; operationId: string }>; }
export interface EnsureDnsResult { zones: Array<{ zoneId: string; hostname: string; records: Array<{ type: string; value: string; providerRecordId: string; operationId: string }> }>; }
export interface VerifyAuthoritativeResult { verified: true; hostnames: string[]; }
export interface VerifyVercelDomainResult { skipped: boolean; domains: Array<{ hostname: string; state: VercelDomainVerificationState }>; }
export interface VerifyTlsResult { skipped: boolean; domains: Array<{ hostname: string; state: TlsReadinessState }>; }
export interface CreateCandidateResult { candidate: DeploymentRecord; }
export interface WaitCandidateResult { candidate: DeploymentRecord; }
export interface ProxyCompatibilityGateResult {
  /** True when no domain is in proxied mode (DNS-only applies never probe). */
  skipped: boolean;
  checks: Array<{ hostname: string; compatible: boolean }>;
}
export interface CandidateHealthResult { health: HealthCheckRecord; }
export interface PromotePhaseResult { promotion: PromotionResult; }
export interface ProductionHealthResult { health: HealthCheckRecord; }
export interface RecordKnownGoodResult { knownGood: string; }
export interface ApplyReportSummary {
  applicationId: string;
  sourceCommit: string;
  desiredGeneration: number;
  planFingerprint: string;
  candidateId: string | null;
  candidateHealth: HealthCheckRecord | null;
  productionHealth: HealthCheckRecord | null;
  status: 'SUCCEEDED' | 'FAILED';
  errorCode: string | null;
  rollback: { deploymentId: string; restored: boolean } | null;
  restored: boolean;
}
export interface ReportResult { reported: true; summary: ApplyReportSummary; }
export interface ReleaseLocksResult { released: string[]; failed: Array<{ key: string; error: string }>; }

/**
 * Typed recovery decision, persisted on the durable 'recover-on-failure'
 * step and mirrored into the APPLY_FAILED audit event. The observed
 * pre-promotion CURRENT deployment is only a claim; rollback fires only when
 * the durable known-good record corroborates it (same project, same
 * environment, same deployment id). Absent/stale/mismatched records never
 * roll back and never mask the original failed release.
 */
export type RecoveryOutcome =
  | { kind: 'ROLLED_BACK'; rollback: RollbackResult; knownGoodId: string }
  | { kind: 'ROLLBACK_FAILED'; rollback: RollbackResult | null; error: { name: string; message: string } }
  | { kind: 'NO_ROLLBACK'; reason: 'NOT_POST_PROMOTION_FAILURE' | 'ROLLBACK_POLICY_DISABLED' | 'CANDIDATE_MISSING' | 'KNOWN_GOOD_NOT_OBSERVED' | 'CANDIDATE_IS_KNOWN_GOOD' | 'KNOWN_GOOD_ABSENT' | 'KNOWN_GOOD_MISMATCH' };

export interface RecoverOnFailureResult { rollback: RollbackResult | null; restored: boolean; rollbackError: { name: string; message: string } | null; reported: true; summary: ApplyReportSummary; recoveryOutcome: RecoveryOutcome; }

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function projectSpec(application: DesiredApplication): ProjectSpec {
  const project = application.vercel.project;
  return {
    id: application.metadata.id,
    name: project.name,
    teamId: null,
    framework: project.framework,
    rootDirectory: project.rootDirectory,
    nodeVersion: project.nodeVersion,
    build: { installCommand: project.build.installCommand, buildCommand: project.build.buildCommand, outputDirectory: project.build.outputDirectory },
    repository: application.repository.name,
    productionBranch: application.repository.productionBranch,
    settings: {
      ...project.settings,
      autoAssignProductionDomains: project.deployment.autoAssignProductionDomains,
    },
  };
}

function domainFor(application: DesiredApplication): string {
  return application.domains.find((domain) => domain.environment === 'production')?.hostname ?? `${application.metadata.id}.example.test`;
}

function knownGoodOf(observed: ObservedApplication): DeploymentRecord | null {
  return observed.deployments.find((deployment) => deployment.environment === 'production' && deployment.state === 'CURRENT') ?? null;
}

function isTrivial(value: unknown): boolean {
  return value === null || value === undefined || value === ''
    || (Array.isArray(value) && value.length === 0)
    || (typeof value === 'object' && value !== null && Object.keys(value).length === 0);
}

function serializableFailure(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  if (error !== null && typeof error === 'object' && 'name' in error && typeof error.name === 'string' && 'message' in error && typeof error.message === 'string') {
    return { name: error.name, message: error.message };
  }
  return { name: 'LP-WORKFLOW-STEP-FAILED', message: 'Unknown failure' };
}

/** Typed access to a persisted step output; the machine's explicit input-passing contract. */
function stepOutput<T>(outputs: Readonly<Record<string, unknown>>, stepId: string): T {
  const value = outputs[stepId];
  if (value === null || value === undefined) throw new WorkflowFailure('LP-WORKFLOW-STEP-INPUT-MISSING', `Step '${stepId}' has no persisted output; the machine resumed from an inconsistent boundary.`);
  return value as T; // persisted JSON written by our own phase functions; shape is the step contract
}

/**
 * The canonical Vercel project id observed by the ensure-project readback.
 * Vercel accepts the project NAME in project-scoped paths but returns the
 * canonical id in domain responses; domain operations therefore target the
 * canonical id so the domain identity check compares like-for-like.
 */
function canonicalProjectIdOf(outputs: Readonly<Record<string, unknown>>, base: ApplyBase): string {
  const ensured = outputs['ensure-project'];
  if (ensured !== null && typeof ensured === 'object' && !Array.isArray(ensured) && 'verified' in ensured) {
    const verified = (ensured as Record<string, unknown>).verified;
    if (verified !== null && typeof verified === 'object' && !Array.isArray(verified) && 'providerResourceId' in verified) {
      const id = (verified as Record<string, unknown>).providerResourceId;
      if (typeof id === 'string' && id.length > 0) return id;
    }
  }
  return base.applicationId;
}

/** Optional accessor for recovery paths where a later step may never have run. */
function tryStepOutput<T>(outputs: Readonly<Record<string, unknown>>, stepId: string): T | undefined {
  if (!(stepId in outputs)) return undefined;
  return stepOutput<T>(outputs, stepId);
}

/** Renews held locks, re-acquiring under the same owner when a lease expired but nobody else took it. */
export async function refreshLocks(store: LaunchpadStore, locks: HeldLocks): Promise<void> {
  for (const key of lockKeys(locks)) {
    if (await store.renewLock(key, locks.ownerId, locks.leaseSeconds)) continue;
    if (await store.acquireLock(key, locks.ownerId, locks.leaseSeconds)) continue;
    throw new WorkflowFailure('LP-LOCK-CONFLICT', `Lock '${key}' is held by another operation after lease expiry.`);
  }
}

/** Releases every lock currently owned by `ownerId`; idempotent and resume-safe (state-derived). */
export async function releaseOwnedLocks(store: LaunchpadStore, applicationId: string, domains: string[], ownerId: string): Promise<ReleaseLocksResult> {
  const released: string[] = [];
  const failed: Array<{ key: string; error: string }> = [];
  const keys = [`application:${applicationId}`, ...domains.map((hostname) => `domain:${hostname}`)];
  for (const key of keys) {
    const lock = await store.getLock(key);
    if (lock !== null && lock.ownerId !== ownerId) continue;
    try {
      if (await store.releaseLock(key, ownerId)) released.push(key);
    } catch (error) {
      failed.push({ key, error: error instanceof Error ? error.name : 'LP-LOCK-RELEASE-FAILED' });
    }
  }
  return { released, failed };
}

// ---------------------------------------------------------------------------
// Phase functions
// ---------------------------------------------------------------------------

export async function applyValidateRequest(input: { base: ApplyBase }): Promise<ValidateRequestResult> {
  const { base } = input;
  if (typeof base.applicationId !== 'string' || base.applicationId.length === 0) throw new WorkflowFailure('LP-WORKFLOW-APPLY-PAYLOAD-INVALID', 'applicationId is required.');
  if (!/^[0-9a-f]{40}$/.test(base.sourceCommit)) throw new WorkflowFailure('LP-WORKFLOW-APPLY-PAYLOAD-INVALID', 'sourceCommit must be a 40-hex commit sha.');
  if (typeof base.planFingerprint !== 'string' || base.planFingerprint.length === 0) throw new WorkflowFailure('LP-WORKFLOW-APPLY-PAYLOAD-INVALID', 'planFingerprint is required.');
  if (!Number.isInteger(base.desiredGeneration) || base.desiredGeneration < 1) throw new WorkflowFailure('LP-WORKFLOW-APPLY-PAYLOAD-INVALID', 'desiredGeneration must be a positive integer.');
  if (typeof base.idempotencyKey !== 'string' || base.idempotencyKey.length === 0) throw new WorkflowFailure('LP-WORKFLOW-APPLY-PAYLOAD-INVALID', 'idempotencyKey is required.');
  if (typeof base.workflowId !== 'string' || base.workflowId.length === 0) throw new WorkflowFailure('LP-WORKFLOW-APPLY-PAYLOAD-INVALID', 'workflowId is required.');
  return { accepted: true };
}

export async function applyLoadDesired(input: { base: ApplyBase; source: SourceProvider; controlRepository: string; manifestPath: string; context: ProviderContext }): Promise<LoadDesiredResult> {
  // TR-LIFE-001: manifest disappearance produces BLOCKED_MISSING_MANIFEST,
  // never deletion; the apply machine stops before any provider read/write.
  if (await input.source.hasPath(input.controlRepository, input.base.sourceCommit, input.manifestPath, input.context) === 'missing') {
    throw new WorkflowFailure('BLOCKED_MISSING_MANIFEST', `The manifest ${input.manifestPath} is missing at ${input.base.sourceCommit}; manifest removal never authorizes deletion.`);
  }
  const content = await input.source.readFile(input.controlRepository, input.base.sourceCommit, input.manifestPath, input.context);
  const catalog = loadCatalog([{ path: input.manifestPath, content }]);
  if (catalog.issues.length > 0) throw new WorkflowFailure('LP-CONTROL-MANIFEST-INVALID', `Catalog validation failed for ${input.manifestPath}: ${catalog.issues[0]?.code ?? 'unknown'}.`);
  const desired = catalog.applications.find((application) => application.metadata.id === input.base.applicationId);
  if (!desired) throw new WorkflowFailure('LP-CONTROL-APPLICATION-NOT_FOUND', `No manifest for application '${input.base.applicationId}' at commit ${input.base.sourceCommit}.`);
  return { desired };
}

export async function applyObserveLiveState(input: { base: ApplyBase; provider: ProjectProvider & DnsProvider; desired: DesiredApplication; context: ProviderContext }): Promise<ObserveLiveStateResult> {
  const { base, provider, desired } = input;
  const capabilities = await provider.capabilities(input.context);
  const project = await provider.observeProject({ projectId: desired.metadata.id }, input.context);
  // The provider-visible deployment for the exact source commit: the same
  // observation the approving CLI makes (findDeploymentByCommit is optional
  // on the contract; absence means no deployment evidence for this commit).
  const deployment = project === null ? null : await (provider.findDeploymentByCommit?.(base.applicationId, base.sourceCommit, input.context) ?? Promise.resolve(null));
  const dns: PlanDnsObservation[] = [];
  for (const domain of desired.domains.filter((candidate) => candidate.environment === 'production')) {
    const zone = await provider.observeZone(domain.cloudflare.zoneRef, input.context);
    const record = await provider.observeRecord(zone.zoneId, domain.hostname, input.context);
    dns.push({ domain, zoneId: zone.zoneId, record });
  }
  // Shared projection with the approving CLI: provider-visible state only.
  // Store bookkeeping (deployment rows, health history, generation records,
  // lifecycle state, ownership tables) is deliberately excluded so the replan
  // fingerprint is satisfiable by construction. Health is checked at
  // execution time; lifecycle state comes from the manifest.
  const observed = buildPlanObservedState({ applicationId: base.applicationId, desired, project, deployment, dns });
  return { observed, capabilities };
}

export async function applyReplanVerify(input: { base: ApplyBase; store: LaunchpadStore; desired: DesiredApplication; observed: ObservedApplication; capabilities: ProviderCapabilities; context: ProviderContext }): Promise<ReplanVerifyResult> {
  // Ownership parity with the approving CLI plan: the CLI cannot see the
  // store's ownership records, so a store-derived ownership map here would
  // make the replan fingerprint unsatisfiable by construction. Ownership
  // ambiguity detection remains in the reconcile flow, which owns the store.
  const ownership: Record<string, string> = {};
  const plan = await buildPlan({ desired: input.desired, observed: input.observed, capabilities: input.capabilities, sourceCommit: input.base.sourceCommit, desiredGeneration: input.base.desiredGeneration, ownership, mode: 'apply', now: new Date().toISOString() });
  const checks = { applicationId: plan.applicationId === input.base.applicationId, sourceCommit: plan.sourceCommit === input.base.sourceCommit, desiredGeneration: plan.desiredGeneration === input.base.desiredGeneration, fingerprint: plan.fingerprint === input.base.planFingerprint, result: plan.result };
  if (!checks.applicationId || !checks.sourceCommit || !checks.desiredGeneration || !checks.fingerprint) {
    throw new WorkflowFailure('LP-PLAN-STALE', `Approved plan is stale: recomputed fingerprint ${plan.fingerprint} does not match approved ${input.base.planFingerprint}.`);
  }
  // Reviewed-plan approval gate (squash-merge neutral). The replan is built
  // at the merged source commit, so its exact plan fingerprint differs from
  // the reviewed PR-head fingerprint; the review fingerprint and desired
  // hash/generation are the cross-SHA review contract. The attestation is
  // bound to the source-commit-neutral review fingerprint of the reviewed
  // plan and the exact desired state it reviewed. Missing attestation —
  // including any desired-state, provider-state, or generation change after
  // review — blocks here, before locks, provider reads, or provider writes.
  const [reviewFingerprint, desiredHash] = await Promise.all([
    planReviewFingerprint(plan),
    desiredStateHash(input.desired),
  ]);
  const attestation = await input.store.getPlanReviewAttestation(input.base.applicationId, reviewFingerprint);
  if (!attestation) {
    throw new WorkflowFailure('LP-PLAN-REVIEW-ATTESTATION-MISSING', `No reviewed-plan attestation exists for review fingerprint ${reviewFingerprint} of application '${input.base.applicationId}'; the plan was not reviewed at its PR head or provider/desired state changed after review.`);
  }
  if (attestation.desiredHash !== desiredHash || attestation.generation !== input.base.desiredGeneration) {
    throw new WorkflowFailure('LP-PLAN-REVIEW-DESIRED-STATE-DRIFT', `The reviewed-plan attestation binds desired state ${attestation.desiredHash.slice(0, 12)}/generation ${attestation.generation}, but the current plan targets ${desiredHash.slice(0, 12)}/generation ${input.base.desiredGeneration}; re-review the changed desired state.`);
  }
  if (plan.result !== 'READY') {
    throw new WorkflowFailure('LP-PLAN-BLOCKED', `Recomputed plan is not ready: ${plan.blockedReason ?? plan.result}.`);
  }
  return { plan, checks };
}

export async function applyNoDestroyGate(input: { plan: PlatformPlan }): Promise<NoDestroyGateResult> {
  const destructive = input.plan.result === 'DESTRUCTIVE' || input.plan.operations.some((operation) => operation.destructive || operation.action === 'DESTROY');
  if (destructive) throw new WorkflowFailure('LP-DESTROY-NORMAL-APPLY-BLOCKED', 'Normal apply refuses destructive operations; run the reviewed decommission workflow.');
  return { accepted: true };
}

export async function applyAcquireLocks(input: { base: ApplyBase; store: LaunchpadStore; desired: DesiredApplication }): Promise<AcquireLocksResult> {
  const locks: HeldLocks = {
    applicationId: input.base.applicationId,
    ownerId: input.base.workflowId,
    leaseSeconds: LOCK_LEASE_SECONDS,
    application: `application:${input.base.applicationId}`,
    domains: input.desired.domains.map((domain) => domain.hostname),
  };
  if (!(await input.store.acquireLock(locks.application, locks.ownerId, locks.leaseSeconds))) {
    throw new WorkflowFailure('LP-LOCK-CONFLICT', `Application lock '${locks.application}' is held by another operation.`);
  }
  const acquired: string[] = [];
  try {
    for (const hostname of locks.domains) {
      const key = `domain:${hostname}`;
      if (!(await input.store.acquireLock(key, locks.ownerId, locks.leaseSeconds))) throw new WorkflowFailure('LP-LOCK-CONFLICT', `Domain lock '${key}' is held by another operation.`);
      acquired.push(key);
    }
  } catch (error) {
    await input.store.releaseLock(locks.application, locks.ownerId);
    for (const key of acquired) await input.store.releaseLock(key, locks.ownerId);
    throw error;
  }
  return { locks };
}

export async function applyEnsureProject(input: { base: ApplyBase; store: LaunchpadStore; provider: ProjectProvider & DnsProvider; desired: DesiredApplication; plan: PlatformPlan; locks: HeldLocks; context: ProviderContext }): Promise<EnsureProjectResult> {
  await refreshLocks(input.store, input.locks);
  const spec = projectSpec(input.desired);
  const mutation = await input.provider.ensureProject(spec, input.context);
  const verified = await input.provider.observeProject({ projectId: spec.id }, input.context);
  if (!verified) throw new WorkflowFailure('LP-PROJECT-READBACK-FAILED', `Project '${spec.id}' was not observed after ensure.`);
  return { mutation, verified };
}

export async function applyEnsureGit(input: { base: ApplyBase; store: LaunchpadStore; provider: ProjectProvider & DnsProvider; desired: DesiredApplication; plan: PlatformPlan; locks: HeldLocks; context: ProviderContext }): Promise<EnsureGitResult> {
  await refreshLocks(input.store, input.locks);
  const project = projectSpec(input.desired);
  const mutation = await input.provider.ensureGitConnection({ projectId: project.id, repository: project.repository, productionBranch: project.productionBranch }, input.context);
  const verified = await input.provider.observeProject({ projectId: project.id }, input.context);
  if (!verified) throw new WorkflowFailure('LP-GIT-READBACK-FAILED', `Project '${project.id}' was not observed after the Git connection was ensured.`);
  return { mutation };
}

export async function applyEnsureSettings(input: { base: ApplyBase; store: LaunchpadStore; provider: ProjectProvider & DnsProvider; desired: DesiredApplication; plan: PlatformPlan; locks: HeldLocks; context: ProviderContext }): Promise<EnsureSettingsResult> {
  await refreshLocks(input.store, input.locks);
  const project = projectSpec(input.desired);
  const verified = await input.provider.observeProject({ projectId: project.id }, input.context);
  if (!verified) throw new WorkflowFailure('LP-SETTINGS-READBACK-FAILED', `Project '${project.id}' was not observed for settings verification.`);
  const observedConfig = verified.configuration;
  const desiredFlat: Record<string, unknown> = {
    name: input.desired.vercel.project.name,
    framework: input.desired.vercel.project.framework,
    rootDirectory: input.desired.vercel.project.rootDirectory,
    nodeVersion: input.desired.vercel.project.nodeVersion,
    installCommand: input.desired.vercel.project.build.installCommand,
    buildCommand: input.desired.vercel.project.build.buildCommand,
    outputDirectory: input.desired.vercel.project.build.outputDirectory,
    developmentCommand: input.desired.vercel.project.build.developmentCommand,
    ignoredBuildStep: input.desired.vercel.project.build.ignoredBuildStep,
    autoAssignProductionDomains: input.desired.vercel.project.deployment.autoAssignProductionDomains,
    functions: input.desired.vercel.project.regions.functions,
  };
  const mismatches: string[] = [];
  for (const [key, value] of Object.entries(desiredFlat)) {
    const observed = key in observedConfig ? observedConfig[key] : null;
    if (observed === null && isTrivial(value)) continue;
    if (canonicalEqual(value, observed)) continue;
    mismatches.push(key);
  }
  for (const [key, value] of Object.entries(input.desired.vercel.project.settings)) {
    const observed = key in observedConfig ? observedConfig[key] : null;
    if (observed === null && isTrivial(value)) continue;
    if (canonicalEqual(value, observed)) continue;
    mismatches.push(`settings.${key}`);
  }
  if (mismatches.length > 0) throw new WorkflowFailure('LP-SETTINGS-READBACK-FAILED', `Project settings did not converge after ensure: ${mismatches.join(', ')}.`);
  return { verified: true, mismatches };
}

export async function applyResolveSecrets(input: { base: ApplyBase; secrets: SecretProvider; desired: DesiredApplication; context: ProviderContext }): Promise<ResolveSecretsResult> {
  const bindings: ResolveSecretsResult['bindings'] = [];
  for (const binding of input.desired.secrets) {
    const environments = binding.environments.filter((environment) => input.desired.environments[environment]?.enabled !== false);
    if (environments.length === 0) continue;
    if (binding.source === undefined) continue; // literal bindings carry no provider secret to resolve
    const fingerprint = await input.secrets.fingerprint(binding.source, input.context);
    bindings.push({ name: binding.name, environments, fingerprint });
  }
  return { bindings };
}

export async function applyEnsureEnvironments(input: { base: ApplyBase; store: LaunchpadStore; provider: ProjectProvider & DnsProvider; secrets?: SecretProvider; desired: DesiredApplication; plan: PlatformPlan; locks: HeldLocks; context: ProviderContext; bindings?: ResolveSecretsResult['bindings'] }): Promise<EnsureEnvironmentsResult> {
  await refreshLocks(input.store, input.locks);
  const spec = input.desired.environments.production;
  if (!spec || spec.enabled === false) return { environment: 'production', skipped: true, mutation: null, fingerprints: {}, resolved: [] };
  const variables: Record<string, SensitiveValue<unknown> | string> = {};
  const fingerprints: Record<string, string> = {};
  for (const binding of input.desired.secrets) {
    if (!binding.environments.includes('production')) continue;
    fingerprints[binding.name] = secretBindingFingerprint('production', binding);
    if (binding.source !== undefined) {
      if (!input.secrets) throw new WorkflowFailure('LP-SECRET-PROVIDER-MISSING', `Secret binding '${binding.name}' requires a secret provider.`);
      variables[binding.name] = await input.secrets.resolve(binding.source, input.context); // SensitiveValue; never serialized
    } else {
      variables[binding.name] = binding.value ?? '';
    }
  }
  const mutation = await input.provider.ensureEnvironment({ projectId: input.base.applicationId, environment: 'production', branch: spec.branch ?? input.desired.repository.productionBranch, variables }, input.context);
  return { environment: 'production', skipped: false, mutation: { changed: mutation.changed, operationId: mutation.operationId }, fingerprints, resolved: input.bindings ?? [] };
}

export async function applyEnsureDomains(input: { base: ApplyBase; store: LaunchpadStore; provider: ProjectProvider & DnsProvider; desired: DesiredApplication; plan: PlatformPlan; locks: HeldLocks; projectId?: string; context: ProviderContext }): Promise<EnsureDomainsResult> {
  await refreshLocks(input.store, input.locks);
  const projectId = input.projectId ?? input.base.applicationId;
  const domains: EnsureDomainsResult['domains'] = [];
  for (const domain of input.desired.domains) {
    const mutation = await input.provider.ensureDomain({ projectId, hostname: domain.hostname, environment: domain.environment, mode: domain.cloudflare.mode, proxyAcknowledgment: domain.cloudflare.proxy?.acknowledgeDoubleCdn === true }, input.context);
    if (input.provider.getDomain) {
      const observed = await input.provider.getDomain(projectId, domain.hostname, input.context);
      if (!observed || observed.hostname !== domain.hostname) throw new WorkflowFailure('LP-DOMAIN-READBACK-FAILED', `Domain '${domain.hostname}' was not observed after ensure.`);
    }
    domains.push({ hostname: domain.hostname, operationId: mutation.operationId });
  }
  return { domains };
}

/**
 * Manifest-authoritative DNS mode projection (PRD-DNS-005). Proxied mode is
 * applied only when explicitly acknowledged; DNS-only is always explicit so
 * a provider record is never silently upgraded or downgraded. TXT records
 * (verification challenges) are never proxied.
 */
function dnsModeIntent(record: RequiredDnsRecord, domain: DesiredApplication['domains'][number]): RequiredDnsRecord {
  if (domain.cloudflare.mode === 'proxied' && (record.type === 'CNAME' || record.type === 'A')) {
    return { ...record, proxied: true, proxyAcknowledgment: true };
  }
  const dnsOnly = { ...record };
  delete dnsOnly.proxyAcknowledgment;
  dnsOnly.proxied = false;
  return dnsOnly;
}

export async function applyEnsureDns(input: { base: ApplyBase; store: LaunchpadStore; provider: ProjectProvider & DnsProvider; desired: DesiredApplication; plan: PlatformPlan; locks: HeldLocks; context: ProviderContext }): Promise<EnsureDnsResult> {
  await refreshLocks(input.store, input.locks);
  const zones: EnsureDnsResult['zones'] = [];
  for (const domain of input.desired.domains) {
    // Durable acknowledgment gate (defense in depth behind the planner
    // policy): an unacknowledged proxied domain must block, never silently
    // degrade to a DNS-only write.
    const acknowledged = domain.cloudflare.proxy?.acknowledgeDoubleCdn === true;
    if (domain.cloudflare.mode === 'proxied' && acknowledged !== true) {
      throw new WorkflowFailure('LP-DNS-PROXY-ACKNOWLEDGMENT-REQUIRED', `Proxied mode for '${domain.hostname}' requires explicit proxy acknowledgment; refusing to write a DNS record.`);
    }
    const zone = await input.provider.observeZone(domain.cloudflare.zoneRef, input.context);
    const required = await input.provider.requiredDnsRecords({ projectId: input.base.applicationId, hostname: domain.hostname, environment: domain.environment, mode: domain.cloudflare.mode, proxyAcknowledgment: acknowledged }, input.context);
    const records: EnsureDnsResult['zones'][number]['records'] = [];
    for (const record of required) {
      const ownershipFingerprint = idempotencyKey('ownership', input.base.applicationId, domain.hostname);
      const existing = await input.provider.observeRecord(zone.zoneId, domain.hostname, input.context, record.type);
      if (existing !== null && existing.ownershipFingerprint !== null && existing.ownershipFingerprint !== ownershipFingerprint) {
        throw new WorkflowFailure('LP-DNS-CONFLICT-UNOWNED', `DNS record for '${domain.hostname}' is owned by another party; refusing to overwrite it.`);
      }
      const intended = dnsModeIntent(record, domain);
      const mutation = await input.provider.ensureRecord(zone.zoneId, intended, ownershipFingerprint, input.context);
      const verified = await input.provider.observeRecord(zone.zoneId, domain.hostname, input.context, record.type);
      if (!verified) throw new WorkflowFailure('LP-DNS-READBACK-FAILED', `DNS record for '${domain.hostname}' was not observed after ensure.`);
      records.push({ type: record.type, value: record.value, providerRecordId: verified.id, operationId: mutation.operationId });
    }
    zones.push({ zoneId: zone.zoneId, hostname: domain.hostname, records });
  }
  return { zones };
}

export async function applyVerifyAuthoritative(input: { base: ApplyBase; provider: ProjectProvider & DnsProvider; desired: DesiredApplication; context: ProviderContext }): Promise<VerifyAuthoritativeResult> {
  const hostnames: string[] = [];
  for (const domain of input.desired.domains) {
    const zone = await input.provider.observeZone(domain.cloudflare.zoneRef, input.context);
    const required = await input.provider.requiredDnsRecords({ projectId: input.base.applicationId, hostname: domain.hostname, environment: domain.environment, mode: domain.cloudflare.mode, proxyAcknowledgment: domain.cloudflare.proxy?.acknowledgeDoubleCdn === true }, input.context);
    for (const record of required) {
      if (!(await input.provider.verifyAuthoritative(domain.hostname, record, input.context, zone))) {
        throw new WorkflowFailure('LP-DNS-VERIFICATION-TIMEOUT', `Authoritative DNS did not converge for ${domain.hostname} (${record.type}).`, true);
      }
    }
    hostnames.push(domain.hostname);
  }
  return { verified: true, hostnames };
}

export async function applyVerifyVercelDomain(input: { base: ApplyBase; provider: ProjectProvider & DnsProvider; desired: DesiredApplication; projectId?: string; context: ProviderContext }): Promise<VerifyVercelDomainResult> {
  if (!input.provider.getDomain || !input.provider.verifyDomain) return { skipped: true, domains: [] };
  const projectId = input.projectId ?? input.base.applicationId;
  const domains: VerifyVercelDomainResult['domains'] = [];
  for (const domain of input.desired.domains) {
    let observation = await input.provider.getDomain(projectId, domain.hostname, input.context);
    if (observation && !observation.verified) {
      await input.provider.verifyDomain(projectId, domain.hostname, input.context);
      observation = await input.provider.getDomain(projectId, domain.hostname, input.context);
    }
    if (!observation || observation.verificationState !== 'VERIFIED') {
      throw new WorkflowFailure('LP-VERCEL-DOMAIN-VERIFICATION-PENDING', `Vercel domain '${domain.hostname}' is not verified (${observation?.verificationState ?? 'UNKNOWN'}).`, true);
    }
    domains.push({ hostname: domain.hostname, state: observation.verificationState });
  }
  return { skipped: false, domains };
}

export async function applyVerifyTls(input: { base: ApplyBase; provider: ProjectProvider & DnsProvider; desired: DesiredApplication; context: ProviderContext }): Promise<VerifyTlsResult> {
  if (!input.provider.getDomainTls) return { skipped: true, domains: [] };
  const domains: VerifyTlsResult['domains'] = [];
  for (const domain of input.desired.domains) {
    const observation = await input.provider.getDomainTls(domain.hostname, input.context);
    if (!observation || observation.state !== 'READY') {
      throw new WorkflowFailure('LP-TLS-READINESS-PENDING', `TLS for '${domain.hostname}' is not ready (${observation?.state ?? 'UNKNOWN'}).`, true);
    }
    domains.push({ hostname: domain.hostname, state: observation.state });
  }
  return { skipped: false, domains };
}

export async function applyCreateCandidate(input: { base: ApplyBase; store: LaunchpadStore; provider: ProjectProvider & DnsProvider; desired: DesiredApplication; plan: PlatformPlan; locks: HeldLocks; context: ProviderContext; appCommit?: string; projectId?: string }): Promise<CreateCandidateResult> {
  await refreshLocks(input.store, input.locks);
  const project = projectSpec(input.desired);
  const projectId = input.projectId ?? project.id;
  // The staged candidate builds the APPLICATION repository at its production
  // branch HEAD (resolved by the controller), never the control-repository
  // commit that triggered the apply. The canonical Vercel project id is used
  // so the deployment record (and the promotion gate) compares like-for-like.
  const candidate = await input.provider.createDeployment({ projectId, environment: 'production', repository: project.repository, commitSha: input.appCommit ?? input.base.sourceCommit, desiredGeneration: input.plan.desiredGeneration, staged: true, rootDirectory: project.rootDirectory }, input.context);
  await input.store.recordDeployment({ id: candidate.id, applicationId: input.base.applicationId, projectId, environment: 'production', repository: project.repository, commitSha: candidate.commitSha, desiredGeneration: candidate.desiredGeneration, state: candidate.state, url: candidate.url, createdAt: candidate.createdAt });
  return { candidate };
}

export async function applyWaitCandidate(input: { base: ApplyBase; store: LaunchpadStore; provider: ProjectProvider & DnsProvider; desired: DesiredApplication; candidate: DeploymentRecord; context: ProviderContext; projectId?: string }): Promise<WaitCandidateResult> {
  const ready = await input.provider.waitForDeployment({ projectId: input.projectId ?? input.base.applicationId, deploymentId: input.candidate.id, timeoutMs: CANDIDATE_WAIT_TIMEOUT_MS, pollMs: CANDIDATE_WAIT_POLL_MS }, input.context);
  if (!['READY', 'STAGED'].includes(ready.state)) {
    let logExcerpt: string | null = null;
    if (input.provider.fetchDeploymentLogs) {
      const logs = await input.provider.fetchDeploymentLogs({ deploymentId: input.candidate.id, maxLines: 200, maxBytes: 8_000 }, input.context);
      logExcerpt = logs.excerpt;
    }
    throw new WorkflowFailure('LP-VERCEL-BUILD-FAILED', `Candidate deployment ended in ${ready.state}.`, false, logExcerpt !== null ? { logExcerpt, truncated: true } : null);
  }
  await input.store.recordDeployment({ id: ready.id, applicationId: input.base.applicationId, projectId: ready.projectId, environment: ready.environment, repository: ready.repository, commitSha: ready.commitSha, desiredGeneration: ready.desiredGeneration, state: ready.state, url: ready.url ?? input.candidate.url, createdAt: ready.createdAt });
  return { candidate: ready };
}

/** Hostname of a candidate deployment URL (scheme/path tolerant); null when the URL is unusable. */
export function candidateOriginHost(candidate: DeploymentRecord): string | null {
  if (!candidate.url || typeof candidate.url !== 'string') return null;
  const withoutScheme = candidate.url.replace(/^https?:\/\//i, '');
  const host = withoutScheme.split('/')[0]?.split('?')[0]?.split('#')[0];
  return host !== undefined && host.length > 0 ? host : null;
}

/**
 * Durable proxy compatibility gate (PRD-DNS-005). Runs only for acknowledged
 * proxied domains, after the DNS record exists (ensure-dns) and the candidate
 * is built (wait-candidate) but before promotion. Compares real origin probes
 * (candidate URL) with public probes (the proxied hostname) through
 * `checkProxyCompatibility`; incompatibility — or a provider that does not
 * expose the capability — blocks promotion. DNS-only applies never probe.
 */
export async function applyProxyCompatibility(input: { base: ApplyBase; provider: ProjectProvider & DnsProvider; desired: DesiredApplication; candidate: DeploymentRecord; context: ProviderContext }): Promise<ProxyCompatibilityGateResult> {
  const proxiedDomains = input.desired.domains.filter((domain) => domain.cloudflare.mode === 'proxied');
  if (proxiedDomains.length === 0) return { skipped: true, checks: [] };
  if (typeof input.provider.checkProxyCompatibility !== 'function') {
    throw new WorkflowFailure('LP-DNS-PROXY-COMPATIBILITY-UNSUPPORTED', 'Cloudflare proxy mode requires origin/public compatibility probing, but the DNS provider does not expose checkProxyCompatibility.');
  }
  const originHost = candidateOriginHost(input.candidate);
  if (originHost === null) throw new WorkflowFailure('LP-CANDIDATE-URL-MISSING', 'Candidate deployment has no URL for proxy compatibility probes.');
  const healthPath = input.desired.environments.production?.health?.path ?? DEFAULT_HEALTH_SPEC.path;
  const checks: ProxyCompatibilityGateResult['checks'] = [];
  for (const domain of proxiedDomains) {
    if (domain.cloudflare.proxy?.acknowledgeDoubleCdn !== true) {
      throw new WorkflowFailure('LP-DNS-PROXY-ACKNOWLEDGMENT-REQUIRED', `Proxied mode for '${domain.hostname}' requires explicit proxy acknowledgment before compatibility probing.`);
    }
    const result = await input.provider.checkProxyCompatibility({ hostname: domain.hostname, originHost, healthPath, proxyAcknowledgment: true }, input.context);
    const origin = result?.origin;
    const publicRoute = result?.public;
    const wellFormed = typeof result?.compatible === 'boolean'
      && origin !== null && typeof origin === 'object' && 'reachable' in origin && 'tls' in origin && 'statusCode' in origin && 'connectingIpHeader' in origin
      && publicRoute !== null && typeof publicRoute === 'object' && 'reachable' in publicRoute && 'tls' in publicRoute && 'statusCode' in publicRoute && 'connectingIpHeader' in publicRoute;
    if (!wellFormed || result.compatible !== true) {
      const detail = wellFormed
        ? `origin reachable=${result.origin.reachable} (tls ${result.origin.tls}, status ${result.origin.statusCode ?? 'none'}, connecting-ip ${result.origin.connectingIpHeader}); public reachable=${result.public.reachable} (tls ${result.public.tls}, status ${result.public.statusCode ?? 'none'})`
        : 'probe result was malformed or did not carry origin/public route observations';
      throw new WorkflowFailure('LP-DNS-PROXY-COMPATIBILITY-FAILED', `Cloudflare proxy compatibility check failed for '${domain.hostname}': ${detail}.`, false, { hostname: domain.hostname });
    }
    checks.push({ hostname: domain.hostname, compatible: true });
  }
  return { skipped: false, checks };
}

export async function applyCandidateHealth(input: { base: ApplyBase; store: LaunchpadStore; desired: DesiredApplication; candidate: DeploymentRecord; context: ProviderContext; fetchImpl?: typeof fetch; sleep?: (delayMs: number) => Promise<void> }): Promise<CandidateHealthResult> {
  if (!input.candidate.url) throw new WorkflowFailure('LP-CANDIDATE-URL-MISSING', 'Candidate deployment has no URL for health checks.');
  const health = await checkHealth({ applicationId: input.base.applicationId, environment: 'production', deploymentId: input.candidate.id, baseUrl: input.candidate.url, spec: input.desired.environments.production?.health ?? DEFAULT_HEALTH_SPEC, fetchImpl: input.fetchImpl, sleep: input.sleep });
  await input.store.recordHealthCheck(health);
  if (health.result !== 'PASSED') throw new WorkflowFailure('LP-HEALTH-CANDIDATE-FAILED', `Candidate health gate failed (${health.errorCode ?? health.result}).`);
  return { health };
}

export async function applyPromote(input: { base: ApplyBase; store: LaunchpadStore; provider: ProjectProvider & DnsProvider; desired: DesiredApplication; plan: PlatformPlan; candidate: DeploymentRecord; locks: HeldLocks; context: ProviderContext; appCommit?: string; projectId?: string }): Promise<PromotePhaseResult> {
  await refreshLocks(input.store, input.locks);
  if (input.desired.lifecycle.state !== 'active') {
    throw new WorkflowFailure('LP-PROMOTION-LIFECYCLE-BLOCKED', `Promotion is disabled while the application lifecycle is '${input.desired.lifecycle.state}'; decommissioning keeps the service running but stops new production promotion.`);
  }
  const project = projectSpec(input.desired);
  // The canonical Vercel project id: the candidate's record carries it (the
  // provider echoes the requested id), so the gate compares like-for-like.
  const projectId = input.projectId ?? project.id;
  if (input.candidate.projectId !== projectId) throw new WorkflowFailure('LP-PROMOTION-PROJECT-MISMATCH', `Candidate '${input.candidate.id}' belongs to project '${input.candidate.projectId}', expected '${projectId}'.`);
  if (input.candidate.environment !== 'production') throw new WorkflowFailure('LP-PROMOTION-ENVIRONMENT-MISMATCH', `Candidate '${input.candidate.id}' targets '${input.candidate.environment}', expected 'production'.`);
  if (input.candidate.repository !== project.repository) throw new WorkflowFailure('LP-PROMOTION-REPOSITORY-MISMATCH', `Candidate '${input.candidate.id}' came from '${input.candidate.repository}', expected '${project.repository}'.`);
  const expectedCommit = input.appCommit ?? input.base.sourceCommit;
  if (input.candidate.commitSha !== expectedCommit) throw new WorkflowFailure('LP-PROMOTION-COMMIT-MISMATCH', `Candidate '${input.candidate.id}' is at ${input.candidate.commitSha}, expected ${expectedCommit}.`);
  if (input.candidate.desiredGeneration !== input.plan.desiredGeneration) throw new WorkflowFailure('LP-PROMOTION-GENERATION-MISMATCH', `Candidate '${input.candidate.id}' has generation ${input.candidate.desiredGeneration}, expected ${input.plan.desiredGeneration}.`);
  if (!['READY', 'STAGED'].includes(input.candidate.state)) throw new WorkflowFailure('LP-PROMOTION-CANDIDATE-NOT-READY', `Candidate '${input.candidate.id}' is '${input.candidate.state}', not ready for promotion.`);
  const promotion = await input.provider.promote({ projectId, deploymentId: input.candidate.id, expectedCommitSha: expectedCommit }, input.context);
  if (promotion.deployment.state !== 'CURRENT') throw new WorkflowFailure('LP-PROMOTION-READBACK-FAILED', `Promotion did not yield a CURRENT deployment (${promotion.deployment.state}).`);
  await input.store.recordPromotion({ applicationId: input.base.applicationId, deploymentId: promotion.deployment.id, previousDeploymentId: promotion.previousDeploymentId, result: 'PROMOTED' });
  return { promotion };
}

export async function applyProductionHealth(input: { base: ApplyBase; store: LaunchpadStore; desired: DesiredApplication; candidate: DeploymentRecord; context: ProviderContext; fetchImpl?: typeof fetch; sleep?: (delayMs: number) => Promise<void> }): Promise<ProductionHealthResult> {
  const health = await checkHealth({ applicationId: input.base.applicationId, environment: 'production', deploymentId: input.candidate.id, baseUrl: `https://${domainFor(input.desired)}`, spec: input.desired.environments.production?.health ?? DEFAULT_HEALTH_SPEC, fetchImpl: input.fetchImpl, sleep: input.sleep });
  await input.store.recordHealthCheck(health);
  if (health.result !== 'PASSED') throw new WorkflowFailure('LP-HEALTH-PRODUCTION-FAILED', `Production health gate failed (${health.errorCode ?? health.result}).`);
  return { health };
}

export async function applyRecordKnownGood(input: { base: ApplyBase; store: LaunchpadStore; desired: DesiredApplication; candidate: DeploymentRecord; productionHealth: HealthCheckRecord; context: ProviderContext }): Promise<RecordKnownGoodResult> {
  if (input.productionHealth.result !== 'PASSED') throw new WorkflowFailure('LP-KNOWN-GOOD-PRECONDITION', 'Known-good recording requires a passed production health check.');
  await input.store.recordKnownGoodDeployment(input.base.applicationId, 'production', input.candidate.id);
  await input.store.updateApplicationStatus(input.base.applicationId, { syncStatus: 'SYNCED', healthStatus: 'HEALTHY' });
  return { knownGood: input.candidate.id };
}

export async function applyReport(input: { base: ApplyBase; store: LaunchpadStore; summary: ApplyReportSummary; context: ProviderContext }): Promise<ReportResult> {
  await input.store.appendAudit({ actor: `${input.context.actor.kind}:${input.context.actor.id}`, action: input.summary.status === 'SUCCEEDED' ? 'APPLY_SUCCEEDED' : 'APPLY_FAILED', applicationId: input.base.applicationId, details: { ...input.summary } });
  return { reported: true, summary: input.summary };
}

export async function applyReleaseLocks(input: { base: ApplyBase; store: LaunchpadStore; locks: HeldLocks }): Promise<ReleaseLocksResult> {
  const result = await releaseOwnedLocks(input.store, input.base.applicationId, input.locks.domains, input.locks.ownerId);
  if (result.failed.length > 0) {
    await input.store.appendAudit({ actor: 'system:workflow', action: 'LOCK_RELEASE_FAILED', applicationId: input.base.applicationId, details: { failed: result.failed } });
  }
  return result;
}

export async function applyRecoverOnFailure(input: { base: ApplyBase; store: LaunchpadStore; provider: ProjectProvider & DnsProvider; desired: DesiredApplication; context: ProviderContext; failure: { failedStep: string; error: unknown }; candidate: DeploymentRecord | null; knownGood: DeploymentRecord | null; productionHealth: HealthCheckRecord | null; projectId?: string; fetchImpl?: typeof fetch; sleep?: (delayMs: number) => Promise<void> }): Promise<RecoverOnFailureResult> {
  const policy = input.desired.environments.production?.rollback;
  const candidate = input.candidate;
  // The observed projection is provider-visible only (catalog commits never
  // match application deployments), so the durable known-good record is the
  // rollback claim; it is written only by the verified promotion path, and
  // the corroboration below requires the same record, so nothing written by
  // another path can trigger a rollback.
  const observedKnownGood = input.knownGood ?? (await input.store.getKnownGoodDeployment(input.base.applicationId, 'production'));
  const project = projectSpec(input.desired);
  // The canonical Vercel project id: deployment and known-good records carry
  // it (the provider echoes the requested id), so corroboration compares
  // like-for-like.
  const projectId = input.projectId ?? project.id;
  let rollback: RollbackResult | null = null;
  let rollbackError: { name: string; message: string } | null = null;
  let recoveryOutcome: RecoveryOutcome;
  if (input.failure.failedStep !== 'production-health') {
    recoveryOutcome = { kind: 'NO_ROLLBACK', reason: 'NOT_POST_PROMOTION_FAILURE' };
  } else if (!(policy?.enabled === true && policy.onFailedHealthCheck === true && policy.previousKnownGood === true)) {
    recoveryOutcome = { kind: 'NO_ROLLBACK', reason: 'ROLLBACK_POLICY_DISABLED' };
  } else if (candidate === null) {
    recoveryOutcome = { kind: 'NO_ROLLBACK', reason: 'CANDIDATE_MISSING' };
  } else if (observedKnownGood === null) {
    recoveryOutcome = { kind: 'NO_ROLLBACK', reason: 'KNOWN_GOOD_NOT_OBSERVED' };
  } else if (observedKnownGood.id === candidate.id) {
    recoveryOutcome = { kind: 'NO_ROLLBACK', reason: 'CANDIDATE_IS_KNOWN_GOOD' };
  } else {
    // The observed pre-promotion CURRENT is only a claim about what was live
    // before promotion; the durable known-good record is the rollback
    // authority. Roll back only when that record exists and corroborates the
    // claim exactly (same project, same environment, same deployment id).
    const stored = await input.store.getKnownGoodDeployment(input.base.applicationId, 'production');
    if (stored === null) {
      recoveryOutcome = { kind: 'NO_ROLLBACK', reason: 'KNOWN_GOOD_ABSENT' };
    } else if (stored.projectId !== projectId || stored.environment !== 'production' || stored.id !== observedKnownGood.id) {
      recoveryOutcome = { kind: 'NO_ROLLBACK', reason: 'KNOWN_GOOD_MISMATCH' };
    } else {
      try {
        rollback = await input.provider.rollback({ projectId, deploymentId: candidate.id, previousKnownGoodId: stored.id }, input.context);
        await input.store.recordKnownGoodDeployment(input.base.applicationId, 'production', stored.id);
        await input.store.recordPromotion({ applicationId: input.base.applicationId, deploymentId: stored.id, previousDeploymentId: candidate.id, result: 'ROLLED_BACK' });
        await input.store.updateApplicationStatus(input.base.applicationId, { syncStatus: 'RECONCILING', healthStatus: 'DEGRADED' });
        recoveryOutcome = { kind: 'ROLLED_BACK', rollback, knownGoodId: stored.id };
      } catch (error) {
        rollbackError = serializableFailure(error);
        recoveryOutcome = { kind: 'ROLLBACK_FAILED', rollback: null, error: rollbackError };
      }
    }
  }
  const summary: ApplyReportSummary = {
    applicationId: input.base.applicationId,
    sourceCommit: input.base.sourceCommit,
    desiredGeneration: input.base.desiredGeneration,
    planFingerprint: input.base.planFingerprint,
    candidateId: candidate?.id ?? null,
    candidateHealth: null,
    productionHealth: input.productionHealth,
    status: 'FAILED',
    errorCode: serializableFailure(input.failure.error).name,
    rollback: rollback !== null ? { deploymentId: rollback.deploymentId, restored: rollback.restored } : null,
    restored: rollback?.restored === true,
  };
  await input.store.appendAudit({ actor: `${input.context.actor.kind}:${input.context.actor.id}`, action: 'APPLY_FAILED', applicationId: input.base.applicationId, details: { ...summary, recoveryOutcome, rollbackError: rollbackError !== null ? rollbackError.name : null, failedStep: input.failure.failedStep } });
  return { rollback, restored: rollback?.restored === true, rollbackError, reported: true, summary, recoveryOutcome };
}

// ---------------------------------------------------------------------------
// Step factory: maps a phase name to a durable, deterministic step
// ---------------------------------------------------------------------------

export interface ApplyStepContext {
  base: ApplyBase;
  context: ProviderContext;
  runtime?: ApplyRuntime;
  source?: SourceProvider;
  controlRepository?: string;
  manifestPath?: string;
  desired?: DesiredApplication;
  observed?: ObservedApplication;
  capabilities?: ProviderCapabilities;
  plan?: PlatformPlan;
  locks?: HeldLocks;
  bindings?: ResolveSecretsResult['bindings'];
  candidate?: DeploymentRecord | null;
  knownGood?: DeploymentRecord | null;
  productionHealth?: HealthCheckRecord | null;
  failure?: { failedStep: string; error: unknown };
  summary?: ApplyReportSummary;
  /** Application-repository commit the production candidate must build (resolved from the app branch; falls back to base.sourceCommit for tests). */
  appCommit?: string;
}

export function applyStep(name: ApplyPhaseName, ctx: ApplyStepContext): DurableStep {
  const base = ctx.base;
  switch (name) {
    case 'validate-request':
      return { id: name, preconditionHash: canonicalJson({ applicationId: base.applicationId, sourceCommit: base.sourceCommit, planFingerprint: base.planFingerprint, desiredGeneration: base.desiredGeneration }), run: async () => applyValidateRequest({ base }) };
    case 'load-desired':
      return { id: name, preconditionHash: canonicalJson({ sourceCommit: base.sourceCommit, controlRepository: ctx.controlRepository ?? null, manifestPath: ctx.manifestPath ?? null }), run: async () => {
        if (!ctx.source || !ctx.controlRepository || !ctx.manifestPath) throw new WorkflowFailure('LP-WORKFLOW-PAYLOAD-MISSING', 'load-desired requires a source provider, control repository, and manifest path.');
        return applyLoadDesired({ base, source: ctx.source, controlRepository: ctx.controlRepository, manifestPath: ctx.manifestPath, context: ctx.context });
      } };
    case 'observe-live-state':
      return { id: name, preconditionHash: canonicalJson({ sourceCommit: base.sourceCommit, planFingerprint: base.planFingerprint, applicationId: base.applicationId }), run: async () => {
        if (!ctx.runtime) throw new WorkflowFailure('LP-WORKFLOW-PAYLOAD-MISSING', 'observe-live-state requires the apply runtime.');
        return applyObserveLiveState({ base, provider: ctx.runtime.provider, desired: requireDesired(ctx), context: ctx.context });
      } };
    case 'replan-verify':
      return { id: name, preconditionHash: canonicalJson({ sourceCommit: base.sourceCommit, planFingerprint: base.planFingerprint, desiredGeneration: base.desiredGeneration }), run: async () => {
        if (!ctx.runtime || !ctx.observed || !ctx.capabilities) throw new WorkflowFailure('LP-WORKFLOW-PAYLOAD-MISSING', 'replan-verify requires observed state and capabilities.');
        return applyReplanVerify({ base, store: ctx.runtime.store, desired: requireDesired(ctx), observed: ctx.observed, capabilities: ctx.capabilities, context: ctx.context });
      } };
    case 'no-destroy-gate':
      return { id: name, preconditionHash: canonicalJson({ planFingerprint: ctx.plan?.fingerprint ?? base.planFingerprint }), run: async () => applyNoDestroyGate({ plan: requirePlan(ctx) }) };
    case 'acquire-locks':
      return { id: name, preconditionHash: canonicalJson({ applicationId: base.applicationId, planFingerprint: base.planFingerprint, hostnames: ctx.desired?.domains.map((domain) => domain.hostname) ?? [] }), run: async () => applyAcquireLocks({ base, store: requireRuntime(ctx).store, desired: requireDesired(ctx) }) };
    case 'ensure-project':
      return mutationStep(name, ctx, (locks) => applyEnsureProject({ base, store: requireRuntime(ctx).store, provider: requireRuntime(ctx).provider, desired: requireDesired(ctx), plan: requirePlan(ctx), locks, context: ctx.context }));
    case 'ensure-git':
      return mutationStep(name, ctx, (locks) => applyEnsureGit({ base, store: requireRuntime(ctx).store, provider: requireRuntime(ctx).provider, desired: requireDesired(ctx), plan: requirePlan(ctx), locks, context: ctx.context }));
    case 'ensure-settings':
      return mutationStep(name, ctx, (locks) => applyEnsureSettings({ base, store: requireRuntime(ctx).store, provider: requireRuntime(ctx).provider, desired: requireDesired(ctx), plan: requirePlan(ctx), locks, context: ctx.context }));
    case 'resolve-secrets':
      return { id: name, preconditionHash: canonicalJson({ applicationId: base.applicationId, bindings: ctx.desired?.secrets ?? [] }), run: async () => {
        const secrets = requireRuntime(ctx).secrets;
        if (!secrets) return { bindings: [] };
        return applyResolveSecrets({ base, secrets, desired: requireDesired(ctx), context: ctx.context });
      } };
    case 'ensure-environments':
      return mutationStep(name, ctx, (locks) => {
        const runtime = requireRuntime(ctx);
        return applyEnsureEnvironments({ base, store: runtime.store, provider: runtime.provider, desired: requireDesired(ctx), plan: requirePlan(ctx), locks, context: ctx.context, ...(runtime.secrets !== undefined ? { secrets: runtime.secrets } : {}), ...(ctx.bindings !== undefined ? { bindings: ctx.bindings } : {}) });
      });
    case 'ensure-domains':
      return mutationStep(name, ctx, (locks, outputs) => applyEnsureDomains({ base, store: requireRuntime(ctx).store, provider: requireRuntime(ctx).provider, desired: requireDesired(ctx), plan: requirePlan(ctx), locks, projectId: canonicalProjectIdOf(outputs, base), context: ctx.context }));
    case 'ensure-dns':
      return mutationStep(name, ctx, (locks) => applyEnsureDns({ base, store: requireRuntime(ctx).store, provider: requireRuntime(ctx).provider, desired: requireDesired(ctx), plan: requirePlan(ctx), locks, context: ctx.context }));
    case 'verify-authoritative':
      return { id: name, preconditionHash: canonicalJson({ sourceCommit: base.sourceCommit, hostnames: ctx.desired?.domains.map((domain) => domain.hostname) ?? [] }), retry: { maxAttempts: 5, baseDelayMs: 2_000, maxDelayMs: 15_000 }, run: async () => applyVerifyAuthoritative({ base, provider: requireRuntime(ctx).provider, desired: requireDesired(ctx), context: ctx.context }) };
    case 'verify-vercel-domain':
      return { id: name, preconditionHash: canonicalJson({ sourceCommit: base.sourceCommit, hostnames: ctx.desired?.domains.map((domain) => domain.hostname) ?? [] }), retry: { maxAttempts: 5, baseDelayMs: 5_000, maxDelayMs: 30_000 }, run: async (_attempt, stepContext) => applyVerifyVercelDomain({ base, provider: requireRuntime(ctx).provider, desired: requireDesired(ctx), projectId: canonicalProjectIdOf(stepContext.outputs, base), context: ctx.context }) };
    case 'verify-tls':
      return { id: name, preconditionHash: canonicalJson({ sourceCommit: base.sourceCommit, hostnames: ctx.desired?.domains.map((domain) => domain.hostname) ?? [] }), retry: { maxAttempts: 5, baseDelayMs: 5_000, maxDelayMs: 30_000 }, run: async () => applyVerifyTls({ base, provider: requireRuntime(ctx).provider, desired: requireDesired(ctx), context: ctx.context }) };
    case 'create-candidate':
      return mutationStep(name, ctx, (locks, outputs) => applyCreateCandidate({ base, store: requireRuntime(ctx).store, provider: requireRuntime(ctx).provider, desired: requireDesired(ctx), plan: requirePlan(ctx), locks, context: ctx.context, projectId: canonicalProjectIdOf(outputs, base), ...(ctx.appCommit !== undefined ? { appCommit: ctx.appCommit } : {}) }));
    case 'wait-candidate':
      return { id: name, preconditionHash: canonicalJson({ sourceCommit: base.sourceCommit, candidateId: ctx.candidate?.id ?? null }), retry: { maxAttempts: 3, baseDelayMs: 5_000, maxDelayMs: 30_000 }, run: async (_attempt, stepContext) => {
        if (!ctx.candidate) throw new WorkflowFailure('LP-CANDIDATE-MISSING', 'Candidate deployment was not created.');
        return applyWaitCandidate({ base, store: requireRuntime(ctx).store, provider: requireRuntime(ctx).provider, desired: requireDesired(ctx), candidate: ctx.candidate, context: ctx.context, projectId: canonicalProjectIdOf(stepContext.outputs, base) });
      } };
    case 'proxy-compatibility':
      return { id: name, preconditionHash: canonicalJson({ sourceCommit: base.sourceCommit, candidateId: ctx.candidate?.id ?? null }), run: async () => {
        if (!ctx.candidate) throw new WorkflowFailure('LP-CANDIDATE-MISSING', 'Candidate deployment is unavailable for proxy compatibility checks.');
        return applyProxyCompatibility({ base, provider: requireRuntime(ctx).provider, desired: requireDesired(ctx), candidate: ctx.candidate, context: ctx.context });
      } };
    case 'candidate-health':
      return { id: name, preconditionHash: canonicalJson({ sourceCommit: base.sourceCommit, candidateId: ctx.candidate?.id ?? null }), run: async () => {
        if (!ctx.candidate) throw new WorkflowFailure('LP-CANDIDATE-MISSING', 'Candidate deployment is unavailable for health checks.');
        const runtime = requireRuntime(ctx);
        return applyCandidateHealth({ base, store: runtime.store, desired: requireDesired(ctx), candidate: ctx.candidate, context: ctx.context, ...(runtime.fetchImpl !== undefined ? { fetchImpl: runtime.fetchImpl } : {}), ...(runtime.sleep !== undefined ? { sleep: runtime.sleep } : {}) });
      } };
    case 'promote':
      return mutationStep(name, ctx, (locks, outputs) => {
        if (!ctx.candidate) throw new WorkflowFailure('LP-CANDIDATE-MISSING', 'Candidate deployment is unavailable for promotion.');
        return applyPromote({ base, store: requireRuntime(ctx).store, provider: requireRuntime(ctx).provider, desired: requireDesired(ctx), plan: requirePlan(ctx), candidate: ctx.candidate, locks, context: ctx.context, projectId: canonicalProjectIdOf(outputs, base), ...(ctx.appCommit !== undefined ? { appCommit: ctx.appCommit } : {}) });
      });
    case 'production-health':
      return { id: name, preconditionHash: canonicalJson({ sourceCommit: base.sourceCommit, candidateId: ctx.candidate?.id ?? null }), run: async () => {
        if (!ctx.candidate) throw new WorkflowFailure('LP-CANDIDATE-MISSING', 'Promoted deployment is unavailable for health checks.');
        const runtime = requireRuntime(ctx);
        return applyProductionHealth({ base, store: runtime.store, desired: requireDesired(ctx), candidate: ctx.candidate, context: ctx.context, ...(runtime.fetchImpl !== undefined ? { fetchImpl: runtime.fetchImpl } : {}), ...(runtime.sleep !== undefined ? { sleep: runtime.sleep } : {}) });
      } };
    case 'record-known-good':
      return { id: name, preconditionHash: canonicalJson({ sourceCommit: base.sourceCommit, candidateId: ctx.candidate?.id ?? null, productionHealth: ctx.productionHealth?.result ?? null }), run: async () => {
        if (!ctx.candidate || !ctx.productionHealth) throw new WorkflowFailure('LP-KNOWN-GOOD-PRECONDITION', 'Known-good recording requires a promoted candidate and production health result.');
        return applyRecordKnownGood({ base, store: requireRuntime(ctx).store, desired: requireDesired(ctx), candidate: ctx.candidate, productionHealth: ctx.productionHealth, context: ctx.context });
      } };
    case 'report':
      return { id: name, preconditionHash: canonicalJson({ sourceCommit: base.sourceCommit, status: ctx.summary?.status ?? 'SUCCEEDED', candidateId: ctx.summary?.candidateId ?? null }), run: async () => {
        if (!ctx.summary) throw new WorkflowFailure('LP-WORKFLOW-PAYLOAD-MISSING', 'report requires a summary.');
        return applyReport({ base, store: requireRuntime(ctx).store, summary: ctx.summary, context: ctx.context });
      } };
    case 'release-locks':
      return { id: name, preconditionHash: canonicalJson({ applicationId: base.applicationId, ownerId: base.workflowId, hostnames: ctx.locks?.domains ?? [] }), run: async () => {
        if (!ctx.locks) throw new WorkflowFailure('LP-WORKFLOW-PAYLOAD-MISSING', 'release-locks requires the held locks.');
        return applyReleaseLocks({ base, store: requireRuntime(ctx).store, locks: ctx.locks });
      } };
    case 'recover-on-failure':
      return { id: name, preconditionHash: canonicalJson({ failedStep: ctx.failure?.failedStep ?? null, error: ctx.failure ? serializableFailure(ctx.failure.error).name : null, candidateId: ctx.candidate?.id ?? null, knownGoodId: ctx.knownGood?.id ?? null }), run: async (_attempt, stepContext) => {
        if (!ctx.failure) throw new WorkflowFailure('LP-WORKFLOW-PAYLOAD-MISSING', 'recover-on-failure requires the failure context.');
        const runtime = requireRuntime(ctx);
        return applyRecoverOnFailure({ base, store: runtime.store, provider: runtime.provider, desired: requireDesired(ctx), context: ctx.context, failure: ctx.failure, candidate: ctx.candidate ?? null, knownGood: ctx.knownGood ?? null, productionHealth: ctx.productionHealth ?? null, projectId: canonicalProjectIdOf(stepContext.outputs, base), ...(runtime.fetchImpl !== undefined ? { fetchImpl: runtime.fetchImpl } : {}), ...(runtime.sleep !== undefined ? { sleep: runtime.sleep } : {}) });
      } };
  }
}

function requireDesired(ctx: ApplyStepContext): DesiredApplication {
  if (!ctx.desired) throw new WorkflowFailure('LP-WORKFLOW-PAYLOAD-MISSING', `Phase '${ctx.base.applicationId}' requires the merged desired manifest.`);
  return ctx.desired;
}

function requirePlan(ctx: ApplyStepContext): PlatformPlan {
  if (!ctx.plan) throw new WorkflowFailure('LP-WORKFLOW-PAYLOAD-MISSING', 'Phase requires the recomputed plan.');
  return ctx.plan;
}

function requireRuntime(ctx: ApplyStepContext): ApplyRuntime {
  if (!ctx.runtime) throw new WorkflowFailure('LP-WORKFLOW-PAYLOAD-MISSING', 'Phase requires the apply runtime.');
  return ctx.runtime;
}

function mutationStep(name: ApplyPhaseName, ctx: ApplyStepContext, run: (locks: HeldLocks, outputs: Readonly<Record<string, unknown>>) => Promise<unknown>): DurableStep {
  return {
    id: name,
    preconditionHash: canonicalJson({ planFingerprint: ctx.plan?.fingerprint ?? ctx.base.planFingerprint, sourceCommit: ctx.base.sourceCommit, lockOwner: ctx.base.workflowId }),
    run: async (_attempt, stepContext) => {
      if (!ctx.locks) throw new WorkflowFailure('LP-LOCK-CONFLICT', `Phase '${name}' requires held locks; the machine resumed without them.`);
      return run(ctx.locks, stepContext.outputs);
    },
  };
}

// ---------------------------------------------------------------------------
// Composed machine + entry points
// ---------------------------------------------------------------------------

export interface ApplyWorkflowInput {
  store: LaunchpadStore;
  provider: ProjectProvider & DnsProvider;
  secrets?: SecretProvider;
  desired: DesiredApplication;
  observed: ObservedApplication;
  plan: PlatformPlan;
  sourceCommit: string;
  context: ProviderContext;
  fetchImpl?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
}

export interface ApplyWorkflowResult {
  status: 'SUCCEEDED' | 'FAILED';
  operationId: string | null;
  candidate: DeploymentRecord | null;
  candidateHealth: HealthCheckRecord | null;
  productionHealth: HealthCheckRecord | null;
  rollback: RollbackResult | null;
  errorCode: string | null;
}

export interface ApplyMachineInput {
  runtime: ApplyRuntime;
  base: ApplyBase;
  submitted: { desired: DesiredApplication; observed: ObservedApplication; plan: PlatformPlan };
  context: ProviderContext;
}

export interface ApplyMachine {
  steps: DurableStep[];
  onFailure: (failure: { failedStep: string; error: unknown; outputs: Readonly<Record<string, unknown>> }) => Promise<unknown>;
  releaseLocks: () => Promise<void>;
}

/** Composes the full 22.1 machine. Steps consume persisted outputs explicitly via `context.outputs`. */
export function buildApplyMachine(input: ApplyMachineInput): ApplyMachine {
  const { runtime, base, submitted, context } = input;
  const steps: DurableStep[] = [
    {
      id: 'validate-request',
      preconditionHash: canonicalJson({ applicationId: base.applicationId, sourceCommit: base.sourceCommit, planFingerprint: base.planFingerprint, desiredGeneration: base.desiredGeneration }),
      run: async () => {
        await applyValidateRequest({ base });
        const plan = submitted.plan;
        if (plan.applicationId !== base.applicationId || plan.sourceCommit !== base.sourceCommit || plan.desiredGeneration !== base.desiredGeneration || plan.fingerprint !== base.planFingerprint) {
          throw new WorkflowFailure('LP-PLAN-STALE', 'Submitted plan does not match the apply request bindings.');
        }
        if (plan.result !== 'READY') throw new WorkflowFailure('LP-PLAN-BLOCKED', `Submitted plan is not ready: ${plan.blockedReason ?? plan.result}.`);
        return { accepted: true } as const;
      },
    },
    { id: 'observe-live-state', preconditionHash: canonicalJson({ sourceCommit: base.sourceCommit, planFingerprint: base.planFingerprint, applicationId: base.applicationId }), run: async () => applyObserveLiveState({ base, provider: runtime.provider, desired: submitted.desired, context }) },
    {
      id: 'replan-verify',
      preconditionHash: canonicalJson({ sourceCommit: base.sourceCommit, planFingerprint: base.planFingerprint, desiredGeneration: base.desiredGeneration }),
      run: async (_attempt, stepContext) => {
        const live = stepOutput<ObserveLiveStateResult>(stepContext.outputs, 'observe-live-state');
        return applyReplanVerify({ base, store: runtime.store, desired: submitted.desired, observed: live.observed, capabilities: live.capabilities, context });
      },
    },
    {
      id: 'no-destroy-gate',
      preconditionHash: canonicalJson({ planFingerprint: base.planFingerprint }),
      run: async (_attempt, stepContext) => applyNoDestroyGate({ plan: stepOutput<ReplanVerifyResult>(stepContext.outputs, 'replan-verify').plan }),
    },
    { id: 'acquire-locks', preconditionHash: canonicalJson({ applicationId: base.applicationId, planFingerprint: base.planFingerprint, hostnames: submitted.desired.domains.map((domain) => domain.hostname) }), run: async () => applyAcquireLocks({ base, store: runtime.store, desired: submitted.desired }) },
    {
      id: 'ensure-project',
      preconditionHash: canonicalJson({ planFingerprint: base.planFingerprint, sourceCommit: base.sourceCommit }),
      run: async (_attempt, stepContext) => applyEnsureProject({ base, store: runtime.store, provider: runtime.provider, desired: submitted.desired, plan: stepOutput<ReplanVerifyResult>(stepContext.outputs, 'replan-verify').plan, locks: stepOutput<AcquireLocksResult>(stepContext.outputs, 'acquire-locks').locks, context }),
    },
    {
      id: 'ensure-git',
      preconditionHash: canonicalJson({ planFingerprint: base.planFingerprint, sourceCommit: base.sourceCommit }),
      run: async (_attempt, stepContext) => applyEnsureGit({ base, store: runtime.store, provider: runtime.provider, desired: submitted.desired, plan: stepOutput<ReplanVerifyResult>(stepContext.outputs, 'replan-verify').plan, locks: stepOutput<AcquireLocksResult>(stepContext.outputs, 'acquire-locks').locks, context }),
    },
    {
      id: 'ensure-settings',
      preconditionHash: canonicalJson({ planFingerprint: base.planFingerprint, sourceCommit: base.sourceCommit }),
      run: async (_attempt, stepContext) => applyEnsureSettings({ base, store: runtime.store, provider: runtime.provider, desired: submitted.desired, plan: stepOutput<ReplanVerifyResult>(stepContext.outputs, 'replan-verify').plan, locks: stepOutput<AcquireLocksResult>(stepContext.outputs, 'acquire-locks').locks, context }),
    },
    {
      id: 'resolve-secrets',
      preconditionHash: canonicalJson({ applicationId: base.applicationId, bindings: submitted.desired.secrets }),
      run: async () => (runtime.secrets ? applyResolveSecrets({ base, secrets: runtime.secrets, desired: submitted.desired, context }) : { bindings: [] }),
    },
    {
      id: 'ensure-environments',
      preconditionHash: canonicalJson({ planFingerprint: base.planFingerprint, sourceCommit: base.sourceCommit }),
      run: async (_attempt, stepContext) => {
        const bindings = stepOutput<ResolveSecretsResult>(stepContext.outputs, 'resolve-secrets').bindings;
        return applyEnsureEnvironments({ base, store: runtime.store, provider: runtime.provider, desired: submitted.desired, plan: stepOutput<ReplanVerifyResult>(stepContext.outputs, 'replan-verify').plan, locks: stepOutput<AcquireLocksResult>(stepContext.outputs, 'acquire-locks').locks, context, bindings, ...(runtime.secrets !== undefined ? { secrets: runtime.secrets } : {}) });
      },
    },
    {
      id: 'ensure-domains',
      preconditionHash: canonicalJson({ planFingerprint: base.planFingerprint, sourceCommit: base.sourceCommit }),
      run: async (_attempt, stepContext) => applyEnsureDomains({ base, store: runtime.store, provider: runtime.provider, desired: submitted.desired, plan: stepOutput<ReplanVerifyResult>(stepContext.outputs, 'replan-verify').plan, locks: stepOutput<AcquireLocksResult>(stepContext.outputs, 'acquire-locks').locks, projectId: canonicalProjectIdOf(stepContext.outputs, base), context }),
    },
    {
      id: 'ensure-dns',
      preconditionHash: canonicalJson({ planFingerprint: base.planFingerprint, sourceCommit: base.sourceCommit }),
      run: async (_attempt, stepContext) => applyEnsureDns({ base, store: runtime.store, provider: runtime.provider, desired: submitted.desired, plan: stepOutput<ReplanVerifyResult>(stepContext.outputs, 'replan-verify').plan, locks: stepOutput<AcquireLocksResult>(stepContext.outputs, 'acquire-locks').locks, context }),
    },
    {
      id: 'verify-authoritative',
      preconditionHash: canonicalJson({ sourceCommit: base.sourceCommit, hostnames: submitted.desired.domains.map((domain) => domain.hostname) }),
      retry: { maxAttempts: 5, baseDelayMs: 2_000, maxDelayMs: 15_000 },
      run: async () => applyVerifyAuthoritative({ base, provider: runtime.provider, desired: submitted.desired, context }),
    },
    {
      id: 'verify-vercel-domain',
      preconditionHash: canonicalJson({ sourceCommit: base.sourceCommit, hostnames: submitted.desired.domains.map((domain) => domain.hostname) }),
      retry: { maxAttempts: 5, baseDelayMs: 5_000, maxDelayMs: 30_000 },
      run: async (_attempt, stepContext) => applyVerifyVercelDomain({ base, provider: runtime.provider, desired: submitted.desired, projectId: canonicalProjectIdOf(stepContext.outputs, base), context }),
    },
    {
      id: 'verify-tls',
      preconditionHash: canonicalJson({ sourceCommit: base.sourceCommit, hostnames: submitted.desired.domains.map((domain) => domain.hostname) }),
      retry: { maxAttempts: 5, baseDelayMs: 5_000, maxDelayMs: 30_000 },
      run: async () => applyVerifyTls({ base, provider: runtime.provider, desired: submitted.desired, context }),
    },
    {
      id: 'create-candidate',
      preconditionHash: canonicalJson({ sourceCommit: base.sourceCommit, desiredGeneration: base.desiredGeneration, planFingerprint: base.planFingerprint }),
      run: async (_attempt, stepContext) => applyCreateCandidate({ base, store: runtime.store, provider: runtime.provider, desired: submitted.desired, plan: stepOutput<ReplanVerifyResult>(stepContext.outputs, 'replan-verify').plan, locks: stepOutput<AcquireLocksResult>(stepContext.outputs, 'acquire-locks').locks, context, projectId: canonicalProjectIdOf(stepContext.outputs, base) }),
    },
    {
      id: 'wait-candidate',
      preconditionHash: canonicalJson({ sourceCommit: base.sourceCommit }),
      retry: { maxAttempts: 3, baseDelayMs: 5_000, maxDelayMs: 30_000 },
      run: async (_attempt, stepContext) => applyWaitCandidate({ base, store: runtime.store, provider: runtime.provider, desired: submitted.desired, candidate: stepOutput<CreateCandidateResult>(stepContext.outputs, 'create-candidate').candidate, context, projectId: canonicalProjectIdOf(stepContext.outputs, base) }),
    },
    {
      id: 'proxy-compatibility',
      preconditionHash: canonicalJson({ sourceCommit: base.sourceCommit }),
      run: async (_attempt, stepContext) => applyProxyCompatibility({ base, provider: runtime.provider, desired: submitted.desired, candidate: stepOutput<WaitCandidateResult>(stepContext.outputs, 'wait-candidate').candidate, context }),
    },
    {
      id: 'candidate-health',
      preconditionHash: canonicalJson({ sourceCommit: base.sourceCommit }),
      run: async (_attempt, stepContext) => applyCandidateHealth({ base, store: runtime.store, desired: submitted.desired, candidate: stepOutput<WaitCandidateResult>(stepContext.outputs, 'wait-candidate').candidate, context, ...(runtime.fetchImpl !== undefined ? { fetchImpl: runtime.fetchImpl } : {}), ...(runtime.sleep !== undefined ? { sleep: runtime.sleep } : {}) }),
    },
    {
      id: 'promote',
      preconditionHash: canonicalJson({ sourceCommit: base.sourceCommit, planFingerprint: base.planFingerprint }),
      run: async (_attempt, stepContext) => applyPromote({ base, store: runtime.store, provider: runtime.provider, desired: submitted.desired, plan: stepOutput<ReplanVerifyResult>(stepContext.outputs, 'replan-verify').plan, candidate: stepOutput<WaitCandidateResult>(stepContext.outputs, 'wait-candidate').candidate, locks: stepOutput<AcquireLocksResult>(stepContext.outputs, 'acquire-locks').locks, context, projectId: canonicalProjectIdOf(stepContext.outputs, base) }),
    },
    {
      id: 'production-health',
      preconditionHash: canonicalJson({ sourceCommit: base.sourceCommit }),
      run: async (_attempt, stepContext) => applyProductionHealth({ base, store: runtime.store, desired: submitted.desired, candidate: stepOutput<PromotePhaseResult>(stepContext.outputs, 'promote').promotion.deployment, context, ...(runtime.fetchImpl !== undefined ? { fetchImpl: runtime.fetchImpl } : {}), ...(runtime.sleep !== undefined ? { sleep: runtime.sleep } : {}) }),
    },
    {
      id: 'record-known-good',
      preconditionHash: canonicalJson({ sourceCommit: base.sourceCommit }),
      run: async (_attempt, stepContext) => applyRecordKnownGood({ base, store: runtime.store, desired: submitted.desired, candidate: stepOutput<PromotePhaseResult>(stepContext.outputs, 'promote').promotion.deployment, productionHealth: stepOutput<ProductionHealthResult>(stepContext.outputs, 'production-health').health, context }),
    },
    {
      id: 'report',
      preconditionHash: canonicalJson({ sourceCommit: base.sourceCommit }),
      run: async (_attempt, stepContext) => {
        const promotion = stepOutput<PromotePhaseResult>(stepContext.outputs, 'promote').promotion.deployment;
        const candidateHealth = stepOutput<CandidateHealthResult>(stepContext.outputs, 'candidate-health').health;
        const productionHealth = stepOutput<ProductionHealthResult>(stepContext.outputs, 'production-health').health;
        const summary: ApplyReportSummary = {
          applicationId: base.applicationId,
          sourceCommit: base.sourceCommit,
          desiredGeneration: base.desiredGeneration,
          planFingerprint: base.planFingerprint,
          candidateId: promotion.id,
          candidateHealth,
          productionHealth,
          status: 'SUCCEEDED',
          errorCode: null,
          rollback: null,
          restored: false,
        };
        return applyReport({ base, store: runtime.store, summary, context });
      },
    },
  ];

  const onFailure = async (failure: { failedStep: string; error: unknown; outputs: Readonly<Record<string, unknown>> }): Promise<unknown> => {
    const live = tryStepOutput<ObserveLiveStateResult>(failure.outputs, 'observe-live-state');
    const promotion = tryStepOutput<PromotePhaseResult>(failure.outputs, 'promote');
    const waited = tryStepOutput<WaitCandidateResult>(failure.outputs, 'wait-candidate');
    const created = tryStepOutput<CreateCandidateResult>(failure.outputs, 'create-candidate');
    const productionHealth = tryStepOutput<ProductionHealthResult>(failure.outputs, 'production-health');
    return applyRecoverOnFailure({
      base, store: runtime.store, provider: runtime.provider, desired: submitted.desired, context, failure,
      candidate: promotion?.promotion.deployment ?? waited?.candidate ?? created?.candidate ?? null,
      knownGood: live ? knownGoodOf(live.observed) : null,
      productionHealth: productionHealth?.health ?? null,
      projectId: canonicalProjectIdOf(failure.outputs, base),
      ...(runtime.fetchImpl !== undefined ? { fetchImpl: runtime.fetchImpl } : {}),
      ...(runtime.sleep !== undefined ? { sleep: runtime.sleep } : {}),
    });
  };

  const releaseLocks = async (): Promise<void> => {
    await releaseOwnedLocks(runtime.store, base.applicationId, submitted.desired.domains.map((domain) => domain.hostname), base.workflowId);
  };

  return { steps, onFailure, releaseLocks };
}

/** Runs a single durable phase through the store (controller internal dispatch path). */
export async function runApplyPhase(input: { store: LaunchpadStore; base: ApplyBase; context: ProviderContext; step: DurableStep; sleep?: (delayMs: number) => Promise<void> }, options: { complete?: boolean } = {}): Promise<StepOutcome> {
  const runner = new DurableOperationRunner(input.store);
  // Hydrate the persisted outputs of prior phases (the composed-machine path
  // rehydrates through the runner; the per-phase dispatch path must too, or
  // steps reading prior outputs — e.g. the canonical project id observed by
  // ensure-project — silently fall back to their defaults). Steps persist
  // under the run id, which is the deterministic idempotency-derived id the
  // runner's startRun produces — never the workflow instance id.
  const runId = stableId('workflow-run', input.base.applicationId, input.base.idempotencyKey);
  const outputs: Record<string, unknown> = {};
  for (const row of await input.store.listWorkflowSteps(runId)) {
    if (row.status === 'SUCCEEDED' && row.result !== null && row.result !== undefined) outputs[row.stepId] = row.result;
  }
  return runner.executeStep({ applicationId: input.base.applicationId, workflowId: input.base.workflowId, action: 'APPLY', idempotencyKey: input.base.idempotencyKey, payloadHash: input.base.payloadHash, steps: [input.step], ...(input.sleep !== undefined ? { sleep: input.sleep } : {}) }, input.step, outputs, options);
}

export async function runApplyWorkflow(input: ApplyWorkflowInput): Promise<ApplyWorkflowResult> {
  const base = await makeApplyBase({ applicationId: input.desired.metadata.id, sourceCommit: input.sourceCommit, planFingerprint: input.plan.fingerprint, desiredGeneration: input.plan.desiredGeneration, idempotencyKey: idempotencyKey('apply', input.desired.metadata.id, input.sourceCommit, String(input.plan.desiredGeneration)), workflowId: input.context.workflowId });
  const runtime: ApplyRuntime = { store: input.store, provider: input.provider, ...(input.secrets !== undefined ? { secrets: input.secrets } : {}), ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}), ...(input.sleep !== undefined ? { sleep: input.sleep } : {}) };
  const machine = buildApplyMachine({ runtime, base, submitted: { desired: input.desired, observed: input.observed, plan: input.plan }, context: input.context });
  const runner = new DurableOperationRunner(input.store);
  const run = await runner.run({ applicationId: base.applicationId, workflowId: base.workflowId, action: 'APPLY', idempotencyKey: base.idempotencyKey, payloadHash: base.payloadHash, steps: machine.steps, onFailure: machine.onFailure, releaseLocks: machine.releaseLocks, ...(input.sleep !== undefined ? { sleep: input.sleep } : {}) });
  return applyWorkflowResult(run);
}

function applyWorkflowResult(run: OperationRunResult): ApplyWorkflowResult {
  const outputs = run.outputs;
  const promotion = tryStepOutput<PromotePhaseResult>(outputs, 'promote');
  const waited = tryStepOutput<WaitCandidateResult>(outputs, 'wait-candidate');
  const created = tryStepOutput<CreateCandidateResult>(outputs, 'create-candidate');
  const candidate = promotion?.promotion.deployment ?? waited?.candidate ?? created?.candidate ?? null;
  const candidateHealth = tryStepOutput<CandidateHealthResult>(outputs, 'candidate-health')?.health ?? null;
  const productionHealth = tryStepOutput<ProductionHealthResult>(outputs, 'production-health')?.health ?? null;
  return { status: run.status, operationId: run.operationId, candidate, candidateHealth, productionHealth, rollback: rollbackFromRecovery(run.recovery), errorCode: errorCodeOf(run.error) };
}

function rollbackFromRecovery(recovery: unknown): RollbackResult | null {
  if (recovery === null || typeof recovery !== 'object' || !('rollback' in recovery)) return null;
  const value = recovery.rollback;
  if (value === null || typeof value !== 'object' || !('deploymentId' in value) || !('restored' in value)) return null;
  return { deploymentId: String(value.deploymentId), restored: value.restored === true };
}
