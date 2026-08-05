import { sha256Hex, stableId } from '@launchpad/shared';
import type { HealthCheckRecord, LifecycleState, ObservedApplication, PlannedOperation, PlatformError, PlatformPlan, ProviderName } from '@launchpad/core';
import { conflict, invalidArgument, notFound } from './errors.js';
import { serializeJson, validateLockKey, type ApplicationStatusPatch, type ApplicationUpsert, type AuditAppend, type CleanupJobUpsert, type CredentialMetadataUpsert, type DeletionApprovalCreate, type DeploymentUpsert, type DesiredGenerationAdvance, type DriftEventUpsert, type IdempotentRequestRegister, type IncidentUpsert, type LaunchpadStore, type MetricSnapshotUpsert, type ObservationUpsert, type PlanReviewAttestationUpsert, type PlanUpsert, type PromotionUpsert, type ProviderErrorUpsert, type ReconciliationOpen, type ResourceUpsert, type StoreOptions, type TombstoneCreate, type TombstoneRelease, type WebhookReceiptUpsert, type WorkflowRunCancel, type WorkflowRunStart, type WorkflowRunPatch, type WorkflowStepUpsert } from './store.js';
import { TERMINAL_WORKFLOW_STATUSES, type ApplicationRecord, type ApplicationDetail, type AuditRecord, type CleanupJobRecord, type CredentialMetadataRecord, type CredentialStatus, type DashboardApplicationRow, type DeletionApprovalRecord, type DeploymentRow, type DesiredGenerationRecord, type DriftEventRecord, type HealthStatus, type IdempotentRequestRecord, type IncidentRecord, type LockRecord, type MetricSnapshotRecord, type ObservationRecord, type PlanReviewAttestationRecord, type PromotionRecord, type ProviderErrorRecord, type ReconciliationRequestRecord, type ResourceRecord, type StoredPlanRecord, type SyncStatus, type TombstoneRecord, type WebhookReceiptRecord, type WorkflowRunRecord, type WorkflowStepRecord, type WorkflowStatus } from './types.js';

/**
 * In-memory `LaunchpadStore`. Rows mirror the D1 schema column-for-column
 * (including JSON payload columns), so the serialization and invariant
 * behavior is identical to `D1LaunchpadStore`; the two share the contract
 * test suite. Not durable — production paths use `D1LaunchpadStore`.
 */

interface AppRow { id: string; display_name: string; source_path: string; desired_generation: number; desired_hash: string; sync_status: SyncStatus; health_status: HealthStatus; lifecycle_state: LifecycleState; owners_json: string; updated_at: string; }
interface DesiredGenerationRow { application_id: string; generation: number; desired_hash: string; updated_at: string; }
interface ResourceRow { id: string; application_id: string; provider: ProviderName; resource_type: string; resource_key: string; provider_resource_id: string; desired_generation: number; observed_hash: string; ownership_fingerprint: string | null; status: 'ACTIVE' | 'RELEASED'; first_seen_at: string; last_seen_at: string; }
interface ObservationRow { id: string; application_id: string; observed_hash: string; payload_json: string; observed_at: string; }
interface PlanRow { id: string; application_id: string; fingerprint: string; source_commit: string; result: PlatformPlan['result']; payload_json: string; created_at: string; }
interface PlanOperationRow { id: string; plan_id: string; resource_key: string; action: string; destructive: 0 | 1; payload_json: string; }
interface WorkflowRunRow { id: string; application_id: string; workflow_type: string; status: WorkflowStatus; idempotency_key: string; payload_hash: string; started_at: string; completed_at: string | null; error_code: string | null; }
interface WorkflowStepRow { workflow_id: string; step_id: string; status: WorkflowStepRecord['status']; attempt: number; precondition_hash: string; result_json: string | null; error_json: string | null; }
interface DeploymentRowInternal { id: string; application_id: string; project_id: string; environment: DeploymentRow['environment']; repository: string; commit_sha: string; desired_generation: number; state: DeploymentRow['state']; url: string | null; created_at: string; }
interface PromotionRow { id: string; application_id: string; deployment_id: string; previous_deployment_id: string | null; result: string; promoted_at: string; }
interface HealthCheckRow { id: string; application_id: string; environment: HealthCheckRecord['environment']; deployment_id: string | null; url: string; attempt: number; dns_resolved: 0 | 1; tls_valid: 0 | 1; status_code: number | null; latency_ms: number | null; assertion_results_json: string; result: HealthCheckRecord['result']; checked_at: string; error_code: string | null; }
interface DriftEventRow { id: string; application_id: string; fingerprint: string; category: string; payload_json: string; observed_at: string; resolved_at: string | null; }
interface ReconciliationRow { id: string; application_id: string; fingerprint: string; mode: ReconciliationRequestRecord['mode']; pull_request_number: number | null; pull_request_url: string | null; status: ReconciliationRequestRecord['status']; opened_at: string; resolved_at: string | null; }
interface ProviderErrorRow { id: string; application_id: string | null; operation_id: string | null; provider: ProviderName | null; code: string; class: ProviderErrorRecord['class']; message: string; retryable: 0 | 1; safe_details_json: string; cause_fingerprint: string; remediation: string; created_at: string; }
interface IncidentRow { id: string; type: IncidentRecord['type']; fingerprint: string; severity: IncidentRecord['severity']; application_id: string | null; operation_id: string | null; message: string; details_json: string; first_seen_at: string; last_fired_at: string; resolved_at: string | null; delivery_json: string; }
interface MetricSnapshotRow { id: string; metric: string; total: number; rate: number | null; window_seconds: number; labels_json: string; captured_at: string; }
interface WebhookReceiptRow { provider: string; event_id: string; payload_json: string; received_at: string; dispatched_at: string | null; }
interface CleanupJobRow { id: string; application_id: string; provider_resource_id: string; expires_at: string; status: CleanupJobRecord['status']; attempts: number; last_error: string | null; }
interface TombstoneRow { application_id: string; domain: string; deleted_at: string; retain_until: string; }
interface AuditRow { id: string; actor: string; action: string; application_id: string | null; details_json: string; created_at: string; }
interface CredentialMetadataRow { id: string; provider: ProviderName; purpose: string; value_fingerprint: string | null; expires_at: string | null; last_checked_at: string; status: CredentialStatus; }
interface LockRow { resource_key: string; owner_id: string; acquired_at: string; expires_at: string; }
interface IdempotentRequestRow { idempotency_key: string; operation_id: string; payload_hash: string; created_at: string; }
interface PlanReviewAttestationRow { id: string; application_id: string; pr_head_source_commit: string; desired_hash: string; generation: number; plan_fingerprint: string; review_fingerprint: string; repository: string; actor: string; workflow_ref: string; created_at: string; }
interface DeletionApprovalRow { id: string; application_id: string; token_hash: string; requested_by: string | null; status: DeletionApprovalRecord['status']; expires_at: string; created_at: string; used_at: string | null; revoked_at: string | null; }

const ALLOWED_LIFECYCLE_TRANSITIONS: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = {
  active: ['active', 'decommissioning'],
  decommissioning: ['decommissioning', 'active', 'approved-for-deletion'],
  'approved-for-deletion': ['approved-for-deletion', 'deleted'],
  deleted: ['deleted'],
};

export class InMemoryLaunchpadStore implements LaunchpadStore {
  private readonly options: Required<StoreOptions>;
  private readonly applications = new Map<string, AppRow>();
  private readonly desiredGenerations = new Map<string, DesiredGenerationRow>();
  private readonly resources = new Map<string, ResourceRow>();
  private readonly observations = new Map<string, ObservationRow>();
  private readonly plans = new Map<string, PlanRow>();
  private readonly planFingerprints = new Map<string, string>();
  private readonly planOperations = new Map<string, PlanOperationRow[]>();
  private readonly workflowRuns = new Map<string, WorkflowRunRow>();
  private readonly workflowRunIdempotency = new Map<string, string>();
  private readonly workflowSteps = new Map<string, WorkflowStepRow>();
  private readonly planReviewAttestations = new Map<string, PlanReviewAttestationRow>();
  private readonly deployments = new Map<string, DeploymentRowInternal>();
  private readonly promotions = new Map<string, PromotionRow>();
  private readonly healthChecks = new Map<string, HealthCheckRow>();
  private readonly driftEvents = new Map<string, DriftEventRow>();
  private readonly reconciliationRequests = new Map<string, ReconciliationRow>();
  private readonly reconciliationFingerprints = new Map<string, string>();
  private readonly providerErrors = new Map<string, ProviderErrorRow>();
  private readonly incidents = new Map<string, IncidentRow>();
  private readonly metricSnapshots: MetricSnapshotRow[] = [];
  private readonly webhookReceipts = new Map<string, WebhookReceiptRow>();
  private readonly cleanupJobs = new Map<string, CleanupJobRow>();
  private readonly tombstones = new Map<string, TombstoneRow>();
  private readonly auditEvents: AuditRow[] = [];
  private readonly credentials = new Map<string, CredentialMetadataRow>();
  private readonly locks = new Map<string, LockRow>();
  private readonly idempotentRequests = new Map<string, IdempotentRequestRow>();
  private readonly deletionApprovals = new Map<string, DeletionApprovalRow>();
  private readonly deletionApprovalByToken = new Map<string, string>();
  private metricSeq = 0;

