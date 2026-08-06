import { expect, it } from 'vitest';
import { FakeProvider } from '@launchpad/provider-testkit';
import { InMemoryLaunchpadStore } from '@launchpad/database';
import { stableId } from '@launchpad/shared';
import type { DesiredApplication, DeploymentRecord, HealthSpec, PlatformPlan } from '@launchpad/core';
import { ProviderRequestError, type DeploymentLogRequest, type DeploymentLogExcerpt, type ProjectProvider, type ProviderContext } from '@launchpad/provider-contract';
import { cleanupPreviewForPullRequest, cleanupShadowProject, runPreviewStage, runPreviewWorkflow, shadowProjectName, sweepExpiredPreviewResources } from './index.js';
import { redactBuildLog } from './preview-app.js';

/**
 * Recorded-provider contract tests for the shadow preview lifecycle: every
 * stage is driven against a recording fake provider plus the in-memory
 * `LaunchpadStore` (the D1 contract twin), asserting provider call traces,
 * persisted rows, terminal statuses, and visible failures.
 */

const context: ProviderContext = { correlationId: 'corr', applicationId: 'app', workflowId: 'wf', actor: { kind: 'github-actions', id: 'test' }, dryRun: false };
const shaA = 'a'.repeat(40);
const shaB = 'b'.repeat(40);
const health: HealthSpec = { path: '/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 1, attempts: 1, intervalSeconds: 0 };

function desired(overrides: { revision?: number; previewVariables?: Record<string, string | { secretRef: string; sensitive: true }>; secrets?: DesiredApplication['secrets']; cleanup?: { onPrClose: boolean; retentionHours: number } } = {}): DesiredApplication {
  return {
    apiVersion: 'launchpad.dev/v1',
    kind: 'Application',
    metadata: { id: 'app', displayName: 'App', owners: ['@platform'], labels: {}, annotations: {} },
    repository: { provider: 'github', name: 'acme/app', productionBranch: 'main', deploymentRef: 'main' },
    vercel: { scope: {}, project: { name: 'app', framework: 'nextjs', rootDirectory: 'apps/web', nodeVersion: '24.x', build: { installCommand: 'yarn install', buildCommand: 'yarn build', outputDirectory: null, developmentCommand: null, ignoredBuildStep: null }, git: { connected: true, productionBranch: 'main' }, deployment: { autoAssignProductionDomains: false}, regions: { functions: [] }, protection: {}, settings: {} } },
    environments: {
      preview: { enabled: true, ...(overrides.cleanup ? { cleanup: overrides.cleanup } : {}), variables: overrides.previewVariables ?? { PREVIEW_TOKEN: 'preview-only-value' }, health },
      production: { enabled: true, health: { path: '/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 1, attempts: 1, intervalSeconds: 0 }, release: { strategy: 'staged-production', promoteExactBuild: true, autoPromoteAfterChecks: true }, rollback: { enabled: true, onFailedHealthCheck: true, previousKnownGood: true } },
    },
    domains: [{ hostname: 'app.example.com', environment: 'production', cloudflare: { zoneRef: 'config://cloudflare/example.com', mode: 'dns-only', ttl: 'auto' }, redirects: [] }],
    secrets: overrides.secrets ?? [
      { name: 'PREVIEW_TOKEN', source: 'config://preview/preview-token', environments: ['preview'], sensitive: true },
      { name: 'PROD_TOKEN', source: 'config://production/prod-token', environments: ['production'], sensitive: true },
    ],
    dependencies: { applications: [], external: [] },
    policies: { drift: { mode: 'open-pr', checkIntervalMinutes: 30 }, destructiveChanges: { allowInNormalApply: false }, preview: { requiredForMerge: true }, staging: { requiredForProduction: false }, health: { requiredForPromotion: true }, failures: { createIssueAfterFinalRetry: true, notifyOwners: true } },
    lifecycle: { state: 'active', deletionProtection: true, orphanPolicy: 'retain', decommission: { requestedAt: null, deleteAfter: null, approvalToken: null, preserveDeployments: true } },
  };
}

function run(input: { provider?: ProjectProvider; desired?: DesiredApplication; sourceCommit?: string; pullRequestNumber?: number; revision?: number; planFingerprint?: string; store?: InMemoryLaunchpadStore; fetchImpl?: typeof fetch; sleep?: (delayMs: number) => Promise<void>; plan?: PlatformPlan } = {}) {
  const pullRequestNumber = input.pullRequestNumber ?? 42;
  const revision = input.revision ?? 1;
  const sourceCommit = input.sourceCommit ?? shaA;
  return runPreviewWorkflow({
    store: input.store ?? new InMemoryLaunchpadStore(),
    provider: input.provider ?? new FakeProvider(),
    desired: input.desired ?? desired(),
    pullRequestNumber,
    repositoryId: 12345,
    revision,
    sourceCommit,
    planFingerprint: input.planFingerprint ?? 'fp-1',
    plan: input.plan,
    idempotencyKey: `preview:app:${pullRequestNumber}:${revision}:${sourceCommit.slice(0, 8)}`,
    context,
    fetchImpl: input.fetchImpl ?? (async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 })),
    sleep: input.sleep ?? (async () => undefined),
  });
}

/** Provider whose preview build always ends in ERROR and exposes redactable build logs. */
class FailingBuildProvider extends FakeProvider {
  readonly logExcerpts = new Map<string, string>();
  override async createDeployment(request: Parameters<FakeProvider['createDeployment']>[0], ctx: ProviderContext): Promise<DeploymentRecord> {
    const deployment = await super.createDeployment(request, ctx);
    const failed = { ...deployment, state: 'ERROR' as const };
    this.deployments.set(failed.id, failed);
    this.logExcerpts.set(failed.id, "npm error ENOENT: no such file or directory, open '/vercel/path0/package.json'\nVERCEL_PREVIEW_TOKEN=preview-only-value\n");
    return failed;
  }
  override async waitForDeployment(request: Parameters<FakeProvider['waitForDeployment']>[0], ctx: ProviderContext): Promise<DeploymentRecord> {
    const deployment = this.deployments.get(request.deploymentId);
    if (!deployment) throw new Error('Fake deployment does not exist');
    return deployment;
  }
  async fetchDeploymentLogs(request: DeploymentLogRequest, _ctx: ProviderContext): Promise<DeploymentLogExcerpt> {
    return { deploymentId: request.deploymentId, excerpt: this.logExcerpts.get(request.deploymentId) ?? 'no logs', truncated: false };
  }
}

it('creates a tracked shadow preview for the exact commit and health-checks the returned deployment URL', async () => {
  const provider = new FakeProvider();
  const store = new InMemoryLaunchpadStore();
  const urls: string[] = [];
  const result = await run({ provider, store, fetchImpl: async (url) => { urls.push(String(url)); return new Response(JSON.stringify({ status: 'ok' }), { status: 200 }); } });

  expect(result.status).toBe('READY');
  expect(result.projectName).toBe('lp-pr-42-app-12345-aaaaaaaa-1');
  expect(result.projectName.length).toBeLessThanOrEqual(63);
  expect(result.deployment?.commitSha).toBe(shaA);
  expect(result.health?.result).toBe('PASSED');
  expect(result.cleanupJobId).toBeTypeOf('string');
  // Independent health check: the probed URL is the provider-returned deployment URL, never the production domain.
  expect(urls).toHaveLength(1);
  expect(urls[0]).toMatch(/^https:\/\/dpl_[0-9a-f]+\.example\.test\//);
  expect(urls[0]).not.toContain('app.example.com');

  // D1 persistence: application, workflow run, steps, shadow resource, deployment, cleanup job, audit.
  expect((await store.getApplication('app'))?.desiredGeneration).toBe(1);
  const runs = await store.listWorkflowRuns('app');
  const previewRun = runs.find((candidate) => candidate.workflowType === 'PREVIEW');
  expect(previewRun?.status).toBe('READY');
  const steps = await store.listWorkflowSteps(previewRun!.id);
  expect(steps.filter((step) => step.status === 'SUCCEEDED').map((step) => step.stepId)).toEqual(expect.arrayContaining(['validate', 'supersede', 'create-shadow-project', 'apply-settings', 'create-deployment', 'wait-for-build', 'collect-build-logs', 'build-gate', 'health-check', 'report', 'schedule-cleanup']));
  const resources = await store.listResources('app');
  expect(resources).toHaveLength(1);
  expect(resources[0]?.resourceType).toBe('vercel.shadow-project');
  expect(resources[0]?.status).toBe('ACTIVE');
  expect(resources[0]?.ownershipFingerprint).toBeTypeOf('string');
  const deployments = await store.listDeployments('app');
  expect(deployments).toHaveLength(1);
  expect(deployments[0]?.commitSha).toBe(shaA);
  expect(deployments[0]?.url).toBe(result.deployment?.url);
  const jobs = await store.listCleanupJobs('app');
  expect(jobs).toHaveLength(1);
  expect(jobs[0]?.status).toBe('QUEUED');
  expect(new Date(jobs[0]?.expiresAt ?? 0).getTime()).toBeGreaterThan(Date.now());
  expect((await store.listAudit('app')).some((event) => event.action === 'PREVIEW_REPORT')).toBe(true);
});

it('derives deterministic, collision-resistant shadow project names', () => {
  const name = shadowProjectName({ applicationId: 'app', pullRequestNumber: 142, repositoryId: 987654321, revision: 3, commitSha: shaA });
  expect(name).toBe('lp-pr-142-app-987654321-aaaaaaaa-3');
  expect(shadowProjectName({ applicationId: 'app', pullRequestNumber: 142, repositoryId: 987654321, revision: 3, commitSha: shaA })).toBe(name);
  expect(shadowProjectName({ applicationId: 'app', pullRequestNumber: 142, repositoryId: 987654321, revision: 4, commitSha: shaB })).not.toBe(name);
  const long = shadowProjectName({ applicationId: 'an-application-with-a-very-long-name', pullRequestNumber: 999999, repositoryId: 123456789012, revision: 9999, commitSha: shaA });
  expect(long.length).toBeLessThanOrEqual(63);
  expect(long).toMatch(/^lp-pr-/);
  expect(long).toMatch(/^[a-z0-9-]+$/);
});

it('statically rejects a production-only secret target before any provider write', async () => {
  const provider = new FakeProvider();
  const store = new InMemoryLaunchpadStore();
  const result = await run({ provider, store, desired: desired({ previewVariables: { PROD_TOKEN: { secretRef: 'PROD_TOKEN', sensitive: true } } }) });
  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-PREVIEW-PRODUCTION-SECRET-REJECTED');
  expect(provider.calls).toEqual([]);
});

it('fails closed on an undeclared preview secret reference', async () => {
  const provider = new FakeProvider();
  const result = await run({ provider, desired: desired({ previewVariables: { UNKNOWN: { secretRef: 'NOT_DECLARED', sensitive: true } } }) });
  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-PREVIEW-SECRET-UNKNOWN');
  expect(provider.calls).toEqual([]);
});

it('fails visibly when the proposed root is invalid: build ERROR, redacted bounded logs, stable error code', async () => {
  const provider = new FailingBuildProvider();
  const store = new InMemoryLaunchpadStore();
  const result = await run({ provider, store });

  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-VERCEL-BUILD-FAILED');
  expect(result.deployment?.state).toBe('ERROR');
  // Bounded, redacted log excerpt: the preview environment value never leaks.
  expect(result.buildLogExcerpt).toContain('ENOENT');
  expect(result.buildLogExcerpt).not.toContain('preview-only-value');
  expect(result.buildLogExcerpt).toContain('[REDACTED]');
  expect(result.logTruncated).toBe(false);
  expect((await store.getWorkflowRun(result.workflowId))?.status).toBe('FAILED');
  expect((await store.getWorkflowRun(result.workflowId))?.errorCode).toBe('LP-VERCEL-BUILD-FAILED');
  const steps = await store.listWorkflowSteps(result.workflowId);
  expect(steps.find((step) => step.stepId === 'collect-build-logs')?.status).toBe('SUCCEEDED');
  expect(steps.find((step) => step.stepId === 'build-gate')?.status).toBe('FAILED');
});

it('redacts preview environment values from bounded build log excerpts', () => {
  const excerpt = { deploymentId: 'dpl_1', excerpt: 'Building...\nSECRET=preview-only-value\nTOKEN=abc\n', truncated: true };
  const redacted = redactBuildLog(excerpt, desired());
  expect(redacted).not.toContain('preview-only-value');
  expect(redacted).toContain('[REDACTED]');
  expect(redacted).toContain('TOKEN=abc');
  expect(redacted.length).toBeLessThanOrEqual(4096);
});

it('reports a health failure independently of a successful build', async () => {
  const provider = new FakeProvider();
  const store = new InMemoryLaunchpadStore();
  const result = await run({ provider, store, fetchImpl: async () => new Response('down', { status: 500 }) });

  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-HEALTH-PREVIEW-FAILED');
  expect(result.deployment?.state).toBe('READY');
  expect(result.health?.result).toBe('FAILED');
  const checks = await store.listHealthChecks('app');
  expect(checks).toHaveLength(1);
  expect(checks[0]?.result).toBe('FAILED');
  // The persisted preview health check is keyed to the shadow deployment's
  // base URL (never the production domain, never a guessed path).
  expect(checks[0]?.url).toBe(result.deployment?.url);
  expect(checks[0]?.url).not.toContain('app.example.com');
});

/** Provider whose deployment poll always times out (retryable) until it stops failing. */
class TimeoutProvider extends FakeProvider {
  failuresRemaining = 3;
  override async waitForDeployment(request: Parameters<FakeProvider['waitForDeployment']>[0], ctx: ProviderContext): Promise<DeploymentRecord> {
    this.calls.push('waitForDeployment');
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new ProviderRequestError({ code: 'LP-VERCEL-DEPLOYMENT-TIMEOUT', class: 'TIMEOUT', provider: 'vercel', message: 'Deployment did not reach a terminal state.', retryable: true });
    }
    const deployment = this.deployments.get(request.deploymentId);
    if (!deployment) throw new Error('Fake deployment does not exist');
    return deployment;
  }
}

/** Provider whose project deletion can be made to fail a fixed number of times. */
class FailingDeleteProvider extends FakeProvider {
  private readonly deleteFailures: Array<{ code: string; retryable: boolean }> = [];
  failNextDelete(failure: { code: string; retryable: boolean }): void {
    this.deleteFailures.push(failure);
  }
  override async deleteProject(projectId: string, ctx: ProviderContext): Promise<void> {
    const failure = this.deleteFailures.shift();
    if (failure) throw new ProviderRequestError({ code: failure.code, class: failure.retryable ? 'TRANSIENT_PROVIDER' : 'INTERNAL', provider: 'vercel', message: failure.code, retryable: failure.retryable });
    return super.deleteProject(projectId, ctx);
  }
}

it('times out with bounded retries, exhausting attempts and persisting the failure', async () => {
  const provider = new TimeoutProvider();
  const store = new InMemoryLaunchpadStore();
  const result = await run({ provider, store });

  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-VERCEL-DEPLOYMENT-TIMEOUT');
  expect(provider.failuresRemaining).toBe(0);
  const steps = await store.listWorkflowSteps(result.workflowId);
  const waitStep = steps.find((step) => step.stepId === 'wait-for-build');
  expect(waitStep?.status).toBe('FAILED');
  expect(waitStep?.attempt).toBe(3);
  expect(waitStep?.error).toMatchObject({ name: 'LP-VERCEL-DEPLOYMENT-TIMEOUT' });
});

it('supersedes and cleans the prior revision preview before creating the new one', async () => {
  const provider = new FakeProvider();
  const store = new InMemoryLaunchpadStore();
  const first = await run({ provider, store, revision: 1, sourceCommit: shaA, planFingerprint: 'fp-1' });
  const second = await run({ provider, store, revision: 2, sourceCommit: shaB, planFingerprint: 'fp-2' });

  expect(second.status).toBe('READY');
  expect(first.projectName).not.toBe(second.projectName);
  // The prior shadow project is deleted, not leaked.
  expect(provider.projects.has(first.projectName)).toBe(false);
  expect(provider.projects.has(second.projectName)).toBe(true);
  const resources = await store.listResources('app', { includeReleased: true });
  const firstResource = resources.find((resource) => resource.resourceKey === first.projectName);
  const secondResource = resources.find((resource) => resource.resourceKey === second.projectName);
  expect(firstResource?.status).toBe('RELEASED');
  expect(secondResource?.status).toBe('ACTIVE');
  const runs = await store.listWorkflowRuns('app');
  const firstRun = runs.find((run) => run.id === first.workflowId);
  // The prior revision completed READY; supersession is recorded on its resource and cleanup, not by erasing success.
  expect(firstRun?.status).toBe('READY');
  expect(runs.find((run) => run.id === second.workflowId)?.status).toBe('READY');
  // The superseded cleanup job completed; the new revision scheduled its own TTL job,
  // and the prior revision's original TTL job remains queued for sweep bookkeeping.
  const jobs = await store.listCleanupJobs('app');
  expect(jobs).toHaveLength(3);
  expect(jobs.find((job) => job.status === 'SUCCEEDED')?.providerResourceId).toBe(first.projectName);
  expect(jobs.filter((job) => job.status === 'QUEUED')).toHaveLength(2);
  expect(jobs.filter((job) => job.status === 'QUEUED').every((job) => job.providerResourceId === first.projectName || job.providerResourceId === second.projectName)).toBe(true);
});

it('cleans every active shadow project when the pull request closes', async () => {
  const provider = new FakeProvider();
  const store = new InMemoryLaunchpadStore();
  await run({ provider, store, pullRequestNumber: 7, revision: 1, sourceCommit: shaA });

  const outcome = await cleanupPreviewForPullRequest({ store, provider, context, applicationId: 'app', pullRequestNumber: 7, reason: 'PR_CLOSED' });
  expect(outcome.cleaned).toEqual([expect.stringMatching(/^lp-pr-7-app-/)]);
  expect(outcome.failed).toEqual([]);
  expect(provider.projects.size).toBe(0);
  const resources = await store.listResources('app', { includeReleased: true });
  expect(resources[0]?.status).toBe('RELEASED');
});

it('keeps cleanup failures visible after retries are exhausted', async () => {
  const provider = new FailingDeleteProvider();
  const store = new InMemoryLaunchpadStore();
  await store.upsertApplication({ id: 'app', displayName: 'App', sourcePath: 'catalog/apps/app', desiredGeneration: 1, desiredHash: 'fp-1', syncStatus: 'SYNCED', healthStatus: 'UNKNOWN', lifecycleState: 'active', owners: ['@platform'] });
  const projectName = 'lp-pr-42-app-12345-aaaaaaaa-1';
  await provider.ensureProject({ id: projectName, name: projectName, teamId: null, framework: 'nextjs', rootDirectory: '.', nodeVersion: '24.x', build: { installCommand: null, buildCommand: null, outputDirectory: null }, repository: 'acme/app', productionBranch: 'main', settings: { launchpadShadow: true, launchpadApplicationId: 'app', launchpadPullRequest: 42, launchpadExpiresAt: new Date(Date.now() - 1000).toISOString() } }, context);
  const expiresAt = new Date(Date.now() - 1000).toISOString();
  const job = await store.enqueueCleanupJob({ id: stableId('cleanup-job', 'app', projectName, expiresAt), applicationId: 'app', providerResourceId: projectName, expiresAt });

  // Transient failures: bounded retries eventually succeed and the job completes.
  provider.failNextDelete({ code: 'LP-VERCEL-DELETE-FAILED', retryable: true });
  const recovered = await cleanupShadowProject({ store, provider, context, applicationId: 'app', projectId: projectName, providerResourceId: projectName, reason: 'PR_CLOSED', cleanupJobId: job.id });
  expect(recovered.status).toBe('CLEANED');
  expect((await store.listCleanupJobs('app'))[0]?.status).toBe('SUCCEEDED');

  // Permanent failures: all attempts exhausted, job FAILED with lastError, workflow run FAILED, audit visible.
  const secondName = 'lp-pr-42-app-12345-bbbbbbbb-2';
  await provider.ensureProject({ id: secondName, name: secondName, teamId: null, framework: 'nextjs', rootDirectory: '.', nodeVersion: '24.x', build: { installCommand: null, buildCommand: null, outputDirectory: null }, repository: 'acme/app', productionBranch: 'main', settings: { launchpadShadow: true, launchpadApplicationId: 'app', launchpadPullRequest: 42, launchpadExpiresAt: new Date(Date.now() - 1000).toISOString() } }, context);
  const secondJob = await store.enqueueCleanupJob({ id: stableId('cleanup-job', 'app', secondName, expiresAt), applicationId: 'app', providerResourceId: secondName, expiresAt });
  provider.failNextDelete({ code: 'LP-VERCEL-DELETE-FAILED', retryable: true });
  provider.failNextDelete({ code: 'LP-VERCEL-DELETE-FAILED', retryable: true });
  provider.failNextDelete({ code: 'LP-VERCEL-DELETE-FAILED', retryable: true });
  const exhausted = await cleanupShadowProject({ store, provider, context, applicationId: 'app', projectId: secondName, providerResourceId: secondName, reason: 'PR_CLOSED', cleanupJobId: secondJob.id });
  expect(exhausted.status).toBe('FAILED');
  expect(exhausted.errorCode).toBe('LP-PREVIEW-CLEANUP-FAILED');
  const failedJob = (await store.listCleanupJobs('app')).find((candidate) => candidate.id === secondJob.id);
  expect(failedJob?.status).toBe('FAILED');
  expect(failedJob?.lastError).toBeTypeOf('string');
  expect(provider.projects.has(secondName)).toBe(true);
  expect((await store.listAudit('app')).some((event) => event.action === 'PREVIEW_CLEANUP' && JSON.stringify(event.details).includes('FAILED'))).toBe(true);
  const cleanupRuns = (await store.listWorkflowRuns('app')).filter((candidate) => candidate.workflowType === 'PREVIEW_CLEANUP');
  expect(cleanupRuns.some((candidate) => candidate.status === 'FAILED')).toBe(true);
});

it('cleans shadow projects whose application id contains a dash', async () => {
  const provider = new FakeProvider();
  const store = new InMemoryLaunchpadStore();
  await store.upsertApplication({ id: 'my-app', displayName: 'My App', sourcePath: 'catalog/apps/my-app.yaml', desiredGeneration: 1, desiredHash: '', syncStatus: 'SYNCED', healthStatus: 'UNKNOWN', lifecycleState: 'active', owners: ['@platform'] });
  const projectName = 'lp-pr-7-my-app-12345-aaaaaaaa-1';
  await provider.ensureProject({ id: projectName, name: projectName, teamId: null, framework: 'nextjs', rootDirectory: '.', nodeVersion: '24.x', build: { installCommand: null, buildCommand: null, outputDirectory: null }, repository: 'acme/my-app', productionBranch: 'main', settings: {} }, context);
  const expiresAt = new Date(Date.now() - 1000).toISOString();
  const job = await store.enqueueCleanupJob({ id: stableId('cleanup-job', 'my-app', projectName, expiresAt), applicationId: 'my-app', providerResourceId: projectName, expiresAt });
  const result = await cleanupShadowProject({ store, provider, context, applicationId: 'my-app', projectId: projectName, providerResourceId: projectName, reason: 'PR_CLOSED', cleanupJobId: job.id });
  expect(result.status).toBe('CLEANED');
  expect(provider.projects.has(projectName)).toBe(false);
});

it('sweeps expired shadow projects tracked by cleanup jobs and leaves untracked projects untouched', async () => {
  const provider = new FakeProvider();
  const store = new InMemoryLaunchpadStore();
  const first = await run({ provider, store, pullRequestNumber: 11, revision: 1, sourceCommit: shaA });
  // A leaked expired shadow project with no durable cleanup job: the provider
  // API stores no metadata, so without the job there is no provable expiry or
  // ownership — it must never be force-deleted.
  const untrackedName = 'lp-pr-99-orphan-1-deadbeef-1';
  await provider.ensureProject({ id: untrackedName, name: untrackedName, teamId: null, framework: 'nextjs', rootDirectory: '.', nodeVersion: '24.x', build: { installCommand: null, buildCommand: null, outputDirectory: null }, repository: 'acme/app', productionBranch: 'main', settings: {} }, context);

  const firstSweep = await sweepExpiredPreviewResources({ store, provider, context, now: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000) });
  expect(firstSweep.cleaned).toEqual([first.projectName]);
  expect(firstSweep.failed).toEqual([]);
  expect(provider.projects.has(untrackedName)).toBe(true);
  expect(provider.projects.has(first.projectName)).toBe(false);
  expect((await store.listResources('app', { includeReleased: true })).find((resource) => resource.resourceKey === first.projectName)?.status).toBe('RELEASED');
  expect((await store.listCleanupJobs('app'))[0]?.status).toBe('SUCCEEDED');

  // A leaked project that gains a durable cleanup job IS swept once due.
  const trackedName = 'lp-pr-99-app-1-deadbeef-1';
  await provider.ensureProject({ id: trackedName, name: trackedName, teamId: null, framework: 'nextjs', rootDirectory: '.', nodeVersion: '24.x', build: { installCommand: null, buildCommand: null, outputDirectory: null }, repository: 'acme/app', productionBranch: 'main', settings: {} }, context);
  const expiresAt = new Date(Date.now() - 60_000).toISOString();
  await store.enqueueCleanupJob({ id: stableId('cleanup-job', 'app', trackedName, expiresAt), applicationId: 'app', providerResourceId: trackedName, expiresAt });

  const secondSweep = await sweepExpiredPreviewResources({ store, provider, context, now: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000) });
  expect(secondSweep.cleaned).toContain(trackedName);
  expect(provider.projects.has(trackedName)).toBe(false);
});

