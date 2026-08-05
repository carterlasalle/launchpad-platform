import { expect, it } from 'vitest';
import { VercelAdapter } from './index.js';
import { SensitiveValue } from '@launchpad/shared';
import type { ProjectSpec, ProviderContext } from '@launchpad/provider-contract';

const ctx: ProviderContext = { correlationId: 'corr', applicationId: 'app', workflowId: 'wf', actor: { kind: 'system', id: 'test' }, dryRun: false };
const project: ProjectSpec = { id: 'app', name: 'app', teamId: null, framework: 'nextjs', rootDirectory: '.', nodeVersion: '24.x', build: { installCommand: 'yarn install', buildCommand: 'yarn build', outputDirectory: null }, repository: 'acme/app', productionBranch: 'main', settings: { autoAssignProductionDomains: false } };

const COMMIT = 'a'.repeat(40);

function deploymentsList(deployments: unknown[]): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.includes('/v7/deployments')) return new Response(JSON.stringify({ deployments }), { status: 200 });
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  };
}

it('locates the preview deployment for the exact commit only', async () => {
  const adapter = new VercelAdapter({ token: 'token', fetchImpl: deploymentsList([
    { uid: 'dpl_old', name: 'app', url: 'app-old.vercel.app', state: 'READY', target: null, meta: { gitCommitSha: 'b'.repeat(40) } },
    { uid: 'dpl_exact', name: 'app', url: 'app-exact.vercel.app', state: 'BUILDING', target: null, meta: { githubCommitSha: COMMIT } },
    { uid: 'dpl_prod', name: 'app', url: 'app-prod.vercel.app', state: 'READY', target: 'production', meta: { gitCommitSha: COMMIT } },
    { uid: 'dpl_branch', name: 'app', url: 'app-branch.vercel.app', state: 'READY', target: null, meta: { githubRef: 'refs/heads/main' } },
  ]) });
  const found = await adapter.findDeploymentByCommit('app', COMMIT, ctx);
  expect(found).toMatchObject({ id: 'dpl_exact', commitSha: COMMIT, environment: 'preview' });
  expect(found?.url).toBe('https://app-exact.vercel.app');
  await expect(adapter.findDeploymentByCommit('app', 'f'.repeat(40), ctx)).resolves.toBeNull();
});

it('skips exact-commit deployments whose declared repository mismatches', async () => {
  const adapter = new VercelAdapter({ token: 'token', fetchImpl: deploymentsList([
    { uid: 'dpl_other', name: 'app', url: 'app-other.vercel.app', state: 'READY', target: null, meta: { gitCommitSha: COMMIT, gitRepo: 'evil/app' } },
  ]) });
  await expect(adapter.findDeploymentByCommit('app', COMMIT, ctx, { expectedRepository: 'acme/app' })).resolves.toBeNull();
});

it('fails closed when the deployments list is malformed', async () => {
  const adapter = new VercelAdapter({ token: 'token', fetchImpl: async (input) => (String(input).includes('/v7/deployments') ? new Response(JSON.stringify({ deployments: 'nope' }), { status: 200 }) : new Response('{}', { status: 200 })) });
  await expect(adapter.findDeploymentByCommit('app', COMMIT, ctx)).rejects.toMatchObject({ code: 'LP-VERCEL-DEPLOYMENTS-MALFORMED' });
});

it('returns a bounded log excerpt with truncation and no dropped secrets', async () => {
  const events = Array.from({ length: 50 }, (_, index) => ({ type: 'stdout', payload: { text: `line ${index} value=${index}` } }));
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/v3/deployments/dpl_1/events')) return new Response(JSON.stringify({ events }), { status: 200 });
    return new Response('{}', { status: 200 });
  };
  const adapter = new VercelAdapter({ token: 'token', fetchImpl });
  const excerpt = await adapter.fetchDeploymentLogs({ deploymentId: 'dpl_1', maxLines: 10, maxBytes: 200 }, ctx);
  expect(excerpt.deploymentId).toBe('dpl_1');
  expect(excerpt.excerpt.length).toBeLessThanOrEqual(200);
  expect(excerpt.truncated).toBe(true);
  expect(excerpt.excerpt.split('\n').length).toBeLessThanOrEqual(10);
  expect(excerpt.excerpt).toContain('line 49');
});

