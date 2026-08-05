import { expect, it } from 'vitest';
import type { DesiredApplication } from '@launchpad/core';
import { InMemoryLaunchpadStore } from '@launchpad/database';
import { VercelAdapter } from '@launchpad/provider-vercel';
import { renderAppPreviewComment, runAppPreviewStatusWorkflow } from './index.js';
import type { ProviderContext } from '@launchpad/provider-contract';

const desired: DesiredApplication = {
  apiVersion: 'launchpad.dev/v1', kind: 'Application', metadata: { id: 'app', displayName: 'App', owners: ['@platform'], labels: {}, annotations: {} }, repository: { provider: 'github', name: 'acme/app', productionBranch: 'main', deploymentRef: 'main' }, vercel: { scope: {}, project: { name: 'app', framework: 'nextjs', rootDirectory: '.', nodeVersion: '24.x', build: { installCommand: 'yarn install', buildCommand: 'yarn build', outputDirectory: null, developmentCommand: null, ignoredBuildStep: null }, git: { connected: true, productionBranch: 'main' }, deployment: { autoAssignProductionDomains: false, prioritizeProductionBuilds: true, rollingRelease: null, skewProtection: false }, regions: { functions: [] }, protection: {}, settings: {} } }, environments: { preview: { enabled: true, health: { path: '/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 1, attempts: 1, intervalSeconds: 0 } }, production: { enabled: true, health: { path: '/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 1, attempts: 1, intervalSeconds: 0 }, release: { strategy: 'staged-production', promoteExactBuild: true, autoPromoteAfterChecks: true }, rollback: { enabled: false, onFailedHealthCheck: false, previousKnownGood: false } } }, domains: [], secrets: [], dependencies: { applications: [], external: [] }, policies: { drift: { mode: 'open-pr', checkIntervalMinutes: 30 }, destructiveChanges: { allowInNormalApply: false }, preview: { requiredForMerge: true }, staging: { requiredForProduction: false }, health: { requiredForPromotion: true }, failures: { createIssueAfterFinalRetry: true, notifyOwners: true } }, lifecycle: { state: 'active', deletionProtection: true, orphanPolicy: 'retain', decommission: { requestedAt: null, deleteAfter: null, approvalToken: null, preserveDeployments: true } },
};
const context: ProviderContext = { correlationId: 'corr', applicationId: 'app', workflowId: 'preview-status', actor: { kind: 'github-actions', id: 'acme/app' }, dryRun: false };
const COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);
const HEALTH_OK = async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 });

async function seededStore(): Promise<InMemoryLaunchpadStore> {
  const store = new InMemoryLaunchpadStore();
  await store.upsertApplication({ id: 'app', displayName: 'App', sourcePath: 'catalog/apps/app.yaml', desiredGeneration: 1, desiredHash: '', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
  return store;
}

function vercelDeployment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { uid: 'dpl_preview', name: 'app', url: 'app-123.vercel.app', state: 'READY', readyState: 'READY', target: null, createdAt: '2026-08-04T08:00:00.000Z', meta: { gitCommitSha: COMMIT, githubCommitSha: COMMIT }, ...overrides };
}

function recordedAdapter(fetchImpl: typeof fetch): VercelAdapter {
  return new VercelAdapter({ token: 'token', fetchImpl });
}

function detailResponse(state: string): Record<string, unknown> {
  return { id: 'dpl_preview', projectId: 'app', url: 'app-123.vercel.app', readyState: state, target: null, meta: { gitCommitSha: COMMIT } };
}

function listResponse(deployments: unknown[], state = 'READY'): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.includes('/v7/deployments')) return new Response(JSON.stringify({ deployments }), { status: 200 });
    if (url.includes('/v13/deployments/dpl_preview')) return new Response(JSON.stringify(detailResponse(state)), { status: 200 });
    if (url.includes('/events')) return new Response(JSON.stringify({ events: [{ type: 'command', payload: { command: 'yarn build' } }, { type: 'stdout', payload: { text: 'compiled successfully' } }] }), { status: 200 });
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  };
}

