import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportJWK, SignJWT } from 'jose';
import { parseAllowlist, oidcConfigFromEnv } from '../env.js';
import { assertOidcBinding, extractOidcToken, OidcBindingError, verifyGithubOidc, type GithubOidcClaims } from './oidc.js';
import { timingSafeEqual } from './timing.js';
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
  expectBindingError(() => assertOidcBinding(base, { sourceCommit: 'b'.repeat(40), actor: 'alice' }), 'LP-OIDC-CLAIM-MISMATCH-SOURCECOMMIT');
});

it('requires the GitHub identity claims the token must carry', () => {
  expectBindingError(() => assertOidcBinding(claims({ repository_id: undefined }), {}), 'LP-OIDC-CLAIM-MISSING-REPOSITORY_ID');
  expectBindingError(() => assertOidcBinding(claims({ repository_owner_id: undefined }), {}), 'LP-OIDC-CLAIM-MISSING-REPOSITORY_OWNER_ID');
  expectBindingError(() => assertOidcBinding(claims({ workflow_ref: undefined }), {}), 'LP-OIDC-CLAIM-MISSING-WORKFLOW_REF');
  expectBindingError(() => assertOidcBinding(claims({ repository: undefined }), {}), 'LP-OIDC-CLAIM-MISSING-REPOSITORY');
  expectBindingError(() => assertOidcBinding(claims({ sha: undefined }), { sourceCommit: 'a'.repeat(40), actor: 'alice' }), 'LP-OIDC-CLAIM-MISSING-SHA');
});

it('requires the actor claim binding on every OIDC ingress', () => {
  expectBindingError(() => assertOidcBinding(claims(), { repository: 'acme/web-app', repositoryId: '123', ownerId: '456', workflowRef: 'acme/web-app/.github/workflows/preview.yml@refs/heads/main', event: 'push', sourceCommit: 'a'.repeat(40), ref: 'refs/heads/main' }), 'LP-OIDC-CLAIM-MISSING-ACTOR');
  expectBindingError(() => assertOidcBinding(claims({ actor: undefined }), { repository: 'acme/web-app', repositoryId: '123', ownerId: '456', workflowRef: 'acme/web-app/.github/workflows/preview.yml@refs/heads/main', event: 'push', sourceCommit: 'a'.repeat(40), ref: 'refs/heads/main', actor: 'alice' }), 'LP-OIDC-CLAIM-MISMATCH-ACTOR');
  expectBindingError(() => assertOidcBinding(claims(), { actor: 'mallory' }), 'LP-OIDC-CLAIM-MISMATCH-ACTOR');
  expect(() => assertOidcBinding(claims(), { repository: 'acme/web-app', repositoryId: '123', ownerId: '456', workflowRef: 'acme/web-app/.github/workflows/preview.yml@refs/heads/main', event: 'push', sourceCommit: 'a'.repeat(40), ref: 'refs/heads/main', actor: 'alice' })).not.toThrow();
});

