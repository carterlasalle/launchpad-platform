import { expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import type * as OidcModule from './auth/oidc.js';
import type { ControllerEnv } from './env.js';

vi.mock('./auth/oidc.js', async (importOriginal) => {
  const actual = await importOriginal<typeof OidcModule>();
  return { ...actual, verifyGithubOidc: vi.fn() };
});

import { createControllerApp } from './api.js';
import { verifyGithubOidc } from './auth/oidc.js';
import type { GithubOidcClaims } from './auth/oidc.js';

const COMMIT = 'a'.repeat(40);
const claims: GithubOidcClaims = { repository: 'acme/app', repository_id: '123', repository_owner_id: '456', workflow_ref: 'CarterLaSalle/launchpad/.github/workflows/reusable-app-preview.yml@refs/tags/v1', event_name: 'pull_request', pull_request_number: '7', ref: 'refs/pull/7/merge', sha: 'b'.repeat(40), actor: 'acme-app-ci' };

function validBody(): Record<string, unknown> {
  return { version: 1, applicationId: 'app', sourceCommit: COMMIT, repository: 'acme/app', repositoryId: 123, repositoryOwnerId: 456, workflowRef: 'acme/app/.github/workflows/launchpad-preview.yml@refs/heads/main', event: 'pull_request', pullRequestNumber: 7, ref: 'refs/pull/7/merge' };
}

async function post<E extends ControllerEnv>(app: Hono<E>, body: unknown, token: string | null = 'jwt'): Promise<Response> {
  return app.request('/v1/applications/app/preview/status', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
}

it('rejects the route without a valid OIDC bearer token', async () => {
  vi.mocked(verifyGithubOidc).mockRejectedValueOnce(new Error('OIDC bearer token is required.'));
  const app = createControllerApp({ operatorToken: 'operator', oidc: { issuer: 'https://token.actions.githubusercontent.com', audience: 'launchpad', jwks: 'https://token.actions.githubusercontent.com/.well-known/jwks' } });
  const response = await post(app, validBody(), null);
  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toEqual({ error: { code: 'LP-OIDC-INVALID', message: 'OIDC bearer token is required.', retryable: false, correlationId: expect.any(String) } });
});

it('rejects claim mismatches with a stable scope-separation error', async () => {
  vi.mocked(verifyGithubOidc).mockResolvedValueOnce(claims);
  const app = createControllerApp({ operatorToken: 'operator', oidc: { issuer: 'https://token.actions.githubusercontent.com', audience: 'launchpad', jwks: 'https://token.actions.githubusercontent.com/.well-known/jwks' } });
  const body = { ...validBody(), repository: 'evil/app' };
  const response = await post(app, body);
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toEqual({ error: { code: 'LP-OIDC-CLAIM-REPOSITORY-MISMATCH', message: expect.stringContaining('repository'), retryable: false, correlationId: expect.any(String) } });
});

it('rejects malformed payloads before any provider work', async () => {
  vi.mocked(verifyGithubOidc).mockResolvedValueOnce(claims);
  const app = createControllerApp({ operatorToken: 'operator', oidc: { issuer: 'https://token.actions.githubusercontent.com', audience: 'launchpad', jwks: 'https://token.actions.githubusercontent.com/.well-known/jwks' } });
  const missingCommit = await post(app, { ...validBody(), sourceCommit: 'not-a-sha' });
  expect(missingCommit.status).toBe(400);
  await expect(missingCommit.json()).resolves.toMatchObject({ error: { code: 'LP-PAYLOAD-COMMIT-INVALID' } });
  const wrongApplication = await post(app, { ...validBody(), applicationId: 'other' });
  expect(wrongApplication.status).toBe(400);
  await expect(wrongApplication.json()).resolves.toMatchObject({ error: { code: 'LP-PAYLOAD-APPLICATION-ID-MISMATCH' } });
  const wrongVersion = await post(app, { ...validBody(), version: 2 });
  expect(wrongVersion.status).toBe(400);
  await expect(wrongVersion.json()).resolves.toMatchObject({ error: { code: 'LP-PAYLOAD-VERSION-UNSUPPORTED' } });
});

it('executes the injected handler with OIDC-bound payload and returns evidence', async () => {
  vi.mocked(verifyGithubOidc).mockResolvedValueOnce(claims);
  const evidence = { status: 'SUCCEEDED', gateState: 'PASSED', operationId: 'op-1', applicationId: 'app', sourceCommit: COMMIT, deployment: { id: 'dpl_1' }, buildState: 'READY', healthState: 'PASSED', commentBody: '<!-- launchpad:app-preview -->', deploymentStatus: { state: 'success' } };
  const handler = vi.fn(async (payload: Record<string, unknown>) => evidence);
  const app = createControllerApp({ operatorToken: 'operator', oidc: { issuer: 'https://token.actions.githubusercontent.com', audience: 'launchpad', jwks: 'https://token.actions.githubusercontent.com/.well-known/jwks' }, workflowHandlers: { 'app-preview-status': handler } });
  const response = await post(app, validBody());
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual(evidence);
  expect(handler).toHaveBeenCalledWith(expect.objectContaining({ applicationId: 'app', sourceCommit: COMMIT, repository: 'acme/app', pullRequestNumber: 7, correlationId: expect.any(String) }));
});

it('maps handler failures to stable error envelopes without provider bodies', async () => {
  vi.mocked(verifyGithubOidc).mockResolvedValueOnce(claims);
  const app = createControllerApp({ operatorToken: 'operator', oidc: { issuer: 'https://token.actions.githubusercontent.com', audience: 'launchpad', jwks: 'https://token.actions.githubusercontent.com/.well-known/jwks' }, workflowHandlers: { 'app-preview-status': async () => { const failure = new Error('No Vercel preview deployment exists for this commit.'); failure.name = 'LP-VERCEL-PREVIEW-NOT_FOUND'; throw failure; } } });
  const response = await post(app, validBody());
  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toEqual({ error: { code: 'LP-VERCEL-PREVIEW-NOT_FOUND', message: 'No Vercel preview deployment exists for this commit.', retryable: false, correlationId: expect.any(String) } });
});

it('fails closed with 503 when OIDC or the handler is not configured', async () => {
  const noOidc = createControllerApp({ operatorToken: 'operator' });
  expect((await post(noOidc, validBody())).status).toBe(503);
  vi.mocked(verifyGithubOidc).mockResolvedValueOnce(claims);
  const noHandler = createControllerApp({ operatorToken: 'operator', oidc: { issuer: 'issuer', audience: 'audience', jwks: 'jwks' } });
  expect((await post(noHandler, validBody())).status).toBe(503);
});
