import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesiredApplication } from '@launchpad/core';
import { buildPlan, desiredStateHash, planReviewFingerprint } from '@launchpad/core';
import { applyLoadDesired, applyObserveLiveState, makeApplyBase } from '@launchpad/workflows';
import { CompositeProvider } from '../../apps/controller/src/handlers.js';
import { ApplyApplicationWorkflow } from '../../apps/controller/src/workflows.js';
import { EnvironmentSecretProvider } from '@launchpad/provider-secrets';
import { controlPushClaims, signGithubToken } from '../fixtures/oidc.js';
import { cfRecord, expectedDnsOwnership, manifestYamlFrom, vercelProject } from '../fixtures/providers.js';
import { CONTROL_REPOSITORY, HEAD_SHA, MAIN_SHA, MANIFEST_PATH, SOURCE_COMMIT, createHarness, type ControllerHarness } from './harness.js';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class WorkflowEntrypoint {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) { this.env = env; }
  },
}));

const WORKFLOW_REF = 'example/control/.github/workflows/apply.yml@refs/heads/main';
const PREV_SHA = 'e'.repeat(40);

/**
 * Secret bindings the apply machine turns into production environment
 * variables. DATABASE_URL is a non-sensitive manifest literal; API_TOKEN and
 * PROD_TOKEN are source-based and resolved by the injected secret provider to
 * canary values. The canaries are the secret-hygiene contract end to end:
 * each may appear in the recorded env write bodies and nowhere else (D1,
 * steps, audit, or other request surfaces).
 */
const FIXTURE_SECRETS = [
  { name: 'DATABASE_URL', value: 'postgres://fixture:db-password@db.internal/fixture', sensitive: false, environments: ['production' as const] },
  { name: 'API_TOKEN', source: 'env://API_TOKEN', sensitive: true, environments: ['production' as const] },
  { name: 'PROD_TOKEN', source: 'env://PROD_TOKEN', sensitive: true, environments: ['production' as const] },
];

const RESOLVED_TOKEN_CANARY = 'lp-resolved-token-value-9f3c7d';
const RESOLVED_PROD_CANARY = 'lp-resolved-prod-value-7d1e5b';

/**
 * Precomputes the plan fingerprint the workflow's replan-verify phase will
 * recompute, using the same production functions, adapters, store, and
 * recorded transport the workflow itself uses. The enqueue then submits this
 * fingerprint, so the freshness gate passes with real inputs.
 */
async function computeApplyFingerprint(harness: ControllerHarness, desired: DesiredApplication, options: { attest?: boolean } = {}): Promise<string> {
  const composite = new CompositeProvider(harness.vercel, harness.cloudflare);
  const base = await makeApplyBase({ applicationId: 'fixture-app', sourceCommit: SOURCE_COMMIT, planFingerprint: 'pending', desiredGeneration: 1, idempotencyKey: 'precompute', workflowId: 'precompute-wf' });
  const loaded = await applyLoadDesired({ base, source: harness.github, controlRepository: CONTROL_REPOSITORY, manifestPath: MANIFEST_PATH, context: harness.context('precompute-wf') });
  const live = await applyObserveLiveState({ base, provider: composite, desired: loaded.desired, context: harness.context('precompute-wf') });
  const plan = await buildPlan({ desired: loaded.desired, observed: live.observed, capabilities: live.capabilities, sourceCommit: base.sourceCommit, desiredGeneration: base.desiredGeneration, ownership: {}, mode: 'apply', now: '2026-08-04T00:00:00.000Z' });
  if (plan.result !== 'READY') {
    const blocks = plan.policyResults.filter((result) => result.result === 'BLOCK').map((result) => result.message).join(' | ');
    throw new Error(`plan is not READY with the real adapter matrices: ${blocks}`);
  }
  if (options.attest !== false) {
    // Record the reviewed-plan attestation the merged apply requires: the
    // review happened at the PR head (HEAD_SHA) against this exact plan.
    const [reviewFingerprint, desiredHash] = await Promise.all([planReviewFingerprint(plan), desiredStateHash(loaded.desired)]);
    await harness.store.savePlanReviewAttestation({ applicationId: 'fixture-app', prHeadSourceCommit: HEAD_SHA, desiredHash, generation: plan.desiredGeneration, planFingerprint: plan.fingerprint, reviewFingerprint, repository: 'example/fixture', actor: 'alice', workflowRef: WORKFLOW_REF });
  }
  return plan.fingerprint;
}

