import { GitHubAdapter } from '@launchpad/provider-github';
import { VercelAdapter } from '@launchpad/provider-vercel';
import { CloudflareAdapter } from '@launchpad/provider-cloudflare';
import type { ProviderContext } from '@launchpad/provider-contract';
import { runProviderContractMatrix, type ProviderMatrixHarness } from './provider-matrix.js';

const ctx: ProviderContext = { correlationId: 'matrix-corr', applicationId: 'app', workflowId: 'wf', actor: { kind: 'system', id: 'matrix' }, dryRun: false };
const COMMIT = 'a'.repeat(40);
const TOKEN = 'lp-contract-canary-token-7f3c9d1e';

const github: ProviderMatrixHarness = {
  name: 'github',
  provider: 'github',
  codePrefix: 'LP-GITHUB',
  token: TOKEN,
  create: ({ fetchImpl, token, timeoutMs }) => new GitHubAdapter({ token: token ?? undefined, baseUrl: 'https://api.github.test', fetchImpl, timeoutMs }),
  strictRead: (adapter) => (adapter as GitHubAdapter).observeRepository('acme/app', ctx),
  strictReadError: (response) => [{ request: { method: 'GET', path: '/repos/acme/app' }, response }],
  finderRead: (adapter) => (adapter as GitHubAdapter).hasPath('acme/app', 'main', 'apps/web', ctx),
  finderAbsentResult: 'missing',
  finderAbsent: () => [{ request: { method: 'GET', path: '/repos/acme/app/contents/apps%2Fweb?ref=main' }, response: { status: 404, body: { message: 'Not Found' } } }],
  write: (adapter) => (adapter as GitHubAdapter).createDeploymentStatus({ repository: 'acme/app', commitSha: COMMIT, environment: 'preview', state: 'success', description: 'matrix', idempotencyKey: 'matrix-idem' }, ctx),
  writeError: (response) => [
    { request: { method: 'GET', path: `/repos/acme/app/deployments?ref=${COMMIT}&environment=preview` }, response: { status: 200, body: [] } },
    { request: { method: 'POST', path: '/repos/acme/app/deployments' }, response },
  ],
  writeOk: () => [
    { request: { method: 'GET', path: `/repos/acme/app/deployments?ref=${COMMIT}&environment=preview` }, response: { status: 200, body: [] } },
    { request: { method: 'POST', path: '/repos/acme/app/deployments' }, response: { status: 201, body: { id: 11, url: 'https://api.github.com/repos/acme/app/deployments/11' } } },
    { request: { method: 'POST', path: '/repos/acme/app/deployments/11/statuses' }, response: { status: 201, body: { id: 22, url: 'https://api.github.com/repos/acme/app/deployments/11/statuses/22' } } },
  ],
  writeIdempotencyKey: (requests) => requests.find((request) => request.method === 'POST' && request.path.endsWith('/deployments'))?.headers['idempotency-key'] ?? null,
  timeoutFetch: () => ({ fetchImpl: abortingFetch }),
};

const vercel: ProviderMatrixHarness = {
  name: 'vercel',
  provider: 'vercel',
  codePrefix: 'LP-VERCEL',
  token: TOKEN,
  create: ({ fetchImpl, token, timeoutMs }) => new VercelAdapter({ token: token ?? undefined, baseUrl: 'https://api.vercel.test', fetchImpl, timeoutMs }),
  strictRead: (adapter) => (adapter as VercelAdapter).waitForDeployment({ projectId: 'app', deploymentId: 'dpl_1', timeoutMs: 50, pollMs: 10 }, ctx),
  strictReadError: (response) => [{ request: { method: 'GET', path: '/v13/deployments/dpl_1' }, response }],
  finderRead: (adapter) => (adapter as VercelAdapter).observeProject({ projectId: 'app' }, ctx),
  finderAbsentResult: null,
  finderAbsent: () => [{ request: { method: 'GET', path: '/v9/projects/app' }, response: { status: 404, body: { error: { code: 'not_found' } } } }],
  write: (adapter) => (adapter as VercelAdapter).createDeployment({ projectId: 'app', environment: 'preview', repository: 'acme/app', commitSha: COMMIT, desiredGeneration: 1, staged: false }, ctx),
  writeError: (response) => [{ request: { method: 'POST', path: '/v13/deployments' }, response }],
  writeOk: () => [{ request: { method: 'POST', path: '/v13/deployments' }, response: { status: 200, body: { id: 'dpl_1', url: 'app-1.vercel.app', readyState: 'QUEUED' } } }],
  writeIdempotencyKey: (requests) => requests.find((request) => request.method === 'POST' && request.path === '/v13/deployments')?.headers['idempotency-key'] ?? null,
  timeoutFetch: () => ({ fetchImpl: abortingFetch }),
};

