import type { DeploymentRecord, EnvironmentName, HealthCheckRecord, LifecycleState, ObservedApplication, PlannedOperation, PlatformError, PlatformPlan, ProviderName } from '@launchpad/core';
import { invalidArgument } from './errors.js';
import type {
  ApplicationDetail,
  ApplicationRecord,
  AuditRecord,
  CleanupJobRecord,
  CredentialMetadataRecord,
  CredentialStatus,
  DashboardApplicationRow,
  DeletionApprovalRecord,
  DeploymentRow,
  DesiredGenerationRecord,
  DriftEventRecord,
  HealthStatus,
  IdempotentRequestRecord,
  IncidentRecord,
  IncidentSeverity,
  IncidentType,
  LockRecord,
  MetricSnapshotRecord,
  ObservationRecord,
  PlanReviewAttestationRecord,
  PromotionRecord,
  ProviderErrorRecord,
  ReconciliationMode,
  ReconciliationRequestRecord,
  ResourceOwnershipStatus,
  ResourceRecord,
  StoredPlanRecord,
  SyncStatus,
  TombstoneRecord,
  WebhookReceiptRecord,
  WorkflowRunRecord,
  WorkflowStepRecord,
} from './types.js';

/**
 * The async, provider-neutral Launchpad store (master plan section 23).
 * One implementation backs D1 (`D1LaunchpadStore`) and one backs an
 * in-memory database (`InMemoryLaunchpadStore`); both enforce the same
 * invariants and share the same contract test suite.
 *
 * Invariants enforced by every implementation:
 * - one active resource-ownership record per provider resource ID;
 * - one active application lock per application and one active domain lock
 *   per hostname, both expiring;
 * - one known-good (`CURRENT`) production deployment per application/
 *   environment;
 * - one open reconciliation request per application and drift fingerprint;
 * - secret values are rejected from every column (serialization fails
 *   closed when a `SensitiveValue` is present);
 * - audit events are append-only and immutable after insertion;
 * - tombstones block application/domain reuse;
 * - deletion approvals are single-use; only token fingerprints are stored;
 * - idempotency keys are application-scoped, deterministic, and reject
 *   payload changes.
 */

