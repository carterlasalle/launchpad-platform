import type { DeploymentRecord, EnvironmentName, ObservedResource, ProviderCapabilities } from '@launchpad/core';
import type { SensitiveValue } from '@launchpad/shared';

// Capability plan inputs are owned by @launchpad/core (the planner consumes
// them); re-exported here for adapter ergonomics so adapters keep importing
// from @launchpad/provider-contract.
export type { FieldCapability, ProviderCapabilities } from '@launchpad/core';

export interface ActorIdentity { kind: 'github-actions' | 'operator' | 'system'; id: string; }
export interface ProviderContext { correlationId: string; applicationId: string; workflowId: string; actor: ActorIdentity; dryRun: boolean; }
export interface ProjectSpec {
  id: string;
  name: string;
  teamId: string | null;
  framework: string | null;
  rootDirectory: string;
  nodeVersion: string | null;
  build: { installCommand: string | null; buildCommand: string | null; outputDirectory: string | null };
  repository: string;
  productionBranch: string;
  settings: Record<string, unknown>;
}
export interface ProjectIdentity { projectId: string; teamId?: string | null; }
export interface GitConnectionSpec { projectId: string; repository: string; productionBranch: string; }
export interface EnvironmentSpec { projectId: string; environment: EnvironmentName; branch: string | null; variables: Record<string, SensitiveValue<unknown> | string>; }
export interface DomainSpec {
  projectId: string;
  hostname: string;
  environment: EnvironmentName;
  mode: 'dns-only' | 'proxied';
  /** Explicit double-CDN acknowledgment (PRD-DNS-005); `proxied:true` is only derived from acknowledged proxied mode. */
  proxyAcknowledgment?: boolean;
}
export interface RequiredDnsRecord {
  hostname: string;
  type: 'CNAME' | 'A' | 'TXT';
  value: string;
  ttl: number | 'auto';
  /** Provider-scoped record ID tracked by Launchpad (D1 providerResourceId). Ownership requires provider record ID and ownership fingerprint to match, never hostname alone. */
  providerRecordId?: string | null;
  /** Requested Cloudflare mode. Absent/false means DNS-only, which is the default and recommended mode. */
  proxied?: boolean;
  /** Explicit acknowledgment that must be true before proxied mode is applied (PRD-DNS-005). */
  proxyAcknowledgment?: boolean;
}
export interface DeploymentRequest { projectId: string; environment: EnvironmentName; repository: string; commitSha: string; desiredGeneration: number; staged: boolean; rootDirectory?: string; /** Git ref (branch) the deployment resolves from; Vercel classifies the environment from it, so staged-production candidates must name the production branch. Defaults to the commit SHA when omitted. */ ref?: string; }
export interface DeploymentWaitRequest { projectId: string; deploymentId: string; timeoutMs: number; pollMs: number; }
export interface PromotionRequest { projectId: string; deploymentId: string; expectedCommitSha: string; }
export interface RollbackRequest { projectId: string; deploymentId: string; previousKnownGoodId: string; }
export interface PromotionResult { deployment: DeploymentRecord; previousDeploymentId: string | null; }
export interface RollbackResult { deploymentId: string; restored: boolean; }
export interface MutationResult<T> { resource: T; changed: boolean; operationId: string; }
export interface RepositoryObservation { provider: 'github'; repository: string; repositoryId: number; archived: boolean; private: boolean; defaultBranch: string; access: boolean; }
export interface ZoneObservation { provider: 'cloudflare'; zoneId: string; name: string; nameservers: string[]; status: string; }
export interface DnsRecordObservation { provider: 'cloudflare'; id: string; zoneId: string; name: string; type: string; content: string; ttl: number; proxied: boolean; ownershipFingerprint: string | null; }
/**
 * DNS propagation state. Deliberately separate from Vercel domain verification
 * and TLS readiness so that a failure in one is never reported as a failure in another.
 */