it('fails closed when the events list is malformed', async () => {
  const adapter = new VercelAdapter({ token: 'token', fetchImpl: async (input) => (String(input).includes('/events') ? new Response(JSON.stringify({ events: {} }), { status: 200 }) : new Response('{}', { status: 200 })) });
  await expect(adapter.fetchDeploymentLogs({ deploymentId: 'dpl_1', maxLines: 10, maxBytes: 100 }, ctx)).rejects.toMatchObject({ code: 'LP-VERCEL-LOGS-MALFORMED' });
});

const DB_SECRET = 'postgres://adapter-db-secret';
const TOKEN_SECRET = 'adapter-token-secret';

interface EnvCall { method: string; url: string; body: unknown; }

/**
 * Stateful Vercel env simulation following the official shapes: the list
 * returns every stored variable, create returns { created: [...] }, and the
 * single-env GET/PATCH routes operate by id. `tamperWith` lets a test inject
 * a readback mismatch after a write.
 */
function envTransport(initial: Array<Record<string, unknown>> = [], tamperWith?: (envs: Array<Record<string, unknown>>) => void): { fetchImpl: typeof fetch; envs: Array<Record<string, unknown>>; calls: EnvCall[] } {
  const envs: Array<Record<string, unknown>> = initial.map((env, index) => ({ id: `env_${index + 1}`, ...env }));
  const calls: EnvCall[] = [];
  let nextId = envs.length + 1;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) as unknown : undefined;
    calls.push({ method, url, body });
    if (tamperWith) tamperWith(envs);
    if (method === 'GET' && /\/env$/.test(url)) return new Response(JSON.stringify({ envs }), { status: 200 });
    if (method === 'POST' && /\/env$/.test(url)) {
      const created = { id: `env_${nextId++}`, ...(body as Record<string, unknown>) };
      envs.push(created);
      return new Response(JSON.stringify({ created: [created], failed: [] }), { status: 200 });
    }
    const envId = /\/env\/([^/]+)$/.exec(url)?.[1];
    if (envId === undefined) return new Response('{}', { status: 404 });
    const index = envs.findIndex((env) => env.id === envId);
    if (index === -1) return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
    if (method === 'PATCH') {
      envs[index] = { ...envs[index], ...(body as Record<string, unknown>) };
    }
    return new Response(JSON.stringify(envs[index]), { status: 200 });
  };
  return { fetchImpl, envs, calls };
}

const productionEnv = (key: string, value: string, type = 'encrypted'): Record<string, unknown> => ({ key, value, type, target: ['production'], gitBranch: 'main' });

it('creates every declared variable through list/create/readback and never serializes values', async () => {
  const { fetchImpl, calls } = envTransport();
  const adapter = new VercelAdapter({ token: 'token', fetchImpl });
  const result = await adapter.ensureEnvironment({ projectId: 'app', environment: 'production', branch: 'main', variables: { DATABASE_URL: new SensitiveValue(DB_SECRET), API_TOKEN: new SensitiveValue(TOKEN_SECRET) } }, ctx);
  expect(result.changed).toBe(true);
  const writes = calls.filter((call) => call.method === 'POST');
  expect(writes).toHaveLength(2);
  expect(writes[0]!.body).toEqual({ key: 'DATABASE_URL', value: DB_SECRET, type: 'encrypted', target: ['production'], gitBranch: 'main' });
  expect(writes[1]!.body).toEqual({ key: 'API_TOKEN', value: TOKEN_SECRET, type: 'encrypted', target: ['production'], gitBranch: 'main' });
  expect(calls.filter((call) => call.method === 'GET' && /\/env\/env_\d+$/.test(call.url))).toHaveLength(2);
  // The raw values exist only inside the write request bodies.
  for (const call of calls) {
    const serialized = JSON.stringify(call.body ?? null);
    if (call.method === 'POST') {
      expect(serialized).toMatch(/DATABASE_URL|API_TOKEN/);
    } else {
      expect(serialized).not.toContain(DB_SECRET);
      expect(serialized).not.toContain(TOKEN_SECRET);
    }
  }
  expect(JSON.stringify(result)).not.toContain(DB_SECRET);
  expect(JSON.stringify(result)).not.toContain(TOKEN_SECRET);
});

