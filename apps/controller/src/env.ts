import type { D1Database, Fetcher } from '@cloudflare/workers-types';

export interface WorkflowBinding { create(input: { id?: string; params?: unknown }): Promise<{ id: string }>; }

export interface ControllerEnv {
  Bindings: {
    DB?: D1Database;
    ASSETS?: Fetcher;
    APPLY_WORKFLOW?: WorkflowBinding;
    PREVIEW_WORKFLOW?: WorkflowBinding;
    RECONCILE_WORKFLOW?: WorkflowBinding;
    DECOMMISSION_WORKFLOW?: WorkflowBinding;
    OPERATOR_TOKEN?: string;
    OIDC_ISSUER?: string;
    OIDC_AUDIENCE?: string;
    OIDC_JWKS?: string;
    CONTROLLER_INTERNAL_TOKEN?: string;
    VERCEL_WEBHOOK_SECRET?: string;
    LAUNCHPAD_ENV?: string;
  };
}

export interface OidcConfig { issuer: string; audience: string; jwks: string; repositoryAllowlist?: string[]; workflowAllowlist?: string[]; }
