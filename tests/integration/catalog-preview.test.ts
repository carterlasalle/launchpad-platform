import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesiredApplication } from '@launchpad/core';
import { AppPreviewStatusWorkflow, PreviewApplicationWorkflow } from '../../apps/controller/src/workflows.js';
import { controlPrClaims, prClaims, signGithubToken } from '../fixtures/oidc.js';
import { HEAD_SHA, MAIN_SHA, MERGE_SHA, SOURCE_COMMIT, createHarness, type ControllerHarness } from './harness.js';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class WorkflowEntrypoint {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) { this.env = env; }
  },
}));

const WORKFLOW_REF = 'example/control/.github/workflows/preview.yml@refs/heads/main';
const PR_NUMBER = 42;

async function previewEnqueueBody(harness: ControllerHarness, desired: DesiredApplication, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return {
    version: 1,
    applicationId: 'fixture-app',
    sourceCommit: HEAD_SHA,
    idempotencyKey: 'preview-key-1',
    repositoryId: '123456789',
    ownerId: '987654321',
    repository: 'example/control',
    workflowRef: WORKFLOW_REF,
    event: 'pull_request',
    prNumber: PR_NUMBER,
    ref: `refs/pull/${PR_NUMBER}/merge`,
    actor: 'alice',
    planFingerprint: 'preview-fp-1',
    desired,
    ...overrides,
  };
}

async function seedPreviewHarness(): Promise<ControllerHarness> {
  const harness = await createHarness();
  const desired = await harness.loadFixtureDesired();
  harness.setControlManifest(harness.fixtureYaml());
  harness.states.github.pulls.set(PR_NUMBER, { number: PR_NUMBER, branch: 'feature/preview', sha: HEAD_SHA });
  // A main-project deployment at the exact PR head for the status gate.
  harness.states.vercel.deployments.set('dpl_9', {
    id: 'dpl_9', projectId: 'fixture-app', url: 'fixture-app-gate.vercel.app', state: 'READY', readyState: 'READY',
    commitSha: HEAD_SHA, target: 'preview', createdAt: '2026-08-04T00:00:00.000Z',
    meta: { repo: 'example/fixture', desiredGeneration: '1' },
  });
  return harness;
}

