import type { DeploymentRecord, EnvironmentName, ObservedResource, ProviderName } from '@launchpad/core';
import type { SensitiveValue } from '@launchpad/shared';

export interface ActorIdentity { kind: 'github-actions' | 'operator' | 'system'; id: string; }
export interface ProviderContext { correlationId: string; applicationId: string; workflowId: string; actor: ActorIdentity; dryRun: boolean; }
export interface FieldCapability { read: boolean; create: boolean; update: boolean; delete: boolean; requiresRedeploy: boolean; destructiveWhenChanged: boolean; }
export interface ProviderCapabilities { provider: ProviderName | 'fake'; adapterVersion: string; fields: Record<string, FieldCapability>; features: Record<string, boolean>; snapshotHash: string; }
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
export interface DomainSpec { projectId: string; hostname: string; environment: EnvironmentName; mode: 'dns-only' | 'proxied'; }
export interface RequiredDnsRecord { hostname: string; type: 'CNAME' | 'A' | 'TXT'; value: string; ttl: number | 'auto'; providerRecordId?: string | null; }
export interface DeploymentRequest { projectId: string; environment: EnvironmentName; repository: string; commitSha: string; desiredGeneration: number; staged: boolean; rootDirectory?: string; }
export interface DeploymentWaitRequest { projectId: string; deploymentId: string; timeoutMs: number; pollMs: number; }
export interface PromotionRequest { projectId: string; deploymentId: string; expectedCommitSha: string; }
export interface RollbackRequest { projectId: string; deploymentId: string; previousKnownGoodId: string; }
export interface PromotionResult { deployment: DeploymentRecord; previousDeploymentId: string | null; }
export interface RollbackResult { deploymentId: string; restored: boolean; }
export interface MutationResult<T> { resource: T; changed: boolean; operationId: string; }
export interface RepositoryObservation { provider: 'github'; repository: string; repositoryId: number; archived: boolean; private: boolean; defaultBranch: string; access: boolean; }
export interface ZoneObservation { provider: 'cloudflare'; zoneId: string; name: string; nameservers: string[]; status: string; }
export interface DnsRecordObservation { provider: 'cloudflare'; id: string; zoneId: string; name: string; type: string; content: string; ttl: number; proxied: boolean; ownershipFingerprint: string | null; }
export interface SourceProvider {
  observeRepository(repository: string, ctx: ProviderContext): Promise<RepositoryObservation>;
  hasPath(repository: string, ref: string, path: string, ctx: ProviderContext): Promise<'file' | 'directory' | 'missing'>;
  upsertPullRequestComment(input: { repository: string; pullRequestNumber: number; marker: string; body: string }, ctx: ProviderContext): Promise<{ id: number; url: string }>;
  createOrUpdatePullRequest(input: { repository: string; branch: string; title: string; body: string; files: Record<string, string> }, ctx: ProviderContext): Promise<{ number: number; url: string }>;
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
}
export interface DnsProvider {
  observeZone(zoneRef: string, ctx: ProviderContext): Promise<ZoneObservation>;
  observeRecord(zoneId: string, hostname: string, ctx: ProviderContext): Promise<DnsRecordObservation | null>;
  ensureRecord(zoneId: string, record: RequiredDnsRecord, ownershipFingerprint: string, ctx: ProviderContext): Promise<MutationResult<DnsRecordObservation>>;
  verifyAuthoritative(hostname: string, expected: RequiredDnsRecord, ctx: ProviderContext): Promise<boolean>;
  deleteRecord(zoneId: string, recordId: string, ctx: ProviderContext): Promise<void>;
}
export interface SecretProvider { resolve(reference: string, ctx: ProviderContext): Promise<SensitiveValue<unknown>>; fingerprint(reference: string, ctx: ProviderContext): Promise<string>; }
