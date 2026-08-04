import { expect, it } from 'vitest';
import { CloudflareAdapter } from './index.js';
import type { ProviderContext } from '@launchpad/provider-contract';

const ctx: ProviderContext = { correlationId: 'corr', applicationId: 'app', workflowId: 'wf', actor: { kind: 'system', id: 'test' }, dryRun: false };

it('creates owned DNS records and blocks conflicting records', async () => {
  let content = JSON.stringify({ result: [], success: true, errors: [], messages: [] });
  const fetchImpl: typeof fetch = async (_input, init) => {
    if (init?.method === 'POST') content = JSON.stringify({ result: { id: 'record-1', name: 'app.example.com', type: 'CNAME', content: 'target.example', ttl: 1, proxied: false, comment: 'launchpad:owned' }, success: true });
    return new Response(content, { status: 200 });
  };
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  const result = await adapter.ensureRecord('zone-1', { hostname: 'app.example.com', type: 'CNAME', value: 'target.example', ttl: 'auto' }, 'owned', ctx);
  expect(result.resource.id).toBe('record-1');
});

it('refuses an existing record without Launchpad ownership metadata', async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ result: [{ id: 'record-1', name: 'app.example.com', type: 'CNAME', content: 'other.example', ttl: 1, proxied: false }], success: true }), { status: 200 });
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  await expect(adapter.ensureRecord('zone-1', { hostname: 'app.example.com', type: 'CNAME', value: 'target.example', ttl: 'auto' }, 'owned', ctx)).rejects.toMatchObject({ code: 'LP-DNS-CONFLICT-UNOWNED' });
});