it('applies GitHub pull_request OIDC semantics: no merge-sha equality, PR number required', () => {
  const prClaims = claims({ event_name: 'pull_request', sha: 'c'.repeat(40), pull_request_number: '42', ref: 'refs/pull/42/merge' });
  expect(() => assertOidcBinding(prClaims, { event: 'pull_request', prNumber: 42, ref: 'refs/pull/42/merge', sourceCommit: 'b'.repeat(40), actor: 'alice' })).not.toThrow();
  expectBindingError(() => assertOidcBinding(prClaims, { event: 'pull_request', prNumber: 43, sourceCommit: 'b'.repeat(40) }), 'LP-OIDC-CLAIM-MISMATCH-PULL_REQUEST_NUMBER');
  const refBoundClaims = claims({ event_name: 'pull_request', pull_request_number: undefined, ref: 'refs/pull/42/merge' });
  expect(() => assertOidcBinding(refBoundClaims, { event: 'pull_request', prNumber: 42, ref: 'refs/pull/42/merge', sourceCommit: 'b'.repeat(40), actor: 'alice' })).not.toThrow();
  expectBindingError(() => assertOidcBinding(claims({ event_name: 'pull_request', pull_request_number: undefined }), { event: 'pull_request', prNumber: 42, sourceCommit: 'b'.repeat(40) }), 'LP-OIDC-CLAIM-MISMATCH-PULL_REQUEST_NUMBER');
  expectBindingError(() => assertOidcBinding(claims({ event_name: 'pull_request', pull_request_number: undefined }), { event: 'pull_request', sourceCommit: 'b'.repeat(40), actor: 'alice' }), 'LP-OIDC-CLAIM-MISSING-PULL_REQUEST_NUMBER');
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


describe('parseAllowlist', () => {
  it('returns undefined for unset or blank values', () => {
    expect(parseAllowlist(undefined)).toBeUndefined();
    expect(parseAllowlist('')).toBeUndefined();
    expect(parseAllowlist('   ')).toBeUndefined();
  });

  it('parses a single entry', () => {
    expect(parseAllowlist('acme/web-app')).toEqual(['acme/web-app']);
  });

  it('parses comma-separated entries, trims whitespace, and drops empty entries', () => {
    expect(parseAllowlist('acme/web-app, acme/other ,,org/repo')).toEqual(['acme/web-app', 'acme/other', 'org/repo']);
    expect(parseAllowlist(' a , b , c ')).toEqual(['a', 'b', 'c']);
    expect(parseAllowlist(',a,,b,')).toEqual(['a', 'b']);
  });
});

describe('oidcConfigFromEnv allowlist wiring', () => {
  it('wires repository and workflow allowlists from env', () => {
    const config = oidcConfigFromEnv({
      OIDC_ISSUER: 'https://issuer.test',
      OIDC_AUDIENCE: 'launchpad',
      OIDC_JWKS: 'https://issuer.test/jwks',
      OIDC_REPOSITORY_ALLOWLIST: 'acme/web-app, acme/other',
      OIDC_WORKFLOW_ALLOWLIST: 'acme/web-app/.github/workflows/preview.yml@refs/heads/main',
    });
    expect(config?.repositoryAllowlist).toEqual(['acme/web-app', 'acme/other']);
    expect(config?.workflowAllowlist).toEqual(['acme/web-app/.github/workflows/preview.yml@refs/heads/main']);
  });

  it('leaves allowlists unset when the env vars are absent', () => {
    const config = oidcConfigFromEnv({ OIDC_ISSUER: 'https://issuer.test', OIDC_AUDIENCE: 'launchpad', OIDC_JWKS: 'https://issuer.test/jwks' });
    expect(config?.repositoryAllowlist).toBeUndefined();
    expect(config?.workflowAllowlist).toBeUndefined();
  });
});

describe('timingSafeEqual', () => {
  it('returns true for equal strings and false for differing bytes', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'ABC')).toBe(false);
  });

  it('returns false for differing lengths', () => {
    expect(timingSafeEqual('abc', 'ab')).toBe(false);
    expect(timingSafeEqual('ab', 'abc')).toBe(false);
    expect(timingSafeEqual('', 'a')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(timingSafeEqual('', '')).toBe(true);
  });
});

