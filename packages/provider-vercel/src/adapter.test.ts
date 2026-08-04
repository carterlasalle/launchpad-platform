import { expect, it } from 'vitest';
import { VercelAdapter } from './index.js';
import type { ProjectSpec, ProviderContext } from '@launchpad/provider-contract';

const ctx: ProviderContext = { correlationId: 'corr', applicationId: 'app', workflowId: 'wf', actor: { kind: 'system', id: 'test' }, dryRun: false };
const project: ProjectSpec = { id: 'app', name: 'app', teamId: null, framework: 'nextjs', rootDirectory: '.', nodeVersion: '24.x', build: { installCommand: 'yarn install', buildCommand: 'yarn build', outputDirectory: null }, repository: 'acme/app', productionBranch: 'main', settings: { autoAssignProductionDomains: false } };

it('creates a Vercel project and verifies the postcondition', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
    if (init?.method === 'POST') return new Response(JSON.stringify({ id: 'prj_1', name: 'app' }), { status: 200 });
    return new Response(JSON.stringify({ id: 'prj_1', name: 'app', framework: 'nextjs', rootDirectory: '.', nodeVersion: '24.x' }), { status: 200 });
  };
  const adapter = new VercelAdapter({ token: 'token', fetchImpl });
  const result = await adapter.ensureProject(project, ctx);
  expect(result.resource.providerResourceId).toBe('prj_1');
  expect(result.changed).toBe(true);
});
