import { expect, it } from 'vitest';
import { GitHubAdapter } from '@launchpad/provider-github';
import type { ProviderContext } from '@launchpad/provider-contract';
import { CONTRACT_CANARY_BODY, CONTRACT_CANARY_TOKEN, expectRequest, loadErrorScenarios, loadScenarios, recordedTransport, type RecordedRequest, type RecordedStep } from '../fixtures/recorded-transport.js';

const ctx: ProviderContext = { correlationId: 'contract-corr', applicationId: 'app', workflowId: 'wf', actor: { kind: 'system', id: 'contract' }, dryRun: false };
const COMMIT = 'a'.repeat(40);
const MAIN_SHA = 'f'.repeat(40);
const BASE = 'https://api.github.test';

function mount(steps: RecordedStep[]): { adapter: GitHubAdapter; requests: RecordedRequest[] } {
  const transport = recordedTransport(steps);
  return { adapter: new GitHubAdapter({ token: CONTRACT_CANARY_TOKEN, baseUrl: BASE, fetchImpl: transport.fetchImpl }), requests: transport.requests };
}

it('observes repository metadata against the official GitHub REST shape', async () => {
  const { adapter, requests } = mount(loadScenarios('github').observeRepository);
  const observation = await adapter.observeRepository('acme/app', ctx);
  expect(observation).toEqual({ provider: 'github', repository: 'acme/app', repositoryId: 42, archived: false, private: true, defaultBranch: 'main', access: true });
  const request = expectRequest(requests, 'GET', '/repos/acme/app');
  expect(request.headers.authorization).toBe(`Bearer ${CONTRACT_CANARY_TOKEN}`);
  expect(request.headers['x-github-api-version']).toBe('2022-11-28');
  expect(request.headers['x-launchpad-correlation-id']).toBe('contract-corr');
});

it('distinguishes file, directory, and missing paths on the contents endpoint', async () => {
  const file = mount(loadScenarios('github').hasPathFile);
  await expect(file.adapter.hasPath('acme/app', 'main', 'apps/web', ctx)).resolves.toBe('file');
  const directory = mount(loadScenarios('github').hasPathDirectory);
  await expect(directory.adapter.hasPath('acme/app', 'main', 'apps/web', ctx)).resolves.toBe('directory');
  const missing = mount(loadScenarios('github').hasPathMissing);
  await expect(missing.adapter.hasPath('acme/app', 'main', 'apps/web', ctx)).resolves.toBe('missing');
  expectRequest(file.requests, 'GET', '/repos/acme/app/contents/apps%2Fweb?ref=main');
});

it('reads files as decoded text and fails closed on missing base64 content', async () => {
  const { adapter, requests } = mount(loadScenarios('github').readFile);
  await expect(adapter.readFile('acme/app', 'main', 'apps/web/app.yaml', ctx)).resolves.toBe('apiVersion: launchpad.dev/v1\nkind: Application\n');
  expectRequest(requests, 'GET', '/repos/acme/app/contents/apps%2Fweb%2Fapp.yaml?ref=main');
  const malformed = mount(loadScenarios('github').readFileMalformed);
  await expect(malformed.adapter.readFile('acme/app', 'main', 'apps/web/app.yaml', ctx)).rejects.toMatchObject({ code: 'LP-GITHUB-FILE-CONTENT-MISSING', class: 'MALFORMED_PROVIDER_RESPONSE', retryable: false });
});

it('resolves refs to their exact commit sha and fails closed on malformed ref bodies', async () => {
  const { adapter, requests } = mount(loadScenarios('github').resolveRef);
  await expect(adapter.resolveRef('acme/app', 'main', ctx)).resolves.toEqual({ sha: COMMIT });
  expectRequest(requests, 'GET', '/repos/acme/app/git/ref/heads/main');
  const malformed = mount(loadScenarios('github').resolveRefMalformed);
  await expect(malformed.adapter.resolveRef('acme/app', 'main', ctx)).rejects.toMatchObject({ code: 'LP-GITHUB-REF-MALFORMED', class: 'MALFORMED_PROVIDER_RESPONSE', retryable: false });
});

it('creates a PR comment when none carries the marker and updates the existing one otherwise', async () => {
  const create = mount(loadScenarios('github').prCommentCreate);
  const created = await create.adapter.upsertPullRequestComment({ repository: 'acme/app', pullRequestNumber: 12, marker: '<!-- launchpad -->', body: 'new body' }, ctx);
  expect(created).toEqual({ id: 100, url: 'https://github.com/acme/app/pull/12#issuecomment-100' });
  expectRequest(create.requests, 'GET', '/repos/acme/app/issues/12/comments?per_page=100');
  const createdBody = expectRequest(create.requests, 'POST', '/repos/acme/app/issues/12/comments');
  expect(createdBody.body).toEqual({ body: 'new body' });

  const update = mount(loadScenarios('github').prCommentUpdate);
  const updated = await update.adapter.upsertPullRequestComment({ repository: 'acme/app', pullRequestNumber: 12, marker: 'launchpad:summary', body: 'fresh summary' }, ctx);
  expect(updated.id).toBe(55);
  const patch = expectRequest(update.requests, 'PATCH', '/repos/acme/app/issues/comments/55');
  expect(patch.body).toEqual({ body: 'fresh summary' });
});

