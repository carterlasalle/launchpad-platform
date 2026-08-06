import { expect, it } from 'vitest';
import { retry } from '@launchpad/shared';
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

const COMMIT = 'c'.repeat(40);

it('creates a transient deployment for the exact commit and posts a status', async () => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET', body: init?.body !== undefined ? JSON.parse(String(init.body)) : null });
    if (url.includes('/deployments?ref=')) return new Response('[]', { status: 200 });
    if (url.endsWith('/deployments')) return new Response(JSON.stringify({ id: 11, url: 'https://api.github.com/repos/acme/app/deployments/11' }), { status: 201 });
    if (url.includes('/deployments/11/statuses')) return new Response(JSON.stringify({ id: 22, url: 'https://api.github.com/repos/acme/app/deployments/11/statuses/22' }), { status: 201 });
    return new Response('{}', { status: 200 });
  };
  const adapter = new GitHubAdapter({ token: 'token', fetchImpl });
  const result = await adapter.createDeploymentStatus({ repository: 'acme/app', commitSha: COMMIT, environment: 'preview', state: 'success', description: 'gate passed', targetUrl: 'https://app-1.vercel.app', logUrl: null, idempotencyKey: 'key-1' }, ctx);
  expect(result).toEqual({ deploymentId: 11, statusId: 22, deploymentUrl: 'https://api.github.com/repos/acme/app/deployments/11', statusUrl: 'https://api.github.com/repos/acme/app/deployments/11/statuses/22' });
  const created = requests.find((request) => request.method === 'POST' && request.url.endsWith('/deployments'));
  expect(created?.body).toMatchObject({ ref: COMMIT, environment: 'preview', description: 'gate passed', transient_environment: true, auto_merge: false, required_contexts: [] });
  const status = requests.find((request) => request.method === 'POST' && request.url.includes('/statuses'));
  expect(status?.body).toEqual({ state: 'success', description: 'gate passed', target_url: 'https://app-1.vercel.app' });
});

it('reuses the existing deployment for the same commit and environment', async () => {
  let createCalls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/deployments?ref=')) return new Response(JSON.stringify([{ id: 33, environment: 'preview', ref: COMMIT }]), { status: 200 });
    if (url.endsWith('/deployments') && init?.method === 'POST') {
      createCalls += 1;
      return new Response(JSON.stringify({ id: 99 }), { status: 201 });
    }
    if (url.includes('/deployments/33/statuses')) return new Response(JSON.stringify({ id: 44, url: 'https://api.github.com/statuses/44' }), { status: 201 });
    return new Response('{}', { status: 200 });
  };
  const adapter = new GitHubAdapter({ token: 'token', fetchImpl });
  const result = await adapter.createDeploymentStatus({ repository: 'acme/app', commitSha: COMMIT, environment: 'preview', state: 'failure', description: 'health failed' }, ctx);
  expect(result.deploymentId).toBe(33);
  expect(result.statusId).toBe(44);
  expect(createCalls).toBe(0);
});

it('bounds oversized sticky comment bodies at 60,000 chars preserving marker and redaction', async () => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET', body: init?.body !== undefined ? JSON.parse(String(init.body)) : null });
    if (init?.method === 'GET' || init?.method === undefined) return new Response(JSON.stringify([]), { status: 200 });
    if (url.endsWith('/issues/12/comments')) return new Response(JSON.stringify({ id: 100, html_url: 'https://github.com/acme/app/pull/12#issuecomment-100' }), { status: 201 });
    return new Response('{}', { status: 200 });
  };
  const adapter = new GitHubAdapter({ token: 'token', fetchImpl });
  const oversized = `<!-- launchpad:plan -->\ntoken=canary-secret\n${'a'.repeat(80_000)}`;
  const result = await adapter.upsertPullRequestComment({ repository: 'acme/app', pullRequestNumber: 12, marker: '<!-- launchpad:plan -->', body: oversized }, ctx);
  expect(result.id).toBe(100);
  const created = requests.find((request) => request.method === 'POST' && request.url.endsWith('/issues/12/comments'));
  const posted = created?.body as { body: string };
  expect(posted.body.length).toBeLessThanOrEqual(60_000);
  expect(posted.body.startsWith('<!-- launchpad:plan -->')).toBe(true);
  expect(posted.body).toContain('…[truncated]');
  expect(posted.body).toContain('token=[REDACTED]');
  expect(posted.body).not.toContain('canary-secret');
});

it('fails closed on a malformed deployment response', async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/deployments?ref=')) return new Response('[]', { status: 200 });
    if (url.endsWith('/deployments') && init?.method === 'POST') return new Response(JSON.stringify({ url: 'https://api.github.com/deployments/1' }), { status: 201 });
    return new Response('{}', { status: 200 });
  };
  const adapter = new GitHubAdapter({ token: 'token', fetchImpl });
  await expect(adapter.createDeploymentStatus({ repository: 'acme/app', commitSha: COMMIT, environment: 'preview', state: 'error', description: 'build failed' }, ctx)).rejects.toMatchObject({ code: 'LP-GITHUB-DEPLOYMENT-MALFORMED' });
});

