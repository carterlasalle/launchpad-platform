import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { OidcConfig } from '../env.js';

export interface GithubOidcClaims extends JWTPayload { repository?: string; repository_id?: string; repository_owner_id?: string; workflow_ref?: string; event_name?: string; pull_request_number?: string; sha?: string; }

export async function verifyGithubOidc(token: string | null, config: OidcConfig): Promise<GithubOidcClaims> {
  if (!token) throw new Error('OIDC bearer token is required.');
  const jwks = createRemoteJWKSet(new URL(config.jwks), { timeoutDuration: 5_000, cooldownDuration: 30_000 });
  const { payload } = await jwtVerify<GithubOidcClaims>(token, jwks, { issuer: config.issuer, audience: config.audience, algorithms: ['RS256'] });
  if (config.repositoryAllowlist && (!payload.repository || !config.repositoryAllowlist.includes(payload.repository))) throw new Error('OIDC repository is not allowed.');
  if (config.workflowAllowlist && (!payload.workflow_ref || !config.workflowAllowlist.includes(payload.workflow_ref))) throw new Error('OIDC workflow is not allowed.');
  if (payload.repository_id === undefined || payload.repository_owner_id === undefined || payload.workflow_ref === undefined) throw new Error('OIDC token is missing required GitHub identity claims.');
  return payload;
}
