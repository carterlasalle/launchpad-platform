import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { OidcConfig } from '../env.js';

export interface GithubOidcClaims extends JWTPayload {
  repository?: string;
  repository_id?: string;
  repository_owner_id?: string;
  repository_owner?: string;
  workflow_ref?: string;
  workflow?: string;
  event_name?: string;
  pull_request_number?: string;
  sha?: string;
  ref?: string;
  actor?: string;
}

/**
 * Body fields a workflow endpoint may bind to OIDC claims. Every field the
 * request carries MUST match the corresponding signed claim; a token minted
 * for one repository can never act for another repository or event.
 */
export interface OidcBoundBody { repository?: unknown; repositoryId?: unknown; repositoryOwnerId?: unknown; event?: unknown; pullRequestNumber?: unknown; ref?: unknown; }

/** Claim-binding failure with a stable, non-leaking error code. */
export class OidcClaimError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = code;
    this.code = code;
  }
}

function claimMismatch(code: string, claim: string, body: unknown): OidcClaimError {
  return new OidcClaimError(code, `OIDC claim '${claim}' does not match the request body.`);
}

/**
 * Binds request body identity fields to the verified OIDC claims
 * (cross-repository scope separation). Only fields actually present in the
 * body are bound; the `sourceCommit` field is intentionally NOT bound to the
 * `sha` claim because for pull_request events the token `sha` is the merge
 * commit while the preview gate verifies the exact PR head SHA.
 */
export function bindOidcBody(claims: GithubOidcClaims, body: OidcBoundBody): void {
  if (body.repository !== undefined && body.repository !== claims.repository) throw claimMismatch('LP-OIDC-CLAIM-REPOSITORY-MISMATCH', 'repository', body.repository);
  if (body.repositoryId !== undefined && String(body.repositoryId) !== String(claims.repository_id)) throw claimMismatch('LP-OIDC-CLAIM-REPOSITORY-ID-MISMATCH', 'repository_id', body.repositoryId);
  if (body.repositoryOwnerId !== undefined && String(body.repositoryOwnerId) !== String(claims.repository_owner_id)) throw claimMismatch('LP-OIDC-CLAIM-OWNER-ID-MISMATCH', 'repository_owner_id', body.repositoryOwnerId);
  if (body.event !== undefined && body.event !== claims.event_name) throw claimMismatch('LP-OIDC-CLAIM-EVENT-MISMATCH', 'event_name', body.event);
  if (body.pullRequestNumber !== undefined && String(body.pullRequestNumber) !== String(claims.pull_request_number)) throw claimMismatch('LP-OIDC-CLAIM-PR-MISMATCH', 'pull_request_number', body.pullRequestNumber);
  if (body.ref !== undefined && body.ref !== claims.ref) throw claimMismatch('LP-OIDC-CLAIM-REF-MISMATCH', 'ref', body.ref);
}

export async function verifyGithubOidc(token: string | null, config: OidcConfig): Promise<GithubOidcClaims> {
  if (!token) throw new Error('OIDC bearer token is required.');
  const jwks = createRemoteJWKSet(new URL(config.jwks), { timeoutDuration: 5_000, cooldownDuration: 30_000 });
  const { payload } = await jwtVerify<GithubOidcClaims>(token, jwks, {
    issuer: config.issuer,
    audience: config.audience,
    algorithms: ['RS256'],
    ...(config.clockToleranceSeconds !== undefined ? { clockTolerance: config.clockToleranceSeconds } : {}),
  });
  if (config.repositoryAllowlist && (!payload.repository || !config.repositoryAllowlist.includes(payload.repository))) throw new Error('OIDC repository is not allowed.');
  if (config.workflowAllowlist && (!payload.workflow_ref || !config.workflowAllowlist.includes(payload.workflow_ref))) throw new Error('OIDC workflow is not allowed.');
  if (payload.repository_id === undefined || payload.repository_owner_id === undefined || payload.workflow_ref === undefined) throw new Error('OIDC token is missing required GitHub identity claims.');
  return payload;
}

const JWT_SEGMENT = /^[A-Za-z0-9_-]+$/;

function isJwt(candidate: string): boolean {
  const parts = candidate.split('.');
  return parts.length === 3 && parts.every((part) => JWT_SEGMENT.test(part));
}

/**
 * Extracts the GitHub Actions OIDC JWT from an Authorization bearer value.
 * Accepts either the raw JWT or the raw request-token API response body
 * (`{ "value": "<jwt>", "expires_in": …, "token_type": "Bearer" }`), which is
 * what `curl "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=…"` returns. Anything
 * else yields null (authentication failure).
 */
