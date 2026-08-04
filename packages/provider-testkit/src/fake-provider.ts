import { createPlatformError, type DeploymentRecord, type EnvironmentName, type ObservedResource } from '@launchpad/core';
import { canonicalJson, idempotencyKey, sha256Hex, stableId } from '@launchpad/shared';
import { ProviderRequestError, type DnsProvider, type DomainSpec, type DnsRecordObservation, type GitConnectionSpec, type MutationResult, type ProjectIdentity, type ProjectProvider, type ProjectSpec, type ProviderCapabilities, type ProviderContext, type PromotionRequest, type PromotionResult, type RequiredDnsRecord, type RollbackRequest, type RollbackResult, type SourceProvider, type EnvironmentSpec, type DeploymentRequest, type DeploymentWaitRequest, type ZoneObservation } from '@launchpad/provider-contract';

interface FakeFailure { code: string; retryable: boolean; }

function resource(providerResourceId: string, resourceType: string, resourceKey: string, configuration: Record<string, unknown>): ObservedResource {
  return { provider: 'vercel', resourceType, resourceKey, providerResourceId, configuration, ownershipFingerprint: stableId('ownership', resourceType, resourceKey), observedAt: new Date().toISOString() };
}

export class FakeProvider implements ProjectProvider, DnsProvider, SourceProvider {
  readonly projects = new Map<string, ObservedResource>();
  readonly deployments = new Map<string, DeploymentRecord>();
  readonly records = new Map<string, DnsRecordObservation>();
  readonly failures = new Map<string, FakeFailure[]>();
  readonly calls: string[] = [];

  async capabilities(): Promise<ProviderCapabilities> {
    const fields = {
      'project.rootDirectory': { read: true, create: true, update: true, delete: false, requiresRedeploy: true, destructiveWhenChanged: false },
      'project.framework': { read: true, create: true, update: true, delete: false, requiresRedeploy: true, destructiveWhenChanged: false },
      'project.settings.autoAssignProductionDomains': { read: true, create: true, update: true, delete: false, requiresRedeploy: false, destructiveWhenChanged: false },
      'domain.hostname': { read: true, create: true, update: true, delete: true, requiresRedeploy: false, destructiveWhenChanged: false },
    };
    return { provider: 'fake', adapterVersion: 'testkit-v1', fields, features: { customEnvironment: true, stagedProduction: true, exactPromotion: true }, snapshotHash: await sha256Hex(canonicalJson(fields)) };
  }

  failNext(method: string, failure: FakeFailure): void {
    const pending = this.failures.get(method) ?? [];
    pending.push(failure);
    this.failures.set(method, pending);
  }

  mutateProject(projectId: string, patch: Record<string, unknown>): void {
    const current = this.projects.get(projectId);
    if (!current) throw new Error(`Unknown fake project ${projectId}`);
    this.projects.set(projectId, { ...current, configuration: { ...current.configuration, ...patch }, observedAt: new Date().toISOString() });
  }

  private takeFailure(method: string): void {
    const failure = this.failures.get(method)?.shift();
    if (!failure) return;
    throw new ProviderRequestError({ code: failure.code, class: failure.retryable ? 'TRANSIENT_PROVIDER' : 'INTERNAL', provider: 'vercel', message: failure.code, retryable: failure.retryable });
  }

  async observeProject(identity: ProjectIdentity, _ctx: ProviderContext): Promise<ObservedResource | null> {
    this.calls.push('observeProject');
    this.takeFailure('observeProject');
    return this.projects.get(identity.projectId) ?? null;
  }

  async ensureProject(spec: ProjectSpec, _ctx: ProviderContext): Promise<MutationResult<ObservedResource>> {
    this.calls.push('ensureProject');
    this.takeFailure('ensureProject');
    const current = this.projects.get(spec.id);
    const configuration = { ...spec } as unknown as Record<string, unknown>;
    const changed = current === undefined || canonicalJson(current.configuration) !== canonicalJson(configuration);
    const observed = current ?? resource(spec.id, 'vercel.project', spec.id, configuration);
    const next = { ...observed, configuration, observedAt: new Date().toISOString() };
    this.projects.set(spec.id, next);
    return { resource: next, changed, operationId: idempotencyKey('ensure-project', spec.id, canonicalJson(configuration)) };
  }

