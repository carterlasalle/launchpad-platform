import { type DeploymentRecord, type ObservedResource } from '@launchpad/core';
import { canonicalJson, idempotencyKey, sha256Hex } from '@launchpad/shared';
import { ProviderRequestError, type DeploymentRequest, type DeploymentWaitRequest, type DomainSpec, type EnvironmentSpec, type GitConnectionSpec, type MutationResult, type ProjectIdentity, type ProjectProvider, type ProjectSpec, type PromotionRequest, type PromotionResult, type ProviderCapabilities, type ProviderContext, type RequiredDnsRecord, type RollbackRequest, type RollbackResult } from '@launchpad/provider-contract';
import { VercelClient } from './client.js';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function mapDeployment(value: unknown, request: { projectId: string; environment: 'preview' | 'staging' | 'production'; repository: string; commitSha: string; desiredGeneration: number }): DeploymentRecord {
  const data = record(value);
  const state = text(data.state) ?? text(data.readyState) ?? 'QUEUED';
  const allowed: DeploymentRecord['state'][] = ['QUEUED', 'BUILDING', 'READY', 'ERROR', 'CANCELED', 'STAGED', 'CURRENT', 'REJECTED', 'ROLLED_BACK'];
  return { id: text(data.id) ?? text(data.uid) ?? '', projectId: request.projectId, environment: request.environment, repository: request.repository, commitSha: text(data.commitSha) ?? request.commitSha, desiredGeneration: request.desiredGeneration, state: allowed.includes(state as DeploymentRecord['state']) ? state as DeploymentRecord['state'] : state === 'PROMOTED' ? 'CURRENT' : 'QUEUED', url: text(data.url) ? `https://${text(data.url)}` : text(data.alias) ? `https://${text(data.alias)}` : null, createdAt: text(data.createdAt) ?? new Date().toISOString() };
}

export class VercelAdapter implements ProjectProvider {
  readonly client: VercelClient;

  constructor(options: { token?: string; teamId?: string | null; baseUrl?: string; fetchImpl?: typeof fetch }) {
    this.client = new VercelClient(options);
  }

  async capabilities(): Promise<ProviderCapabilities> {
    const fields = {
      'project.framework': { read: true, create: true, update: true, delete: false, requiresRedeploy: true, destructiveWhenChanged: false },
      'project.rootDirectory': { read: true, create: true, update: true, delete: false, requiresRedeploy: true, destructiveWhenChanged: false },
      'project.nodeVersion': { read: true, create: true, update: true, delete: false, requiresRedeploy: true, destructiveWhenChanged: false },
      'project.build.installCommand': { read: true, create: true, update: true, delete: false, requiresRedeploy: true, destructiveWhenChanged: false },
      'project.build.buildCommand': { read: true, create: true, update: true, delete: false, requiresRedeploy: true, destructiveWhenChanged: false },
      'project.settings.autoAssignProductionDomains': { read: true, create: true, update: true, delete: false, requiresRedeploy: false, destructiveWhenChanged: false },
      'domain.hostname': { read: true, create: true, update: true, delete: true, requiresRedeploy: false, destructiveWhenChanged: false },
    };
    return { provider: 'vercel', adapterVersion: 'rest-v1', fields, features: { customEnvironment: true, stagedProduction: true, exactPromotion: true, deploymentLogs: true }, snapshotHash: await sha256Hex(canonicalJson(fields)) };
  }