  constructor(options: StoreOptions = {}) {
    this.options = { now: options.now ?? (() => new Date()) };
  }

  private nowIso(): string {
    return this.options.now().toISOString();
  }

  private requireApplication(applicationId: string): AppRow {
    const row = this.applications.get(applicationId);
    if (!row) throw notFound('Application', applicationId);
    return row;
  }

  private requirePlan(planId: string): PlanRow {
    const row = this.plans.get(planId);
    if (!row) throw notFound('Plan', planId);
    return row;
  }

  private requireWorkflowRun(workflowId: string): WorkflowRunRow {
    const row = this.workflowRuns.get(workflowId);
    if (!row) throw notFound('Workflow run', workflowId);
    return row;
  }

  private requireDeployment(deploymentId: string): DeploymentRowInternal {
    const row = this.deployments.get(deploymentId);
    if (!row) throw notFound('Deployment', deploymentId);
    return row;
  }

  private copyApplication(row: AppRow): ApplicationRecord {
    return { id: row.id, displayName: row.display_name, sourcePath: row.source_path, desiredGeneration: row.desired_generation, desiredHash: row.desired_hash, syncStatus: row.sync_status, healthStatus: row.health_status, lifecycleState: row.lifecycle_state, owners: JSON.parse(row.owners_json) as string[], updatedAt: row.updated_at };
  }

  private copyResource(row: ResourceRow): ResourceRecord {
    return { id: row.id, applicationId: row.application_id, provider: row.provider, resourceType: row.resource_type, resourceKey: row.resource_key, providerResourceId: row.provider_resource_id, desiredGeneration: row.desired_generation, observedHash: row.observed_hash, ownershipFingerprint: row.ownership_fingerprint, status: row.status, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at };
  }

  private copyObservation(row: ObservationRow): ObservationRecord {
    return { id: row.id, applicationId: row.application_id, observedHash: row.observed_hash, payload: JSON.parse(row.payload_json) as ObservedApplication, observedAt: row.observed_at };
  }

  private copyPlan(row: PlanRow): StoredPlanRecord {
    return { id: row.id, applicationId: row.application_id, fingerprint: row.fingerprint, sourceCommit: row.source_commit, result: row.result, plan: JSON.parse(row.payload_json) as PlatformPlan, createdAt: row.created_at };
  }

  private copyWorkflowRun(row: WorkflowRunRow): WorkflowRunRecord {
    return { id: row.id, applicationId: row.application_id, workflowType: row.workflow_type, status: row.status, idempotencyKey: row.idempotency_key, payloadHash: row.payload_hash, startedAt: row.started_at, completedAt: row.completed_at, errorCode: row.error_code };
  }

  private copyWorkflowStep(row: WorkflowStepRow): WorkflowStepRecord {
    return { workflowId: row.workflow_id, stepId: row.step_id, status: row.status, attempt: row.attempt, preconditionHash: row.precondition_hash, result: row.result_json === null ? null : JSON.parse(row.result_json), error: row.error_json === null ? null : JSON.parse(row.error_json) };
  }

  private copyDeployment(row: DeploymentRowInternal): DeploymentRow {
    return { id: row.id, applicationId: row.application_id, projectId: row.project_id, environment: row.environment, repository: row.repository, commitSha: row.commit_sha, desiredGeneration: row.desired_generation, state: row.state, url: row.url, createdAt: row.created_at };
  }

  private copyPromotion(row: PromotionRow): PromotionRecord {
    return { id: row.id, applicationId: row.application_id, deploymentId: row.deployment_id, previousDeploymentId: row.previous_deployment_id, result: row.result, promotedAt: row.promoted_at };
  }

  private copyHealthCheck(row: HealthCheckRow): HealthCheckRecord {
    return { id: row.id, applicationId: row.application_id, environment: row.environment, deploymentId: row.deployment_id, url: row.url, attempt: row.attempt, dnsResolved: row.dns_resolved === 1, tlsValid: row.tls_valid === 1, statusCode: row.status_code, latencyMs: row.latency_ms, assertionResults: JSON.parse(row.assertion_results_json) as HealthCheckRecord['assertionResults'], result: row.result, checkedAt: row.checked_at, errorCode: row.error_code };
  }

  private copyDriftEvent(row: DriftEventRow): DriftEventRecord {
    return { id: row.id, applicationId: row.application_id, fingerprint: row.fingerprint, category: row.category, payload: JSON.parse(row.payload_json) as Record<string, unknown>, observedAt: row.observed_at, resolvedAt: row.resolved_at };
  }

  private copyReconciliation(row: ReconciliationRow): ReconciliationRequestRecord {
    return { id: row.id, applicationId: row.application_id, fingerprint: row.fingerprint, mode: row.mode, pullRequestNumber: row.pull_request_number, pullRequestUrl: row.pull_request_url, status: row.status, openedAt: row.opened_at, resolvedAt: row.resolved_at };
  }

  private copyProviderError(row: ProviderErrorRow): ProviderErrorRecord {
    return { id: row.id, applicationId: row.application_id, operationId: row.operation_id, provider: row.provider, code: row.code, class: row.class, message: row.message, retryable: row.retryable === 1, safeDetails: JSON.parse(row.safe_details_json) as Record<string, unknown>, causeFingerprint: row.cause_fingerprint, remediation: row.remediation, createdAt: row.created_at };
  }

  private copyIncident(row: IncidentRow): IncidentRecord {
    return { id: row.id, type: row.type, fingerprint: row.fingerprint, severity: row.severity, applicationId: row.application_id, operationId: row.operation_id, message: row.message, details: JSON.parse(row.details_json) as Record<string, unknown>, firstSeenAt: row.first_seen_at, lastFiredAt: row.last_fired_at, resolvedAt: row.resolved_at, delivery: JSON.parse(row.delivery_json) as Record<string, unknown> };
  }

  private copyMetricSnapshot(row: MetricSnapshotRow): MetricSnapshotRecord {
    return { id: row.id, metric: row.metric, total: row.total, rate: row.rate, windowSeconds: row.window_seconds, labels: JSON.parse(row.labels_json) as Record<string, string>, capturedAt: row.captured_at };
  }

  private copyWebhookReceipt(row: WebhookReceiptRow): WebhookReceiptRecord {
    return { provider: row.provider, eventId: row.event_id, payload: JSON.parse(row.payload_json) as Record<string, unknown>, receivedAt: row.received_at, dispatchedAt: row.dispatched_at };
  }

  private copyCleanupJob(row: CleanupJobRow): CleanupJobRecord {
    return { id: row.id, applicationId: row.application_id, providerResourceId: row.provider_resource_id, expiresAt: row.expires_at, status: row.status, attempts: row.attempts, lastError: row.last_error };
  }

  private copyTombstone(row: TombstoneRow): TombstoneRecord {
    return { applicationId: row.application_id, domain: row.domain, deletedAt: row.deleted_at, retainUntil: row.retain_until };
  }

  private copyAudit(row: AuditRow): AuditRecord {
    return { id: row.id, actor: row.actor, action: row.action, applicationId: row.application_id, details: JSON.parse(row.details_json) as Record<string, unknown>, createdAt: row.created_at };
  }

  private copyCredential(row: CredentialMetadataRow): CredentialMetadataRecord {
    return { id: row.id, provider: row.provider, purpose: row.purpose, valueFingerprint: row.value_fingerprint, expiresAt: row.expires_at, lastCheckedAt: row.last_checked_at, status: row.status };
  }

