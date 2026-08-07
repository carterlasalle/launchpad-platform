import { expect, it } from 'vitest';
import { buildPlan, desiredStateHash, planReviewFingerprint, type DesiredApplication, type DeploymentRecord, type FieldCapability, type HealthCheckRecord, type ObservedApplication, type PlatformPlan, type ProviderCapabilities } from '@launchpad/core';
import { FakeProvider } from '@launchpad/provider-testkit';
import { InMemoryLaunchpadStore } from '@launchpad/database';
import { idempotencyKey, sha256Hex, SensitiveValue, stableId } from '@launchpad/shared';
import { applyNoDestroyGate, applyObserveLiveState, applyPromote, applyRecoverOnFailure, applyStep, errorCodeOf, makeApplyBase, runApplyPhase, runApplyWorkflow, WorkflowFailure, type ApplyRuntime, type ApplyWorkflowResult, type EnsureEnvironmentsResult, type HeldLocks, type RecoverOnFailureResult, type ResolveSecretsResult } from './index.js';
import type { ProviderContext, ProxyCompatibilityRequest, ProxyCompatibilityResult, RequiredDnsRecord, SecretProvider } from '@launchpad/provider-contract';

const desired: DesiredApplication = {
  apiVersion: 'launchpad.dev/v1', kind: 'Application', metadata: { id: 'app', displayName: 'App', owners: ['@platform'], labels: {}, annotations: {} }, repository: { provider: 'github', name: 'acme/app', productionBranch: 'main', deploymentRef: 'main' }, vercel: { scope: {}, project: { name: 'app', framework: 'nextjs', rootDirectory: '.', nodeVersion: '24.x', build: { installCommand: 'yarn install', buildCommand: 'yarn build', outputDirectory: null, developmentCommand: null, ignoredBuildStep: null }, git: { connected: true, productionBranch: 'main' }, deployment: { autoAssignProductionDomains: false}, regions: { functions: [] }, protection: {}, settings: {} } }, environments: { preview: { enabled: true, health: { path: '/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 1, attempts: 1, intervalSeconds: 0 } }, production: { enabled: true, health: { path: '/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 1, attempts: 1, intervalSeconds: 0 }, release: { strategy: 'staged-production', promoteExactBuild: true, autoPromoteAfterChecks: true }, rollback: { enabled: true, onFailedHealthCheck: true, previousKnownGood: true } } }, domains: [{ hostname: 'app.example.com', environment: 'production', cloudflare: { zoneRef: 'config://cloudflare/example.com', mode: 'dns-only', ttl: 'auto' }, redirects: [] }], secrets: [], dependencies: { applications: [], external: [] }, policies: { drift: { mode: 'open-pr', checkIntervalMinutes: 30 }, destructiveChanges: { allowInNormalApply: false }, preview: { requiredForMerge: true }, staging: { requiredForProduction: false }, health: { requiredForPromotion: true }, failures: { createIssueAfterFinalRetry: true, notifyOwners: true } }, lifecycle: { state: 'active', deletionProtection: true, orphanPolicy: 'retain', decommission: { requestedAt: null, deleteAfter: null, approvalToken: null, preserveDeployments: true } },
};
const context: ProviderContext = { correlationId: 'corr', applicationId: 'app', workflowId: 'apply-wf', actor: { kind: 'system', id: 'test' }, dryRun: false };
const observed = (): ObservedApplication => ({ applicationId: 'app', observedAt: '2026-08-04T00:00:00.000Z', desiredGeneration: 1, desiredHash: '', observedHash: '', lifecycleState: 'active', resources: [], deployments: [], health: { status: 'UNKNOWN', latest: null } });

const okFetch = async (): Promise<Response> => new Response(JSON.stringify({ status: 'ok' }), { status: 200 });

function capability(requiresRedeploy = false): FieldCapability {
  return { read: true, create: true, update: true, delete: false, requiresRedeploy, destructiveWhenChanged: false };
}

/** Full capability matrix matching the manifest surface, so plans build READY against the fake adapter. */
const FULL_CAPABILITIES: ProviderCapabilities = {
  provider: 'fake', adapterVersion: 'testkit-v1', snapshotHash: 'testkit-full',
  features: { stagedProduction: true, customEnvironment: true, exactPromotion: true },
  fields: {
    'project.name': capability(), 'project.framework': capability(true), 'project.rootDirectory': capability(true), 'project.nodeVersion': capability(true),
    'project.build.installCommand': capability(true), 'project.build.buildCommand': capability(true), 'project.build.outputDirectory': capability(true),
    'project.build.developmentCommand': capability(true), 'project.build.ignoredBuildStep': capability(true),
    'project.settings.autoAssignProductionDomains': capability(),
    'project.regions.functions': capability(true),
    'domain.hostname': capability(), 'domain.environment': capability(), 'domain.canonical': capability(), 'domain.mode': capability(), 'domain.ttl': capability(), 'domain.zoneRef': capability(),
    'dns.record.proxied': capability(), 'dns.record.ttl': capability(), 'dns.record.zoneRef': capability(),
  },
};

function testProvider(): FakeProvider {
  const provider = new FakeProvider();
  provider.capabilities = async () => FULL_CAPABILITIES;
  return provider;
}

const projectSpec = { id: 'app', name: 'app', teamId: null, framework: 'nextjs', rootDirectory: '.', nodeVersion: '24.x', build: { installCommand: 'yarn install', buildCommand: 'yarn build', outputDirectory: null }, repository: 'acme/app', productionBranch: 'main', settings: { autoAssignProductionDomains: false} };

