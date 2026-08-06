import type { DeploymentRecord, DesiredApplication, ObservedApplication, ObservedResource, PlatformPlan } from '@launchpad/core';
import { loadCatalog, parseZoneRegistry } from '@launchpad/catalog';
import { checkHealth } from '@launchpad/health';
import { D1LaunchpadStore, LaunchpadRepositories } from '@launchpad/database';
import { canonicalJson, idempotencyKey, sha256Hex } from '@launchpad/shared';
import { CloudflareAdapter } from '@launchpad/provider-cloudflare';
import { createAuthoritativeDnsResolver } from './dns-resolver.js';
import { GitHubAdapter } from '@launchpad/provider-github';
import { EnvironmentSecretProvider } from '@launchpad/provider-secrets';
import { VercelAdapter } from '@launchpad/provider-vercel';
import type { DeploymentLogExcerpt, DeploymentLogRequest, DeploymentRequest, DeploymentWaitRequest, DnsProvider, DomainSpec, EnvironmentSpec, GitConnectionSpec, MutationResult, ProjectDomainObservation, ProjectIdentity, ProjectProvider, ProjectSpec, PromotionRequest, PromotionResult, ProviderCapabilities, ProviderContext, ProxyCompatibilityRequest, ProxyCompatibilityResult, RequiredDnsRecord, RollbackRequest, RollbackResult, SourceProvider, TlsObservation, ZoneObservation } from '@launchpad/provider-contract';
import { APPLY_PHASES, RECONCILE_PHASES, applyStep, cleanupPreviewForPullRequest, cleanupShadowProject, consumeDeletionApproval, issueDeletionApproval, loadRegisteredCatalog, makeApplyBase, makeReconcileBase, planDecommission, reactivateApplication, reconcileStep, rollbackProduction, runAppPreviewStatusWorkflow, runApplyPhase, runApplyWorkflow, runDecommissionWorkflow, runPreviewStage, runPreviewWorkflow, runReconcilePhase, type ApplyPhaseName, type ApplyReportSummary, type ApplyRuntime, type ApplyStepContext, type AccessError, type DiffPlanResult, type HeldLocks, type ManifestError, type ReconcilePhaseName, type ReconcileStepContext, type ResolveSecretsResult } from '@launchpad/workflows';
import { ensureApplicationRegistered, zoneRegistryPathFor, type ControllerDependencies, type WorkflowHandler } from './api.js';
import type { ControllerEnv } from './env.js';
import { oidcConfigFromEnv } from './env.js';
import type { ObservabilityDeps } from './observability.js';

export class CompositeProvider implements ProjectProvider, DnsProvider {
  readonly projects: VercelAdapter;
  readonly dns: CloudflareAdapter;
  constructor(projects: VercelAdapter, dns: CloudflareAdapter) { this.projects = projects; this.dns = dns; }
  /**
   * Capability union of the composed providers: each adapter advertises only
   * the fields its own behavior implements (Vercel: project/settings/domain
   * surface; Cloudflare: DNS record surface), and the planner validates the
   * full manifest surface against the union. Deterministic snapshot hash so
   * plan fingerprints stay stable.
   */
  async capabilities(_ctx?: ProviderContext): Promise<ProviderCapabilities> {
    const [projects, dns] = await Promise.all([this.projects.capabilities(), this.dns.capabilities()]);
    const fields = { ...projects.fields, ...dns.fields };
    return {
      provider: 'vercel',
      adapterVersion: 'composite-v1',
      snapshotHash: await sha256Hex(canonicalJson(fields)),
      features: { ...projects.features, ...dns.features },
      fields,
    };
  }
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
  getDomain(projectId: string, hostname: string, ctx: ProviderContext): Promise<ProjectDomainObservation | null> { return this.projects.getDomain(projectId, hostname, ctx); }
  verifyDomain(projectId: string, hostname: string, ctx: ProviderContext): Promise<ProjectDomainObservation> { return this.projects.verifyDomain(projectId, hostname, ctx); }
  getDomainTls(hostname: string, ctx: ProviderContext): Promise<TlsObservation> { return this.projects.getDomainTls(hostname, ctx); }
  fetchDeploymentLogs(request: DeploymentLogRequest, ctx: ProviderContext): Promise<DeploymentLogExcerpt> { return this.projects.fetchDeploymentLogs(request, ctx); }
  findDeploymentByCommit(projectId: string, commitSha: string, ctx: ProviderContext, options?: { expectedRepository?: string | null }): Promise<DeploymentRecord | null> { return this.projects.findDeploymentByCommit(projectId, commitSha, ctx, options); }
  removeDomain(projectId: string, hostname: string, ctx: ProviderContext): Promise<void> { return this.projects.removeDomain(projectId, hostname, ctx); }
  deleteDeployment(deploymentId: string, ctx: ProviderContext): Promise<void> { return this.projects.deleteDeployment(deploymentId, ctx); }
  observeZone(zoneRef: string, ctx: ProviderContext) { return this.dns.observeZone(zoneRef, ctx); }
  observeRecord(zoneId: string, hostname: string, ctx: ProviderContext, type?: string) { return this.dns.observeRecord(zoneId, hostname, ctx, type); }
  ensureRecord(zoneId: string, record: RequiredDnsRecord, ownershipFingerprint: string, ctx: ProviderContext) { return this.dns.ensureRecord(zoneId, record, ownershipFingerprint, ctx); }
  verifyAuthoritative(hostname: string, record: RequiredDnsRecord, ctx: ProviderContext, zone?: ZoneObservation) { return this.dns.verifyAuthoritative(hostname, record, ctx, zone); }
  deleteRecord(zoneId: string, recordId: string, ctx: ProviderContext, ownershipFingerprint?: string) { return this.dns.deleteRecord(zoneId, recordId, ctx, ownershipFingerprint); }
  checkProxyCompatibility(request: ProxyCompatibilityRequest, ctx: ProviderContext): Promise<ProxyCompatibilityResult> { return this.dns.checkProxyCompatibility(request, ctx); }
}