it('updates a drifted variable in place with PATCH and a verified readback', async () => {
  const { fetchImpl, calls } = envTransport([productionEnv('DATABASE_URL', 'postgres://stale-value')]);
  const adapter = new VercelAdapter({ token: 'token', fetchImpl });
  const result = await adapter.ensureEnvironment({ projectId: 'app', environment: 'production', branch: 'main', variables: { DATABASE_URL: new SensitiveValue(DB_SECRET) } }, ctx);
  expect(result.changed).toBe(true);
  const patch = calls.find((call) => call.method === 'PATCH');
  expect(patch).toMatchObject({ url: 'https://api.vercel.com/v9/projects/app/env/env_1', body: { key: 'DATABASE_URL', value: DB_SECRET, type: 'encrypted', target: ['production'], gitBranch: 'main' } });
  expect(calls.filter((call) => call.method === 'GET' && /\/env\/env_1$/.test(call.url))).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain(DB_SECRET);
});

it('replays an already-converged environment as a no-op, then updates on drift', async () => {
  const { fetchImpl, calls, envs } = envTransport([productionEnv('DATABASE_URL', DB_SECRET)]);
  const adapter = new VercelAdapter({ token: 'token', fetchImpl });
  const first = await adapter.ensureEnvironment({ projectId: 'app', environment: 'production', branch: 'main', variables: { DATABASE_URL: new SensitiveValue(DB_SECRET) } }, ctx);
  expect(first.changed).toBe(false);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://api.vercel.com/v9/projects/app/env' });

  calls.length = 0;
  envs[0] = { ...envs[0]!, value: 'postgres://rotated-value' };
  const second = await adapter.ensureEnvironment({ projectId: 'app', environment: 'production', branch: 'main', variables: { DATABASE_URL: new SensitiveValue(DB_SECRET) } }, ctx);
  expect(second.changed).toBe(true);
  expect(calls.some((call) => call.method === 'PATCH')).toBe(true);
});

it('fails closed with a typed non-leaking postcondition error on readback mismatch', async () => {
  let tampered = false;
  const { fetchImpl } = envTransport([], (envs) => {
    if (!tampered && envs.length > 0) {
      envs[0] = { ...envs[0]!, value: 'provider-tampered-value' };
      tampered = true;
    }
  });
  const adapter = new VercelAdapter({ token: 'token', fetchImpl });
  await expect(adapter.ensureEnvironment({ projectId: 'app', environment: 'production', branch: 'main', variables: { DATABASE_URL: new SensitiveValue(DB_SECRET) } }, ctx)).rejects.toSatisfy((error: unknown) => {
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain(DB_SECRET);
    expect(serialized).not.toContain('provider-tampered-value');
    expect(error).toMatchObject({ code: 'LP-VERCEL-ENV-POSTCONDITION-FAILED', class: 'CONFLICT', retryable: false });
    return true;
  });
});

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

function dnsConfigAdapter(): VercelAdapter {
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).includes('/v6/domains/app.example.com/config')) {
      return new Response(JSON.stringify({ recommendedCNAME: [{ rank: 1, value: ['cname.vercel-dns.com'] }], recordId: 'rec_1' }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  return new VercelAdapter({ token: 'token', fetchImpl });
}

it('maps acknowledged proxied mode into proxied required DNS records with the acknowledgment', async () => {
  const records = await dnsConfigAdapter().requiredDnsRecords({ projectId: 'app', hostname: 'app.example.com', environment: 'production', mode: 'proxied', proxyAcknowledgment: true }, ctx);
  expect(records[0]).toMatchObject({ hostname: 'app.example.com', type: 'CNAME', value: 'cname.vercel-dns.com', ttl: 'auto', providerRecordId: 'rec_1', proxied: true, proxyAcknowledgment: true });
});

it('maps dns-only mode into an explicit proxied:false required DNS record without an acknowledgment', async () => {
  const [record] = await dnsConfigAdapter().requiredDnsRecords({ projectId: 'app', hostname: 'app.example.com', environment: 'production', mode: 'dns-only' }, ctx);
  expect(record).toMatchObject({ proxied: false });
  expect(record?.proxyAcknowledgment).toBeUndefined();
});

it('never maps unacknowledged proxied mode into a proxied required DNS record', async () => {
  // proxied:true is only derived from acknowledged proxied mode (PRD-DNS-005);
  // the apply pipeline blocks the unacknowledged write before it reaches a provider.
  const [record] = await dnsConfigAdapter().requiredDnsRecords({ projectId: 'app', hostname: 'app.example.com', environment: 'production', mode: 'proxied' }, ctx);
  expect(record).toMatchObject({ proxied: false });
  expect(record?.proxyAcknowledgment).toBeUndefined();
});
