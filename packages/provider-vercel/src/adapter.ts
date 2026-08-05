import { type DeploymentRecord, type ObservedResource } from '@launchpad/core';
import { canonicalJson, idempotencyKey, sha256Hex } from '@launchpad/shared';
import { ProviderRequestError, type DeploymentLogExcerpt, type DeploymentLogRequest, type DeploymentRequest, type DeploymentWaitRequest, type DomainSpec, type EnvironmentSpec, type GitConnectionSpec, type MutationResult, type ProjectDomainObservation, type ProjectIdentity, type ProjectProvider, type ProjectSpec, type PromotionRequest, type PromotionResult, type ProviderCapabilities, type ProviderContext, type RequiredDnsRecord, type RollbackRequest, type RollbackResult, type TlsObservation } from '@launchpad/provider-contract';
import { VercelClient } from './client.js';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function malformed(code: string, message: string): never {
  throw new ProviderRequestError({ code, class: 'MALFORMED_PROVIDER_RESPONSE', provider: 'vercel', message, retryable: false });
}

function nullableText(value: unknown, code: string, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return malformed(code, `Vercel returned a non-string '${field}' field.`);
}

function mapProjectDomain(value: unknown, expectedProjectId: string, expectedHostname: string): ProjectDomainObservation {
  const data = record(value);
  const hostname = text(data.name);
  const projectId = text(data.projectId);
  if (hostname === null || projectId === null || typeof data.verified !== 'boolean') {
    return malformed('LP-VERCEL-DOMAIN-MALFORMED', 'Vercel returned an incomplete project-domain response.');
  }
  if (hostname !== expectedHostname || projectId !== expectedProjectId) {
    return malformed('LP-VERCEL-DOMAIN-IDENTITY-MISMATCH', 'Vercel returned project-domain identity that does not match the request.');
  }
  const rawChallenges = data.verification ?? [];
  if (!Array.isArray(rawChallenges)) {
    return malformed('LP-VERCEL-DOMAIN-MALFORMED', "Vercel returned a non-array 'verification' field.");
  }
  const challenges = rawChallenges.map((value) => {
    const challenge = record(value);
    const type = text(challenge.type);
    const domain = text(challenge.domain);
    const challengeValue = text(challenge.value);
    if (type === null || domain === null || challengeValue === null) {
      return malformed('LP-VERCEL-DOMAIN-MALFORMED', 'Vercel returned an incomplete project-domain verification challenge.');
    }
    return {
      type,
      domain,
      value: challengeValue,
      reason: nullableText(challenge.reason, 'LP-VERCEL-DOMAIN-MALFORMED', 'verification.reason'),
    };
  });
  return {
    provider: 'vercel',
    projectId,
    hostname,
    verified: data.verified,
    verificationState: data.verified ? 'VERIFIED' : challenges.length > 0 ? 'PENDING' : 'UNKNOWN',
    challenges,
    redirect: nullableText(data.redirect, 'LP-VERCEL-DOMAIN-MALFORMED', 'redirect'),
    gitBranch: nullableText(data.gitBranch, 'LP-VERCEL-DOMAIN-MALFORMED', 'gitBranch'),
    customEnvironmentId: nullableText(data.customEnvironmentId, 'LP-VERCEL-DOMAIN-MALFORMED', 'customEnvironmentId'),
    observedAt: new Date().toISOString(),
  };
}

interface VercelCertificate {
  id: string;
  createdAt: number;
  expiresAt: number;
  autoRenew: boolean;
  cns: string[];
}

function mapCertificate(value: unknown): VercelCertificate {
  const data = record(value);
  const id = text(data.id);
  if (
    id === null
    || typeof data.createdAt !== 'number'
    || !Number.isFinite(data.createdAt)
    || typeof data.expiresAt !== 'number'
    || !Number.isFinite(data.expiresAt)
    || Number.isNaN(new Date(data.expiresAt).getTime())
    || typeof data.autoRenew !== 'boolean'
    || !Array.isArray(data.cns)
    || data.cns.some((name) => typeof name !== 'string')
  ) {
    return malformed('LP-VERCEL-CERTS-MALFORMED', 'Vercel returned an incomplete certificate response.');
  }
  return { id, createdAt: data.createdAt, expiresAt: data.expiresAt, autoRenew: data.autoRenew, cns: data.cns as string[] };
}

