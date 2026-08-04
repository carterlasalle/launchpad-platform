import { D1LaunchpadStore } from '@launchpad/database';
import { createControllerApp } from './api.js';
import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import type { ControllerEnv } from './env.js';
import { handleQueue, type QueueBatch } from './queues.js';
export { ApplyApplicationWorkflow, DecommissionApplicationWorkflow, PreviewApplicationWorkflow, ReconcileApplicationWorkflow } from './workflows.js';

const app = createControllerApp({ operatorToken: '', oidc: undefined });

export default {
  fetch(request: Request, env: ControllerEnv['Bindings'], executionContext: ExecutionContext): Response | Promise<Response> {
    const configured = createControllerApp({ operatorToken: env.OPERATOR_TOKEN ?? '', internalWorkflowToken: env.CONTROLLER_INTERNAL_TOKEN, oidc: env.OIDC_ISSUER && env.OIDC_AUDIENCE && env.OIDC_JWKS ? { issuer: env.OIDC_ISSUER, audience: env.OIDC_AUDIENCE, jwks: env.OIDC_JWKS } : undefined, webhookSecret: env.VERCEL_WEBHOOK_SECRET, store: env.DB ? new D1LaunchpadStore(env.DB) : undefined, assets: env.ASSETS as unknown as { fetch(request: Request): Promise<Response> } });
    return configured.fetch(request, env, executionContext);
  },
  async queue(batch: QueueBatch): Promise<void> { await handleQueue(batch); },
  async scheduled(_controller: ScheduledController, env: ControllerEnv['Bindings']): Promise<void> { if (!env.RECONCILE_WORKFLOW) throw new Error('LP-RECONCILIATION-WORKFLOW-BINDING-MISSING'); await env.RECONCILE_WORKFLOW.create({ id: `reconcile-${Date.now()}`, params: { trigger: 'cron' } }); }
};

export { app };