export interface StoreOptions {
  /** Clock used for all timestamps; injectable for deterministic tests. */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface ApplicationUpsert {
  id: string;
  displayName: string;
  sourcePath: string;
  desiredGeneration: number;
  desiredHash: string;
  syncStatus: SyncStatus;
  healthStatus: HealthStatus;
  lifecycleState: LifecycleState;
  owners?: string[];
  /** Primary domain, checked against tombstones for reuse blocking. */
  domain?: string | null;
  updatedAt?: string;
}

export interface ApplicationStatusPatch {
  syncStatus?: SyncStatus;
  healthStatus?: HealthStatus;
  updatedAt?: string;
}

export interface DesiredGenerationAdvance {
  applicationId: string;
  generation: number;
  desiredHash: string;
  updatedAt?: string;
}

export interface ResourceUpsert {
  id?: string;
  applicationId: string;
  provider: ProviderName;
  resourceType: string;
  resourceKey: string;
  providerResourceId: string;
  desiredGeneration: number;
  observedHash: string;
  ownershipFingerprint?: string | null;
  status?: ResourceOwnershipStatus;
  firstSeenAt?: string;
  lastSeenAt?: string;
}

export interface ObservationUpsert {
  id?: string;
  applicationId: string;
  observedHash: string;
  payload: ObservedApplication;
  observedAt?: string;
}

export interface PlanUpsert {
  id?: string;
  applicationId: string;
  plan: PlatformPlan;
  createdAt?: string;
}

export interface WorkflowRunStart {
  id?: string;
  applicationId: string;
  workflowType: string;
  idempotencyKey: string;
  payloadHash: string;
  startedAt?: string;
}

export interface WorkflowRunPatch {
  status?: WorkflowRunRecord['status'];
  completedAt?: string | null;
  errorCode?: string | null;
}

/**
 * Operator-requested cancel of a queued workflow run. The QUEUED -> CANCELED
 * transition and its immutable audit event are applied atomically; a run in
 * any other state (RUNNING, a mid-machine state, or a terminal state) is
 * rejected with a conflict and nothing is written.
 */
export interface WorkflowRunCancel {
  /** The workflow run to cancel. */
  id: string;
  /** Operator identity recorded on the immutable audit event. */
  actor: string;
  /** Deterministic idempotency key, recorded in the audit details so replays of the same cancel are attributable. */
  idempotencyKey: string;
  /** Optional deterministic audit id; defaults to a stable id derived from actor/action/application/key. */
  auditId?: string;
  canceledAt?: string;
}

export interface WorkflowStepUpsert {
  workflowId: string;
  stepId: string;
  status: WorkflowStepRecord['status'];
  attempt: number;
  preconditionHash: string;
  result?: unknown;
  error?: unknown;
}

export interface DeploymentUpsert {
  id: string;
  applicationId: string;
  projectId: string;
  environment: EnvironmentName;
  repository: string;
  commitSha: string;
  desiredGeneration: number;
  state: DeploymentRecord['state'];
  url?: string | null;
  createdAt?: string;
}

export interface PromotionUpsert {
  id?: string;
  applicationId: string;
  deploymentId: string;
  previousDeploymentId?: string | null;
  result: string;
  promotedAt?: string;
}

export interface DriftEventUpsert {
  id?: string;
  applicationId: string;
  fingerprint: string;
  category: string;
  payload: Record<string, unknown>;
  observedAt?: string;
}

export interface ReconciliationOpen {
  id?: string;
  applicationId: string;
  fingerprint: string;
  mode: ReconciliationMode;
  pullRequestNumber?: number | null;
  pullRequestUrl?: string | null;
  openedAt?: string;
}

export interface ProviderErrorUpsert {
  id?: string;
  applicationId?: string | null;
  operationId?: string | null;
  provider?: ProviderName | null;
  code: string;
  class: ProviderErrorRecord['class'];
  message: string;
  retryable: boolean;
  safeDetails?: Record<string, unknown>;
  causeFingerprint?: string;
  remediation?: string | null;
  createdAt?: string;
}

export interface IncidentUpsert {
  id?: string;
  type: IncidentType;
  fingerprint: string;
  severity: IncidentSeverity;
  applicationId?: string | null;
  operationId?: string | null;
  message: string;
  details?: Record<string, unknown>;
  firedAt?: string;
  delivery?: Record<string, unknown>;
}

export interface MetricSnapshotUpsert {
  id?: string;
  metric: string;
  total: number;
  rate?: number | null;
  windowSeconds: number;
  labels?: Record<string, string>;
  capturedAt?: string;
}

export interface WebhookReceiptUpsert {
  provider: string;
  eventId: string;
  payload: Record<string, unknown>;
  receivedAt?: string;
}

export interface CleanupJobUpsert {
  id?: string;
  applicationId: string;
  providerResourceId: string;
  expiresAt: string;
}

export interface TombstoneCreate {
  applicationId: string;
  domain: string;
  deletedAt?: string;
  retainUntil: string;
}

export interface AuditAppend {
  id?: string;
  actor: string;
  action: string;
  applicationId?: string | null;
  details?: Record<string, unknown>;
  createdAt?: string;
}

export interface CredentialMetadataUpsert {
  id: string;
  provider: ProviderName;
  purpose: string;
  valueFingerprint?: string | null;
  expiresAt?: string | null;
  lastCheckedAt: string;
  status: CredentialStatus;
}

export interface IdempotentRequestRegister {
  idempotencyKey: string;
  operationId: string;
  payloadHash: string;
  createdAt?: string;
}

export interface PlanReviewAttestationUpsert {
  id?: string;
  applicationId: string;
  /** Exact PR head commit the reviewed plan was computed at. */
  prHeadSourceCommit: string;
  /** Hash of the redacted desired manifest the reviewed plan targets. */
  desiredHash: string;
  /** Desired generation the reviewed plan targets. */
  generation: number;
  /** Exact plan fingerprint at the PR head (includes the PR head commit). */
  planFingerprint: string;
  /** Source-commit-neutral review fingerprint of the reviewed plan. */
  reviewFingerprint: string;
  /** OIDC claim-bound repository (`owner/name`) of the reviewing workflow. */
  repository: string;
  /** OIDC claim-bound actor of the reviewing workflow. */
  actor: string;
  /** OIDC claim-bound workflow ref that performed the review. */
  workflowRef: string;
  createdAt?: string;
}

export interface DeletionApprovalCreate {
  id?: string;
  applicationId: string;
  /** The raw approval token; only its sha256 fingerprint is persisted. */
  token: string;
  requestedBy?: string | null;
  expiresAt: string;
  createdAt?: string;
}

/**
 * Reviewed release of a tombstone so a deleted application ID or domain can
 * be reused. Only reachable through the reviewed override path (retention
 * elapsed, or an operator-supplied review evidence record); the identity and
 * reason are mandatory so the release is always attributable.
 */
export interface TombstoneRelease {
  applicationId: string;
  /** Operator identity authorizing the release (reviewed override or retention expiry). */
  reviewedBy: string;
  /** Required non-empty reason, recorded in the release and the audit trail. */
  reason: string;
  reviewedAt?: string;
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface LaunchpadStore {
  // applications -----------------------------------------------------------
  upsertApplication(input: ApplicationUpsert): Promise<ApplicationRecord>;
  getApplication(applicationId: string): Promise<ApplicationRecord | null>;
  updateApplicationStatus(applicationId: string, patch: ApplicationStatusPatch): Promise<ApplicationRecord>;
  setLifecycleState(applicationId: string, state: LifecycleState, updatedAt?: string): Promise<ApplicationRecord>;

  // desired generations ----------------------------------------------------
  advanceDesiredGeneration(input: DesiredGenerationAdvance): Promise<DesiredGenerationRecord>;
  getDesiredGeneration(applicationId: string): Promise<DesiredGenerationRecord | null>;

  // resources / ownership --------------------------------------------------
  upsertResource(input: ResourceUpsert): Promise<ResourceRecord>;
  releaseResource(provider: ProviderName, providerResourceId: string, releasedAt?: string): Promise<ResourceRecord | null>;
  getResource(provider: ProviderName, providerResourceId: string): Promise<ResourceRecord | null>;
  listResources(applicationId: string, options?: { includeReleased?: boolean }): Promise<ResourceRecord[]>;

  // observations -----------------------------------------------------------
  recordObservation(input: ObservationUpsert): Promise<ObservationRecord>;
  getObservation(id: string): Promise<ObservationRecord | null>;
  listObservations(applicationId: string, options?: { limit?: number }): Promise<ObservationRecord[]>;

  // plans and plan operations ----------------------------------------------
  savePlan(input: PlanUpsert): Promise<StoredPlanRecord>;
  getPlan(id: string): Promise<StoredPlanRecord | null>;
  getPlanByFingerprint(applicationId: string, fingerprint: string): Promise<StoredPlanRecord | null>;
  listPlans(applicationId: string, options?: { limit?: number }): Promise<StoredPlanRecord[]>;
  replacePlanOperations(planId: string, operations: PlannedOperation[]): Promise<void>;
  listPlanOperations(planId: string): Promise<PlannedOperation[]>;

  // workflow runs / steps --------------------------------------------------
  startWorkflowRun(input: WorkflowRunStart): Promise<WorkflowRunRecord>;
  updateWorkflowRun(id: string, patch: WorkflowRunPatch): Promise<WorkflowRunRecord>;
  /**
   * Atomically transitions exactly the matching QUEUED workflow run to
   * CANCELED and appends its immutable audit event in the same transaction.
   * Throws a CONFLICT when the run is not QUEUED (RUNNING, mid-machine, or
   * terminal); nothing is written in that case.
   */
  cancelWorkflowRun(input: WorkflowRunCancel): Promise<WorkflowRunRecord>;
  getWorkflowRun(id: string): Promise<WorkflowRunRecord | null>;
  listWorkflowRuns(applicationId: string, options?: { limit?: number }): Promise<WorkflowRunRecord[]>;
  listOpenWorkflowRuns(applicationId: string): Promise<WorkflowRunRecord[]>;
  recordWorkflowStep(input: WorkflowStepUpsert): Promise<WorkflowStepRecord>;
  getWorkflowStep(workflowId: string, stepId: string): Promise<WorkflowStepRecord | null>;
  listWorkflowSteps(workflowId: string): Promise<WorkflowStepRecord[]>;

  // deployments / promotions / known-good ----------------------------------
  recordDeployment(input: DeploymentUpsert): Promise<DeploymentRow>;
  getDeployment(id: string): Promise<DeploymentRow | null>;
  listDeployments(applicationId: string, options?: { environment?: EnvironmentName; limit?: number }): Promise<DeploymentRow[]>;
  recordKnownGoodDeployment(applicationId: string, environment: EnvironmentName, deploymentId: string, recordedAt?: string): Promise<DeploymentRow>;
  getKnownGoodDeployment(applicationId: string, environment: EnvironmentName): Promise<DeploymentRow | null>;
  recordPromotion(input: PromotionUpsert): Promise<PromotionRecord>;
  listPromotions(applicationId: string, options?: { limit?: number }): Promise<PromotionRecord[]>;

  // health checks ----------------------------------------------------------
  recordHealthCheck(check: HealthCheckRecord): Promise<HealthCheckRecord>;
  getHealthCheck(id: string): Promise<HealthCheckRecord | null>;
  listHealthChecks(applicationId: string, options?: { environment?: EnvironmentName; limit?: number }): Promise<HealthCheckRecord[]>;
  listHealthChecksForDeployment(deploymentId: string): Promise<HealthCheckRecord[]>;

  // drift / reconciliation -------------------------------------------------
  recordDriftEvent(input: DriftEventUpsert): Promise<DriftEventRecord>;
  resolveDriftEvent(id: string, resolvedAt?: string): Promise<DriftEventRecord>;
  listDriftEvents(applicationId: string, options?: { includeResolved?: boolean; limit?: number }): Promise<DriftEventRecord[]>;
  openReconciliationRequest(input: ReconciliationOpen): Promise<ReconciliationRequestRecord>;
  resolveReconciliationRequest(id: string, status: 'RESOLVED' | 'SUPERSEDED', resolvedAt?: string): Promise<ReconciliationRequestRecord>;
  getOpenReconciliationRequest(applicationId: string, fingerprint: string): Promise<ReconciliationRequestRecord | null>;
  listReconciliationRequests(applicationId: string): Promise<ReconciliationRequestRecord[]>;

  // provider errors --------------------------------------------------------
  recordProviderError(input: ProviderErrorUpsert): Promise<ProviderErrorRecord>;
  recordPlatformError(applicationId: string | null, error: PlatformError): Promise<ProviderErrorRecord>;
  listProviderErrors(applicationId: string, options?: { limit?: number }): Promise<ProviderErrorRecord[]>;
  listProviderErrorsForOperation(operationId: string): Promise<ProviderErrorRecord[]>;

  // incidents / alerts -----------------------------------------------------
  /**
   * Upserts one incident per (type, fingerprint): refires reopen the same
   * row. With `trackOnly`, the row keeps its lastFiredAt (used as a
   * below-threshold counter that never suppresses a later firing).
   */
  recordIncident(input: IncidentUpsert, options?: { trackOnly?: boolean }): Promise<IncidentRecord>;
  getIncident(type: IncidentType, fingerprint: string): Promise<IncidentRecord | null>;
  listIncidents(options?: { limit?: number; openOnly?: boolean; type?: IncidentType }): Promise<IncidentRecord[]>;
  resolveIncident(id: string, resolvedAt?: string): Promise<IncidentRecord>;

  // metric snapshots -------------------------------------------------------
  recordMetricSnapshot(input: MetricSnapshotUpsert): Promise<MetricSnapshotRecord>;
  listMetricSnapshots(options?: { limit?: number; metric?: string }): Promise<MetricSnapshotRecord[]>;

  // webhooks ---------------------------------------------------------------
  persistWebhookReceipt(input: WebhookReceiptUpsert): Promise<{ inserted: boolean; receipt: WebhookReceiptRecord }>;
  getWebhookReceipt(provider: string, eventId: string): Promise<WebhookReceiptRecord | null>;
  /** Marks a receipt as dispatched (first writer wins; idempotent). Returns the updated receipt, or null when no receipt exists. */
  markWebhookReceiptDispatched(provider: string, eventId: string, dispatchedAt?: string): Promise<WebhookReceiptRecord | null>;

  // cleanup ----------------------------------------------------------------
  enqueueCleanupJob(input: CleanupJobUpsert): Promise<CleanupJobRecord>;
  claimCleanupJob(id: string): Promise<CleanupJobRecord>;
  completeCleanupJob(id: string, status: 'SUCCEEDED' | 'FAILED', lastError?: string | null): Promise<CleanupJobRecord>;
  listCleanupJobs(applicationId: string): Promise<CleanupJobRecord[]>;
  listPendingCleanupJobs(options?: { limit?: number }): Promise<CleanupJobRecord[]>;
  /** Cleanup jobs whose retention window has elapsed: QUEUED with `expires_at <= now`, oldest first. Drives the scheduled cleanup sweep. */
  listDueCleanupJobs(options?: { limit?: number; now?: string }): Promise<CleanupJobRecord[]>;

  // tombstones -------------------------------------------------------------
  createTombstone(input: TombstoneCreate): Promise<TombstoneRecord>;
  getTombstone(applicationId: string): Promise<TombstoneRecord | null>;
  isTombstoned(applicationId: string): Promise<boolean>;
  isDomainTombstoned(domain: string): Promise<boolean>;
  /**
   * Reviewed override path (TR-LIFE-006): removes the tombstone so the
   * deleted application ID and its domain can be registered again. Requires
   * attributable release evidence; the workflow layer additionally enforces
   * the retention window and audit trail before calling this.
   */
  releaseTombstone(input: TombstoneRelease): Promise<TombstoneRecord>;

  // audit (append-only) ----------------------------------------------------
  appendAudit(input: AuditAppend): Promise<AuditRecord>;
  listAudit(applicationId: string, options?: { limit?: number }): Promise<AuditRecord[]>;
  listAuditAll(options?: { limit?: number }): Promise<AuditRecord[]>;

  // credentials metadata ---------------------------------------------------
  upsertCredentialMetadata(input: CredentialMetadataUpsert): Promise<CredentialMetadataRecord>;
  getCredentialMetadata(id: string): Promise<CredentialMetadataRecord | null>;
  listCredentialsMetadata(provider?: ProviderName): Promise<CredentialMetadataRecord[]>;
  updateCredentialStatus(id: string, status: CredentialStatus, lastCheckedAt: string): Promise<CredentialMetadataRecord>;

  // locks ------------------------------------------------------------------
  acquireLock(resourceKey: string, ownerId: string, leaseSeconds: number, now?: string): Promise<boolean>;
  renewLock(resourceKey: string, ownerId: string, leaseSeconds: number, now?: string): Promise<boolean>;
  releaseLock(resourceKey: string, ownerId: string): Promise<boolean>;
  getLock(resourceKey: string): Promise<LockRecord | null>;

  // idempotent requests ----------------------------------------------------
  registerIdempotentRequest(input: IdempotentRequestRegister): Promise<IdempotentRequestRecord>;
  getIdempotentRequest(idempotencyKey: string): Promise<IdempotentRequestRecord | null>;

  // reviewed-plan attestations (plan-approval gate) ------------------------
  /**
   * Persists an automated reviewed-plan attestation idempotently: one row per
   * (application, review fingerprint); replaying the same reviewed plan
   * returns the stored row. A replay whose desired-state binding (desired
   * hash, generation, plan fingerprint, repository) disagrees with the
   * stored row fails closed.
   */
  savePlanReviewAttestation(input: PlanReviewAttestationUpsert): Promise<{ inserted: boolean; attestation: PlanReviewAttestationRecord }>;
  getPlanReviewAttestation(applicationId: string, reviewFingerprint: string): Promise<PlanReviewAttestationRecord | null>;
  listPlanReviewAttestations(applicationId: string, options?: { limit?: number }): Promise<PlanReviewAttestationRecord[]>;

  // deletion approvals (single-use) ----------------------------------------
  createDeletionApproval(input: DeletionApprovalCreate): Promise<DeletionApprovalRecord>;
  consumeDeletionApproval(applicationId: string, token: string, consumedAt?: string): Promise<DeletionApprovalRecord>;
  revokeDeletionApproval(id: string, revokedAt?: string): Promise<DeletionApprovalRecord>;
  listDeletionApprovals(applicationId: string): Promise<DeletionApprovalRecord[]>;

  // dashboard query models -------------------------------------------------
  listApplications(): Promise<DashboardApplicationRow[]>;
  getApplicationDetail(applicationId: string): Promise<ApplicationDetail>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Lock keys are constrained to application and domain locks (section 23.1). */
export function validateLockKey(resourceKey: string): void {
  if (!resourceKey.startsWith('application:') && !resourceKey.startsWith('domain:')) {
    throw invalidArgument('LP-DB-INVALID-LOCK-KEY', `Lock key '${resourceKey}' must be 'application:<id>' or 'domain:<hostname>'`);
  }
}

/**
 * Serializes a payload column. Fails closed: any value JSON cannot serialize
 * — including `SensitiveValue`, which throws on serialization by contract —
 * is rejected before a write can occur.
 */
export function serializeJson(value: unknown, what: string): string {
  try {
    return JSON.stringify(value);
  } catch {
    throw invalidArgument('LP-DB-SERIALIZATION-BLOCKED', `Refusing to persist ${what}: the value contains sensitive or non-serializable data`);
  }
}