function certificateCovers(commonName: string, hostname: string): boolean {
  const normalizedName = commonName.toLowerCase().replace(/\.$/, '');
  const normalizedHost = hostname.toLowerCase().replace(/\.$/, '');
  if (normalizedName === normalizedHost) return true;
  if (!normalizedName.startsWith('*.')) return false;
  const suffix = normalizedName.slice(2);
  if (!normalizedHost.endsWith(`.${suffix}`)) return false;
  const label = normalizedHost.slice(0, -(suffix.length + 1));
  return label.length > 0 && !label.includes('.');
}

interface VercelEnvVar {
  id: string;
  key: string;
  value: string | null;
  type: string | null;
  target: string[];
  gitBranch: string | null;
}

interface DesiredEnvVar {
  key: string;
  value: string;
  type: 'encrypted' | 'plain';
  target: string[];
  gitBranch: string | null;
}

function sameEnvTarget(left: string[], right: string[]): boolean {
  const normalize = (values: string[]): string => [...values].sort().join(',');
  return normalize(left) === normalize(right);
}

function mapEnvVar(value: unknown): VercelEnvVar {
  const data = record(value);
  const id = text(data.id);
  const key = text(data.key);
  const rawValue = data.value;
  const rawType = data.type;
  const rawTarget = data.target;
  const rawBranch = data.gitBranch;
  if (id === null || key === null || (rawValue !== null && rawValue !== undefined && typeof rawValue !== 'string') || (rawType !== null && rawType !== undefined && typeof rawType !== 'string') || (rawBranch !== null && rawBranch !== undefined && typeof rawBranch !== 'string')) {
    return malformed('LP-VERCEL-ENV-MALFORMED', 'Vercel returned an incomplete environment variable entry.');
  }
  const target = Array.isArray(rawTarget) ? rawTarget : typeof rawTarget === 'string' ? [rawTarget] : null;
  if (target === null || target.some((entry) => typeof entry !== 'string')) {
    return malformed('LP-VERCEL-ENV-MALFORMED', "Vercel returned a non-string 'target' field.");
  }
  return { id, key, value: typeof rawValue === 'string' ? rawValue : null, type: typeof rawType === 'string' ? rawType : null, target, gitBranch: typeof rawBranch === 'string' ? rawBranch : null };
}

/** Returns the mismatched dimension, or null when the observed variable matches the desired entry. */
function envMismatch(desired: DesiredEnvVar, observed: VercelEnvVar): string | null {
  if (observed.key !== desired.key) return 'key';
  if (observed.value !== desired.value) return 'value';
  if (observed.type !== desired.type) return 'type';
  if (!sameEnvTarget(observed.target, desired.target)) return 'target';
  if ((observed.gitBranch ?? null) !== desired.gitBranch) return 'branch';
  return null;
}

/**
 * Typed postcondition failure for environment reconciliation. Never carries
 * the raw desired or observed value: only the key and the mismatched field
 * are exposed so the error stays safe to persist, log, and surface.
 */
function envPostconditionError(key: string, field: string): never {
  throw new ProviderRequestError({ code: 'LP-VERCEL-ENV-POSTCONDITION-FAILED', class: 'CONFLICT', provider: 'vercel', message: `Vercel environment variable '${key}' did not converge (${field}).`, retryable: false, safeDetails: { key, field } });
}

/**
 * Decrypt-capable single-env readback (official GET /v9/projects/{id}/env/{envId}).
 * A 404 fails closed with the typed postcondition error (the variable
 * vanished before it could be verified); transient provider failures
 * propagate unchanged.
 */
async function fetchEnvVar(client: VercelClient, projectId: string, envId: string, key: string, ctx: ProviderContext): Promise<VercelEnvVar> {
  try {
    return mapEnvVar(await client.request<unknown>(client.withTeam(`/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envId)}`), { correlationId: ctx.correlationId }));
  } catch (error) {
    if (error instanceof ProviderRequestError && error.class === 'NOT_FOUND') return envPostconditionError(key, 'readback');
    throw error;
  }
}

