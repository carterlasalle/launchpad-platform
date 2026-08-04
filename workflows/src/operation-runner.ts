import { isRetryableError } from '@launchpad/shared';
import { LaunchpadRepositories, type OperationRow } from '@launchpad/database';

export interface DurableStep { id: string; preconditionHash: string; maxAttempts?: number; run: (attempt: number) => Promise<unknown>; }
export interface OperationRunInput { applicationId: string; workflowId: string; action: string; idempotencyKey: string; payloadHash: string; steps: DurableStep[]; }
export interface OperationRunResult { operationId: string; status: OperationRow['status']; failedStep: string | null; error: unknown; }

export class DurableOperationRunner {
  readonly repositories: LaunchpadRepositories;

  constructor(repositories: LaunchpadRepositories) { this.repositories = repositories; }

  async run(input: OperationRunInput): Promise<OperationRunResult> {
    const operation = this.repositories.startOperation(input);
    this.repositories.updateOperation(operation.id, { status: 'RUNNING', completedAt: null, errorCode: null });
    for (const step of input.steps) {
      const existing = this.repositories.getStep(operation.id, step.id);
      if (existing?.status === 'SUCCEEDED' && existing.preconditionHash === step.preconditionHash) continue;
      const maxAttempts = step.maxAttempts ?? 3;
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        this.repositories.recordStep({ operationId: operation.id, stepId: step.id, status: 'RUNNING', attempt, preconditionHash: step.preconditionHash, result: null, error: null });
        try {
          const result = await step.run(attempt);
          this.repositories.recordStep({ operationId: operation.id, stepId: step.id, status: 'SUCCEEDED', attempt, preconditionHash: step.preconditionHash, result, error: null });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const retryable = isRetryableError(error);
          this.repositories.recordStep({ operationId: operation.id, stepId: step.id, status: retryable && attempt < maxAttempts ? 'RETRYING' : 'FAILED', attempt, preconditionHash: step.preconditionHash, result: null, error: error instanceof Error ? { name: error.name, message: error.message } : { message: 'Unknown failure' } });
          if (!retryable || attempt === maxAttempts) break;
        }
      }
      if (lastError !== null) {
        this.repositories.updateOperation(operation.id, { status: 'FAILED', completedAt: new Date().toISOString(), errorCode: lastError instanceof Error ? lastError.name : 'LP-WORKFLOW-STEP-FAILED' });
        return { operationId: operation.id, status: 'FAILED', failedStep: step.id, error: lastError };
      }
    }
    this.repositories.updateOperation(operation.id, { status: 'SUCCEEDED', completedAt: new Date().toISOString(), errorCode: null });
    return { operationId: operation.id, status: 'SUCCEEDED', failedStep: null, error: null };
  }
}