  async ensureGitConnection(spec: GitConnectionSpec, _ctx: ProviderContext): Promise<MutationResult<ObservedResource>> {
    this.calls.push('ensureGitConnection');
    const project = this.projects.get(spec.projectId);
    if (!project) throw createPlatformError({ code: 'LP-FAKE-PROJECT-NOT_FOUND', class: 'NOT_FOUND', provider: 'vercel', message: 'Fake project does not exist.', retryable: false });
    const configuration = { repository: spec.repository, productionBranch: spec.productionBranch };
    const changed = canonicalJson(project.configuration.git ?? null) !== canonicalJson(configuration);
    const next = { ...project, configuration: { ...project.configuration, git: configuration }, observedAt: new Date().toISOString() };
    this.projects.set(spec.projectId, next);
    return { resource: next, changed, operationId: idempotencyKey('ensure-git', spec.projectId, spec.repository, spec.productionBranch) };
  }

  async ensureEnvironment(spec: EnvironmentSpec, _ctx: ProviderContext): Promise<MutationResult<ObservedResource>> {
    const project = this.projects.get(spec.projectId);
    if (!project) throw new Error('Fake project does not exist');
    const key = `${spec.projectId}:${spec.environment}`;
    const environments = { ...(project.configuration.environments as Record<string, unknown> | undefined), [spec.environment]: { branch: spec.branch, variables: Object.keys(spec.variables) } };
    const next = { ...project, configuration: { ...project.configuration, environments }, observedAt: new Date().toISOString() };
    this.projects.set(spec.projectId, next);
    return { resource: next, changed: true, operationId: idempotencyKey('ensure-environment', key) };
  }

  async ensureDomain(spec: DomainSpec, _ctx: ProviderContext): Promise<MutationResult<ObservedResource>> {
    const project = this.projects.get(spec.projectId);
    if (!project) throw new Error('Fake project does not exist');
    const domains = [...((project.configuration.domains as string[] | undefined) ?? [])];
    const changed = !domains.includes(spec.hostname);
    if (changed) domains.push(spec.hostname);
    const next = { ...project, configuration: { ...project.configuration, domains }, observedAt: new Date().toISOString() };
    this.projects.set(spec.projectId, next);
    return { resource: next, changed, operationId: idempotencyKey('ensure-domain', spec.projectId, spec.hostname) };
  }

  async requiredDnsRecords(domain: DomainSpec, _ctx: ProviderContext): Promise<RequiredDnsRecord[]> {
    return [{ hostname: domain.hostname, type: 'CNAME', value: `${domain.projectId}.vercel-dns.example`, ttl: 'auto', providerRecordId: null }];
  }

  async createDeployment(request: DeploymentRequest, _ctx: ProviderContext): Promise<DeploymentRecord> {
    this.calls.push('createDeployment');
    const id = `dpl_${stableId('deployment', request.projectId, request.commitSha, String(request.desiredGeneration))}`;
    const deployment: DeploymentRecord = { id, projectId: request.projectId, environment: request.environment, repository: request.repository, commitSha: request.commitSha, desiredGeneration: request.desiredGeneration, state: request.staged ? 'STAGED' : 'READY', url: `https://${id}.example.test`, createdAt: new Date().toISOString() };
    this.deployments.set(id, deployment);
    return deployment;
  }

  async waitForDeployment(request: DeploymentWaitRequest, _ctx: ProviderContext): Promise<DeploymentRecord> {
    this.calls.push('waitForDeployment');
    const deployment = this.deployments.get(request.deploymentId);
    if (!deployment) throw new Error('Fake deployment does not exist');
    return deployment;
  }

  async promote(request: PromotionRequest, _ctx: ProviderContext): Promise<PromotionResult> {
    this.calls.push('promote');
    const deployment = this.deployments.get(request.deploymentId);
    if (!deployment) throw new Error('Fake deployment does not exist');
    if (deployment.commitSha !== request.expectedCommitSha) throw new ProviderRequestError({ code: 'LP-DEPLOYMENT-COMMIT-MISMATCH', class: 'CONFLICT', provider: 'vercel', message: 'Deployment commit does not match promotion request.', retryable: false });
    let previousDeploymentId: string | null = null;
    for (const [id, candidate] of this.deployments) {
      if (id !== deployment.id && candidate.projectId === deployment.projectId && candidate.state === 'CURRENT') {
        previousDeploymentId = id;
        this.deployments.set(id, { ...candidate, state: 'REJECTED' });
      }
    }
    const current = { ...deployment, state: 'CURRENT' as const };
    this.deployments.set(deployment.id, current);
    return { deployment: current, previousDeploymentId };
  }