/** Fetch + verify: any mismatch with the desired entry fails closed with the typed postcondition error. */
async function readbackEnvVar(client: VercelClient, projectId: string, envId: string, desired: DesiredEnvVar, ctx: ProviderContext): Promise<VercelEnvVar> {
  const observed = await fetchEnvVar(client, projectId, envId, desired.key, ctx);
  const mismatch = envMismatch(desired, observed);
  if (mismatch !== null) return envPostconditionError(desired.key, mismatch);
  return observed;
}

async function createEnvVar(client: VercelClient, projectId: string, desired: DesiredEnvVar, ctx: ProviderContext): Promise<VercelEnvVar> {
  const body = { key: desired.key, value: desired.value, type: desired.type, target: desired.target, gitBranch: desired.gitBranch };
  const response = record(await client.request<unknown>(client.withTeam(`/v10/projects/${encodeURIComponent(projectId)}/env`), { method: 'POST', body: JSON.stringify(body), correlationId: ctx.correlationId, idempotencyKey: idempotencyKey('vercel-environment-create', projectId, canonicalJson(body)) }));
  // Current official shape: { created: [...] } (legacy single-env responses
  // with a top-level id are still accepted). Without an id the write cannot
  // be read back, so it fails closed.
  const created = response.created ?? (text(response.id) !== null ? response : null);
  const createdId = text(record(Array.isArray(created) ? created[0] : created).id);
  if (createdId === null) return envPostconditionError(desired.key, 'created-id');
  return readbackEnvVar(client, projectId, createdId, desired, ctx);
}

async function updateEnvVar(client: VercelClient, projectId: string, envId: string, desired: DesiredEnvVar, ctx: ProviderContext): Promise<VercelEnvVar> {
  const body = { key: desired.key, value: desired.value, type: desired.type, target: desired.target, gitBranch: desired.gitBranch };
  await client.request<unknown>(client.withTeam(`/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envId)}`), { method: 'PATCH', body: JSON.stringify(body), correlationId: ctx.correlationId, idempotencyKey: idempotencyKey('vercel-environment-update', projectId, envId, canonicalJson(body)) });
  return readbackEnvVar(client, projectId, envId, desired, ctx);
}

function mapDeployment(value: unknown, request: { projectId: string; environment: 'preview' | 'staging' | 'production'; repository: string; commitSha: string; desiredGeneration: number }): DeploymentRecord {
  const data = record(value);
  const state = text(data.state) ?? text(data.readyState) ?? 'QUEUED';
  const allowed: DeploymentRecord['state'][] = ['QUEUED', 'BUILDING', 'READY', 'ERROR', 'CANCELED', 'STAGED', 'CURRENT', 'REJECTED', 'ROLLED_BACK'];
  // Official Vercel timestamps are millisecond numbers; legacy string shapes are still accepted.
  const createdAt = typeof data.createdAt === 'number' ? new Date(data.createdAt).toISOString() : typeof data.created === 'number' ? new Date(data.created).toISOString() : text(data.createdAt) ?? text(data.created) ?? new Date().toISOString();
  return { id: text(data.id) ?? text(data.uid) ?? '', projectId: request.projectId, environment: request.environment, repository: request.repository, commitSha: text(data.commitSha) ?? request.commitSha, desiredGeneration: request.desiredGeneration, state: allowed.includes(state as DeploymentRecord['state']) ? state as DeploymentRecord['state'] : state === 'PROMOTED' ? 'CURRENT' : 'QUEUED', url: text(data.url) ? `https://${text(data.url)}` : text(data.alias) ? `https://${text(data.alias)}` : null, createdAt };
}

export class VercelAdapter implements ProjectProvider {
  readonly client: VercelClient;

