import type { D1Database, Queue, SecretsStoreSecret } from '@cloudflare/workers-types';
import type { QueueEnvelope } from './queues.js';

export interface WorkflowBinding { create(input: { id?: string; params?: unknown }): Promise<{ id: string }>; }

export interface AssetFetcher { fetch(input: string): Promise<Response>; }

export interface ControllerEnv {
  Bindings: {
    DB?: D1Database;
    ASSETS?: AssetFetcher;
    APPLY_WORKFLOW?: WorkflowBinding;
    PREVIEW_WORKFLOW?: WorkflowBinding;
    APP_PREVIEW_STATUS_WORKFLOW?: WorkflowBinding;
    RECONCILE_WORKFLOW?: WorkflowBinding;
    DECOMMISSION_WORKFLOW?: WorkflowBinding;
    PROVIDER_EVENTS?: Queue<QueueEnvelope>;
    HEALTH_CHECKS?: Queue<QueueEnvelope>;
    SECRETS_OPERATOR_TOKEN?: SecretsStoreSecret;
    SECRETS_CONTROLLER_INTERNAL_TOKEN?: SecretsStoreSecret;
    SECRETS_VERCEL_TOKEN?: SecretsStoreSecret;
    SECRETS_CLOUDFLARE_TOKEN?: SecretsStoreSecret;
    SECRETS_GITHUB_TOKEN?: SecretsStoreSecret;
    SECRETS_VERCEL_WEBHOOK_SECRET?: SecretsStoreSecret;
    OPERATOR_TOKEN?: string;
    OIDC_ISSUER?: string;
    OIDC_AUDIENCE?: string;
    OIDC_JWKS?: string;
    OIDC_CLOCK_TOLERANCE?: string;
    OIDC_REPOSITORY_ALLOWLIST?: string;
    OIDC_WORKFLOW_ALLOWLIST?: string;
    CONTROLLER_INTERNAL_URL?: string;
    CONTROLLER_INTERNAL_TOKEN?: string;
    CONTROL_REPOSITORY?: string;
    CONTROL_CATALOG_ROOT?: string;
    VERCEL_TOKEN?: string;
    VERCEL_TEAM_ID?: string;
    CLOUDFLARE_TOKEN?: string;
    /** HTTPS endpoint of the shared authoritative DNS resolver (see dns-resolver.ts). */
    LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL?: string;
    GITHUB_TOKEN?: string;
    VERCEL_WEBHOOK_SECRET?: string;
    RECONCILIATION_SHARD_COUNT?: string;
    /** Bounded provider-event fan-out: max reconciliation instances per webhook event. */
    PROVIDER_EVENT_FANOUT_LIMIT?: string;
    /** Deterministic provider-event fan-out shards (>= 1). */
    PROVIDER_EVENT_SHARD_COUNT?: string;
    LAUNCHPAD_ENV?: string;
    /** Exact runtime gate for scheduled and provider-event reconciliation. */
    LAUNCHPAD_CONTROL_PLANE_ENABLED?: string;
    LAUNCHPAD_LOG_LEVEL?: string;
    LAUNCHPAD_ALERTS_ENABLED?: string;
    LAUNCHPAD_ALERT_COOLDOWN_SECONDS?: string;
    LAUNCHPAD_ALERT_RECONCILIATION_THRESHOLD?: string;
    LAUNCHPAD_ALERT_CREDENTIAL_EXPIRY_WINDOW_DAYS?: string;
    LAUNCHPAD_ALERT_ERROR_RATE_THRESHOLD?: string;
    GITHUB_BASE_URL?: string;
  };
}

export interface OidcConfig {
  issuer: string;
  audience: string;
  jwks: string;
  repositoryAllowlist?: string[];
  workflowAllowlist?: string[];
  /** Clock skew tolerance in seconds applied to `exp`/`nbf` verification (jose `clockTolerance`). */
  clockToleranceSeconds?: number;
}

function parseAllowlist(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function parseClockTolerance(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`LP-OIDC-CONFIG-INVALID: OIDC_CLOCK_TOLERANCE must be a non-negative integer of seconds, got '${value}'.`);
  }
  return parsed;
}

/**
 * Builds the OIDC trust configuration from Worker environment variables.
 * OIDC is enabled only when issuer, audience, and JWKS are all configured;
 * a partial configuration fails closed (throws) rather than silently
 * disabling claim verification.
 */
export function oidcConfigFromEnv(env: ControllerEnv['Bindings']): OidcConfig | undefined {
  const issuer = env.OIDC_ISSUER;
  const audience = env.OIDC_AUDIENCE;
  const jwks = env.OIDC_JWKS;
  if (!issuer || !audience || !jwks) {
    if (issuer || audience || jwks) throw new Error('LP-OIDC-CONFIG-INVALID: OIDC_ISSUER, OIDC_AUDIENCE, and OIDC_JWKS must be configured together.');
    return undefined;
  }
  const config: OidcConfig = { issuer, audience, jwks };
  const clockToleranceSeconds = parseClockTolerance(env.OIDC_CLOCK_TOLERANCE);
  if (clockToleranceSeconds !== undefined) config.clockToleranceSeconds = clockToleranceSeconds;
  const repositoryAllowlist = parseAllowlist(env.OIDC_REPOSITORY_ALLOWLIST);
  if (repositoryAllowlist !== undefined) config.repositoryAllowlist = repositoryAllowlist;
  const workflowAllowlist = parseAllowlist(env.OIDC_WORKFLOW_ALLOWLIST);
  if (workflowAllowlist !== undefined) config.workflowAllowlist = workflowAllowlist;
  return config;
}
