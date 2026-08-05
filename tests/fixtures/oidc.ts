import { exportJWK, SignJWT } from 'jose';

/**
 * Signed GitHub OIDC/JWKS fixture: generates a real RSA key pair, exposes the
 * JWKS document the controller fetches, and signs GitHub Actions-shaped
 * tokens for the integration tests. Token verification runs through the
 * controller's own `verifyGithubOidc` (jose, RS256) — nothing is stubbed.
 */
export interface OidcTestKeys {
  issuer: string;
  audience: string;
  jwksUrl: string;
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
  jwksBody: { keys: JsonWebKey[] };
}

export async function createOidcTestKeys(issuer: string, audience: string): Promise<OidcTestKeys> {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = await exportJWK(pair.publicKey);
  const publicJwk = { ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' } as JsonWebKey;
  return { issuer, audience, jwksUrl: `${issuer}/.well-known/jwks`, privateKey: pair.privateKey, publicJwk, jwksBody: { keys: [publicJwk] } };
}

export function signGithubToken(keys: OidcTestKeys, claims: Record<string, unknown>, options: { expiresInSeconds?: number; issuedAtSeconds?: number } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(keys.issuer)
    .setAudience(keys.audience)
    .setIssuedAt(options.issuedAtSeconds ?? now)
    .setExpirationTime(now + (options.expiresInSeconds ?? 3600))
    .sign(keys.privateKey);
}

/**
 * GitHub Actions OIDC claims for the integration fixtures. `event_name`,
 * `sha`, and `ref` follow GitHub's OIDC semantics: for `pull_request` events
 * the `sha` claim is the ephemeral merge commit, NOT the PR head.
 */
export function githubClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'repo:987654321:example/fixture:ref:refs/heads/main',
    repository: 'example/fixture',
    repository_id: '123456789',
    repository_owner: 'example',
    repository_owner_id: '987654321',
    workflow_ref: 'example/fixture/.github/workflows/preview.yml@refs/heads/main',
    workflow: 'preview.yml',
    event_name: 'push',
    sha: 'a'.repeat(40),
    ref: 'refs/heads/main',
    actor: 'alice',
    run_id: '1234567890',
    ...overrides,
  };
}

export function pushClaims(sourceCommit: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return githubClaims({ event_name: 'push', sha: sourceCommit, ref: 'refs/heads/main', ...overrides });
}

export function prClaims(prNumber: number, mergeSha: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return githubClaims({ event_name: 'pull_request', sha: mergeSha, ref: `refs/pull/${prNumber}/merge`, pull_request_number: String(prNumber), ...overrides });
}