it('passes the gate for the exact commit with READY build and healthy preview URL', async () => {
  const list = [{ ...vercelDeployment(), meta: { gitCommitSha: COMMIT } }];
  const adapter = recordedAdapter(listResponse(list));
  const result = await runAppPreviewStatusWorkflow({ store: await seededStore(), provider: adapter, desired, sourceCommit: COMMIT, context, fetchImpl: HEALTH_OK, sleep: async () => undefined, waitPollMs: 1 });
  expect(result.status).toBe('SUCCEEDED');
  expect(result.gateState).toBe('PASSED');
  expect(result.buildState).toBe('READY');
  expect(result.healthState).toBe('PASSED');
  expect(result.deployment?.id).toBe('dpl_preview');
  expect(result.deployment?.commitSha).toBe(COMMIT);
  expect(result.deploymentStatus).toEqual({ state: 'success', description: expect.stringContaining(COMMIT.slice(0, 12)), targetUrl: 'https://app-123.vercel.app', logUrl: null });
  expect(result.commentBody).toContain('<!-- launchpad:app-preview -->');
  expect(result.commentBody).toContain(`\`${COMMIT.slice(0, 12)}\``);
  expect(result.commentBody).toContain('https://app-123.vercel.app');
  expect(result.commentBody).toContain(result.operationId ?? '');
  expect(result.logs?.excerpt).toContain('compiled successfully');
});

it('never accepts a deployment for another commit or a branch-latest fallback', async () => {
  const adapter = recordedAdapter(listResponse([vercelDeployment({ meta: { gitCommitSha: OTHER_COMMIT } })]));
  const result = await runAppPreviewStatusWorkflow({ store: await seededStore(), provider: adapter, desired, sourceCommit: COMMIT, context, fetchImpl: HEALTH_OK, sleep: async () => undefined });
  expect(result.status).toBe('FAILED');
  expect(result.failure?.code).toBe('LP-VERCEL-PREVIEW-NOT_FOUND');
  expect(result.gateState).toBe('FAILED');
  expect(result.deployment).toBeNull();

  // A deployment that carries no explicit commit identity (branch-only) is not accepted either.
  const branchLatest = [{ uid: 'dpl_branch', name: 'app', url: 'app-456.vercel.app', state: 'READY', target: null, meta: { githubRef: 'refs/heads/feature' } }];
  const adapter2 = recordedAdapter(listResponse(branchLatest));
  const result2 = await runAppPreviewStatusWorkflow({ store: await seededStore(), provider: adapter2, desired, sourceCommit: COMMIT, context, fetchImpl: HEALTH_OK, sleep: async () => undefined });
  expect(result2.status).toBe('FAILED');
  expect(result2.failure?.code).toBe('LP-VERCEL-PREVIEW-NOT_FOUND');
});

it('rejects a production-targeted deployment for the same commit', async () => {
  const list = [vercelDeployment({ target: 'production' })];
  const adapter = recordedAdapter(listResponse(list));
  const result = await runAppPreviewStatusWorkflow({ store: await seededStore(), provider: adapter, desired, sourceCommit: COMMIT, context, fetchImpl: HEALTH_OK, sleep: async () => undefined });
  expect(result.status).toBe('FAILED');
  expect(result.failure?.code).toBe('LP-VERCEL-PREVIEW-NOT_FOUND');
});

it('fails loudly and visibly when the build is canceled', async () => {
  const adapter = recordedAdapter(listResponse([vercelDeployment({ state: 'CANCELED', readyState: 'CANCELED' })], 'CANCELED'));
  const result = await runAppPreviewStatusWorkflow({ store: await seededStore(), provider: adapter, desired, sourceCommit: COMMIT, context, fetchImpl: HEALTH_OK, sleep: async () => undefined });
  expect(result.status).toBe('FAILED');
  expect(result.buildState).toBe('CANCELED');
  expect(result.failure?.code).toBe('LP-VERCEL-BUILD-FAILED');
  expect(result.commentBody).toContain('CANCELED');
});

it('fails loudly with bounded redacted logs when the build ends in ERROR', async () => {
  const events: unknown[] = [];
  for (let index = 0; index < 300; index += 1) events.push({ type: 'stdout', payload: { text: `line ${index} api_key=supersecret-value` } });
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/v7/deployments')) return new Response(JSON.stringify({ deployments: [vercelDeployment({ state: 'ERROR', readyState: 'ERROR' })] }), { status: 200 });
    if (url.includes('/v13/deployments/dpl_preview')) return new Response(JSON.stringify(detailResponse('ERROR')), { status: 200 });
    if (url.includes('/events')) return new Response(JSON.stringify({ events }), { status: 200 });
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  };
  const result = await runAppPreviewStatusWorkflow({ store: await seededStore(), provider: recordedAdapter(fetchImpl), desired, sourceCommit: COMMIT, context, fetchImpl: HEALTH_OK, sleep: async () => undefined, maxLogLines: 50, maxLogBytes: 4_000 });
  expect(result.status).toBe('FAILED');
  expect(result.gateState).toBe('FAILED');
  expect(result.buildState).toBe('ERROR');
  expect(result.failure?.code).toBe('LP-VERCEL-BUILD-FAILED');
  expect(result.deploymentStatus.state).toBe('error');
  expect(result.logs?.truncated).toBe(true);
  expect(result.logs?.excerpt.length).toBeLessThanOrEqual(4_000);
  expect(result.logs?.excerpt).not.toContain('supersecret-value');
  expect(result.logs?.excerpt).toContain('api_key=[REDACTED]');
  expect(result.commentBody).toContain('LP-VERCEL-BUILD-FAILED');
  expect(result.commentBody).toContain('api_key=[REDACTED]');
});

