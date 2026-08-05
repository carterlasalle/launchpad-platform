import type { WorkflowStep } from 'cloudflare:workers';

/**
 * Cloudflare Workflow step harness: executes every `step.do` boundary against
 * the real controller workflow classes in-process. Records executed steps and
 * can force an interruption (simulated Worker restart) after a chosen number
 * of completed steps so tests can prove durable resume without duplicate
 * provider writes.
 */
export class WorkflowStepHarness implements WorkflowStep {
  /** Names of every `step.do` boundary executed, in order. */
  readonly executed: string[] = [];
  readonly sleeps: Array<{ name: string; duration: string | number }> = [];
  private readonly interruptAfter: number | null;
  /** Set when the harness threw the simulated interruption. */
  interrupted = false;

  constructor(options: { interruptAfter?: number } = {}) {
    this.interruptAfter = options.interruptAfter ?? null;
  }

  async do(name: string, callback: () => Promise<unknown>): Promise<unknown> {
    this.executed.push(name);
    if (this.interruptAfter !== null && this.executed.length > this.interruptAfter) {
      this.interrupted = true;
      const error = new Error(`LP-SIMULATED-WORKER-RESTART: interrupted before '${name}'`);
      error.name = 'LP-SIMULATED-WORKER-RESTART';
      throw error;
    }
    return callback();
  }

  async sleep(name: string, duration: string | number): Promise<void> {
    this.sleeps.push({ name, duration });
  }
}

/** Workflow event payload shape accepted by the WorkflowEntrypoint classes. */
export interface WorkflowEventShape<P = Record<string, unknown>> {
  payload: P;
  timestamp: Date;
  instanceId: string;
  workflowName: string;
}

export function workflowEvent<P = Record<string, unknown>>(payload: P, instanceId: string): WorkflowEventShape<P> {
  return { payload, timestamp: new Date('2026-08-04T00:00:00.000Z'), instanceId, workflowName: 'integration' };
}
