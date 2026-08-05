export type ProviderName = 'github' | 'vercel' | 'cloudflare' | 'secrets' | 'platform';
export type EnvironmentName = 'preview' | 'staging' | 'production';
export type PlanMode = 'apply' | 'reconcile';

export interface PlanBlock {
  code: string;
  rule: string;
  message: string;
  remediation: string | null;
}

export type DriftCategory = 'missing' | 'changed' | 'untracked' | 'ownership' | 'secret' | 'access' | 'deployment' | 'health';

export interface DriftRecord {
  resourceKey: string;
  category: DriftCategory;
  detail: string;
}

export interface DriftSummary {
  detected: boolean;
  fingerprint: string;
  records: DriftRecord[];
}

export interface ApplicationMetadata {
  id: string;
  displayName: string;
  description?: string | null;
  owners: string[];
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

export interface RepositorySpec {
  provider: 'github';
  name: string;
  productionBranch: string;
  stagingBranch?: string | null;
  deploymentRef: string;
  expectedRepositoryId?: number | null;
  access?: { requirePrivateAccessVerification: boolean; requireVercelGitAccess: boolean };
  onboarding?: { managedWorkflow: boolean; workflowVersion: string; openOnboardingPr: boolean };
}

export interface VercelProjectSpec {
  scope: { teamIdRef?: string | null };
  project: {
    name: string;
    framework: string | null;
    rootDirectory: string;
    nodeVersion: string | null;
    build: {
      installCommand: string | null;
      buildCommand: string | null;
      outputDirectory: string | null;
      developmentCommand: string | null;
      ignoredBuildStep: string | null;
    };
    git: { connected: boolean; productionBranch: string };
    deployment: { autoAssignProductionDomains: boolean; prioritizeProductionBuilds: boolean; rollingRelease: string | null; skewProtection: boolean };
    regions: { functions: string[] };
    protection: Record<string, string>;
    settings: Record<string, boolean | string | number | null>;
  };
}

export interface HealthDependencySpec {
  id: string;
  type: 'application' | 'external';
  url?: string | null;
  required: boolean;
}

export interface HealthSpec {
  path: string;
  method: string;
  headers?: Record<string, string | { secretRef: string }>;
  expectedStatus: number[];
  timeoutSeconds: number;
  attempts: number;
  intervalSeconds: number;
  backoff?: { multiplier?: number; maxDelaySeconds?: number };
  dependencies?: HealthDependencySpec[];
  body?: { jsonPath?: string; equals?: unknown; contains?: string; matches?: string };
  tls?: { required: boolean; minimumDaysRemaining?: number };
  redirects?: { allowed: boolean };
  latencyMs?: number;
}

export interface EnvironmentSpec {
  enabled: boolean;
  strategy?: 'native-preview' | 'shadow-project' | 'custom-environment' | 'separate-project';
  source?: { ref: string };
  branch?: string;
  domain?: string | null;
  variables?: Record<string, string | { secretRef: string; sensitive: true }>;
  cleanup?: { onPrClose: boolean; retentionHours: number };
  health: HealthSpec;
  release?: { strategy: 'staged-production'; promoteExactBuild: boolean; autoPromoteAfterChecks: boolean };
  rollback?: { enabled: boolean; onFailedHealthCheck: boolean; previousKnownGood: boolean };
}

export interface DomainSpec {
  hostname: string;
  environment: EnvironmentName;
  canonical?: boolean;
  cloudflare: { zoneRef: string; mode: 'dns-only' | 'proxied'; ttl: number | 'auto'; proxy?: { acknowledgeDoubleCdn: boolean; bypassWellKnownPaths: boolean; verifyConnectingIpHeader: boolean; cachePolicy: string } };
  redirects: string[];
}

export interface SecretBinding {
  name: string;
  source?: string;
  value?: string;
  sensitive?: boolean;
  environments: EnvironmentName[];
}

export interface DependencySpec {
  applications: string[];
  external: Array<{ id: string; type: string; url: string; requiredBefore: EnvironmentName[] }>;
}

export interface PolicySpec {
  drift: { mode: 'open-pr' | 'auto-restore'; checkIntervalMinutes: number };
  destructiveChanges: { allowInNormalApply: false };
  preview: { requiredForMerge: boolean };
  staging: { requiredForProduction: boolean };
  health: { requiredForPromotion: boolean };
  failures: { createIssueAfterFinalRetry: boolean; notifyOwners: boolean };
}

export type LifecycleState = 'active' | 'decommissioning' | 'approved-for-deletion' | 'deleted';
export interface LifecycleSpec {
  state: LifecycleState;
  deletionProtection: boolean;
  orphanPolicy: 'retain' | 'destroy';
  decommission: { requestedAt: string | null; deleteAfter: string | null; approvalToken: string | null; preserveDeployments: boolean };
  recoveryPolicy?: { allowReactivateBeforeDeletionApproval: boolean };
}

export interface DesiredApplication {
  apiVersion: 'launchpad.dev/v1';
  kind: 'Application';
  metadata: ApplicationMetadata;
  repository: RepositorySpec;
  vercel: VercelProjectSpec;
  environments: Partial<Record<EnvironmentName, EnvironmentSpec>>;
  domains: DomainSpec[];
  secrets: SecretBinding[];
  dependencies: DependencySpec;
  policies: PolicySpec;
  lifecycle: LifecycleSpec;
  sourcePath?: string;
}

export interface ObservedResource {
  provider: ProviderName;
  resourceType: string;
  providerResourceId: string;
  resourceKey: string;
  configuration: Record<string, unknown>;
  ownershipFingerprint: string | null;
  observedAt: string;
}

export interface ObservedApplication {
  applicationId: string;
  observedAt: string;
  desiredGeneration: number;
  desiredHash: string;
  observedHash: string;
  lifecycleState?: LifecycleState | null;
  resources: ObservedResource[];
  deployments: DeploymentRecord[];
  health: HealthSummary;
}

export interface DeploymentRecord {
  id: string;
  projectId: string;
  environment: EnvironmentName;
  repository: string;
  commitSha: string;
  desiredGeneration: number;
  state: 'QUEUED' | 'BUILDING' | 'READY' | 'ERROR' | 'CANCELED' | 'STAGED' | 'CURRENT' | 'REJECTED' | 'ROLLED_BACK';
  url: string | null;
  createdAt: string;
}

export interface HealthSummary {
  status: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'CHECKING' | 'UNKNOWN';
  latest: HealthCheckRecord | null;
}

export interface HealthCheckRecord {
  id: string;
  applicationId: string;
  environment: EnvironmentName;
  deploymentId: string | null;
  url: string;
  attempt: number;
  dnsResolved: boolean;
  tlsValid: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  assertionResults: Array<{ name: string; passed: boolean; message: string }>;
  result: 'PASSED' | 'FAILED' | 'ERROR';
  checkedAt: string;
  errorCode: string | null;
}

export interface DownstreamEffect { resourceKey: string; action: string; reason: string; severity: 'INFO' | 'WARNING' | 'BLOCKING'; }
export interface PolicyResult { rule: string; result: 'PASS' | 'WARN' | 'BLOCK'; message: string; remediation: string | null; }
export type PlannedAction = 'CREATE' | 'UPDATE_IN_PLACE' | 'REDEPLOY_REQUIRED' | 'RECREATE_PREVIEW_ONLY' | 'PROMOTE' | 'RECONCILE' | 'DECOMMISSION' | 'DESTROY' | 'NO_CHANGE' | 'BLOCKED';
export interface PlannedOperation {
  id: string;
  resourceKey: string;
  provider: ProviderName;
  resourceType: string;
  action: PlannedAction;
  before: unknown;
  after: unknown;
  prerequisites: string[];
  invalidates: string[];
  idempotencyKey: string;
  destructive: boolean;
  retryClass: 'NONE' | 'TRANSIENT' | 'PROVIDER_EVENTUAL_CONSISTENCY';
}
export interface PlatformPlan {
  schemaVersion: 'launchpad.plan/v1';
  applicationId: string;
  desiredGeneration: number;
  sourceCommit: string;
  createdAt: string;
  capabilitySnapshotHash: string;
  observedStateHash: string;
  operations: PlannedOperation[];
  downstreamEffects: DownstreamEffect[];
  policyResults: PolicyResult[];
  fingerprint: string;
  result: 'READY' | 'BLOCKED' | 'DESTRUCTIVE';
  mode?: PlanMode;
  blockedReason?: string | null;
  layers?: string[][];
  drift?: DriftSummary | null;
}