  async rollback(request: RollbackRequest, _ctx: ProviderContext): Promise<RollbackResult> {
    this.calls.push('rollback');
    const knownGood = this.deployments.get(request.previousKnownGoodId);
    if (!knownGood || knownGood.projectId !== request.projectId) throw new Error('Known-good deployment does not exist');
    this.deployments.set(knownGood.id, { ...knownGood, state: 'CURRENT' });
    const failed = this.deployments.get(request.deploymentId);
    if (failed) this.deployments.set(failed.id, { ...failed, state: 'ROLLED_BACK' });
    return { deploymentId: knownGood.id, restored: true };
  }

  async listOwnedShadowProjects(_ctx: ProviderContext): Promise<ObservedResource[]> {
    return [...this.projects.values()].filter((project) => project.resourceKey.startsWith('shadow:'));
  }

  async deleteProject(projectId: string, _ctx: ProviderContext): Promise<void> {
    this.projects.delete(projectId);
  }

  async observeZone(zoneRef: string, _ctx: ProviderContext): Promise<ZoneObservation> {
    return { provider: 'cloudflare', zoneId: zoneRef.replace('config://cloudflare/', 'zone_'), name: zoneRef.replace('config://cloudflare/', ''), nameservers: ['ns1.example.test', 'ns2.example.test'], status: 'active' };
  }

  async observeRecord(zoneId: string, hostname: string, _ctx: ProviderContext): Promise<DnsRecordObservation | null> {
    return this.records.get(`${zoneId}:${hostname}`) ?? null;
  }

  async ensureRecord(zoneId: string, record: RequiredDnsRecord, ownershipFingerprint: string, _ctx: ProviderContext): Promise<MutationResult<DnsRecordObservation>> {
    const key = `${zoneId}:${record.hostname}`;
    const current = this.records.get(key);
    if (current && current.ownershipFingerprint !== ownershipFingerprint) throw new Error('Unowned DNS record conflict');
    const next: DnsRecordObservation = { provider: 'cloudflare', id: current?.id ?? `dns_${stableId('dns', key)}`, zoneId, name: record.hostname, type: record.type, content: record.value, ttl: record.ttl === 'auto' ? 1 : record.ttl, proxied: false, ownershipFingerprint };
    this.records.set(key, next);
    return { resource: next, changed: canonicalJson(current ?? null) !== canonicalJson(next), operationId: idempotencyKey('dns', key, ownershipFingerprint) };
  }

  async verifyAuthoritative(hostname: string, expected: RequiredDnsRecord, _ctx: ProviderContext): Promise<boolean> {
    const record = [...this.records.values()].find((candidate) => candidate.name === hostname);
    return record?.content === expected.value;
  }

  async deleteRecord(zoneId: string, recordId: string, _ctx: ProviderContext): Promise<void> {
    for (const [key, record] of this.records) if (record.zoneId === zoneId && record.id === recordId) this.records.delete(key);
  }

  async observeRepository(repository: string, _ctx: ProviderContext) {
    return { provider: 'github' as const, repository, repositoryId: 1, archived: false, private: true, defaultBranch: 'main', access: true };
  }

  async hasPath(_repository: string, _ref: string, path: string, _ctx: ProviderContext): Promise<'file' | 'directory' | 'missing'> {
    return path.includes('missing') ? 'missing' : path.endsWith('/') ? 'directory' : 'file';
  }

  async upsertPullRequestComment(input: { repository: string; pullRequestNumber: number; marker: string; body: string }, _ctx: ProviderContext): Promise<{ id: number; url: string }> {
    return { id: input.pullRequestNumber, url: `https://github.com/${input.repository}/pull/${input.pullRequestNumber}#issuecomment-${input.pullRequestNumber}` };
  }

  async createOrUpdatePullRequest(input: { repository: string; branch: string; title: string; body: string; files: Record<string, string> }, _ctx: ProviderContext): Promise<{ number: number; url: string }> {
    return { number: Number.parseInt(stableId('reconcile', input.repository, input.branch).slice(0, 6), 16) % 100000, url: `https://github.com/${input.repository}/pull/1` };
  }
}
