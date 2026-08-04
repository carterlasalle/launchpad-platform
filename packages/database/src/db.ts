import type { PlatformPlan } from '@launchpad/core';

export interface OperationRow { id: string; workflowId: string; applicationId: string; action: string; status: 'QUEUED' | 'RUNNING' | 'RETRYING' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED' | 'ROLLED_BACK'; idempotencyKey: string; payloadHash: string; startedAt: string; completedAt: string | null; errorCode: string | null; }
export interface StepRow { operationId: string; stepId: string; status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'RETRYING' | 'SKIPPED'; attempt: number; preconditionHash: string; result: unknown; error: unknown; }
export interface LockRow { resourceKey: string; ownerId: string; expiresAt: number; }
export interface AuditRow { id: string; actor: string; action: string; applicationId: string; details: Record<string, unknown>; createdAt: string; }
export interface TombstoneRow { applicationId: string; domain: string; deletedAt: string; retainUntil: string; }
export interface StoredPlan { id: string; applicationId: string; fingerprint: string; plan: PlatformPlan; createdAt: string; }

export class InMemoryDatabase {
  readonly operations = new Map<string, OperationRow>();
  readonly idempotency = new Map<string, { payloadHash: string; operationId: string }>();
  readonly steps = new Map<string, StepRow>();
  readonly locks = new Map<string, LockRow>();
  readonly audits: AuditRow[] = [];
  readonly tombstones = new Map<string, TombstoneRow>();
  readonly plans = new Map<string, StoredPlan>();
}