const cloudflare: ProviderMatrixHarness = {
  name: 'cloudflare',
  provider: 'cloudflare',
  codePrefix: 'LP-CLOUDFLARE',
  token: TOKEN,
  create: ({ fetchImpl, token, timeoutMs }) => new CloudflareAdapter({ token: token ?? undefined, baseUrl: 'https://api.cloudflare.test', fetchImpl, timeoutMs }),
  strictRead: (adapter) => (adapter as CloudflareAdapter).observeZone('config://cloudflare/example.com', ctx),
  strictReadError: (response) => [{ request: { method: 'GET', path: '/zones?name=example.com&status=active' }, response }],
  finderRead: (adapter) => (adapter as CloudflareAdapter).observeRecord('zone-1', 'app.example.com', ctx),
  finderAbsentResult: null,
  finderAbsent: () => [{ request: { method: 'GET', path: '/zones/zone-1/dns_records?name=app.example.com' }, response: { status: 200, body: { success: true, result: [], errors: [], messages: [] } } }],
  write: (adapter) => (adapter as CloudflareAdapter).ensureRecord('zone-1', { hostname: 'app.example.com', type: 'CNAME', value: 'target.example', ttl: 'auto' }, 'matrix-fp', ctx),
  writeError: (response) => [
    { request: { method: 'GET', path: '/zones/zone-1/dns_records?name=app.example.com&type=CNAME' }, response: { status: 200, body: { success: true, result: [], errors: [], messages: [] } } },
    { request: { method: 'POST', path: '/zones/zone-1/dns_records' }, response },
  ],
  writeOk: () => [
    { request: { method: 'GET', path: '/zones/zone-1/dns_records?name=app.example.com&type=CNAME' }, response: { status: 200, body: { success: true, result: [], errors: [], messages: [] } } },
    { request: { method: 'POST', path: '/zones/zone-1/dns_records' }, response: { status: 200, body: { success: true, result: { id: 'record-1', name: 'app.example.com', type: 'CNAME', content: 'target.example', ttl: 1, proxied: false, comment: 'launchpad:matrix-fp' }, errors: [], messages: [] } } },
    { request: { method: 'GET', path: '/zones/zone-1/dns_records?name=app.example.com&type=CNAME' }, response: { status: 200, body: { success: true, result: [{ id: 'record-1', name: 'app.example.com', type: 'CNAME', content: 'target.example', ttl: 1, proxied: false, comment: 'launchpad:matrix-fp' }], errors: [], messages: [] } } },
  ],
  writeIdempotencyKey: (requests) => requests.find((request) => request.method === 'POST' && request.path.endsWith('/dns_records'))?.headers['idempotency-key'] ?? null,
  timeoutFetch: () => ({ fetchImpl: abortingFetch }),
};

/** Fetch that never resolves until the client aborts the request signal — the real timeout path. */
function abortingFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal as AbortSignal | undefined;
    const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

runProviderContractMatrix(github);
runProviderContractMatrix(vercel);
runProviderContractMatrix(cloudflare);