function requiredPayload<T>(payload: Record<string, unknown>, key: string): T {
  const value = payload[key];
  if (value === null || value === undefined) throw new Error(`LP-WORKFLOW-PAYLOAD-MISSING-${key.toUpperCase()}`);
  return value as T;
}

/** Failure with a stable code surfaced verbatim in workflow error envelopes. */
class HandlerFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = code;
    this.code = code;
  }
}

/** Manifest path inside the control repository for an application (CONTROL_CATALOG_ROOT overrides the default catalog root). */
function manifestPathFor(env: ControllerEnv['Bindings'], applicationId: string): string {
  return env.CONTROL_CATALOG_ROOT ? `${env.CONTROL_CATALOG_ROOT.replace(/\/$/, '')}/${applicationId}.yaml` : `catalog/apps/${applicationId}.yaml`;
}

/**
 * Reads and parses the zone registry at the protected ref through the source
 * provider. Fails closed on a missing (LP-ZONE-REGISTRY-MISSING) or malformed
 * (LP-ZONE-REGISTRY-INVALID) registry; both errors carry the registry path.
 */
async function readZoneRegistry(source: SourceProvider, env: ControllerEnv['Bindings'], context: ProviderContext): Promise<string[]> {
  const path = zoneRegistryPathFor(env.CONTROL_CATALOG_ROOT);
  let content: string;
  try {
    content = await source.readFile(env.CONTROL_REPOSITORY ?? '', 'main', path, context);
  } catch (error) {
    const notFound = typeof error === 'object' && error !== null && 'class' in error && error.class === 'NOT_FOUND';
    const detail = error instanceof Error ? error.message : 'The zone registry could not be read.';
    throw new HandlerFailure(notFound ? 'LP-ZONE-REGISTRY-MISSING' : 'LP-ZONE-REGISTRY-UNREADABLE', `The zone registry ${path} could not be read at main: ${detail}`);
  }
  const parsed = parseZoneRegistry(content, path);
  if (parsed.issues.length > 0) {
    const first = parsed.issues[0];
    throw new HandlerFailure('LP-ZONE-REGISTRY-INVALID', `The zone registry ${path} is invalid (${first?.code ?? 'LP-ZONE-REGISTRY-INVALID'} at ${path}:${first?.line ?? 1}:${first?.column ?? 1}).`);
  }
  return parsed.zones;
}