it('resolves a ref to its commit sha and bases branches on the caller-provided protected main sha', async () => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET', body: init?.body !== undefined ? JSON.parse(String(init.body)) : null });
    if (url.endsWith('/repos/acme/control')) return new Response(JSON.stringify({ id: 7, archived: false, private: true, default_branch: 'main' }), { status: 200 });
    if (url.includes('/git/ref/heads/main')) return new Response(JSON.stringify({ object: { sha: 'f'.repeat(40) } }), { status: 200 });
    if (url.includes('/git/refs') && init?.method === 'POST') return new Response(JSON.stringify({ ref: 'refs/heads/reconcile/app/1', object: { sha: 'f'.repeat(40) } }), { status: 201 });
    if (url.includes('/contents/') && init?.method === 'PUT') return new Response(JSON.stringify({ content: {} }), { status: 200 });
    if (url.includes('/contents/') && init?.method !== 'PUT') return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    if (url.includes('/pulls?state=open')) return new Response('[]', { status: 200 });
    if (url.endsWith('/pulls') && init?.method === 'POST') return new Response(JSON.stringify({ number: 12, html_url: 'https://github.com/acme/control/pull/12' }), { status: 201 });
    return new Response('{}', { status: 200 });
  };
  const adapter = new GitHubAdapter({ token: 'token', fetchImpl });
  const ref = await adapter.resolveRef('acme/control', 'main', ctx);
  expect(ref.sha).toBe('f'.repeat(40));
  const pr = await adapter.createOrUpdatePullRequest({ repository: 'acme/control', branch: 'reconcile/app/1', title: 't', body: 'b', files: { 'catalog/apps/app.yaml': 'x' }, baseSha: ref.sha }, ctx);
  expect(pr.number).toBe(12);
  const branchCreate = requests.find((request) => request.method === 'POST' && request.url.includes('/git/refs'));
  expect(branchCreate?.body).toEqual({ ref: 'refs/heads/reconcile/app/1', sha: 'f'.repeat(40) });
});

const CANARY_TOKEN = 'github-token-canary-9f3a';
const CANARY_BODY = 'provider-echoed-canary-7f1d';

it('reports archived repositories through observation and fails closed on writes to them', async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/repos/acme/app')) return new Response(JSON.stringify({ id: 42, archived: true, private: true, default_branch: 'main' }), { status: 200 });
    if (init?.method === 'GET' || init?.method === undefined) return new Response(JSON.stringify([]), { status: 200 });
    if (url.includes('/comments')) return new Response(JSON.stringify({ message: CANARY_BODY }), { status: 403 });
    return new Response('{}', { status: 200 });
  };
  const adapter = new GitHubAdapter({ token: 'token', fetchImpl });
  const observed = await adapter.observeRepository('acme/app', ctx);
  expect(observed).toMatchObject({ archived: true, access: true });
  await expect(adapter.upsertPullRequestComment({ repository: 'acme/app', pullRequestNumber: 1, marker: '<!-- launchpad:plan -->', body: 'plan' }, ctx)).rejects.toMatchObject({ code: 'LP-GITHUB-HTTP-403', class: 'AUTHORIZATION', retryable: false, status: 403 });
});

it('denies private/no-access reads with an authorization error and never leaks the body', async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ message: CANARY_BODY }), { status: 403 });
  const adapter = new GitHubAdapter({ token: CANARY_TOKEN, fetchImpl });
  await expect(adapter.observeRepository('private/org', ctx)).rejects.toSatisfy((error: unknown) => {
    const typed = error as { code: string; class: string; retryable: boolean; status: number | null; safeDetails: Record<string, unknown> };
    expect(typed.code).toBe('LP-GITHUB-HTTP-403');
    expect(typed.class).toBe('AUTHORIZATION');
    expect(typed.retryable).toBe(false);
    expect(typed.status).toBe(403);
    expect(JSON.stringify(error)).not.toContain(CANARY_TOKEN);
    expect(JSON.stringify(error)).not.toContain(CANARY_BODY);
    expect('body' in typed.safeDetails).toBe(false);
    return true;
  });
});

it('propagates 404 on strict reads but maps it to missing on finder reads', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/contents/') || url.includes('/git/ref/heads/')) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    return new Response('{}', { status: 200 });
  };
  const adapter = new GitHubAdapter({ token: 'token', fetchImpl });
  await expect(adapter.readFile('acme/app', 'main', 'missing.yaml', ctx)).rejects.toMatchObject({ code: 'LP-GITHUB-HTTP-404', class: 'NOT_FOUND', retryable: false, status: 404 });
  await expect(adapter.resolveRef('acme/app', 'no-such-branch', ctx)).rejects.toMatchObject({ code: 'LP-GITHUB-HTTP-404', class: 'NOT_FOUND', retryable: false, status: 404 });
  await expect(adapter.hasPath('acme/app', 'main', 'missing.yaml', ctx)).resolves.toBe('missing');
});

