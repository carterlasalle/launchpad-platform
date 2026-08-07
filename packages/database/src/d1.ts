import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { sha256Hex, stableId } from '@launchpad/shared';
import type { HealthCheckRecord, LifecycleState, ObservedApplication, PlannedOperation, PlatformError, PlatformPlan, ProviderName } from '@launchpad/core';
import { conflict, invalidArgument, notFound } from './errors.js';
import { serializeJson, validateLockKey, type ApplicationStatusPatch, type ApplicationUpsert, type AuditAppend, type CleanupJobUpsert, type CredentialMetadataUpsert, type DeletionApprovalCreate, type DeploymentUpsert, type DesiredGenerationAdvance, type DriftEventUpsert, type IdempotentRequestRegister, type IncidentUpsert, type LaunchpadStore, type MetricSnapshotUpsert, type ObservationUpsert, type PlanReviewAttestationUpsert, type PlanUpsert, type PromotionUpsert, type ProviderErrorUpsert, type ReconciliationOpen, type ResourceUpsert, type StoreOptions, type TombstoneCreate, type TombstoneRelease, type WebhookReceiptUpsert, type WorkflowRunCancel, type WorkflowRunStart, type WorkflowRunPatch, type WorkflowStepUpsert } from './store.js';
import { TERMINAL_WORKFLOW_STATUSES, type ApplicationDetail, type ApplicationRecord, type AuditRecord, type CleanupJobRecord, type CredentialMetadataRecord, type CredentialStatus, type DashboardApplicationRow, type DeletionApprovalRecord, type DeploymentRow, type DesiredGenerationRecord, type DriftEventRecord, type IdempotentRequestRecord, type IncidentRecord, type LockRecord, type MetricSnapshotRecord, type ObservationRecord, type PlanReviewAttestationRecord, type PromotionRecord, type ProviderErrorRecord, type ReconciliationRequestRecord, type ResourceRecord, type StoredPlanRecord, type TombstoneRecord, type WebhookReceiptRecord, type WorkflowRunRecord, type WorkflowStepRecord, type WorkflowStatus } from './types.js';

/**
 * D1-backed `LaunchpadStore` (master plan section 23). Enforces invariants
 * with schema constraints (unique indexes, partial unique indexes, CHECKs,
 * triggers, foreign keys) plus atomic `ON CONFLICT` upserts and transactional
 * `batch()` where a single statement cannot express the invariant. Production
 * paths use this store; `InMemoryLaunchpadStore` mirrors it for tests.
 */
export class D1LaunchpadStore implements LaunchpadStore {
  readonly db: D1Database;
  private readonly now: () => Date;
  private metricSeq = 0;

  constructor(db: D1Database, options: StoreOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date());
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  // Row loaders ------------------------------------------------------------

  private async loadApplication(applicationId: string): Promise<ApplicationRecord | null> {
    const row = await this.db.prepare('SELECT id, display_name, source_path, desired_generation, desired_hash, sync_status, health_status, lifecycle_state, owners_json, updated_at FROM applications WHERE id = ?').bind(applicationId).first<SqlApplicationRow>();
    return row ? this.toApplication(row) : null;
  }

  private async loadDeployment(deploymentId: string): Promise<DeploymentRow | null> {
    const row = await this.db.prepare('SELECT id, application_id, project_id, environment, repository, commit_sha, desired_generation, state, url, created_at FROM deployments WHERE id = ?').bind(deploymentId).first<SqlDeploymentRow>();
    return row ? this.toDeployment(row) : null;
  }

  private async loadPlan(planId: string): Promise<StoredPlanRecord | null> {
    const row = await this.db.prepare('SELECT id, application_id, fingerprint, source_commit, result, payload_json, created_at FROM plans WHERE id = ?').bind(planId).first<SqlPlanRow>();
    return row ? this.toPlan(row) : null;
  }

  private async loadWorkflowRun(workflowId: string): Promise<WorkflowRunRecord | null> {
    const row = await this.db.prepare('SELECT id, application_id, workflow_type, status, idempotency_key, payload_hash, started_at, completed_at, error_code FROM workflow_runs WHERE id = ?').bind(workflowId).first<SqlWorkflowRunRow>();
    return row ? this.toWorkflowRun(row) : null;
  }

  private async loadReconciliation(id: string): Promise<ReconciliationRequestRecord | null> {
    const row = await this.db.prepare('SELECT id, application_id, fingerprint, mode, pull_request_number, pull_request_url, status, opened_at, resolved_at FROM reconciliation_requests WHERE id = ?').bind(id).first<SqlReconciliationRow>();
    return row ? this.toReconciliation(row) : null;
  }

  private async loadCleanupJob(id: string): Promise<CleanupJobRecord | null> {
    const row = await this.db.prepare('SELECT id, application_id, provider_resource_id, expires_at, status, attempts, last_error FROM cleanup_jobs WHERE id = ?').bind(id).first<SqlCleanupJobRow>();
    return row ? this.toCleanupJob(row) : null;
  }

  private async requireApplication(applicationId: string): Promise<void> {
    const row = await this.db.prepare('SELECT 1 AS present FROM applications WHERE id = ?').bind(applicationId).first<{ present: number }>();
    if (!row) throw notFound('Application', applicationId);
  }

  private async requirePlan(planId: string): Promise<void> {
    const row = await this.db.prepare('SELECT 1 AS present FROM plans WHERE id = ?').bind(planId).first<{ present: number }>();
    if (!row) throw notFound('Plan', planId);
  }

  private async requireWorkflowRun(workflowId: string): Promise<void> {
    const row = await this.db.prepare('SELECT 1 AS present FROM workflow_runs WHERE id = ?').bind(workflowId).first<{ present: number }>();
    if (!row) throw notFound('Workflow run', workflowId);
  }

  // Row mappers ------------------------------------------------------------

  private toApplication(row: SqlApplicationRow): ApplicationRecord {
    return { id: row.id, displayName: row.display_name, sourcePath: row.source_path, desiredGeneration: row.desired_generation, desiredHash: row.desired_hash, syncStatus: row.sync_status, healthStatus: row.health_status, lifecycleState: row.lifecycle_state, owners: JSON.parse(row.owners_json) as string[], updatedAt: row.updated_at };
  }

  private toDesiredGeneration(row: SqlDesiredGenerationRow): DesiredGenerationRecord {
    return { applicationId: row.application_id, generation: row.generation, desiredHash: row.desired_hash, updatedAt: row.updated_at };
  }

  private toResource(row: SqlResourceRow): ResourceRecord {
    return { id: row.id, applicationId: row.application_id, provider: row.provider, resourceType: row.resource_type, resourceKey: row.resource_key, providerResourceId: row.provider_resource_id, desiredGeneration: row.desired_generation, observedHash: row.observed_hash, ownershipFingerprint: row.ownership_fingerprint, status: row.status, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at };
  }

  private toObservation(row: SqlObservationRow): ObservationRecord {
    return { id: row.id, applicationId: row.application_id, observedHash: row.observed_hash, payload: JSON.parse(row.payload_json) as ObservedApplication, observedAt: row.observed_at };
  }

  private toPlan(row: SqlPlanRow): StoredPlanRecord {
    return { id: row.id, applicationId: row.application_id, fingerprint: row.fingerprint, sourceCommit: row.source_commit, result: row.result, plan: JSON.parse(row.payload_json) as PlatformPlan, createdAt: row.created_at };
  }

  private toWorkflowRun(row: SqlWorkflowRunRow): WorkflowRunRecord {
    return { id: row.id, applicationId: row.application_id, workflowType: row.workflow_type, status: row.status, idempotencyKey: row.idempotency_key, payloadHash: row.payload_hash, startedAt: row.started_at, completedAt: row.completed_at, errorCode: row.error_code };
  }

  private toWorkflowStep(row: SqlWorkflowStepRow): WorkflowStepRecord {
    return { workflowId: row.workflow_id, stepId: row.step_id, status: row.status, attempt: row.attempt, preconditionHash: row.precondition_hash, result: row.result_json === null ? null : (JSON.parse(row.result_json) as unknown), error: row.error_json === null ? null : (JSON.parse(row.error_json) as unknown) };
  }

  private toDeployment(row: SqlDeploymentRow): DeploymentRow {
    return { id: row.id, applicationId: row.application_id, projectId: row.project_id, environment: row.environment, repository: row.repository, commitSha: row.commit_sha, desiredGeneration: row.desired_generation, state: row.state, url: row.url, createdAt: row.created_at };
  }

  private toPromotion(row: SqlPromotionRow): PromotionRecord {
    return { id: row.id, applicationId: row.application_id, deploymentId: row.deployment_id, previousDeploymentId: row.previous_deployment_id, result: row.result, promotedAt: row.promoted_at };
  }

  private toHealthCheck(row: SqlHealthCheckRow): HealthCheckRecord {
    return { id: row.id, applicationId: row.application_id, environment: row.environment, deploymentId: row.deployment_id, url: row.url, attempt: row.attempt, dnsResolved: row.dns_resolved === 1, tlsValid: row.tls_valid === 1, statusCode: row.status_code, latencyMs: row.latency_ms, assertionResults: JSON.parse(row.assertion_results_json) as HealthCheckRecord['assertionResults'], result: row.result, checkedAt: row.checked_at, errorCode: row.error_code };
  }

  private toDriftEvent(row: SqlDriftEventRow): DriftEventRecord {
    return { id: row.id, applicationId: row.application_id, fingerprint: row.fingerprint, category: row.category, payload: JSON.parse(row.payload_json) as Record<string, unknown>, observedAt: row.observed_at, resolvedAt: row.resolved_at };
  }

  private toReconciliation(row: SqlReconciliationRow): ReconciliationRequestRecord {
    return { id: row.id, applicationId: row.application_id, fingerprint: row.fingerprint, mode: row.mode, pullRequestNumber: row.pull_request_number, pullRequestUrl: row.pull_request_url, status: row.status, openedAt: row.opened_at, resolvedAt: row.resolved_at };
  }

  private toProviderError(row: SqlProviderErrorRow): ProviderErrorRecord {
    return { id: row.id, applicationId: row.application_id, operationId: row.operation_id, provider: row.provider, code: row.code, class: row.class, message: row.message, retryable: row.retryable === 1, safeDetails: JSON.parse(row.safe_details_json) as Record<string, unknown>, causeFingerprint: row.cause_fingerprint, remediation: row.remediation, createdAt: row.created_at };
  }

  private toIncident(row: SqlIncidentRow): IncidentRecord {
    return { id: row.id, type: row.type, fingerprint: row.fingerprint, severity: row.severity, applicationId: row.application_id, operationId: row.operation_id, message: row.message, details: JSON.parse(row.details_json) as Record<string, unknown>, firstSeenAt: row.first_seen_at, lastFiredAt: row.last_fired_at, resolvedAt: row.resolved_at, delivery: JSON.parse(row.delivery_json) as Record<string, unknown> };
  }

  private toMetricSnapshot(row: SqlMetricSnapshotRow): MetricSnapshotRecord {
    return { id: row.id, metric: row.metric, total: row.total, rate: row.rate, windowSeconds: row.window_seconds, labels: JSON.parse(row.labels_json) as Record<string, string>, capturedAt: row.captured_at };
  }

  private toWebhookReceipt(row: SqlWebhookReceiptRow): WebhookReceiptRecord {
    return { provider: row.provider, eventId: row.event_id, payload: JSON.parse(row.payload_json) as Record<string, unknown>, receivedAt: row.received_at, dispatchedAt: row.dispatched_at };
  }

  private toCleanupJob(row: SqlCleanupJobRow): CleanupJobRecord {
    return { id: row.id, applicationId: row.application_id, providerResourceId: row.provider_resource_id, expiresAt: row.expires_at, status: row.status, attempts: row.attempts, lastError: row.last_error };
  }

  private toTombstone(row: SqlTombstoneRow): TombstoneRecord {
    return { applicationId: row.application_id, domain: row.domain, deletedAt: row.deleted_at, retainUntil: row.retain_until };
  }

  private toAudit(row: SqlAuditRow): AuditRecord {
    return { id: row.id, actor: row.actor, action: row.action, applicationId: row.application_id, details: JSON.parse(row.details_json) as Record<string, unknown>, createdAt: row.created_at };
  }

  private toCredential(row: SqlCredentialRow): CredentialMetadataRecord {
    return { id: row.id, provider: row.provider, purpose: row.purpose, valueFingerprint: row.value_fingerprint, expiresAt: row.expires_at, lastCheckedAt: row.last_checked_at, status: row.status };
  }