async function seedApplyHarness(options: { seedKnownGood?: boolean } = {}): Promise<ControllerHarness> {
  const harness = await createHarness({ secrets: new EnvironmentSecretProvider({ API_TOKEN: RESOLVED_TOKEN_CANARY, PROD_TOKEN: RESOLVED_PROD_CANARY }) });
  const manifest = manifestYamlFrom({ ...(await harness.loadFixtureDesired()), secrets: FIXTURE_SECRETS });
  harness.setControlManifest(manifest);
  harness.setControlManifest(manifest, SOURCE_COMMIT);
  harness.seedVercelProject();
  harness.states.cloudflare.records.push(cfRecord({
    zoneId: 'zone_1', name: 'fixture.example.com', type: 'CNAME', content: 'cname.vercel-dns.com', ttl: 1, proxied: false,
    comment: `launchpad:${expectedDnsOwnership('fixture-app', 'fixture.example.com')}`,
  }, harness.states.cloudflare));
  await harness.registerApplication();
  if (options.seedKnownGood) {
    harness.states.vercel.deployments.set('dpl_1', {
      id: 'dpl_1', projectId: 'fixture-app', url: 'fixture.example.com', state: 'CURRENT', readyState: 'CURRENT',
      commitSha: PREV_SHA, target: 'production', createdAt: '2026-08-03T00:00:00.000Z', meta: { repo: 'example/fixture', desiredGeneration: '0' },
    });
    await harness.store.recordDeployment({ id: 'dpl_1', applicationId: 'fixture-app', projectId: 'fixture-app', environment: 'production', repository: 'example/fixture', commitSha: PREV_SHA, desiredGeneration: 0, state: 'CURRENT', url: 'https://fixture.example.com', createdAt: '2026-08-03T00:00:00.000Z' });
    await harness.store.recordKnownGoodDeployment('fixture-app', 'production', 'dpl_1');
  }
  return harness;
}