  constructor(options: { token?: string; teamId?: string | null; baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    this.client = new VercelClient(options);
  }

  async capabilities(): Promise<ProviderCapabilities> {
    const fields = {
      'project.name': { read: true, create: true, update: true, delete: false, requiresRedeploy: false, destructiveWhenChanged: false },
      'project.framework': { read: true, create: true, update: true, delete: false, requiresRedeploy: true, destructiveWhenChanged: false },
      'project.rootDirectory': { read: true, create: true, update: true, delete: false, requiresRedeploy: true, destructiveWhenChanged: false },
      'project.nodeVersion': { read: true, create: true, update: true, delete: false, requiresRedeploy: true, destructiveWhenChanged: false },
      'project.build.installCommand': { read: true, create: true, update: true, delete: false, requiresRedeploy: true, destructiveWhenChanged: false },
      'project.build.buildCommand': { read: true, create: true, update: true, delete: false, requiresRedeploy: true, destructiveWhenChanged: false },
      'project.build.outputDirectory': { read: true, create: true, update: true, delete: false, requiresRedeploy: true, destructiveWhenChanged: false },
      'project.settings.autoAssignProductionDomains': { read: true, create: true, update: true, delete: false, requiresRedeploy: false, destructiveWhenChanged: false },
      'project.settings.prioritizeProductionBuilds': { read: true, create: true, update: true, delete: false, requiresRedeploy: false, destructiveWhenChanged: false },
      'project.settings.rollingRelease': { read: true, create: true, update: true, delete: false, requiresRedeploy: false, destructiveWhenChanged: false },
      'project.settings.skewProtection': { read: true, create: true, update: true, delete: false, requiresRedeploy: false, destructiveWhenChanged: false },
      'domain.hostname': { read: true, create: true, update: true, delete: true, requiresRedeploy: false, destructiveWhenChanged: false },
      // Catalog-side domain attributes managed by the apply machine through
      // ensureDomain/ensureRecord (the planner validates these leaves against
      // the composite capability surface; the composite merges this matrix
      // with the Cloudflare DNS matrix).
      'domain.environment': { read: true, create: true, update: true, delete: false, requiresRedeploy: false, destructiveWhenChanged: false },
      'domain.canonical': { read: true, create: true, update: true, delete: false, requiresRedeploy: false, destructiveWhenChanged: false },
      'domain.mode': { read: true, create: true, update: true, delete: false, requiresRedeploy: false, destructiveWhenChanged: false },
      'domain.ttl': { read: true, create: true, update: true, delete: false, requiresRedeploy: false, destructiveWhenChanged: false },
      'domain.zoneRef': { read: true, create: true, update: true, delete: false, requiresRedeploy: false, destructiveWhenChanged: false },
    };
    return { provider: 'vercel', adapterVersion: 'rest-v1', fields, features: { customEnvironment: true, stagedProduction: true, exactPromotion: true, deploymentLogs: true, exactCommitLookup: true, domainVerification: true, tlsReadiness: true }, snapshotHash: await sha256Hex(canonicalJson(fields)) };
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

  /**
   * Idempotent reconciliation of every declared `EnvironmentSpec.variables`
   * entry through the official Vercel env surface (list GET /v9/projects/{id}/env,
   * create POST /v10/projects/{id}/env, update PATCH /v9/projects/{id}/env/{envId}).
   *
   * SensitiveValue instances are revealed only here, at request construction:
   * the revealed value exists transiently in the outbound body and in the
   * immediate decrypt-capable readback comparison, and never in the returned
   * configuration, errors, or persisted artifacts. Provider envs the spec does
   * not declare are never modified or deleted. Every created/updated entry is
   * verified through the single-env readback; a missing or mismatched readback
   * fails closed with the typed LP-VERCEL-ENV-POSTCONDITION-FAILED error.
   */
  async ensureEnvironment(spec: EnvironmentSpec, ctx: ProviderContext): Promise<MutationResult<ObservedResource>> {
    const environment = spec.environment === 'production' || spec.environment === 'preview' ? spec.environment : 'preview';
    const operationId = idempotencyKey('vercel-environment-operation', spec.projectId, environment);
    const desired: DesiredEnvVar[] = Object.entries(spec.variables).map(([key, value]) => {
      const revealed = typeof value === 'string' ? value : value.reveal();
      if (typeof revealed !== 'string') {
        throw new ProviderRequestError({
          code: 'LP-VERCEL-ENV-VALUE-INVALID',
          class: 'VALIDATION',
          provider: 'vercel',
          message: `Environment variable '${key}' did not resolve to a string.`,
          retryable: false,
          safeDetails: { key },
        });
      }
      return {
        key,
        value: revealed,
        type: typeof value === 'string' ? 'plain' : 'encrypted',
        target: [environment],
        gitBranch: spec.branch ?? null,
      };
    });
    const resource = (configuration: Record<string, unknown>, changed: boolean): MutationResult<ObservedResource> => ({
      resource: {
        provider: 'vercel',
        resourceType: 'vercel.environment',
        resourceKey: `${spec.projectId}:${environment}`,
        providerResourceId: `${spec.projectId}:${environment}`,
        configuration,
        ownershipFingerprint: spec.projectId,
        observedAt: new Date().toISOString(),
      },
      changed,
      operationId,
    });
    if (desired.length === 0) return resource({ variables: [] }, false);
    const listed = record(await this.client.request<unknown>(this.client.withTeam(`/v9/projects/${encodeURIComponent(spec.projectId)}/env`), { correlationId: ctx.correlationId }));
    const rawEnvs = listed.envs;
    if (!Array.isArray(rawEnvs)) return malformed('LP-VERCEL-ENV-MALFORMED', "Vercel returned a non-array 'envs' field.");
    const existing = rawEnvs.map((entry) => mapEnvVar(entry));
    let changed = false;
    const variables: Array<Record<string, unknown>> = [];
    for (const entry of desired) {
      const sameKey = existing.filter((env) => env.key === entry.key);
      // Prefer the entry with the exact identity (target + branch); fall back
      // to the first same-key entry so a declared key always converges without
      // ever deleting or touching provider envs the spec does not declare.
      const candidate = sameKey.find((env) => sameEnvTarget(env.target, entry.target) && (env.gitBranch ?? null) === entry.gitBranch) ?? sameKey[0] ?? null;
      if (candidate === null) {
        const created = await createEnvVar(this.client, spec.projectId, entry, ctx);
        variables.push({ key: created.key, id: created.id, type: created.type, target: created.target, gitBranch: created.gitBranch });
        changed = true;
        continue;
      }
      if (candidate.value !== null && envMismatch(entry, candidate) === null) {
        // Already converged: verified against the decrypt-capable list values.
        variables.push({ key: candidate.key, id: candidate.id, type: candidate.type, target: candidate.target, gitBranch: candidate.gitBranch });
        continue;
      }
      if (candidate.value === null) {
        // The list omits the value (e.g. sensitive/system types): resolve it
        // through the decrypt-capable single-env readback before deciding.
        const readback = await fetchEnvVar(this.client, spec.projectId, candidate.id, entry.key, ctx);
        if (envMismatch(entry, readback) !== null) {
          const verified = await updateEnvVar(this.client, spec.projectId, candidate.id, entry, ctx);
          variables.push({ key: verified.key, id: verified.id, type: verified.type, target: verified.target, gitBranch: verified.gitBranch });
          changed = true;
          continue;
        }
        variables.push({ key: readback.key, id: readback.id, type: readback.type, target: readback.target, gitBranch: readback.gitBranch });
        continue;
      }
      const verified = await updateEnvVar(this.client, spec.projectId, candidate.id, entry, ctx);
      variables.push({ key: verified.key, id: verified.id, type: verified.type, target: verified.target, gitBranch: verified.gitBranch });
      changed = true;
    }
    return resource({ variables }, changed);
  }

  async ensureDomain(spec: DomainSpec, ctx: ProviderContext): Promise<MutationResult<ObservedResource>> {
    const response = await this.client.request<unknown>(this.client.withTeam(`/v10/projects/${encodeURIComponent(spec.projectId)}/domains`), { method: 'POST', body: JSON.stringify({ name: spec.hostname }), correlationId: ctx.correlationId, idempotencyKey: idempotencyKey('vercel-domain', spec.projectId, spec.hostname) });
    return { resource: { provider: 'vercel', resourceType: 'vercel.domain', resourceKey: spec.hostname, providerResourceId: text(record(response).id) ?? spec.hostname, configuration: record(response), ownershipFingerprint: spec.projectId, observedAt: new Date().toISOString() }, changed: true, operationId: idempotencyKey('vercel-domain-operation', spec.projectId, spec.hostname) };
  }

  async getDomain(projectId: string, hostname: string, ctx: ProviderContext): Promise<ProjectDomainObservation | null> {
    try {
      const response = await this.client.request<unknown>(this.client.withTeam(`/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(hostname)}`), { correlationId: ctx.correlationId });
      return mapProjectDomain(response, projectId, hostname);
    } catch (error) {
      if (error instanceof ProviderRequestError && error.class === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async verifyDomain(projectId: string, hostname: string, ctx: ProviderContext): Promise<ProjectDomainObservation> {
    const response = await this.client.request<unknown>(this.client.withTeam(`/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(hostname)}/verify`), {
      method: 'POST',
      correlationId: ctx.correlationId,
      idempotencyKey: idempotencyKey('vercel-domain-verify', projectId, hostname),
    });
    return mapProjectDomain(response, projectId, hostname);
  }

  async getDomainTls(hostname: string, ctx: ProviderContext): Promise<TlsObservation> {
    const response = record(await this.client.request<unknown>(this.client.withTeam('/v8/certs'), { correlationId: ctx.correlationId }));
    if (!Array.isArray(response.certs)) {
      return malformed('LP-VERCEL-CERTS-MALFORMED', "Vercel returned a non-array 'certs' field.");
    }
    const matching = response.certs
      .map(mapCertificate)
      .filter((certificate) => certificate.cns.some((commonName) => certificateCovers(commonName, hostname)))
      .sort((left, right) => right.expiresAt - left.expiresAt)[0] ?? null;
    if (matching === null) {
      return { provider: 'vercel', hostname, state: 'PENDING', certificateId: null, expiresAt: null, autoRenew: false, observedAt: new Date().toISOString() };
    }
    return {
      provider: 'vercel',
      hostname,
      state: matching.expiresAt > Date.now() ? 'READY' : 'FAILED',
      certificateId: matching.id,
      expiresAt: new Date(matching.expiresAt).toISOString(),
      autoRenew: matching.autoRenew,
      observedAt: new Date().toISOString(),
    };
  }

  async requiredDnsRecords(domain: DomainSpec, ctx: ProviderContext): Promise<RequiredDnsRecord[]> {
    const response = await this.client.request<unknown>(`/v6/domains/${encodeURIComponent(domain.hostname)}/config`, { correlationId: ctx.correlationId });
    const data = record(response);
    // Current official shape: recommendedCNAME is an array of { rank, value: string[] }.
    // Legacy shapes: top-level `cname` string or `records.value` string.
    const recommended = Array.isArray(data.recommendedCNAME) ? (data.recommendedCNAME as unknown[]).map(record) : [];
    const entry = recommended.find((candidate) => candidate.rank === 1) ?? recommended[0];
    const values = record(entry).value;
    const target = (Array.isArray(values) ? values.find((candidate): candidate is string => typeof candidate === 'string') : null)
      ?? text(data.cname)
      ?? text(record(data.records).value);
    if (!target) throw new ProviderRequestError({ code: 'LP-VERCEL-DNS-REQUIREMENT-MISSING', class: 'MALFORMED_PROVIDER_RESPONSE', provider: 'vercel', message: 'Vercel did not return a required DNS target.', retryable: false });
    // Cloudflare proxying intent is propagated from the domain spec:
    // proxied:true is only requested for acknowledged proxied mode (PRD-DNS-005);
    // anything else maps to an explicit DNS-only record. The apply pipeline
    // blocks unacknowledged proxied mode before any record is written.
    const proxied = domain.mode === 'proxied' && domain.proxyAcknowledgment === true;
    return [{ hostname: domain.hostname, type: 'CNAME', value: target, ttl: 'auto', providerRecordId: text(data.recordId), proxied, ...(proxied ? { proxyAcknowledgment: true } : {}) }];
  }

  async createDeployment(request: DeploymentRequest, ctx: ProviderContext): Promise<DeploymentRecord> {
    // Staged production candidates are created with target 'staging' so they
    // never receive production traffic before health gates pass and the
    // explicit promotion step runs (feature `stagedProduction`).
    const target = request.environment === 'production' ? (request.staged ? 'staging' : 'production') : undefined;
    const response = await this.client.request<unknown>(this.client.withTeam('/v13/deployments'), { method: 'POST', body: JSON.stringify({ name: request.projectId, project: request.projectId, ...(target !== undefined ? { target } : {}), gitSource: { type: 'github', repo: request.repository, ref: request.commitSha, sha: request.commitSha }, meta: { launchpadApplicationId: ctx.applicationId, desiredGeneration: String(request.desiredGeneration) } }), correlationId: ctx.correlationId, idempotencyKey: idempotencyKey('vercel-deployment', request.projectId, request.commitSha, String(request.desiredGeneration)) });
    return mapDeployment(response, request);
  }

  async waitForDeployment(request: DeploymentWaitRequest, ctx: ProviderContext): Promise<DeploymentRecord> {
    const started = Date.now();
    let last: DeploymentRecord | null = null;
    while (Date.now() - started <= request.timeoutMs) {
      const response = await this.client.request<unknown>(this.client.withTeam(`/v13/deployments/${encodeURIComponent(request.deploymentId)}`), { correlationId: ctx.correlationId });
      const data = record(response);
      // A staged production candidate is created with target 'staging' (see
      // createDeployment) but remains a production-bound deployment: its
      // Launchpad environment is 'production', never 'preview'.
      last = mapDeployment(response, { projectId: text(data.projectId) ?? '', environment: data.target === 'production' || data.target === 'staging' ? 'production' : 'preview', repository: text(record(data.meta).repo) ?? '', commitSha: text(data.meta && record(data.meta).gitCommitSha) ?? '', desiredGeneration: Number(record(data.meta).desiredGeneration ?? 0) });
      if (['READY', 'ERROR', 'CANCELED', 'STAGED', 'CURRENT'].includes(last.state)) return last;
      await new Promise<void>((resolve) => setTimeout(resolve, request.pollMs));
    }
    throw new ProviderRequestError({ code: 'LP-VERCEL-DEPLOYMENT-TIMEOUT', class: 'TIMEOUT', provider: 'vercel', message: `Deployment ${request.deploymentId} did not reach a terminal state.`, retryable: true, safeDetails: { deploymentId: request.deploymentId, lastState: last?.state ?? null } });
  }

  async promote(request: PromotionRequest, ctx: ProviderContext): Promise<PromotionResult> {
    // Current official shape: POST /v10/projects/{projectId}/promote/{deploymentId}
    // with an empty 201/202 response. The promoted deployment identity is the
    // request's deployment id; commit verification happens in the caller
    // against the candidate it health-gated.
    await this.client.request(this.client.withTeam(`/v10/projects/${encodeURIComponent(request.projectId)}/promote/${encodeURIComponent(request.deploymentId)}`), { method: 'POST', correlationId: ctx.correlationId, idempotencyKey: idempotencyKey('vercel-promote', request.projectId, request.deploymentId) });
    return { deployment: { id: request.deploymentId, projectId: request.projectId, environment: 'production', repository: '', commitSha: request.expectedCommitSha, desiredGeneration: 0, state: 'CURRENT', url: null, createdAt: new Date().toISOString() }, previousDeploymentId: null };
  }

  async rollback(request: RollbackRequest, ctx: ProviderContext): Promise<RollbackResult> {
    // Current official shape: POST /v1/projects/{projectId}/rollback/{deploymentId}
    // (deploymentId is the deployment to roll back *to*), empty 201 response.
    await this.client.request(this.client.withTeam(`/v1/projects/${encodeURIComponent(request.projectId)}/rollback/${encodeURIComponent(request.previousKnownGoodId)}`), { method: 'POST', correlationId: ctx.correlationId, idempotencyKey: idempotencyKey('vercel-rollback', request.projectId, request.previousKnownGoodId) });
    return { deploymentId: request.previousKnownGoodId, restored: true };
  }

  async listOwnedShadowProjects(ctx: ProviderContext): Promise<ObservedResource[]> {
    const response = await this.client.request<unknown>(this.client.withTeam('/v9/projects?search=lp-pr-'), { correlationId: ctx.correlationId });
    const projects = record(response).projects;
    if (!Array.isArray(projects)) return [];
    return projects.map((project: unknown) => { const data = record(project); const id = text(data.id) ?? ''; return { provider: 'vercel', resourceType: 'vercel.shadow-project', resourceKey: text(data.name) ?? id, providerResourceId: id, configuration: data, ownershipFingerprint: text(data.name), observedAt: new Date().toISOString() }; });
  }
  /**
   * Locates the preview deployment for the exact commit SHA. The commit match
   * is explicit (top-level `commitSha` or one of the meta commit fields) and
   * never falls back to branch-latest; production-targeted deployments are
   * rejected; a declared repository mismatch is rejected. Returns null when no
   * exact-commit preview exists.
   */
  async findDeploymentByCommit(projectId: string, commitSha: string, ctx: ProviderContext, options?: { expectedRepository?: string | null }): Promise<DeploymentRecord | null> {
    const response = await this.client.request<unknown>(this.client.withTeam(`/v7/deployments?projectId=${encodeURIComponent(projectId)}&limit=100`), { correlationId: ctx.correlationId });
    const deployments = record(response).deployments;
    if (!Array.isArray(deployments)) throw new ProviderRequestError({ code: 'LP-VERCEL-DEPLOYMENTS-MALFORMED', class: 'MALFORMED_PROVIDER_RESPONSE', provider: 'vercel', message: 'Vercel did not return a deployments list.', retryable: false });
    for (const deployment of deployments) {
      const data = record(deployment);
      const meta = record(data.meta);
      const explicitSha = text(data.commitSha) ?? text(meta.gitCommitSha) ?? text(meta.githubCommitSha) ?? text(meta.commitSha);
      if (explicitSha !== commitSha) continue;
      if (data.target === 'production') continue;
      if (options?.expectedRepository) {
        const repository = text(meta.gitRepo) ?? text(meta.repo) ?? text(record(data.gitSource).repo) ?? text(record(data.gitSource).repository);
        if (repository && repository !== options.expectedRepository) continue;
      }
      const matched = mapDeployment(deployment, { projectId, environment: 'preview', repository: '', commitSha, desiredGeneration: 0 });
      if (matched.id === '' || matched.commitSha !== commitSha) continue;
      return matched;
    }
    return null;
  }

  /**
   * Returns a bounded excerpt of build events. The excerpt is length-capped by
   * `maxBytes` and line-capped by `maxLines`; `truncated` reports whether
   * events were dropped. Redaction of sensitive values happens in the caller
   * (the preview-status pipeline) so this adapter stays raw and replayable.
   */
  async fetchDeploymentLogs(request: DeploymentLogRequest, ctx: ProviderContext): Promise<DeploymentLogExcerpt> {
    // Current official shape: GET /v3/deployments/{id}/events returns a bare
    // event array. The legacy { events: [...] } wrapper is still accepted.
    const response = await this.client.request<unknown>(this.client.withTeam(`/v3/deployments/${encodeURIComponent(request.deploymentId)}/events?limit=100&direction=forward`), { correlationId: ctx.correlationId });
    const events = Array.isArray(response) ? response : record(response).events;
    if (!Array.isArray(events)) throw new ProviderRequestError({ code: 'LP-VERCEL-LOGS-MALFORMED', class: 'MALFORMED_PROVIDER_RESPONSE', provider: 'vercel', message: 'Vercel did not return a deployment events list.', retryable: false });
    const lines: string[] = [];
    for (const event of events) {
      const payload = record(record(event).payload);
      const line = text(payload.text) ?? text(payload.command) ?? null;
      if (line !== null) lines.push(line);
    }
    const tail = lines.slice(-request.maxLines);
    let excerpt = tail.join('\n');
    let truncated = lines.length > tail.length;
    if (excerpt.length > request.maxBytes) {
      excerpt = excerpt.slice(-request.maxBytes);
      truncated = true;
    }
    return { deploymentId: request.deploymentId, excerpt, truncated };
  }

  async deleteProject(projectId: string, ctx: ProviderContext): Promise<void> {
    await this.client.request(this.client.withTeam(`/v9/projects/${encodeURIComponent(projectId)}`), { method: 'DELETE', correlationId: ctx.correlationId, idempotencyKey: idempotencyKey('vercel-delete-project', projectId) });
  }

  /** Detaches a domain from a project (field `domain.hostname` delete). */
  async removeDomain(projectId: string, hostname: string, ctx: ProviderContext): Promise<void> {
    await this.client.request(this.client.withTeam(`/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(hostname)}`), { method: 'DELETE', correlationId: ctx.correlationId, idempotencyKey: idempotencyKey('vercel-domain-remove', projectId, hostname) });
  }

  /** Deletes a deployment by id. */
  async deleteDeployment(deploymentId: string, ctx: ProviderContext): Promise<void> {
    await this.client.request(this.client.withTeam(`/v13/deployments/${encodeURIComponent(deploymentId)}`), { method: 'DELETE', correlationId: ctx.correlationId, idempotencyKey: idempotencyKey('vercel-deployment-delete', deploymentId) });
  }
}