  private copyLock(row: LockRow): LockRecord {
    return { resourceKey: row.resource_key, ownerId: row.owner_id, acquiredAt: row.acquired_at, expiresAt: row.expires_at };
  }

  private copyIdempotentRequest(row: IdempotentRequestRow): IdempotentRequestRecord {
    return { idempotencyKey: row.idempotency_key, operationId: row.operation_id, payloadHash: row.payload_hash, createdAt: row.created_at };
  }

  private copyDeletionApproval(row: DeletionApprovalRow): DeletionApprovalRecord {
    return { id: row.id, applicationId: row.application_id, tokenHash: row.token_hash, requestedBy: row.requested_by, status: row.status, expiresAt: row.expires_at, createdAt: row.created_at, usedAt: row.used_at, revokedAt: row.revoked_at };
  }

  private copyDesiredGeneration(row: DesiredGenerationRow): DesiredGenerationRecord {
    return { applicationId: row.application_id, generation: row.generation, desiredHash: row.desired_hash, updatedAt: row.updated_at };
  }

  // applications -----------------------------------------------------------

  async upsertApplication(input: ApplicationUpsert): Promise<ApplicationRecord> {
    if (this.tombstones.has(input.id)) throw conflict('LP-DB-TOMBSTONE-REUSE-BLOCKED', `Application '${input.id}' was deleted and its tombstone blocks reuse`);
    if (input.domain && this.isDomainTombstonedSync(input.domain)) throw conflict('LP-DB-TOMBSTONE-REUSE-BLOCKED', `Domain '${input.domain}' belongs to a deleted application and its tombstone blocks reuse`);
    const existing = this.applications.get(input.id);
    if (existing?.lifecycle_state === 'deleted') throw conflict('LP-DB-APP-DELETED-IMMUTABLE', `Application '${input.id}' is deleted and cannot be re-created`);
    const row: AppRow = { id: input.id, display_name: input.displayName, source_path: input.sourcePath, desired_generation: input.desiredGeneration, desired_hash: input.desiredHash, sync_status: input.syncStatus, health_status: input.healthStatus, lifecycle_state: input.lifecycleState, owners_json: serializeJson(input.owners ?? [], 'application owners'), updated_at: input.updatedAt ?? this.nowIso() };
    this.applications.set(input.id, row);
    return this.copyApplication(row);
  }

  async getApplication(applicationId: string): Promise<ApplicationRecord | null> {
    const row = this.applications.get(applicationId);
    return row ? this.copyApplication(row) : null;
  }

  async updateApplicationStatus(applicationId: string, patch: ApplicationStatusPatch): Promise<ApplicationRecord> {
    const row = this.requireApplication(applicationId);
    if (patch.syncStatus !== undefined) row.sync_status = patch.syncStatus;
    if (patch.healthStatus !== undefined) row.health_status = patch.healthStatus;
    row.updated_at = patch.updatedAt ?? this.nowIso();
    return this.copyApplication(row);
  }

  async setLifecycleState(applicationId: string, state: LifecycleState, updatedAt?: string): Promise<ApplicationRecord> {
    const row = this.requireApplication(applicationId);
    const allowed = ALLOWED_LIFECYCLE_TRANSITIONS[row.lifecycle_state] ?? [];
    if (!allowed.includes(state)) throw conflict('LP-DB-LIFECYCLE-TRANSITION-INVALID', `Cannot move application '${applicationId}' from '${row.lifecycle_state}' to '${state}'`, { from: row.lifecycle_state, to: state });
    row.lifecycle_state = state;
    row.updated_at = updatedAt ?? this.nowIso();
    return this.copyApplication(row);
  }

  // desired generations ----------------------------------------------------

  async advanceDesiredGeneration(input: DesiredGenerationAdvance): Promise<DesiredGenerationRecord> {
    this.requireApplication(input.applicationId);
    if (!Number.isInteger(input.generation) || input.generation < 1) throw invalidArgument('LP-DB-GENERATION-INVALID', 'Desired generation must be a positive integer');
    const existing = this.desiredGenerations.get(input.applicationId);
    if (existing && input.generation <= existing.generation) throw conflict('LP-DB-GENERATION-STALE', `Desired generation for '${input.applicationId}' is already at ${existing.generation}; refusing to regress to ${input.generation}`, { current: existing.generation, attempted: input.generation });
    const row: DesiredGenerationRow = { application_id: input.applicationId, generation: input.generation, desired_hash: input.desiredHash, updated_at: input.updatedAt ?? this.nowIso() };
    this.desiredGenerations.set(input.applicationId, row);
    return this.copyDesiredGeneration(row);
  }

  async getDesiredGeneration(applicationId: string): Promise<DesiredGenerationRecord | null> {
    const row = this.desiredGenerations.get(applicationId);
    return row ? this.copyDesiredGeneration(row) : null;
  }

  // resources --------------------------------------------------------------

  async upsertResource(input: ResourceUpsert): Promise<ResourceRecord> {
    this.requireApplication(input.applicationId);
    const key = `${input.provider}:${input.providerResourceId}`;
    const existing = this.resources.get(key);
    const row: ResourceRow = {
      id: input.id ?? existing?.id ?? stableId('resource', input.provider, input.providerResourceId),
      application_id: input.applicationId,
      provider: input.provider,
      resource_type: input.resourceType,
      resource_key: input.resourceKey,
      provider_resource_id: input.providerResourceId,
      desired_generation: input.desiredGeneration,
      observed_hash: input.observedHash,
      ownership_fingerprint: input.ownershipFingerprint ?? existing?.ownership_fingerprint ?? null,
      status: input.status ?? 'ACTIVE',
      first_seen_at: existing?.first_seen_at ?? input.firstSeenAt ?? this.nowIso(),
      last_seen_at: input.lastSeenAt ?? this.nowIso(),
    };
    this.resources.set(key, row);
    return this.copyResource(row);
  }

  async releaseResource(provider: ProviderName, providerResourceId: string, releasedAt?: string): Promise<ResourceRecord | null> {
    const row = this.resources.get(`${provider}:${providerResourceId}`);
    if (!row) return null;
    if (row.status === 'ACTIVE') {
      row.status = 'RELEASED';
      row.last_seen_at = releasedAt ?? this.nowIso();
    }
    return this.copyResource(row);
  }

  async getResource(provider: ProviderName, providerResourceId: string): Promise<ResourceRecord | null> {
    const row = this.resources.get(`${provider}:${providerResourceId}`);
    return row ? this.copyResource(row) : null;
  }

  async listResources(applicationId: string, options: { includeReleased?: boolean } = {}): Promise<ResourceRecord[]> {
    return [...this.resources.values()].filter((row) => row.application_id === applicationId && (options.includeReleased === true || row.status === 'ACTIVE')).sort((left, right) => left.resource_key.localeCompare(right.resource_key)).map((row) => this.copyResource(row));
  }

  // observations -----------------------------------------------------------

  async recordObservation(input: ObservationUpsert): Promise<ObservationRecord> {
    this.requireApplication(input.applicationId);
    const observedAt = input.observedAt ?? this.nowIso();
    const row: ObservationRow = { id: input.id ?? stableId('observation', input.applicationId, input.observedHash, observedAt), application_id: input.applicationId, observed_hash: input.observedHash, payload_json: serializeJson(input.payload, 'observation'), observed_at: observedAt };
    this.observations.set(row.id, row);
    return this.copyObservation(row);
  }

  async getObservation(id: string): Promise<ObservationRecord | null> {
    const row = this.observations.get(id);
    return row ? this.copyObservation(row) : null;
  }

  async listObservations(applicationId: string, options: { limit?: number } = {}): Promise<ObservationRecord[]> {
    const rows = [...this.observations.values()].filter((row) => row.application_id === applicationId).sort((left, right) => right.observed_at.localeCompare(left.observed_at) || right.id.localeCompare(left.id));
    return rows.slice(0, options.limit).map((row) => this.copyObservation(row));
  }

  // plans ------------------------------------------------------------------