describe('catalog PR preview flow (integration)', () => {
  let harness: ControllerHarness;
  let desired: DesiredApplication;

  beforeEach(async () => { harness = await seedPreviewHarness(); desired = await harness.loadFixtureDesired(); });
  afterEach(() => { harness.restore(); });

  it('enqueues a claim-bound preview: 202, D1 idempotency, one workflow instance', async () => {
    const token = await signGithubToken(harness.oidc, controlPrClaims(PR_NUMBER, MERGE_SHA));
    const body = await previewEnqueueBody(harness, desired);
    const response = await harness.request('/v1/applications/fixture-app/preview/verify', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    expect(response.status).toBe(202);
    const enqueued = await response.json() as { workflowId: string; operationId: string; status: string };
    expect(enqueued.status).toBe('QUEUED');
    expect(enqueued.workflowId).toBe(`lp-preview-${enqueued.operationId}`);
    expect(harness.workflowInstances).toHaveLength(1);
    expect(harness.workflowInstances[0]?.params).toMatchObject({ kind: 'preview', applicationId: 'fixture-app', sourceCommit: HEAD_SHA, prNumber: PR_NUMBER });

    // Durable ledger: run row, idempotent request row, claim-binding audit.
    const run = await harness.store.getWorkflowRun(enqueued.operationId);
    expect(run).toMatchObject({ workflowType: 'preview', status: 'QUEUED', idempotencyKey: 'preview-key-1', payloadHash: expect.any(String) as string });
    const idempotent = await harness.store.getIdempotentRequest('preview-key-1');
    expect(idempotent?.operationId).toBe(enqueued.operationId);
    const audit = await harness.store.listAudit('fixture-app');
    const startEvent = audit.find((event) => event.action === 'OIDC_OPERATION_START');
    expect(startEvent?.details).toMatchObject({ operationId: enqueued.operationId, workflowId: enqueued.workflowId, repositoryId: '123456789', repository: 'example/control', prNumber: PR_NUMBER, sourceCommit: HEAD_SHA });

    // Replaying the same idempotency key returns the same operation and reuses
    // the same workflow instance id (the platform dedupes by instance id).
    const replay = await harness.request('/v1/applications/fixture-app/preview/verify', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    expect(replay.status).toBe(202);
    await expect(replay.json()).resolves.toMatchObject({ operationId: enqueued.operationId, status: 'QUEUED' });
    expect(harness.workflowInstances.map((instance) => instance.id)).toEqual([enqueued.workflowId, enqueued.workflowId]);
  });

  it('runs the granular preview phases through real adapters to an exact deployment URL and passed health', async () => {
    const token = await signGithubToken(harness.oidc, controlPrClaims(PR_NUMBER, MERGE_SHA));
    const body = await previewEnqueueBody(harness, desired);
    const response = await harness.request('/v1/applications/fixture-app/preview/verify', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const enqueued = await response.json() as { workflowId: string; operationId: string };
    const instance = harness.workflowInstances[0];
    if (!instance) throw new Error('workflow instance missing');

    const { result, steps } = await harness.runWorkflow(PreviewApplicationWorkflow, instance.params, { instanceId: instance.id });
    const outcomes = result as Record<string, unknown>;
    // The staged machine returns the per-stage results; the health gate
    // passed against the exact deployment URL.
    expect((outcomes['health-check'] as { result?: string } | null)?.result).toBe('PASSED');
    expect(outcomes['schedule-cleanup']).toMatchObject({ cleanupJobId: expect.any(String) as string });
    expect(steps.executed).toEqual([
      'validate preview request',
      'preview validate', 'preview supersede', 'preview create-shadow-project', 'preview apply-settings',
      'preview create-deployment', 'preview wait-for-build', 'preview collect-build-logs', 'preview build-gate',
      'preview health-check', 'preview report', 'preview schedule-cleanup',
    ]);

    // Persisted boundaries: run READY, every stage step recorded once, exact-commit deployment.
    const run = await harness.store.getWorkflowRun(enqueued.operationId);
    expect(run).toMatchObject({ status: 'READY', errorCode: null });
    const stepsRows = await harness.store.listWorkflowSteps(enqueued.operationId);
    expect(stepsRows.filter((step) => step.status === 'SUCCEEDED')).toHaveLength(11);
    const deployments = await harness.store.listDeployments('fixture-app', { environment: 'preview' });
    const previewDeployment = deployments.find((deployment) => deployment.id.startsWith('dpl_'));
    expect(previewDeployment?.commitSha).toBe(MAIN_SHA);
    expect(previewDeployment?.url).toMatch(/^https:\/\/lp-pr-42-.*\.vercel\.app$/);
    const health = await harness.store.listHealthChecks('fixture-app', { environment: 'preview' });
    expect(health[0]).toMatchObject({ result: 'PASSED', url: previewDeployment?.url ?? '' });
    const cleanupJobs = await harness.store.listCleanupJobs('fixture-app');
    expect(cleanupJobs).toHaveLength(1);
    expect((await harness.store.listAudit('fixture-app')).some((event) => event.action === 'PREVIEW_REPORT')).toBe(true);

    // Exact-commit transport: the deployment was created for the PR head sha and the shadow project is collision-resistant.
    const createCalls = harness.transport.jsonBodies('POST', '/v13/deployments');
    expect(createCalls).toHaveLength(1);
    expect((createCalls[0] as Record<string, unknown>).gitSource).toMatchObject({ sha: MAIN_SHA, ref: MAIN_SHA });
    const projectCalls = harness.transport.jsonBodies('POST', '/v10/projects');
    expect((projectCalls[0] as Record<string, unknown>).name).toMatch(/^lp-pr-42-/);
    // The string repositoryId from the OIDC binding must reach the shadow
    // project name; otherwise the workflow falls back to a GitHub observe.
    expect((projectCalls[0] as Record<string, unknown>).name).toContain('123456789');
    expect(harness.transport.allBodies().toLowerCase()).not.toContain('canary');
  });

  it('serves claim-scoped poll, status evidence, and artifacts; foreign claims are rejected', async () => {
    const token = await signGithubToken(harness.oidc, controlPrClaims(PR_NUMBER, MERGE_SHA));
    const body = await previewEnqueueBody(harness, desired);
    const response = await harness.request('/v1/applications/fixture-app/preview/verify', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const enqueued = await response.json() as { workflowId: string; operationId: string };
    const instance = harness.workflowInstances[0];
    if (!instance) throw new Error('workflow instance missing');
    await harness.runWorkflow(PreviewApplicationWorkflow, instance.params, { instanceId: instance.id });

    // Scoped poll: the bound workflow token sees the terminal READY status.
    const poll = await harness.request(`/v1/operations/${enqueued.operationId}`, { headers: { authorization: `Bearer ${token}` } });
    expect(poll.status).toBe(200);
    const pollBody = await poll.json() as { status: string; kind: string; applicationId: string; sourceCommit: string | null; errorCode: string | null };
    expect(pollBody).toMatchObject({ status: 'READY', kind: 'preview', applicationId: 'fixture-app', sourceCommit: HEAD_SHA, errorCode: null });

    // A token minted for another repository cannot poll this operation: the
    // gzg.3 control-repository gate rejects it at the middleware before any
    // operation-scope binding is consulted.
    const foreignToken = await signGithubToken(harness.oidc, prClaims(PR_NUMBER, MERGE_SHA, { repository: 'acme/other', repository_id: '111111', repository_owner_id: '222222', workflow_ref: 'acme/other/.github/workflows/x.yml@refs/heads/main' }));
    const foreign = await harness.request(`/v1/operations/${enqueued.operationId}`, { headers: { authorization: `Bearer ${foreignToken}` } });
    expect(foreign.status).toBe(401);
    await expect(foreign.json()).resolves.toMatchObject({ error: { code: 'LP-OIDC-REPOSITORY-NOT-CONTROL' } });

    // Status gate: exact-commit preview evidence with build logs and redacted comment.
    const statusBody = { version: 1, applicationId: 'fixture-app', sourceCommit: HEAD_SHA, repository: 'example/fixture', repositoryId: '123456789', repositoryOwnerId: '987654321', event: 'pull_request' };
    // Preview status is reported by the APPLICATION repository's workflow (not
    // gated by the control-repository middleware; its own verification binds
    // the app-repo token).
    const appToken = await signGithubToken(harness.oidc, prClaims(PR_NUMBER, MERGE_SHA));
    const status = await harness.request('/v1/applications/fixture-app/preview/status', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${appToken}` }, body: JSON.stringify(statusBody) });
    expect(status.status).toBe(200);
    const evidence = await status.json() as { status: string; gateState: string; buildState: string; healthState: string; sourceCommit: string; deployment: { url: string } | null; logs: { excerpt: string } | null; commentBody: string; deploymentStatus: { state: string } };
    expect(evidence).toMatchObject({ status: 'SUCCEEDED', gateState: 'PASSED', buildState: 'READY', healthState: 'PASSED', sourceCommit: HEAD_SHA, deploymentStatus: { state: 'success' } });
    expect(evidence.deployment?.url).toBe('https://fixture-app-gate.vercel.app');
    expect(evidence.logs?.excerpt).toContain('Compiled successfully');
    expect(evidence.commentBody).toContain('https://fixture-app-gate.vercel.app');
    expect(evidence.commentBody.toLowerCase()).not.toContain('canary');
    expect(harness.transport.allBodies().toLowerCase()).not.toContain('canary');
  });

  it('enqueues health runs on the dedicated app-preview-status machine and reaches the real gate stages', async () => {
    const token = await signGithubToken(harness.oidc, controlPrClaims(PR_NUMBER, MERGE_SHA));
    const body = {
      version: 1,
      applicationId: 'fixture-app',
      sourceCommit: HEAD_SHA,
      idempotencyKey: 'health-key-1',
      repositoryId: '123456789',
      ownerId: '987654321',
      repository: 'example/control',
      workflowRef: WORKFLOW_REF,
      event: 'pull_request',
      prNumber: PR_NUMBER,
      ref: `refs/pull/${PR_NUMBER}/merge`,
      actor: 'alice',
    };
    const response = await harness.request('/v1/applications/fixture-app/health/run', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    expect(response.status).toBe(202);
    const enqueued = await response.json() as { workflowId: string; operationId: string; status: string };
    expect(enqueued.status).toBe('QUEUED');
    expect(enqueued.workflowId).toMatch(/^lp-app-preview-status-[0-9a-f]{16}$/);
    expect(harness.workflowInstances).toHaveLength(1);
    expect(harness.workflowInstances[0]?.params).toMatchObject({ version: 1, kind: 'app-preview-status', applicationId: 'fixture-app', sourceCommit: HEAD_SHA, prNumber: PR_NUMBER });

    // Run the dedicated machine: it validates the versioned envelope, then
    // dispatches the real app-preview-status handler (durable gate stages).
    const instance = harness.workflowInstances[0];
    if (!instance) throw new Error('workflow instance missing');
    const { result, steps } = await harness.runWorkflow(AppPreviewStatusWorkflow, instance.params, { instanceId: instance.id });
    const gate = result as { status: string; gateState: string; buildState: string; healthState: string; operationId: string };
    expect(gate).toMatchObject({ status: 'SUCCEEDED', gateState: 'PASSED', buildState: 'READY', healthState: 'PASSED' });
    expect(steps.executed).toEqual(['validate app-preview-status payload', 'run app-preview-status workflow']);

    // The outer durable run reached SUCCEEDED; the inner gate run persisted
    // every real stage boundary through the store.
    const run = await harness.store.getWorkflowRun(enqueued.operationId);
    expect(run).toMatchObject({ status: 'SUCCEEDED', errorCode: null });
    const gateRun = await harness.store.getWorkflowRun(gate.operationId);
    expect(gateRun).toMatchObject({ workflowType: 'PREVIEW_STATUS', status: 'SUCCEEDED' });
    expect(gateRun?.idempotencyKey).toMatch(/^[0-9a-f]{16}$/);
    const stageRows = await harness.store.listWorkflowSteps(gate.operationId);
    const expectedStages = ['locate-deployment', 'wait-for-build', 'collect-build-logs', 'build-gate', 'health-check', 'report'];
    expect(stageRows.map((step) => step.stepId).sort()).toEqual([...expectedStages].sort());

    // The claim-scoped poll projects the gate result without provider bodies.
    const poll = await harness.request(`/v1/operations/${enqueued.operationId}`, { headers: { authorization: `Bearer ${token}` } });
    expect(poll.status).toBe(200);
    await expect(poll.json()).resolves.toMatchObject({ status: 'SUCCEEDED', kind: 'app-preview-status', sourceCommit: HEAD_SHA, result: { previewUrl: 'https://fixture-app-gate.vercel.app', buildState: 'READY', healthState: 'PASSED' } });
  });

  it('keeps invalid-root build failures, health failures, and stale commits failed and visible', async () => {
    const token = await signGithubToken(harness.oidc, controlPrClaims(PR_NUMBER, MERGE_SHA));
    const cases: Array<{ name: string; script: (h: ControllerHarness) => void; expectedError: string }> = [
      { name: 'invalid root build', script: (h) => { h.states.vercel.defaultTerminalState = 'ERROR'; }, expectedError: 'LP-VERCEL-BUILD-FAILED' },
      { name: 'health failure', script: (h) => { h.states.health.defaultStatus = 503; }, expectedError: 'LP-HEALTH-PREVIEW-FAILED' },
      { name: 'stale commit', script: (h) => { h.states.vercel.commitShaOverride = SOURCE_COMMIT; }, expectedError: 'LP-VERCEL-DEPLOYMENT-COMMIT-MISMATCH' },
    ];
    for (const fixture of cases) {
      const h = await seedPreviewHarness();
      fixture.script(h);
      const t = await signGithubToken(h.oidc, controlPrClaims(PR_NUMBER, MERGE_SHA));
      const body = await previewEnqueueBody(h, desired);
      const response = await h.request('/v1/applications/fixture-app/preview/verify', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: JSON.stringify(body) });
      const enqueued = await response.json() as { workflowId: string; operationId: string };
      const instance = h.workflowInstances[0];
      if (!instance) throw new Error('workflow instance missing');
      let thrown: Error | null = null;
      try {
        await h.runWorkflow(PreviewApplicationWorkflow, instance.params, { instanceId: instance.id });
      } catch (error) {
        thrown = error as Error;
      }
      expect(thrown, fixture.name).not.toBeNull();
      expect(thrown?.name, fixture.name).toBe(fixture.expectedError);

      // The durable run is FAILED with the typed code; the failing step row records the error.
      const run = await h.store.getWorkflowRun(enqueued.operationId);
      expect(run?.status, fixture.name).toBe('FAILED');
      expect(run?.errorCode, fixture.name).toBe(fixture.expectedError);
      const failedSteps = (await h.store.listWorkflowSteps(enqueued.operationId)).filter((step) => step.status === 'FAILED');
      expect(failedSteps.length, fixture.name).toBeGreaterThan(0);
      const failure = failedSteps[0]?.error as { name?: string } | null;
      expect(failure?.name, fixture.name).toBe(fixture.expectedError);
      // Failures surface in observability: a provider-error row and an incident.
      const errors = await h.store.listProviderErrors('fixture-app');
      expect(errors.some((error) => error.code === fixture.expectedError), fixture.name).toBe(true);
      const incidents = await h.store.listIncidents();
      expect(incidents.length, fixture.name).toBeGreaterThan(0);

      // The claim-scoped poll reports the failure, never a false terminal.
      const poll = await h.request(`/v1/operations/${enqueued.operationId}`, { headers: { authorization: `Bearer ${t}` } });
      const pollBody = await poll.json() as { status: string; errorCode: string | null };
      expect(pollBody.status, fixture.name).toBe('FAILED');
      expect(pollBody.errorCode, fixture.name).toBe(fixture.expectedError);
      h.restore();
    }
  });
});
