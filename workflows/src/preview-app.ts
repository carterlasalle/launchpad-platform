import type { DeploymentRecord, DesiredApplication, HealthCheckRecord, HealthSpec, PlatformPlan } from '@launchpad/core';
import { checkHealth } from '@launchpad/health';
import { canonicalJson, idempotencyKey, isRetryableError, SensitiveValue, stableId } from '@launchpad/shared';
import type { CleanupJobRecord, LaunchpadStore, ResourceRecord, WorkflowRunRecord, WorkflowStatus, WorkflowStepRecord } from '@launchpad/database';
import type { DeploymentLogExcerpt, EnvironmentSpec, ProjectProvider, ProjectSpec, ProviderContext, SourceProvider } from '@launchpad/provider-contract';

/**
 * Durable shadow-preview workflow (master plan 8.3, 10.2, 13.4, 22.2).
 *
 * A catalog PR revision is deployed to an isolated shadow project that
 * receives only the proposed framework/root/commands/runtime and preview-safe
 * environment data. Every stage (validate, supersede, create, settings,
 * deploy, poll, logs, gate, health, report, cleanup) is independently
 * resumable: start/attempt/result/error state persists through
 * `LaunchpadStore` workflow steps, and a completed step is skipped on resume
 * while its preconditions are unchanged. Shadow project, deployment,
 * PR-revision, TTL, operation, and cleanup data all live in D1.
 *
 * Status machine (22.2): QUEUED -> CREATING_SHADOW_PROJECT ->
 * APPLYING_PROPOSED_SETTINGS -> CREATING_DEPLOYMENT -> WAITING_FOR_BUILD ->
 * CHECKING_HEALTH -> REPORTING -> READY. Failures move the run to FAILED with
 * a stable error code; superseded revisions are CANCELED; cleanup runs move
 * CLEANUP_PENDING -> CLEANED (or FAILED, visibly).
 */

// ---------------------------------------------------------------------------
// Failure and naming helpers
// ---------------------------------------------------------------------------

class WorkflowFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = code;
    this.code = code;
  }
}

const MAX_STEP_ATTEMPTS = 3;
const DEFAULT_RETENTION_HOURS = 24;
const MAX_LOG_LINES = 50;
const MAX_LOG_BYTES = 4096;

function sanitizeNamePart(value: string): string {
  // Single linear pass: split on any run of non-alphanumeric characters,
  // drop empties, join with '-'. No regex alternation or repetition that
  // could backtrack super-linearly on hostile input (CodeQL poly-redos).
  return value.toLowerCase().split(/[^a-z0-9-]+/).filter((part) => part.length > 0).join('-');
}

/**
 * Deterministic, collision-resistant shadow project name (TR-PRV-001): tied to
 * repository ID, PR number, application ID, and revision, plus a short commit
 * so two runs of the same revision never alias each other. Always <= 63 chars.
 */
export function shadowProjectName(input: { applicationId: string; pullRequestNumber: number; repositoryId: number; revision: number; commitSha: string }): string {
  const applicationId = sanitizeNamePart(input.applicationId).slice(0, 20) || 'app';
  const pullRequestNumber = String(input.pullRequestNumber).slice(0, 6) || '0';
  const repositoryId = String(input.repositoryId).slice(0, 12);
  const commitSha = input.commitSha.slice(0, 8) || 'none';
  const revision = String(input.revision).slice(0, 4);
  return `lp-pr-${pullRequestNumber}-${applicationId}-${repositoryId}-${commitSha}-${revision}`;
}

function expiresAtIso(now: Date, retentionHours: number): string {
  return new Date(now.getTime() + retentionHours * 60 * 60 * 1000).toISOString();
}

function errorName(error: unknown): string {
  return error instanceof WorkflowFailure ? error.code : error instanceof Error ? error.name : 'LP-WORKFLOW-STEP-FAILED';
}

function serializeError(error: unknown): { name: string; message: string } {
  return error instanceof Error ? { name: errorName(error), message: error.message } : { name: 'LP-WORKFLOW-STEP-FAILED', message: 'Unknown failure' };
}

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

export interface PreviewWorkflowInput {
  /** Section-23 store; D1 in production, in-memory in tests. */
  store: LaunchpadStore;
  provider: ProjectProvider;
  /** Used to resolve the GitHub repository ID when the payload does not carry one. */
  source?: SourceProvider | undefined;
  /** Proposed catalog state; only preview-safe data is applied to the shadow project. */
  desired: DesiredApplication;
  pullRequestNumber: number;
  /** GitHub numeric repository ID; resolved via `source` when absent. */
  repositoryId?: number | undefined;
  revision: number;
  /** Exact PR commit the preview deployment must target. */
  sourceCommit: string;
  /** Plan binding: the preview fails stale when a stored plan disagrees. */
  planFingerprint: string;
  /** Optional full plan; when present its binding is verified before any write. */
  plan?: PlatformPlan | undefined;
  idempotencyKey: string;
  context: ProviderContext;
  fetchImpl?: typeof fetch | undefined;
  sleep?: ((delayMs: number) => Promise<void>) | undefined;
  resolveSecret?: ((reference: string) => Promise<string>) | undefined;
  now?: (() => Date) | undefined;
}

export interface PreviewWorkflowResult {
  workflowId: string;
  status: 'READY' | 'FAILED' | 'CANCELED';
  projectId: string;
  projectName: string;
  deployment: DeploymentRecord | null;
  health: HealthCheckRecord | null;
  buildLogExcerpt: string | null;
  logTruncated: boolean;
  errorCode: string | null;
  cleanupJobId: string | null;
}