describe('verifyGithubOidc allowlist and trust-config negatives (real signed tokens)', () => {
  const ISSUER = 'https://token.actions.test';
  const AUDIENCE = 'launchpad-test';
  let privateKey: CryptoKey;
  let publicJwk: JsonWebKey;
  let originalFetch: typeof fetch;

  async function sign(claims: Record<string, unknown>, overrides: { issuer?: string; audience?: string } = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(overrides.issuer ?? ISSUER)
      .setAudience(overrides.audience ?? AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);
  }

  function githubClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      sub: 'repo:123:acme/web-app:ref:refs/heads/main',
      repository: 'acme/web-app',
      repository_id: '123',
      repository_owner: 'acme',
      repository_owner_id: '456',
      workflow_ref: 'acme/web-app/.github/workflows/preview.yml@refs/heads/main',
      workflow: 'preview.yml',
      event_name: 'push',
      sha: 'a'.repeat(40),
      ref: 'refs/heads/main',
      actor: 'alice',
      run_id: '1',
      ...overrides,
    };
  }

  function config(overrides: Partial<Parameters<typeof verifyGithubOidc>[1]> = {}): Parameters<typeof verifyGithubOidc>[1] {
    return { issuer: ISSUER, audience: AUDIENCE, jwks: `${ISSUER}/.well-known/jwks`, ...overrides };
  }

  beforeEach(async () => {
    const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    privateKey = pair.privateKey;
    const jwk = await exportJWK(pair.publicKey);
    publicJwk = { ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' } as JsonWebKey;
    originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${ISSUER}/.well-known/jwks`) {
        return Promise.resolve(new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return Promise.resolve(new Response('not mocked', { status: 500 }));
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('accepts a token whose repository and workflow are allowlisted', async () => {
    const token = await sign(githubClaims());
    await expect(verifyGithubOidc(token, config({ repositoryAllowlist: ['acme/web-app'], workflowAllowlist: ['acme/web-app/.github/workflows/preview.yml@refs/heads/main'] }))).resolves.toMatchObject({ repository: 'acme/web-app' });
  });

  it('rejects a signed token whose repository is not in the repository allowlist', async () => {
    const token = await sign(githubClaims({ repository: 'acme/other', sub: 'repo:123:acme/other:ref:refs/heads/main' }));
    await expect(verifyGithubOidc(token, config({ repositoryAllowlist: ['acme/web-app'] }))).rejects.toThrow(/OIDC repository is not allowed/);
  });

  it('rejects a signed token whose workflow_ref is not in the workflow allowlist', async () => {
    const token = await sign(githubClaims({ workflow_ref: 'acme/web-app/.github/workflows/other.yml@refs/heads/main' }));
    await expect(verifyGithubOidc(token, config({ workflowAllowlist: ['acme/web-app/.github/workflows/preview.yml@refs/heads/main'] }))).rejects.toThrow(/OIDC workflow is not allowed/);
  });

  it('accepts a pull_request workflow_ref when the same workflow path is allowlisted', async () => {
    const token = await sign(githubClaims({ workflow_ref: 'acme/web-app/.github/workflows/preview.yml@refs/pull/42/merge' }));
    await expect(verifyGithubOidc(token, config({ workflowAllowlist: ['acme/web-app/.github/workflows/preview.yml@refs/heads/main'] }))).resolves.toMatchObject({ repository: 'acme/web-app' });
  });

  it('rejects a pull_request workflow_ref whose path is not allowlisted', async () => {
    const token = await sign(githubClaims({ workflow_ref: 'acme/web-app/.github/workflows/other.yml@refs/pull/42/merge' }));
    await expect(verifyGithubOidc(token, config({ workflowAllowlist: ['acme/web-app/.github/workflows/preview.yml@refs/heads/main'] }))).rejects.toThrow(/OIDC workflow is not allowed/);
  });

  it('rejects a non-PR transient ref even when the workflow path is allowlisted', async () => {
    const token = await sign(githubClaims({ workflow_ref: 'acme/web-app/.github/workflows/preview.yml@refs/heads/feature' }));
    await expect(verifyGithubOidc(token, config({ workflowAllowlist: ['acme/web-app/.github/workflows/preview.yml@refs/heads/main'] }))).rejects.toThrow(/OIDC workflow is not allowed/);
  });

  it('rejects a signed token with a wrong issuer', async () => {
    const token = await sign(githubClaims(), { issuer: 'https://evil.test' });
    await expect(verifyGithubOidc(token, config())).rejects.toThrow();
  });

  it('rejects a signed token with a wrong audience', async () => {
    const token = await sign(githubClaims(), { audience: 'other-audience' });
    await expect(verifyGithubOidc(token, config())).rejects.toThrow();
  });
});
