import type {
  DeploymentRecord,
  EnvironmentName,
  ErrorClass,
  HealthCheckRecord,
  LifecycleState,
  ObservedApplication,
  PlatformPlan,
  ProviderName,
} from '@launchpad/core';

/**
 * Provider-neutral persistence types for the Launchpad 1.0 database contract
 * (master plan section 23). Every row type maps 1:1 to a table in
 * migrations/d1; every table has typed operations on {@link LaunchpadStore}.
 *
 * Conventions:
 * - All timestamps are ISO-8601 UTC strings (`toISOString` format) so
 *   lexicographic ordering is chronological.
 * - Payload columns are JSON-serialized; values containing `SensitiveValue`
 *   (or anything else JSON cannot serialize) are rejected at write time and
 *   never persisted.
 * - IDs are application-scoped and deterministic (`stableId`); secrets are
 *   never stored — only keyed fingerprints.
 */

// ---------------------------------------------------------------------------
// Status unions
// ---------------------------------------------------------------------------

export type SyncStatus = 'SYNCED' | 'OUT_OF_SYNC' | 'RECONCILING' | 'BLOCKED' | 'UNKNOWN' | 'DECOMMISSIONING';
export type HealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'CHECKING' | 'UNKNOWN';

/** Workflow-run states across the apply, preview, and reconciliation machines (22.1-22.3). */
export type WorkflowStatus =
  | 'QUEUED'
  | 'VALIDATING'
  | 'LOCKING'
  | 'ENSURING_PROJECT'
  | 'ENSURING_GIT'
  | 'ENSURING_SETTINGS'
  | 'ENSURING_ENVIRONMENTS'
  | 'ENSURING_SECRETS'
  | 'ENSURING_DOMAINS'
  | 'ENSURING_DNS'
  | 'VERIFYING_DOMAIN'
  | 'BUILDING_CANDIDATE'
  | 'CHECKING_CANDIDATE'
  | 'PROMOTING'
  | 'CHECKING_PRODUCTION'
  | 'RECORDING_KNOWN_GOOD'
  | 'CREATING_SHADOW_PROJECT'
  | 'APPLYING_PROPOSED_SETTINGS'
  | 'CREATING_DEPLOYMENT'
  | 'WAITING_FOR_BUILD'
  | 'CHECKING_HEALTH'
  | 'REPORTING'
  | 'CLEANUP_PENDING'
  | 'CLEANED'
  | 'OBSERVING'
  | 'DIFFING'
  | 'SYNCED'
  | 'OUT_OF_SYNC'
  | 'OPENING_OR_UPDATING_PR'
  | 'AWAITING_REVIEW'
  | 'READY'
  | 'RUNNING'
  | 'RETRYING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'BLOCKED'
  | 'ROLLING_BACK'
  | 'ROLLED_BACK'
  | 'CANCELED';

/** Workflow runs in these states are finished; anything else is an active operation. */
export const TERMINAL_WORKFLOW_STATUSES: readonly WorkflowStatus[] = ['SUCCEEDED', 'FAILED', 'BLOCKED', 'ROLLED_BACK', 'CANCELED', 'CLEANED', 'SYNCED', 'READY'] as const;

export type WorkflowStepStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'RETRYING' | 'SKIPPED';

/**
 * Deployment states from the domain model plus `SUPERSEDED`, the store-internal
 * terminal state for a known-good deployment that a newer deployment replaced.
 */
export type DeploymentState = DeploymentRecord['state'] | 'SUPERSEDED';

export type ResourceOwnershipStatus = 'ACTIVE' | 'RELEASED';
export type ReconciliationMode = 'restore-desired-state' | 'adopt-observed-state';
export type ReconciliationStatus = 'OPEN' | 'RESOLVED' | 'SUPERSEDED';
export type CleanupStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
export type CredentialStatus = 'VALID' | 'EXPIRING_SOON' | 'EXPIRED' | 'REVOKED' | 'UNKNOWN';
export type DeletionApprovalStatus = 'PENDING' | 'USED' | 'EXPIRED' | 'REVOKED';

export type IncidentType = 'DLQ' | 'RECONCILIATION_FAILURE' | 'CREDENTIAL_EXPIRY' | 'CONTROLLER_ERROR_RATE';
export type IncidentSeverity = 'warning' | 'critical';

// ---------------------------------------------------------------------------
// Row types (one per section-23 table)
// ---------------------------------------------------------------------------

export interface ApplicationRecord {
  id: string;
  displayName: string;
  sourcePath: string;
  desiredGeneration: number;
  desiredHash: string;
  syncStatus: SyncStatus;
  healthStatus: HealthStatus;
  lifecycleState: LifecycleState;
  owners: string[];
  updatedAt: string;
}

export interface DesiredGenerationRecord {
  applicationId: string;
  generation: number;
  desiredHash: string;
  updatedAt: string;
}

