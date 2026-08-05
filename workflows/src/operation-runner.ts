import { canonicalJson, isRetryableError } from '@launchpad/shared';
import { TERMINAL_WORKFLOW_STATUSES, type LaunchpadStore } from '@launchpad/database';

/**
 * Durable, store-backed execution of one granular apply phase (or a composed
 * machine). Every start/attempt/result/error is persisted through
 * `LaunchpadStore` (`workflow_runs` + `workflow_steps`), so a Worker restart
 * resumes from the last durable boundary: completed steps with unchanged
 * preconditions are never re-executed, and their persisted results are
 * returned to the caller exactly as before.
 *
 * Retries are granted ONLY for typed retryable failures (`error.retryable ===
 * true`, e.g. `ProviderRequestError`/`LaunchpadError`/`WorkflowFailure` with
 * retryable set) and are bounded by the step's `retry` policy with
 * exponential backoff.
 */

export interface DurableStepRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
}

/** Execution context passed to every step: persisted outputs of prior steps. */
export interface StepRunContext {
  /** stepId -> persisted result of every previously completed step (resumed or fresh). */
  readonly outputs: Readonly<Record<string, unknown>>;
}

export interface DurableStep<TResult = unknown> {
  /** Stable step identifier; doubles as the durable step key across resumes. */
  id: string;
  /**
   * Hash of the inputs this step consumes. A step persisted as SUCCEEDED is
   * skipped on resume only while this hash matches; any input change
   * re-executes it (idempotent mutations make that safe).
   */
  preconditionHash: string;
  /** Bounded retry policy. Defaults to 3 attempts, 1s base delay, 30s cap. */
  retry?: DurableStepRetryPolicy;
  /** Executes the step body. `attempt` is 1-based. Results must be JSON-serializable. */
  run: (attempt: number, context: StepRunContext) => Promise<TResult>;
}

export interface OperationRunInput {
  applicationId: string;
  /** Cloudflare Workflow instance id; used as lock owner and provider context workflowId. */
  workflowId: string;
  /** Workflow type recorded on the durable run, e.g. 'APPLY'. */
  action: string;
  idempotencyKey: string;
  payloadHash: string;
  /** Ordered steps of the machine. Each is independently resumable. */
  steps: DurableStep<unknown>[];
  /**
   * Optional recovery step executed (as durable step 'recover-on-failure')
   * when a step exhausts its retries. Should not throw; its result is
   * returned as `recovery`. The run itself stays FAILED.
   */
  onFailure?: (failure: { failedStep: string; error: unknown; outputs: Readonly<Record<string, unknown>> }) => Promise<unknown>;
  /**
   * Optional lock release invoked in finally paths (success and failure).
   * Failures are recorded as a visible 'release-locks' step without flipping
   * the run status.
   */
  releaseLocks?: () => Promise<void>;
  sleep?: (delayMs: number) => Promise<void>;
}

export interface StepOutcome { status: 'SUCCEEDED' | 'FAILED'; result?: unknown; error?: unknown; }
export interface OperationRunResult {
  operationId: string;
  status: 'SUCCEEDED' | 'FAILED';
  failedStep: string | null;
  error: unknown;
  /** stepId -> persisted result, including results resumed from the store. */
  outputs: Record<string, unknown>;
  /** Result of the onFailure recovery step when the run failed. */
  recovery: unknown;
}

const DEFAULT_RETRY: Required<DurableStepRetryPolicy> = { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 };
const RELEASE_STEP = 'release-locks';

function serializableError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    let code: string | null = null;
    if ('code' in error && typeof error.code === 'string') code = error.code;
    let details: unknown = null;
    if ('details' in error && error.details !== null && error.details !== undefined) details = error.details;
    return { name: error.name, code, message: error.message, retryable: isRetryableError(error), details };
  }
  return { message: 'Unknown failure' };
}

export function errorCodeOf(error: unknown): string | null {
  if (error instanceof Error) return error.name;
  return null;
}

export class DurableOperationRunner {
  readonly store: LaunchpadStore;

  constructor(store: LaunchpadStore) { this.store = store; }

  /** Starts (or returns) the durable workflow run for the idempotency key. */
  async startRun(input: OperationRunInput): Promise<string> {
    const run = await this.store.startWorkflowRun({ applicationId: input.applicationId, workflowType: input.action, idempotencyKey: input.idempotencyKey, payloadHash: input.payloadHash });
    return run.id;
  }

  /**
   * Executes one durable step (single-phase dispatch). Completing the step
   * leaves the run RUNNING; a failure after retry exhaustion marks the run
   * FAILED with error code and completion time. Pass `complete: true` to mark
   * the run SUCCEEDED after the step (the machine's final phase). Terminal
   * runs are never un-terminalized by later phases (recovery, lock release).
   */
  async executeStep(input: OperationRunInput, step: DurableStep, outputs: Record<string, unknown> | undefined, options: { complete?: boolean } = {}): Promise<StepOutcome> {
    const operationId = await this.startRun(input);
    const run = await this.store.getWorkflowRun(operationId);
    const terminal = run !== null && TERMINAL_WORKFLOW_STATUSES.includes(run.status);
    if (!terminal) await this.store.updateWorkflowRun(operationId, { status: 'RUNNING', completedAt: null, errorCode: null });
    const outcome = await this.attemptStep(operationId, step, outputs, input.sleep);
    if (outcome.status === 'FAILED') {
      if (!terminal) await this.store.updateWorkflowRun(operationId, { status: 'FAILED', completedAt: new Date().toISOString(), errorCode: errorCodeOf(outcome.error) ?? 'LP-WORKFLOW-STEP-FAILED' });
      return outcome;
    }
    if (options.complete === true && !terminal) {
      await this.store.updateWorkflowRun(operationId, { status: 'SUCCEEDED', completedAt: new Date().toISOString(), errorCode: null });
    }
    return outcome;
  }

