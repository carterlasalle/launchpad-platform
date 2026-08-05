import { stableId } from '@launchpad/shared';
import type { PlatformPlan } from '@launchpad/core';
import { InMemoryDatabase, type ApplicationDashboardRow, type AuditRow, type IncidentRow, type OperationRow, type StepRow, type TombstoneRow } from './db.js';

export interface StartOperationInput { applicationId: string; workflowId: string; action: string; idempotencyKey: string; payloadHash: string; }
export interface RecordStepInput { operationId: string; stepId: string; status: StepRow['status']; attempt: number; preconditionHash: string; result: unknown; error: unknown; }

export class LaunchpadRepositories {
  readonly db: InMemoryDatabase;

  constructor(db: InMemoryDatabase) { this.db = db; }
  upsertApplication(row: ApplicationDashboardRow): void { this.db.applications.set(row.application, { ...row }); }

  listApplications(): ApplicationDashboardRow[] { return [...this.db.applications.values()].sort((left, right) => left.application.localeCompare(right.application)).map((row) => ({ ...row })); }

  getApplication(applicationId: string): ApplicationDashboardRow | null { const row = this.db.applications.get(applicationId); return row ? { ...row } : null; }

  listOperations(applicationId: string): OperationRow[] { return [...this.db.operations.values()].filter((operation) => operation.applicationId === applicationId).map((operation) => ({ ...operation })); }

  startOperation(input: StartOperationInput): OperationRow {
    const existing = this.db.idempotency.get(input.idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== input.payloadHash) throw new Error('Idempotency key was reused with a different payload.');
      const operation = this.db.operations.get(existing.operationId);
      if (operation) return operation;
    }
    const id = stableId('operation', input.applicationId, input.workflowId, input.idempotencyKey);
    const operation: OperationRow = { id, workflowId: input.workflowId, applicationId: input.applicationId, action: input.action, status: 'QUEUED', idempotencyKey: input.idempotencyKey, payloadHash: input.payloadHash, startedAt: new Date().toISOString(), completedAt: null, errorCode: null };
    this.db.operations.set(id, operation);
    this.db.idempotency.set(input.idempotencyKey, { payloadHash: input.payloadHash, operationId: id });
    return operation;
  }
  updateOperation(id: string, patch: Partial<Pick<OperationRow, 'status' | 'completedAt' | 'errorCode'>>): OperationRow {
    const operation = this.db.operations.get(id);
    if (!operation) throw new Error(`Unknown operation '${id}'.`);
    Object.assign(operation, patch);
    return operation;
  }

  recordStep(input: RecordStepInput): StepRow {
    const key = `${input.operationId}:${input.stepId}`;
    const row: StepRow = { operationId: input.operationId, stepId: input.stepId, status: input.status, attempt: input.attempt, preconditionHash: input.preconditionHash, result: input.result, error: input.error };
    this.db.steps.set(key, row);
    return row;
  }

  getStep(operationId: string, stepId: string): StepRow | null {
    return this.db.steps.get(`${operationId}:${stepId}`) ?? null;
  }

  savePlan(applicationId: string, plan: PlatformPlan): string {
    const id = stableId('plan', applicationId, plan.fingerprint);
    this.db.plans.set(id, { id, applicationId, fingerprint: plan.fingerprint, plan, createdAt: new Date().toISOString() });
    return id;
  }

  getPlan(id: string): PlatformPlan | null { return this.db.plans.get(id)?.plan ?? null; }

  acquireLock(resourceKey: string, ownerId: string, leaseSeconds: number): boolean {
    const now = Date.now();
    const current = this.db.locks.get(resourceKey);
    if (current && current.expiresAt > now && current.ownerId !== ownerId) return false;
    this.db.locks.set(resourceKey, { resourceKey, ownerId, expiresAt: now + leaseSeconds * 1000 });
    return true;
  }

  renewLock(resourceKey: string, ownerId: string, leaseSeconds: number): boolean {
    const current = this.db.locks.get(resourceKey);
    if (!current || current.ownerId !== ownerId || current.expiresAt <= Date.now()) return false;
    current.expiresAt = Date.now() + leaseSeconds * 1000;
    return true;
  }

  releaseLock(resourceKey: string, ownerId: string): boolean {
    const current = this.db.locks.get(resourceKey);
    if (!current || current.ownerId !== ownerId) return false;
    this.db.locks.delete(resourceKey);
    return true;
  }

  appendAudit(input: { actor: string; action: string; applicationId: string; details: Record<string, unknown> }): AuditRow {
    const row: AuditRow = { id: stableId('audit', input.applicationId, input.action, String(this.db.audits.length)), actor: input.actor, action: input.action, applicationId: input.applicationId, details: structuredClone(input.details), createdAt: new Date().toISOString() };
    this.db.audits.push(row);
    return row;
  }

  listAudit(applicationId: string): AuditRow[] { return this.db.audits.filter((event) => event.applicationId === applicationId).map((event) => structuredClone(event)); }

  createTombstone(input: Omit<TombstoneRow, 'applicationId'> & { applicationId: string }): TombstoneRow {
    const row = { ...input };
    this.db.tombstones.set(input.applicationId, row);
    return row;
  }

  isTombstoned(applicationId: string): boolean { return this.db.tombstones.has(applicationId); }

  /** Upserts one incident per (type, fingerprint); refires reopen the same row. */
  recordIncident(input: Omit<IncidentRow, 'id' | 'firstSeenAt' | 'lastFiredAt' | 'delivery'> & { firedAt?: string; delivery?: Record<string, unknown> }): IncidentRow {
    const firedAt = input.firedAt ?? new Date().toISOString();
    const key = `${input.type}:${input.fingerprint}`;
    const existing = this.db.incidents.get(key);
    const row: IncidentRow = {
      id: existing?.id ?? stableId('incident', input.type, input.fingerprint),
      type: input.type,
      fingerprint: input.fingerprint,
      severity: input.severity,
      applicationId: input.applicationId ?? existing?.applicationId ?? null,
      operationId: input.operationId ?? existing?.operationId ?? null,
      message: input.message,
      details: structuredClone(input.details),
      firstSeenAt: existing?.firstSeenAt ?? firedAt,
      lastFiredAt: firedAt,
      resolvedAt: null,
      delivery: structuredClone(input.delivery ?? {}),
    };
    this.db.incidents.set(key, row);
    return { ...row, details: structuredClone(row.details), delivery: structuredClone(row.delivery) };
  }

  listIncidents(): IncidentRow[] {
    return [...this.db.incidents.values()].sort((left, right) => right.lastFiredAt.localeCompare(left.lastFiredAt)).map((row) => ({ ...row, details: structuredClone(row.details), delivery: structuredClone(row.delivery) }));
  }
}