export interface CleanupInput {
  store: LaunchpadStore;
  provider: ProjectProvider;
  context: ProviderContext;
  applicationId: string;
  projectId: string;
  providerResourceId: string;
  reason: 'SUPERSEDED' | 'PR_CLOSED' | 'PR_MERGED' | 'TTL_EXPIRED' | 'ORPHAN';
  /** Deterministic cleanup-job id when the job was enqueued by this workflow. */
  cleanupJobId?: string | undefined;
  now?: (() => Date) | undefined;
}

export interface CleanupResult {
  projectId: string;
  status: 'CLEANED' | 'FAILED';
  errorCode: string | null;
  message: string;
  cleanupJobId: string | null;
}

export interface CleanupSweepResult {
  cleaned: string[];
  failed: Array<{ projectId: string; errorCode: string; message: string }>;
}

export interface PullRequestCleanupInput {
  store: LaunchpadStore;
  provider: ProjectProvider;
  context: ProviderContext;
  applicationId: string;
  pullRequestNumber: number;
  reason: 'PR_CLOSED' | 'PR_MERGED';
  now?: (() => Date) | undefined;
}

// ---------------------------------------------------------------------------
// Static secret-target rejection (TR-PRV-003)
// ---------------------------------------------------------------------------

/**
 * Statically rejects production-only secret targets before any provider write.
 * A preview environment variable may only reference a binding that includes
 * 'preview' in its environments; a production-only binding referenced by a
 * preview variable fails the preview. Unknown secret refs fail closed.
 */
export function previewEnvironmentVariables(desired: DesiredApplication): Record<string, string | { secretRef: string; sensitive: true }> {
  const variables = desired.environments.preview?.variables ?? {};
  const bindings = new Map(desired.secrets.map((binding) => [binding.name, binding]));
  const output: Record<string, string | { secretRef: string; sensitive: true }> = {};
  for (const [name, value] of Object.entries(variables)) {
    const binding = bindings.get(name);
    if (binding && !binding.environments.includes('preview')) {
      throw new WorkflowFailure('LP-PREVIEW-PRODUCTION-SECRET-REJECTED', `Environment variable '${name}' targets secret '${binding.source ?? name}' which is not preview-safe (environments: ${binding.environments.join(', ')}); previews may only receive preview-safe environment data.`);
    }
    if (typeof value === 'object' && value !== null && !bindings.has(value.secretRef)) {
      throw new WorkflowFailure('LP-PREVIEW-SECRET-UNKNOWN', `Environment variable '${name}' references secret '${value.secretRef}' which is not declared in the application manifest.`);
    }
    output[name] = value;
  }
  return output;
}

