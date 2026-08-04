import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

interface WorkflowEnv { CONTROLLER_INTERNAL_URL?: string; CONTROLLER_INTERNAL_TOKEN?: string; }
interface WorkflowPayload { applicationId: string; sourceCommit?: string; planFingerprint?: string; idempotencyKey?: string; [key: string]: unknown; }

async function dispatch(env: WorkflowEnv, kind: string, payload: WorkflowPayload): Promise<Record<string, unknown>> {
  if (!env.CONTROLLER_INTERNAL_URL || !env.CONTROLLER_INTERNAL_TOKEN) throw new Error('LP-WORKFLOW-DISPATCH-CONFIG-MISSING');
  const response = await fetch(`${env.CONTROLLER_INTERNAL_URL.replace(/\/$/, '')}/internal/workflows/${kind}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-launchpad-workflow-token': env.CONTROLLER_INTERNAL_TOKEN }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`LP-WORKFLOW-DISPATCH-${response.status}`);
  const value = await response.json() as unknown;
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { value };
}

export class ApplyApplicationWorkflow extends WorkflowEntrypoint<WorkflowEnv, WorkflowPayload> {
  async run(event: WorkflowEvent<WorkflowPayload>, step: WorkflowStep): Promise<Record<string, unknown>> {
    const validated = await step.do('validate apply request', async () => { if (!event.payload.applicationId || !event.payload.sourceCommit || !event.payload.planFingerprint) throw new Error('LP-WORKFLOW-APPLY-PAYLOAD-INVALID'); return event.payload; });
    return step.do('execute durable apply', async () => dispatch(this.env, 'apply', validated));
  }
}

export class PreviewApplicationWorkflow extends WorkflowEntrypoint<WorkflowEnv, WorkflowPayload> {
  async run(event: WorkflowEvent<WorkflowPayload>, step: WorkflowStep): Promise<Record<string, unknown>> {
    const validated = await step.do('validate preview request', async () => { if (!event.payload.applicationId || !event.payload.sourceCommit) throw new Error('LP-WORKFLOW-PREVIEW-PAYLOAD-INVALID'); return event.payload; });
    return step.do('execute durable preview', async () => dispatch(this.env, 'preview', validated));
  }
}

export class ReconcileApplicationWorkflow extends WorkflowEntrypoint<WorkflowEnv, WorkflowPayload> {
  async run(event: WorkflowEvent<WorkflowPayload>, step: WorkflowStep): Promise<Record<string, unknown>> {
    const validated = await step.do('validate reconcile request', async () => { if (!event.payload.applicationId || !event.payload.sourceCommit) throw new Error('LP-WORKFLOW-RECONCILE-PAYLOAD-INVALID'); return event.payload; });
    return step.do('execute durable reconciliation', async () => dispatch(this.env, 'reconcile', validated));
  }
}

export class DecommissionApplicationWorkflow extends WorkflowEntrypoint<WorkflowEnv, WorkflowPayload> {
  async run(event: WorkflowEvent<WorkflowPayload>, step: WorkflowStep): Promise<Record<string, unknown>> {
    const validated = await step.do('validate decommission request', async () => { if (!event.payload.applicationId || !event.payload.idempotencyKey) throw new Error('LP-WORKFLOW-DECOMMISSION-PAYLOAD-INVALID'); return event.payload; });
    return step.do('execute durable decommission', async () => dispatch(this.env, 'decommission', validated));
  }
}