  async savePlan(input: PlanUpsert): Promise<StoredPlanRecord> {
    this.requireApplication(input.applicationId);
    const serialized = serializeJson(input.plan, 'plan');
    const fingerprintKey = `${input.applicationId}:${input.plan.fingerprint}`;
    const existingId = this.planFingerprints.get(fingerprintKey);
    if (existingId) {
      const existing = this.requirePlan(existingId);
      if (existing.payload_json === serialized) return this.copyPlan(existing);
      throw conflict('LP-DB-PLAN-FINGERPRINT-CONFLICT', `A different plan with fingerprint '${input.plan.fingerprint}' is already stored for '${input.applicationId}'`, { applicationId: input.applicationId, fingerprint: input.plan.fingerprint });
    }
    const row: PlanRow = { id: input.id ?? stableId('plan', input.applicationId, input.plan.fingerprint), application_id: input.applicationId, fingerprint: input.plan.fingerprint, source_commit: input.plan.sourceCommit, result: input.plan.result, payload_json: serialized, created_at: input.createdAt ?? this.nowIso() };
    this.plans.set(row.id, row);
    this.planFingerprints.set(fingerprintKey, row.id);
    return this.copyPlan(row);
  }

  async getPlan(id: string): Promise<StoredPlanRecord | null> {
    const row = this.plans.get(id);
    return row ? this.copyPlan(row) : null;
  }

  async getPlanByFingerprint(applicationId: string, fingerprint: string): Promise<StoredPlanRecord | null> {
    const id = this.planFingerprints.get(`${applicationId}:${fingerprint}`);
    if (!id) return null;
    const row = this.plans.get(id);
    return row ? this.copyPlan(row) : null;
  }

