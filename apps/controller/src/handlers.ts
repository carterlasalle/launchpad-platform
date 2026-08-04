import type { DeploymentRecord, DesiredApplication, ObservedApplication, ObservedResource, PlatformPlan } from '@launchpad/core';
import { loadCatalog } from '@launchpad/catalog';
import { checkHealth } from '@launchpad/health';
import { LaunchpadRepositories } from '@launchpad/database';
import { CloudflareAdapter } from '@launchpad/provider-cloudflare';
import { GitHubAdapter } from '@launchpad/provider-github';
import { EnvironmentSecretProvider } from '@launchpad/provider-secrets';
import { VercelAdapter } from '@launchpad/provider-vercel';
import type { DnsProvider, DomainSpec, EnvironmentSpec, GitConnectionSpec, MutationResult, ProjectIdentity, ProjectProvider, ProjectSpec, ProviderCapabilities, ProviderContext, PromotionRequest, PromotionResult, RequiredDnsRecord, RollbackRequest, RollbackResult, DeploymentRequest, DeploymentWaitRequest } from '@launchpad/provider-contract';
import { decommissionApplication, reconcileApplication, runApplyWorkflow, runPreviewWorkflow } from '@launchpad/workflows';
import type { ControllerDependencies, WorkflowHandler } from './api.js';
import type { ControllerEnv } from './env.js';

class CompositeProvider implements ProjectProvider, DnsProvider {
  readonly projects: VercelAdapter;
  readonly dns: CloudflareAdapter;
  constructor(projects: VercelAdapter, dns: CloudflareAdapter) { this.projects = projects; this.dns = dns; }
  capabilities(_ctx?: ProviderContext): Promise<ProviderCapabilities> { return this.projects.capabilities(); }
  observeProject(identity: ProjectIdentity, ctx: ProviderContext): Promise<ObservedResource | null> { return this.projects.observeProject(identity, ctx); }
  ensureProject(spec: ProjectSpec, ctx: ProviderContext): Promise<MutationResult<ObservedResource>> { return this.projects.ensureProject(spec, ctx); }
  ensureGitConnection(spec: GitConnectionSpec, ctx: ProviderContext): Promise<MutationResult<ObservedResource>> { return this.projects.ensureGitConnection(spec, ctx); }
  ensureEnvironment(spec: EnvironmentSpec, ctx: ProviderContext): Promise<MutationResult<ObservedResource>> { return this.projects.ensureEnvironment(spec, ctx); }
  ensureDomain(spec: DomainSpec, ctx: ProviderContext): Promise<MutationResult<ObservedResource>> { return this.projects.ensureDomain(spec, ctx); }
  requiredDnsRecords(domain: DomainSpec, ctx: ProviderContext): Promise<RequiredDnsRecord[]> { return this.projects.requiredDnsRecords(domain, ctx); }
  createDeployment(request: DeploymentRequest, ctx: ProviderContext): Promise<DeploymentRecord> { return this.projects.createDeployment(request, ctx); }
  waitForDeployment(request: DeploymentWaitRequest, ctx: ProviderContext): Promise<DeploymentRecord> { return this.projects.waitForDeployment(request, ctx); }
  promote(request: PromotionRequest, ctx: ProviderContext): Promise<PromotionResult> { return this.projects.promote(request, ctx); }
  rollback(request: RollbackRequest, ctx: ProviderContext): Promise<RollbackResult> { return this.projects.rollback(request, ctx); }
  listOwnedShadowProjects(ctx: ProviderContext): Promise<ObservedResource[]> { return this.projects.listOwnedShadowProjects(ctx); }
  deleteProject(projectId: string, ctx: ProviderContext): Promise<void> { return this.projects.deleteProject(projectId, ctx); }
  observeZone(zoneRef: string, ctx: ProviderContext) { return this.dns.observeZone(zoneRef, ctx); }
  observeRecord(zoneId: string, hostname: string, ctx: ProviderContext) { return this.dns.observeRecord(zoneId, hostname, ctx); }
  ensureRecord(zoneId: string, record: RequiredDnsRecord, ownershipFingerprint: string, ctx: ProviderContext) { return this.dns.ensureRecord(zoneId, record, ownershipFingerprint, ctx); }
  verifyAuthoritative(hostname: string, record: RequiredDnsRecord, ctx: ProviderContext) { return this.dns.verifyAuthoritative(hostname, record, ctx); }
  deleteRecord(zoneId: string, recordId: string, ctx: ProviderContext) { return this.dns.deleteRecord(zoneId, recordId, ctx); }
}

function requiredPayload<T>(payload: Record<string, unknown>, key: string): T {
  const value = payload[key];
  if (value === null || value === undefined) throw new Error(`LP-WORKFLOW-PAYLOAD-MISSING-${key.toUpperCase()}`);
  return value as T;
}

function contextFor(payload: Record<string, unknown>, applicationId: string): ProviderContext {
  return { correlationId: typeof payload.correlationId === 'string' ? payload.correlationId : crypto.randomUUID(), applicationId, workflowId: typeof payload.workflowId === 'string' ? payload.workflowId : crypto.randomUUID(), actor: { kind: 'github-actions', id: typeof payload.actor === 'string' ? payload.actor : 'workflow' }, dryRun: false };
}