  private toLock(row: SqlLockRow): LockRecord {
    return { resourceKey: row.resource_key, ownerId: row.owner_id, acquiredAt: row.acquired_at, expiresAt: row.expires_at };
  }

  private toIdempotentRequest(row: SqlIdempotentRequestRow): IdempotentRequestRecord {
    return { idempotencyKey: row.idempotency_key, operationId: row.operation_id, payloadHash: row.payload_hash, createdAt: row.created_at };
  }

  private toDeletionApproval(row: SqlDeletionApprovalRow): DeletionApprovalRecord {
    return { id: row.id, applicationId: row.application_id, tokenHash: row.token_hash, requestedBy: row.requested_by, status: row.status, expiresAt: row.expires_at, createdAt: row.created_at, usedAt: row.used_at, revokedAt: row.revoked_at };
  }

  // applications -----------------------------------------------------------

  async upsertApplication(input: ApplicationUpsert): Promise<ApplicationRecord> {
    const tombstone = await this.db.prepare('SELECT 1 AS present FROM tombstones WHERE application_id = ?').bind(input.id).first<{ present: number }>();
    if (tombstone) throw conflict('LP-DB-TOMBSTONE-REUSE-BLOCKED', `Application '${input.id}' was deleted and its tombstone blocks reuse`);
    if (input.domain) {
      const domainTombstone = await this.db.prepare('SELECT 1 AS present FROM tombstones WHERE domain = ?').bind(input.domain).first<{ present: number }>();
      if (domainTombstone) throw conflict('LP-DB-TOMBSTONE-REUSE-BLOCKED', `Domain '${input.domain}' belongs to a deleted application and its tombstone blocks reuse`);
    }
    const deleted = await this.db.prepare('SELECT lifecycle_state FROM applications WHERE id = ?').bind(input.id).first<{ lifecycle_state: LifecycleState }>();
    if (deleted?.lifecycle_state === 'deleted') throw conflict('LP-DB-APP-DELETED-IMMUTABLE', `Application '${input.id}' is deleted and cannot be re-created`);
    await this.db.prepare('INSERT INTO applications (id, display_name, source_path, desired_generation, desired_hash, sync_status, health_status, lifecycle_state, owners_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, source_path = excluded.source_path, desired_generation = excluded.desired_generation, desired_hash = excluded.desired_hash, sync_status = excluded.sync_status, health_status = excluded.health_status, lifecycle_state = excluded.lifecycle_state, owners_json = excluded.owners_json, updated_at = excluded.updated_at').bind(input.id, input.displayName, input.sourcePath, input.desiredGeneration, input.desiredHash, input.syncStatus, input.healthStatus, input.lifecycleState, serializeJson(input.owners ?? [], 'application owners'), input.updatedAt ?? this.nowIso()).run();
    const row = await this.loadApplication(input.id);
    if (!row) throw notFound('Application', input.id);
    return row;
  }

  async getApplication(applicationId: string): Promise<ApplicationRecord | null> {
    return this.loadApplication(applicationId);
  }

  async updateApplicationStatus(applicationId: string, patch: ApplicationStatusPatch): Promise<ApplicationRecord> {
    const result = await this.db.prepare('UPDATE applications SET sync_status = COALESCE(?, sync_status), health_status = COALESCE(?, health_status), updated_at = ? WHERE id = ?').bind(patch.syncStatus ?? null, patch.healthStatus ?? null, patch.updatedAt ?? this.nowIso(), applicationId).run();
    if ((result.meta?.changes ?? 0) === 0) throw notFound('Application', applicationId);
    const row = await this.loadApplication(applicationId);
    if (!row) throw notFound('Application', applicationId);
    return row;
  }

  async setLifecycleState(applicationId: string, state: LifecycleState, updatedAt?: string): Promise<ApplicationRecord> {
    const row = await this.loadApplication(applicationId);
    if (!row) throw notFound('Application', applicationId);
    const allowed: readonly LifecycleState[] = ALLOWED_LIFECYCLE_TRANSITIONS[row.lifecycleState];
    if (!allowed.includes(state)) throw conflict('LP-DB-LIFECYCLE-TRANSITION-INVALID', `Cannot move application '${applicationId}' from '${row.lifecycleState}' to '${state}'`, { from: row.lifecycleState, to: state });
    await this.db.prepare('UPDATE applications SET lifecycle_state = ?, updated_at = ? WHERE id = ?').bind(state, updatedAt ?? this.nowIso(), applicationId).run();
    const updated = await this.loadApplication(applicationId);
    if (!updated) throw notFound('Application', applicationId);
    return updated;
  }

  // desired generations ----------------------------------------------------

  async advanceDesiredGeneration(input: DesiredGenerationAdvance): Promise<DesiredGenerationRecord> {
    await this.requireApplication(input.applicationId);
    if (!Number.isInteger(input.generation) || input.generation < 1) throw invalidArgument('LP-DB-GENERATION-INVALID', 'Desired generation must be a positive integer');
    const updatedAt = input.updatedAt ?? this.nowIso();
    const result = await this.db.prepare('INSERT INTO desired_generations (application_id, generation, desired_hash, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(application_id) DO UPDATE SET generation = excluded.generation, desired_hash = excluded.desired_hash, updated_at = excluded.updated_at WHERE excluded.generation > desired_generations.generation').bind(input.applicationId, input.generation, input.desiredHash, updatedAt).run();
    if ((result.meta?.changes ?? 0) === 0) {
      const current = await this.db.prepare('SELECT generation FROM desired_generations WHERE application_id = ?').bind(input.applicationId).first<{ generation: number }>();
      throw conflict('LP-DB-GENERATION-STALE', `Desired generation for '${input.applicationId}' is already at ${current?.generation ?? 0}; refusing to regress to ${input.generation}`, { current: current?.generation ?? 0, attempted: input.generation });
    }
    const row = await this.db.prepare('SELECT application_id, generation, desired_hash, updated_at FROM desired_generations WHERE application_id = ?').bind(input.applicationId).first<SqlDesiredGenerationRow>();
    if (!row) throw notFound('Desired generation', input.applicationId);
    return this.toDesiredGeneration(row);
  }

  async getDesiredGeneration(applicationId: string): Promise<DesiredGenerationRecord | null> {
    const row = await this.db.prepare('SELECT application_id, generation, desired_hash, updated_at FROM desired_generations WHERE application_id = ?').bind(applicationId).first<SqlDesiredGenerationRow>();
    return row ? this.toDesiredGeneration(row) : null;
  }

  // resources --------------------------------------------------------------

  async upsertResource(input: ResourceUpsert): Promise<ResourceRecord> {
    await this.requireApplication(input.applicationId);
    await this.db.prepare('INSERT INTO resources (id, application_id, provider, resource_type, resource_key, provider_resource_id, desired_generation, observed_hash, ownership_fingerprint, status, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider, provider_resource_id) DO UPDATE SET application_id = excluded.application_id, resource_type = excluded.resource_type, resource_key = excluded.resource_key, desired_generation = excluded.desired_generation, observed_hash = excluded.observed_hash, ownership_fingerprint = excluded.ownership_fingerprint, status = excluded.status, last_seen_at = excluded.last_seen_at').bind(input.id ?? stableId('resource', input.provider, input.providerResourceId), input.applicationId, input.provider, input.resourceType, input.resourceKey, input.providerResourceId, input.desiredGeneration, input.observedHash, input.ownershipFingerprint ?? null, input.status ?? 'ACTIVE', input.firstSeenAt ?? this.nowIso(), input.lastSeenAt ?? this.nowIso()).run();
    const row = await this.db.prepare('SELECT id, application_id, provider, resource_type, resource_key, provider_resource_id, desired_generation, observed_hash, ownership_fingerprint, status, first_seen_at, last_seen_at FROM resources WHERE provider = ? AND provider_resource_id = ?').bind(input.provider, input.providerResourceId).first<SqlResourceRow>();
    if (!row) throw notFound('Resource', `${input.provider}:${input.providerResourceId}`);
    return this.toResource(row);
  }

  async releaseResource(provider: ProviderName, providerResourceId: string, releasedAt?: string): Promise<ResourceRecord | null> {
    const releasedAtValue = releasedAt ?? this.nowIso();
    const result = await this.db.prepare('UPDATE resources SET status = \'RELEASED\', last_seen_at = ? WHERE provider = ? AND provider_resource_id = ? AND status = \'ACTIVE\'').bind(releasedAtValue, provider, providerResourceId).run();
    if ((result.meta?.changes ?? 0) === 1) {
      const row = await this.db.prepare('SELECT id, application_id, provider, resource_type, resource_key, provider_resource_id, desired_generation, observed_hash, ownership_fingerprint, status, first_seen_at, last_seen_at FROM resources WHERE provider = ? AND provider_resource_id = ?').bind(provider, providerResourceId).first<SqlResourceRow>();
      return row ? this.toResource(row) : null;
    }
    const existing = await this.db.prepare('SELECT id, application_id, provider, resource_type, resource_key, provider_resource_id, desired_generation, observed_hash, ownership_fingerprint, status, first_seen_at, last_seen_at FROM resources WHERE provider = ? AND provider_resource_id = ?').bind(provider, providerResourceId).first<SqlResourceRow>();
    return existing ? this.toResource(existing) : null;
  }

  async getResource(provider: ProviderName, providerResourceId: string): Promise<ResourceRecord | null> {
    const row = await this.db.prepare('SELECT id, application_id, provider, resource_type, resource_key, provider_resource_id, desired_generation, observed_hash, ownership_fingerprint, status, first_seen_at, last_seen_at FROM resources WHERE provider = ? AND provider_resource_id = ?').bind(provider, providerResourceId).first<SqlResourceRow>();
    return row ? this.toResource(row) : null;
  }

  async listResources(applicationId: string, options: { includeReleased?: boolean } = {}): Promise<ResourceRecord[]> {
    const result = await this.db.prepare(options.includeReleased === true ? 'SELECT id, application_id, provider, resource_type, resource_key, provider_resource_id, desired_generation, observed_hash, ownership_fingerprint, status, first_seen_at, last_seen_at FROM resources WHERE application_id = ? ORDER BY resource_key ASC' : 'SELECT id, application_id, provider, resource_type, resource_key, provider_resource_id, desired_generation, observed_hash, ownership_fingerprint, status, first_seen_at, last_seen_at FROM resources WHERE application_id = ? AND status = \'ACTIVE\' ORDER BY resource_key ASC').bind(applicationId).all<SqlResourceRow>();
    return result.results.map((row) => this.toResource(row));
  }

  // observations -----------------------------------------------------------

  async recordObservation(input: ObservationUpsert): Promise<ObservationRecord> {
    await this.requireApplication(input.applicationId);
    const observedAt = input.observedAt ?? this.nowIso();
    const id = input.id ?? stableId('observation', input.applicationId, input.observedHash, observedAt);
    await this.db.prepare('INSERT INTO observations (id, application_id, observed_hash, payload_json, observed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET application_id = excluded.application_id, observed_hash = excluded.observed_hash, payload_json = excluded.payload_json, observed_at = excluded.observed_at').bind(id, input.applicationId, input.observedHash, serializeJson(input.payload, 'observation'), observedAt).run();
    const row = await this.db.prepare('SELECT id, application_id, observed_hash, payload_json, observed_at FROM observations WHERE id = ?').bind(id).first<SqlObservationRow>();
    if (!row) throw notFound('Observation', id);
    return this.toObservation(row);
  }

  async getObservation(id: string): Promise<ObservationRecord | null> {
    const row = await this.db.prepare('SELECT id, application_id, observed_hash, payload_json, observed_at FROM observations WHERE id = ?').bind(id).first<SqlObservationRow>();
    return row ? this.toObservation(row) : null;
  }

  async listObservations(applicationId: string, options: { limit?: number } = {}): Promise<ObservationRecord[]> {
    const result = await this.db.prepare('SELECT id, application_id, observed_hash, payload_json, observed_at FROM observations WHERE application_id = ? ORDER BY observed_at DESC, id DESC LIMIT ?').bind(applicationId, options.limit ?? -1).all<SqlObservationRow>();
    return result.results.map((row) => this.toObservation(row));
  }

  // plans ------------------------------------------------------------------