export type DnsVerificationState = 'PENDING' | 'VERIFIED' | 'FAILED' | 'TIMED_OUT';
/** Vercel-side domain verification state, represented independently of DNS propagation and TLS. */
export type VercelDomainVerificationState = 'PENDING' | 'VERIFIED' | 'FAILED' | 'UNKNOWN';
/** TLS certificate readiness state, represented independently of DNS propagation and Vercel verification. */
export type TlsReadinessState = 'PENDING' | 'ISSUING' | 'READY' | 'FAILED' | 'UNKNOWN';
export interface DnsVerificationResult {
  state: DnsVerificationState;
  hostname: string;
  nameservers: string[];
  attempts: number;
  startedAt: string;
}
export interface ProxyRouteProbeResult {
  route: 'origin' | 'public';
  url: string;
  reachable: boolean;
  statusCode: number | null;
  tls: 'ok' | 'failed' | 'unknown';
  /** True when the probed response carried a `cf-connecting-ip` header, i.e. CF-Connecting-IP pass-through is observable. */
  connectingIpHeader: boolean;
  latencyMs: number;
  observedAt: string;
}
export interface ProxyCompatibilityRequest {
  hostname: string;
  /** Origin hostname (e.g. the Vercel deployment host) probed directly, bypassing the Cloudflare proxy. */
  originHost: string;
  /** Path probed on both routes; defaults to `/`. */
  healthPath?: string;
  /** Per-probe bound; defaults to the adapter probe timeout. */
  timeoutMs?: number;
  /** Explicit acknowledgment required before proxy compatibility checks run (PRD-DNS-005). */
  proxyAcknowledgment: boolean;
}
export interface ProxyCompatibilityResult {
  hostname: string;
  mode: 'proxied';
  acknowledgment: boolean;
  origin: ProxyRouteProbeResult;
  public: ProxyRouteProbeResult;
  compatible: boolean;
  checkedAt: string;
}
export interface SourceProvider {
  observeRepository(repository: string, ctx: ProviderContext, expectedRepositoryId?: number): Promise<RepositoryObservation>;
  hasPath(repository: string, ref: string, path: string, ctx: ProviderContext): Promise<'file' | 'directory' | 'missing'>;
  readFile(repository: string, ref: string, path: string, ctx: ProviderContext): Promise<string>;
  /** Optional capability: resolve a git ref (protected main branch or tag) to its exact commit SHA. Reconciliation requires it to operate from the latest protected main commit (TR-REC-001). */
  resolveRef?(repository: string, ref: string, ctx: ProviderContext): Promise<{ sha: string }>;
  upsertPullRequestComment(input: { repository: string; pullRequestNumber: number; marker: string; body: string }, ctx: ProviderContext): Promise<{ id: number; url: string }>;
  createOrUpdatePullRequest(input: { repository: string; branch: string; title: string; body: string; files: Record<string, string>; baseSha?: string }, ctx: ProviderContext): Promise<{ number: number; url: string }>;
  /** Optional capability: present only when the provider can publish GitHub Deployments and statuses (PRD-STS-003, TR-GH-006). */
  createDeploymentStatus?(input: DeploymentStatusInput, ctx: ProviderContext): Promise<DeploymentStatusResult>;
}
export interface ProjectProvider {
  capabilities(ctx?: ProviderContext): Promise<ProviderCapabilities>;
  observeProject(identity: ProjectIdentity, ctx: ProviderContext): Promise<ObservedResource | null>;
  ensureProject(spec: ProjectSpec, ctx: ProviderContext): Promise<MutationResult<ObservedResource>>;
  ensureGitConnection(spec: GitConnectionSpec, ctx: ProviderContext): Promise<MutationResult<ObservedResource>>;
  ensureEnvironment(spec: EnvironmentSpec, ctx: ProviderContext): Promise<MutationResult<ObservedResource>>;
  ensureDomain(spec: DomainSpec, ctx: ProviderContext): Promise<MutationResult<ObservedResource>>;
  requiredDnsRecords(domain: DomainSpec, ctx: ProviderContext): Promise<RequiredDnsRecord[]>;
  createDeployment(request: DeploymentRequest, ctx: ProviderContext): Promise<DeploymentRecord>;
  waitForDeployment(request: DeploymentWaitRequest, ctx: ProviderContext): Promise<DeploymentRecord>;
  promote(request: PromotionRequest, ctx: ProviderContext): Promise<PromotionResult>;
  rollback(request: RollbackRequest, ctx: ProviderContext): Promise<RollbackResult>;
  listOwnedShadowProjects(ctx: ProviderContext): Promise<ObservedResource[]>;
  deleteProject(projectId: string, ctx: ProviderContext): Promise<void>;
  /** Optional capability: present only when the provider exposes domain verification state (feature `domainVerification`). */
  getDomain?(projectId: string, hostname: string, ctx: ProviderContext): Promise<ProjectDomainObservation | null>;
  /** Optional capability: present only when the provider can re-request domain verification (feature `domainVerification`). */
  verifyDomain?(projectId: string, hostname: string, ctx: ProviderContext): Promise<ProjectDomainObservation>;
  /** Optional capability: present only when the provider exposes TLS/certificate readiness (feature `tlsReadiness`). */
  getDomainTls?(hostname: string, ctx: ProviderContext): Promise<TlsObservation>;
  /** Optional capability: present only when the provider exposes deployment logs (feature `deploymentLogs`). */
  fetchDeploymentLogs?(request: DeploymentLogRequest, ctx: ProviderContext): Promise<DeploymentLogExcerpt>;
  /**
   * Optional capability: locate a deployment for the exact commit SHA. The
   * match MUST be exact (no branch-latest fallback), MUST reject production
   * deployments, and MUST return null when no exact-commit preview exists.
   */
  findDeploymentByCommit?(projectId: string, commitSha: string, ctx: ProviderContext, options?: { expectedRepository?: string | null }): Promise<DeploymentRecord | null>;
  /** Optional capability: present only when the provider can detach a project domain (field `domain.hostname` delete). */
  removeDomain?(projectId: string, hostname: string, ctx: ProviderContext): Promise<void>;
  /** Optional capability: present only when the provider supports deleting deployments (field `deployment` delete). */
  deleteDeployment?(deploymentId: string, ctx: ProviderContext): Promise<void>;
}
export interface DnsProvider {
  observeZone(zoneRef: string, ctx: ProviderContext): Promise<ZoneObservation>;
  observeRecord(zoneId: string, hostname: string, ctx: ProviderContext, type?: string): Promise<DnsRecordObservation | null>;
  ensureRecord(zoneId: string, record: RequiredDnsRecord, ownershipFingerprint: string, ctx: ProviderContext): Promise<MutationResult<DnsRecordObservation>>;
  verifyAuthoritative(hostname: string, expected: RequiredDnsRecord, ctx: ProviderContext, zone?: ZoneObservation): Promise<boolean>;
  deleteRecord(zoneId: string, recordId: string, ctx: ProviderContext, ownershipFingerprint?: string): Promise<void>;
  /** Capability-gated: advertised via `features.proxyCompatibilityCheck`; providers without origin/public probing may omit it. */
  checkProxyCompatibility?(request: ProxyCompatibilityRequest, ctx: ProviderContext): Promise<ProxyCompatibilityResult>;
}
export interface SecretProvider { resolve(reference: string, ctx: ProviderContext): Promise<SensitiveValue<unknown>>; fingerprint(reference: string, ctx: ProviderContext): Promise<string>; }
export interface DomainVerificationChallenge { type: string; domain: string; value: string; reason: string | null; }
export interface ProjectDomainObservation {
  provider: 'vercel';
  projectId: string;
  hostname: string;
  verified: boolean;
  verificationState: VercelDomainVerificationState;
  challenges: DomainVerificationChallenge[];
  redirect: string | null;
  gitBranch: string | null;
  customEnvironmentId: string | null;
  observedAt: string;
}
export interface TlsObservation {
  provider: 'vercel';
  hostname: string;
  state: TlsReadinessState;
  certificateId: string | null;
  expiresAt: string | null;
  autoRenew: boolean;
  observedAt: string;
}
export interface DeploymentLogRequest { deploymentId: string; maxLines: number; maxBytes: number; }
export interface DeploymentLogExcerpt { deploymentId: string; excerpt: string; truncated: boolean; }
/**
 * GitHub Deployment status states (REST deployments/statuses). `queued` and
 * `in_progress` are transient; `success`, `failure`, `error`, and `inactive`
 * are terminal. Build failures map to `error`; failed health gates map to
 * `failure` so GitHub distinguishes them (TR-GH-006).
 */
export type GithubDeploymentState = 'queued' | 'in_progress' | 'success' | 'failure' | 'error' | 'inactive';
export interface DeploymentStatusInput {
  repository: string;
  /** Exact commit SHA the deployment belongs to; never a branch name. */
  commitSha: string;
  environment: string;
  state: GithubDeploymentState;
  description: string;
  targetUrl?: string | null;
  logUrl?: string | null;
  idempotencyKey?: string;
}
export interface DeploymentStatusResult { deploymentId: number; statusId: number; deploymentUrl: string | null; statusUrl: string | null; }
