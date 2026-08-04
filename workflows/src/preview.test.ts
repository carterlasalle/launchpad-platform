import { expect, it } from 'vitest';
import { FakeProvider } from '@launchpad/provider-testkit';
import { runPreviewWorkflow, cleanupExpiredShadowProjects, cleanupShadowProject } from './index.js';
import type { ProjectSpec, ProviderContext } from '@launchpad/provider-contract';

const ctx: ProviderContext = { correlationId: 'corr', applicationId: 'app', workflowId: 'wf', actor: { kind: 'system', id: 'test' }, dryRun: false };
const project: ProjectSpec = { id: 'app', name: 'app', teamId: null, framework: 'nextjs', rootDirectory: '.', nodeVersion: '24.x', build: { installCommand: 'yarn install', buildCommand: 'yarn build', outputDirectory: null }, repository: 'acme/app', productionBranch: 'main', settings: {} };

it('creates an isolated shadow project, waits for deployment, and checks health', async () => {
  const provider = new FakeProvider();
  const result = await runPreviewWorkflow({ provider, project, pullRequestNumber: 42, revision: 3, commitSha: 'a'.repeat(40), health: { path: '/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 1, attempts: 1, intervalSeconds: 0 }, context: ctx, fetchImpl: async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }), sleep: async () => undefined });
  expect(result.projectName).toContain('lp-pr-42-app-3');
  expect(result.deployment.state).toBe('READY');
  expect(result.health.result).toBe('PASSED');
});

it('reports cleanup failures as visible results', async () => {
  const provider = new FakeProvider();
  const cleanup = await cleanupShadowProject(provider, 'does-not-exist', ctx);
  expect(cleanup.status).toBe('FAILED');
  expect(cleanup.errorCode).toBe('LP-PREVIEW-CLEANUP-FAILED');
});
it('cleans expired shadow projects through the owned-resource sweep', async () => {
  const provider = new FakeProvider();
  await runPreviewWorkflow({ provider, project, pullRequestNumber: 7, revision: 1, commitSha: 'b'.repeat(40), health: { path: '/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 1, attempts: 1, intervalSeconds: 0 }, context: ctx, fetchImpl: async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }), sleep: async () => undefined });
  const sweep = await cleanupExpiredShadowProjects(provider, ctx, new Date(Date.now() + 2 * 24 * 60 * 60 * 1000));
  expect(sweep.failed).toEqual([]);
  expect(sweep.cleaned).toHaveLength(1);
});
