import { expect, it } from 'vitest';
import { GitHubAdapter } from './index.js';
import type { ProviderContext } from '@launchpad/provider-contract';

const ctx: ProviderContext = { correlationId: 'corr', applicationId: 'app', workflowId: 'wf', actor: { kind: 'system', id: 'test' }, dryRun: false };

it('observes repository metadata and distinguishes file paths', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/repos/acme/app')) return new Response(JSON.stringify({ id: 42, archived: false, private: true, default_branch: 'main' }), { status: 200 });
    if (url.includes('/contents/apps%2Fweb')) return new Response(JSON.stringify({ type: 'dir' }), { status: 200 });
    return new Response('{}', { status: 200 });
  };
  const adapter = new GitHubAdapter({ token: 'token', fetchImpl });
  await expect(adapter.observeRepository('acme/app', ctx)).resolves.toMatchObject({ repositoryId: 42, private: true, access: true });
  await expect(adapter.hasPath('acme/app', 'main', 'apps/web', ctx)).resolves.toBe('directory');
});