  /** Runs a composed machine: idempotent resume, per-step retries, recovery, lock release. */
  async run(input: OperationRunInput): Promise<OperationRunResult> {
    const operationId = await this.startRun(input);
    await this.store.updateWorkflowRun(operationId, { status: 'RUNNING', completedAt: null, errorCode: null });
    const outputs: Record<string, unknown> = {};
    await this.rehydrateOutputs(operationId, input.steps, outputs);
    try {
      for (const step of input.steps) {
        const outcome = await this.attemptStep(operationId, step, outputs, input.sleep);
        if (outcome.status === 'FAILED') {
          const recovery = await this.recover(operationId, input, step.id, outcome.error, outputs);
          await this.store.updateWorkflowRun(operationId, { status: 'FAILED', completedAt: new Date().toISOString(), errorCode: errorCodeOf(outcome.error) ?? 'LP-WORKFLOW-STEP-FAILED' });
          return { operationId, status: 'FAILED', failedStep: step.id, error: outcome.error, outputs, recovery };
        }
      }
      await this.store.updateWorkflowRun(operationId, { status: 'SUCCEEDED', completedAt: new Date().toISOString(), errorCode: null });
      return { operationId, status: 'SUCCEEDED', failedStep: null, error: null, outputs, recovery: null };
    } finally {
      await this.release(operationId, input);
    }
  }

  private async attemptStep(operationId: string, step: DurableStep, outputs: Record<string, unknown> | undefined, sleep: ((delayMs: number) => Promise<void>) | undefined): Promise<StepOutcome> {
    const persisted = await this.store.getWorkflowStep(operationId, step.id);
    if (persisted?.status === 'SUCCEEDED' && persisted.preconditionHash === step.preconditionHash) {
      if (outputs) outputs[step.id] = persisted.result;
      return { status: 'SUCCEEDED', result: persisted.result };
    }
    const policy: Required<DurableStepRetryPolicy> = { ...DEFAULT_RETRY, ...step.retry };
    const stepOutputs: Record<string, unknown> = outputs ?? {};
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      await this.store.recordWorkflowStep({ workflowId: operationId, stepId: step.id, status: 'RUNNING', attempt, preconditionHash: step.preconditionHash });
      try {
        const result = await step.run(attempt, { outputs: { ...stepOutputs } });
        await this.store.recordWorkflowStep({ workflowId: operationId, stepId: step.id, status: 'SUCCEEDED', attempt, preconditionHash: step.preconditionHash, result });
        stepOutputs[step.id] = result;
        return { status: 'SUCCEEDED', result };
      } catch (error) {
        lastError = error;
        const retryable = isRetryableError(error);
        const exhausted = attempt === policy.maxAttempts;
        await this.store.recordWorkflowStep({ workflowId: operationId, stepId: step.id, status: retryable && !exhausted ? 'RETRYING' : 'FAILED', attempt, preconditionHash: step.preconditionHash, error: serializableError(error) });
        if (!retryable || exhausted) break;
        const delayMs = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
        if (sleep) await sleep(delayMs);
        else await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return { status: 'FAILED', error: lastError };
  }

  private async recover(operationId: string, input: OperationRunInput, failedStep: string, error: unknown, outputs: Record<string, unknown>): Promise<unknown> {
    const onFailure = input.onFailure;
    if (!onFailure) return null;
    const recoveryStep: DurableStep = {
      id: 'recover-on-failure',
      preconditionHash: canonicalJson({ failedStep, error: serializableError(error) }),
      run: async () => onFailure({ failedStep, error, outputs }),
    };
    const outcome = await this.attemptStep(operationId, recoveryStep, outputs, input.sleep);
    return outcome.status === 'SUCCEEDED' ? outcome.result : { recoveryFailed: true, error: outcome.error };
  }

  private async release(operationId: string, input: OperationRunInput): Promise<void> {
    if (!input.releaseLocks) return;
    try {
      await input.releaseLocks();
      await this.store.recordWorkflowStep({ workflowId: operationId, stepId: RELEASE_STEP, status: 'SUCCEEDED', attempt: 1, preconditionHash: input.payloadHash });
    } catch (error) {
      await this.store.recordWorkflowStep({ workflowId: operationId, stepId: RELEASE_STEP, status: 'FAILED', attempt: 1, preconditionHash: input.payloadHash, error: serializableError(error) });
    }
  }

  private async rehydrateOutputs(operationId: string, steps: DurableStep[], outputs: Record<string, unknown>): Promise<void> {
    for (const step of steps) {
      const persisted = await this.store.getWorkflowStep(operationId, step.id);
      if (persisted?.status === 'SUCCEEDED' && persisted.preconditionHash === step.preconditionHash) {
        outputs[step.id] = persisted.result;
      }
    }
  }
}