async function enqueueApply(harness: ControllerHarness, planFingerprint: string, overrides: Record<string, unknown> = {}): Promise<{ operationId: string; workflowId: string }> {
  const token = await signGithubToken(harness.oidc, controlPushClaims(SOURCE_COMMIT));
  const body = {
    version: 1,
    applicationId: 'fixture-app',
    sourceCommit: SOURCE_COMMIT,
    desiredGeneration: 1,
    planFingerprint,
    idempotencyKey: 'apply-key-1',
    repositoryId: '123456789',
    ownerId: '987654321',
    repository: 'example/control',
    workflowRef: WORKFLOW_REF,
    event: 'push',
    ref: 'refs/heads/main',
    actor: 'alice',
    ...overrides,
  };
  const response = await harness.request('/v1/applications/fixture-app/apply', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  expect(response.status).toBe(202);
  return await response.json() as { operationId: string; workflowId: string };
}

describe('merged apply flow (integration)', () => {
  let harness: ControllerHarness;
  let desired: DesiredApplication;

  beforeEach(async () => { harness = await seedApplyHarness(); desired = { ...(await harness.loadFixtureDesired()), secrets: FIXTURE_SECRETS }; });
  afterEach(() => { harness.restore(); });

  it('applies end to end: exact-commit reload, live replan, DNS+TLS gates, exact promotion, post-health known-good', async () => {
    const planFingerprint = await computeApplyFingerprint(harness, desired);
    const { operationId, workflowId } = await enqueueApply(harness, planFingerprint);
    const instance = harness.workflowInstances[0];
    if (!instance) throw new Error('workflow instance missing');
    expect(instance.id).toBe(workflowId);

    const { result } = await harness.runWorkflow(ApplyApplicationWorkflow, instance.params, { instanceId: instance.id });
    expect((result as Record<string, unknown>).status).toBe('SUCCEEDED');

    // Durable run and granular steps.
    const run = await harness.store.getWorkflowRun(operationId);
    expect(run).toMatchObject({ status: 'SUCCEEDED', workflowType: 'apply', errorCode: null });
    const steps = await harness.store.listWorkflowSteps(operationId);
    expect(steps.filter((step) => step.status === 'SUCCEEDED')).toHaveLength(25);
    expect(steps.find((step) => step.stepId === 'proxy-compatibility')?.result).toMatchObject({ skipped: true, checks: [] });
    const vercelDomainStep = steps.find((step) => step.stepId === 'verify-vercel-domain');
    expect(vercelDomainStep?.result).toMatchObject({ skipped: false, domains: [{ hostname: 'fixture.example.com', state: 'VERIFIED' }] });
    const tlsStep = steps.find((step) => step.stepId === 'verify-tls');
    expect(tlsStep?.result).toMatchObject({ skipped: false, domains: [{ hostname: 'fixture.example.com', state: 'READY' }] });

    // Exact desired-commit reload happened through the real GitHub adapter
    // (the adapter percent-encodes the full contents path, GitHub-style).
    expect(harness.transport.count('GET', `/contents/catalog%2Fapps%2Ffixture-app.yaml?ref=${SOURCE_COMMIT}`)).toBeGreaterThanOrEqual(2);

    // Exact-commit candidate creation and exact promotion (no canary/traffic-split anywhere).
    const deploymentCalls = harness.transport.jsonBodies('POST', '/v13/deployments');
    expect(deploymentCalls).toHaveLength(1);
    expect((deploymentCalls[0] as Record<string, unknown>).gitSource).toMatchObject({ sha: MAIN_SHA, ref: 'main' });
    expect(harness.states.vercel.promoteCalls).toEqual([{ projectId: 'fixture-app', deploymentId: 'dpl_10' }]);
    // Every declared variable is reconciled through the official env surface:
    // one list read, one create per variable, one decrypt-capable readback per create.
    expect(harness.states.vercel.envCalls).toHaveLength(3);
    expect(harness.states.vercel.envCalls.map((call) => call.key)).toEqual(['DATABASE_URL', 'API_TOKEN', 'PROD_TOKEN']);
    // The manifest literal flows verbatim as a plain variable; resolved secrets
    // are revealed only at request construction (encrypted type).
    expect(harness.states.vercel.envCalls[0]).toMatchObject({ key: 'DATABASE_URL', value: 'postgres://fixture:db-password@db.internal/fixture', type: 'plain', target: ['production'], gitBranch: 'main' });
    expect(harness.states.vercel.envCalls[1]).toMatchObject({ key: 'API_TOKEN', value: RESOLVED_TOKEN_CANARY, type: 'encrypted', target: ['production'], gitBranch: 'main' });
    expect(harness.states.vercel.envCalls[2]).toMatchObject({ key: 'PROD_TOKEN', value: RESOLVED_PROD_CANARY, type: 'encrypted', target: ['production'], gitBranch: 'main' });
    expect(harness.transport.requestsFor('GET', '/v9/projects/fixture-app/env').filter((request) => request.url.endsWith('/v9/projects/fixture-app/env'))).toHaveLength(1);
    expect(harness.transport.requestsFor('GET', '/v9/projects/fixture-app/env/env_')).toHaveLength(3);
    expect(harness.transport.count('PATCH', '/v9/projects/fixture-app/env/')).toBe(0);
    expect(harness.states.vercel.domainCalls).toHaveLength(1);
    // Secret hygiene end to end: resolved secret values exist only in the env
    // write request bodies — never in durable steps, runs, audit rows, or any
    // other recorded request surface.
    const envWriteBodies = JSON.stringify(harness.transport.jsonBodies('POST', '/v10/projects/fixture-app/env'));
    expect(envWriteBodies).toContain(RESOLVED_TOKEN_CANARY);
    expect(envWriteBodies).toContain(RESOLVED_PROD_CANARY);
    const persisted = JSON.stringify({ steps: await harness.store.listWorkflowSteps(operationId), audit: await harness.store.listAudit('fixture-app'), runs: await harness.store.listWorkflowRuns('fixture-app') });
    expect(persisted).not.toContain(RESOLVED_TOKEN_CANARY);
    expect(persisted).not.toContain(RESOLVED_PROD_CANARY);
    const otherRequests = harness.transport.requests.filter((request) => !(request.method === 'POST' && request.url.includes('/v10/projects/fixture-app/env')));
    expect(JSON.stringify(otherRequests.map((request) => request.bodyText))).not.toContain(RESOLVED_TOKEN_CANARY);
    expect(JSON.stringify(otherRequests.map((request) => request.bodyText))).not.toContain(RESOLVED_PROD_CANARY);
    // The DNS record already matched: no provider DNS mutation was issued.
    expect(harness.transport.count('POST', '/dns_records')).toBe(0);
    expect(harness.transport.count('PUT', '/dns_records')).toBe(0);
    expect(harness.transport.allBodies().toLowerCase()).not.toContain('canary');

    // Persisted outcomes: CURRENT deployment + known-good, passed health, SYNCED/HEALTHY status, released locks.
    const knownGood = await harness.store.getKnownGoodDeployment('fixture-app', 'production');
    expect(knownGood?.id).toBe('dpl_10');
    expect(knownGood?.commitSha).toBe(MAIN_SHA);
    const deployment = await harness.store.getDeployment('dpl_10');
    expect(deployment).toMatchObject({ state: 'CURRENT', commitSha: MAIN_SHA, environment: 'production', url: 'https://fixture-app-dpl_10.vercel.app' });
    const health = await harness.store.listHealthChecks('fixture-app', { environment: 'production' });
    expect(health).toHaveLength(2);
    expect(health.every((check) => check.result === 'PASSED')).toBe(true);
    const application = await harness.store.getApplication('fixture-app');
    expect(application).toMatchObject({ syncStatus: 'SYNCED', healthStatus: 'HEALTHY' });
    expect((await harness.store.listPromotions('fixture-app'))[0]).toMatchObject({ deploymentId: 'dpl_10', result: 'PROMOTED' });
    expect((await harness.store.listAudit('fixture-app')).some((event) => event.action === 'APPLY_SUCCEEDED')).toBe(true);
    expect(await harness.store.getLock('application:fixture-app')).toBeNull();
    expect(await harness.store.getLock('domain:fixture.example.com')).toBeNull();

    // Claim-scoped poll reports the terminal success.
    const token = await signGithubToken(harness.oidc, controlPushClaims(SOURCE_COMMIT));
    const poll = await harness.request(`/v1/operations/${operationId}`, { headers: { authorization: `Bearer ${token}` } });
    expect(poll.status).toBe(200);
    await expect(poll.json()).resolves.toMatchObject({ status: 'SUCCEEDED', kind: 'apply', applicationId: 'fixture-app', sourceCommit: SOURCE_COMMIT, errorCode: null });
  });

  it('fails on a stale plan fingerprint before any provider write', async () => {
    const { operationId } = await enqueueApply(harness, 'f'.repeat(64));
    const instance = harness.workflowInstances[0];
    if (!instance) throw new Error('workflow instance missing');
    let thrown: Error | null = null;
    try {
      await harness.runWorkflow(ApplyApplicationWorkflow, instance.params, { instanceId: instance.id });
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.name).toBe('LP-PLAN-STALE');
    const run = await harness.store.getWorkflowRun(operationId);
    expect(run).toMatchObject({ status: 'FAILED', errorCode: 'LP-PLAN-STALE' });
    // Reads only: no provider mutation was ever attempted before the freshness gate.
    expect(harness.transport.count('POST', 'api.vercel.com')).toBe(0);
    expect(harness.transport.count('PATCH', 'api.vercel.com')).toBe(0);
    expect(harness.transport.count('DELETE', 'api.vercel.com')).toBe(0);
    expect(harness.transport.count('POST', 'api.cloudflare.com')).toBe(0);
    expect(await harness.store.getLock('application:fixture-app')).toBeNull();
  });

  it('blocks a conflicting application lock before any provider write', async () => {
    const planFingerprint = await computeApplyFingerprint(harness, desired);
    const { operationId } = await enqueueApply(harness, planFingerprint);
    await harness.store.acquireLock('application:fixture-app', 'other-operator', 900);
    const instance = harness.workflowInstances[0];
    if (!instance) throw new Error('workflow instance missing');
    let thrown: Error | null = null;
    try {
      await harness.runWorkflow(ApplyApplicationWorkflow, instance.params, { instanceId: instance.id });
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.name).toBe('LP-LOCK-CONFLICT');
    const run = await harness.store.getWorkflowRun(operationId);
    expect(run).toMatchObject({ status: 'FAILED', errorCode: 'LP-LOCK-CONFLICT' });
    expect(harness.transport.count('POST', 'api.vercel.com')).toBe(0);
    expect(harness.transport.count('PATCH', 'api.vercel.com')).toBe(0);
    expect(harness.transport.count('POST', 'api.cloudflare.com')).toBe(0);
  });

  it('rejects destructive plans at the no-destroy gate before locks or writes', async () => {
    const destructivePlan = {
      schemaVersion: 'launchpad.plan/v1', applicationId: 'fixture-app', desiredGeneration: 1, sourceCommit: SOURCE_COMMIT,
      createdAt: '2026-08-04T00:00:00.000Z', capabilitySnapshotHash: 'h', observedStateHash: 'h', fingerprint: 'destructive-fp',
      result: 'DESTRUCTIVE',
      operations: [{ id: 'op-1', resourceKey: 'vercel.project', provider: 'vercel', resourceType: 'vercel.project', action: 'DESTROY', before: null, after: null, prerequisites: [], invalidates: [], idempotencyKey: 'ik', destructive: true, retryClass: 'NONE' }],
      downstreamEffects: [], policyResults: [], layers: [], drift: null,
    };
    const response = await harness.request('/internal/workflows/apply/no-destroy-gate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-launchpad-workflow-token': 'internal-token' },
      body: JSON.stringify({ applicationId: 'fixture-app', sourceCommit: SOURCE_COMMIT, planFingerprint: 'destructive-fp', desiredGeneration: 1, idempotencyKey: 'ndg-key', workflowId: 'ndg-wf', plan: destructivePlan }),
    });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-DESTROY-NORMAL-APPLY-BLOCKED' } });
    expect(await harness.store.getLock('application:fixture-app')).toBeNull();
    expect(harness.transport.count('POST', 'api.vercel.com')).toBe(0);
    expect(harness.transport.count('PATCH', 'api.vercel.com')).toBe(0);

    const benign = { ...destructivePlan, result: 'READY', operations: [] };
    const accepted = await harness.request('/internal/workflows/apply/no-destroy-gate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-launchpad-workflow-token': 'internal-token' },
      body: JSON.stringify({ applicationId: 'fixture-app', sourceCommit: SOURCE_COMMIT, planFingerprint: 'destructive-fp', desiredGeneration: 1, idempotencyKey: 'ndg-key-2', workflowId: 'ndg-wf-2', plan: benign }),
    });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toEqual({ accepted: true });
  });

  it('resumes after a forced interruption without duplicating provider writes', async () => {
    const planFingerprint = await computeApplyFingerprint(harness, desired);
    const { operationId, workflowId } = await enqueueApply(harness, planFingerprint);
    const instance = harness.workflowInstances[0];
    if (!instance) throw new Error('workflow instance missing');

    // Crash after 8 completed step.do boundaries (through ensure-git, after
    // two provider PATCHes); the durable store holds the boundary.
    let interrupted: Error | null = null;
    try {
      await harness.runWorkflow(ApplyApplicationWorkflow, instance.params, { instanceId: instance.id, interruptAfter: 8 });
    } catch (error) {
      interrupted = error as Error;
    }
    expect(interrupted?.name).toBe('LP-SIMULATED-WORKER-RESTART');
    const midRun = await harness.store.getWorkflowRun(operationId);
    expect(midRun?.status).toBe('RUNNING');

    // Resume the same instance: completed phases are replayed from D1, not re-executed.
    const { result } = await harness.runWorkflow(ApplyApplicationWorkflow, instance.params, { instanceId: instance.id });
    expect((result as Record<string, unknown>).status).toBe('SUCCEEDED');
    const run = await harness.store.getWorkflowRun(operationId);
    expect(run?.status).toBe('SUCCEEDED');

    // Exactly-once provider writes across both runs.
    expect(harness.states.vercel.promoteCalls).toEqual([{ projectId: 'fixture-app', deploymentId: 'dpl_10' }]);
    expect(harness.transport.count('POST', '/v13/deployments')).toBe(1);
    expect(harness.transport.count('PATCH', '/v9/projects/fixture-app')).toBe(1);
    expect(harness.transport.count('POST', '/v10/projects/fixture-app/env')).toBe(3);
    expect(harness.transport.count('POST', '/v10/projects/fixture-app/domains')).toBe(1);
    expect(harness.transport.count('POST', '/v10/projects/fixture-app/promote')).toBe(1);
    // Every phase step has exactly one durable SUCCEEDED row (no re-execution attempts).
    const steps = await harness.store.listWorkflowSteps(operationId);
    const phaseIds = ['validate-request', 'load-desired', 'observe-live-state', 'replan-verify', 'no-destroy-gate', 'acquire-locks', 'ensure-project', 'ensure-git', 'ensure-settings', 'resolve-secrets', 'ensure-environments', 'ensure-domains', 'ensure-dns', 'verify-authoritative', 'verify-vercel-domain', 'verify-tls', 'create-candidate', 'wait-candidate', 'proxy-compatibility', 'candidate-health', 'promote', 'production-health', 'record-known-good', 'report', 'release-locks'];
    for (const phase of phaseIds) {
      expect(steps.filter((step) => step.stepId === phase && step.status === 'SUCCEEDED'), phase).toHaveLength(1);
    }
    expect(steps.every((step) => step.status !== 'RETRYING')).toBe(true);
    expect((await harness.store.getKnownGoodDeployment('fixture-app', 'production'))?.id).toBe('dpl_10');
  });

  it('replays environment reconciliation as a no-op on a second apply', async () => {
    const firstFingerprint = await computeApplyFingerprint(harness, desired);
    await enqueueApply(harness, firstFingerprint);
    const firstInstance = harness.workflowInstances[0];
    if (!firstInstance) throw new Error('workflow instance missing');
    const first = await harness.runWorkflow(ApplyApplicationWorkflow, firstInstance.params, { instanceId: firstInstance.id });
    expect((first.result as Record<string, unknown>).status).toBe('SUCCEEDED');
    expect(harness.states.vercel.envCalls).toHaveLength(3);
    expect(harness.transport.count('PATCH', '/v9/projects/fixture-app/env/')).toBe(0);

    // A second apply of the same manifest sees the converged variables and
    // replays the environment phase with zero writes.
    const secondFingerprint = await computeApplyFingerprint(harness, desired);
    const { operationId } = await enqueueApply(harness, secondFingerprint, { idempotencyKey: 'apply-key-2' });
    const secondInstance = harness.workflowInstances[1];
    if (!secondInstance) throw new Error('workflow instance missing');
    const second = await harness.runWorkflow(ApplyApplicationWorkflow, secondInstance.params, { instanceId: secondInstance.id });
    expect((second.result as Record<string, unknown>).status).toBe('SUCCEEDED');
    const run = await harness.store.getWorkflowRun(operationId);
    expect(run).toMatchObject({ status: 'SUCCEEDED', errorCode: null });

    // Environment reconciliation is idempotent: creates stay at 3, no updates,
    // exactly one list read per apply, and nothing unrelated was deleted.
    expect(harness.states.vercel.envCalls).toHaveLength(3);
    expect(harness.transport.count('POST', '/v10/projects/fixture-app/env')).toBe(3);
    expect(harness.transport.count('PATCH', '/v9/projects/fixture-app/env/')).toBe(0);
    expect(harness.transport.requestsFor('GET', '/v9/projects/fixture-app/env').filter((request) => request.url.endsWith('/v9/projects/fixture-app/env'))).toHaveLength(2);
    expect([...harness.states.vercel.envs.values()].map((env) => env.key).sort()).toEqual(['API_TOKEN', 'DATABASE_URL', 'PROD_TOKEN']);
    // The second apply's environment phase recorded a no-op mutation.
    const steps = await harness.store.listWorkflowSteps(operationId);
    const envStep = steps.find((step) => step.stepId === 'ensure-environments');
    expect(envStep?.result).toMatchObject({ skipped: false, mutation: { changed: false } });
  });

  it('rolls back to the previous known-good when production health fails, keeping the run failed', { timeout: 30_000 }, async () => {
    harness.restore();
    harness = await seedApplyHarness({ seedKnownGood: true });
    desired = await harness.loadFixtureDesired();
    // Production domain health fails; the candidate deployment URL stays healthy.
    harness.states.health.statuses.set('fixture.example.com', 503);
    const planFingerprint = await computeApplyFingerprint(harness, desired);
    const { operationId } = await enqueueApply(harness, planFingerprint);
    const instance = harness.workflowInstances[0];
    if (!instance) throw new Error('workflow instance missing');
    let thrown: Error | null = null;
    try {
      await harness.runWorkflow(ApplyApplicationWorkflow, instance.params, { instanceId: instance.id });
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.name).toBe('LP-HEALTH-PRODUCTION-FAILED');

    // The run stays FAILED with the original code even though recovery rolled back.
    const run = await harness.store.getWorkflowRun(operationId);
    expect(run).toMatchObject({ status: 'FAILED', errorCode: 'LP-HEALTH-PRODUCTION-FAILED' });
    // The durable recovery step records the typed outcome: the rollback fired only
    // because the recorded known-good corroborated the observed pre-promotion CURRENT.
    expect((await harness.store.getWorkflowStep(operationId, 'recover-on-failure'))?.result).toMatchObject({ recoveryOutcome: { kind: 'ROLLED_BACK', knownGoodId: 'dpl_1' } });
    // The provider was asked to roll back from the promoted candidate to the known-good
    // (current official rollback contract: POST /v1/projects/{projectId}/rollback/{knownGoodId}).
    expect(harness.states.vercel.rollbackCalls).toContainEqual({ projectId: 'fixture-app', deploymentId: 'dpl_1' });
    expect((await harness.store.listPromotions('fixture-app')).some((promotion) => promotion.result === 'ROLLED_BACK' && promotion.deploymentId === 'dpl_1')).toBe(true);
    expect((await harness.store.getKnownGoodDeployment('fixture-app', 'production'))?.id).toBe('dpl_1');
    const application = await harness.store.getApplication('fixture-app');
    expect(application).toMatchObject({ syncStatus: 'RECONCILING', healthStatus: 'DEGRADED' });
    expect((await harness.store.listAudit('fixture-app')).some((event) => event.action === 'APPLY_ROLLBACK')).toBe(true);
    expect((await harness.store.listAudit('fixture-app')).some((event) => event.action === 'APPLY_FAILED')).toBe(true);
    // Locks were released after the failure.
    expect(await harness.store.getLock('application:fixture-app')).toBeNull();
  });

  it('blocks a merged apply without a reviewed-plan attestation before any provider write', async () => {
    const planFingerprint = await computeApplyFingerprint(harness, desired, { attest: false });
    const { operationId } = await enqueueApply(harness, planFingerprint);
    const instance = harness.workflowInstances[0];
    if (!instance) throw new Error('workflow instance missing');
    let thrown: Error | null = null;
    try {
      await harness.runWorkflow(ApplyApplicationWorkflow, instance.params, { instanceId: instance.id });
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.name).toBe('LP-PLAN-REVIEW-ATTESTATION-MISSING');
    const run = await harness.store.getWorkflowRun(operationId);
    expect(run).toMatchObject({ status: 'FAILED', errorCode: 'LP-PLAN-REVIEW-ATTESTATION-MISSING' });
    // The failed approval gate precedes every provider mutation; the only
    // provider traffic is the observe-live-state read that feeds the replan.
    expect(harness.transport.count('POST', 'api.vercel.com')).toBe(0);
    expect(harness.transport.count('PATCH', 'api.vercel.com')).toBe(0);
    expect(harness.transport.count('DELETE', 'api.vercel.com')).toBe(0);
    expect(harness.transport.count('POST', 'api.cloudflare.com')).toBe(0);
    expect(await harness.store.getLock('application:fixture-app')).toBeNull();
    expect(await harness.store.getLock('domain:fixture.example.com')).toBeNull();
  });

  it('blocks a merged apply when provider state drifted after review (fresh plan, no attestation for the drifted review fingerprint)', async () => {
    const planFingerprint = await computeApplyFingerprint(harness, desired);
    // Provider state drifts after the review: the live project root changes.
    harness.states.vercel.projects.set('fixture-app', { ...vercelProject(), rootDirectory: 'apps/changed' });
    const { operationId } = await enqueueApply(harness, planFingerprint);
    const instance = harness.workflowInstances[0];
    if (!instance) throw new Error('workflow instance missing');
    let thrown: Error | null = null;
    try {
      await harness.runWorkflow(ApplyApplicationWorkflow, instance.params, { instanceId: instance.id });
    } catch (error) {
      thrown = error as Error;
    }
    // The drifted replan is fresh against the submitted (drifted) fingerprint
    // only if the enqueue fingerprint is recomputed; with the reviewed
    // fingerprint the replan no longer matches it, so the freshness gate
    // fires first — either way the apply stops before any provider write.
    expect(['LP-PLAN-STALE', 'LP-PLAN-REVIEW-ATTESTATION-MISSING']).toContain(thrown?.name);
    const run = await harness.store.getWorkflowRun(operationId);
    expect(['LP-PLAN-STALE', 'LP-PLAN-REVIEW-ATTESTATION-MISSING']).toContain(run?.errorCode);
    expect(harness.transport.count('POST', 'api.vercel.com')).toBe(0);
    expect(harness.transport.count('PATCH', 'api.vercel.com')).toBe(0);
    expect(harness.transport.count('POST', 'api.cloudflare.com')).toBe(0);
    expect(await harness.store.getLock('application:fixture-app')).toBeNull();
  });
});
