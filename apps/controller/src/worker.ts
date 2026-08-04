import { D1LaunchpadStore, InMemoryDatabase, LaunchpadRepositories } from '@launchpad/database';
import { createControllerApp } from './api.js';
import { controllerDependencies } from './handlers.js';
import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import type { ControllerEnv } from './env.js';
import { handleQueue, type QueueBatch } from './queues.js';
export { ApplyApplicationWorkflow, DecommissionApplicationWorkflow, PreviewApplicationWorkflow, ReconcileApplicationWorkflow } from './workflows.js';

const repositories = new LaunchpadRepositories(new InMemoryDatabase());

export default {
  fetch(request: Request, env: ControllerEnv['Bindings'], executionContext: ExecutionContext): Response | Promise<Response> {
    const dependencies = controllerDependencies(env, repositories);
    const configured = createControllerApp({ ...dependencies, store: env.DB ? new D1LaunchpadStore(env.DB) : undefined });
    return configured.fetch(request, env, executionContext);
  },
  async queue(batch: QueueBatch): Promise<void> { await handleQueue(batch); },
  async scheduled(_controller: ScheduledController, env: ControllerEnv['Bindings']): Promise<void> { if (!env.RECONCILE_WORKFLOW) throw new Error('LP-RECONCILIATION-WORKFLOW-BINDING-MISSING'); await env.RECONCILE_WORKFLOW.create({ id: `reconcile-${Date.now()}`, params: { trigger: 'cron' } }); },
};