it('treats a timed-out build as terminal failure with TIMEOUT state', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/v7/deployments')) return new Response(JSON.stringify({ deployments: [vercelDeployment({ state: 'BUILDING' })] }), { status: 200 });
    if (url.includes('/v13/deployments/dpl_preview')) return new Response(JSON.stringify({ id: 'dpl_preview', projectId: 'app', url: 'app-123.vercel.app', readyState: 'BUILDING', target: null, meta: { gitCommitSha: COMMIT } }), { status: 200 });
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  };
  const result = await runAppPreviewStatusWorkflow({ store: await seededStore(), provider: recordedAdapter(fetchImpl), desired, sourceCommit: COMMIT, context, fetchImpl: HEALTH_OK, sleep: async () => undefined, waitTimeoutMs: 60, waitPollMs: 5 });
  expect(result.status).toBe('FAILED');
  expect(result.failure?.code).toBe('LP-VERCEL-DEPLOYMENT-TIMEOUT');
  expect(result.buildState).toBe('TIMEOUT');
  expect(result.deploymentStatus.state).toBe('error');
});

it('surfaces a malformed provider response as a visible terminal failure', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).includes('/v7/deployments')) return new Response('<html>gateway error</html>', { status: 200 });
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  };
  const result = await runAppPreviewStatusWorkflow({ store: await seededStore(), provider: recordedAdapter(fetchImpl), desired, sourceCommit: COMMIT, context, fetchImpl: HEALTH_OK, sleep: async () => undefined });
  expect(result.status).toBe('FAILED');
  expect(result.failure?.code).toBe('LP-VERCEL-MALFORMED-RESPONSE');
  expect(result.commentBody).not.toContain('<html>');
});

it('fails the gate and reports health failure details when the preview URL is unhealthy', async () => {
  const adapter = recordedAdapter(listResponse([vercelDeployment()]));
  const result = await runAppPreviewStatusWorkflow({ store: await seededStore(), provider: adapter, desired, sourceCommit: COMMIT, context, fetchImpl: async () => new Response('boom <script>alert(1)</script>', { status: 500 }), sleep: async () => undefined });
  expect(result.status).toBe('FAILED');
  expect(result.healthState).toBe('FAILED');
  expect(result.failure?.code).toBe('LP-HEALTH-PREVIEW-FAILED');
  expect(result.deploymentStatus.state).toBe('failure');
  expect(result.commentBody).toContain('LP-HEALTH-PREVIEW-FAILED');
  expect(result.commentBody).not.toContain('<script>');
});

it('escapes and redacts every provider-derived value in the sticky comment', () => {
  const body = renderAppPreviewComment({ applicationId: 'app', sourceCommit: COMMIT, buildState: 'ERROR', previewUrl: 'https://app-123.vercel.app', healthState: null, healthDetails: 'expected 200 but got 500 | token=abc123', failure: { code: 'LP-VERCEL-BUILD-FAILED', message: 'build failed with <b>boom</b>' }, logs: 'error: secret=xyz\n```', operationId: 'op-1', correlationId: 'corr-1' });
  expect(body).toContain('<!-- launchpad:app-preview -->');
  expect(body).toContain('token=[REDACTED]');
  expect(body).toContain('&lt;b&gt;boom&lt;/b&gt;');
  expect(body).not.toContain('<b>');
  expect(body).not.toContain('| expected');
  expect(body).toContain('op-1');
  expect(body).toContain('corr-1');
});

it('renders non-https preview URLs as escaped text instead of markdown links', () => {
  const body = renderAppPreviewComment({ applicationId: 'app', sourceCommit: COMMIT, buildState: 'READY', previewUrl: 'http://not-tls.example', healthState: 'PASSED', healthDetails: null, failure: null, logs: null, operationId: 'op-2', correlationId: 'corr-2' });
  expect(body).toContain('http://not-tls.example');
  expect(body).not.toContain('[open preview](http://not-tls.example)');
});