export function extractOidcToken(value: string | null): string | null {
  if (!value) return null;
  const candidate = value.trim();
  if (isJwt(candidate)) return candidate;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const nested = (parsed as { value?: unknown }).value;
      if (typeof nested === 'string' && isJwt(nested.trim())) return nested.trim();
    }
  } catch {
    // Not JSON — cannot contain a token value.
  }
  return null;
}

/** The body-declared identity a request must match against verified OIDC claims. */
export interface OidcBinding {
  applicationId?: string | null;
  repository?: string | null;
  repositoryId?: string | null;
  ownerId?: string | null;
  workflowRef?: string | null;
  event?: string | null;
  prNumber?: number | string | null;
  sourceCommit?: string | null;
  ref?: string | null;
  actor?: string | null;
}

/** A claim binding failure with a stable, typed code. */
export class OidcBindingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = code;
    this.code = code;
  }
}

function bindingMismatch(field: string): OidcBindingError {
  return new OidcBindingError(`LP-OIDC-CLAIM-MISMATCH-${field.toUpperCase()}`, `OIDC claim '${field}' does not match the request.`);
}

function bindingMissing(field: string): OidcBindingError {
  return new OidcBindingError(`LP-OIDC-CLAIM-MISSING-${field.toUpperCase()}`, `OIDC token is missing the required '${field}' claim.`);
}

/**
 * Binds verified GitHub OIDC claims to the identity declared by the request
 * body. Every declared binding must match its claim exactly; claims required
 * for GitHub identity are always required. The commit-SHA rule accounts for
 * GitHub's OIDC semantics: for `pull_request` events the `sha` claim is the
 * ephemeral `refs/pull/N/merge` commit, NOT the reviewed PR head — so head
 * SHA verification is deferred to the controller's server-side PR lookup
 * (the route calls `verifyPullRequestHead`). For every other event the token
 * `sha` claim must equal the request's `sourceCommit` exactly.
 */
export function pullRequestNumberFromClaims(claims: GithubOidcClaims): string | null {
  if (claims.pull_request_number !== undefined) return claims.pull_request_number;
  const match = /^refs\/pull\/(\d+)\/merge$/.exec(claims.ref ?? '');
  return match?.[1] ?? null;
}

export function assertOidcBinding(claims: GithubOidcClaims, binding: OidcBinding): void {
  if (binding.repository !== undefined && binding.repository !== null) {
    if (claims.repository !== binding.repository) throw bindingMismatch('repository');
  } else if (!claims.repository) {
    throw bindingMissing('repository');
  }
  if (binding.repositoryId !== undefined && binding.repositoryId !== null) {
    if (claims.repository_id !== String(binding.repositoryId)) throw bindingMismatch('repository_id');
  } else if (claims.repository_id === undefined) {
    throw bindingMissing('repository_id');
  }
  if (binding.ownerId !== undefined && binding.ownerId !== null) {
    if (claims.repository_owner_id !== String(binding.ownerId)) throw bindingMismatch('repository_owner_id');
  } else if (claims.repository_owner_id === undefined) {
    throw bindingMissing('repository_owner_id');
  }
  if (binding.workflowRef !== undefined && binding.workflowRef !== null) {
    if (claims.workflow_ref !== binding.workflowRef) throw bindingMismatch('workflow_ref');
  } else if (claims.workflow_ref === undefined) {
    throw bindingMissing('workflow_ref');
  }
  if (binding.event !== undefined && binding.event !== null && claims.event_name !== binding.event) {
    throw bindingMismatch('event_name');
  }
  if (binding.prNumber !== undefined && binding.prNumber !== null) {
    if (pullRequestNumberFromClaims(claims) !== String(binding.prNumber)) throw bindingMismatch('pull_request_number');
  }
  if (binding.ref !== undefined && binding.ref !== null && claims.ref !== binding.ref) {
    throw bindingMismatch('ref');
  }
  if (binding.actor !== undefined && binding.actor !== null && claims.actor !== binding.actor) {
    throw bindingMismatch('actor');
  }
  if (binding.sourceCommit !== undefined && binding.sourceCommit !== null) {
    if (claims.event_name === 'pull_request') {
      // GitHub never includes the PR head SHA in OIDC claims; the caller must
      // verify it server-side against the pull request API instead.
      if (pullRequestNumberFromClaims(claims) === null) throw bindingMissing('pull_request_number');
    } else {
      if (!claims.sha) throw bindingMissing('sha');
      if (claims.sha !== binding.sourceCommit) throw bindingMismatch('sourceCommit');
    }
  }
}
