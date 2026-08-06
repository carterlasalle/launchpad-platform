import { expect, it } from 'vitest';
import { assertOidcBinding, extractOidcToken, OidcBindingError, verifyGithubOidc, type GithubOidcClaims } from './oidc.js';
import { verifyWebhookSignature } from './webhooks.js';

function expectBindingError(call: () => void, code: string): void {
  try {
    call();
    expect.unreachable(`expected binding error ${code}`);
  } catch (error) {
    expect((error as OidcBindingError).code).toBe(code);
  }
}

it('rejects missing or malformed OIDC tokens', async () => {
  await expect(verifyGithubOidc(null, { issuer: 'https://issuer.test', audience: 'launchpad', jwks: 'https://issuer.test/jwks' })).rejects.toThrow(/OIDC bearer token/);
});

it('extracts the JWT from raw tokens and request-token API responses', () => {
  expect(extractOidcToken('aaa.bbb.ccc')).toBe('aaa.bbb.ccc');
  expect(extractOidcToken('  aaa.bbb.ccc  ')).toBe('aaa.bbb.ccc');
  expect(extractOidcToken('{"value":"aaa.bbb.ccc","expires_in":360,"token_type":"Bearer"}')).toBe('aaa.bbb.ccc');
  expect(extractOidcToken('{"value":42}')).toBeNull();
  expect(extractOidcToken('garbage')).toBeNull();
  expect(extractOidcToken(null)).toBeNull();
  expect(extractOidcToken('')).toBeNull();
});

function claims(overrides: Record<string, unknown> = {}): GithubOidcClaims {
  return {
    repository: 'acme/web-app',
    repository_id: '123',
    repository_owner_id: '456',
    workflow_ref: 'acme/web-app/.github/workflows/preview.yml@refs/heads/main',
    event_name: 'push',
    sha: 'a'.repeat(40),
    ref: 'refs/heads/main',
    actor: 'alice',
    ...overrides,
  } as GithubOidcClaims;
}

it('binds every declared claim and rejects mismatches with typed codes', () => {
  const base = claims();
  expect(() => assertOidcBinding(base, { applicationId: 'app-demo', repository: 'acme/web-app', repositoryId: '123', ownerId: '456', workflowRef: 'acme/web-app/.github/workflows/preview.yml@refs/heads/main', event: 'push', sourceCommit: 'a'.repeat(40), ref: 'refs/heads/main', actor: 'alice' })).not.toThrow();
  expectBindingError(() => assertOidcBinding(base, { repository: 'acme/other' }), 'LP-OIDC-CLAIM-MISMATCH-REPOSITORY');
  expectBindingError(() => assertOidcBinding(base, { repositoryId: '999' }), 'LP-OIDC-CLAIM-MISMATCH-REPOSITORY_ID');
  expectBindingError(() => assertOidcBinding(base, { ownerId: '999' }), 'LP-OIDC-CLAIM-MISMATCH-REPOSITORY_OWNER_ID');
  expectBindingError(() => assertOidcBinding(base, { workflowRef: 'acme/other/.github/workflows/x.yml@main' }), 'LP-OIDC-CLAIM-MISMATCH-WORKFLOW_REF');
  expectBindingError(() => assertOidcBinding(base, { event: 'workflow_dispatch' }), 'LP-OIDC-CLAIM-MISMATCH-EVENT_NAME');
  expectBindingError(() => assertOidcBinding(base, { prNumber: 7 }), 'LP-OIDC-CLAIM-MISMATCH-PULL_REQUEST_NUMBER');
  expectBindingError(() => assertOidcBinding(base, { ref: 'refs/heads/other' }), 'LP-OIDC-CLAIM-MISMATCH-REF');
  expectBindingError(() => assertOidcBinding(base, { actor: 'mallory' }), 'LP-OIDC-CLAIM-MISMATCH-ACTOR');
  expectBindingError(() => assertOidcBinding(base, { sourceCommit: 'b'.repeat(40) }), 'LP-OIDC-CLAIM-MISMATCH-SOURCECOMMIT');
});

it('requires the GitHub identity claims the token must carry', () => {
  expectBindingError(() => assertOidcBinding(claims({ repository_id: undefined }), {}), 'LP-OIDC-CLAIM-MISSING-REPOSITORY_ID');
  expectBindingError(() => assertOidcBinding(claims({ repository_owner_id: undefined }), {}), 'LP-OIDC-CLAIM-MISSING-REPOSITORY_OWNER_ID');
  expectBindingError(() => assertOidcBinding(claims({ workflow_ref: undefined }), {}), 'LP-OIDC-CLAIM-MISSING-WORKFLOW_REF');
  expectBindingError(() => assertOidcBinding(claims({ repository: undefined }), {}), 'LP-OIDC-CLAIM-MISSING-REPOSITORY');
  expectBindingError(() => assertOidcBinding(claims({ sha: undefined }), { sourceCommit: 'a'.repeat(40) }), 'LP-OIDC-CLAIM-MISSING-SHA');
});

it('applies GitHub pull_request OIDC semantics: no merge-sha equality, PR number required', () => {
  const prClaims = claims({ event_name: 'pull_request', sha: 'c'.repeat(40), pull_request_number: '42', ref: 'refs/pull/42/merge' });
  expect(() => assertOidcBinding(prClaims, { event: 'pull_request', prNumber: 42, ref: 'refs/pull/42/merge', sourceCommit: 'b'.repeat(40) })).not.toThrow();
  expectBindingError(() => assertOidcBinding(prClaims, { event: 'pull_request', prNumber: 43, sourceCommit: 'b'.repeat(40) }), 'LP-OIDC-CLAIM-MISMATCH-PULL_REQUEST_NUMBER');
  const refBoundClaims = claims({ event_name: 'pull_request', pull_request_number: undefined, ref: 'refs/pull/42/merge' });
  expect(() => assertOidcBinding(refBoundClaims, { event: 'pull_request', prNumber: 42, ref: 'refs/pull/42/merge', sourceCommit: 'b'.repeat(40) })).not.toThrow();
  expectBindingError(() => assertOidcBinding(claims({ event_name: 'pull_request', pull_request_number: undefined }), { event: 'pull_request', prNumber: 42, sourceCommit: 'b'.repeat(40) }), 'LP-OIDC-CLAIM-MISMATCH-PULL_REQUEST_NUMBER');
  expectBindingError(() => assertOidcBinding(claims({ event_name: 'pull_request', pull_request_number: undefined }), { event: 'pull_request', sourceCommit: 'b'.repeat(40) }), 'LP-OIDC-CLAIM-MISSING-PULL_REQUEST_NUMBER');
});

it('accepts a correctly signed webhook and rejects a tampered payload', async () => {
  const payload = '{"id":"event-1"}';
  const secret = 'webhook-secret';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  const signature = `sha256=${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  await expect(verifyWebhookSignature(payload, signature, secret)).resolves.toBe(true);
  await expect(verifyWebhookSignature(`${payload}!`, signature, secret)).resolves.toBe(false);
});