  async savePlan(input: PlanUpsert): Promise<StoredPlanRecord> {
    await this.requireApplication(input.applicationId);
    const serialized = serializeJson(input.plan, 'plan');
    const existingRow = await this.db.prepare('SELECT id, payload_json FROM plans WHERE application_id = ? AND fingerprint = ?').bind(input.applicationId, input.plan.fingerprint).first<{ id: string; payload_json: string }>();
    if (existingRow) {
      if (existingRow.payload_json === serialized) {
        const existing = await this.loadPlan(existingRow.id);
        if (existing) return existing;
      }
      throw conflict('LP-DB-PLAN-FINGERPRINT-CONFLICT', `A different plan with fingerprint '${input.plan.fingerprint}' is already stored for '${input.applicationId}'`, { applicationId: input.applicationId, fingerprint: input.plan.fingerprint });
    }
    const id = input.id ?? stableId('plan', input.applicationId, input.plan.fingerprint);
    try {
      await this.db.prepare('INSERT INTO plans (id, application_id, fingerprint, source_commit, result, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, input.applicationId, input.plan.fingerprint, input.plan.sourceCommit, input.plan.result, serialized, input.createdAt ?? this.nowIso()).run();
    } catch {
      const raced = await this.db.prepare('SELECT id, payload_json FROM plans WHERE application_id = ? AND fingerprint = ?').bind(input.applicationId, input.plan.fingerprint).first<{ id: string; payload_json: string }>();
      if (raced) {
        if (raced.payload_json === serialized) {
          const existing = await this.loadPlan(raced.id);
          if (existing) return existing;
        }
        throw conflict('LP-DB-PLAN-FINGERPRINT-CONFLICT', `A different plan with fingerprint '${input.plan.fingerprint}' is already stored for '${input.applicationId}'`, { applicationId: input.applicationId, fingerprint: input.plan.fingerprint });
      }
      throw conflict('LP-DB-PLAN-FINGERPRINT-CONFLICT', `A different plan with fingerprint '${input.plan.fingerprint}' is already stored for '${input.applicationId}'`, { applicationId: input.applicationId, fingerprint: input.plan.fingerprint });
    }
    const row = await this.loadPlan(id);
    if (!row) throw notFound('Plan', id);
    return row;
  }

  async getPlan(id: string): Promise<StoredPlanRecord | null> {
    return this.loadPlan(id);
  }

  async getPlanByFingerprint(applicationId: string, fingerprint: string): Promise<StoredPlanRecord | null> {
    const row = await this.db.prepare('SELECT id, application_id, fingerprint, source_commit, result, payload_json, created_at FROM plans WHERE application_id = ? AND fingerprint = ?').bind(applicationId, fingerprint).first<SqlPlanRow>();
    return row ? this.toPlan(row) : null;
  }

  async listPlans(applicationId: string, options: { limit?: number } = {}): Promise<StoredPlanRecord[]> {
    const result = await this.db.prepare('SELECT id, application_id, fingerprint, source_commit, result, payload_json, created_at FROM plans WHERE application_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').bind(applicationId, options.limit ?? -1).all<SqlPlanRow>();
    return result.results.map((row) => this.toPlan(row));
  }

  async replacePlanOperations(planId: string, operations: PlannedOperation[]): Promise<void> {
    await this.requirePlan(planId);
    const statements: D1PreparedStatement[] = [this.db.prepare('DELETE FROM plan_operations WHERE plan_id = ?').bind(planId)];
    for (const operation of operations) {
      statements.push(this.db.prepare('INSERT INTO plan_operations (id, plan_id, resource_key, action, destructive, payload_json) VALUES (?, ?, ?, ?, ?, ?)').bind(operation.id, planId, operation.resourceKey, operation.action, operation.destructive ? 1 : 0, serializeJson(operation, 'plan operation')));
    }
    await this.db.batch(statements);
  }

  async listPlanOperations(planId: string): Promise<PlannedOperation[]> {
    const result = await this.db.prepare('SELECT payload_json FROM plan_operations WHERE plan_id = ? ORDER BY rowid ASC').bind(planId).all<{ payload_json: string }>();
    return result.results.map((row) => JSON.parse(row.payload_json) as PlannedOperation);
  }

  // workflow runs / steps --------------------------------------------------

  async startWorkflowRun(input: WorkflowRunStart): Promise<WorkflowRunRecord> {
    const existing = await this.db.prepare('SELECT id, application_id, workflow_type, status, idempotency_key, payload_hash, started_at, completed_at, error_code FROM workflow_runs WHERE idempotency_key = ?').bind(input.idempotencyKey).first<SqlWorkflowRunRow>();
    if (existing) {
      if (existing.payload_hash !== input.payloadHash) throw conflict('LP-DB-IDEMPOTENCY-REUSED', `Idempotency key '${input.idempotencyKey}' was already used with a different payload`, { idempotencyKey: input.idempotencyKey });
      return this.toWorkflowRun(existing);
    }
    await this.requireApplication(input.applicationId);
    const id = input.id ?? stableId('workflow-run', input.applicationId, input.idempotencyKey);
    try {
      await this.db.prepare('INSERT INTO workflow_runs (id, application_id, workflow_type, status, idempotency_key, payload_hash, started_at, completed_at, error_code) VALUES (?, ?, ?, \'QUEUED\', ?, ?, ?, NULL, NULL)').bind(id, input.applicationId, input.workflowType, input.idempotencyKey, input.payloadHash, input.startedAt ?? this.nowIso()).run();
    } catch {
      const raced = await this.db.prepare('SELECT id, application_id, workflow_type, status, idempotency_key, payload_hash, started_at, completed_at, error_code FROM workflow_runs WHERE idempotency_key = ?').bind(input.idempotencyKey).first<SqlWorkflowRunRow>();
      if (raced) {
        if (raced.payload_hash !== input.payloadHash) throw conflict('LP-DB-IDEMPOTENCY-REUSED', `Idempotency key '${input.idempotencyKey}' was already used with a different payload`, { idempotencyKey: input.idempotencyKey });
        return this.toWorkflowRun(raced);
      }
      throw conflict('LP-DB-WORKFLOW-RUN-CONFLICT', `Failed to start workflow run for idempotency key '${input.idempotencyKey}'`, { idempotencyKey: input.idempotencyKey });
    }
    const row = await this.loadWorkflowRun(id);
    if (!row) throw notFound('Workflow run', id);
    return row;
  }

  async updateWorkflowRun(id: string, patch: WorkflowRunPatch): Promise<WorkflowRunRecord> {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.status !== undefined) {
      sets.push('status = ?');
      values.push(patch.status);
    }
    if (patch.completedAt !== undefined) {
      sets.push('completed_at = ?');
      values.push(patch.completedAt);
    }
    if (patch.errorCode !== undefined) {
      sets.push('error_code = ?');
      values.push(patch.errorCode);
    }
    if (sets.length > 0) {
      values.push(id);
      const result = await this.db.prepare(`UPDATE workflow_runs SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
      if ((result.meta?.changes ?? 0) === 0) {
        const exists = await this.db.prepare('SELECT 1 AS present FROM workflow_runs WHERE id = ?').bind(id).first<{ present: number }>();
        if (!exists) throw notFound('Workflow run', id);
      }
    }
    const row = await this.loadWorkflowRun(id);
    if (!row) throw notFound('Workflow run', id);
    return row;
  }

  async cancelWorkflowRun(input: WorkflowRunCancel): Promise<WorkflowRunRecord> {
    const row = await this.loadWorkflowRun(input.id);
    if (!row) throw notFound('Workflow run', input.id);
    if (row.status !== 'QUEUED') throw conflict('LP-DB-CANCEL-NOT-QUEUED', `Workflow run '${input.id}' is '${row.status}'; only QUEUED runs can be canceled`, { id: input.id, status: row.status });
    const canceledAt = input.canceledAt ?? this.nowIso();
    const auditId = input.auditId ?? stableId('audit', input.actor, 'OPERATOR_CANCEL', row.applicationId, input.idempotencyKey);
    // The status flip and the immutable audit append are one transaction:
    // the audit INSERT is guarded by the same transaction observing the run
    // as CANCELED, so a run that raced past QUEUED is never marked canceled
    // and never records a cancel audit event.
    const results = await this.db.batch([
      this.db.prepare('UPDATE workflow_runs SET status = \'CANCELED\', completed_at = ?, error_code = NULL WHERE id = ? AND status = \'QUEUED\'').bind(canceledAt, input.id),
      this.db.prepare('INSERT INTO audit_events (id, actor, action, application_id, details_json, created_at) SELECT ?, ?, \'OPERATOR_CANCEL\', ?, ?, ? WHERE EXISTS (SELECT 1 FROM workflow_runs WHERE id = ? AND status = \'CANCELED\')').bind(auditId, input.actor, row.applicationId, serializeJson({ operationId: row.id, idempotencyKey: input.idempotencyKey, status: 'CANCELED' }, 'audit details'), canceledAt, input.id),
    ]);
    if ((results[0]?.meta?.changes ?? 0) === 0) {
      // The run left QUEUED between the guard read and the guarded update.
      const raced = await this.loadWorkflowRun(input.id);
      if (!raced) throw notFound('Workflow run', input.id);
      throw conflict('LP-DB-CANCEL-NOT-QUEUED', `Workflow run '${input.id}' is '${raced.status}'; only QUEUED runs can be canceled`, { id: input.id, status: raced.status });
    }
    const canceled = await this.loadWorkflowRun(input.id);
    if (!canceled) throw notFound('Workflow run', input.id);
    return canceled;
  }

  async getWorkflowRun(id: string): Promise<WorkflowRunRecord | null> {
    return this.loadWorkflowRun(id);
  }

  async listWorkflowRuns(applicationId: string, options: { limit?: number } = {}): Promise<WorkflowRunRecord[]> {
    const result = await this.db.prepare('SELECT id, application_id, workflow_type, status, idempotency_key, payload_hash, started_at, completed_at, error_code FROM workflow_runs WHERE application_id = ? ORDER BY started_at DESC, id DESC LIMIT ?').bind(applicationId, options.limit ?? -1).all<SqlWorkflowRunRow>();
    return result.results.map((row) => this.toWorkflowRun(row));
  }

  async listOpenWorkflowRuns(applicationId: string): Promise<WorkflowRunRecord[]> {
    const placeholders = TERMINAL_WORKFLOW_STATUSES.map(() => '?').join(', ');
    const result = await this.db.prepare(`SELECT id, application_id, workflow_type, status, idempotency_key, payload_hash, started_at, completed_at, error_code FROM workflow_runs WHERE application_id = ? AND status NOT IN (${placeholders}) ORDER BY started_at ASC`).bind(applicationId, ...TERMINAL_WORKFLOW_STATUSES).all<SqlWorkflowRunRow>();
    return result.results.map((row) => this.toWorkflowRun(row));
  }

  async recordWorkflowStep(input: WorkflowStepUpsert): Promise<WorkflowStepRecord> {
    await this.requireWorkflowRun(input.workflowId);
    await this.db.prepare('INSERT INTO workflow_steps (workflow_id, step_id, status, attempt, precondition_hash, result_json, error_json) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workflow_id, step_id) DO UPDATE SET status = excluded.status, attempt = excluded.attempt, precondition_hash = excluded.precondition_hash, result_json = excluded.result_json, error_json = excluded.error_json').bind(input.workflowId, input.stepId, input.status, input.attempt, input.preconditionHash, input.result === undefined ? null : serializeJson(input.result, 'workflow step result'), input.error === undefined ? null : serializeJson(input.error, 'workflow step error')).run();
    const row = await this.db.prepare('SELECT workflow_id, step_id, status, attempt, precondition_hash, result_json, error_json FROM workflow_steps WHERE workflow_id = ? AND step_id = ?').bind(input.workflowId, input.stepId).first<SqlWorkflowStepRow>();
    if (!row) throw notFound('Workflow step', `${input.workflowId}:${input.stepId}`);
    return this.toWorkflowStep(row);
  }

  async getWorkflowStep(workflowId: string, stepId: string): Promise<WorkflowStepRecord | null> {
    const row = await this.db.prepare('SELECT workflow_id, step_id, status, attempt, precondition_hash, result_json, error_json FROM workflow_steps WHERE workflow_id = ? AND step_id = ?').bind(workflowId, stepId).first<SqlWorkflowStepRow>();
    return row ? this.toWorkflowStep(row) : null;
  }

  async listWorkflowSteps(workflowId: string): Promise<WorkflowStepRecord[]> {
    const result = await this.db.prepare('SELECT workflow_id, step_id, status, attempt, precondition_hash, result_json, error_json FROM workflow_steps WHERE workflow_id = ? ORDER BY step_id ASC').bind(workflowId).all<SqlWorkflowStepRow>();
    return result.results.map((row) => this.toWorkflowStep(row));
  }

  // deployments / promotions / known-good ----------------------------------

  async recordDeployment(input: DeploymentUpsert): Promise<DeploymentRow> {
    await this.requireApplication(input.applicationId);
    await this.db.prepare('INSERT INTO deployments (id, application_id, project_id, environment, repository, commit_sha, desired_generation, state, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET application_id = excluded.application_id, project_id = excluded.project_id, environment = excluded.environment, repository = excluded.repository, commit_sha = excluded.commit_sha, desired_generation = excluded.desired_generation, state = excluded.state, url = excluded.url, created_at = excluded.created_at').bind(input.id, input.applicationId, input.projectId, input.environment, input.repository, input.commitSha, input.desiredGeneration, input.state, input.url ?? null, input.createdAt ?? this.nowIso()).run();
    const row = await this.loadDeployment(input.id);
    if (!row) throw notFound('Deployment', input.id);
    return row;
  }

  async getDeployment(id: string): Promise<DeploymentRow | null> {
    return this.loadDeployment(id);
  }

  async listDeployments(applicationId: string, options: { environment?: DeploymentRow['environment']; limit?: number } = {}): Promise<DeploymentRow[]> {
    const result = await this.db.prepare('SELECT id, application_id, project_id, environment, repository, commit_sha, desired_generation, state, url, created_at FROM deployments WHERE application_id = ? AND (? IS NULL OR environment = ?) ORDER BY created_at DESC, id DESC LIMIT ?').bind(applicationId, options.environment ?? null, options.environment ?? null, options.limit ?? -1).all<SqlDeploymentRow>();
    return result.results.map((row) => this.toDeployment(row));
  }

  async recordKnownGoodDeployment(applicationId: string, environment: DeploymentRow['environment'], deploymentId: string, recordedAt?: string): Promise<DeploymentRow> {
    const existing = await this.db.prepare('SELECT id, application_id, environment FROM deployments WHERE id = ?').bind(deploymentId).first<{ id: string; application_id: string; environment: string }>();
    if (!existing || existing.application_id !== applicationId || existing.environment !== environment) throw notFound('Deployment', deploymentId);
    const recordedAtValue = recordedAt ?? this.nowIso();
    await this.db.batch([
      this.db.prepare('UPDATE deployments SET state = \'SUPERSEDED\' WHERE application_id = ? AND environment = ? AND state = \'CURRENT\' AND id != ?').bind(applicationId, environment, deploymentId),
      this.db.prepare('UPDATE deployments SET state = \'CURRENT\', created_at = ? WHERE id = ?').bind(recordedAtValue, deploymentId),
    ]);
    const row = await this.loadDeployment(deploymentId);
    if (!row) throw notFound('Deployment', deploymentId);
    return row;
  }

  async getKnownGoodDeployment(applicationId: string, environment: DeploymentRow['environment']): Promise<DeploymentRow | null> {
    const row = await this.db.prepare('SELECT id, application_id, project_id, environment, repository, commit_sha, desired_generation, state, url, created_at FROM deployments WHERE application_id = ? AND environment = ? AND state = \'CURRENT\' ORDER BY created_at DESC, id DESC LIMIT 1').bind(applicationId, environment).first<SqlDeploymentRow>();
    return row ? this.toDeployment(row) : null;
  }

  async recordPromotion(input: PromotionUpsert): Promise<PromotionRecord> {
    await this.requireApplication(input.applicationId);
    const exists = await this.db.prepare('SELECT 1 AS present FROM deployments WHERE id = ?').bind(input.deploymentId).first<{ present: number }>();
    if (!exists) throw notFound('Deployment', input.deploymentId);
    const promotedAt = input.promotedAt ?? this.nowIso();
    const id = input.id ?? stableId('promotion', input.applicationId, input.deploymentId, promotedAt);
    await this.db.prepare('INSERT INTO deployment_promotions (id, application_id, deployment_id, previous_deployment_id, result, promoted_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET application_id = excluded.application_id, deployment_id = excluded.deployment_id, previous_deployment_id = excluded.previous_deployment_id, result = excluded.result, promoted_at = excluded.promoted_at').bind(id, input.applicationId, input.deploymentId, input.previousDeploymentId ?? null, input.result, promotedAt).run();
    const row = await this.db.prepare('SELECT id, application_id, deployment_id, previous_deployment_id, result, promoted_at FROM deployment_promotions WHERE id = ?').bind(id).first<SqlPromotionRow>();
    if (!row) throw notFound('Promotion', id);
    return this.toPromotion(row);
  }

  async listPromotions(applicationId: string, options: { limit?: number } = {}): Promise<PromotionRecord[]> {
    const result = await this.db.prepare('SELECT id, application_id, deployment_id, previous_deployment_id, result, promoted_at FROM deployment_promotions WHERE application_id = ? ORDER BY promoted_at DESC, id DESC LIMIT ?').bind(applicationId, options.limit ?? -1).all<SqlPromotionRow>();
    return result.results.map((row) => this.toPromotion(row));
  }

  // health checks ----------------------------------------------------------

  async recordHealthCheck(check: HealthCheckRecord): Promise<HealthCheckRecord> {
    await this.requireApplication(check.applicationId);
    await this.db.prepare('INSERT INTO health_checks (id, application_id, environment, deployment_id, url, attempt, dns_resolved, tls_valid, status_code, latency_ms, assertion_results_json, result, checked_at, error_code, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET application_id = excluded.application_id, environment = excluded.environment, deployment_id = excluded.deployment_id, url = excluded.url, attempt = excluded.attempt, dns_resolved = excluded.dns_resolved, tls_valid = excluded.tls_valid, status_code = excluded.status_code, latency_ms = excluded.latency_ms, assertion_results_json = excluded.assertion_results_json, result = excluded.result, checked_at = excluded.checked_at, error_code = excluded.error_code, payload_json = excluded.payload_json').bind(check.id, check.applicationId, check.environment, check.deploymentId, check.url, check.attempt, check.dnsResolved ? 1 : 0, check.tlsValid ? 1 : 0, check.statusCode, check.latencyMs, serializeJson(check.assertionResults, 'health assertion results'), check.result, check.checkedAt, check.errorCode, serializeJson(check, 'health check')).run();
    const row = await this.db.prepare('SELECT id, application_id, environment, deployment_id, url, attempt, dns_resolved, tls_valid, status_code, latency_ms, assertion_results_json, result, checked_at, error_code FROM health_checks WHERE id = ?').bind(check.id).first<SqlHealthCheckRow>();
    if (!row) throw notFound('Health check', check.id);
    return this.toHealthCheck(row);
  }

  async getHealthCheck(id: string): Promise<HealthCheckRecord | null> {
    const row = await this.db.prepare('SELECT id, application_id, environment, deployment_id, url, attempt, dns_resolved, tls_valid, status_code, latency_ms, assertion_results_json, result, checked_at, error_code FROM health_checks WHERE id = ?').bind(id).first<SqlHealthCheckRow>();
    return row ? this.toHealthCheck(row) : null;
  }

  async listHealthChecks(applicationId: string, options: { environment?: DeploymentRow['environment']; limit?: number } = {}): Promise<HealthCheckRecord[]> {
    const result = await this.db.prepare('SELECT id, application_id, environment, deployment_id, url, attempt, dns_resolved, tls_valid, status_code, latency_ms, assertion_results_json, result, checked_at, error_code FROM health_checks WHERE application_id = ? AND (? IS NULL OR environment = ?) ORDER BY checked_at DESC, id DESC LIMIT ?').bind(applicationId, options.environment ?? null, options.environment ?? null, options.limit ?? -1).all<SqlHealthCheckRow>();
    return result.results.map((row) => this.toHealthCheck(row));
  }

  async listHealthChecksForDeployment(deploymentId: string): Promise<HealthCheckRecord[]> {
    const result = await this.db.prepare('SELECT id, application_id, environment, deployment_id, url, attempt, dns_resolved, tls_valid, status_code, latency_ms, assertion_results_json, result, checked_at, error_code FROM health_checks WHERE deployment_id = ? ORDER BY checked_at ASC').bind(deploymentId).all<SqlHealthCheckRow>();
    return result.results.map((row) => this.toHealthCheck(row));
  }

  // drift / reconciliation -------------------------------------------------

  async recordDriftEvent(input: DriftEventUpsert): Promise<DriftEventRecord> {
    await this.requireApplication(input.applicationId);
    const observedAt = input.observedAt ?? this.nowIso();
    const id = input.id ?? stableId('drift-event', input.applicationId, input.fingerprint, observedAt);
    await this.db.prepare('INSERT INTO drift_events (id, application_id, fingerprint, category, payload_json, observed_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET application_id = excluded.application_id, fingerprint = excluded.fingerprint, category = excluded.category, payload_json = excluded.payload_json, observed_at = excluded.observed_at').bind(id, input.applicationId, input.fingerprint, input.category, serializeJson(input.payload, 'drift event'), observedAt).run();
    const row = await this.db.prepare('SELECT id, application_id, fingerprint, category, payload_json, observed_at, resolved_at FROM drift_events WHERE id = ?').bind(id).first<SqlDriftEventRow>();
    if (!row) throw notFound('Drift event', id);
    return this.toDriftEvent(row);
  }

  async resolveDriftEvent(id: string, resolvedAt?: string): Promise<DriftEventRecord> {
    const resolvedAtValue = resolvedAt ?? this.nowIso();
    await this.db.prepare('UPDATE drift_events SET resolved_at = COALESCE(resolved_at, ?) WHERE id = ?').bind(resolvedAtValue, id).run();
    const row = await this.db.prepare('SELECT id, application_id, fingerprint, category, payload_json, observed_at, resolved_at FROM drift_events WHERE id = ?').bind(id).first<SqlDriftEventRow>();
    if (!row) throw notFound('Drift event', id);
    return this.toDriftEvent(row);
  }

  async listDriftEvents(applicationId: string, options: { includeResolved?: boolean; limit?: number } = {}): Promise<DriftEventRecord[]> {
    const result = await this.db.prepare('SELECT id, application_id, fingerprint, category, payload_json, observed_at, resolved_at FROM drift_events WHERE application_id = ? AND (? = 1 OR resolved_at IS NULL) ORDER BY observed_at DESC, id DESC LIMIT ?').bind(applicationId, options.includeResolved === true ? 1 : 0, options.limit ?? -1).all<SqlDriftEventRow>();
    return result.results.map((row) => this.toDriftEvent(row));
  }

  async openReconciliationRequest(input: ReconciliationOpen): Promise<ReconciliationRequestRecord> {
    await this.requireApplication(input.applicationId);
    const existing = await this.db.prepare('SELECT id, application_id, fingerprint, mode, pull_request_number, pull_request_url, status, opened_at, resolved_at FROM reconciliation_requests WHERE application_id = ? AND fingerprint = ?').bind(input.applicationId, input.fingerprint).first<SqlReconciliationRow>();
    if (existing) {
      if (existing.status === 'OPEN') return this.toReconciliation(existing);
      await this.db.prepare('UPDATE reconciliation_requests SET status = \'OPEN\', resolved_at = NULL, mode = ?, pull_request_number = COALESCE(?, pull_request_number), pull_request_url = COALESCE(?, pull_request_url) WHERE id = ?').bind(input.mode, input.pullRequestNumber ?? null, input.pullRequestUrl ?? null, existing.id).run();
      const reopened = await this.loadReconciliation(existing.id);
      if (!reopened) throw notFound('Reconciliation request', existing.id);
      return reopened;
    }
    const id = input.id ?? stableId('reconciliation', input.applicationId, input.fingerprint);
    try {
      await this.db.prepare('INSERT INTO reconciliation_requests (id, application_id, fingerprint, mode, pull_request_number, pull_request_url, status, opened_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, \'OPEN\', ?, NULL)').bind(id, input.applicationId, input.fingerprint, input.mode, input.pullRequestNumber ?? null, input.pullRequestUrl ?? null, input.openedAt ?? this.nowIso()).run();
    } catch {
      const raced = await this.loadReconciliation(id);
      if (!raced) throw conflict('LP-DB-RECONCILIATION-CONFLICT', `Failed to open reconciliation request for fingerprint '${input.fingerprint}'`, { applicationId: input.applicationId, fingerprint: input.fingerprint });
      if (raced.status === 'OPEN') return raced;
      await this.db.prepare('UPDATE reconciliation_requests SET status = \'OPEN\', resolved_at = NULL, mode = ?, pull_request_number = COALESCE(?, pull_request_number), pull_request_url = COALESCE(?, pull_request_url) WHERE id = ?').bind(input.mode, input.pullRequestNumber ?? null, input.pullRequestUrl ?? null, raced.id).run();
      const reopened = await this.loadReconciliation(raced.id);
      if (!reopened) throw notFound('Reconciliation request', raced.id);
      return reopened;
    }
    const row = await this.loadReconciliation(id);
    if (!row) throw notFound('Reconciliation request', id);
    return row;
  }

  async resolveReconciliationRequest(id: string, status: 'RESOLVED' | 'SUPERSEDED', resolvedAt?: string): Promise<ReconciliationRequestRecord> {
    const existing = await this.loadReconciliation(id);
    if (!existing) throw notFound('Reconciliation request', id);
    if (existing.status !== 'OPEN') return existing;
    await this.db.prepare('UPDATE reconciliation_requests SET status = ?, resolved_at = ? WHERE id = ? AND status = \'OPEN\'').bind(status, resolvedAt ?? this.nowIso(), id).run();
    const row = await this.loadReconciliation(id);
    if (!row) throw notFound('Reconciliation request', id);
    return row;
  }

  async getOpenReconciliationRequest(applicationId: string, fingerprint: string): Promise<ReconciliationRequestRecord | null> {
    const row = await this.db.prepare('SELECT id, application_id, fingerprint, mode, pull_request_number, pull_request_url, status, opened_at, resolved_at FROM reconciliation_requests WHERE application_id = ? AND fingerprint = ? AND status = \'OPEN\'').bind(applicationId, fingerprint).first<SqlReconciliationRow>();
    return row ? this.toReconciliation(row) : null;
  }

  async listReconciliationRequests(applicationId: string): Promise<ReconciliationRequestRecord[]> {
    const result = await this.db.prepare('SELECT id, application_id, fingerprint, mode, pull_request_number, pull_request_url, status, opened_at, resolved_at FROM reconciliation_requests WHERE application_id = ? ORDER BY opened_at DESC, id ASC').bind(applicationId).all<SqlReconciliationRow>();
    return result.results.map((row) => this.toReconciliation(row));
  }

  // provider errors --------------------------------------------------------

  async recordProviderError(input: ProviderErrorUpsert): Promise<ProviderErrorRecord> {
    if (input.applicationId !== undefined && input.applicationId !== null) await this.requireApplication(input.applicationId);
    const createdAt = input.createdAt ?? this.nowIso();
    const safeDetailsJson = serializeJson(input.safeDetails ?? {}, 'provider error details');
    const id = input.id ?? stableId('provider-error', input.code, input.message, input.causeFingerprint ?? '', safeDetailsJson, createdAt);
    await this.db.prepare('INSERT INTO provider_errors (id, application_id, operation_id, provider, code, class, message, retryable, safe_details_json, cause_fingerprint, remediation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET application_id = excluded.application_id, operation_id = excluded.operation_id, provider = excluded.provider, code = excluded.code, class = excluded.class, message = excluded.message, retryable = excluded.retryable, safe_details_json = excluded.safe_details_json, cause_fingerprint = excluded.cause_fingerprint, remediation = excluded.remediation, created_at = excluded.created_at').bind(id, input.applicationId ?? null, input.operationId ?? null, input.provider ?? null, input.code, input.class, input.message, input.retryable ? 1 : 0, safeDetailsJson, input.causeFingerprint ?? '', input.remediation ?? '', createdAt).run();
    const row = await this.db.prepare('SELECT id, application_id, operation_id, provider, code, class, message, retryable, safe_details_json, cause_fingerprint, remediation, created_at FROM provider_errors WHERE id = ?').bind(id).first<SqlProviderErrorRow>();
    if (!row) throw notFound('Provider error', id);
    return this.toProviderError(row);
  }

  async recordPlatformError(applicationId: string | null, error: PlatformError): Promise<ProviderErrorRecord> {
    return this.recordProviderError({ applicationId, operationId: error.operationId, provider: error.provider, code: error.code, class: error.class, message: error.message, retryable: error.retryable, safeDetails: error.safeDetails, causeFingerprint: error.causeFingerprint, remediation: error.remediation });
  }

  async listProviderErrors(applicationId: string, options: { limit?: number } = {}): Promise<ProviderErrorRecord[]> {
    const result = await this.db.prepare('SELECT id, application_id, operation_id, provider, code, class, message, retryable, safe_details_json, cause_fingerprint, remediation, created_at FROM provider_errors WHERE application_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').bind(applicationId, options.limit ?? -1).all<SqlProviderErrorRow>();
    return result.results.map((row) => this.toProviderError(row));
  }

  async listProviderErrorsForOperation(operationId: string): Promise<ProviderErrorRecord[]> {
    const result = await this.db.prepare('SELECT id, application_id, operation_id, provider, code, class, message, retryable, safe_details_json, cause_fingerprint, remediation, created_at FROM provider_errors WHERE operation_id = ? ORDER BY created_at ASC').bind(operationId).all<SqlProviderErrorRow>();
    return result.results.map((row) => this.toProviderError(row));
  }

  // incidents / alerts -----------------------------------------------------

  async recordIncident(input: IncidentUpsert, options: { trackOnly?: boolean } = {}): Promise<IncidentRecord> {
    const firedAt = input.firedAt ?? this.nowIso();
    const detailsJson = serializeJson(input.details ?? {}, 'incident details');
    const deliveryJson = serializeJson(input.delivery ?? {}, 'incident delivery');
    const id = input.id ?? stableId('incident', input.type, input.fingerprint);
    // One row per (type, fingerprint): refiring reopens the same row and
    // keeps the original firstSeenAt. Track-only updates keep lastFiredAt so
    // below-threshold counting never suppresses the eventual firing.
    const sql = options.trackOnly === true
      ? 'INSERT INTO incidents (id, type, fingerprint, severity, application_id, operation_id, message, details_json, first_seen_at, last_fired_at, resolved_at, delivery_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?) ON CONFLICT(type, fingerprint) DO UPDATE SET id = excluded.id, severity = excluded.severity, application_id = COALESCE(excluded.application_id, incidents.application_id), operation_id = COALESCE(excluded.operation_id, incidents.operation_id), message = excluded.message, details_json = excluded.details_json, resolved_at = NULL, delivery_json = excluded.delivery_json'
      : 'INSERT INTO incidents (id, type, fingerprint, severity, application_id, operation_id, message, details_json, first_seen_at, last_fired_at, resolved_at, delivery_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?) ON CONFLICT(type, fingerprint) DO UPDATE SET id = excluded.id, severity = excluded.severity, application_id = COALESCE(excluded.application_id, incidents.application_id), operation_id = COALESCE(excluded.operation_id, incidents.operation_id), message = excluded.message, details_json = excluded.details_json, last_fired_at = excluded.last_fired_at, resolved_at = NULL, delivery_json = excluded.delivery_json';
    await this.db.prepare(sql).bind(id, input.type, input.fingerprint, input.severity, input.applicationId ?? null, input.operationId ?? null, input.message, detailsJson, firedAt, options.trackOnly === true ? '1970-01-01T00:00:00.000Z' : firedAt, deliveryJson).run();
    const row = await this.db.prepare('SELECT id, type, fingerprint, severity, application_id, operation_id, message, details_json, first_seen_at, last_fired_at, resolved_at, delivery_json FROM incidents WHERE type = ? AND fingerprint = ?').bind(input.type, input.fingerprint).first<SqlIncidentRow>();
    if (!row) throw notFound('Incident', `${input.type}:${input.fingerprint}`);
    return this.toIncident(row);
  }

  async getIncident(type: IncidentRecord['type'], fingerprint: string): Promise<IncidentRecord | null> {
    const row = await this.db.prepare('SELECT id, type, fingerprint, severity, application_id, operation_id, message, details_json, first_seen_at, last_fired_at, resolved_at, delivery_json FROM incidents WHERE type = ? AND fingerprint = ?').bind(type, fingerprint).first<SqlIncidentRow>();
    return row ? this.toIncident(row) : null;
  }

  async listIncidents(options: { limit?: number; openOnly?: boolean; type?: IncidentRecord['type'] } = {}): Promise<IncidentRecord[]> {
    const openFilter = options.openOnly === true ? ' AND resolved_at IS NULL' : '';
    const typeFilter = options.type !== undefined ? ' AND type = ?' : '';
    const result = await this.db.prepare(`SELECT id, type, fingerprint, severity, application_id, operation_id, message, details_json, first_seen_at, last_fired_at, resolved_at, delivery_json FROM incidents WHERE 1 = 1${openFilter}${typeFilter} ORDER BY last_fired_at DESC, id ASC LIMIT ?`).bind(...(options.type !== undefined ? [options.type] : []), options.limit ?? -1).all<SqlIncidentRow>();
    return result.results.map((row) => this.toIncident(row));
  }

  async resolveIncident(id: string, resolvedAt?: string): Promise<IncidentRecord> {
    const resolvedAtValue = resolvedAt ?? this.nowIso();
    await this.db.prepare('UPDATE incidents SET resolved_at = COALESCE(resolved_at, ?) WHERE id = ?').bind(resolvedAtValue, id).run();
    const row = await this.db.prepare('SELECT id, type, fingerprint, severity, application_id, operation_id, message, details_json, first_seen_at, last_fired_at, resolved_at, delivery_json FROM incidents WHERE id = ?').bind(id).first<SqlIncidentRow>();
    if (!row) throw notFound('Incident', id);
    return this.toIncident(row);
  }

  // metric snapshots -------------------------------------------------------

  async recordMetricSnapshot(input: MetricSnapshotUpsert): Promise<MetricSnapshotRecord> {
    const capturedAt = input.capturedAt ?? this.nowIso();
    const labelsJson = serializeJson(input.labels ?? {}, 'metric snapshot labels');
    const id = input.id ?? stableId('metric-snapshot', input.metric, capturedAt, String(input.total), labelsJson, String(this.metricSeq++));
    await this.db.prepare('INSERT INTO metric_snapshots (id, metric, total, rate, window_seconds, labels_json, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, input.metric, input.total, input.rate ?? null, input.windowSeconds, labelsJson, capturedAt).run();
    const row = await this.db.prepare('SELECT id, metric, total, rate, window_seconds, labels_json, captured_at FROM metric_snapshots WHERE id = ?').bind(id).first<SqlMetricSnapshotRow>();
    if (!row) throw notFound('Metric snapshot', id);
    return this.toMetricSnapshot(row);
  }

  async listMetricSnapshots(options: { limit?: number; metric?: string } = {}): Promise<MetricSnapshotRecord[]> {
    const metricFilter = options.metric !== undefined ? ' WHERE metric = ?' : '';
    const result = await this.db.prepare(`SELECT id, metric, total, rate, window_seconds, labels_json, captured_at FROM metric_snapshots${metricFilter} ORDER BY captured_at DESC, id ASC LIMIT ?`).bind(...(options.metric !== undefined ? [options.metric] : []), options.limit ?? -1).all<SqlMetricSnapshotRow>();
    return result.results.map((row) => this.toMetricSnapshot(row));
  }

  // webhooks ---------------------------------------------------------------

  async persistWebhookReceipt(input: WebhookReceiptUpsert): Promise<{ inserted: boolean; receipt: WebhookReceiptRecord }> {
    const receivedAt = input.receivedAt ?? this.nowIso();
    const result = await this.db.prepare('INSERT OR IGNORE INTO webhook_events (provider, event_id, payload_json, received_at) VALUES (?, ?, ?, ?)').bind(input.provider, input.eventId, serializeJson(input.payload, 'webhook payload'), receivedAt).run();
    if ((result.meta?.changes ?? 0) === 1) return { inserted: true, receipt: { provider: input.provider, eventId: input.eventId, payload: JSON.parse(JSON.stringify(input.payload)) as Record<string, unknown>, receivedAt, dispatchedAt: null } };
    const row = await this.db.prepare('SELECT provider, event_id, payload_json, received_at, dispatched_at FROM webhook_events WHERE provider = ? AND event_id = ?').bind(input.provider, input.eventId).first<SqlWebhookReceiptRow>();
    if (!row) throw notFound('Webhook receipt', `${input.provider}:${input.eventId}`);
    return { inserted: false, receipt: this.toWebhookReceipt(row) };
  }

  async getWebhookReceipt(provider: string, eventId: string): Promise<WebhookReceiptRecord | null> {
    const row = await this.db.prepare('SELECT provider, event_id, payload_json, received_at, dispatched_at FROM webhook_events WHERE provider = ? AND event_id = ?').bind(provider, eventId).first<SqlWebhookReceiptRow>();
    return row ? this.toWebhookReceipt(row) : null;
  }

  async markWebhookReceiptDispatched(provider: string, eventId: string, dispatchedAt?: string): Promise<WebhookReceiptRecord | null> {
    const dispatchedAtIso = dispatchedAt ?? this.nowIso();
    // First writer wins: a concurrent redelivery must not overwrite the marker.
    await this.db.prepare('UPDATE webhook_events SET dispatched_at = ? WHERE provider = ? AND event_id = ? AND dispatched_at IS NULL').bind(dispatchedAtIso, provider, eventId).run();
    const row = await this.db.prepare('SELECT provider, event_id, payload_json, received_at, dispatched_at FROM webhook_events WHERE provider = ? AND event_id = ?').bind(provider, eventId).first<SqlWebhookReceiptRow>();
    return row ? this.toWebhookReceipt(row) : null;
  }

  // cleanup ----------------------------------------------------------------

  async enqueueCleanupJob(input: CleanupJobUpsert): Promise<CleanupJobRecord> {
    await this.requireApplication(input.applicationId);
    const id = input.id ?? stableId('cleanup-job', input.applicationId, input.providerResourceId, input.expiresAt);
    const existing = await this.db.prepare('SELECT id, application_id, provider_resource_id, expires_at, status, attempts, last_error FROM cleanup_jobs WHERE id = ?').bind(id).first<SqlCleanupJobRow>();
    if (existing) return this.toCleanupJob(existing);
    await this.db.prepare('INSERT INTO cleanup_jobs (id, application_id, provider_resource_id, expires_at, status, attempts, last_error) VALUES (?, ?, ?, ?, \'QUEUED\', 0, NULL)').bind(id, input.applicationId, input.providerResourceId, input.expiresAt).run();
    const row = await this.loadCleanupJob(id);
    if (!row) throw notFound('Cleanup job', id);
    return row;
  }

  async claimCleanupJob(id: string): Promise<CleanupJobRecord> {
    const result = await this.db.prepare('UPDATE cleanup_jobs SET status = \'RUNNING\', attempts = attempts + 1 WHERE id = ? AND status = \'QUEUED\'').bind(id).run();
    if ((result.meta?.changes ?? 0) === 1) {
      const row = await this.loadCleanupJob(id);
      if (!row) throw notFound('Cleanup job', id);
      return row;
    }
    const existing = await this.loadCleanupJob(id);
    if (!existing) throw notFound('Cleanup job', id);
    throw conflict('LP-DB-CLEANUP-NOT-CLAIMABLE', `Cleanup job '${id}' is '${existing.status}', not 'QUEUED'`, { id, status: existing.status });
  }

  async completeCleanupJob(id: string, status: 'SUCCEEDED' | 'FAILED', lastError?: string | null): Promise<CleanupJobRecord> {
    const existing = await this.loadCleanupJob(id);
    if (!existing) throw notFound('Cleanup job', id);
    if (existing.status === 'SUCCEEDED' || existing.status === 'FAILED') return existing;
    if (existing.status === 'QUEUED') throw conflict('LP-DB-CLEANUP-NOT-CLAIMABLE', `Cleanup job '${id}' must be claimed before completion`, { id, status: existing.status });
    await this.db.prepare('UPDATE cleanup_jobs SET status = ?, last_error = ? WHERE id = ? AND status = \'RUNNING\'').bind(status, lastError ?? null, id).run();
    const row = await this.loadCleanupJob(id);
    if (!row) throw notFound('Cleanup job', id);
    return row;
  }

  async listCleanupJobs(applicationId: string): Promise<CleanupJobRecord[]> {
    const result = await this.db.prepare('SELECT id, application_id, provider_resource_id, expires_at, status, attempts, last_error FROM cleanup_jobs WHERE application_id = ? ORDER BY expires_at ASC, id ASC').bind(applicationId).all<SqlCleanupJobRow>();
    return result.results.map((row) => this.toCleanupJob(row));
  }

  async listPendingCleanupJobs(options: { limit?: number } = {}): Promise<CleanupJobRecord[]> {
    const result = await this.db.prepare('SELECT id, application_id, provider_resource_id, expires_at, status, attempts, last_error FROM cleanup_jobs WHERE status IN (\'QUEUED\', \'RUNNING\') AND expires_at > ? ORDER BY expires_at ASC LIMIT ?').bind(this.nowIso(), options.limit ?? -1).all<SqlCleanupJobRow>();
    return result.results.map((row) => this.toCleanupJob(row));
  }

  async listDueCleanupJobs(options: { limit?: number; now?: string } = {}): Promise<CleanupJobRecord[]> {
    const result = await this.db.prepare('SELECT id, application_id, provider_resource_id, expires_at, status, attempts, last_error FROM cleanup_jobs WHERE status = \'QUEUED\' AND expires_at <= ? ORDER BY expires_at ASC LIMIT ?').bind(options.now ?? this.nowIso(), options.limit ?? -1).all<SqlCleanupJobRow>();
    return result.results.map((row) => this.toCleanupJob(row));
  }

  // tombstones -------------------------------------------------------------

  async createTombstone(input: TombstoneCreate): Promise<TombstoneRecord> {
    const app = await this.db.prepare('SELECT lifecycle_state FROM applications WHERE id = ?').bind(input.applicationId).first<{ lifecycle_state: LifecycleState }>();
    if (!app) throw notFound('Application', input.applicationId);
    if (app.lifecycle_state !== 'deleted') throw conflict('LP-DB-TOMBSTONE-APP-NOT-DELETED', `Application '${input.applicationId}' must reach lifecycle 'deleted' before it can be tombstoned`, { lifecycleState: app.lifecycle_state });
    const existingTombstone = await this.db.prepare('SELECT 1 AS present FROM tombstones WHERE application_id = ?').bind(input.applicationId).first<{ present: number }>();
    if (existingTombstone) throw conflict('LP-DB-ALREADY-TOMBSTONED', `Application '${input.applicationId}' is already tombstoned`);
    const domainTombstone = await this.db.prepare('SELECT 1 AS present FROM tombstones WHERE domain = ?').bind(input.domain).first<{ present: number }>();
    if (domainTombstone) throw conflict('LP-DB-TOMBSTONE-REUSE-BLOCKED', `Domain '${input.domain}' already belongs to a tombstoned application`);
    try {
      await this.db.prepare('INSERT INTO tombstones (application_id, domain, deleted_at, retain_until) VALUES (?, ?, ?, ?)').bind(input.applicationId, input.domain, input.deletedAt ?? this.nowIso(), input.retainUntil).run();
    } catch {
      throw conflict('LP-DB-ALREADY-TOMBSTONED', `Application '${input.applicationId}' is already tombstoned`);
    }
    const row = await this.db.prepare('SELECT application_id, domain, deleted_at, retain_until FROM tombstones WHERE application_id = ?').bind(input.applicationId).first<SqlTombstoneRow>();
    if (!row) throw notFound('Tombstone', input.applicationId);
    return this.toTombstone(row);
  }

  async getTombstone(applicationId: string): Promise<TombstoneRecord | null> {
    const row = await this.db.prepare('SELECT application_id, domain, deleted_at, retain_until FROM tombstones WHERE application_id = ?').bind(applicationId).first<SqlTombstoneRow>();
    return row ? this.toTombstone(row) : null;
  }

  async isTombstoned(applicationId: string): Promise<boolean> {
    const row = await this.db.prepare('SELECT 1 AS present FROM tombstones WHERE application_id = ?').bind(applicationId).first<{ present: number }>();
    return row !== null;
  }

  async isDomainTombstoned(domain: string): Promise<boolean> {
    const row = await this.db.prepare('SELECT 1 AS present FROM tombstones WHERE domain = ?').bind(domain).first<{ present: number }>();
    return row !== null;
  }

  async releaseTombstone(input: TombstoneRelease): Promise<TombstoneRecord> {
    if (input.reviewedBy.trim().length === 0) throw invalidArgument('LP-DB-TOMBSTONE-RELEASE-REVIEWER-REQUIRED', 'Releasing a tombstone requires a reviewer identity');
    if (input.reason.trim().length === 0) throw invalidArgument('LP-DB-TOMBSTONE-RELEASE-REASON-REQUIRED', 'Releasing a tombstone requires a reason');
    const row = await this.db.prepare('SELECT application_id, domain, deleted_at, retain_until FROM tombstones WHERE application_id = ?').bind(input.applicationId).first<SqlTombstoneRow>();
    if (!row) throw notFound('Tombstone', input.applicationId);
    await this.db.prepare('DELETE FROM tombstones WHERE application_id = ?').bind(input.applicationId).run();
    return this.toTombstone(row);
  }

  // audit (append-only; immutability enforced by triggers) -----------------

  async appendAudit(input: AuditAppend): Promise<AuditRecord> {
    // Default ids are globally unique (readable prefix + v4 UUID) so that
    // concurrent instances or isolate restarts over one database can never
    // collide, even for identical actor/action/application at the same time.
    // Explicit caller ids are used verbatim for idempotent replay.
    const id = input.id ?? `audit-${crypto.randomUUID()}`;
    const createdAt = input.createdAt ?? this.nowIso();
    await this.db.prepare('INSERT INTO audit_events (id, actor, action, application_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, input.actor, input.action, input.applicationId ?? null, serializeJson(input.details ?? {}, 'audit details'), createdAt).run();
    const row = await this.db.prepare('SELECT id, actor, action, application_id, details_json, created_at FROM audit_events WHERE id = ?').bind(id).first<SqlAuditRow>();
    if (!row) throw notFound('Audit event', id);
    return this.toAudit(row);
  }

  async listAudit(applicationId: string, options: { limit?: number } = {}): Promise<AuditRecord[]> {
    const result = await this.db.prepare('SELECT id, actor, action, application_id, details_json, created_at FROM (SELECT id, actor, action, application_id, details_json, created_at, rowid AS rowid FROM audit_events WHERE application_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at ASC, rowid ASC').bind(applicationId, options.limit ?? -1).all<SqlAuditRow>();
    return result.results.map((row) => this.toAudit(row));
  }

  async listAuditAll(options: { limit?: number } = {}): Promise<AuditRecord[]> {
    const result = await this.db.prepare('SELECT id, actor, action, application_id, details_json, created_at FROM (SELECT id, actor, action, application_id, details_json, created_at, rowid AS rowid FROM audit_events ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at ASC, rowid ASC').bind(options.limit ?? -1).all<SqlAuditRow>();
    return result.results.map((row) => this.toAudit(row));
  }

  // credentials metadata ---------------------------------------------------

  async upsertCredentialMetadata(input: CredentialMetadataUpsert): Promise<CredentialMetadataRecord> {
    await this.db.prepare('INSERT INTO credentials_metadata (id, provider, purpose, value_fingerprint, expires_at, last_checked_at, status) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, purpose = excluded.purpose, value_fingerprint = excluded.value_fingerprint, expires_at = excluded.expires_at, last_checked_at = excluded.last_checked_at, status = excluded.status').bind(input.id, input.provider, input.purpose, input.valueFingerprint ?? null, input.expiresAt ?? null, input.lastCheckedAt, input.status).run();
    const row = await this.db.prepare('SELECT id, provider, purpose, value_fingerprint, expires_at, last_checked_at, status FROM credentials_metadata WHERE id = ?').bind(input.id).first<SqlCredentialRow>();
    if (!row) throw notFound('Credential metadata', input.id);
    return this.toCredential(row);
  }

  async getCredentialMetadata(id: string): Promise<CredentialMetadataRecord | null> {
    const row = await this.db.prepare('SELECT id, provider, purpose, value_fingerprint, expires_at, last_checked_at, status FROM credentials_metadata WHERE id = ?').bind(id).first<SqlCredentialRow>();
    return row ? this.toCredential(row) : null;
  }

  async listCredentialsMetadata(provider?: ProviderName): Promise<CredentialMetadataRecord[]> {
    const result = await this.db.prepare('SELECT id, provider, purpose, value_fingerprint, expires_at, last_checked_at, status FROM credentials_metadata WHERE (? IS NULL OR provider = ?) ORDER BY id ASC').bind(provider ?? null, provider ?? null).all<SqlCredentialRow>();
    return result.results.map((row) => this.toCredential(row));
  }

  async updateCredentialStatus(id: string, status: CredentialStatus, lastCheckedAt: string): Promise<CredentialMetadataRecord> {
    const result = await this.db.prepare('UPDATE credentials_metadata SET status = ?, last_checked_at = ? WHERE id = ?').bind(status, lastCheckedAt, id).run();
    if ((result.meta?.changes ?? 0) === 0) {
      const exists = await this.db.prepare('SELECT 1 AS present FROM credentials_metadata WHERE id = ?').bind(id).first<{ present: number }>();
      if (!exists) throw notFound('Credential metadata', id);
    }
    const row = await this.db.prepare('SELECT id, provider, purpose, value_fingerprint, expires_at, last_checked_at, status FROM credentials_metadata WHERE id = ?').bind(id).first<SqlCredentialRow>();
    if (!row) throw notFound('Credential metadata', id);
    return this.toCredential(row);
  }

  // locks ------------------------------------------------------------------

  async acquireLock(resourceKey: string, ownerId: string, leaseSeconds: number, now?: string): Promise<boolean> {
    validateLockKey(resourceKey);
    const nowIso = now ?? this.nowIso();
    const expiresAt = new Date(Date.parse(nowIso) + leaseSeconds * 1000).toISOString();
    const result = await this.db.prepare('INSERT INTO locks (resource_key, owner_id, acquired_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(resource_key) DO UPDATE SET owner_id = excluded.owner_id, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at WHERE locks.expires_at <= ? OR locks.owner_id = excluded.owner_id').bind(resourceKey, ownerId, nowIso, expiresAt, nowIso).run();
    return (result.meta?.changes ?? 0) === 1;
  }

  async renewLock(resourceKey: string, ownerId: string, leaseSeconds: number, now?: string): Promise<boolean> {
    validateLockKey(resourceKey);
    const nowIso = now ?? this.nowIso();
    const expiresAt = new Date(Date.parse(nowIso) + leaseSeconds * 1000).toISOString();
    const result = await this.db.prepare('UPDATE locks SET expires_at = ? WHERE resource_key = ? AND owner_id = ? AND expires_at > ?').bind(expiresAt, resourceKey, ownerId, nowIso).run();
    return (result.meta?.changes ?? 0) === 1;
  }

  async releaseLock(resourceKey: string, ownerId: string): Promise<boolean> {
    const result = await this.db.prepare('DELETE FROM locks WHERE resource_key = ? AND owner_id = ?').bind(resourceKey, ownerId).run();
    return (result.meta?.changes ?? 0) === 1;
  }

  async getLock(resourceKey: string): Promise<LockRecord | null> {
    const row = await this.db.prepare('SELECT resource_key, owner_id, acquired_at, expires_at FROM locks WHERE resource_key = ?').bind(resourceKey).first<SqlLockRow>();
    return row ? this.toLock(row) : null;
  }

  // idempotent requests ----------------------------------------------------

  async registerIdempotentRequest(input: IdempotentRequestRegister): Promise<IdempotentRequestRecord> {
    const existing = await this.db.prepare('SELECT idempotency_key, operation_id, payload_hash, created_at FROM idempotent_requests WHERE idempotency_key = ?').bind(input.idempotencyKey).first<SqlIdempotentRequestRow>();
    if (existing) {
      if (existing.payload_hash !== input.payloadHash) throw conflict('LP-DB-IDEMPOTENCY-REUSED', `Idempotency key '${input.idempotencyKey}' was already registered with a different payload`, { idempotencyKey: input.idempotencyKey });
      return this.toIdempotentRequest(existing);
    }
    await this.requireWorkflowRun(input.operationId);
    const createdAt = input.createdAt ?? this.nowIso();
    try {
      await this.db.prepare('INSERT INTO idempotent_requests (idempotency_key, operation_id, payload_hash, created_at) VALUES (?, ?, ?, ?)').bind(input.idempotencyKey, input.operationId, input.payloadHash, createdAt).run();
    } catch {
      const raced = await this.db.prepare('SELECT idempotency_key, operation_id, payload_hash, created_at FROM idempotent_requests WHERE idempotency_key = ?').bind(input.idempotencyKey).first<SqlIdempotentRequestRow>();
      if (raced) {
        if (raced.payload_hash !== input.payloadHash) throw conflict('LP-DB-IDEMPOTENCY-REUSED', `Idempotency key '${input.idempotencyKey}' was already registered with a different payload`, { idempotencyKey: input.idempotencyKey });
        return this.toIdempotentRequest(raced);
      }
      throw conflict('LP-DB-IDEMPOTENCY-CONFLICT', `Failed to register idempotency key '${input.idempotencyKey}'`, { idempotencyKey: input.idempotencyKey });
    }
    const row = await this.db.prepare('SELECT idempotency_key, operation_id, payload_hash, created_at FROM idempotent_requests WHERE idempotency_key = ?').bind(input.idempotencyKey).first<SqlIdempotentRequestRow>();
    if (!row) throw notFound('Idempotent request', input.idempotencyKey);
    return this.toIdempotentRequest(row);
  }

  async getIdempotentRequest(idempotencyKey: string): Promise<IdempotentRequestRecord | null> {
    const row = await this.db.prepare('SELECT idempotency_key, operation_id, payload_hash, created_at FROM idempotent_requests WHERE idempotency_key = ?').bind(idempotencyKey).first<SqlIdempotentRequestRow>();
    return row ? this.toIdempotentRequest(row) : null;
  }

  // reviewed-plan attestations (plan-approval gate) ------------------------

  private async loadPlanReviewAttestation(attestationId: string): Promise<PlanReviewAttestationRecord | null> {
    const row = await this.db.prepare('SELECT id, application_id, pr_head_source_commit, desired_hash, generation, plan_fingerprint, review_fingerprint, repository, actor, workflow_ref, created_at FROM plan_review_attestations WHERE id = ?').bind(attestationId).first<SqlPlanReviewAttestationRow>();
    return row ? this.toPlanReviewAttestation(row) : null;
  }

  private toPlanReviewAttestation(row: SqlPlanReviewAttestationRow): PlanReviewAttestationRecord {
    return { id: row.id, applicationId: row.application_id, prHeadSourceCommit: row.pr_head_source_commit, desiredHash: row.desired_hash, generation: row.generation, planFingerprint: row.plan_fingerprint, reviewFingerprint: row.review_fingerprint, repository: row.repository, actor: row.actor, workflowRef: row.workflow_ref, createdAt: row.created_at };
  }

  async savePlanReviewAttestation(input: PlanReviewAttestationUpsert): Promise<{ inserted: boolean; attestation: PlanReviewAttestationRecord }> {
    await this.requireApplication(input.applicationId);
    const existingRow = await this.db.prepare('SELECT id, application_id, pr_head_source_commit, desired_hash, generation, plan_fingerprint, review_fingerprint, repository, actor, workflow_ref, created_at FROM plan_review_attestations WHERE application_id = ? AND review_fingerprint = ?').bind(input.applicationId, input.reviewFingerprint).first<SqlPlanReviewAttestationRow>();
    if (existingRow) {
      const existing = this.toPlanReviewAttestation(existingRow);
      if (existing.desiredHash !== input.desiredHash || existing.generation !== input.generation || existing.repository !== input.repository) {
        throw conflict('LP-DB-PLAN-REVIEW-REPLAY-CONFLICT', `A reviewed-plan attestation for review fingerprint '${input.reviewFingerprint}' is already stored for '${input.applicationId}' with a different desired-state binding`, { applicationId: input.applicationId, reviewFingerprint: input.reviewFingerprint });
      }
      return { inserted: false, attestation: existing };
    }
    const id = input.id ?? stableId('plan-review', input.applicationId, input.reviewFingerprint);
    const createdAt = input.createdAt ?? this.nowIso();
    try {
      await this.db.prepare('INSERT INTO plan_review_attestations (id, application_id, pr_head_source_commit, desired_hash, generation, plan_fingerprint, review_fingerprint, repository, actor, workflow_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, input.applicationId, input.prHeadSourceCommit, input.desiredHash, input.generation, input.planFingerprint, input.reviewFingerprint, input.repository, input.actor, input.workflowRef, createdAt).run();
    } catch {
      const raced = await this.db.prepare('SELECT id, application_id, pr_head_source_commit, desired_hash, generation, plan_fingerprint, review_fingerprint, repository, actor, workflow_ref, created_at FROM plan_review_attestations WHERE application_id = ? AND review_fingerprint = ?').bind(input.applicationId, input.reviewFingerprint).first<SqlPlanReviewAttestationRow>();
      if (raced) {
        const existing = this.toPlanReviewAttestation(raced);
        if (existing.desiredHash !== input.desiredHash || existing.generation !== input.generation || existing.repository !== input.repository) {
          throw conflict('LP-DB-PLAN-REVIEW-REPLAY-CONFLICT', `A reviewed-plan attestation for review fingerprint '${input.reviewFingerprint}' is already stored for '${input.applicationId}' with a different desired-state binding`, { applicationId: input.applicationId, reviewFingerprint: input.reviewFingerprint });
        }
        return { inserted: false, attestation: existing };
      }
      throw conflict('LP-DB-PLAN-REVIEW-CONFLICT', `Failed to persist the reviewed-plan attestation for review fingerprint '${input.reviewFingerprint}'`, { applicationId: input.applicationId, reviewFingerprint: input.reviewFingerprint });
    }
    const row = await this.loadPlanReviewAttestation(id);
    if (!row) throw notFound('Plan review attestation', id);
    return { inserted: true, attestation: row };
  }

  async getPlanReviewAttestation(applicationId: string, reviewFingerprint: string): Promise<PlanReviewAttestationRecord | null> {
    const row = await this.db.prepare('SELECT id, application_id, pr_head_source_commit, desired_hash, generation, plan_fingerprint, review_fingerprint, repository, actor, workflow_ref, created_at FROM plan_review_attestations WHERE application_id = ? AND review_fingerprint = ?').bind(applicationId, reviewFingerprint).first<SqlPlanReviewAttestationRow>();
    return row ? this.toPlanReviewAttestation(row) : null;
  }

  async listPlanReviewAttestations(applicationId: string, options: { limit?: number } = {}): Promise<PlanReviewAttestationRecord[]> {
    const result = await this.db.prepare('SELECT id, application_id, pr_head_source_commit, desired_hash, generation, plan_fingerprint, review_fingerprint, repository, actor, workflow_ref, created_at FROM plan_review_attestations WHERE application_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').bind(applicationId, options.limit ?? -1).all<SqlPlanReviewAttestationRow>();
    return result.results.map((row) => this.toPlanReviewAttestation(row));
  }

  // deletion approvals (single-use) ----------------------------------------

  async createDeletionApproval(input: DeletionApprovalCreate): Promise<DeletionApprovalRecord> {
    await this.requireApplication(input.applicationId);
    const tokenHash = await sha256Hex(input.token);
    const existing = await this.db.prepare('SELECT 1 AS present FROM deletion_approvals WHERE application_id = ? AND token_hash = ?').bind(input.applicationId, tokenHash).first<{ present: number }>();
    if (existing) throw conflict('LP-DB-APPROVAL-EXISTS', 'A pending deletion approval with this token already exists for this application');
    const id = input.id ?? stableId('deletion-approval', input.applicationId, tokenHash);
    try {
      await this.db.prepare('INSERT INTO deletion_approvals (id, application_id, token_hash, requested_by, status, expires_at, created_at, used_at, revoked_at) VALUES (?, ?, ?, ?, \'PENDING\', ?, ?, NULL, NULL)').bind(id, input.applicationId, tokenHash, input.requestedBy ?? null, input.expiresAt, input.createdAt ?? this.nowIso()).run();
    } catch {
      throw conflict('LP-DB-APPROVAL-EXISTS', 'A pending deletion approval with this token already exists for this application');
    }
    const row = await this.db.prepare('SELECT id, application_id, token_hash, requested_by, status, expires_at, created_at, used_at, revoked_at FROM deletion_approvals WHERE id = ?').bind(id).first<SqlDeletionApprovalRow>();
    if (!row) throw notFound('Deletion approval', id);
    return this.toDeletionApproval(row);
  }

  async consumeDeletionApproval(applicationId: string, token: string, consumedAt?: string): Promise<DeletionApprovalRecord> {
    const tokenHash = await sha256Hex(token);
    const row = await this.db.prepare('SELECT id, application_id, token_hash, requested_by, status, expires_at, created_at, used_at, revoked_at FROM deletion_approvals WHERE application_id = ? AND token_hash = ?').bind(applicationId, tokenHash).first<SqlDeletionApprovalRow>();
    if (!row) throw notFound('Deletion approval', `application '${applicationId}'`);
    if (row.status === 'USED') throw conflict('LP-DB-APPROVAL-USED', `Deletion approval '${row.id}' was already consumed`, { id: row.id });
    if (row.status === 'REVOKED') throw conflict('LP-DB-APPROVAL-REVOKED', `Deletion approval '${row.id}' was revoked`, { id: row.id });
    const nowIso = consumedAt ?? this.nowIso();
    if (row.expires_at < nowIso) {
      await this.db.prepare('UPDATE deletion_approvals SET status = \'EXPIRED\' WHERE id = ? AND status = \'PENDING\'').bind(row.id).run();
      throw conflict('LP-DB-APPROVAL-EXPIRED', `Deletion approval '${row.id}' expired at ${row.expires_at}`, { id: row.id, expiresAt: row.expires_at });
    }
    const consumed = await this.db.prepare('UPDATE deletion_approvals SET status = \'USED\', used_at = ? WHERE id = ? AND status = \'PENDING\' AND expires_at >= ?').bind(nowIso, row.id, nowIso).run();
    if ((consumed.meta?.changes ?? 0) === 0) {
      const raced = await this.db.prepare('SELECT status FROM deletion_approvals WHERE id = ?').bind(row.id).first<{ status: string }>();
      throw conflict('LP-DB-APPROVAL-USED', `Deletion approval '${row.id}' was already consumed (status '${raced?.status ?? 'UNKNOWN'}')`, { id: row.id });
    }
    const updated = await this.db.prepare('SELECT id, application_id, token_hash, requested_by, status, expires_at, created_at, used_at, revoked_at FROM deletion_approvals WHERE id = ?').bind(row.id).first<SqlDeletionApprovalRow>();
    if (!updated) throw notFound('Deletion approval', row.id);
    return this.toDeletionApproval(updated);
  }

  async revokeDeletionApproval(id: string, revokedAt?: string): Promise<DeletionApprovalRecord> {
    const result = await this.db.prepare('UPDATE deletion_approvals SET status = \'REVOKED\', revoked_at = ? WHERE id = ? AND status = \'PENDING\'').bind(revokedAt ?? this.nowIso(), id).run();
    if ((result.meta?.changes ?? 0) === 1) {
      const row = await this.db.prepare('SELECT id, application_id, token_hash, requested_by, status, expires_at, created_at, used_at, revoked_at FROM deletion_approvals WHERE id = ?').bind(id).first<SqlDeletionApprovalRow>();
      if (!row) throw notFound('Deletion approval', id);
      return this.toDeletionApproval(row);
    }
    const existing = await this.db.prepare('SELECT id, application_id, token_hash, requested_by, status, expires_at, created_at, used_at, revoked_at FROM deletion_approvals WHERE id = ?').bind(id).first<SqlDeletionApprovalRow>();
    if (!existing) throw notFound('Deletion approval', id);
    throw conflict('LP-DB-APPROVAL-NOT-PENDING', `Deletion approval '${id}' is '${existing.status}', only pending approvals can be revoked`, { id, status: existing.status });
  }

  async listDeletionApprovals(applicationId: string): Promise<DeletionApprovalRecord[]> {
    const result = await this.db.prepare('SELECT id, application_id, token_hash, requested_by, status, expires_at, created_at, used_at, revoked_at FROM deletion_approvals WHERE application_id = ? ORDER BY created_at DESC, id ASC').bind(applicationId).all<SqlDeletionApprovalRow>();
    return result.results.map((row) => this.toDeletionApproval(row));
  }

  // dashboard query models -------------------------------------------------

  async listApplications(): Promise<DashboardApplicationRow[]> {
    const result = await this.db.prepare(`SELECT
      a.id AS application, a.display_name AS displayName, a.owners_json AS ownersJson, a.sync_status AS sync, a.health_status AS health,
      kg.state AS deployment, kg.commit_sha AS currentDeploymentCommit, kg.url AS productionUrl,
      rr.resolved_at AS lastSuccessfulReconciliation, wr.status AS activeOperation, op.pull_request_url AS openPrOrIncident,
      a.updated_at AS updatedAt
    FROM applications a
    LEFT JOIN deployments kg ON kg.id = (SELECT d.id FROM deployments d WHERE d.application_id = a.id AND d.environment = 'production' AND d.state = 'CURRENT' ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1)
    LEFT JOIN (SELECT application_id, MAX(resolved_at) AS resolved_at FROM reconciliation_requests WHERE status = 'RESOLVED' GROUP BY application_id) rr ON rr.application_id = a.id
    LEFT JOIN (SELECT application_id, MIN(status) AS status FROM workflow_runs WHERE status NOT IN (${TERMINAL_WORKFLOW_STATUSES.map(() => '?').join(', ')}) GROUP BY application_id) wr ON wr.application_id = a.id
    LEFT JOIN (SELECT application_id, pull_request_url FROM reconciliation_requests WHERE status = 'OPEN' AND pull_request_url IS NOT NULL GROUP BY application_id) op ON op.application_id = a.id
    ORDER BY a.id ASC`).bind(...TERMINAL_WORKFLOW_STATUSES).all<SqlDashboardRow>();
    return result.results.map((row) => {
      const owners = JSON.parse(row.ownersJson) as string[];
      return { application: row.application, displayName: row.displayName, owners, owner: owners[0] ?? 'unassigned', sync: row.sync, health: row.health, deployment: row.deployment, currentDeploymentCommit: row.currentDeploymentCommit, productionUrl: row.productionUrl, lastSuccessfulReconciliation: row.lastSuccessfulReconciliation, activeOperation: row.activeOperation, openPrOrIncident: row.openPrOrIncident, updatedAt: row.updatedAt };
    });
  }

  async getApplicationDetail(applicationId: string): Promise<ApplicationDetail> {
    const statements: D1PreparedStatement[] = [
      this.db.prepare('SELECT id, display_name, source_path, desired_generation, desired_hash, sync_status, health_status, lifecycle_state, owners_json, updated_at FROM applications WHERE id = ?').bind(applicationId),
      this.db.prepare('SELECT id, application_id, project_id, environment, repository, commit_sha, desired_generation, state, url, created_at FROM deployments WHERE application_id = ? AND environment = \'production\' AND state = \'CURRENT\' ORDER BY created_at DESC, id DESC LIMIT 1').bind(applicationId),
      this.db.prepare('SELECT id, application_id, environment, deployment_id, url, attempt, dns_resolved, tls_valid, status_code, latency_ms, assertion_results_json, result, checked_at, error_code FROM health_checks WHERE application_id = ? ORDER BY checked_at DESC, id DESC LIMIT 1').bind(applicationId),
      this.db.prepare(`SELECT id, application_id, workflow_type, status, idempotency_key, payload_hash, started_at, completed_at, error_code FROM workflow_runs WHERE application_id = ? AND status NOT IN (${TERMINAL_WORKFLOW_STATUSES.map(() => '?').join(', ')}) ORDER BY started_at ASC`).bind(applicationId, ...TERMINAL_WORKFLOW_STATUSES),
      this.db.prepare('SELECT id, application_id, workflow_type, status, idempotency_key, payload_hash, started_at, completed_at, error_code FROM workflow_runs WHERE application_id = ? ORDER BY started_at DESC, id DESC LIMIT 10').bind(applicationId),
    ];
    const results = await this.db.batch(statements);
    const applicationRow = results[0]?.results?.[0] as SqlApplicationRow | undefined;
    const knownGoodRow = results[1]?.results?.[0] as SqlDeploymentRow | undefined;
    const healthRow = results[2]?.results?.[0] as SqlHealthCheckRow | undefined;
    const openRunRows = (results[3]?.results ?? []) as SqlWorkflowRunRow[];
    const recentRunRows = (results[4]?.results ?? []) as SqlWorkflowRunRow[];
    return { application: applicationRow ? this.toApplication(applicationRow) : null, knownGoodDeployment: knownGoodRow ? this.toDeployment(knownGoodRow) : null, latestHealthCheck: healthRow ? this.toHealthCheck(healthRow) : null, openWorkflowRuns: openRunRows.map((row) => this.toWorkflowRun(row)), recentWorkflowRuns: recentRunRows.map((row) => this.toWorkflowRun(row)) };
  }
}

const ALLOWED_LIFECYCLE_TRANSITIONS: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = {
  active: ['active', 'decommissioning'],
  decommissioning: ['decommissioning', 'active', 'approved-for-deletion'],
  'approved-for-deletion': ['approved-for-deletion', 'deleted'],
  deleted: ['deleted'],
};

interface SqlApplicationRow { id: string; display_name: string; source_path: string; desired_generation: number; desired_hash: string; sync_status: ApplicationRecord['syncStatus']; health_status: ApplicationRecord['healthStatus']; lifecycle_state: LifecycleState; owners_json: string; updated_at: string; }
interface SqlDesiredGenerationRow { application_id: string; generation: number; desired_hash: string; updated_at: string; }
interface SqlResourceRow { id: string; application_id: string; provider: ProviderName; resource_type: string; resource_key: string; provider_resource_id: string; desired_generation: number; observed_hash: string; ownership_fingerprint: string | null; status: 'ACTIVE' | 'RELEASED'; first_seen_at: string; last_seen_at: string; }
interface SqlObservationRow { id: string; application_id: string; observed_hash: string; payload_json: string; observed_at: string; }
interface SqlPlanRow { id: string; application_id: string; fingerprint: string; source_commit: string; result: PlatformPlan['result']; payload_json: string; created_at: string; }
interface SqlWorkflowRunRow { id: string; application_id: string; workflow_type: string; status: WorkflowStatus; idempotency_key: string; payload_hash: string; started_at: string; completed_at: string | null; error_code: string | null; }
interface SqlWorkflowStepRow { workflow_id: string; step_id: string; status: WorkflowStepRecord['status']; attempt: number; precondition_hash: string; result_json: string | null; error_json: string | null; }
interface SqlDeploymentRow { id: string; application_id: string; project_id: string; environment: DeploymentRow['environment']; repository: string; commit_sha: string; desired_generation: number; state: DeploymentRow['state']; url: string | null; created_at: string; }
interface SqlPromotionRow { id: string; application_id: string; deployment_id: string; previous_deployment_id: string | null; result: string; promoted_at: string; }
interface SqlHealthCheckRow { id: string; application_id: string; environment: HealthCheckRecord['environment']; deployment_id: string | null; url: string; attempt: number; dns_resolved: 0 | 1; tls_valid: 0 | 1; status_code: number | null; latency_ms: number | null; assertion_results_json: string; result: HealthCheckRecord['result']; checked_at: string; error_code: string | null; }
interface SqlDriftEventRow { id: string; application_id: string; fingerprint: string; category: string; payload_json: string; observed_at: string; resolved_at: string | null; }
interface SqlReconciliationRow { id: string; application_id: string; fingerprint: string; mode: ReconciliationRequestRecord['mode']; pull_request_number: number | null; pull_request_url: string | null; status: ReconciliationRequestRecord['status']; opened_at: string; resolved_at: string | null; }
interface SqlProviderErrorRow { id: string; application_id: string | null; operation_id: string | null; provider: ProviderName | null; code: string; class: ProviderErrorRecord['class']; message: string; retryable: 0 | 1; safe_details_json: string; cause_fingerprint: string; remediation: string; created_at: string; }
interface SqlIncidentRow { id: string; type: IncidentRecord['type']; fingerprint: string; severity: IncidentRecord['severity']; application_id: string | null; operation_id: string | null; message: string; details_json: string; first_seen_at: string; last_fired_at: string; resolved_at: string | null; delivery_json: string; }
interface SqlMetricSnapshotRow { id: string; metric: string; total: number; rate: number | null; window_seconds: number; labels_json: string; captured_at: string; }
interface SqlWebhookReceiptRow { provider: string; event_id: string; payload_json: string; received_at: string; dispatched_at: string | null; }
interface SqlCleanupJobRow { id: string; application_id: string; provider_resource_id: string; expires_at: string; status: CleanupJobRecord['status']; attempts: number; last_error: string | null; }
interface SqlTombstoneRow { application_id: string; domain: string; deleted_at: string; retain_until: string; }
interface SqlAuditRow { id: string; actor: string; action: string; application_id: string | null; details_json: string; created_at: string; }
interface SqlCredentialRow { id: string; provider: ProviderName; purpose: string; value_fingerprint: string | null; expires_at: string | null; last_checked_at: string; status: CredentialStatus; }
interface SqlLockRow { resource_key: string; owner_id: string; acquired_at: string; expires_at: string; }
interface SqlIdempotentRequestRow { idempotency_key: string; operation_id: string; payload_hash: string; created_at: string; }
interface SqlPlanReviewAttestationRow { id: string; application_id: string; pr_head_source_commit: string; desired_hash: string; generation: number; plan_fingerprint: string; review_fingerprint: string; repository: string; actor: string; workflow_ref: string; created_at: string; }
interface SqlDeletionApprovalRow { id: string; application_id: string; token_hash: string; requested_by: string | null; status: DeletionApprovalRecord['status']; expires_at: string; created_at: string; used_at: string | null; revoked_at: string | null; }
interface SqlDashboardRow { application: string; displayName: string; ownersJson: string; sync: ApplicationRecord['syncStatus']; health: ApplicationRecord['healthStatus']; deployment: DeploymentRow['state'] | null; currentDeploymentCommit: string | null; productionUrl: string | null; lastSuccessfulReconciliation: string | null; activeOperation: string | null; openPrOrIncident: string | null; updatedAt: string; }
