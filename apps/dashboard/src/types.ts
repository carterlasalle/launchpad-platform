// Client-side shapes for the Launchpad control-plane dashboard API.
//
// These mirror the response envelopes of the controller's /v1 routes and the
// repository row types they serialize. Pages validate envelopes with
// requireArrayField before rendering; nothing here is ever interpolated into
// HTML — all rendering goes through the safe DOM helpers in dom.ts.

export interface DashboardApplication {
  application: string;
  displayName: string;
  owner: string;
  sync: string;
  health: string;
  deployment: string;
  productionUrl: string | null;
  updatedAt: string;
}

export interface OperationRecord {
  id: string;
  workflowId: string;
  applicationId: string;
  action: string;
  status: string;
  idempotencyKey: string;
  payloadHash: string;
  startedAt: string;
  completedAt: string | null;
  errorCode: string | null;
}

export interface AuditEvent {
  id: string;
  actor: string;
  action: string;
  applicationId: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ResourceEntry {
  provider: string;
  resourceType: string;
  providerResourceId: string;
  resourceKey: string;
  configuration: Record<string, unknown>;
  ownershipFingerprint: string | null;
  observedAt: string;
}

export interface DeploymentRecordView {
  id: string;
  environment: string;
  commitSha: string;
  state: string;
  url: string | null;
  createdAt: string;
}

export interface HealthCheckView {
  environment: string;
  url: string;
  result: string;
  statusCode: number | null;
  latencyMs: number | null;
  checkedAt: string;
  errorCode: string | null;
}

export type DriftEntry = Record<string, unknown>;

export interface ApplicationsResponse {
  applications: DashboardApplication[];
}

export interface ApplicationDetailResponse {
  application: DashboardApplication | null;
  operations: OperationRecord[];
}

export interface OperationsResponse {
  applicationId: string;
  operations: OperationRecord[];
}

export interface ResourcesResponse {
  applicationId: string;
  resources: ResourceEntry[];
}

export interface DeploymentsResponse {
  applicationId: string;
  deployments: DeploymentRecordView[];
}

export interface HealthResponse {
  applicationId: string;
  checks: HealthCheckView[];
}

export interface DriftResponse {
  applicationId: string;
  drift: DriftEntry[];
}

export interface AuditResponse {
  applicationId: string;
  events: AuditEvent[];
}

export interface PlanOperationView {
  id: string;
  resourceKey: string;
  action: string;
  destructive: boolean;
}

export interface PlanView {
  id: string;
  fingerprint: string;
  sourceCommit: string;
  result: string;
  createdAt: string;
  operationCount: number;
  operations: PlanOperationView[];
}

export interface PlansResponse {
  applicationId: string;
  plans: PlanView[];
}

export interface WorkflowStepView {
  stepId: string;
  status: string;
  attempt: number;
  preconditionHash: string;
  result: { previewUrl: string | null; buildState: string | null; healthState: string | null } | null;
  error: { code: string | null; message: string | null } | null;
}

export interface OperationDetailResponse {
  applicationId: string;
  operation: OperationRecord | null;
  steps: WorkflowStepView[];
}

export interface CredentialView {
  id: string;
  provider: string;
  purpose: string;
  valueFingerprint: string | null;
  expiresAt: string | null;
  lastCheckedAt: string;
  status: string;
}

export interface CredentialsResponse {
  credentials: CredentialView[];
}