/** Bounded health-check spec for operator-initiated production rechecks (a direct recovery action). */
const DEFAULT_HEALTH_SPEC = { path: '/api/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 10, attempts: 3, intervalSeconds: 1 };

function contextFor(payload: Record<string, unknown>, applicationId: string): ProviderContext {
  return { correlationId: typeof payload.correlationId === 'string' ? payload.correlationId : crypto.randomUUID(), applicationId, workflowId: typeof payload.workflowId === 'string' ? payload.workflowId : crypto.randomUUID(), actor: { kind: 'github-actions', id: typeof payload.actor === 'string' ? payload.actor : 'workflow' }, dryRun: false };
}

/**
 * Granular apply phase handlers (master plan 22.1). Each phase is dispatched
 * by the `ApplyApplicationWorkflow` as its own `step.do` boundary; every
 * phase persists start/attempt/result/error through the D1 `LaunchpadStore`
 * and retries only typed retryable failures with bounded policies.
 */
function createApplyPhaseHandlers(env: ControllerEnv['Bindings'], provider: CompositeProvider, github: GitHubAdapter, secrets: EnvironmentSecretProvider): Record<string, WorkflowHandler> {
  const store = env.DB ? new D1LaunchpadStore(env.DB) : null;

  const phaseHandler = (phase: ApplyPhaseName): WorkflowHandler => async (payload) => {
    if (!store) throw new Error('LP-STORE-CONFIG-MISSING');
    const base = await makeApplyBase({
      applicationId: requiredPayload<string>(payload, 'applicationId'),
      sourceCommit: requiredPayload<string>(payload, 'sourceCommit'),
      planFingerprint: requiredPayload<string>(payload, 'planFingerprint'),
      desiredGeneration: requiredPayload<number>(payload, 'desiredGeneration'),
      idempotencyKey: requiredPayload<string>(payload, 'idempotencyKey'),
      workflowId: requiredPayload<string>(payload, 'workflowId'),
    });
    const context = contextFor(payload, base.applicationId);
    const runtime: ApplyRuntime = { store, provider, secrets };
    const ctx: ApplyStepContext = { base, context, runtime };
    switch (phase) {
      case 'load-desired':
        if (!env.CONTROL_REPOSITORY) throw new Error('LP-CONTROL-REPOSITORY-CONFIG-MISSING');
        ctx.source = github;
        ctx.controlRepository = env.CONTROL_REPOSITORY;
        ctx.manifestPath = typeof payload.manifestPath === 'string' ? payload.manifestPath : (await store.getApplication(base.applicationId))?.sourcePath ?? manifestPathFor(env, base.applicationId);
        break;
      case 'observe-live-state':
        ctx.desired = requiredPayload<DesiredApplication>(payload, 'desired');
        break;
      case 'replan-verify':
        ctx.desired = requiredPayload<DesiredApplication>(payload, 'desired');
        ctx.observed = requiredPayload<ObservedApplication>(payload, 'observed');
        ctx.capabilities = requiredPayload<ProviderCapabilities>(payload, 'capabilities');
        break;
      case 'no-destroy-gate':
        ctx.plan = requiredPayload<PlatformPlan>(payload, 'plan');
        break;
      case 'acquire-locks':
        ctx.desired = requiredPayload<DesiredApplication>(payload, 'desired');
        break;
      case 'ensure-project':
      case 'ensure-git':
      case 'ensure-settings':
      case 'ensure-domains':
      case 'ensure-dns':
        ctx.desired = requiredPayload<DesiredApplication>(payload, 'desired');
        ctx.plan = requiredPayload<PlatformPlan>(payload, 'plan');
        ctx.locks = requiredPayload<HeldLocks>(payload, 'locks');
        break;
      case 'create-candidate': {
        ctx.desired = requiredPayload<DesiredApplication>(payload, 'desired');
        ctx.plan = requiredPayload<PlatformPlan>(payload, 'plan');
        ctx.locks = requiredPayload<HeldLocks>(payload, 'locks');
        // The staged production candidate builds the APPLICATION repository at
        // its production branch HEAD; the control-repository commit that
        // triggered the apply does not exist in the application repository.
        const desired = ctx.desired;
        const ref = await github.resolveRef(desired.repository.name, desired.repository.productionBranch, context);
        if (!ref || typeof ref.sha !== 'string' || !/^[0-9a-f]{40}$/.test(ref.sha)) {
          throw new HandlerFailure('LP-APPLY-COMMIT-UNRESOLVABLE', `The application repository branch '${desired.repository.productionBranch}' could not be resolved for the production candidate.`);
        }
        ctx.appCommit = ref.sha;
        break;
      }
      case 'resolve-secrets':
        ctx.desired = requiredPayload<DesiredApplication>(payload, 'desired');
        break;
      case 'ensure-environments':
        ctx.desired = requiredPayload<DesiredApplication>(payload, 'desired');
        ctx.plan = requiredPayload<PlatformPlan>(payload, 'plan');
        ctx.locks = requiredPayload<HeldLocks>(payload, 'locks');
        ctx.bindings = requiredPayload<ResolveSecretsResult['bindings']>(payload, 'bindings');
        break;
      case 'verify-authoritative':
      case 'verify-vercel-domain':
      case 'verify-tls':
        ctx.desired = requiredPayload<DesiredApplication>(payload, 'desired');
        break;
      case 'wait-candidate':
      case 'proxy-compatibility':
      case 'candidate-health':
        ctx.desired = requiredPayload<DesiredApplication>(payload, 'desired');
        ctx.candidate = requiredPayload<DeploymentRecord>(payload, 'candidate');
        break;
      case 'promote': {
        ctx.desired = requiredPayload<DesiredApplication>(payload, 'desired');
        ctx.plan = requiredPayload<PlatformPlan>(payload, 'plan');
        ctx.locks = requiredPayload<HeldLocks>(payload, 'locks');
        ctx.candidate = requiredPayload<DeploymentRecord>(payload, 'candidate');
        // The candidate was built from the application repository branch; the
        // promotion gate compares against the same resolved commit.
        const desiredForPromote = ctx.desired;
        const ref = await github.resolveRef(desiredForPromote.repository.name, desiredForPromote.repository.productionBranch, context);
        if (ref && typeof ref.sha === 'string' && /^[0-9a-f]{40}$/.test(ref.sha)) ctx.appCommit = ref.sha;
        break;
      }
      case 'production-health':
        ctx.desired = requiredPayload<DesiredApplication>(payload, 'desired');
        ctx.candidate = requiredPayload<DeploymentRecord>(payload, 'candidate');
        break;
      case 'record-known-good':
        ctx.desired = requiredPayload<DesiredApplication>(payload, 'desired');
        ctx.candidate = requiredPayload<DeploymentRecord>(payload, 'candidate');
        ctx.productionHealth = requiredPayload<ObservedApplication['health']['latest']>(payload, 'productionHealth');
        break;
      case 'report':
        ctx.summary = requiredPayload<ApplyReportSummary>(payload, 'summary');
        break;
      case 'release-locks':
        ctx.locks = requiredPayload<HeldLocks>(payload, 'locks');
        break;
      case 'recover-on-failure':
        ctx.desired = requiredPayload<DesiredApplication>(payload, 'desired');
        ctx.failure = requiredPayload<{ failedStep: string; error: unknown }>(payload, 'failure');
        ctx.candidate = 'candidate' in payload && payload.candidate !== null ? requiredPayload<DeploymentRecord>(payload, 'candidate') : null;
        ctx.knownGood = 'knownGood' in payload && payload.knownGood !== null ? requiredPayload<DeploymentRecord>(payload, 'knownGood') : null;
        ctx.productionHealth = 'productionHealth' in payload && payload.productionHealth !== null ? requiredPayload<ObservedApplication['health']['latest']>(payload, 'productionHealth') : null;
        break;
      case 'validate-request':
        break;
    }
    const step = applyStep(phase, ctx);
    const outcome = await runApplyPhase({ store, base, context, step }, { complete: phase === 'report' });
    if (outcome.status === 'FAILED') throw outcome.error;
    // Raw phase result: the workflow machine reads fields like `desired`,
    // `plan`, `locks`, `candidate`, and `promotion` directly off each
    // dispatch response (see ApplyApplicationWorkflow in workflows.ts).
    return outcome.result as Record<string, unknown>;
  };

  const handlers: Record<string, WorkflowHandler> = {};
  for (const phase of APPLY_PHASES) handlers[`apply/${phase}`] = phaseHandler(phase);
  return handlers;
}

/**
 * Granular reconciliation phase handlers (master plan 22.3). Each phase is
 * dispatched by the `ReconcileApplicationWorkflow` as its own `step.do`
 * boundary and persists start/attempt/result/error through the D1 store.
 * Phases read their inputs from the dispatch payload (the workflow forwards
 * prior phase outputs explicitly). Access/read failures are surfaced as
 * typed UNKNOWN/BLOCKED verdicts — never SYNCED.
 */
function createReconcilePhaseHandlers(env: ControllerEnv['Bindings'], provider: CompositeProvider, github: GitHubAdapter): Record<string, WorkflowHandler> {
  const store = env.DB ? new D1LaunchpadStore(env.DB) : null;

  const phaseHandler = (phase: ReconcilePhaseName): WorkflowHandler => async (payload) => {
    if (!store) throw new Error('LP-STORE-CONFIG-MISSING');
    if (!env.CONTROL_REPOSITORY) throw new Error('LP-CONTROL-REPOSITORY-CONFIG-MISSING');
    const rawMode = payload.mode;
    if (rawMode === 'auto-restore') throw new Error('LP-RECONCILIATION-AUTO-RESTORE-DISABLED');
    const base = await makeReconcileBase({
      applicationId: requiredPayload<string>(payload, 'applicationId'),
      sourceCommit: typeof payload.sourceCommit === 'string' && payload.sourceCommit.length > 0 ? payload.sourceCommit : null,
      mode: rawMode === 'adopt-observed-state' || rawMode === 'restore-desired-state' ? rawMode : 'open-pr',
      shard: requiredPayload<number>(payload, 'shard'),
      shardCount: requiredPayload<number>(payload, 'shardCount'),
      triggeredAt: requiredPayload<string>(payload, 'triggeredAt'),
      workflowId: requiredPayload<string>(payload, 'workflowId'),
      idempotencyKey: requiredPayload<string>(payload, 'idempotencyKey'),
    });
    const context = contextFor(payload, base.applicationId);
    const ctx: ReconcileStepContext = {
      base,
      context,
      runtime: { store, provider },
      source: github,
      controlRepository: env.CONTROL_REPOSITORY,
      manifestPath: typeof payload.manifestPath === 'string' ? payload.manifestPath : (await store.getApplication(base.applicationId))?.sourcePath ?? manifestPathFor(env, base.applicationId),
      sourceCommit: base.sourceCommit,
    };
    switch (phase) {
      case 'observe-live-state':
        ctx.desired = payload.desired === null || payload.desired === undefined ? null : requiredPayload<DesiredApplication>(payload, 'desired');
        break;
      case 'diff-plan':
        ctx.desired = payload.desired === null || payload.desired === undefined ? null : requiredPayload<DesiredApplication>(payload, 'desired');
        ctx.observed = payload.observed === null || payload.observed === undefined ? null : requiredPayload<ObservedApplication>(payload, 'observed');
        ctx.capabilities = payload.capabilities === null || payload.capabilities === undefined ? null : requiredPayload<ProviderCapabilities>(payload, 'capabilities');
        ctx.accessErrors = requiredPayload<AccessError[]>(payload, 'accessErrors');
        ctx.manifestError = payload.manifestError === null || payload.manifestError === undefined ? null : requiredPayload<ManifestError>(payload, 'manifestError');
        break;
      case 'persist-status':
        ctx.diff = requiredPayload<DiffPlanResult>(payload, 'diff');
        ctx.observed = payload.observed === null || payload.observed === undefined ? null : requiredPayload<ObservedApplication>(payload, 'observed');
        break;
      case 'open-or-update-pr':
        ctx.diff = requiredPayload<DiffPlanResult>(payload, 'diff');
        ctx.desired = payload.desired === null || payload.desired === undefined ? null : requiredPayload<DesiredApplication>(payload, 'desired');
        ctx.observed = payload.observed === null || payload.observed === undefined ? null : requiredPayload<ObservedApplication>(payload, 'observed');
        ctx.rawManifest = payload.rawManifest === null || payload.rawManifest === undefined ? null : requiredPayload<string>(payload, 'rawManifest');
        break;
      case 'report':
        ctx.diff = requiredPayload<DiffPlanResult>(payload, 'diff');
        if (payload.pr !== null && payload.pr !== undefined && typeof payload.pr === 'object' && !Array.isArray(payload.pr)) {
          const pr = payload.pr as Record<string, unknown>;
          ctx.summary = {
            status: ctx.diff.status,
            sourceCommit: base.sourceCommit,
            driftFingerprint: ctx.diff.driftFingerprint,
            pullRequest: pr.pullRequest !== null && pr.pullRequest !== undefined && typeof pr.pullRequest === 'object' && !Array.isArray(pr.pullRequest) ? { number: Number((pr.pullRequest as Record<string, unknown>).number), url: String((pr.pullRequest as Record<string, unknown>).url) } : null,
            operation: pr.operation === 'adopt-observed-state' || pr.operation === 'restore-desired-state' ? pr.operation : null,
            driftCount: ctx.diff.drift.length,
            accessErrors: ctx.diff.accessErrors,
            blockedReason: ctx.diff.blockedReason,
          };
        }
        break;
      case 'resolve-main':
      case 'load-desired':
        break;
    }
    const step = reconcileStep(phase, ctx);
    const outcome = await runReconcilePhase({ store, base, context, step }, { complete: phase === 'report' });
    if (outcome.status === 'FAILED') throw outcome.error;
    // Raw phase result: the workflow machine reads fields like `sourceCommit`,
    // `desired`, `observed`, `capabilities`, `diff`, and `pr` directly off each
    // dispatch response (see ReconcileApplicationWorkflow in workflows.ts).
    return outcome.result as Record<string, unknown>;
  };

  const handlers: Record<string, WorkflowHandler> = {};
  for (const phase of RECONCILE_PHASES) handlers[`reconcile/${phase}`] = phaseHandler(phase);
  return handlers;
}

export interface WorkflowHandlerOptions {
  /**
   * Adapter instances to use instead of freshly constructed ones. The
   * controller production path omits this (defaults are constructed from
   * env), but the option is required for DNS verification: authoritative
   * DNS checking needs a resolver, and the integration tests record provider
   * transport through adapter `fetchImpl`s.
   */
  providers?: {
    vercel?: VercelAdapter;
    cloudflare?: CloudflareAdapter;
    github?: GitHubAdapter;
    secrets?: EnvironmentSecretProvider;
  };
}

/**
 * Builds the production Cloudflare adapter from controller environment.
 * When `LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL` is configured, the adapter
 * is constructed with the shared HTTPS authoritative DNS resolver so
 * `verifyAuthoritative` can check records against the zone's own
 * nameservers; a configured-but-invalid URL fails closed at construction.
 * Without the URL the adapter keeps the legacy behavior (verification fails
 * with a typed resolver-unconfigured error). The deploy pipeline requires a
 * concrete URL for production.
 */
export function createCloudflareAdapterForEnv(env: ControllerEnv['Bindings']): CloudflareAdapter {
  return new CloudflareAdapter({
    ...(env.CLOUDFLARE_TOKEN ? { token: env.CLOUDFLARE_TOKEN } : {}),
    ...(env.LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL ? { resolveDns: createAuthoritativeDnsResolver({ url: env.LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL }) } : {}),
  });
}

export function createWorkflowHandlers(env: ControllerEnv['Bindings'], repositories: LaunchpadRepositories, options: WorkflowHandlerOptions = {}): Record<string, WorkflowHandler> {
  const vercel = options.providers?.vercel ?? new VercelAdapter({ ...(env.VERCEL_TOKEN ? { token: env.VERCEL_TOKEN } : {}), ...(env.VERCEL_TEAM_ID ? { teamId: env.VERCEL_TEAM_ID } : {}) });
  const cloudflare = options.providers?.cloudflare ?? createCloudflareAdapterForEnv(env);
  const github = options.providers?.github ?? new GitHubAdapter({ ...(env.GITHUB_TOKEN ? { token: env.GITHUB_TOKEN } : {}) });
  const secrets = options.providers?.secrets ?? new EnvironmentSecretProvider();
  const provider = new CompositeProvider(vercel, cloudflare);
  const store = env.DB ? new D1LaunchpadStore(env.DB) : null;
  return {
    ...createApplyPhaseHandlers(env, provider, github, secrets),
    ...createReconcilePhaseHandlers(env, provider, github),
    apply: async (payload) => {
      // Legacy synchronous apply (pre-workflow internal dispatch contract). The
      // controller's apply ingress no longer calls this path; it enqueues the
      // granular ApplyApplicationWorkflow instead.
      if (!store) throw new Error('LP-STORE-CONFIG-MISSING');
      const desired = requiredPayload<DesiredApplication>(payload, 'desired');
      const observed = requiredPayload<ObservedApplication>(payload, 'observed');
      const plan = requiredPayload<PlatformPlan>(payload, 'plan');
      const result = await runApplyWorkflow({ store, provider, secrets, desired, observed, plan, sourceCommit: requiredPayload<string>(payload, 'sourceCommit'), context: contextFor(payload, desired.metadata.id) });
      return { ...result };
    },
    preview: async (payload) => {
      const desired = requiredPayload<DesiredApplication>(payload, 'desired');
      const context = contextFor(payload, desired.metadata.id);
      if (!store) throw new Error('LP-PREVIEW-STORE-MISSING');
      const sourceCommit = requiredPayload<string>(payload, 'sourceCommit');
      const payloadPlan = payload.plan !== null && typeof payload.plan === 'object' && !Array.isArray(payload.plan) ? payload.plan as PlatformPlan : undefined;
      const planFingerprint = typeof payload.planFingerprint === 'string' && payload.planFingerprint.length > 0 ? payload.planFingerprint : payloadPlan?.fingerprint;
      if (!planFingerprint) throw new Error('LP-WORKFLOW-PAYLOAD-MISSING-PLANFINGERPRINT');
      const revision = Number(payload.revision ?? payload.desiredGeneration ?? 1);
      const stage = typeof payload.stage === 'string' && payload.stage.length > 0 ? payload.stage : null;
      const base = {
        store,
        provider: vercel,
        source: github,
        desired,
        pullRequestNumber: Number(payload.pullRequestNumber ?? payload.prNumber ?? 0),
        repositoryId: (typeof payload.repositoryId === 'number' || typeof payload.repositoryId === 'string') && /^\d+$/.test(String(payload.repositoryId)) ? Number(payload.repositoryId) : undefined,
        revision,
        sourceCommit,
        planFingerprint,
        plan: payloadPlan,
        idempotencyKey: typeof payload.idempotencyKey === 'string' && payload.idempotencyKey.length > 0 ? payload.idempotencyKey : idempotencyKey('preview', desired.metadata.id, sourceCommit, String(revision)),
        context,
      };
      if (stage) {
        // The staged machine returns the raw persisted step result; the
        // workflow's per-stage outcomes are the documented evidence shape.
        return await runPreviewStage({ ...base, stage }) as unknown as Record<string, unknown>;
      }
      return await runPreviewWorkflow(base) as unknown as Record<string, unknown>;
    },
    'preview-cleanup': async (payload) => {
      const applicationId = requiredPayload<string>(payload, 'applicationId');
      if (!store) throw new Error('LP-PREVIEW-STORE-MISSING');
      const context = contextFor(payload, applicationId);
      const reason = payload.reason === 'PR_MERGED' ? 'PR_MERGED' : 'PR_CLOSED';
      const projectId = typeof payload.projectId === 'string' && payload.projectId.length > 0 ? payload.projectId : null;
      if (projectId) {
        return await cleanupShadowProject({ store, provider: vercel, context, applicationId, projectId, providerResourceId: typeof payload.providerResourceId === 'string' && payload.providerResourceId.length > 0 ? payload.providerResourceId : projectId, reason, cleanupJobId: typeof payload.cleanupJobId === 'string' ? payload.cleanupJobId : undefined }) as unknown as Record<string, unknown>;
      }
      const pullRequestNumber = Number(payload.pullRequestNumber ?? payload.prNumber ?? 0);
      if (pullRequestNumber <= 0) throw new Error('LP-WORKFLOW-PAYLOAD-MISSING-PRNUMBER');
      return await cleanupPreviewForPullRequest({ store, provider: vercel, context, applicationId, pullRequestNumber, reason }) as unknown as Record<string, unknown>;
    },
    'app-preview': async (payload) => {
      const applicationId = requiredPayload<string>(payload, 'applicationId');
      if (!env.CONTROL_REPOSITORY) throw new Error('LP-CONTROL-REPOSITORY-CONFIG-MISSING');
      const context = contextFor(payload, applicationId);
      const path = env.CONTROL_CATALOG_ROOT ? `${env.CONTROL_CATALOG_ROOT.replace(/\/$/, '')}/${applicationId}.yaml` : `catalog/apps/${applicationId}.yaml`;
      const content = await github.readFile(env.CONTROL_REPOSITORY, 'main', path, context);
      const catalog = loadCatalog([{ path, content }], { zones: await readZoneRegistry(github, env, context) });
      if (catalog.issues.length > 0) throw new Error(`LP-CONTROL-MANIFEST-INVALID:${catalog.issues[0]?.code ?? 'unknown'}`);
      const desired = catalog.applications.find((candidate) => candidate.metadata.id === applicationId);
      if (!desired) throw new Error('LP-CONTROL-APPLICATION-NOT_FOUND');
      const deployment = await vercel.findDeploymentByCommit(applicationId, requiredPayload<string>(payload, 'sourceCommit'), context);
      if (!deployment || !deployment.url) throw new Error('LP-VERCEL-PREVIEW-NOT_FOUND');
      const health = await checkHealth({ applicationId, environment: 'preview', deploymentId: deployment.id, baseUrl: deployment.url, spec: desired.environments.preview?.health ?? { path: '/api/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 10, attempts: 1, intervalSeconds: 0 } });
      return { applicationId, deployment, health };
    },
    'app-preview-status': async (payload) => {
      const applicationId = requiredPayload<string>(payload, 'applicationId');
      const sourceCommit = requiredPayload<string>(payload, 'sourceCommit');
      const repository = requiredPayload<string>(payload, 'repository');
      if (!store) throw new Error('LP-STORE-CONFIG-MISSING');
      if (!env.CONTROL_REPOSITORY) throw new HandlerFailure('LP-CONTROL-REPOSITORY-CONFIG-MISSING', 'The control repository is not configured.');
      const context = contextFor(payload, applicationId);
      const path = env.CONTROL_CATALOG_ROOT ? `${env.CONTROL_CATALOG_ROOT.replace(/\/$/, '')}/${applicationId}.yaml` : `catalog/apps/${applicationId}.yaml`;
      const content = await github.readFile(env.CONTROL_REPOSITORY, 'main', path, context);
      const catalog = loadCatalog([{ path, content }], { zones: await readZoneRegistry(github, env, context) });
      if (catalog.issues.length > 0) throw new HandlerFailure('LP-CONTROL-MANIFEST-INVALID', `The control manifest for ${applicationId} failed validation (${catalog.issues[0]?.code ?? 'unknown'}).`);
      const desired = catalog.applications.find((candidate) => candidate.metadata.id === applicationId);
      if (!desired) throw new HandlerFailure('LP-CONTROL-APPLICATION-NOT_FOUND', `No catalog application '${applicationId}' exists.`);
      if (desired.repository.name !== repository) throw new HandlerFailure('LP-SCOPE-REPOSITORY-MISMATCH', `OIDC token repository ${repository} is not the configured repository for ${applicationId}.`);
      // The preview-status workflow persists through the D1 store
      // (startWorkflowRun requires an application row); register a minimal
      // record like the OIDC enqueue path does.
      await ensureApplicationRegistered(store, applicationId, env.CONTROL_CATALOG_ROOT);
      return runAppPreviewStatusWorkflow({ store, provider: vercel, desired, sourceCommit, context, correlationId: typeof payload.correlationId === 'string' ? payload.correlationId : context.correlationId }) as unknown as Promise<Record<string, unknown>>;
    },
    // Dashboard direct recovery actions. These are the only dashboard-request
    // paths allowed to touch providers, and each is invoked only after the
    // operator action route has recorded an idempotent durable operation.
    'health-check': async (payload) => {
      const applicationId = requiredPayload<string>(payload, 'applicationId');
      if (!store) throw new Error('LP-STORE-CONFIG-MISSING');
      const context = contextFor(payload, applicationId);
      const knownGood = await store.getKnownGoodDeployment(applicationId, 'production');
      if (!knownGood || !knownGood.url) throw new HandlerFailure('LP-RECHECK-NO-KNOWN-GOOD', 'No known-good production deployment with a URL is recorded.');
      const check = await checkHealth({ applicationId, environment: 'production', deploymentId: knownGood.id, baseUrl: knownGood.url, spec: DEFAULT_HEALTH_SPEC });
      // HealthCheckRecord.url identifies the deployment (its base URL), not
      // the probed endpoint; the checked path is a property of the spec.
      const record = { ...check, url: knownGood.url };
      await store.recordHealthCheck(record);
      return { applicationId, check: record };
    },
    rollback: async (payload) => {
      const applicationId = requiredPayload<string>(payload, 'applicationId');
      const failedDeploymentId = requiredPayload<string>(payload, 'failedDeploymentId');
      const knownGoodDeploymentId = requiredPayload<string>(payload, 'knownGoodDeploymentId');
      if (!store) throw new Error('LP-STORE-CONFIG-MISSING');
      const context = contextFor(payload, applicationId);
      const knownGood = await store.getDeployment(knownGoodDeploymentId);
      if (!knownGood) throw new HandlerFailure('LP-ROLLBACK-KNOWN-GOOD-MISSING', 'The known-good deployment is no longer recorded.');
      if (knownGood.state !== 'CURRENT') throw new HandlerFailure('LP-ROLLBACK-KNOWN-GOOD-STALE', 'The recorded known-good deployment is not CURRENT.');
      const result = await rollbackProduction({ provider: vercel, projectId: knownGood.projectId, failedDeploymentId, knownGoodDeploymentId, context });
      return { applicationId, failedDeploymentId, knownGoodDeploymentId, result };
    },
    decommission: async (payload) => {
      // Legacy single-dispatch alias: the DecommissionApplicationWorkflow now
      // dispatches the granular `decommission/destroy` handler below.
      const applicationId = requiredPayload<string>(payload, 'applicationId');
      if (!store) throw new Error('LP-STORE-CONFIG-MISSING');
      if (!env.CONTROL_REPOSITORY) throw new HandlerFailure('LP-CONTROL-REPOSITORY-CONFIG-MISSING', 'The control repository is not configured.');
      const context = contextFor(payload, applicationId);
      const result = await runDecommissionWorkflow({
        applicationId,
        approvalId: requiredPayload<string>(payload, 'approvalId'),
        approvalToken: requiredPayload<string>(payload, 'approvalToken'),
        sourceCommit: requiredPayload<string>(payload, 'sourceCommit'),
        domain: requiredPayload<string>(payload, 'domain'),
        actor: typeof payload.actor === 'string' && payload.actor.length > 0 ? payload.actor : 'operator',
        now: typeof payload.now === 'string' && payload.now.length > 0 ? payload.now : new Date().toISOString(),
        idempotencyKey: requiredPayload<string>(payload, 'idempotencyKey'),
        workflowId: typeof payload.workflowId === 'string' && payload.workflowId.length > 0 ? payload.workflowId : crypto.randomUUID(),
        controlRepository: env.CONTROL_REPOSITORY,
        manifestPath: (await store.getApplication(applicationId))?.sourcePath ?? manifestPathFor(env, applicationId),
        dependentCatalog: await loadRegisteredCatalog({ store, source: github, controlRepository: env.CONTROL_REPOSITORY, catalogRoot: env.CONTROL_CATALOG_ROOT ?? 'catalog/apps', context }),
        provider,
        source: github,
        store,
        context,
      });
      return { ...result } as unknown as Record<string, unknown>;
    },
    'decommission/destroy': async (payload) => {
      const applicationId = requiredPayload<string>(payload, 'applicationId');
      if (!store) throw new Error('LP-STORE-CONFIG-MISSING');
      if (!env.CONTROL_REPOSITORY) throw new HandlerFailure('LP-CONTROL-REPOSITORY-CONFIG-MISSING', 'The control repository is not configured.');
      const context = contextFor(payload, applicationId);
      const result = await runDecommissionWorkflow({
        applicationId,
        approvalId: requiredPayload<string>(payload, 'approvalId'),
        approvalToken: requiredPayload<string>(payload, 'approvalToken'),
        sourceCommit: requiredPayload<string>(payload, 'sourceCommit'),
        domain: requiredPayload<string>(payload, 'domain'),
        actor: typeof payload.actor === 'string' && payload.actor.length > 0 ? payload.actor : 'operator',
        now: typeof payload.now === 'string' && payload.now.length > 0 ? payload.now : new Date().toISOString(),
        idempotencyKey: requiredPayload<string>(payload, 'idempotencyKey'),
        workflowId: requiredPayload<string>(payload, 'workflowId'),
        controlRepository: env.CONTROL_REPOSITORY,
        manifestPath: (await store.getApplication(applicationId))?.sourcePath ?? manifestPathFor(env, applicationId),
        dependentCatalog: await loadRegisteredCatalog({ store, source: github, controlRepository: env.CONTROL_REPOSITORY, catalogRoot: env.CONTROL_CATALOG_ROOT ?? 'catalog/apps', context }),
        provider,
        source: github,
        store,
        context,
      });
      return { ...result } as unknown as Record<string, unknown>;
    },
    'decommission/plan': async (payload) => {
      const applicationId = requiredPayload<string>(payload, 'applicationId');
      if (!env.CONTROL_REPOSITORY) throw new HandlerFailure('LP-CONTROL-REPOSITORY-CONFIG-MISSING', 'The control repository is not configured.');
      if (!store) throw new Error('LP-STORE-CONFIG-MISSING');
      const context = contextFor(payload, applicationId);
      const manifestPath = (await store.getApplication(applicationId))?.sourcePath ?? manifestPathFor(env, applicationId);
      const content = await github.readFile(env.CONTROL_REPOSITORY, 'main', manifestPath, context);
      const catalog = loadCatalog([{ path: manifestPath, content }], { zones: await readZoneRegistry(github, env, context) });
      if (catalog.issues.length > 0) throw new HandlerFailure('LP-CONTROL-MANIFEST-INVALID', `The control manifest for ${applicationId} failed validation (${catalog.issues[0]?.code ?? 'unknown'}).`);
      const manifest = catalog.applications.find((candidate) => candidate.metadata.id === applicationId);
      if (!manifest) throw new HandlerFailure('LP-CONTROL-APPLICATION-NOT_FOUND', `No catalog application '${applicationId}' exists.`);
      const dependentCatalog = await loadRegisteredCatalog({ store, source: github, controlRepository: env.CONTROL_REPOSITORY, catalogRoot: env.CONTROL_CATALOG_ROOT ?? 'catalog/apps', context });
      const result = await planDecommission({ source: github, controlRepository: env.CONTROL_REPOSITORY, manifestPath, applicationId, manifest, catalog: dependentCatalog, requestedAt: typeof payload.now === 'string' && payload.now.length > 0 ? payload.now : new Date().toISOString(), context });
      return { ...result } as unknown as Record<string, unknown>;
    },
    'decommission/approval': async (payload) => {
      const applicationId = requiredPayload<string>(payload, 'applicationId');
      if (!store) throw new Error('LP-STORE-CONFIG-MISSING');
      const context = contextFor(payload, applicationId);
      const sourceCommit = requiredPayload<string>(payload, 'sourceCommit');
      const domain = requiredPayload<string>(payload, 'domain');
      const actor = typeof payload.actor === 'string' && payload.actor.length > 0 ? payload.actor : 'operator';
      const now = typeof payload.now === 'string' && payload.now.length > 0 ? payload.now : new Date().toISOString();
      const expiresAt = typeof payload.expiresAt === 'string' && payload.expiresAt.length > 0 ? payload.expiresAt : new Date(new Date(now).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const issued = await issueDeletionApproval({ store, binding: { applicationId, domain, sourceCommit, actor, expiresAt }, now });
      return { approvalId: issued.approvalId, token: issued.token, applicationId, domain, sourceCommit, expiresAt } as unknown as Record<string, unknown>;
    },
    'decommission/reactivate': async (payload) => {
      const applicationId = requiredPayload<string>(payload, 'applicationId');
      if (!env.CONTROL_REPOSITORY) throw new HandlerFailure('LP-CONTROL-REPOSITORY-CONFIG-MISSING', 'The control repository is not configured.');
      if (!store) throw new Error('LP-STORE-CONFIG-MISSING');
      const context = contextFor(payload, applicationId);
      const manifestPath = (await store.getApplication(applicationId))?.sourcePath ?? manifestPathFor(env, applicationId);
      const content = await github.readFile(env.CONTROL_REPOSITORY, 'main', manifestPath, context);
      const catalog = loadCatalog([{ path: manifestPath, content }], { zones: await readZoneRegistry(github, env, context) });
      if (catalog.issues.length > 0) throw new HandlerFailure('LP-CONTROL-MANIFEST-INVALID', `The control manifest for ${applicationId} failed validation (${catalog.issues[0]?.code ?? 'unknown'}).`);
      const manifest = catalog.applications.find((candidate) => candidate.metadata.id === applicationId);
      if (!manifest) throw new HandlerFailure('LP-CONTROL-APPLICATION-NOT_FOUND', `No catalog application '${applicationId}' exists.`);
      const result = await reactivateApplication({ source: github, controlRepository: env.CONTROL_REPOSITORY, manifestPath, applicationId, manifest, reason: typeof payload.reason === 'string' && payload.reason.length > 0 ? payload.reason : 'operator request', context });
      return { ...result } as unknown as Record<string, unknown>;
    },
    secrets: async (payload) => {
      const reference = requiredPayload<string>(payload, 'reference');
      const value = await secrets.fingerprint(reference, contextFor(payload, 'applicationId') ?? contextFor(payload, 'platform'));
      return { fingerprint: value };
    },
  };
}

export function controllerDependencies(env: ControllerEnv['Bindings'], repositories: LaunchpadRepositories, observability?: ObservabilityDeps): ControllerDependencies {
  return {
    operatorToken: env.OPERATOR_TOKEN ?? '',
    internalWorkflowToken: env.CONTROLLER_INTERNAL_TOKEN,
    webhookSecret: env.VERCEL_WEBHOOK_SECRET,
    githubToken: env.GITHUB_TOKEN,
    controlCatalogRoot: env.CONTROL_CATALOG_ROOT,
    controlRepository: env.CONTROL_REPOSITORY,
    oidc: oidcConfigFromEnv(env),
    workflowHandlers: createWorkflowHandlers(env, repositories),
    logger: observability?.logger,
    metrics: observability?.metrics,
    observability,
  };
}