export interface ResourceRecord {
  id: string;
  applicationId: string;
  provider: ProviderName;
  resourceType: string;
  resourceKey: string;
  providerResourceId: string;
  desiredGeneration: number;
  observedHash: string;
  ownershipFingerprint: string | null;
  status: ResourceOwnershipStatus;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ObservationRecord {
  id: string;
  applicationId: string;
  observedHash: string;
  payload: ObservedApplication;
  observedAt: string;
}

export interface StoredPlanRecord {
  id: string;
  applicationId: string;
  fingerprint: string;
  sourceCommit: string;
  result: PlatformPlan['result'];
  plan: PlatformPlan;
  createdAt: string;
}

export interface WorkflowRunRecord {
  id: string;
  applicationId: string;
  workflowType: string;
  status: WorkflowStatus;
  idempotencyKey: string;
  payloadHash: string;
  startedAt: string;
  completedAt: string | null;
  errorCode: string | null;
}

export interface WorkflowStepRecord {
  workflowId: string;
  stepId: string;
  status: WorkflowStepStatus;
  attempt: number;
  preconditionHash: string;
  /** JSON-serializable; anything else is rejected at write time. */
  result: unknown;
  /** JSON-serializable; anything else is rejected at write time. */
  error: unknown;
}

export interface DeploymentRow {
  id: string;
  applicationId: string;
  projectId: string;
  environment: EnvironmentName;
  repository: string;
  commitSha: string;
  desiredGeneration: number;
  state: DeploymentState;
  url: string | null;
  createdAt: string;
}

export interface PromotionRecord {
  id: string;
  applicationId: string;
  deploymentId: string;
  previousDeploymentId: string | null;
  result: string;
  promotedAt: string;
}

export interface DriftEventRecord {
  id: string;
  applicationId: string;
  fingerprint: string;
  category: string;
  payload: Record<string, unknown>;
  observedAt: string;
  resolvedAt: string | null;
}

export interface ReconciliationRequestRecord {
  id: string;
  applicationId: string;
  fingerprint: string;
  mode: ReconciliationMode;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  status: ReconciliationStatus;
  openedAt: string;
  resolvedAt: string | null;
}

export interface ProviderErrorRecord {
  id: string;
  applicationId: string | null;
  operationId: string | null;
  provider: ProviderName | null;
  code: string;
  class: ErrorClass;
  message: string;
  retryable: boolean;
  safeDetails: Record<string, unknown>;
  causeFingerprint: string;
  /** Operator-facing remediation guidance for the stable error code. */
  remediation: string;
  createdAt: string;
}

/** Durable alert/incident record (one row per type+fingerprint, reopened on refire). */
export interface IncidentRecord {
  id: string;
  type: IncidentType;
  fingerprint: string;
  severity: IncidentSeverity;
  applicationId: string | null;
  operationId: string | null;
  message: string;
  details: Record<string, unknown>;
  firstSeenAt: string;
  lastFiredAt: string;
  resolvedAt: string | null;
  /** Per-sink delivery outcomes; failures are visible, never silent. */
  delivery: Record<string, unknown>;
}

/** Bounded metric snapshot row persisted per capture window. */
export interface MetricSnapshotRecord {
  id: string;
  metric: string;
  total: number;
  rate: number | null;
  windowSeconds: number;
  labels: Record<string, string>;
  capturedAt: string;
}

export interface WebhookReceiptRecord {
  provider: string;
  eventId: string;
  /** Sanitized event projection (id/type and non-secret resource identifiers); never the raw provider body. */
  payload: Record<string, unknown>;
  receivedAt: string;
  /** Set once (first writer wins) when the sanitized provider-event envelope was enqueued; null until then. */
  dispatchedAt: string | null;
}

export interface CleanupJobRecord {
  id: string;
  applicationId: string;
  providerResourceId: string;
  expiresAt: string;
  status: CleanupStatus;
  attempts: number;
  lastError: string | null;
}

export interface TombstoneRecord {
  applicationId: string;
  domain: string;
  deletedAt: string;
  retainUntil: string;
}

export interface AuditRecord {
  id: string;
  actor: string;
  action: string;
  applicationId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface CredentialMetadataRecord {
  id: string;
  provider: ProviderName;
  purpose: string;
  /** Keyed fingerprint of the underlying credential; never the value itself. */
  valueFingerprint: string | null;
  expiresAt: string | null;
  lastCheckedAt: string;
  status: CredentialStatus;
}

export interface LockRecord {
  resourceKey: string;
  ownerId: string;
  acquiredAt: string;
  expiresAt: string;
}

/**
 * Automated reviewed-plan attestation (plan-approval gate). One row per
 * (application, review fingerprint); the review fingerprint is computed from
 * the reviewed plan's canonical semantics (never the source commit), so a
 * squash-merged apply can require the attestation for the exact desired
 * hash/generation without depending on the merge commit SHA. Only hashes
 * and fingerprints are stored — never raw environment/secret values or plan
 * payloads.
 */
export interface PlanReviewAttestationRecord {
  id: string;
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
  createdAt: string;
}

export interface IdempotentRequestRecord {
  idempotencyKey: string;
  operationId: string;
  payloadHash: string;
  createdAt: string;
}

export interface DeletionApprovalRecord {
  id: string;
  applicationId: string;
  /** sha256 of the approval token. The raw token is never persisted. */
  tokenHash: string;
  requestedBy: string | null;
  status: DeletionApprovalStatus;
  expiresAt: string;
  createdAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}

// ---------------------------------------------------------------------------
// Dashboard query models (section 27) — derived from real rows, never defaults
// ---------------------------------------------------------------------------

export interface DashboardApplicationRow {
  application: string;
  displayName: string;
  owners: string[];
  /** Primary owner label (first owner or 'unassigned'). */
  owner: string;
  sync: SyncStatus;
  health: HealthStatus;
  /** Known-good production deployment state, or null when none exists. */
  deployment: DeploymentState | null;
  currentDeploymentCommit: string | null;
  productionUrl: string | null;
  /** Most recent reconciliation resolution, or null when never reconciled. */
  lastSuccessfulReconciliation: string | null;
  /** Status of the oldest active workflow run, or null. */
  activeOperation: string | null;
  /** Open reconciliation PR URL, or null. */
  openPrOrIncident: string | null;
  updatedAt: string;
}

export interface ApplicationDetail {
  application: ApplicationRecord | null;
  knownGoodDeployment: DeploymentRow | null;
  latestHealthCheck: HealthCheckRecord | null;
  openWorkflowRuns: WorkflowRunRecord[];
  recentWorkflowRuns: WorkflowRunRecord[];
}