  async listPlans(applicationId: string, options: { limit?: number } = {}): Promise<StoredPlanRecord[]> {
    const rows = [...this.plans.values()].filter((row) => row.application_id === applicationId).sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));
    return rows.slice(0, options.limit).map((row) => this.copyPlan(row));
  }

  async replacePlanOperations(planId: string, operations: PlannedOperation[]): Promise<void> {
    this.requirePlan(planId);
    this.planOperations.set(planId, operations.map((operation) => ({ id: operation.id, plan_id: planId, resource_key: operation.resourceKey, action: operation.action, destructive: operation.destructive ? 1 : 0, payload_json: serializeJson(operation, 'plan operation') })));
  }

  async listPlanOperations(planId: string): Promise<PlannedOperation[]> {
    const rows = this.planOperations.get(planId) ?? [];
    return rows.map((row) => JSON.parse(row.payload_json) as PlannedOperation);
  }

  // workflow runs / steps --------------------------------------------------

  async startWorkflowRun(input: WorkflowRunStart): Promise<WorkflowRunRecord> {
    const existingId = this.workflowRunIdempotency.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.requireWorkflowRun(existingId);
      if (existing.payload_hash !== input.payloadHash) throw conflict('LP-DB-IDEMPOTENCY-REUSED', `Idempotency key '${input.idempotencyKey}' was already used with a different payload`, { idempotencyKey: input.idempotencyKey });
      return this.copyWorkflowRun(existing);
    }
    this.requireApplication(input.applicationId);
    const row: WorkflowRunRow = { id: input.id ?? stableId('workflow-run', input.applicationId, input.idempotencyKey), application_id: input.applicationId, workflow_type: input.workflowType, status: 'QUEUED', idempotency_key: input.idempotencyKey, payload_hash: input.payloadHash, started_at: input.startedAt ?? this.nowIso(), completed_at: null, error_code: null };
    this.workflowRuns.set(row.id, row);
    this.workflowRunIdempotency.set(input.idempotencyKey, row.id);
    return this.copyWorkflowRun(row);
  }

  async updateWorkflowRun(id: string, patch: WorkflowRunPatch): Promise<WorkflowRunRecord> {
    const row = this.requireWorkflowRun(id);
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.completedAt !== undefined) row.completed_at = patch.completedAt;
    if (patch.errorCode !== undefined) row.error_code = patch.errorCode;
    return this.copyWorkflowRun(row);
  }

  async cancelWorkflowRun(input: WorkflowRunCancel): Promise<WorkflowRunRecord> {
    const row = this.requireWorkflowRun(input.id);
    if (row.status !== 'QUEUED') throw conflict('LP-DB-CANCEL-NOT-QUEUED', `Workflow run '${input.id}' is '${row.status}'; only QUEUED runs can be canceled`, { id: input.id, status: row.status });
    const canceledAt = input.canceledAt ?? this.nowIso();
    row.status = 'CANCELED';
    row.completed_at = canceledAt;
    row.error_code = null;
    this.auditEvents.push({
      id: input.auditId ?? stableId('audit', input.actor, 'OPERATOR_CANCEL', row.application_id, input.idempotencyKey),
      actor: input.actor,
      action: 'OPERATOR_CANCEL',
      application_id: row.application_id,
      details_json: serializeJson({ operationId: row.id, idempotencyKey: input.idempotencyKey, status: 'CANCELED' }, 'audit details'),
      created_at: canceledAt,
    });
    return this.copyWorkflowRun(row);
  }

  async getWorkflowRun(id: string): Promise<WorkflowRunRecord | null> {
    const row = this.workflowRuns.get(id);
    return row ? this.copyWorkflowRun(row) : null;
  }

  async listWorkflowRuns(applicationId: string, options: { limit?: number } = {}): Promise<WorkflowRunRecord[]> {
    const rows = [...this.workflowRuns.values()].filter((row) => row.application_id === applicationId).sort((left, right) => right.started_at.localeCompare(left.started_at) || right.id.localeCompare(left.id));
    return rows.slice(0, options.limit).map((row) => this.copyWorkflowRun(row));
  }

  async listOpenWorkflowRuns(applicationId: string): Promise<WorkflowRunRecord[]> {
    return [...this.workflowRuns.values()].filter((row) => row.application_id === applicationId && !TERMINAL_WORKFLOW_STATUSES.includes(row.status)).sort((left, right) => left.started_at.localeCompare(right.started_at)).map((row) => this.copyWorkflowRun(row));
  }

  async recordWorkflowStep(input: WorkflowStepUpsert): Promise<WorkflowStepRecord> {
    this.requireWorkflowRun(input.workflowId);
    const row: WorkflowStepRow = { workflow_id: input.workflowId, step_id: input.stepId, status: input.status, attempt: input.attempt, precondition_hash: input.preconditionHash, result_json: input.result === undefined ? null : serializeJson(input.result, 'workflow step result'), error_json: input.error === undefined ? null : serializeJson(input.error, 'workflow step error') };
    this.workflowSteps.set(`${input.workflowId}:${input.stepId}`, row);
    return this.copyWorkflowStep(row);
  }

  async getWorkflowStep(workflowId: string, stepId: string): Promise<WorkflowStepRecord | null> {
    const row = this.workflowSteps.get(`${workflowId}:${stepId}`);
    return row ? this.copyWorkflowStep(row) : null;
  }

  async listWorkflowSteps(workflowId: string): Promise<WorkflowStepRecord[]> {
    return [...this.workflowSteps.values()].filter((row) => row.workflow_id === workflowId).sort((left, right) => left.step_id.localeCompare(right.step_id)).map((row) => this.copyWorkflowStep(row));
  }

  // deployments / promotions / known-good ----------------------------------

  async recordDeployment(input: DeploymentUpsert): Promise<DeploymentRow> {
    this.requireApplication(input.applicationId);
    const row: DeploymentRowInternal = { id: input.id, application_id: input.applicationId, project_id: input.projectId, environment: input.environment, repository: input.repository, commit_sha: input.commitSha, desired_generation: input.desiredGeneration, state: input.state, url: input.url ?? null, created_at: input.createdAt ?? this.nowIso() };
    this.deployments.set(input.id, row);
    return this.copyDeployment(row);
  }

  async getDeployment(id: string): Promise<DeploymentRow | null> {
    const row = this.deployments.get(id);
    return row ? this.copyDeployment(row) : null;
  }

  async listDeployments(applicationId: string, options: { environment?: DeploymentRow['environment']; limit?: number } = {}): Promise<DeploymentRow[]> {
    const rows = [...this.deployments.values()].filter((row) => row.application_id === applicationId && (options.environment === undefined || row.environment === options.environment)).sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));
    return rows.slice(0, options.limit).map((row) => this.copyDeployment(row));
  }

  async recordKnownGoodDeployment(applicationId: string, environment: DeploymentRow['environment'], deploymentId: string, recordedAt?: string): Promise<DeploymentRow> {
    const target = this.requireDeployment(deploymentId);
    if (target.application_id !== applicationId || target.environment !== environment) throw notFound('Deployment', deploymentId);
    for (const row of this.deployments.values()) {
      if (row.application_id === applicationId && row.environment === environment && row.state === 'CURRENT' && row.id !== deploymentId) row.state = 'SUPERSEDED';
    }
    target.state = 'CURRENT';
    target.created_at = recordedAt ?? this.nowIso();
    return this.copyDeployment(target);
  }

  async getKnownGoodDeployment(applicationId: string, environment: DeploymentRow['environment']): Promise<DeploymentRow | null> {
    for (const row of this.deployments.values()) {
      if (row.application_id === applicationId && row.environment === environment && row.state === 'CURRENT') return this.copyDeployment(row);
    }
    return null;
  }

  async recordPromotion(input: PromotionUpsert): Promise<PromotionRecord> {
    this.requireApplication(input.applicationId);
    this.requireDeployment(input.deploymentId);
    const promotedAt = input.promotedAt ?? this.nowIso();
    const row: PromotionRow = { id: input.id ?? stableId('promotion', input.applicationId, input.deploymentId, promotedAt), application_id: input.applicationId, deployment_id: input.deploymentId, previous_deployment_id: input.previousDeploymentId ?? null, result: input.result, promoted_at: promotedAt };
    this.promotions.set(row.id, row);
    return this.copyPromotion(row);
  }

  async listPromotions(applicationId: string, options: { limit?: number } = {}): Promise<PromotionRecord[]> {
    const rows = [...this.promotions.values()].filter((row) => row.application_id === applicationId).sort((left, right) => right.promoted_at.localeCompare(left.promoted_at) || right.id.localeCompare(left.id));
    return rows.slice(0, options.limit).map((row) => this.copyPromotion(row));
  }

  // health checks ----------------------------------------------------------

  async recordHealthCheck(check: HealthCheckRecord): Promise<HealthCheckRecord> {
    this.requireApplication(check.applicationId);
    const row: HealthCheckRow = { id: check.id, application_id: check.applicationId, environment: check.environment, deployment_id: check.deploymentId, url: check.url, attempt: check.attempt, dns_resolved: check.dnsResolved ? 1 : 0, tls_valid: check.tlsValid ? 1 : 0, status_code: check.statusCode, latency_ms: check.latencyMs, assertion_results_json: serializeJson(check.assertionResults, 'health assertion results'), result: check.result, checked_at: check.checkedAt, error_code: check.errorCode };
    this.healthChecks.set(check.id, row);
    return this.copyHealthCheck(row);
  }

  async getHealthCheck(id: string): Promise<HealthCheckRecord | null> {
    const row = this.healthChecks.get(id);
    return row ? this.copyHealthCheck(row) : null;
  }

  async listHealthChecks(applicationId: string, options: { environment?: DeploymentRow['environment']; limit?: number } = {}): Promise<HealthCheckRecord[]> {
    const rows = [...this.healthChecks.values()].filter((row) => row.application_id === applicationId && (options.environment === undefined || row.environment === options.environment)).sort((left, right) => right.checked_at.localeCompare(left.checked_at) || right.id.localeCompare(left.id));
    return rows.slice(0, options.limit).map((row) => this.copyHealthCheck(row));
  }

  async listHealthChecksForDeployment(deploymentId: string): Promise<HealthCheckRecord[]> {
    return [...this.healthChecks.values()].filter((row) => row.deployment_id === deploymentId).sort((left, right) => left.checked_at.localeCompare(right.checked_at)).map((row) => this.copyHealthCheck(row));
  }

  // drift / reconciliation -------------------------------------------------

  async recordDriftEvent(input: DriftEventUpsert): Promise<DriftEventRecord> {
    this.requireApplication(input.applicationId);
    const observedAt = input.observedAt ?? this.nowIso();
    const row: DriftEventRow = { id: input.id ?? stableId('drift-event', input.applicationId, input.fingerprint, observedAt), application_id: input.applicationId, fingerprint: input.fingerprint, category: input.category, payload_json: serializeJson(input.payload, 'drift event'), observed_at: observedAt, resolved_at: null };
    this.driftEvents.set(row.id, row);
    return this.copyDriftEvent(row);
  }

  async resolveDriftEvent(id: string, resolvedAt?: string): Promise<DriftEventRecord> {
    const row = this.driftEvents.get(id);
    if (!row) throw notFound('Drift event', id);
    if (row.resolved_at === null) row.resolved_at = resolvedAt ?? this.nowIso();
    return this.copyDriftEvent(row);
  }

  async listDriftEvents(applicationId: string, options: { includeResolved?: boolean; limit?: number } = {}): Promise<DriftEventRecord[]> {
    const rows = [...this.driftEvents.values()].filter((row) => row.application_id === applicationId && (options.includeResolved === true || row.resolved_at === null)).sort((left, right) => right.observed_at.localeCompare(left.observed_at) || right.id.localeCompare(left.id));
    return rows.slice(0, options.limit).map((row) => this.copyDriftEvent(row));
  }

  async openReconciliationRequest(input: ReconciliationOpen): Promise<ReconciliationRequestRecord> {
    this.requireApplication(input.applicationId);
    const fingerprintKey = `${input.applicationId}:${input.fingerprint}`;
    const existingId = this.reconciliationFingerprints.get(fingerprintKey);
    if (existingId) {
      const existing = this.reconciliationRequests.get(existingId);
      if (existing) {
        if (existing.status === 'OPEN') return this.copyReconciliation(existing);
        existing.status = 'OPEN';
        existing.resolved_at = null;
        existing.mode = input.mode;
        if (input.pullRequestNumber !== undefined) existing.pull_request_number = input.pullRequestNumber;
        if (input.pullRequestUrl !== undefined) existing.pull_request_url = input.pullRequestUrl;
        return this.copyReconciliation(existing);
      }
    }
    const row: ReconciliationRow = { id: input.id ?? stableId('reconciliation', input.applicationId, input.fingerprint), application_id: input.applicationId, fingerprint: input.fingerprint, mode: input.mode, pull_request_number: input.pullRequestNumber ?? null, pull_request_url: input.pullRequestUrl ?? null, status: 'OPEN', opened_at: input.openedAt ?? this.nowIso(), resolved_at: null };
    this.reconciliationRequests.set(row.id, row);
    this.reconciliationFingerprints.set(fingerprintKey, row.id);
    return this.copyReconciliation(row);
  }

  async resolveReconciliationRequest(id: string, status: 'RESOLVED' | 'SUPERSEDED', resolvedAt?: string): Promise<ReconciliationRequestRecord> {
    const row = this.reconciliationRequests.get(id);
    if (!row) throw notFound('Reconciliation request', id);
    if (row.status === 'OPEN') {
      row.status = status;
      row.resolved_at = resolvedAt ?? this.nowIso();
    }
    return this.copyReconciliation(row);
  }

  async getOpenReconciliationRequest(applicationId: string, fingerprint: string): Promise<ReconciliationRequestRecord | null> {
    const id = this.reconciliationFingerprints.get(`${applicationId}:${fingerprint}`);
    if (!id) return null;
    const row = this.reconciliationRequests.get(id);
    return row && row.status === 'OPEN' ? this.copyReconciliation(row) : null;
  }

  async listReconciliationRequests(applicationId: string): Promise<ReconciliationRequestRecord[]> {
    return [...this.reconciliationRequests.values()].filter((row) => row.application_id === applicationId).sort((left, right) => right.opened_at.localeCompare(left.opened_at) || left.id.localeCompare(right.id)).map((row) => this.copyReconciliation(row));
  }

  // provider errors --------------------------------------------------------

  async recordProviderError(input: ProviderErrorUpsert): Promise<ProviderErrorRecord> {
    if (input.applicationId !== undefined && input.applicationId !== null) this.requireApplication(input.applicationId);
    const createdAt = input.createdAt ?? this.nowIso();
    const safeDetailsJson = serializeJson(input.safeDetails ?? {}, 'provider error details');
    const id = input.id ?? stableId('provider-error', input.code, input.message, input.causeFingerprint ?? '', safeDetailsJson, createdAt);
    const row: ProviderErrorRow = { id, application_id: input.applicationId ?? null, operation_id: input.operationId ?? null, provider: input.provider ?? null, code: input.code, class: input.class, message: input.message, retryable: input.retryable ? 1 : 0, safe_details_json: safeDetailsJson, cause_fingerprint: input.causeFingerprint ?? '', remediation: input.remediation ?? '', created_at: createdAt };
    this.providerErrors.set(id, row);
    return this.copyProviderError(row);
  }

  async recordPlatformError(applicationId: string | null, error: PlatformError): Promise<ProviderErrorRecord> {
    return this.recordProviderError({ applicationId, operationId: error.operationId, provider: error.provider, code: error.code, class: error.class, message: error.message, retryable: error.retryable, safeDetails: error.safeDetails, causeFingerprint: error.causeFingerprint, remediation: error.remediation });
  }

  async listProviderErrors(applicationId: string, options: { limit?: number } = {}): Promise<ProviderErrorRecord[]> {
    const rows = [...this.providerErrors.values()].filter((row) => row.application_id === applicationId).sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));
    return rows.slice(0, options.limit).map((row) => this.copyProviderError(row));
  }

  async listProviderErrorsForOperation(operationId: string): Promise<ProviderErrorRecord[]> {
    return [...this.providerErrors.values()].filter((row) => row.operation_id === operationId).sort((left, right) => left.created_at.localeCompare(right.created_at)).map((row) => this.copyProviderError(row));
  }

  // incidents / alerts -----------------------------------------------------

  async recordIncident(input: IncidentUpsert, options: { trackOnly?: boolean } = {}): Promise<IncidentRecord> {
    const firedAt = input.firedAt ?? this.nowIso();
    const detailsJson = serializeJson(input.details ?? {}, 'incident details');
    const deliveryJson = serializeJson(input.delivery ?? {}, 'incident delivery');
    const id = input.id ?? stableId('incident', input.type, input.fingerprint);
    const existing = this.incidents.get(`${input.type}:${input.fingerprint}`);
    const row: IncidentRow = {
      id,
      type: input.type,
      fingerprint: input.fingerprint,
      severity: input.severity,
      application_id: input.applicationId ?? existing?.application_id ?? null,
      operation_id: input.operationId ?? existing?.operation_id ?? null,
      message: input.message,
      details_json: detailsJson,
      first_seen_at: existing?.first_seen_at ?? firedAt,
      last_fired_at: options.trackOnly === true ? (existing?.last_fired_at ?? '1970-01-01T00:00:00.000Z') : firedAt,
      resolved_at: null,
      delivery_json: deliveryJson,
    };
    this.incidents.set(`${input.type}:${input.fingerprint}`, row);
    return this.copyIncident(row);
  }

  async getIncident(type: IncidentRecord['type'], fingerprint: string): Promise<IncidentRecord | null> {
    const row = this.incidents.get(`${type}:${fingerprint}`);
    return row ? this.copyIncident(row) : null;
  }

  async listIncidents(options: { limit?: number; openOnly?: boolean; type?: IncidentRecord['type'] } = {}): Promise<IncidentRecord[]> {
    const rows = [...this.incidents.values()].filter((row) => (options.openOnly === true ? row.resolved_at === null : true) && (options.type === undefined || row.type === options.type)).sort((left, right) => right.last_fired_at.localeCompare(left.last_fired_at) || left.id.localeCompare(right.id));
    return rows.slice(0, options.limit).map((row) => this.copyIncident(row));
  }

  async resolveIncident(id: string, resolvedAt?: string): Promise<IncidentRecord> {
    const row = [...this.incidents.values()].find((candidate) => candidate.id === id);
    if (!row) throw notFound('Incident', id);
    row.resolved_at = row.resolved_at ?? (resolvedAt ?? this.nowIso());
    return this.copyIncident(row);
  }

  // metric snapshots -------------------------------------------------------

  async recordMetricSnapshot(input: MetricSnapshotUpsert): Promise<MetricSnapshotRecord> {
    const capturedAt = input.capturedAt ?? this.nowIso();
    const labelsJson = serializeJson(input.labels ?? {}, 'metric snapshot labels');
    const id = input.id ?? stableId('metric-snapshot', input.metric, capturedAt, String(input.total), labelsJson, String(this.metricSeq++));
    const row: MetricSnapshotRow = { id, metric: input.metric, total: input.total, rate: input.rate ?? null, window_seconds: input.windowSeconds, labels_json: labelsJson, captured_at: capturedAt };
    this.metricSnapshots.push(row);
    return this.copyMetricSnapshot(row);
  }

  async listMetricSnapshots(options: { limit?: number; metric?: string } = {}): Promise<MetricSnapshotRecord[]> {
    const rows = [...this.metricSnapshots].filter((row) => options.metric === undefined || row.metric === options.metric).sort((left, right) => right.captured_at.localeCompare(left.captured_at) || left.id.localeCompare(right.id));
    return rows.slice(0, options.limit).map((row) => this.copyMetricSnapshot(row));
  }

  // webhooks ---------------------------------------------------------------

  async persistWebhookReceipt(input: WebhookReceiptUpsert): Promise<{ inserted: boolean; receipt: WebhookReceiptRecord }> {
    const key = `${input.provider}:${input.eventId}`;
    const existing = this.webhookReceipts.get(key);
    if (existing) return { inserted: false, receipt: this.copyWebhookReceipt(existing) };
    const row: WebhookReceiptRow = { provider: input.provider, event_id: input.eventId, payload_json: serializeJson(input.payload, 'webhook payload'), received_at: input.receivedAt ?? this.nowIso(), dispatched_at: null };
    this.webhookReceipts.set(key, row);
    return { inserted: true, receipt: this.copyWebhookReceipt(row) };
  }

  async getWebhookReceipt(provider: string, eventId: string): Promise<WebhookReceiptRecord | null> {
    const row = this.webhookReceipts.get(`${provider}:${eventId}`);
    return row ? this.copyWebhookReceipt(row) : null;
  }

  async markWebhookReceiptDispatched(provider: string, eventId: string, dispatchedAt?: string): Promise<WebhookReceiptRecord | null> {
    const row = this.webhookReceipts.get(`${provider}:${eventId}`);
    if (!row) return null;
    if (row.dispatched_at === null) {
      row.dispatched_at = dispatchedAt ?? this.nowIso();
      this.webhookReceipts.set(`${provider}:${eventId}`, row);
    }
    return this.copyWebhookReceipt(row);
  }

  // cleanup ----------------------------------------------------------------

  async enqueueCleanupJob(input: CleanupJobUpsert): Promise<CleanupJobRecord> {
    this.requireApplication(input.applicationId);
    const id = input.id ?? stableId('cleanup-job', input.applicationId, input.providerResourceId, input.expiresAt);
    const existing = this.cleanupJobs.get(id);
    if (existing) return this.copyCleanupJob(existing);
    const row: CleanupJobRow = { id, application_id: input.applicationId, provider_resource_id: input.providerResourceId, expires_at: input.expiresAt, status: 'QUEUED', attempts: 0, last_error: null };
    this.cleanupJobs.set(id, row);
    return this.copyCleanupJob(row);
  }

  async claimCleanupJob(id: string): Promise<CleanupJobRecord> {
    const row = this.cleanupJobs.get(id);
    if (!row) throw notFound('Cleanup job', id);
    if (row.status !== 'QUEUED') throw conflict('LP-DB-CLEANUP-NOT-CLAIMABLE', `Cleanup job '${id}' is '${row.status}', not 'QUEUED'`, { id, status: row.status });
    row.status = 'RUNNING';
    row.attempts += 1;
    return this.copyCleanupJob(row);
  }

  async completeCleanupJob(id: string, status: 'SUCCEEDED' | 'FAILED', lastError?: string | null): Promise<CleanupJobRecord> {
    const row = this.cleanupJobs.get(id);
    if (!row) throw notFound('Cleanup job', id);
    if (row.status === 'QUEUED') throw conflict('LP-DB-CLEANUP-NOT-CLAIMABLE', `Cleanup job '${id}' must be claimed before completion`, { id, status: row.status });
    if (row.status === 'SUCCEEDED' || row.status === 'FAILED') return this.copyCleanupJob(row);
    row.status = status;
    row.last_error = lastError ?? null;
    return this.copyCleanupJob(row);
  }

  async listCleanupJobs(applicationId: string): Promise<CleanupJobRecord[]> {
    return [...this.cleanupJobs.values()].filter((row) => row.application_id === applicationId).sort((left, right) => left.expires_at.localeCompare(right.expires_at) || left.id.localeCompare(right.id)).map((row) => this.copyCleanupJob(row));
  }

  async listPendingCleanupJobs(options: { limit?: number } = {}): Promise<CleanupJobRecord[]> {
    const now = this.nowIso();
    const rows = [...this.cleanupJobs.values()].filter((row) => (row.status === 'QUEUED' || row.status === 'RUNNING') && row.expires_at > now).sort((left, right) => left.expires_at.localeCompare(right.expires_at)).slice(0, options.limit);
    return rows.map((row) => this.copyCleanupJob(row));
  }

  // tombstones -------------------------------------------------------------

  async createTombstone(input: TombstoneCreate): Promise<TombstoneRecord> {
    const app = this.requireApplication(input.applicationId);
    if (app.lifecycle_state !== 'deleted') throw conflict('LP-DB-TOMBSTONE-APP-NOT-DELETED', `Application '${input.applicationId}' must reach lifecycle 'deleted' before it can be tombstoned`, { lifecycleState: app.lifecycle_state });
    if (this.tombstones.has(input.applicationId)) throw conflict('LP-DB-ALREADY-TOMBSTONED', `Application '${input.applicationId}' is already tombstoned`);
    if (this.isDomainTombstonedSync(input.domain)) throw conflict('LP-DB-TOMBSTONE-REUSE-BLOCKED', `Domain '${input.domain}' already belongs to a tombstoned application`);
    const row: TombstoneRow = { application_id: input.applicationId, domain: input.domain, deleted_at: input.deletedAt ?? this.nowIso(), retain_until: input.retainUntil };
    this.tombstones.set(input.applicationId, row);
    return this.copyTombstone(row);
  }

  private isDomainTombstonedSync(domain: string): boolean {
    for (const row of this.tombstones.values()) {
      if (row.domain === domain) return true;
    }
    return false;
  }

  async getTombstone(applicationId: string): Promise<TombstoneRecord | null> {
    const row = this.tombstones.get(applicationId);
    return row ? this.copyTombstone(row) : null;
  }

  async isTombstoned(applicationId: string): Promise<boolean> {
    return this.tombstones.has(applicationId);
  }

  async releaseTombstone(input: TombstoneRelease): Promise<TombstoneRecord> {
    if (input.reviewedBy.trim().length === 0) throw invalidArgument('LP-DB-TOMBSTONE-RELEASE-REVIEWER-REQUIRED', 'Releasing a tombstone requires a reviewer identity');
    if (input.reason.trim().length === 0) throw invalidArgument('LP-DB-TOMBSTONE-RELEASE-REASON-REQUIRED', 'Releasing a tombstone requires a reason');
    const row = this.tombstones.get(input.applicationId);
    if (!row) throw notFound('Tombstone', input.applicationId);
    this.tombstones.delete(input.applicationId);
    return this.copyTombstone(row);
  }

  async isDomainTombstoned(domain: string): Promise<boolean> {
    return this.isDomainTombstonedSync(domain);
  }

  // audit (append-only) ----------------------------------------------------

  async appendAudit(input: AuditAppend): Promise<AuditRecord> {
    // Default ids are globally unique (readable prefix + v4 UUID) so that
    // concurrent instances or isolate restarts can never collide, even for
    // identical actor/action/application at the same time. Explicit caller
    // ids are used verbatim for idempotent replay.
    const row: AuditRow = { id: input.id ?? `audit-${crypto.randomUUID()}`, actor: input.actor, action: input.action, application_id: input.applicationId ?? null, details_json: serializeJson(input.details ?? {}, 'audit details'), created_at: input.createdAt ?? this.nowIso() };
    this.auditEvents.push(row);
    return this.copyAudit(row);
  }

  async listAudit(applicationId: string, options: { limit?: number } = {}): Promise<AuditRecord[]> {
    const rows = this.auditEvents.filter((row) => row.application_id === applicationId);
    return rows.slice(-(options.limit ?? rows.length)).map((row) => this.copyAudit(row));
  }

  async listAuditAll(options: { limit?: number } = {}): Promise<AuditRecord[]> {
    const rows = this.auditEvents;
    return rows.slice(-(options.limit ?? rows.length)).map((row) => this.copyAudit(row));
  }

  // credentials metadata ---------------------------------------------------

  async upsertCredentialMetadata(input: CredentialMetadataUpsert): Promise<CredentialMetadataRecord> {
    const row: CredentialMetadataRow = { id: input.id, provider: input.provider, purpose: input.purpose, value_fingerprint: input.valueFingerprint ?? null, expires_at: input.expiresAt ?? null, last_checked_at: input.lastCheckedAt, status: input.status };
    this.credentials.set(input.id, row);
    return this.copyCredential(row);
  }

  async getCredentialMetadata(id: string): Promise<CredentialMetadataRecord | null> {
    const row = this.credentials.get(id);
    return row ? this.copyCredential(row) : null;
  }

  async listCredentialsMetadata(provider?: ProviderName): Promise<CredentialMetadataRecord[]> {
    return [...this.credentials.values()].filter((row) => provider === undefined || row.provider === provider).sort((left, right) => left.id.localeCompare(right.id)).map((row) => this.copyCredential(row));
  }

  async updateCredentialStatus(id: string, status: CredentialStatus, lastCheckedAt: string): Promise<CredentialMetadataRecord> {
    const row = this.credentials.get(id);
    if (!row) throw notFound('Credential metadata', id);
    row.status = status;
    row.last_checked_at = lastCheckedAt;
    return this.copyCredential(row);
  }

  // locks ------------------------------------------------------------------

  async acquireLock(resourceKey: string, ownerId: string, leaseSeconds: number, now?: string): Promise<boolean> {
    validateLockKey(resourceKey);
    const nowIso = now ?? this.nowIso();
    const expiresAt = new Date(Date.parse(nowIso) + leaseSeconds * 1000).toISOString();
    const current = this.locks.get(resourceKey);
    if (current && current.expires_at > nowIso && current.owner_id !== ownerId) return false;
    this.locks.set(resourceKey, { resource_key: resourceKey, owner_id: ownerId, acquired_at: nowIso, expires_at: expiresAt });
    return true;
  }

  async renewLock(resourceKey: string, ownerId: string, leaseSeconds: number, now?: string): Promise<boolean> {
    validateLockKey(resourceKey);
    const nowIso = now ?? this.nowIso();
    const current = this.locks.get(resourceKey);
    if (!current || current.owner_id !== ownerId || current.expires_at <= nowIso) return false;
    current.expires_at = new Date(Date.parse(nowIso) + leaseSeconds * 1000).toISOString();
    return true;
  }

  async releaseLock(resourceKey: string, ownerId: string): Promise<boolean> {
    const current = this.locks.get(resourceKey);
    if (!current || current.owner_id !== ownerId) return false;
    this.locks.delete(resourceKey);
    return true;
  }

  async getLock(resourceKey: string): Promise<LockRecord | null> {
    const row = this.locks.get(resourceKey);
    return row ? this.copyLock(row) : null;
  }

  // idempotent requests ----------------------------------------------------

  async registerIdempotentRequest(input: IdempotentRequestRegister): Promise<IdempotentRequestRecord> {
    const existing = this.idempotentRequests.get(input.idempotencyKey);
    if (existing) {
      if (existing.payload_hash !== input.payloadHash) throw conflict('LP-DB-IDEMPOTENCY-REUSED', `Idempotency key '${input.idempotencyKey}' was already registered with a different payload`, { idempotencyKey: input.idempotencyKey });
      return this.copyIdempotentRequest(existing);
    }
    this.requireWorkflowRun(input.operationId);
    const row: IdempotentRequestRow = { idempotency_key: input.idempotencyKey, operation_id: input.operationId, payload_hash: input.payloadHash, created_at: input.createdAt ?? this.nowIso() };
    this.idempotentRequests.set(input.idempotencyKey, row);
    return this.copyIdempotentRequest(row);
  }

  async getIdempotentRequest(idempotencyKey: string): Promise<IdempotentRequestRecord | null> {
    const row = this.idempotentRequests.get(idempotencyKey);
    return row ? this.copyIdempotentRequest(row) : null;
  }

  // reviewed-plan attestations (plan-approval gate) ------------------------

  private copyPlanReviewAttestation(row: PlanReviewAttestationRow): PlanReviewAttestationRecord {
    return { id: row.id, applicationId: row.application_id, prHeadSourceCommit: row.pr_head_source_commit, desiredHash: row.desired_hash, generation: row.generation, planFingerprint: row.plan_fingerprint, reviewFingerprint: row.review_fingerprint, repository: row.repository, actor: row.actor, workflowRef: row.workflow_ref, createdAt: row.created_at };
  }

  async savePlanReviewAttestation(input: PlanReviewAttestationUpsert): Promise<{ inserted: boolean; attestation: PlanReviewAttestationRecord }> {
    this.requireApplication(input.applicationId);
    for (const existing of this.planReviewAttestations.values()) {
      if (existing.application_id === input.applicationId && existing.review_fingerprint === input.reviewFingerprint) {
        if (existing.desired_hash !== input.desiredHash || existing.generation !== input.generation || existing.plan_fingerprint !== input.planFingerprint || existing.repository !== input.repository) {
          throw conflict('LP-DB-PLAN-REVIEW-REPLAY-CONFLICT', `A reviewed-plan attestation for review fingerprint '${input.reviewFingerprint}' is already stored for '${input.applicationId}' with a different desired-state binding`, { applicationId: input.applicationId, reviewFingerprint: input.reviewFingerprint });
        }
        return { inserted: false, attestation: this.copyPlanReviewAttestation(existing) };
      }
    }
    const row: PlanReviewAttestationRow = { id: input.id ?? stableId('plan-review', input.applicationId, input.reviewFingerprint), application_id: input.applicationId, pr_head_source_commit: input.prHeadSourceCommit, desired_hash: input.desiredHash, generation: input.generation, plan_fingerprint: input.planFingerprint, review_fingerprint: input.reviewFingerprint, repository: input.repository, actor: input.actor, workflow_ref: input.workflowRef, created_at: input.createdAt ?? this.nowIso() };
    this.planReviewAttestations.set(row.id, row);
    return { inserted: true, attestation: this.copyPlanReviewAttestation(row) };
  }

  async getPlanReviewAttestation(applicationId: string, reviewFingerprint: string): Promise<PlanReviewAttestationRecord | null> {
    for (const row of this.planReviewAttestations.values()) {
      if (row.application_id === applicationId && row.review_fingerprint === reviewFingerprint) return this.copyPlanReviewAttestation(row);
    }
    return null;
  }

  async listPlanReviewAttestations(applicationId: string, options: { limit?: number } = {}): Promise<PlanReviewAttestationRecord[]> {
    const rows = [...this.planReviewAttestations.values()].filter((row) => row.application_id === applicationId).sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));
    return rows.slice(0, options.limit).map((row) => this.copyPlanReviewAttestation(row));
  }

  // deletion approvals (single-use) ----------------------------------------

  async createDeletionApproval(input: DeletionApprovalCreate): Promise<DeletionApprovalRecord> {
    this.requireApplication(input.applicationId);
    const tokenHash = await sha256Hex(input.token);
    const tokenKey = `${input.applicationId}:${tokenHash}`;
    if (this.deletionApprovalByToken.has(tokenKey)) throw conflict('LP-DB-APPROVAL-EXISTS', 'A pending deletion approval with this token already exists for this application');
    const row: DeletionApprovalRow = { id: input.id ?? stableId('deletion-approval', input.applicationId, tokenHash), application_id: input.applicationId, token_hash: tokenHash, requested_by: input.requestedBy ?? null, status: 'PENDING', expires_at: input.expiresAt, created_at: input.createdAt ?? this.nowIso(), used_at: null, revoked_at: null };
    this.deletionApprovals.set(row.id, row);
    this.deletionApprovalByToken.set(tokenKey, row.id);
    return this.copyDeletionApproval(row);
  }

  async consumeDeletionApproval(applicationId: string, token: string, consumedAt?: string): Promise<DeletionApprovalRecord> {
    const tokenHash = await sha256Hex(token);
    const id = this.deletionApprovalByToken.get(`${applicationId}:${tokenHash}`);
    if (!id) throw notFound('Deletion approval', `application '${applicationId}'`);
    const row = this.deletionApprovals.get(id);
    if (!row) throw notFound('Deletion approval', id);
    if (row.status === 'USED') throw conflict('LP-DB-APPROVAL-USED', `Deletion approval '${id}' was already consumed`, { id });
    if (row.status === 'REVOKED') throw conflict('LP-DB-APPROVAL-REVOKED', `Deletion approval '${id}' was revoked`, { id });
    const nowIso = consumedAt ?? this.nowIso();
    if (row.expires_at < nowIso) {
      row.status = 'EXPIRED';
      throw conflict('LP-DB-APPROVAL-EXPIRED', `Deletion approval '${id}' expired at ${row.expires_at}`, { id, expiresAt: row.expires_at });
    }
    row.status = 'USED';
    row.used_at = nowIso;
    return this.copyDeletionApproval(row);
  }

  async revokeDeletionApproval(id: string, revokedAt?: string): Promise<DeletionApprovalRecord> {
    const row = this.deletionApprovals.get(id);
    if (!row) throw notFound('Deletion approval', id);
    if (row.status !== 'PENDING') throw conflict('LP-DB-APPROVAL-NOT-PENDING', `Deletion approval '${id}' is '${row.status}', only pending approvals can be revoked`, { id, status: row.status });
    row.status = 'REVOKED';
    row.revoked_at = revokedAt ?? this.nowIso();
    return this.copyDeletionApproval(row);
  }

  async listDeletionApprovals(applicationId: string): Promise<DeletionApprovalRecord[]> {
    return [...this.deletionApprovals.values()].filter((row) => row.application_id === applicationId).sort((left, right) => right.created_at.localeCompare(left.created_at) || left.id.localeCompare(right.id)).map((row) => this.copyDeletionApproval(row));
  }

  // dashboard query models -------------------------------------------------

  async listApplications(): Promise<DashboardApplicationRow[]> {
    return [...this.applications.values()].sort((left, right) => left.id.localeCompare(right.id)).map((row) => {
      const knownGood = [...this.deployments.values()].find((deployment) => deployment.application_id === row.id && deployment.environment === 'production' && deployment.state === 'CURRENT');
      const openRuns = [...this.workflowRuns.values()].filter((run) => run.application_id === row.id && !TERMINAL_WORKFLOW_STATUSES.includes(run.status));
      const lastReconciled = [...this.reconciliationRequests.values()].filter((request) => request.application_id === row.id && request.status === 'RESOLVED' && request.resolved_at !== null).map((request) => request.resolved_at ?? '').sort().at(-1) ?? null;
      const openReconciliation = [...this.reconciliationRequests.values()].find((request) => request.application_id === row.id && request.status === 'OPEN' && request.pull_request_url !== null);
      const owners = JSON.parse(row.owners_json) as string[];
      return { application: row.id, displayName: row.display_name, owners, owner: owners[0] ?? 'unassigned', sync: row.sync_status, health: row.health_status, deployment: knownGood?.state ?? null, currentDeploymentCommit: knownGood?.commit_sha ?? null, productionUrl: knownGood?.url ?? null, lastSuccessfulReconciliation: lastReconciled, activeOperation: openRuns.length > 0 ? (openRuns.map((run) => run.status).sort()[0] ?? null) : null, openPrOrIncident: openReconciliation?.pull_request_url ?? null, updatedAt: row.updated_at };
    });
  }

  async getApplicationDetail(applicationId: string): Promise<ApplicationDetail> {
    const app = await this.getApplication(applicationId);
    if (!app) return { application: null, knownGoodDeployment: null, latestHealthCheck: null, openWorkflowRuns: [], recentWorkflowRuns: [] };
    const knownGoodDeployment = await this.getKnownGoodDeployment(applicationId, 'production');
    const healthRows = [...this.healthChecks.values()].filter((row) => row.application_id === applicationId).sort((left, right) => right.checked_at.localeCompare(left.checked_at)).slice(0, 1);
    const openWorkflowRuns = await this.listOpenWorkflowRuns(applicationId);
    const recentWorkflowRuns = await this.listWorkflowRuns(applicationId, { limit: 10 });
    return { application: app, knownGoodDeployment, latestHealthCheck: healthRows[0] ? this.copyHealthCheck(healthRows[0]) : null, openWorkflowRuns, recentWorkflowRuns };
  }
}
