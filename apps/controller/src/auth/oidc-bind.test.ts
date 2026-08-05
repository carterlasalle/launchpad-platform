import { expect, it } from 'vitest';
import { bindOidcBody, OidcClaimError, type GithubOidcClaims, type OidcBoundBody } from './oidc.js';

const claims: GithubOidcClaims = { repository: 'acme/app', repository_id: '123', repository_owner_id: '456', workflow_ref: 'CarterLaSalle/launchpad/.github/workflows/reusable-app-preview.yml@refs/tags/v1', event_name: 'pull_request', pull_request_number: '7', ref: 'refs/pull/7/merge', sha: 'a'.repeat(40), actor: 'acme-app-ci' };

it('accepts a body whose identity fields match the signed claims', () => {
  expect(() => bindOidcBody(claims, { repository: 'acme/app', repositoryId: 123, repositoryOwnerId: '456', event: 'pull_request', pullRequestNumber: 7, ref: 'refs/pull/7/merge' })).not.toThrow();
});

it('binds only the fields the request actually carries', () => {
  expect(() => bindOidcBody(claims, { repository: 'acme/app' })).not.toThrow();
  expect(() => bindOidcBody(claims, {})).not.toThrow();
});

function claimErrorOf(bind: () => void): OidcClaimError {
  try {
    bind();
  } catch (error) {
    if (error instanceof OidcClaimError) return error;
  }
  throw new Error('Expected bindOidcBody to throw an OidcClaimError');
}

it('rejects repository identity mismatches with stable codes', () => {
  expect(claimErrorOf(() => bindOidcBody(claims, { repository: 'evil/app' })).code).toBe('LP-OIDC-CLAIM-REPOSITORY-MISMATCH');
  expect(claimErrorOf(() => bindOidcBody(claims, { repositoryId: 999 })).code).toBe('LP-OIDC-CLAIM-REPOSITORY-ID-MISMATCH');
  expect(claimErrorOf(() => bindOidcBody(claims, { repositoryOwnerId: '999' })).code).toBe('LP-OIDC-CLAIM-OWNER-ID-MISMATCH');
});

it('rejects event, pull request, and ref mismatches', () => {
  expect(claimErrorOf(() => bindOidcBody(claims, { event: 'push' })).code).toBe('LP-OIDC-CLAIM-EVENT-MISMATCH');
  expect(claimErrorOf(() => bindOidcBody(claims, { pullRequestNumber: 8 })).code).toBe('LP-OIDC-CLAIM-PR-MISMATCH');
  expect(claimErrorOf(() => bindOidcBody(claims, { ref: 'refs/heads/main' })).code).toBe('LP-OIDC-CLAIM-REF-MISMATCH');
});

it('normalizes numeric and string claim representations', () => {
  expect(() => bindOidcBody(claims, { repositoryId: '123', repositoryOwnerId: 456, pullRequestNumber: '7' })).not.toThrow();
});

it('does not bind the commit sha claim (pull_request tokens carry the merge commit)', () => {
  const body = { repository: 'acme/app', sourceCommit: 'b'.repeat(40) } as OidcBoundBody;
  expect(() => bindOidcBody(claims, body)).not.toThrow();
});
