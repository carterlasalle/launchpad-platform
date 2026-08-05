import type { PlatformPlan } from '@launchpad/core';

export interface ApplicationDashboardRow { application: string; displayName: string; owner: string; sync: string; health: string; deployment: string; productionUrl: string | null; updatedAt: string; }

export interface OperationRow { id: string; workflowId: string; applicationId: string; action: string; status: 'QUEUED' | 'RUNNING' | 'RETRYING' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED' | 'ROLLED_BACK'; idempotencyKey: string; payloadHash: string; startedAt: string; completedAt: string | null; errorCode: string | null; }
export interface StepRow { operationId: string; stepId: string; status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'RETRYING' | 'SKIPPED'; attempt: number; preconditionHash: string; result: unknown; error: unknown; }
export interface LockRow { resourceKey: string; ownerId: string; expiresAt: number; }
export interface AuditRow { id: string; actor: string; action: string; applicationId: string; details: Record<string, unknown>; createdAt: string; }
export interface TombstoneRow { applicationId: string; domain: string; deletedAt: string; retainUntil: string; }
export interface StoredPlan { id: string; applicationId: string; fingerprint: string; plan: PlatformPlan; createdAt: string; }

export interface IncidentRow {
  id: string;
  type: string;
  fingerprint: string;
  severity: 'warning' | 'critical';
  applicationId: string | null;
  operationId: string | null;
  message: string;
  details: Record<string, unknown>;
  firstSeenAt: string;
  lastFiredAt: string;
  resolvedAt: string | null;
  delivery: Record<string, unknown>;
}

export class InMemoryDatabase {
  readonly applications = new Map<string, ApplicationDashboardRow>();
  readonly operations = new Map<string, OperationRow>();
  readonly idempotency = new Map<string, { payloadHash: string; operationId: string }>();
  readonly steps = new Map<string, StepRow>();
  readonly locks = new Map<string, LockRow>();
  readonly audits: AuditRow[] = [];
  readonly tombstones = new Map<string, TombstoneRow>();
  readonly plans = new Map<string, StoredPlan>();
  readonly incidents = new Map<string, IncidentRow>();
}