  async observeProject(identity: ProjectIdentity, ctx: ProviderContext): Promise<ObservedResource | null> {
    try {
      const data = await this.client.request<unknown>(this.client.withTeam(`/v9/projects/${encodeURIComponent(identity.projectId)}`), { correlationId: ctx.correlationId });
      const project = record(data);
      return { provider: 'vercel', resourceType: 'vercel.project', resourceKey: identity.projectId, providerResourceId: text(project.id) ?? identity.projectId, configuration: project, ownershipFingerprint: text(project.id), observedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof ProviderRequestError && error.class === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async ensureProject(spec: ProjectSpec, ctx: ProviderContext): Promise<MutationResult<ObservedResource>> {
    const before = await this.observeProject({ projectId: spec.id, teamId: spec.teamId }, ctx);
    const body = { name: spec.name, framework: spec.framework, rootDirectory: spec.rootDirectory, nodeVersion: spec.nodeVersion, installCommand: spec.build.installCommand, buildCommand: spec.build.buildCommand, outputDirectory: spec.build.outputDirectory, gitRepository: spec.repository, productionBranch: spec.productionBranch, ...spec.settings };
    const afterResponse = before ? await this.client.request<unknown>(this.client.withTeam(`/v9/projects/${encodeURIComponent(before.providerResourceId)}`), { method: 'PATCH', body: JSON.stringify(body), correlationId: ctx.correlationId, idempotencyKey: idempotencyKey('vercel-project', spec.id, canonicalJson(body)) }) : await this.client.request<unknown>(this.client.withTeam('/v10/projects'), { method: 'POST', body: JSON.stringify(body), correlationId: ctx.correlationId, idempotencyKey: idempotencyKey('vercel-project', spec.id, canonicalJson(body)) });
    const observed = { provider: 'vercel' as const, resourceType: 'vercel.project', resourceKey: spec.id, providerResourceId: text(record(afterResponse).id) ?? before?.providerResourceId ?? spec.id, configuration: record(afterResponse), ownershipFingerprint: text(record(afterResponse).id) ?? spec.id, observedAt: new Date().toISOString() };
    const changed = before === null || canonicalJson(before.configuration) !== canonicalJson(observed.configuration);
    return { resource: observed, changed, operationId: idempotencyKey('vercel-project-operation', spec.id, canonicalJson(body)) };
  }

  async ensureGitConnection(spec: GitConnectionSpec, ctx: ProviderContext): Promise<MutationResult<ObservedResource>> {
    const response = await this.client.request<unknown>(this.client.withTeam(`/v9/projects/${encodeURIComponent(spec.projectId)}`), { method: 'PATCH', body: JSON.stringify({ gitRepository: { type: 'github', repo: spec.repository }, productionBranch: spec.productionBranch }), correlationId: ctx.correlationId, idempotencyKey: idempotencyKey('vercel-git', spec.projectId, spec.repository, spec.productionBranch) });
    return { resource: { provider: 'vercel', resourceType: 'vercel.git', resourceKey: spec.projectId, providerResourceId: spec.projectId, configuration: record(response), ownershipFingerprint: spec.projectId, observedAt: new Date().toISOString() }, changed: true, operationId: idempotencyKey('vercel-git-operation', spec.projectId, spec.repository) };
  }

  async ensureEnvironment(spec: EnvironmentSpec, ctx: ProviderContext): Promise<MutationResult<ObservedResource>> {
    const environment = spec.environment === 'production' || spec.environment === 'preview' ? spec.environment : 'preview';
    const response = await this.client.request<unknown>(this.client.withTeam(`/v10/projects/${encodeURIComponent(spec.projectId)}/env`), { method: 'POST', body: JSON.stringify({ key: Object.keys(spec.variables)[0] ?? 'LAUNCHPAD_ENV', value: 'managed-by-launchpad', target: [environment], gitBranch: spec.branch }), correlationId: ctx.correlationId, idempotencyKey: idempotencyKey('vercel-environment', spec.projectId, environment) });
    return { resource: { provider: 'vercel', resourceType: 'vercel.environment', resourceKey: `${spec.projectId}:${environment}`, providerResourceId: `${spec.projectId}:${environment}`, configuration: record(response), ownershipFingerprint: spec.projectId, observedAt: new Date().toISOString() }, changed: true, operationId: idempotencyKey('vercel-environment-operation', spec.projectId, environment) };
  }

  async ensureDomain(spec: DomainSpec, ctx: ProviderContext): Promise<MutationResult<ObservedResource>> {
    const response = await this.client.request<unknown>(this.client.withTeam(`/v10/projects/${encodeURIComponent(spec.projectId)}/domains`), { method: 'POST', body: JSON.stringify({ name: spec.hostname }), correlationId: ctx.correlationId, idempotencyKey: idempotencyKey('vercel-domain', spec.projectId, spec.hostname) });
    return { resource: { provider: 'vercel', resourceType: 'vercel.domain', resourceKey: spec.hostname, providerResourceId: text(record(response).id) ?? spec.hostname, configuration: record(response), ownershipFingerprint: spec.projectId, observedAt: new Date().toISOString() }, changed: true, operationId: idempotencyKey('vercel-domain-operation', spec.projectId, spec.hostname) };
  }

  async requiredDnsRecords(domain: DomainSpec, ctx: ProviderContext): Promise<RequiredDnsRecord[]> {
    const response = await this.client.request<unknown>(`/v6/domains/${encodeURIComponent(domain.hostname)}/config`, { correlationId: ctx.correlationId });
    const data = record(response);
    const target = text(data.recommendedCNAME) ?? text(data.cname) ?? text(record(data.records).value);
    if (!target) throw new ProviderRequestError({ code: 'LP-VERCEL-DNS-REQUIREMENT-MISSING', class: 'MALFORMED_PROVIDER_RESPONSE', provider: 'vercel', message: 'Vercel did not return a required DNS target.', retryable: false });
    return [{ hostname: domain.hostname, type: 'CNAME', value: target, ttl: 'auto', providerRecordId: text(data.recordId) }];
  }

  async createDeployment(request: DeploymentRequest, ctx: ProviderContext): Promise<DeploymentRecord> {
    const response = await this.client.request<unknown>(this.client.withTeam('/v13/deployments'), { method: 'POST', body: JSON.stringify({ name: request.projectId, project: request.projectId, target: request.environment === 'production' ? 'production' : undefined, gitSource: { type: 'github', repo: request.repository, ref: request.commitSha, sha: request.commitSha }, meta: { launchpadApplicationId: ctx.applicationId, desiredGeneration: String(request.desiredGeneration) } }), correlationId: ctx.correlationId, idempotencyKey: idempotencyKey('vercel-deployment', request.projectId, request.commitSha, String(request.desiredGeneration)) });
    return mapDeployment(response, request);
  }

  async waitForDeployment(request: DeploymentWaitRequest, ctx: ProviderContext): Promise<DeploymentRecord> {
    const started = Date.now();
    let last: DeploymentRecord | null = null;
    while (Date.now() - started <= request.timeoutMs) {
      const response = await this.client.request<unknown>(this.client.withTeam(`/v13/deployments/${encodeURIComponent(request.deploymentId)}`), { correlationId: ctx.correlationId });
      const data = record(response);
      last = mapDeployment(response, { projectId: text(data.projectId) ?? '', environment: data.target === 'production' ? 'production' : 'preview', repository: text(record(data.meta).repo) ?? '', commitSha: text(data.meta && record(data.meta).gitCommitSha) ?? '', desiredGeneration: Number(record(data.meta).desiredGeneration ?? 0) });
      if (['READY', 'ERROR', 'CANCELED', 'STAGED', 'CURRENT'].includes(last.state)) return last;
      await new Promise<void>((resolve) => setTimeout(resolve, request.pollMs));
    }
    throw new ProviderRequestError({ code: 'LP-VERCEL-DEPLOYMENT-TIMEOUT', class: 'TIMEOUT', provider: 'vercel', message: `Deployment ${request.deploymentId} did not reach a terminal state.`, retryable: true, safeDetails: { deploymentId: request.deploymentId, lastState: last?.state ?? null } });
  }

  async promote(request: PromotionRequest, ctx: ProviderContext): Promise<PromotionResult> {
    const response = await this.client.request<unknown>(this.client.withTeam(`/v10/projects/${encodeURIComponent(request.projectId)}/promote`), { method: 'POST', body: JSON.stringify({ deploymentId: request.deploymentId }), correlationId: ctx.correlationId, idempotencyKey: idempotencyKey('vercel-promote', request.projectId, request.deploymentId) });
    const data = record(response);
    const deployment = mapDeployment(data.deployment ?? response, { projectId: request.projectId, environment: 'production', repository: '', commitSha: request.expectedCommitSha, desiredGeneration: Number(data.desiredGeneration ?? 0) });
    if (deployment.commitSha !== request.expectedCommitSha) throw new ProviderRequestError({ code: 'LP-VERCEL-PROMOTION-COMMIT-MISMATCH', class: 'CONFLICT', provider: 'vercel', message: 'Promoted deployment commit does not match the expected commit.', retryable: false });
    return { deployment: { ...deployment, state: 'CURRENT' }, previousDeploymentId: text(data.previousDeploymentId) };
  }

  async rollback(request: RollbackRequest, ctx: ProviderContext): Promise<RollbackResult> {
    await this.client.request(this.client.withTeam(`/v10/projects/${encodeURIComponent(request.projectId)}/promote`), { method: 'POST', body: JSON.stringify({ deploymentId: request.previousKnownGoodId, rollbackFrom: request.deploymentId }), correlationId: ctx.correlationId, idempotencyKey: idempotencyKey('vercel-rollback', request.projectId, request.previousKnownGoodId) });
    return { deploymentId: request.previousKnownGoodId, restored: true };
  }

  async listOwnedShadowProjects(ctx: ProviderContext): Promise<ObservedResource[]> {
    const response = await this.client.request<unknown>(this.client.withTeam('/v9/projects?search=lp-pr-'), { correlationId: ctx.correlationId });
    const projects = record(response).projects;
    if (!Array.isArray(projects)) return [];
    return projects.map((project: unknown) => { const data = record(project); const id = text(data.id) ?? ''; return { provider: 'vercel', resourceType: 'vercel.shadow-project', resourceKey: text(data.name) ?? id, providerResourceId: id, configuration: data, ownershipFingerprint: text(data.name), observedAt: new Date().toISOString() }; });
  }

  async deleteProject(projectId: string, ctx: ProviderContext): Promise<void> {
    await this.client.request(this.client.withTeam(`/v9/projects/${encodeURIComponent(projectId)}`), { method: 'DELETE', correlationId: ctx.correlationId, idempotencyKey: idempotencyKey('vercel-delete-project', projectId) });
  }
}