async function seededStore(): Promise<InMemoryLaunchpadStore> {
  const store = new InMemoryLaunchpadStore();
  await store.upsertApplication({ id: 'app', displayName: 'App', sourcePath: 'catalog/apps/app.yaml', desiredGeneration: 1, desiredHash: '', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
  return store;
}

/**
 * Builds the approved plan from the exact live observation the machine will
 * recompute (freshness parity by construction) and records the reviewed-plan
 * attestation for it (the PR-head review evidence the apply gate requires),
 * unless `attest: false` is passed.
 */
async function planFor(provider: FakeProvider, store: InMemoryLaunchpadStore, options: { sourceCommit?: string; desiredOverride?: DesiredApplication; observedOverride?: ObservedApplication; attest?: boolean } = {}): Promise<{ plan: PlatformPlan; observed: ObservedApplication }> {
  const desiredApp = options.desiredOverride ?? desired;
  const sourceCommit = options.sourceCommit ?? 'a'.repeat(40);
  const base = await makeApplyBase({ applicationId: desiredApp.metadata.id, sourceCommit, planFingerprint: 'pending', desiredGeneration: 1, idempotencyKey: idempotencyKey('apply', desiredApp.metadata.id, sourceCommit, '1'), workflowId: 'apply-wf' });
  const live = await applyObserveLiveState({ base, provider, desired: desiredApp, context });
  const observedState = options.observedOverride ?? live.observed;
  const plan = await buildPlan({ desired: desiredApp, observed: observedState, capabilities: live.capabilities, sourceCommit, desiredGeneration: 1, now: '2026-08-04T00:00:00.000Z' });
  if (options.attest !== false) {
    await attestPlan(store, desiredApp, plan, sourceCommit);
  }
  // The observation above is test setup, not the workflow under test: call
  // histories asserted as "before any provider read or write" must measure
  // the apply run itself, so reset the provider call log here.
  provider.calls.length = 0;
  return { plan, observed: observedState };
}

/** Records the reviewed-plan attestation exactly as the PR-head plan workflow would. */
async function attestPlan(store: InMemoryLaunchpadStore, desiredApp: DesiredApplication, plan: PlatformPlan, sourceCommit: string): Promise<void> {
  const [reviewFingerprint, desiredHash] = await Promise.all([planReviewFingerprint(plan), desiredStateHash(desiredApp)]);
  await store.savePlanReviewAttestation({ applicationId: desiredApp.metadata.id, prHeadSourceCommit: sourceCommit, desiredHash, generation: plan.desiredGeneration, planFingerprint: plan.fingerprint, reviewFingerprint, repository: 'acme/app', actor: 'alice', workflowRef: 'acme/app/.github/workflows/apply.yml@refs/heads/main' });
}

function run(store: InMemoryLaunchpadStore, provider: FakeProvider, plan: PlatformPlan, observedState: ObservedApplication, options: { sourceCommit?: string; fetchImpl?: typeof fetch; sleep?: () => Promise<void> } = {}): ReturnType<typeof runApplyWorkflow> {
  return runApplyWorkflow({ store, provider, desired, observed: observedState, plan, sourceCommit: options.sourceCommit ?? plan.sourceCommit, context, fetchImpl: options.fetchImpl ?? okFetch, sleep: options.sleep ?? (async () => undefined) });
}

const WRITE_CALLS = ['ensureProject', 'ensureGitConnection', 'ensureEnvironment', 'ensureDomain', 'ensureRecord', 'createDeployment', 'promote', 'rollback'];

/** Asserts a promise rejects with a WorkflowFailure/ProviderRequestError whose name is the typed code. */
async function expectFailure(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    expect.unreachable(`expected rejection with ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    const failure = error as Error;
    expect(failure.name).toBe(code);
  }
}

it('applies, health-checks, and promotes the exact candidate', async () => {
  const provider = testProvider();
  const store = await seededStore();
  const { plan, observed: observedState } = await planFor(provider, store);
  const result = await run(store, provider, plan, observedState);
  expect(result.status).toBe('SUCCEEDED');
  expect(result.candidate?.commitSha).toBe(plan.sourceCommit);
  expect(result.rollback).toBeNull();
  expect(result.errorCode).toBeNull();
  const promotedId = result.candidate?.id ?? '';
  expect(promotedId).not.toBe('');
  expect(provider.deployments.get(promotedId)?.state).toBe('CURRENT');
  expect((await store.getKnownGoodDeployment('app', 'production'))?.id).toBe(promotedId);
});

it('rejects a stale plan before any provider read or write', async () => {
  const provider = testProvider();
  const store = await seededStore();
  const { plan } = await planFor(provider, store);
  const result = await run(store, provider, plan, observed(), { sourceCommit: 'b'.repeat(40) });
  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-PLAN-STALE');
  expect(provider.calls).toEqual([]);
  expect(await store.getLock('application:app')).toBeNull();
});

it('hydrates prior phase outputs in the per-phase dispatch path (canonical project id for domains)', async () => {
  const provider = testProvider();
  const store = await seededStore();
  const base = await makeApplyBase({ applicationId: 'app', sourceCommit: 'a'.repeat(40), planFingerprint: 'pending', desiredGeneration: 1, idempotencyKey: 'phase-hydration', workflowId: 'apply-phase-hydration' });
  const runtime: ApplyRuntime = { store, provider };
  const plan = await buildPlan({ desired, observed: observed(), capabilities: FULL_CAPABILITIES, sourceCommit: 'a'.repeat(40), desiredGeneration: 1, now: '2026-08-04T00:00:00.000Z' });
  const locks: HeldLocks = { applicationId: 'app', ownerId: 'apply-phase-hydration', leaseSeconds: 900, application: 'application:app', domains: [] };
  const projectStep = applyStep('ensure-project', { base, context, runtime, desired, plan, locks });
  const projectOutcome = await runApplyPhase({ store, base, context, step: projectStep });
  expect(projectOutcome.status).toBe('SUCCEEDED');
  // The persisted readback carries the canonical Vercel project id (the run
  // id is the deterministic idempotency-key-derived workflow id).
  await store.recordWorkflowStep({ workflowId: stableId('workflow-run', 'app', base.idempotencyKey), stepId: 'ensure-project', status: 'SUCCEEDED', attempt: 1, preconditionHash: projectStep.preconditionHash, result: { mutation: { changed: true, operationId: 'op' }, verified: { provider: 'vercel', resourceType: 'vercel.project', resourceKey: 'app', providerResourceId: 'prj_canonical', configuration: { id: 'prj_canonical' }, ownershipFingerprint: 'prj_canonical', observedAt: 't' } } });
  let ensuredProjectId: string | null = null;
  const recording: FakeProvider = new Proxy(provider, {
    get(target, prop, receiver) {
      if (prop === 'ensureDomain') {
        return async (spec: { projectId: string; hostname: string }): Promise<unknown> => {
          ensuredProjectId = spec.projectId;
          return { resource: { provider: 'vercel', resourceType: 'vercel.domain', resourceKey: spec.hostname, providerResourceId: 'dom_1', configuration: { name: spec.hostname, projectId: spec.projectId }, ownershipFingerprint: spec.projectId, observedAt: 't' }, changed: false, operationId: 'op' };
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as FakeProvider;
  const step = applyStep('ensure-domains', { base, context, runtime: { store, provider: recording }, desired, plan, locks });
  const outcome = await runApplyPhase({ store, base, context, step });
  expect(outcome.status).toBe('SUCCEEDED');
  expect(ensuredProjectId).toBe('prj_canonical');
});

it('resumes from persisted granular boundaries without duplicate writes or missing local state', async () => {
  const provider = testProvider();
  const store = await seededStore();
  const { plan, observed: observedState } = await planFor(provider, store);
  provider.failNext('waitForDeployment', { code: 'LP-INTERRUPT', retryable: false });
  const first = await run(store, provider, plan, observedState);
  expect(first.status).toBe('FAILED');
  expect(first.errorCode).toBe('LP-INTERRUPT');
  expect(provider.calls.filter((call) => call === 'createDeployment')).toHaveLength(1);
  // "Worker restart": same store, same idempotency key; completed steps must not re-execute.
  const second = await run(store, provider, plan, observedState);
  expect(second.status).toBe('SUCCEEDED');
  expect(second.operationId).toBe(first.operationId);
  expect(second.candidate?.commitSha).toBe(plan.sourceCommit);
  expect(provider.calls.filter((call) => call === 'createDeployment')).toHaveLength(1);
});

it('resumes a single phase without re-executing completed work after restart', async () => {
  const provider = testProvider();
  const store = await seededStore();
  const base = await makeApplyBase({ applicationId: 'app', sourceCommit: 'a'.repeat(40), planFingerprint: 'fp', desiredGeneration: 1, idempotencyKey: 'phase-restart', workflowId: 'restart-wf' });
  const runtime: ApplyRuntime = { store, provider };
  const plan = await buildPlan({ desired, observed: observed(), capabilities: FULL_CAPABILITIES, sourceCommit: 'a'.repeat(40), desiredGeneration: 1, now: '2026-08-04T00:00:00.000Z' });
  const locks: HeldLocks = { applicationId: 'app', ownerId: 'restart-wf', leaseSeconds: 900, application: 'application:app', domains: [] };
  const step = applyStep('ensure-project', { base, context, runtime, desired, plan, locks });
  const first = await runApplyPhase({ store, base, context, step });
  expect(first.status).toBe('SUCCEEDED');
  expect(provider.calls.filter((call) => call === 'ensureProject')).toHaveLength(1);
  const second = await runApplyPhase({ store, base, context, step });
  expect(second.status).toBe('SUCCEEDED');
  expect(second.result).toEqual(first.result);
  expect(provider.calls.filter((call) => call === 'ensureProject')).toHaveLength(1);
});

it('deduplicates duplicate delivery of the same apply', async () => {
  const provider = testProvider();
  const store = await seededStore();
  const { plan, observed: observedState } = await planFor(provider, store);
  const first = await run(store, provider, plan, observedState);
  const second = await run(store, provider, plan, observedState);
  expect(first.status).toBe('SUCCEEDED');
  expect(second.status).toBe('SUCCEEDED');
  expect(second.operationId).toBe(first.operationId);
  expect(provider.calls.filter((call) => call === 'createDeployment')).toHaveLength(1);
});

it('blocks on application lock conflicts before any provider write', async () => {
  const provider = testProvider();
  const store = await seededStore();
  const { plan, observed: observedState } = await planFor(provider, store);
  await store.acquireLock('application:app', 'other-workflow', 900);
  const result = await run(store, provider, plan, observedState);
  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-LOCK-CONFLICT');
  expect(provider.calls.some((call) => WRITE_CALLS.includes(call))).toBe(false);
});

it('waits out lock contention and proceeds once the holder releases', async () => {
  const provider = testProvider();
  const store = await seededStore();
  const { plan, observed: observedState } = await planFor(provider, store);
  await store.acquireLock('application:app', 'other-workflow', 900);
  let released = false;
  const result = await run(store, provider, plan, observedState, {
    // The first retry backoff releases the competing lock; the retryable
    // acquire then succeeds and the machine proceeds to completion.
    sleep: async () => {
      if (!released) {
        released = true;
        await store.releaseLock('application:app', 'other-workflow');
      }
    },
  });
  expect(result.status).toBe('SUCCEEDED');
  expect(provider.calls).toContain('createDeployment');
  expect(await store.getLock('application:app')).toBeNull();
});

it('blocks on domain lock conflicts and releases locks in failure paths', async () => {
  const provider = testProvider();
  const store = await seededStore();
  const { plan, observed: observedState } = await planFor(provider, store);
  await store.acquireLock('domain:app.example.com', 'other-workflow', 900);
  const result = await run(store, provider, plan, observedState);
  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-LOCK-CONFLICT');
  expect(provider.calls.some((call) => WRITE_CALLS.includes(call))).toBe(false);
  expect(await store.getLock('application:app')).toBeNull();
});

it('retries only typed retryable failures and fails after bounded exhaustion', async () => {
  const provider = testProvider();
  const store = await seededStore();
  const { plan, observed: observedState } = await planFor(provider, store);
  provider.failNext('ensureProject', { code: 'LP-TRANSIENT-1', retryable: true });
  provider.failNext('ensureProject', { code: 'LP-TRANSIENT-2', retryable: true });
  provider.failNext('ensureProject', { code: 'LP-TRANSIENT-3', retryable: true });
  const result = await run(store, provider, plan, observedState);
  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-TRANSIENT-3');
  const operationId = result.operationId ?? '';
  const step = await store.getWorkflowStep(operationId, 'ensure-project');
  expect(step?.status).toBe('FAILED');
  expect(step?.attempt).toBe(3);
  expect(await store.getLock('application:app')).toBeNull();
});

it('does not retry non-retryable failures', async () => {
  const provider = testProvider();
  const store = await seededStore();
  const { plan, observed: observedState } = await planFor(provider, store);
  provider.failNext('ensureProject', { code: 'LP-HARD-FAILURE', retryable: false });
  const result = await run(store, provider, plan, observedState);
  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-HARD-FAILURE');
  const operationId = result.operationId ?? '';
  const step = await store.getWorkflowStep(operationId, 'ensure-project');
  expect(step?.status).toBe('FAILED');
  expect(step?.attempt).toBe(1);
});

it('rejects all normal DESTROY operations before locks or provider writes', async () => {
  const provider = testProvider();
  const store = await seededStore();
  const { plan, observed: observedState } = await planFor(provider, store);
  const destructivePlan: PlatformPlan = {
    ...plan,
    result: 'DESTRUCTIVE',
    operations: [...plan.operations, { id: 'destroy-app', resourceKey: 'application.destroy', provider: 'platform' as const, resourceType: 'application', action: 'DESTROY', before: null, after: null, prerequisites: [], invalidates: [], idempotencyKey: 'destroy', destructive: true, retryClass: 'NONE' as const }],
  };
  await expectFailure(applyNoDestroyGate({ plan: destructivePlan }), 'LP-DESTROY-NORMAL-APPLY-BLOCKED');
  const result = await run(store, provider, destructivePlan, observedState);
  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-PLAN-BLOCKED');
  expect(provider.calls).toEqual([]);
  expect(await store.getLock('application:app')).toBeNull();
});

it('promotes the exact project, environment, repository, commit, and generation', async () => {
  const provider = testProvider();
  const store = await seededStore();
  const { plan } = await planFor(provider, store);
  const base = await makeApplyBase({ applicationId: 'app', sourceCommit: plan.sourceCommit, planFingerprint: plan.fingerprint, desiredGeneration: 1, idempotencyKey: 'promote-test', workflowId: 'promote-wf' });
  const locks: HeldLocks = { applicationId: 'app', ownerId: 'promote-wf', leaseSeconds: 900, application: 'application:app', domains: ['app.example.com'] };
  const mismatched: DeploymentRecord = { id: 'dpl_mismatch', projectId: 'app', environment: 'production', repository: 'acme/app', commitSha: 'd'.repeat(40), desiredGeneration: 1, state: 'STAGED', url: 'https://dpl_mismatch.example.test', createdAt: '2026-08-04T00:00:00.000Z' };
  await expectFailure(applyPromote({ base, store, provider, desired, plan, candidate: mismatched, locks, context }), 'LP-PROMOTION-COMMIT-MISMATCH');
  expect(provider.calls).not.toContain('promote');
  const exact = await provider.createDeployment({ projectId: 'app', environment: 'production', repository: 'acme/app', commitSha: plan.sourceCommit, desiredGeneration: 1, staged: true }, context);
  await store.recordDeployment({ id: exact.id, applicationId: 'app', projectId: 'app', environment: 'production', repository: 'acme/app', commitSha: exact.commitSha, desiredGeneration: 1, state: exact.state, url: exact.url, createdAt: exact.createdAt });
  const promoted = await applyPromote({ base, store, provider, desired, plan, candidate: exact, locks, context });
  expect(promoted.promotion.deployment.state).toBe('CURRENT');
  expect(promoted.promotion.deployment.commitSha).toBe(plan.sourceCommit);
  expect(provider.deployments.get(exact.id)?.state).toBe('CURRENT');
});

it('keeps prior production active when the candidate health gate fails', async () => {
  const provider = testProvider();
  const store = await seededStore();
  await provider.ensureProject(projectSpec, context);
  const previous = await provider.createDeployment({ projectId: 'app', environment: 'production', repository: 'acme/app', commitSha: 'c'.repeat(40), desiredGeneration: 0, staged: false }, context);
  await provider.promote({ projectId: 'app', deploymentId: previous.id, expectedCommitSha: previous.commitSha }, context);
  await store.recordDeployment({ id: previous.id, applicationId: 'app', projectId: 'app', environment: 'production', repository: 'acme/app', commitSha: previous.commitSha, desiredGeneration: 0, state: 'CURRENT', url: previous.url, createdAt: previous.createdAt });
  await store.recordKnownGoodDeployment('app', 'production', previous.id);
  const { plan, observed: observedState } = await planFor(provider, store);
  const result = await run(store, provider, plan, observedState, { fetchImpl: async () => new Response(JSON.stringify({ status: 'bad' }), { status: 500 }) });
  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-HEALTH-CANDIDATE-FAILED');
  expect(result.rollback).toBeNull();
  expect(provider.deployments.get(previous.id)?.state).toBe('CURRENT');
  expect((await store.getKnownGoodDeployment('app', 'production'))?.id).toBe(previous.id);
});

it('fails the release while reporting successful rollback and keeps the original operation failed', async () => {
  const provider = testProvider();
  const store = await seededStore();
  await provider.ensureProject(projectSpec, context);
  const previous = await provider.createDeployment({ projectId: 'app', environment: 'production', repository: 'acme/app', commitSha: 'c'.repeat(40), desiredGeneration: 0, staged: false }, context);
  await provider.promote({ projectId: 'app', deploymentId: previous.id, expectedCommitSha: previous.commitSha }, context);
  await store.recordDeployment({ id: previous.id, applicationId: 'app', projectId: 'app', environment: 'production', repository: 'acme/app', commitSha: previous.commitSha, desiredGeneration: 0, state: 'CURRENT', url: previous.url, createdAt: previous.createdAt });
  await store.recordKnownGoodDeployment('app', 'production', previous.id);
  const { plan, observed: observedState } = await planFor(provider, store);
  // Deterministic by target URL, not call count: the candidate host is
  // healthy, the production domain is degraded, regardless of how many
  // attempts the health check makes (count-based routing flakes under
  // slower CI when retry/attempt interleavings shift).
  const result = await run(store, provider, plan, observedState, { fetchImpl: async (input) => (new URL(String(input)).host === 'app.example.com' ? new Response(JSON.stringify({ status: 'bad' }), { status: 500 }) : new Response(JSON.stringify({ status: 'ok' }), { status: 200 })) });
  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-HEALTH-PRODUCTION-FAILED');
  expect(result.rollback?.restored).toBe(true);
  expect(result.rollback?.deploymentId).toBe(previous.id);
  const operationId = result.operationId ?? '';
  expect((await store.getWorkflowRun(operationId))?.status).toBe('FAILED');
  const recoveryStep = await store.getWorkflowStep(operationId, 'recover-on-failure');
  expect(recoveryStep?.status).toBe('SUCCEEDED');
  expect(recoveryStep?.result).toMatchObject({ recoveryOutcome: { kind: 'ROLLED_BACK', knownGoodId: previous.id } });
  expect((await store.getKnownGoodDeployment('app', 'production'))?.id).toBe(previous.id);
  expect(provider.deployments.get(previous.id)?.state).toBe('CURRENT');
});

const failedHealth = (deploymentId: string): HealthCheckRecord => ({
  id: `h-${deploymentId}`, applicationId: 'app', environment: 'production', deploymentId, url: 'https://app.example.com', attempt: 1, dnsResolved: true, tlsValid: true, statusCode: 503, latencyMs: 12, assertionResults: [], result: 'FAILED', checkedAt: '2026-08-04T00:00:00.000Z', errorCode: 'LP-HEALTH-PRODUCTION-FAILED',
});

const candidateRecord = (): DeploymentRecord => ({ id: 'dpl_candidate', projectId: 'app', environment: 'production', repository: 'acme/app', commitSha: 'a'.repeat(40), desiredGeneration: 1, state: 'READY', url: 'https://dpl_candidate.example.test', createdAt: '2026-08-04T00:00:00.000Z' });

const productionHealthFailure = { failedStep: 'production-health', error: new WorkflowFailure('LP-HEALTH-PRODUCTION-FAILED', 'Production health gate failed.') };

const observedClaim = (id: string): DeploymentRecord => ({ id, projectId: 'app', environment: 'production', repository: 'acme/app', commitSha: 'c'.repeat(40), desiredGeneration: 0, state: 'CURRENT', url: `https://${id}.example.test`, createdAt: '2026-08-04T00:00:00.000Z' });

/** Runs the recovery path directly: the failure is the post-promotion production-health gate. */
async function recoverFor(provider: FakeProvider, store: InMemoryLaunchpadStore, knownGood: DeploymentRecord | null): Promise<RecoverOnFailureResult> {
  const base = await makeApplyBase({ applicationId: 'app', sourceCommit: 'a'.repeat(40), planFingerprint: 'fp', desiredGeneration: 1, idempotencyKey: `recovery-${knownGood?.id ?? 'none'}`, workflowId: 'recovery-wf' });
  return applyRecoverOnFailure({ base, store, provider, desired, context, failure: productionHealthFailure, candidate: candidateRecord(), knownGood, productionHealth: failedHealth('dpl_candidate') });
}

it('recovery rolls back only when the durable known-good record matches the observed pre-promotion CURRENT', async () => {
  const provider = testProvider();
  const store = await seededStore();
  await provider.ensureProject(projectSpec, context);
  const previous = await provider.createDeployment({ projectId: 'app', environment: 'production', repository: 'acme/app', commitSha: 'c'.repeat(40), desiredGeneration: 0, staged: false }, context);
  await provider.promote({ projectId: 'app', deploymentId: previous.id, expectedCommitSha: previous.commitSha }, context);
  await store.recordDeployment({ id: previous.id, applicationId: 'app', projectId: 'app', environment: 'production', repository: 'acme/app', commitSha: previous.commitSha, desiredGeneration: 0, state: 'CURRENT', url: previous.url, createdAt: previous.createdAt });
  await store.recordKnownGoodDeployment('app', 'production', previous.id);
  const recovery = await recoverFor(provider, store, previous);
  expect(recovery.rollback).toEqual({ deploymentId: previous.id, restored: true });
  expect(recovery.recoveryOutcome).toEqual({ kind: 'ROLLED_BACK', rollback: { deploymentId: previous.id, restored: true }, knownGoodId: previous.id });
  expect(provider.calls).toContain('rollback');
  expect((await store.getKnownGoodDeployment('app', 'production'))?.id).toBe(previous.id);
  expect(recovery.summary).toMatchObject({ status: 'FAILED', errorCode: 'LP-HEALTH-PRODUCTION-FAILED', rollback: { deploymentId: previous.id, restored: true } });
});

it('recovery never rolls back when no durable known-good is recorded, even though the observation claims a CURRENT deployment', async () => {
  const provider = testProvider();
  const store = await seededStore();
  const recovery = await recoverFor(provider, store, observedClaim('dpl_observed'));
  expect(recovery.rollback).toBeNull();
  expect(recovery.restored).toBe(false);
  expect(recovery.recoveryOutcome).toEqual({ kind: 'NO_ROLLBACK', reason: 'KNOWN_GOOD_ABSENT' });
  expect(provider.calls).not.toContain('rollback');
  expect(await store.getKnownGoodDeployment('app', 'production')).toBeNull();
  expect(recovery.summary).toMatchObject({ status: 'FAILED', errorCode: 'LP-HEALTH-PRODUCTION-FAILED' });
  const audit = await store.listAudit('app');
  expect(audit.some((event) => {
    if (event.action !== 'APPLY_FAILED' || event.details.errorCode !== 'LP-HEALTH-PRODUCTION-FAILED') return false;
    const outcome = event.details.recoveryOutcome;
    return outcome !== null && typeof outcome === 'object' && 'kind' in outcome && outcome.kind === 'NO_ROLLBACK';
  })).toBe(true);
});

it('recovery never rolls back when the only CURRENT row was written manually and is not the pre-promotion observed CURRENT', async () => {
  const provider = testProvider();
  const store = await seededStore();
  await store.recordDeployment({ id: 'dpl_manual', applicationId: 'app', projectId: 'app', environment: 'production', repository: 'acme/app', commitSha: 'f'.repeat(40), desiredGeneration: 0, state: 'CURRENT', url: 'https://dpl_manual.example.test', createdAt: '2026-08-04T00:00:00.000Z' });
  const recovery = await recoverFor(provider, store, observedClaim('dpl_observed'));
  expect(recovery.rollback).toBeNull();
  expect(recovery.recoveryOutcome).toEqual({ kind: 'NO_ROLLBACK', reason: 'KNOWN_GOOD_MISMATCH' });
  expect(provider.calls).not.toContain('rollback');
  expect((await store.getKnownGoodDeployment('app', 'production'))?.id).toBe('dpl_manual');
  expect(recovery.summary).toMatchObject({ status: 'FAILED', errorCode: 'LP-HEALTH-PRODUCTION-FAILED' });
});

it('recovery never rolls back when the recorded known-good is a different deployment than the observed pre-promotion CURRENT', async () => {
  const provider = testProvider();
  const store = await seededStore();
  await store.recordDeployment({ id: 'dpl_observed', applicationId: 'app', projectId: 'app', environment: 'production', repository: 'acme/app', commitSha: 'c'.repeat(40), desiredGeneration: 0, state: 'READY', url: 'https://dpl_observed.example.test', createdAt: '2026-08-04T00:00:00.000Z' });
  await store.recordDeployment({ id: 'dpl_other', applicationId: 'app', projectId: 'app', environment: 'production', repository: 'acme/app', commitSha: 'e'.repeat(40), desiredGeneration: 1, state: 'READY', url: 'https://dpl_other.example.test', createdAt: '2026-08-04T00:00:00.000Z' });
  await store.recordKnownGoodDeployment('app', 'production', 'dpl_other');
  const recovery = await recoverFor(provider, store, observedClaim('dpl_observed'));
  expect(recovery.rollback).toBeNull();
  expect(recovery.recoveryOutcome).toEqual({ kind: 'NO_ROLLBACK', reason: 'KNOWN_GOOD_MISMATCH' });
  expect(provider.calls).not.toContain('rollback');
  expect((await store.getKnownGoodDeployment('app', 'production'))?.id).toBe('dpl_other');
  expect(recovery.summary).toMatchObject({ status: 'FAILED', errorCode: 'LP-HEALTH-PRODUCTION-FAILED' });
});

it('recovery never rolls back when the recorded known-good belongs to a different project', async () => {
  const provider = testProvider();
  const store = await seededStore();
  await store.recordDeployment({ id: 'dpl_other-project', applicationId: 'app', projectId: 'other-project', environment: 'production', repository: 'acme/app', commitSha: 'e'.repeat(40), desiredGeneration: 0, state: 'CURRENT', url: 'https://dpl_other-project.example.test', createdAt: '2026-08-04T00:00:00.000Z' });
  const recovery = await recoverFor(provider, store, observedClaim('dpl_observed'));
  expect(recovery.rollback).toBeNull();
  expect(recovery.recoveryOutcome).toEqual({ kind: 'NO_ROLLBACK', reason: 'KNOWN_GOOD_MISMATCH' });
  expect(provider.calls).not.toContain('rollback');
  expect(recovery.summary).toMatchObject({ status: 'FAILED', errorCode: 'LP-HEALTH-PRODUCTION-FAILED' });
});

class TestSecretProvider implements SecretProvider {
  constructor(private readonly values: Record<string, string>) {}

  async resolve(reference: string, _ctx: ProviderContext): Promise<SensitiveValue<unknown>> {
    const value = this.values[reference];
    if (value === undefined) throw new Error(`LP-SECRET-NOT-FOUND: ${reference}`);
    return new SensitiveValue(value);
  }

  async fingerprint(reference: string, _ctx: ProviderContext): Promise<string> {
    return sha256Hex(`fingerprint:${reference}:${this.values[reference] ?? ''}`);
  }
}

it('persists secret fingerprints and never raw secret values', async () => {
  const provider = testProvider();
  const store = await seededStore();
  const secretValue = 'super-secret-value';
  const secrets = new TestSecretProvider({ 'env://API_TOKEN': secretValue });
  const desiredWithSecrets: DesiredApplication = { ...desired, secrets: [{ name: 'API_TOKEN', source: 'env://API_TOKEN', environments: ['production'] }] };
  const base = await makeApplyBase({ applicationId: 'app', sourceCommit: 'a'.repeat(40), planFingerprint: 'fp', desiredGeneration: 1, idempotencyKey: 'secrets-test', workflowId: 'secrets-wf' });
  const runtime: ApplyRuntime = { store, provider, secrets };
  const resolved = await runApplyPhase({ store, base, context, step: applyStep('resolve-secrets', { base, context, runtime, desired: desiredWithSecrets }) });
  expect(resolved.status).toBe('SUCCEEDED');
  const resolvedResult = resolved.result as ResolveSecretsResult; // phase output; shape is the phase contract
  const bindings = resolvedResult.bindings;
  expect(bindings).toHaveLength(1);
  expect(JSON.stringify(bindings)).not.toContain(secretValue);
  const seenVariables: unknown[] = [];
  const originalEnsureEnvironment = provider.ensureEnvironment.bind(provider);
  provider.ensureEnvironment = async (spec, ctx) => { seenVariables.push(spec.variables); return originalEnsureEnvironment(spec, ctx); };
  const plan = await buildPlan({ desired: desiredWithSecrets, observed: observed(), capabilities: FULL_CAPABILITIES, sourceCommit: 'a'.repeat(40), desiredGeneration: 1, now: '2026-08-04T00:00:00.000Z' });
  const locks: HeldLocks = { applicationId: 'app', ownerId: 'secrets-wf', leaseSeconds: 900, application: 'application:app', domains: [] };
  // The machine runs ensure-project before ensure-environments; the fake
  // mirrors the Vercel API (an environment can only be ensured on an existing
  // project), so seed the project the same way the full pipeline would.
  await provider.ensureProject(projectSpec, context);
  const environments = await runApplyPhase({ store, base, context, step: applyStep('ensure-environments', { base, context, runtime, desired: desiredWithSecrets, plan, locks, bindings }) });
  expect(environments.status).toBe('SUCCEEDED');
  const environmentResult = environments.result as EnsureEnvironmentsResult;
  expect(JSON.stringify(environmentResult)).not.toContain(secretValue);
  const seenRecord = seenVariables[0] as Record<string, unknown> | undefined; // captured provider input; shape is our EnvironmentSpec.variables
  const variable = seenRecord?.API_TOKEN;
  expect(variable).toBeInstanceOf(SensitiveValue);
  const sensitive = variable as SensitiveValue<unknown>; // wrapped by TestSecretProvider; contract is SensitiveValue
  expect(sensitive.reveal()).toBe(secretValue);
  const run = await store.startWorkflowRun({ applicationId: 'app', workflowType: 'APPLY', idempotencyKey: 'secrets-test', payloadHash: base.payloadHash });
  expect(JSON.stringify(await store.listWorkflowSteps(run.id))).not.toContain(secretValue);
});

// ---------------------------------------------------------------------------
// Reviewed-plan approval gate (squash-merge neutral)
// ---------------------------------------------------------------------------

it('passes the approval gate for a squash-merged equivalent plan: the review fingerprint is source-commit neutral', async () => {
  const provider = testProvider();
  const store = await seededStore();
  // Review happened at the PR head (commit 'a'); the apply runs at the merged
  // commit ('b'). The plan content is identical (squash merge), so only the
  // source commit differs between the reviewed plan and the merged replan.
  const { plan, observed: observedState } = await planFor(provider, store, { sourceCommit: 'a'.repeat(40) });
  const mergedPlan = { ...plan, sourceCommit: 'b'.repeat(40) };
  mergedPlan.fingerprint = (await buildPlan({ desired, observed: observedState, capabilities: FULL_CAPABILITIES, sourceCommit: 'b'.repeat(40), desiredGeneration: 1, now: '2026-08-04T00:00:00.000Z' })).fingerprint;
  expect(await planReviewFingerprint(mergedPlan)).toBe(await planReviewFingerprint(plan));
  expect(mergedPlan.fingerprint).not.toBe(plan.fingerprint);

  const result = await runApplyWorkflow({ store, provider, desired, observed: observedState, plan: mergedPlan, sourceCommit: 'b'.repeat(40), context: { ...context, workflowId: 'apply-merged' }, fetchImpl: okFetch, sleep: async () => undefined });
  expect(result.status, `apply failed: ${result.errorCode ?? 'unknown'}`).toBe('SUCCEEDED');
  expect(result.errorCode).toBeNull();
});

it('blocks apply when the provider drifted after review (no attestation for the drifted review fingerprint), before any provider write', async () => {
  const provider = testProvider();
  const store = await seededStore();
  const { plan, observed: observedState } = await planFor(provider, store, { sourceCommit: 'a'.repeat(40) });
  // Provider state drifts after the review: the project now exists with a
  // different root directory.
  await provider.ensureProject(projectSpec, context);
  provider.mutateProject('app', { rootDirectory: 'apps/changed' });
  const drifted = await applyObserveLiveState({ base: await makeApplyBase({ applicationId: 'app', sourceCommit: 'b'.repeat(40), planFingerprint: 'pending', desiredGeneration: 1, idempotencyKey: 'drift-apply', workflowId: 'apply-drift' }), provider, desired, context });
  const driftedPlan = await buildPlan({ desired, observed: drifted.observed, capabilities: drifted.capabilities, sourceCommit: 'b'.repeat(40), desiredGeneration: 1, now: '2026-08-04T00:00:00.000Z' });
  expect(await planReviewFingerprint(driftedPlan)).not.toBe(await planReviewFingerprint(plan));
  // The merged apply is fresh against the drifted state but was never reviewed for it.
  provider.calls.length = 0;
  const result = await runApplyWorkflow({ store, provider, desired, observed: drifted.observed, plan: driftedPlan, sourceCommit: 'b'.repeat(40), context: { ...context, workflowId: 'apply-drift' }, fetchImpl: okFetch, sleep: async () => undefined });
  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-PLAN-REVIEW-ATTESTATION-MISSING');
  // observe-live-state reads are allowed before the gate; no provider write
  // ever follows a failed approval gate.
  expect(provider.calls.filter((call) => WRITE_CALLS.includes(call))).toEqual([]);
  expect(await store.getLock('application:app')).toBeNull();
});

it('blocks apply when the merged desired state differs from the reviewed PR-head state (review fingerprint mismatch)', async () => {
  const provider = testProvider();
  const store = await seededStore();
  const { plan } = await planFor(provider, store, { sourceCommit: 'a'.repeat(40) });
  // The merged manifest changed after review (e.g. a second commit landed
  // before merge): the desired framework now differs.
  const changedDesired: DesiredApplication = { ...desired, vercel: { ...desired.vercel, project: { ...desired.vercel.project, framework: 'remix' } } };
  const changedBase = await makeApplyBase({ applicationId: 'app', sourceCommit: 'b'.repeat(40), planFingerprint: 'pending', desiredGeneration: 1, idempotencyKey: 'changed-apply', workflowId: 'apply-changed' });
  const changedLive = await applyObserveLiveState({ base: changedBase, provider, desired: changedDesired, context });
  const changedPlan = await buildPlan({ desired: changedDesired, observed: changedLive.observed, capabilities: changedLive.capabilities, sourceCommit: 'b'.repeat(40), desiredGeneration: 1, now: '2026-08-04T00:00:00.000Z' });
  expect(await planReviewFingerprint(changedPlan)).not.toBe(await planReviewFingerprint(plan));
  provider.calls.length = 0;
  const result = await runApplyWorkflow({ store, provider, desired: changedDesired, observed: changedLive.observed, plan: changedPlan, sourceCommit: 'b'.repeat(40), context: { ...context, workflowId: 'apply-changed' }, fetchImpl: okFetch, sleep: async () => undefined });
  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-PLAN-REVIEW-ATTESTATION-MISSING');
  expect(provider.calls.filter((call) => WRITE_CALLS.includes(call))).toEqual([]);
  expect(await store.getLock('application:app')).toBeNull();
});

it('blocks apply when an attestation exists for the review fingerprint but binds a different desired state (defense-in-depth drift check)', async () => {
  const provider = testProvider();
  const store = await seededStore();
  const { plan, observed: observedState } = await planFor(provider, store, { sourceCommit: 'a'.repeat(40), attest: false });
  // The stored attestation matches the review fingerprint but was recorded
  // against a different desired-state binding (e.g. a stale attestation).
  await store.savePlanReviewAttestation({ applicationId: 'app', prHeadSourceCommit: 'a'.repeat(40), desiredHash: 'd'.repeat(64), generation: 9, planFingerprint: plan.fingerprint, reviewFingerprint: await planReviewFingerprint(plan), repository: 'acme/app', actor: 'alice', workflowRef: 'acme/app/.github/workflows/apply.yml@refs/heads/main' });
  provider.calls.length = 0;
  const result = await runApplyWorkflow({ store, provider, desired, observed: observedState, plan, sourceCommit: plan.sourceCommit, context: { ...context, workflowId: 'apply-drift-check' }, fetchImpl: okFetch, sleep: async () => undefined });
  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-PLAN-REVIEW-DESIRED-STATE-DRIFT');
  expect(provider.calls.filter((call) => WRITE_CALLS.includes(call))).toEqual([]);
  expect(await store.getLock('application:app')).toBeNull();
});

it('blocks apply without any reviewed-plan attestation, before any provider write', async () => {
  const provider = testProvider();
  const store = await seededStore();
  const { plan, observed: observedState } = await planFor(provider, store, { sourceCommit: 'a'.repeat(40), attest: false });
  provider.calls.length = 0;
  const result = await runApplyWorkflow({ store, provider, desired, observed: observedState, plan, sourceCommit: plan.sourceCommit, context: { ...context, workflowId: 'apply-no-review' }, fetchImpl: okFetch, sleep: async () => undefined });
  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-PLAN-REVIEW-ATTESTATION-MISSING');
  expect(provider.calls.filter((call) => WRITE_CALLS.includes(call))).toEqual([]);
  expect(await store.getLock('application:app')).toBeNull();
});

const dnsOnlyDomain = (): DesiredApplication['domains'] => [{ hostname: 'app.example.com', environment: 'production', cloudflare: { zoneRef: 'config://cloudflare/example.com', mode: 'dns-only', ttl: 'auto' }, redirects: [] }];

function proxiedDomain(acknowledged: boolean): DesiredApplication['domains'] {
  return [{
    hostname: 'app.example.com',
    environment: 'production',
    cloudflare: {
      zoneRef: 'config://cloudflare/example.com',
      mode: 'proxied',
      ttl: 'auto',
      ...(acknowledged ? { proxy: { acknowledgeDoubleCdn: true, bypassWellKnownPaths: true, verifyConnectingIpHeader: true, cachePolicy: 'standard' } } : {}),
    },
    redirects: [],
  }];
}

function probeResult(compatible: boolean, request: ProxyCompatibilityRequest): ProxyCompatibilityResult {
  const observedAt = '2026-08-04T00:00:00.000Z';
  return {
    hostname: request.hostname,
    mode: 'proxied',
    acknowledgment: true,
    origin: { route: 'origin', url: `https://${request.originHost}${request.healthPath ?? '/'}`, reachable: true, statusCode: 200, tls: 'ok', connectingIpHeader: compatible, latencyMs: 1, observedAt },
    public: { route: 'public', url: `https://${request.hostname}${request.healthPath ?? '/'}`, reachable: true, statusCode: 200, tls: 'ok', connectingIpHeader: false, latencyMs: 1, observedAt },
    compatible,
    checkedAt: observedAt,
  };
}

function runDesired(store: InMemoryLaunchpadStore, provider: FakeProvider, desiredApp: DesiredApplication, plan: PlatformPlan, observedState: ObservedApplication): Promise<ApplyWorkflowResult> {
  return runApplyWorkflow({ store, provider, desired: desiredApp, observed: observedState, plan, sourceCommit: plan.sourceCommit, context, fetchImpl: okFetch, sleep: async () => undefined });
}

function captureEnsureRecords(provider: FakeProvider): RequiredDnsRecord[] {
  const seen: RequiredDnsRecord[] = [];
  const original = provider.ensureRecord.bind(provider);
  provider.ensureRecord = async (zoneId, record, fingerprint, ctx) => {
    seen.push(record);
    return original(zoneId, record, fingerprint, ctx);
  };
  return seen;
}

it('writes acknowledged proxied DNS records as proxied:true and promotes only after compatible probes', async () => {
  const provider = testProvider();
  provider.checkProxyCompatibility = async (request) => probeResult(true, request);
  const store = await seededStore();
  const proxied = { ...desired, domains: proxiedDomain(true) };
  const { plan, observed: observedState } = await planFor(provider, store, { desiredOverride: proxied });
  const seen = captureEnsureRecords(provider);
  const result = await runDesired(store, provider, proxied, plan, observedState);
  expect(result.status, `proxied apply failed: ${result.errorCode ?? 'unknown'}`).toBe('SUCCEEDED');
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ proxied: true, proxyAcknowledgment: true });
  expect(provider.records.get('zone_example.com:app.example.com')?.proxied).toBe(true);
  expect(provider.calls).toContain('promote');
});

it('blocks promotion when the origin/public compatibility probes are incompatible', async () => {
  const provider = testProvider();
  provider.checkProxyCompatibility = async (request) => probeResult(false, request);
  const store = await seededStore();
  const proxied = { ...desired, domains: proxiedDomain(true) };
  const { plan, observed: observedState } = await planFor(provider, store, { desiredOverride: proxied });
  const result = await runDesired(store, provider, proxied, plan, observedState);
  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-DNS-PROXY-COMPATIBILITY-FAILED');
  expect(provider.calls).not.toContain('promote');
});

it('blocks proxied applies when the DNS provider lacks a callable proxy compatibility capability', async () => {
  const provider = testProvider();
  Object.defineProperty(provider, 'checkProxyCompatibility', { configurable: true, value: undefined });
  const store = await seededStore();
  const proxied = { ...desired, domains: proxiedDomain(true) };
  const { plan, observed: observedState } = await planFor(provider, store, { desiredOverride: proxied });
  const result = await runDesired(store, provider, proxied, plan, observedState);
  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-DNS-PROXY-COMPATIBILITY-UNSUPPORTED');
  expect(provider.calls).not.toContain('promote');
});

it('blocks unacknowledged proxied mode before any DNS write', async () => {
  const provider = testProvider();
  const store = await seededStore();
  const unacknowledged = { ...desired, domains: proxiedDomain(false) };
  const base = await makeApplyBase({ applicationId: 'app', sourceCommit: 'a'.repeat(40), planFingerprint: 'fp', desiredGeneration: 1, idempotencyKey: 'dns-ack', workflowId: 'ack-wf' });
  const runtime: ApplyRuntime = { store, provider };
  const plan = await buildPlan({ desired: unacknowledged, observed: observed(), capabilities: FULL_CAPABILITIES, sourceCommit: 'a'.repeat(40), desiredGeneration: 1, now: '2026-08-04T00:00:00.000Z' });
  const locks: HeldLocks = { applicationId: 'app', ownerId: 'ack-wf', leaseSeconds: 900, application: 'application:app', domains: ['app.example.com'] };
  const step = applyStep('ensure-dns', { base, context, runtime, desired: unacknowledged, plan, locks });
  const outcome = await runApplyPhase({ store, base, context, step });
  expect(outcome.status).toBe('FAILED');
  expect(errorCodeOf(outcome.error)).toBe('LP-DNS-PROXY-ACKNOWLEDGMENT-REQUIRED');
  expect(provider.records.size).toBe(0);
  expect(provider.calls).toEqual([]);
});

it('writes DNS-only records explicitly and never runs the proxy gate', async () => {
  const provider = testProvider();
  let probeCalls = 0;
  provider.checkProxyCompatibility = async (request) => {
    probeCalls += 1;
    return probeResult(true, request);
  };
  const store = await seededStore();
  const dnsOnly = { ...desired, domains: dnsOnlyDomain() };
  const { plan, observed: observedState } = await planFor(provider, store, { desiredOverride: dnsOnly });
  const seen = captureEnsureRecords(provider);
  const result = await runDesired(store, provider, dnsOnly, plan, observedState);
  expect(result.status).toBe('SUCCEEDED');
  const [record] = seen;
  expect(record).toMatchObject({ proxied: false });
  expect(record?.proxyAcknowledgment).toBeUndefined();
  expect(provider.records.get('zone_example.com:app.example.com')?.proxied).toBe(false);
  expect(probeCalls).toBe(0);
  expect(provider.calls).toContain('promote');
});