it('resumes a restart without duplicate resources or repeated provider writes', async () => {
  const provider = new FakeProvider();
  const store = new InMemoryLaunchpadStore();
  const input = { store, provider, pullRequestNumber: 42, revision: 1, sourceCommit: shaA, planFingerprint: 'fp-1' };
  const first = await run(input);
  expect(first.status).toBe('READY');
  const callsAfterFirst = [...provider.calls];

  const second = await run(input);
  expect(second.status).toBe('READY');
  expect(second.workflowId).toBe(first.workflowId);
  expect(second.deployment?.id).toBe(first.deployment?.id);
  // No duplicate provider writes: completed steps are skipped, not replayed.
  expect(provider.calls.filter((call) => call === 'createDeployment')).toHaveLength(1);
  expect(provider.calls.filter((call) => call === 'ensureProject')).toHaveLength(1);
  expect(provider.calls).toEqual(callsAfterFirst);
  expect(provider.deployments.size).toBe(1);
});

it('executes individual stages durably, resuming without repeating completed ones', async () => {
  const provider = new FakeProvider();
  const store = new InMemoryLaunchpadStore();
  const base = { store, provider, pullRequestNumber: 42, revision: 1, sourceCommit: shaA, planFingerprint: 'fp-1' };
  const validate = await runPreviewStage({ ...base, desired: desired(), repositoryId: 12345, idempotencyKey: 'preview:app:42:1:aaaaaaaa', context, fetchImpl: async () => new Response('ok', { status: 200 }), sleep: async () => undefined, stage: 'validate' });
  expect(validate).toMatchObject({ projectName: 'lp-pr-42-app-12345-aaaaaaaa-1', repositoryId: 12345 });
  expect(provider.calls).toEqual([]);
  await runPreviewStage({ ...base, desired: desired(), repositoryId: 12345, idempotencyKey: 'preview:app:42:1:aaaaaaaa', context, fetchImpl: async () => new Response('ok', { status: 200 }), sleep: async () => undefined, stage: 'create-shadow-project' });
  expect(provider.calls).toEqual(['ensureProject']);

  // The full run then completes the remaining stages without re-running validate/create.
  const result = await run({ provider, store });
  expect(result.status).toBe('READY');
  expect(provider.calls.filter((call) => call === 'ensureProject')).toHaveLength(1);
  expect(provider.calls.filter((call) => call === 'createDeployment')).toHaveLength(1);
  const steps = await store.listWorkflowSteps(result.workflowId);
  expect(steps.find((step) => step.stepId === 'validate')?.attempt).toBe(1);
  expect(steps.find((step) => step.stepId === 'create-shadow-project')?.attempt).toBe(1);
});

it('fails stale plans before any provider write', async () => {
  const provider = new FakeProvider();
  const store = new InMemoryLaunchpadStore();
  await store.upsertApplication({ id: 'app', displayName: 'App', sourcePath: 'catalog/apps/app', desiredGeneration: 1, desiredHash: 'fp-1', syncStatus: 'SYNCED', healthStatus: 'UNKNOWN', lifecycleState: 'active', owners: ['@platform'] });
  const plan: PlatformPlan = { schemaVersion: 'launchpad.plan/v1', applicationId: 'app', desiredGeneration: 1, sourceCommit: shaA, createdAt: '2026-08-04T00:00:00.000Z', capabilitySnapshotHash: 'cap', observedStateHash: 'obs', operations: [], downstreamEffects: [], policyResults: [], fingerprint: 'fp-1', result: 'READY' };
  await store.savePlan({ applicationId: 'app', plan });
  const result = await run({ provider, store, sourceCommit: shaB, planFingerprint: 'fp-1' });
  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-PLAN-STALE');
  expect(provider.calls).toEqual([]);
});