export function createWorkflowHandlers(env: ControllerEnv['Bindings'], repositories: LaunchpadRepositories): Record<string, WorkflowHandler> {
  const vercel = new VercelAdapter({ ...(env.VERCEL_TOKEN ? { token: env.VERCEL_TOKEN } : {}), ...(env.VERCEL_TEAM_ID ? { teamId: env.VERCEL_TEAM_ID } : {}) });
  const cloudflare = new CloudflareAdapter({ ...(env.CLOUDFLARE_TOKEN ? { token: env.CLOUDFLARE_TOKEN } : {}) });
  const github = new GitHubAdapter({ ...(env.GITHUB_TOKEN ? { token: env.GITHUB_TOKEN } : {}) });
  const secrets = new EnvironmentSecretProvider();
  const provider = new CompositeProvider(vercel, cloudflare);
  return {
    apply: async (payload) => {
      const desired = requiredPayload<DesiredApplication>(payload, 'desired');
      const observed = requiredPayload<ObservedApplication>(payload, 'observed');
      const plan = requiredPayload<PlatformPlan>(payload, 'plan');
      const result = await runApplyWorkflow({ repositories, provider, desired, observed, plan, sourceCommit: requiredPayload<string>(payload, 'sourceCommit'), context: contextFor(payload, desired.metadata.id) });
      return result as unknown as Record<string, unknown>;
    },
    preview: async (payload) => {
      const desired = requiredPayload<DesiredApplication>(payload, 'desired');
      const context = contextFor(payload, desired.metadata.id);
      const project = desired.vercel.project;
      const result = await runPreviewWorkflow({ provider: vercel, project: { id: desired.metadata.id, name: project.name, teamId: null, framework: project.framework, rootDirectory: project.rootDirectory, nodeVersion: project.nodeVersion, build: { installCommand: project.build.installCommand, buildCommand: project.build.buildCommand, outputDirectory: project.build.outputDirectory }, repository: desired.repository.name, productionBranch: desired.repository.productionBranch, settings: project.settings }, pullRequestNumber: Number(payload.pullRequestNumber ?? 0), revision: Number(payload.revision ?? 1), commitSha: requiredPayload<string>(payload, 'sourceCommit'), health: desired.environments.preview?.health ?? { path: '/api/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 10, attempts: 1, intervalSeconds: 0 }, context });
      return result as unknown as Record<string, unknown>;
    },
    'app-preview': async (payload) => {
      const applicationId = requiredPayload<string>(payload, 'applicationId');
      if (!env.CONTROL_REPOSITORY) throw new Error('LP-CONTROL-REPOSITORY-CONFIG-MISSING');
      const context = contextFor(payload, applicationId);
      const path = env.CONTROL_CATALOG_ROOT ? `${env.CONTROL_CATALOG_ROOT.replace(/\/$/, '')}/${applicationId}.yaml` : `catalog/apps/${applicationId}.yaml`;
      const content = await github.readFile(env.CONTROL_REPOSITORY, 'main', path, context);
      const catalog = loadCatalog([{ path, content }]);
      if (catalog.issues.length > 0) throw new Error(`LP-CONTROL-MANIFEST-INVALID:${catalog.issues[0]?.code ?? 'unknown'}`);
      const desired = catalog.applications.find((candidate) => candidate.metadata.id === applicationId);
      if (!desired) throw new Error('LP-CONTROL-APPLICATION-NOT_FOUND');
      const deployment = await vercel.findDeploymentByCommit(applicationId, requiredPayload<string>(payload, 'sourceCommit'), context);
      if (!deployment || !deployment.url) throw new Error('LP-VERCEL-PREVIEW-NOT_FOUND');
      const health = await checkHealth({ applicationId, environment: 'preview', deploymentId: deployment.id, baseUrl: deployment.url, spec: desired.environments.preview?.health ?? { path: '/api/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 10, attempts: 1, intervalSeconds: 0 } });
      return { applicationId, deployment, health };
    },
    reconcile: async (payload) => {
      const desired = requiredPayload<DesiredApplication>(payload, 'desired');
      const observed = requiredPayload<ObservedApplication>(payload, 'observed');
      const result = await reconcileApplication({ provider: vercel, source: github, desired, observed, context: contextFor(payload, desired.metadata.id), mode: payload.mode === 'adopt-observed-state' ? 'adopt-observed-state' : 'open-pr', mainCommit: requiredPayload<string>(payload, 'sourceCommit') });
      return result as unknown as Record<string, unknown>;
    },
    decommission: async (payload) => {
      const desired = requiredPayload<DesiredApplication>(payload, 'desired');
      const observed = requiredPayload<ObservedApplication>(payload, 'observed');
      const result = await decommissionApplication({ provider, repositories, desired, observed, approvalToken: requiredPayload<string>(payload, 'approvalToken'), now: new Date().toISOString(), context: contextFor(payload, desired.metadata.id) });
      return result as unknown as Record<string, unknown>;
    },
    secrets: async (payload) => {
      const reference = requiredPayload<string>(payload, 'reference');
      const value = await secrets.fingerprint(reference, contextFor(payload, 'applicationId') ?? contextFor(payload, 'platform'));
      return { fingerprint: value };
    },
  };
}

export function controllerDependencies(env: ControllerEnv['Bindings'], repositories: LaunchpadRepositories): ControllerDependencies {
  return { operatorToken: env.OPERATOR_TOKEN ?? '', internalWorkflowToken: env.CONTROLLER_INTERNAL_TOKEN, webhookSecret: env.VERCEL_WEBHOOK_SECRET, workflowHandlers: createWorkflowHandlers(env, repositories) };
}