async function resolvePreviewVariables(desired: DesiredApplication, resolveSecret: ((reference: string) => Promise<string>) | undefined): Promise<Record<string, SensitiveValue<unknown> | string>> {
  const declared = previewEnvironmentVariables(desired);
  const resolved: Record<string, SensitiveValue<unknown> | string> = {};
  for (const [name, value] of Object.entries(declared)) {
    if (typeof value === 'string') {
      resolved[name] = value;
    } else {
      const binding = desired.secrets.find((candidate) => candidate.name === value.secretRef);
      const reference = binding?.source ?? value.secretRef;
      if (!resolveSecret) throw new WorkflowFailure('LP-PREVIEW-SECRET-UNAVAILABLE', `Environment variable '${name}' needs secret '${reference}' but no secret resolver is configured for the preview workflow.`);
      resolved[name] = new SensitiveValue(await resolveSecret(reference));
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Store-backed step runner (durable, resumable)
// ---------------------------------------------------------------------------

interface PreviewStage {
  id: string;
  status: WorkflowStatus;
  preconditionHash: string;
  run: () => Promise<unknown>;
}

async function findRunByIdempotencyKey(store: LaunchpadStore, applicationId: string, key: string): Promise<WorkflowRunRecord | null> {
  const runs = await store.listWorkflowRuns(applicationId);
  return runs.find((run) => run.idempotencyKey === key) ?? null;
}

async function ensureApplicationRow(store: LaunchpadStore, desired: DesiredApplication, revision: number, planFingerprint: string): Promise<void> {
  const existing = await store.getApplication(desired.metadata.id);
  if (existing) return;
  await store.upsertApplication({
    id: desired.metadata.id,
    displayName: desired.metadata.displayName,
    sourcePath: desired.sourcePath ?? `catalog/apps/${desired.metadata.id}`,
    desiredGeneration: revision,
    desiredHash: planFingerprint,
    syncStatus: 'UNKNOWN',
    healthStatus: 'UNKNOWN',
    lifecycleState: 'active',
    owners: desired.metadata.owners,
  });
}

async function startOrResumeRun(input: PreviewWorkflowInput): Promise<WorkflowRunRecord> {
  const existing = await findRunByIdempotencyKey(input.store, input.desired.metadata.id, input.idempotencyKey);
  if (existing) return existing;
  return input.store.startWorkflowRun({
    applicationId: input.desired.metadata.id,
    workflowType: 'PREVIEW',
    idempotencyKey: input.idempotencyKey,
    payloadHash: canonicalJson({ planFingerprint: input.planFingerprint, sourceCommit: input.sourceCommit, revision: input.revision, pullRequestNumber: input.pullRequestNumber }),
  });
}

async function runStages(store: LaunchpadStore, run: WorkflowRunRecord, stages: PreviewStage[]): Promise<{ failed: boolean; failedStep: string | null; error: unknown }> {
  for (const stage of stages) {
    await store.updateWorkflowRun(run.id, { status: stage.status });
    const existing = await store.getWorkflowStep(run.id, stage.id);
    if (existing?.status === 'SUCCEEDED' && existing.preconditionHash === stage.preconditionHash) continue;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt += 1) {
      await store.recordWorkflowStep({ workflowId: run.id, stepId: stage.id, status: 'RUNNING', attempt, preconditionHash: stage.preconditionHash });
      try {
        const result = await stage.run();
        await store.recordWorkflowStep({ workflowId: run.id, stepId: stage.id, status: 'SUCCEEDED', attempt, preconditionHash: stage.preconditionHash, result });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        const retryable = isRetryableError(error);
        await store.recordWorkflowStep({ workflowId: run.id, stepId: stage.id, status: retryable && attempt < MAX_STEP_ATTEMPTS ? 'RETRYING' : 'FAILED', attempt, preconditionHash: stage.preconditionHash, error: serializeError(error) });
        if (!retryable || attempt === MAX_STEP_ATTEMPTS) break;
      }
    }
    if (lastError !== null) return { failed: true, failedStep: stage.id, error: lastError };
  }
  return { failed: false, failedStep: null, error: null };
}

function stepResult(step: WorkflowStepRecord | null): unknown {
  return step?.result ?? null;
}

// ---------------------------------------------------------------------------
// Shadow project spec
// ---------------------------------------------------------------------------

function shadowProjectSpec(input: PreviewWorkflowInput, projectName: string, repositoryId: number, retentionHours: number, expiresAt: string): ProjectSpec {
  const project = input.desired.vercel.project;
  return {
    id: projectName,
    name: projectName,
    teamId: null,
    framework: project.framework,
    rootDirectory: project.rootDirectory,
    nodeVersion: project.nodeVersion,
    build: {
      installCommand: project.build.installCommand,
      buildCommand: project.build.buildCommand,
      outputDirectory: project.build.outputDirectory,
    },
    repository: input.desired.repository.name,
    productionBranch: input.desired.repository.productionBranch,
    settings: {
      ...project.settings,
      launchpadShadow: true,
      launchpadApplicationId: input.desired.metadata.id,
      launchpadPullRequest: input.pullRequestNumber,
      launchpadRepositoryId: repositoryId,
      launchpadRepository: input.desired.repository.name,
      launchpadRevision: input.revision,
      launchpadCommit: input.sourceCommit,
      launchpadExpiresAt: expiresAt,
      launchpadRetentionHours: retentionHours,
    },
  };
}

function cleanupJobIdFor(applicationId: string, providerResourceId: string, expiresAt: string): string {
  return stableId('cleanup-job', applicationId, providerResourceId, expiresAt);
}

/**
 * Launchpad shadow-metadata readback. Adapters echo the launchpad settings in
 * two shapes: nested under `configuration.settings` (Vercel project responses
 * per the recorded-sandbox contract) or flattened into the configuration root
 * (the testkit projection). Ownership and expiry must be honored whichever
 * shape the observing adapter returned, so both are read here.
 */
/**
 * Ownership of a shadow project is derived from its collision-resistant name
 * (lp-pr-<pr>-<app>-<repoId>-<commit>-<rev>): the Vercel project API exposes
 * no arbitrary metadata fields, so the name itself is the only provider-side
 * ownership evidence. The parsed segment is sanitized exactly like
 * shadowProjectName sanitizes it, so comparisons are lossless.
 */
function shadowProjectApplicationId(projectName: string): string | null {
  const segments = projectName.split('-');
  if (segments.length < 6 || segments[0] !== 'lp' || segments[1] !== 'pr') return null;
  if (!/^\d+$/.test(segments[2] ?? '')) return null;
  // The trailing segments are fixed-shape (repoId-commit-revision), so the
  // application id is everything between them — which keeps sanitized ids
  // containing dashes (e.g. `my-app`) parseable.
  const repoId = segments[segments.length - 3] ?? '';
  const commit = segments[segments.length - 2] ?? '';
  const revision = segments[segments.length - 1] ?? '';
  if (!/^\d+$/.test(repoId) || !/^(?:[0-9a-f]{8}|none)$/.test(commit) || !/^\d+$/.test(revision)) return null;
  const applicationId = segments.slice(3, segments.length - 3).join('-');
  return applicationId.length > 0 ? applicationId : null;
}

// ---------------------------------------------------------------------------
// Cleanup machinery
// ---------------------------------------------------------------------------

async function findActiveShadowResources(store: LaunchpadStore, applicationId: string, pullRequestNumber: number): Promise<ResourceRecord[]> {
  const resources = await store.listResources(applicationId);
  return resources.filter((resource) => resource.resourceType === 'vercel.shadow-project' && resource.status === 'ACTIVE' && resource.resourceKey.startsWith(`lp-pr-${pullRequestNumber}-`));
}

async function cancelRunForResource(store: LaunchpadStore, applicationId: string, resource: ResourceRecord, errorCode: string, completedAt: string): Promise<void> {
  if (!resource.observedHash) return;
  const run = await findRunByIdempotencyKey(store, applicationId, resource.observedHash);
  if (run && !['READY', 'FAILED', 'CANCELED', 'SUCCEEDED', 'CLEANED'].includes(run.status)) {
    await store.updateWorkflowRun(run.id, { status: 'CANCELED', completedAt, errorCode });
  }
}

async function enqueueCleanup(store: LaunchpadStore, applicationId: string, providerResourceId: string, expiresAt: string): Promise<CleanupJobRecord> {
  return store.enqueueCleanupJob({ id: cleanupJobIdFor(applicationId, providerResourceId, expiresAt), applicationId, providerResourceId, expiresAt });
}

/**
 * Durably deletes one owned shadow project. The cleanup job (when provided)
 * is claimed and completed so attempts and failures stay visible; retryable
 * provider errors are retried with bounded attempts, and exhaustion leaves a
 * FAILED job that the daily orphan sweep re-attempts. A project that is
 * already absent is reported CLEANED.
 */
export async function cleanupShadowProject(input: CleanupInput): Promise<CleanupResult> {
  const now = input.now ?? (() => new Date());
  const workflowId = stableId('preview-cleanup', input.applicationId, input.providerResourceId);
  const run = await input.store.startWorkflowRun({
    applicationId: input.applicationId,
    workflowType: 'PREVIEW_CLEANUP',
    idempotencyKey: workflowId,
    payloadHash: canonicalJson({ projectId: input.projectId, providerResourceId: input.providerResourceId, reason: input.reason }),
  });
  await input.store.updateWorkflowRun(run.id, { status: 'CLEANUP_PENDING' });
  const cleanupJobId = input.cleanupJobId ?? null;
  let claimed = false;
  try {
    if (cleanupJobId) {
      try {
        await input.store.claimCleanupJob(cleanupJobId);
        claimed = true;
      } catch {
        claimed = false;
      }
    }
    const existing = await input.provider.observeProject({ projectId: input.projectId }, input.context);
    if (existing === null) {
      if (claimed && cleanupJobId) await input.store.completeCleanupJob(cleanupJobId, 'SUCCEEDED', null);
      await input.store.updateWorkflowRun(run.id, { status: 'CLEANED', completedAt: now().toISOString() });
      await input.store.appendAudit({ actor: input.context.actor.id, action: 'PREVIEW_CLEANUP', applicationId: input.applicationId, details: { projectId: input.projectId, providerResourceId: input.providerResourceId, reason: input.reason, result: 'CLEANED', message: 'Shadow project was already absent.' } });
      return { projectId: input.projectId, status: 'CLEANED', errorCode: null, message: 'Shadow project was already absent.', cleanupJobId };
    }
    const owner = shadowProjectApplicationId(input.projectId);
    if (owner === null || owner !== sanitizeNamePart(input.applicationId).slice(0, 20)) {
      const message = `Shadow project '${input.projectId}' is owned by '${owner ?? '(unknown)'}', not '${input.applicationId}'; refusing to delete an unowned resource.`;
      if (claimed && cleanupJobId) await input.store.completeCleanupJob(cleanupJobId, 'FAILED', message);
      await input.store.updateWorkflowRun(run.id, { status: 'FAILED', completedAt: now().toISOString(), errorCode: 'LP-PREVIEW-CLEANUP-UNOWNED' });
      await input.store.appendAudit({ actor: input.context.actor.id, action: 'PREVIEW_CLEANUP', applicationId: input.applicationId, details: { projectId: input.projectId, providerResourceId: input.providerResourceId, reason: input.reason, result: 'FAILED', errorCode: 'LP-PREVIEW-CLEANUP-UNOWNED' } });
      return { projectId: input.projectId, status: 'FAILED', errorCode: 'LP-PREVIEW-CLEANUP-UNOWNED', message, cleanupJobId };
    }
    let lastError: string | null = null;
    for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt += 1) {
      try {
        await input.provider.deleteProject(input.providerResourceId, input.context);
        lastError = null;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Shadow project deletion failed.';
        if (!isRetryableError(error) || attempt === MAX_STEP_ATTEMPTS) break;
      }
    }
    if (lastError !== null) throw new Error(lastError);
    await input.store.releaseResource('vercel', input.providerResourceId, now().toISOString());
    if (claimed && cleanupJobId) await input.store.completeCleanupJob(cleanupJobId, 'SUCCEEDED', null);
    await input.store.updateWorkflowRun(run.id, { status: 'CLEANED', completedAt: now().toISOString() });
    await input.store.appendAudit({ actor: input.context.actor.id, action: 'PREVIEW_CLEANUP', applicationId: input.applicationId, details: { projectId: input.projectId, providerResourceId: input.providerResourceId, reason: input.reason, result: 'CLEANED' } });
    return { projectId: input.projectId, status: 'CLEANED', errorCode: null, message: 'Shadow project deleted.', cleanupJobId };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Shadow project cleanup failed.';
    if (cleanupJobId) {
      try {
        await input.store.completeCleanupJob(cleanupJobId, 'FAILED', message);
      } catch {
        // The job may be claimed elsewhere; the workflow run below still records the failure.
      }
    }
    await input.store.updateWorkflowRun(run.id, { status: 'FAILED', completedAt: now().toISOString(), errorCode: 'LP-PREVIEW-CLEANUP-FAILED' });
    await input.store.appendAudit({ actor: input.context.actor.id, action: 'PREVIEW_CLEANUP', applicationId: input.applicationId, details: { projectId: input.projectId, providerResourceId: input.providerResourceId, reason: input.reason, result: 'FAILED', errorCode: 'LP-PREVIEW-CLEANUP-FAILED', message } });
    return { projectId: input.projectId, status: 'FAILED', errorCode: 'LP-PREVIEW-CLEANUP-FAILED', message, cleanupJobId };
  }
}

/**
 * Cleans every active shadow project for a closed/merged pull request.
 * Failures remain visible in cleanup jobs, workflow runs, and audit events.
 */
export async function cleanupPreviewForPullRequest(input: PullRequestCleanupInput): Promise<{ cleaned: string[]; failed: Array<{ projectId: string; errorCode: string; message: string }> }> {
  const now = input.now ?? (() => new Date());
  const resources = await findActiveShadowResources(input.store, input.applicationId, input.pullRequestNumber);
  const cleaned: string[] = [];
  const failed: Array<{ projectId: string; errorCode: string; message: string }> = [];
  for (const resource of resources) {
    await input.store.releaseResource('vercel', resource.providerResourceId, now().toISOString());
    await cancelRunForResource(input.store, input.applicationId, resource, 'LP-PREVIEW-SUPERSEDED', now().toISOString());
    const expiresAt = now().toISOString();
    await enqueueCleanup(input.store, input.applicationId, resource.providerResourceId, expiresAt);
    const result = await cleanupShadowProject({ store: input.store, provider: input.provider, context: input.context, applicationId: input.applicationId, projectId: resource.resourceKey, providerResourceId: resource.providerResourceId, reason: input.reason, cleanupJobId: cleanupJobIdFor(input.applicationId, resource.providerResourceId, expiresAt), now: input.now });
    if (result.status === 'CLEANED') cleaned.push(resource.resourceKey);
    else failed.push({ projectId: resource.resourceKey, errorCode: result.errorCode ?? 'LP-PREVIEW-CLEANUP-FAILED', message: result.message });
  }
  return { cleaned, failed };
}

/**
 * Daily orphan sweep: deletes expired shadow projects that still exist on the
 * provider (tracked or leaked), releases their tracking, completes their
 * cleanup jobs, and completes the bookkeeping for jobs whose projects are
 * already gone. Failures are returned and recorded, never swallowed.
 */
export async function sweepExpiredPreviewResources(input: { store: LaunchpadStore; provider: ProjectProvider; context: ProviderContext; now?: Date }): Promise<CleanupSweepResult> {
  const now = input.now ?? new Date();
  const cleaned: string[] = [];
  const failed: Array<{ projectId: string; errorCode: string; message: string }> = [];
  const providerProjects = await input.provider.listOwnedShadowProjects(input.context);
  const jobs = new Map<string, CleanupJobRecord>();
  for (const application of await input.store.listApplications()) {
    for (const job of await input.store.listCleanupJobs(application.application)) {
      jobs.set(job.providerResourceId, job);
    }
  }
  for (const project of providerProjects) {
    // The durable cleanup job is the only reliable expiry evidence: the
    // provider API stores no metadata on the project itself, so a project
    // without a job can never be proven expired or owned. Such projects are
    // left untouched rather than force-deleted.
    const job = jobs.get(project.providerResourceId) ?? null;
    if (job === null || new Date(job.expiresAt).getTime() > now.getTime()) continue;
    const result = await cleanupShadowProject({
      store: input.store,
      provider: input.provider,
      context: input.context,
      applicationId: job.applicationId,
      projectId: project.resourceKey,
      providerResourceId: project.providerResourceId,
      reason: 'TTL_EXPIRED',
      cleanupJobId: job.id,
      now: () => now,
    });
    if (result.status === 'CLEANED') cleaned.push(project.resourceKey);
    else failed.push({ projectId: project.resourceKey, errorCode: result.errorCode ?? 'LP-PREVIEW-CLEANUP-FAILED', message: result.message });
  }
  // Bookkeeping pass: complete due jobs whose provider resource is already gone.
  for (const application of await input.store.listApplications()) {
    for (const job of await input.store.listCleanupJobs(application.application)) {
      if (job.status !== 'QUEUED' && job.status !== 'RUNNING') continue;
      if (new Date(job.expiresAt).getTime() > now.getTime()) continue;
      const resource = await input.store.getResource('vercel', job.providerResourceId);
      if (resource && resource.status === 'ACTIVE') continue;
      try {
        await input.store.completeCleanupJob(job.id, 'SUCCEEDED', null);
      } catch {
        // Not claimable (claimed elsewhere or already finished) — nothing to do.
      }
    }
  }
  return { cleaned, failed };
}

// ---------------------------------------------------------------------------
// Durable preview stages
// ---------------------------------------------------------------------------

function previewHealth(desired: DesiredApplication): HealthSpec {
  return desired.environments.preview?.health ?? { path: '/api/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 10, attempts: 1, intervalSeconds: 0 };
}

function buildStages(input: PreviewWorkflowInput, runId: string, repositoryId: number): { stages: PreviewStage[]; projectName: string; retentionHours: number } {
  const desired = input.desired;
  const retentionHours = desired.environments.preview?.cleanup?.retentionHours ?? DEFAULT_RETENTION_HOURS;
  const now = input.now ?? (() => new Date());
  const projectName = shadowProjectName({ applicationId: desired.metadata.id, pullRequestNumber: input.pullRequestNumber, repositoryId, revision: input.revision, commitSha: input.sourceCommit });
  const health = previewHealth(desired);

  const stages: PreviewStage[] = [
    {
      id: 'validate',
      status: 'VALIDATING',
      preconditionHash: canonicalJson({ planFingerprint: input.planFingerprint, sourceCommit: input.sourceCommit, revision: input.revision, pullRequestNumber: input.pullRequestNumber }),
      run: async () => {
        if (input.plan) {
          if (input.plan.applicationId !== desired.metadata.id || input.plan.sourceCommit !== input.sourceCommit || input.plan.fingerprint !== input.planFingerprint || input.plan.desiredGeneration !== input.revision) {
            throw new WorkflowFailure('LP-PLAN-STALE', 'The approved plan does not bind this application, commit, generation, and fingerprint.');
          }
        } else {
          const stored = await input.store.getPlanByFingerprint(desired.metadata.id, input.planFingerprint);
          if (stored && (stored.sourceCommit !== input.sourceCommit || stored.plan.desiredGeneration !== input.revision)) {
            throw new WorkflowFailure('LP-PLAN-STALE', 'The stored plan for this fingerprint does not bind the requested commit and generation.');
          }
        }
        previewEnvironmentVariables(desired);
        return { projectName, repositoryId, retentionHours, expiresAt: expiresAtIso(now(), retentionHours) };
      },
    },
    {
      id: 'supersede',
      status: 'CREATING_SHADOW_PROJECT',
      preconditionHash: canonicalJson({ pullRequestNumber: input.pullRequestNumber, revision: input.revision, sourceCommit: input.sourceCommit }),
      run: async () => {
        const prior = (await findActiveShadowResources(input.store, desired.metadata.id, input.pullRequestNumber)).filter((resource) => resource.observedHash !== input.idempotencyKey && resource.resourceKey !== projectName);
        for (const resource of prior) {
          await input.store.releaseResource('vercel', resource.providerResourceId, now().toISOString());
          await cancelRunForResource(input.store, desired.metadata.id, resource, 'LP-PREVIEW-SUPERSEDED', now().toISOString());
          const jobExpiresAt = now().toISOString();
          await enqueueCleanup(input.store, desired.metadata.id, resource.providerResourceId, jobExpiresAt);
          const cleanup = await cleanupShadowProject({ store: input.store, provider: input.provider, context: input.context, applicationId: desired.metadata.id, projectId: resource.resourceKey, providerResourceId: resource.providerResourceId, reason: 'SUPERSEDED', cleanupJobId: cleanupJobIdFor(desired.metadata.id, resource.providerResourceId, jobExpiresAt), now: input.now });
          if (cleanup.status !== 'CLEANED') {
            throw new WorkflowFailure('LP-PREVIEW-SUPERSEDE-CLEANUP-FAILED', `Prior revision preview '${resource.resourceKey}' could not be cleaned: ${cleanup.message}`);
          }
        }
        return { superseded: prior.map((resource) => resource.resourceKey) };
      },
    },
    {
      id: 'create-shadow-project',
      status: 'CREATING_SHADOW_PROJECT',
      preconditionHash: canonicalJson({ projectName, repositoryId, revision: input.revision, sourceCommit: input.sourceCommit, retentionHours }),
      run: async () => {
        const validation = stepResult(await input.store.getWorkflowStep(runId, 'validate')) as { expiresAt: string } | null;
        const expiresAt = validation?.expiresAt ?? expiresAtIso(now(), retentionHours);
        const spec = shadowProjectSpec(input, projectName, repositoryId, retentionHours, expiresAt);
        const created = await input.provider.ensureProject(spec, input.context);
        await input.store.upsertResource({
          applicationId: desired.metadata.id,
          provider: 'vercel',
          resourceType: 'vercel.shadow-project',
          resourceKey: projectName,
          providerResourceId: created.resource.providerResourceId,
          desiredGeneration: input.revision,
          observedHash: input.idempotencyKey,
          ownershipFingerprint: created.resource.ownershipFingerprint ?? projectName,
        });
        return { projectId: projectName, providerResourceId: created.resource.providerResourceId };
      },
    },
    {
      id: 'apply-settings',
      status: 'APPLYING_PROPOSED_SETTINGS',
      preconditionHash: canonicalJson({ projectName, repository: desired.repository.name, productionBranch: desired.repository.productionBranch, variables: desired.environments.preview?.variables ?? {} }),
      run: async () => {
        const created = stepResult(await input.store.getWorkflowStep(runId, 'create-shadow-project')) as { projectId: string; providerResourceId: string } | null;
        const projectId = created?.projectId ?? projectName;
        await input.provider.ensureGitConnection({ projectId, repository: desired.repository.name, productionBranch: desired.repository.productionBranch }, input.context);
        const variables = await resolvePreviewVariables(desired, input.resolveSecret);
        const environment: EnvironmentSpec = { projectId, environment: 'preview', branch: null, variables };
        await input.provider.ensureEnvironment(environment, input.context);
        return { projectId, environment: 'preview', variables: Object.keys(variables) };
      },
    },
    {
      id: 'create-deployment',
      status: 'CREATING_DEPLOYMENT',
      preconditionHash: canonicalJson({ projectName, sourceCommit: input.sourceCommit, revision: input.revision, repository: desired.repository.name }),
      run: async () => {
        const buildCommit = await resolvePreviewBuildCommit(input);
        const deployment = await input.provider.createDeployment({ projectId: projectName, environment: 'preview', repository: desired.repository.name, commitSha: buildCommit, desiredGeneration: input.revision, staged: false, rootDirectory: desired.vercel.project.rootDirectory }, input.context);
        if (deployment.commitSha !== buildCommit) throw new WorkflowFailure('LP-VERCEL-DEPLOYMENT-COMMIT-MISMATCH', `Deployment '${deployment.id}' targets commit ${deployment.commitSha}, not ${buildCommit}.`);
        await input.store.recordDeployment({ id: deployment.id, applicationId: desired.metadata.id, projectId: projectName, environment: 'preview', repository: desired.repository.name, commitSha: deployment.commitSha, desiredGeneration: input.revision, state: deployment.state, url: deployment.url });
        return deployment;
      },
    },
    {
      id: 'wait-for-build',
      status: 'WAITING_FOR_BUILD',
      preconditionHash: canonicalJson({ projectName, sourceCommit: input.sourceCommit }),
      run: async () => {
        const deployment = stepResult(await input.store.getWorkflowStep(runId, 'create-deployment')) as DeploymentRecord | null;
        if (!deployment) throw new WorkflowFailure('LP-PREVIEW-DEPLOYMENT-MISSING', 'Preview deployment was not created.');
        const timeoutMs = health.timeoutSeconds * 1000 * Math.max(health.attempts, 1);
        const pollMs = Math.max(100, health.intervalSeconds * 1000);
        const ready = await input.provider.waitForDeployment({ projectId: projectName, deploymentId: deployment.id, timeoutMs, pollMs }, input.context);
        if (!['READY', 'ERROR', 'CANCELED'].includes(ready.state)) throw new WorkflowFailure('LP-VERCEL-DEPLOYMENT-TIMEOUT', `Deployment '${deployment.id}' did not reach a terminal state (last state: ${ready.state}).`);
        return { deployment: ready, terminal: ready.state };
      },
    },
    {
      id: 'collect-build-logs',
      status: 'WAITING_FOR_BUILD',
      preconditionHash: canonicalJson({ projectName, sourceCommit: input.sourceCommit }),
      run: async () => {
        const waited = stepResult(await input.store.getWorkflowStep(runId, 'wait-for-build')) as { deployment: DeploymentRecord; terminal: string } | null;
        if (!waited || waited.terminal === 'READY') return { excerpt: null, truncated: false };
        if (!input.provider.fetchDeploymentLogs) return { excerpt: null, truncated: false, unavailable: 'provider does not expose deployment logs' };
        const logs = await input.provider.fetchDeploymentLogs({ deploymentId: waited.deployment.id, maxLines: MAX_LOG_LINES, maxBytes: MAX_LOG_BYTES }, input.context);
        return { excerpt: redactBuildLog(logs, desired), truncated: logs.truncated };
      },
    },
    {
      id: 'build-gate',
      status: 'WAITING_FOR_BUILD',
      preconditionHash: canonicalJson({ projectName, sourceCommit: input.sourceCommit }),
      run: async () => {
        const waited = stepResult(await input.store.getWorkflowStep(runId, 'wait-for-build')) as { deployment: DeploymentRecord; terminal: string } | null;
        const state = waited?.terminal ?? 'READY';
        if (state === 'READY') return { state };
        const logs = stepResult(await input.store.getWorkflowStep(runId, 'collect-build-logs')) as { excerpt: string | null; truncated: boolean } | null;
        const excerpt = logs?.excerpt ? `\n\nBuild log excerpt:\n${logs.excerpt}` : '';
        throw new WorkflowFailure('LP-VERCEL-BUILD-FAILED', `Preview build ended in ${state} for commit ${input.sourceCommit}.${excerpt}`);
      },
    },
    {
      id: 'health-check',
      status: 'CHECKING_HEALTH',
      preconditionHash: canonicalJson({ projectName, sourceCommit: input.sourceCommit, health }),
      run: async () => {
        const waited = stepResult(await input.store.getWorkflowStep(runId, 'wait-for-build')) as { deployment: DeploymentRecord; terminal: string } | null;
        const deployment = waited?.deployment ?? null;
        if (!deployment || !deployment.url) throw new WorkflowFailure('LP-PREVIEW-DEPLOYMENT-URL-MISSING', 'The provider returned no deployment URL to health-check; refusing to check a guessed domain.');
        const check = await checkHealth({ applicationId: desired.metadata.id, environment: 'preview', deploymentId: deployment.id, baseUrl: deployment.url, spec: health, fetchImpl: input.fetchImpl, sleep: input.sleep });
        // The checker records the exact probed endpoint (base + health path);
        // the persisted evidence contract keys preview health checks to the
        // deployment base URL, so the record is normalized before persistence.
        const normalized: HealthCheckRecord = check.url !== deployment.url ? { ...check, url: deployment.url } : check;
        await input.store.recordHealthCheck(normalized);
        if (normalized.result !== 'PASSED') throw new WorkflowFailure('LP-HEALTH-PREVIEW-FAILED', `Preview health check failed against ${deployment.url}: ${normalized.errorCode ?? 'assertion failure'}.`);
        return normalized;
      },
    },
    {
      id: 'report',
      status: 'REPORTING',
      preconditionHash: canonicalJson({ projectName, sourceCommit: input.sourceCommit }),
      run: async () => {
        const waited = stepResult(await input.store.getWorkflowStep(runId, 'wait-for-build')) as { deployment: DeploymentRecord; terminal: string } | null;
        const deployment = waited?.deployment ?? null;
        const health = stepResult(await input.store.getWorkflowStep(runId, 'health-check')) as HealthCheckRecord | null;
        if (deployment) {
          await input.store.recordDeployment({ id: deployment.id, applicationId: desired.metadata.id, projectId: projectName, environment: 'preview', repository: desired.repository.name, commitSha: deployment.commitSha, desiredGeneration: input.revision, state: deployment.state, url: deployment.url });
        }
        await input.store.appendAudit({ actor: input.context.actor.id, action: 'PREVIEW_REPORT', applicationId: desired.metadata.id, details: { projectName, deploymentId: deployment?.id ?? null, commitSha: input.sourceCommit, revision: input.revision, health: health?.result ?? null, errorCode: null } });
        return { projectName, deploymentId: deployment?.id ?? null, health: health?.result ?? null };
      },
    },
    {
      id: 'schedule-cleanup',
      status: 'CLEANUP_PENDING',
      preconditionHash: canonicalJson({ projectName, sourceCommit: input.sourceCommit, retentionHours }),
      run: async () => {
        const created = stepResult(await input.store.getWorkflowStep(runId, 'create-shadow-project')) as { projectId: string; providerResourceId: string } | null;
        const providerResourceId = created?.providerResourceId ?? projectName;
        const validation = stepResult(await input.store.getWorkflowStep(runId, 'validate')) as { expiresAt: string } | null;
        const expiresAt = validation?.expiresAt ?? expiresAtIso(now(), retentionHours);
        const job = await enqueueCleanup(input.store, desired.metadata.id, providerResourceId, expiresAt);
        return { cleanupJobId: job.id, expiresAt };
      },
    },
  ];
  return { stages, projectName, retentionHours };
}

/**
 * Bounded redaction for build log excerpts (TR-PRV-005): known preview
 * environment values are never echoed back into reports.
 */
export function redactBuildLog(excerpt: DeploymentLogExcerpt, desired: DesiredApplication): string {
  const secrets = new Set<string>();
  for (const binding of desired.secrets) {
    if (binding.environments.includes('preview') && typeof binding.value === 'string' && binding.value.length > 0) secrets.add(binding.value);
  }
  for (const value of Object.values(desired.environments.preview?.variables ?? {})) {
    if (typeof value === 'string' && value.length > 0) secrets.add(value);
  }
  let output = excerpt.excerpt;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    output = output.split(secret).join('[REDACTED]');
  }
  return output.slice(0, MAX_LOG_BYTES);
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * The shadow preview builds the APPLICATION repository at its production
 * branch HEAD. The catalog PR commit lives in the control repository and
 * does not exist in the application repository, so it can never be the
 * deployment target; the source provider resolves the real app commit.
 */
async function resolvePreviewBuildCommit(input: PreviewWorkflowInput): Promise<string> {
  const source = input.source;
  if (!source || typeof source.resolveRef !== 'function') {
    throw new WorkflowFailure('LP-PREVIEW-COMMIT-UNRESOLVABLE', `The application repository branch '${input.desired.repository.productionBranch}' could not be resolved for the shadow preview; a source provider with ref resolution is required.`);
  }
  const ref = await source.resolveRef(input.desired.repository.name, input.desired.repository.productionBranch, input.context);
  const sha = ref?.sha;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new WorkflowFailure('LP-PREVIEW-COMMIT-UNRESOLVABLE', `The application repository '${input.desired.repository.name}' did not resolve to a valid commit for the shadow preview.`);
  }
  return sha;
}

async function resolveRepositoryId(input: PreviewWorkflowInput): Promise<number> {
  if (typeof input.repositoryId === 'number' && input.repositoryId > 0) return input.repositoryId;
  if (input.source) {
    const observed = await input.source.observeRepository(input.desired.repository.name, input.context);
    if (observed.repositoryId > 0) return observed.repositoryId;
  }
  return 0;
}

export async function runPreviewWorkflow(input: PreviewWorkflowInput): Promise<PreviewWorkflowResult> {
  const now = input.now ?? (() => new Date());
  await ensureApplicationRow(input.store, input.desired, input.revision, input.planFingerprint);
  const repositoryId = await resolveRepositoryId(input);
  const run = await startOrResumeRun(input);
  if (repositoryId <= 0) {
    await input.store.updateWorkflowRun(run.id, { status: 'FAILED', completedAt: now().toISOString(), errorCode: 'LP-PREVIEW-REPOSITORY-ID-UNRESOLVED' });
    return { workflowId: run.id, status: 'FAILED', projectId: '', projectName: '', deployment: null, health: null, buildLogExcerpt: null, logTruncated: false, errorCode: 'LP-PREVIEW-REPOSITORY-ID-UNRESOLVED', cleanupJobId: null };
  }
  const { stages, projectName } = buildStages(input, run.id, repositoryId);
  const outcome = await runStages(input.store, run, stages);
  const deployment = (stepResult(await input.store.getWorkflowStep(run.id, 'wait-for-build')) as { deployment: DeploymentRecord } | null)?.deployment ?? null;
  const health = (stepResult(await input.store.getWorkflowStep(run.id, 'health-check')) as HealthCheckRecord | null) ?? (await input.store.listHealthChecks(input.desired.metadata.id, { environment: 'preview', limit: 1 }))[0] ?? null;
  const logs = stepResult(await input.store.getWorkflowStep(run.id, 'collect-build-logs')) as { excerpt: string | null; truncated: boolean } | null;
  const cleanup = stepResult(await input.store.getWorkflowStep(run.id, 'schedule-cleanup')) as { cleanupJobId: string } | null;
  if (outcome.failed) {
    const errorCode = errorName(outcome.error);
    await input.store.updateWorkflowRun(run.id, { status: 'FAILED', completedAt: now().toISOString(), errorCode });
    return {
      workflowId: run.id,
      status: 'FAILED',
      projectId: projectName,
      projectName,
      deployment,
      health: health ?? null,
      buildLogExcerpt: logs?.excerpt ?? null,
      logTruncated: logs?.truncated ?? false,
      errorCode,
      cleanupJobId: cleanup?.cleanupJobId ?? null,
    };
  }
  await input.store.updateWorkflowRun(run.id, { status: 'READY', completedAt: now().toISOString(), errorCode: null });
  return {
    workflowId: run.id,
    status: 'READY',
    projectId: projectName,
    projectName,
    deployment,
    health: health ?? null,
    buildLogExcerpt: logs?.excerpt ?? null,
    logTruncated: logs?.truncated ?? false,
    errorCode: null,
    cleanupJobId: cleanup?.cleanupJobId ?? null,
  };
}

/**
 * Executes exactly one durable preview stage and returns its persisted result.
 * Used by the controller's `PreviewApplicationWorkflow` instance, where every
 * `step.do` boundary maps to one stage; results are re-read from the store, so
 * a resumed instance never repeats a completed stage.
 */
export async function runPreviewStage(input: PreviewWorkflowInput & { stage: string }): Promise<unknown> {
  await ensureApplicationRow(input.store, input.desired, input.revision, input.planFingerprint);
  const repositoryId = await resolveRepositoryId(input);
  const run = await startOrResumeRun(input);
  if (repositoryId <= 0) throw new WorkflowFailure('LP-PREVIEW-REPOSITORY-ID-UNRESOLVED', `Repository ID for '${input.desired.repository.name}' is required for a collision-resistant shadow project name.`);
  const { stages } = buildStages(input, run.id, repositoryId);
  const stage = stages.find((candidate) => candidate.id === input.stage);
  if (!stage) throw new WorkflowFailure('LP-PREVIEW-STAGE-UNKNOWN', `Unknown preview stage '${input.stage}'.`);
  const outcome = await runStages(input.store, run, [stage]);
  if (outcome.failed) {
    await input.store.updateWorkflowRun(run.id, { status: 'FAILED', completedAt: (input.now?.() ?? new Date()).toISOString(), errorCode: errorName(outcome.error) });
    throw outcome.error;
  }
  // The staged machine's terminal boundary is the final stage (schedule-cleanup);
  // only then is the run finished and pollable as READY. Intermediate stages
  // keep their granular status so claim-scoped polls never see a false terminal.
  const finalStage = stages.at(-1)?.id;
  if (finalStage !== undefined && stage.id === finalStage) {
    await input.store.updateWorkflowRun(run.id, { status: 'READY', completedAt: (input.now?.() ?? new Date()).toISOString(), errorCode: null });
  }
  return stepResult(await input.store.getWorkflowStep(run.id, stage.id));
}