it('creates a branch, writes files, and opens a PR with the official REST bodies', async () => {
  const { adapter, requests } = mount(loadScenarios('github').createOrUpdatePr);
  const result = await adapter.createOrUpdatePullRequest({ repository: 'acme/control', branch: 'reconcile/app/1', title: 'Reconcile app', body: 'automated reconciliation', files: { 'catalog/apps/app.yaml': 'hello' }, baseSha: MAIN_SHA }, ctx);
  expect(result).toEqual({ number: 12, url: 'https://github.com/acme/control/pull/12' });
  const branch = expectRequest(requests, 'POST', '/repos/acme/control/git/refs');
  expect(branch.body).toEqual({ ref: 'refs/heads/reconcile/app/1', sha: MAIN_SHA });
  const file = expectRequest(requests, 'PUT', '/repos/acme/control/contents/catalog%2Fapps%2Fapp.yaml');
  expect(file.body).toEqual({ message: 'chore: reconcile catalog/apps/app.yaml', content: 'aGVsbG8=', branch: 'reconcile/app/1' });
  const pr = expectRequest(requests, 'POST', '/repos/acme/control/pulls');
  expect(pr.body).toEqual({ title: 'Reconcile app', body: 'automated reconciliation', head: 'reconcile/app/1', base: 'main' });
});

it('reuses an open PR for the same head branch instead of creating a second', async () => {
  const { adapter, requests } = mount(loadScenarios('github').reuseOpenPr);
  const result = await adapter.createOrUpdatePullRequest({ repository: 'acme/control', branch: 'reconcile/app/1', title: 'Reconcile app', body: 'updated', files: { 'catalog/apps/app.yaml': 'hello' }, baseSha: MAIN_SHA }, ctx);
  expect(result.number).toBe(12);
  const patch = expectRequest(requests, 'PATCH', '/repos/acme/control/pulls/12');
  expect(patch.body).toEqual({ title: 'Reconcile app', body: 'updated' });
  expect(requests.some((request) => request.method === 'POST' && request.path === '/repos/acme/control/pulls')).toBe(false);
});

it('creates a transient deployment for the exact commit and posts a status', async () => {
  const { adapter, requests } = mount(loadScenarios('github').deploymentStatusCreate);
  const result = await adapter.createDeploymentStatus({ repository: 'acme/app', commitSha: COMMIT, environment: 'preview', state: 'success', description: 'gate passed', targetUrl: 'https://app-1.vercel.app', logUrl: null, idempotencyKey: 'idem-1' }, ctx);
  expect(result).toEqual({ deploymentId: 11, statusId: 22, deploymentUrl: 'https://api.github.com/repos/acme/app/deployments/11', statusUrl: 'https://api.github.com/repos/acme/app/deployments/11/statuses/22' });
  const deployment = expectRequest(requests, 'POST', '/repos/acme/app/deployments');
  expect(deployment.body).toEqual({ ref: COMMIT, environment: 'preview', description: 'gate passed', transient_environment: true, auto_merge: false, required_contexts: [] });
  expect(deployment.headers['idempotency-key']).toBe('idem-1');
  const status = expectRequest(requests, 'POST', '/repos/acme/app/deployments/11/statuses');
  expect(status.body).toEqual({ state: 'success', description: 'gate passed', target_url: 'https://app-1.vercel.app' });
});

it('reuses the existing deployment for the same commit and environment', async () => {
  const { adapter, requests } = mount(loadScenarios('github').deploymentStatusReuse);
  const result = await adapter.createDeploymentStatus({ repository: 'acme/app', commitSha: COMMIT, environment: 'preview', state: 'failure', description: 'health failed' }, ctx);
  expect(result.deploymentId).toBe(33);
  expect(requests.some((request) => request.method === 'POST' && request.path === '/repos/acme/app/deployments')).toBe(false);
  expectRequest(requests, 'POST', '/repos/acme/app/deployments/33/statuses');
});

it('fails closed when a partial deployment response lacks an id', async () => {
  const { adapter } = mount(loadScenarios('github').deploymentStatusMalformed);
  await expect(adapter.createDeploymentStatus({ repository: 'acme/app', commitSha: COMMIT, environment: 'preview', state: 'error', description: 'build failed' }, ctx)).rejects.toMatchObject({ code: 'LP-GITHUB-DEPLOYMENT-MALFORMED', class: 'MALFORMED_PROVIDER_RESPONSE', retryable: false });
});

it('keeps provider error bodies and tokens out of typed errors', async () => {
  const { adapter } = mount(loadScenarios('github').errorCanary);
  await expect(adapter.observeRepository('acme/app', ctx)).rejects.toSatisfy((error: unknown) => {
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain(CONTRACT_CANARY_BODY);
    expect(serialized).not.toContain(CONTRACT_CANARY_TOKEN);
    expect((error as Error).message).not.toContain(CONTRACT_CANARY_BODY);
    expect(error).toMatchObject({ code: 'LP-GITHUB-HTTP-403', class: 'AUTHORIZATION', retryable: false });
    return true;
  });
});

it('maps the recorded rate-limit fixture to typed retry metadata', async () => {
  const errors = loadErrorScenarios();
  const { adapter } = mount([{ request: { method: 'GET', path: '/repos/acme/app' }, response: { status: errors.rateLimited[0]!.response.status, body: errors.rateLimited[0]!.response.body } }]);
  await expect(adapter.observeRepository('acme/app', ctx)).rejects.toMatchObject({ code: 'LP-GITHUB-HTTP-429', class: 'RATE_LIMITED', retryable: true, status: 429 });
});