it('classifies 401 as authentication and 403 as authorization on strict reads', async () => {
  const adapter401 = new GitHubAdapter({ token: 'token', fetchImpl: async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }) });
  await expect(adapter401.observeRepository('acme/app', ctx)).rejects.toMatchObject({ code: 'LP-GITHUB-HTTP-401', class: 'AUTHENTICATION', retryable: false, status: 401 });
  const adapter403 = new GitHubAdapter({ token: 'token', fetchImpl: async () => new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 }) });
  await expect(adapter403.observeRepository('acme/app', ctx)).rejects.toMatchObject({ code: 'LP-GITHUB-HTTP-403', class: 'AUTHORIZATION', retryable: false, status: 403 });
});

it('classifies rate limits with retry metadata and safe details (429)', async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 429 });
  const adapter = new GitHubAdapter({ token: 'token', fetchImpl });
  await expect(adapter.observeRepository('acme/app', ctx)).rejects.toMatchObject({ code: 'LP-GITHUB-HTTP-429', class: 'RATE_LIMITED', retryable: true, status: 429, safeDetails: { status: 429 } });
});

it('classifies transient 5xx responses as retryable', async () => {
  for (const status of [500, 503]) {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ message: 'unavailable' }), { status });
    const adapter = new GitHubAdapter({ token: 'token', fetchImpl });
    await expect(adapter.observeRepository('acme/app', ctx)).rejects.toMatchObject({ code: `LP-GITHUB-HTTP-${status}`, class: 'TRANSIENT_PROVIDER', retryable: true, status });
  }
});

it('classifies request timeouts as retryable TIMEOUT', async () => {
  const fetchImpl: typeof fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
  });
  const adapter = new GitHubAdapter({ token: 'token', fetchImpl, timeoutMs: 20 });
  await expect(adapter.observeRepository('acme/app', ctx)).rejects.toMatchObject({ code: 'LP-GITHUB-TIMEOUT', class: 'TIMEOUT', retryable: true });
});

it('fails closed on a malformed JSON envelope even with a 200 status', async () => {
  const fetchImpl: typeof fetch = async () => new Response('<html>not json</html>', { status: 200 });
  const adapter = new GitHubAdapter({ token: 'token', fetchImpl });
  await expect(adapter.observeRepository('acme/app', ctx)).rejects.toMatchObject({ code: 'LP-GITHUB-MALFORMED-RESPONSE', class: 'MALFORMED_PROVIDER_RESPONSE', retryable: false });
});

it('recovers a transient failure on retry with the same idempotency key', async () => {
  const requests: Array<{ url: string; method: string; idempotencyKey: string | null; authorization: string | null }> = [];
  let deploymentsPosted = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, method: init?.method ?? 'GET', idempotencyKey: headers.get('idempotency-key'), authorization: headers.get('authorization') });
    if (url.includes('/deployments?ref=')) return new Response('[]', { status: 200 });
    if (url.endsWith('/deployments') && init?.method === 'POST') {
      deploymentsPosted += 1;
      if (deploymentsPosted === 1) return new Response(JSON.stringify({ message: 'unavailable' }), { status: 503 });
      return new Response(JSON.stringify({ id: 11, url: 'https://api.github.com/repos/acme/app/deployments/11' }), { status: 201 });
    }
    if (url.includes('/deployments/11/statuses')) return new Response(JSON.stringify({ id: 22, url: 'https://api.github.com/statuses/22' }), { status: 201 });
    return new Response('{}', { status: 200 });
  };
  const adapter = new GitHubAdapter({ token: 'token', fetchImpl });
  const result = await retry(() => adapter.createDeploymentStatus({ repository: 'acme/app', commitSha: COMMIT, environment: 'preview', state: 'success', description: 'gate passed', idempotencyKey: 'deploy-key-1' }, ctx), { maxAttempts: 2, baseDelayMs: 0, sleep: async () => undefined });
  expect(result.deploymentId).toBe(11);
  const posted = requests.filter((request) => request.method === 'POST' && request.url.endsWith('/deployments'));
  expect(posted).toHaveLength(2);
  expect(posted[0]?.idempotencyKey).toBe('deploy-key-1');
  expect(posted[1]?.idempotencyKey).toBe('deploy-key-1');
  expect(requests.every((request) => request.authorization === 'Bearer token')).toBe(true);
});

it('never leaks the bearer token or raw provider bodies into typed errors', async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ message: CANARY_BODY }), { status: 403 });
  const adapter = new GitHubAdapter({ token: CANARY_TOKEN, fetchImpl });
  await expect(adapter.upsertPullRequestComment({ repository: 'acme/app', pullRequestNumber: 1, marker: '<!-- launchpad:plan -->', body: 'plan' }, ctx)).rejects.toSatisfy((error: unknown) => {
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain(CANARY_TOKEN);
    expect(serialized).not.toContain(CANARY_BODY);
    const typed = error as { message: string; safeDetails: Record<string, unknown> };
    expect(typed.message).not.toContain(CANARY_BODY);
    expect('body' in typed.safeDetails).toBe(false);
    return true;
  });
});
