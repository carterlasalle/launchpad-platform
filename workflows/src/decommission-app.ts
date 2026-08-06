import { canonicalJson, idempotencyKey, sha256Hex } from '@launchpad/shared';
import { loadCatalog } from '@launchpad/catalog';
import type { DesiredApplication, LifecycleState } from '@launchpad/core';
import type { LaunchpadStore, ResourceRecord } from '@launchpad/database';
import type { DnsProvider, ProjectProvider, ProviderContext, SourceProvider } from '@launchpad/provider-contract';
import { stringify } from 'yaml';
import { DurableOperationRunner, errorCodeOf, type DurableStep, type OperationRunResult } from './operation-runner.js';
import { WorkflowFailure, releaseOwnedLocks, type HeldLocks } from './apply-app.js';

/**
 * Launchpad 1.0 lifecycle and deletion controller (master plan sections 13.10,
 * 19, 42). Implements the only reviewed path that may destroy provider
 * resources:
 *
 * - explicit lifecycle transitions active → decommissioning →
 *   approved-for-deletion → deleted, with reverse reactivation gated on the
 *   declared recovery policy before deletion approval;
 * - a first deletion PR carrying the impact/reverse-dependent report,
 *   requestedAt and deleteAfter cooling-off (promotion stops, service stays);
 * - a cryptographically random, single-use approval token whose SHA-256
 *   fingerprint is the only persisted form, bound to application + domain +
 *   approved source commit + actor + expiry;
 * - a granular, durable, ordered destroy machine with one `DurableStep` per
 *   provider mutation/readback, ownership re-verification before every
 *   destructive mutation, and safe resume after interruption;
 * - a final export, tombstone (with retention + reviewed override path) and
 *   immutable audit trail.
 *
 * Manifest disappearance is never a deletion: every path that could destroy
 * resources fails with `BLOCKED_MISSING_MANIFEST` before any provider write.
 */

export const DECOMMISSION_VERSION = 1 as const;
export const DECOMMISSION_KIND = 'decommission' as const;
export const DEFAULT_COOLING_OFF_MS = 48 * 60 * 60 * 1000;
export const DEFAULT_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const LOCK_LEASE_SECONDS = 900;

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------

/**
 * Enforces the explicit lifecycle machine. Reverse reactivation
 * (decommissioning → active) is only permitted before deletion approval and
 * only when the declared recovery policy allows it; the reviewed recovery PR
 * is what declares that policy (semantic catalog validation mirrors this).
 */
export function assertLifecycleTransition(
  current: LifecycleState,
  next: LifecycleState,
  recoveryPolicy: { allowReactivateBeforeDeletionApproval?: boolean } | undefined,
): void {
  if (current === next) return;
  const allowed: ReadonlyArray<LifecycleState> = current === 'active'
    ? ['decommissioning']
    : current === 'decommissioning'
      ? ['active', 'approved-for-deletion']
      : current === 'approved-for-deletion'
        ? ['deleted']
        : [];
  if (allowed.includes(next)) {
    if (next === 'active' && recoveryPolicy?.allowReactivateBeforeDeletionApproval !== true) {
      throw new WorkflowFailure('LP-LIFECYCLE-RECOVERY-POLICY-REQUIRED', `Reactivating '${current}' → 'active' requires lifecycle.recoveryPolicy.allowReactivateBeforeDeletionApproval: true in a reviewed PR.`);
    }
    return;
  }
  throw new WorkflowFailure('LP-LIFECYCLE-TRANSITION-INVALID', `Lifecycle transition '${current}' → '${next}' is not allowed.`, false, { from: current, to: next });
}

// ---------------------------------------------------------------------------
// Reverse dependents and impact report
// ---------------------------------------------------------------------------

export interface ReverseDependent {
  applicationId: string;
  via: 'application-dependency' | 'external-url';
  detail: string;
}

/**
 * Applications that depend on `applicationId` (or reference one of its
 * domains in an external link). Deletion is blocked while any exist.
 */
export function findReverseDependents(applicationId: string, catalog: readonly DesiredApplication[], domains: readonly string[]): ReverseDependent[] {
  const dependents: ReverseDependent[] = [];
  const domainSet = new Set(domains);
  for (const candidate of catalog) {
    if (candidate.metadata.id === applicationId) continue;
    if (candidate.dependencies.applications.includes(applicationId)) {
      dependents.push({ applicationId: candidate.metadata.id, via: 'application-dependency', detail: `${candidate.metadata.id} depends on ${applicationId}` });
    }
    for (const external of candidate.dependencies.external) {
      let hostname: string | null = null;
      try {
        hostname = new URL(external.url).hostname;
      } catch {
        hostname = null;
      }
      if (hostname !== null && domainSet.has(hostname)) {
        dependents.push({ applicationId: candidate.metadata.id, via: 'external-url', detail: `${candidate.metadata.id} external '${external.id}' references ${hostname}` });
      }
    }
  }
  return dependents;
}

export interface DecommissionImpactReport {
  applicationId: string;
  reverseDependents: ReverseDependent[];
  promotionStopped: boolean;
  serviceKept: boolean;
  requestedAt: string;
  deleteAfter: string;
  /** Dependents that would block the final destroy until resolved. */
  blockingDependents: string[];
}

export interface DecommissionPlanResult {
  status: 'PR_OPENED' | 'ALREADY_DECOMMISSIONING' | 'BLOCKED';
  report: DecommissionImpactReport | null;
  pullRequest: { number: number; url: string } | null;
  errorCode: string | null;
}

export interface ReactivationResult {
  status: 'PR_OPENED' | 'BLOCKED' | 'NOT_DECOMMISSIONING';
  pullRequest: { number: number; url: string } | null;
  errorCode: string | null;
}

function manifestFor(applicationId: string, manifestPath: string, content: string, commit: string): DesiredApplication {
  const catalog = loadCatalog([{ path: manifestPath, content }]);
  if (catalog.issues.length > 0) {
    throw new WorkflowFailure('LP-CONTROL-MANIFEST-INVALID', `Catalog validation failed for ${manifestPath} at ${commit}: ${catalog.issues[0]?.code ?? 'unknown'}.`);
  }
  const application = catalog.applications.find((candidate) => candidate.metadata.id === applicationId);
  if (!application) {
    throw new WorkflowFailure('LP-CONTROL-APPLICATION-NOT_FOUND', `No manifest for application '${applicationId}' at ${commit}.`);
  }
  return application;
}

/**
 * First deletion PR (master plan 19.1): flips the manifest to
 * `decommissioning` with requestedAt/deleteAfter, stops promotion (lifecycle
 * gate), keeps the service running, and attaches the impact report with
 * reverse dependents to the PR body. One open PR per application: the branch
 * is stable and `createOrUpdatePullRequest` reopens/updates it.
 */
export async function planDecommission(input: {
  source: SourceProvider;
  controlRepository: string;
  manifestPath: string;
  applicationId: string;
  manifest: DesiredApplication;
  catalog: DesiredApplication[];
  requestedAt?: string;
  coolingOffMs?: number;
  context: ProviderContext;
}): Promise<DecommissionPlanResult> {
  const requestedAt = input.requestedAt ?? new Date().toISOString();
  const coolingOffMs = input.coolingOffMs ?? DEFAULT_COOLING_OFF_MS;
  const state = input.manifest.lifecycle.state;
  const domains = input.manifest.domains.map((domain) => domain.hostname);
  const reverseDependents = findReverseDependents(input.applicationId, input.catalog, domains);
  const deleteAfter = new Date(new Date(requestedAt).getTime() + coolingOffMs).toISOString();
  const report: DecommissionImpactReport = {
    applicationId: input.applicationId,
    reverseDependents,
    promotionStopped: true,
    serviceKept: true,
    requestedAt,
    deleteAfter,
    blockingDependents: reverseDependents.map((dependent) => dependent.applicationId),
  };
  if (state === 'decommissioning' || state === 'approved-for-deletion' || state === 'deleted') {
    return { status: 'ALREADY_DECOMMISSIONING', report, pullRequest: null, errorCode: null };
  }
  if (state !== 'active') {
    return { status: 'BLOCKED', report, pullRequest: null, errorCode: 'LP-LIFECYCLE-TRANSITION-INVALID' };
  }
  const updated: DesiredApplication = {
    ...input.manifest,
    lifecycle: {
      ...input.manifest.lifecycle,
      state: 'decommissioning',
      deletionProtection: true,
      decommission: { ...input.manifest.lifecycle.decommission, requestedAt, deleteAfter, approvalToken: null },
    },
  };
  const body = [
    '## Launchpad decommission request',
    '',
    `Application: ${input.applicationId}`,
    `Requested at: ${requestedAt}`,
    `Cooling-off until (deleteAfter): ${deleteAfter}`,
    '',
    'This PR begins the reviewed decommissioning flow:',
    '- New production promotion is stopped while this application is decommissioning.',
    '- The project and domain remain fully active (no provider mutation).',
    '- Deletion only becomes possible after a second reviewed PR sets `approved-for-deletion` and a single-use approval token is consumed by the destroy workflow.',
    '',
    '### Impact report',
    '',
    reverseDependents.length === 0
      ? '- No reverse dependents found.'
      : reverseDependents.map((dependent) => `- ${dependent.detail}`).join('\n'),
    '',
    reverseDependents.length > 0 ? 'The dependents above must be resolved before the final destroy can run (LP-DESTROY-DEPENDENTS).' : '',
  ].join('\n');
  const pullRequest = await input.source.createOrUpdatePullRequest({
    repository: input.controlRepository,
    branch: `decommission/${input.applicationId}`,
    title: `decommission: ${input.applicationId}`,
    body,
    files: { [input.manifestPath]: stringify(updated as unknown as Record<string, unknown>, { aliasDuplicateObjects: false, lineWidth: 0 }) },
  }, input.context);
  return { status: 'PR_OPENED', report, pullRequest, errorCode: null };
}

/**
 * Reviewed recovery path (before deletion approval): opens a PR returning
 * `decommissioning` → `active` while declaring the recovery policy the
 * semantic catalog gate requires. Approved-for-deletion manifests are
 * immutable to reactivation.
 */
export async function reactivateApplication(input: {
  source: SourceProvider;
  controlRepository: string;
  manifestPath: string;
  applicationId: string;
  manifest: DesiredApplication;
  reason: string;
  context: ProviderContext;
}): Promise<ReactivationResult> {
  const state = input.manifest.lifecycle.state;
  if (state === 'approved-for-deletion' || state === 'deleted') {
    return { status: 'BLOCKED', pullRequest: null, errorCode: 'LP-LIFECYCLE-REACTIVATION-AFTER-APPROVAL-BLOCKED' };
  }
  if (state !== 'decommissioning') return { status: 'NOT_DECOMMISSIONING', pullRequest: null, errorCode: null };
  const updated: DesiredApplication = {
    ...input.manifest,
    lifecycle: {
      ...input.manifest.lifecycle,
      state: 'active',
      decommission: { ...input.manifest.lifecycle.decommission, requestedAt: null, deleteAfter: null, approvalToken: null },
      recoveryPolicy: { allowReactivateBeforeDeletionApproval: true },
    },
  };
  const body = [
    '## Launchpad reactivation request',
    '',
    `Application: ${input.applicationId}`,
    `Reason: ${input.reason}`,
    '',
    'This reviewed PR cancels decommissioning before deletion approval and declares `recoveryPolicy.allowReactivateBeforeDeletionApproval: true` (required by the lifecycle transition gate).',
  ].join('\n');
  const pullRequest = await input.source.createOrUpdatePullRequest({
    repository: input.controlRepository,
    branch: `decommission/${input.applicationId}`,
    title: `reactivate: ${input.applicationId}`,
    body,
    files: { [input.manifestPath]: stringify(updated as unknown as Record<string, unknown>, { aliasDuplicateObjects: false, lineWidth: 0 }) },
  }, input.context);
  return { status: 'PR_OPENED', pullRequest, errorCode: null };
}

// ---------------------------------------------------------------------------
// Approval token service
// ---------------------------------------------------------------------------

/** Binding contract captured at issuance and re-verified at destruction. */
export interface DeletionApprovalBinding {
  applicationId: string;
  domain: string;
  /** Approved (merged final deletion PR) source commit. */
  sourceCommit: string;
  actor: string;
  /** Filled from the persisted approval at destruction time. */
  expiresAt?: string;
}

/** Cryptographically random 256-bit token; shown once at issuance. */
export function generateApprovalToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function validateBinding(binding: DeletionApprovalBinding, now: string): void {
  if (binding.applicationId.trim().length === 0) throw new WorkflowFailure('LP-APPROVAL-BINDING-APPLICATION-REQUIRED', 'Approval issuance requires an applicationId.');
  if (binding.domain.trim().length === 0) throw new WorkflowFailure('LP-APPROVAL-BINDING-DOMAIN-REQUIRED', 'Approval issuance requires the production domain.');
  if (!COMMIT_SHA_PATTERN.test(binding.sourceCommit)) throw new WorkflowFailure('LP-APPROVAL-BINDING-COMMIT-INVALID', 'Approval issuance requires a 40-hex approved sourceCommit.');
  if (binding.actor.trim().length === 0) throw new WorkflowFailure('LP-APPROVAL-BINDING-ACTOR-REQUIRED', 'Approval issuance requires an operator identity.');
  if (binding.expiresAt === undefined) throw new WorkflowFailure('LP-APPROVAL-EXPIRY-REQUIRED', 'Approval issuance requires an expiry.');
  if (new Date(binding.expiresAt).getTime() <= new Date(now).getTime()) {
    throw new WorkflowFailure('LP-APPROVAL-EXPIRY-INVALID', `Approval expiry '${binding.expiresAt}' must be in the future.`);
  }
}

/**
 * Issues a single-use deletion approval. The raw token is returned exactly
 * once and is never persisted: the store keeps only its SHA-256 fingerprint,
 * and the full binding (application, domain, approved source commit, actor,
 * expiry) is recorded in the immutable audit trail for destruction-time
 * re-verification.
 */
export async function issueDeletionApproval(input: {
  store: LaunchpadStore;
  binding: DeletionApprovalBinding;
  now?: string;
}): Promise<{ approvalId: string; token: string; binding: DeletionApprovalBinding }> {
  const now = input.now ?? new Date().toISOString();
  validateBinding(input.binding, now);
  const token = generateApprovalToken();
  const approval = await input.store.createDeletionApproval({
    applicationId: input.binding.applicationId,
    token,
    requestedBy: input.binding.actor,
    expiresAt: input.binding.expiresAt ?? '',
  });
  await input.store.appendAudit({
    actor: `operator:${input.binding.actor}`,
    action: 'DELETION_APPROVAL_ISSUED',
    applicationId: input.binding.applicationId,
    details: {
      approvalId: approval.id,
      applicationId: input.binding.applicationId,
      domain: input.binding.domain,
      sourceCommit: input.binding.sourceCommit,
      actor: input.binding.actor,
      expiresAt: input.binding.expiresAt,
    },
  });
  return { approvalId: approval.id, token, binding: input.binding };
}

/**
 * Destruction-time verification: re-derives the binding from the persisted
 * issuance audit record, compares it field-by-field with the presented
 * binding (a mismatch never consumes the token), then consumes the token in
 * a single-use transaction (USED/REVOKED/EXPIRED fail closed).
 */
export async function consumeDeletionApproval(input: {
  store: LaunchpadStore;
  approvalId: string;
  binding: DeletionApprovalBinding;
  token: string;
  now: string;
}): Promise<{ approvalId: string; consumedAt: string }> {
  const approvals = await input.store.listDeletionApprovals(input.binding.applicationId);
  const approval = approvals.find((candidate) => candidate.id === input.approvalId);
  if (!approval) throw new WorkflowFailure('LP-DESTROY-APPROVAL-NOT_FOUND', `Deletion approval '${input.approvalId}' does not exist for '${input.binding.applicationId}'.`);
  if (approval.status === 'USED') throw new WorkflowFailure('LP-DESTROY-APPROVAL-USED', `Deletion approval '${input.approvalId}' was already consumed; a fresh approval is required.`);
  if (approval.status === 'REVOKED') throw new WorkflowFailure('LP-DESTROY-APPROVAL-REVOKED', `Deletion approval '${input.approvalId}' was revoked.`);
  if (approval.expiresAt < input.now) throw new WorkflowFailure('LP-DESTROY-APPROVAL-EXPIRED', `Deletion approval '${input.approvalId}' expired at ${approval.expiresAt}.`);
  if (approval.requestedBy !== null && approval.requestedBy !== input.binding.actor) {
    throw new WorkflowFailure('LP-DESTROY-APPROVAL-BINDING-MISMATCH', 'The presented operator identity does not match the approved actor.');
  }
  const issued = (await input.store.listAudit(input.binding.applicationId)).find((event) => event.action === 'DELETION_APPROVAL_ISSUED' && typeof event.details === 'object' && event.details !== null && event.details.approvalId === input.approvalId);
  if (!issued) throw new WorkflowFailure('LP-DESTROY-APPROVAL-BINDING-MISSING', 'The approval has no issuance record; destruction is refused.');
  const recorded = issued.details as Record<string, unknown>;
  const bindingFields: Array<keyof DeletionApprovalBinding> = ['applicationId', 'domain', 'sourceCommit', 'actor'];
  const mismatches = bindingFields.filter((field) => recorded[field] !== input.binding[field]);
  if (mismatches.length > 0) {
    throw new WorkflowFailure('LP-DESTROY-APPROVAL-BINDING-MISMATCH', `The presented ${mismatches.join(', ')} do not match the approved binding; destruction is refused.`, false, { mismatches });
  }
  await input.store.consumeDeletionApproval(input.binding.applicationId, input.token, input.now);
  return { approvalId: input.approvalId, consumedAt: input.now };
}

// ---------------------------------------------------------------------------
// Tombstone reuse retention and reviewed override
// ---------------------------------------------------------------------------

export interface TombstoneOverrideEvidence {
  reviewedBy: string;
  reviewedAt: string;
  reason: string;
  evidenceUrl?: string | null;
}

export type TombstoneReuseVerdict =
  | { allowed: true; released: boolean; retainUntil: string | null }
  | { allowed: false; code: 'LP-TOMBSTONE-REUSE-BLOCKED' | 'LP-TOMBSTONE-OVERRIDE-REQUIRED'; message: string; retainUntil: string | null };

/**
 * TR-LIFE-006 reuse gate: a tombstoned application ID or domain cannot be
 * registered again until the retention window elapses, or a reviewed override
 * is supplied. When the gate passes, the tombstone is released with
 * attributable evidence so the registration path can proceed.
 */
export async function assertTombstoneReuseAllowed(input: {
  store: LaunchpadStore;
  applicationId: string;
  domain: string;
  now: string;
  override?: TombstoneOverrideEvidence | null;
}): Promise<TombstoneReuseVerdict> {
  const tombstone = await input.store.getTombstone(input.applicationId);
  const domainTombstoned = await input.store.isDomainTombstoned(input.domain);
  if (!tombstone && !domainTombstoned) return { allowed: true, released: false, retainUntil: null };
  if (tombstone !== null && domainTombstoned && tombstone.domain !== input.domain) {
    return { allowed: false, code: 'LP-TOMBSTONE-REUSE-BLOCKED', message: `Domain '${input.domain}' is retained by another tombstoned application; the reviewed override must release that tombstone first.`, retainUntil: tombstone.retainUntil };
  }
  const retainUntil = tombstone?.retainUntil ?? null;
  const retentionElapsed = retainUntil !== null && retainUntil <= input.now;
  const override = input.override ?? null;
  const reviewed = override !== null && override.reviewedBy.trim().length > 0 && override.reason.trim().length > 0 && override.reviewedAt.length > 0 && override.reviewedAt <= input.now;
  if (!retentionElapsed && !reviewed) {
    if (override !== null) {
      return { allowed: false, code: 'LP-TOMBSTONE-OVERRIDE-REQUIRED', message: 'The tombstone override is incomplete: reviewedBy, reason, and a past reviewedAt are required before reuse.', retainUntil };
    }
    return { allowed: false, code: 'LP-TOMBSTONE-REUSE-BLOCKED', message: `Application '${input.applicationId}' is tombstoned until ${retainUntil ?? 'unknown'}; reuse is blocked until retention elapses or a reviewed override is supplied.`, retainUntil };
  }
  const evidence = retentionElapsed
    ? { reviewedBy: 'retention-policy', reason: `Tombstone retention for ${input.applicationId} elapsed at ${retainUntil ?? 'unknown'}` }
    : { reviewedBy: override?.reviewedBy ?? '', reason: override?.reason ?? '' };
  await input.store.releaseTombstone({ applicationId: input.applicationId, reviewedBy: evidence.reviewedBy, reason: evidence.reason, reviewedAt: input.now });
  return { allowed: true, released: true, retainUntil };
}

// ---------------------------------------------------------------------------
// Registered catalog for dependent checks
// ---------------------------------------------------------------------------

/**
 * Loads the manifests of every registered application at the current main
 * commit (bounded by the D1 application ledger) so the destroy machine can
 * compute reverse dependents from Git-desired state. Manifests that fail to
 * load or parse are skipped: they hold no resources and cannot be functional
 * dependents.
 */
export async function loadRegisteredCatalog(input: {
  store: LaunchpadStore;
  source: SourceProvider;
  controlRepository: string;
  catalogRoot: string;
  context: ProviderContext;
}): Promise<DesiredApplication[]> {
  const rows = await input.store.listApplications();
  const files: Array<{ path: string; content: string }> = [];
  for (const row of rows) {
    const registered = await input.store.getApplication(row.application);
    const path = registered?.sourcePath ?? `${input.catalogRoot.replace(/\/$/, '')}/${row.application}.yaml`;
    try {
      files.push({ path, content: await input.source.readFile(input.controlRepository, 'main', path, input.context) });
    } catch {
      // Unreadable manifests are skipped: they hold no resources and cannot
      // be functional dependents.
    }
  }
  // Batch-load every registered manifest in ONE catalog so application
  // dependencies resolve across the set. Loading each manifest in isolation
  // makes any declared dependency fail as LP-CATALOG-MISSING-DEPENDENCY and
  // the dependent would be dropped from the reverse-dependent gate, which
  // would silently bypass LP-DESTROY-DEPENDENTS.
  const catalog = loadCatalog(files);
  return catalog.applications;
}

// ---------------------------------------------------------------------------
// Granular destroy machine
// ---------------------------------------------------------------------------

export interface DecommissionDestroyInput {
  applicationId: string;
  approvalId: string;
  approvalToken: string;
  /** Approved (merged final deletion PR) commit whose manifest authorizes destruction. */
  sourceCommit: string;
  /** Production domain bound to the approval. */
  domain: string;
  actor: string;
  now: string;
  idempotencyKey: string;
  workflowId: string;
  controlRepository: string;
  manifestPath: string;
  /** Reverse-dependent candidates loaded from the control repository at main. */
  dependentCatalog: DesiredApplication[];
  provider: ProjectProvider & DnsProvider;
  source: SourceProvider;
  store: LaunchpadStore;
  context: ProviderContext;
  tombstoneRetentionMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

export interface DecommissionDestroyResult {
  status: 'DELETED' | 'FAILED';
  applicationId: string;
  operationId: string;
  failedStep: string | null;
  errorCode: string | null;
  exportJson: string;
  tombstone: { applicationId: string; domain: string; retainUntil: string } | null;
  error: unknown;
}

interface ApprovedManifestOutput { manifest: DesiredApplication; mainManifest: DesiredApplication; }
interface ExportOutput { exportJson: string; }
interface TombstoneOutput { tombstone: { applicationId: string; domain: string; retainUntil: string }; }

function expectedDnsOwnership(applicationId: string, hostname: string): string {
  // Exact convention the apply machine writes (applyEnsureDns).
  return idempotencyKey('ownership', applicationId, hostname);
}

function projectLedgerFingerprint(resources: readonly ResourceRecord[]): string | null {
  return resources.find((resource) => resource.resourceKey === 'vercel.project' || resource.resourceKey === 'vercel.settings')?.ownershipFingerprint ?? null;
}

interface DestroyDomain { hostname: string; environment: DesiredApplication['domains'][number]['environment']; zoneRef: string; proxied: boolean; }

function domainsOf(manifest: DesiredApplication): DestroyDomain[] {
  return manifest.domains.map((domain) => ({ hostname: domain.hostname, environment: domain.environment, zoneRef: domain.cloudflare.zoneRef, proxied: domain.cloudflare.mode === 'proxied' }));
}

function productionDomainOf(manifest: DesiredApplication): string {
  return domainsOf(manifest).find((domain) => domain.environment === 'production')?.hostname ?? `${manifest.metadata.id}.unknown`;
}

function manifestOutput(stepContext: { outputs: Readonly<Record<string, unknown>> }): ApprovedManifestOutput {
  const output = stepContext.outputs['load-approved-manifest'];
  if (output === null || output === undefined) throw new WorkflowFailure('LP-WORKFLOW-STEP-INPUT-MISSING', "Step 'load-approved-manifest' has no persisted output; the machine resumed from an inconsistent boundary.");
  return output as ApprovedManifestOutput;
}

/** Builds the ordered destroy machine. Every step is durable and idempotent; resume replays only failed steps. */
export function buildDecommissionMachine(input: DecommissionDestroyInput): DurableStep[] {
  const { applicationId, approvalId, approvalToken, sourceCommit, domain, actor, now, controlRepository, manifestPath, dependentCatalog, provider, source, store, context } = input;
  const retentionMs = input.tombstoneRetentionMs ?? DEFAULT_TOMBSTONE_RETENTION_MS;
  const lockOwner = input.workflowId;
  const request = { applicationId, approvalId, sourceCommit, domain, actor };
  const manifestPrecondition = canonicalJson({ applicationId, sourceCommit, manifestPath });
  const manifestBound = canonicalJson({ applicationId, sourceCommit });
  const step = (id: string, preconditionHash: string, run: (stepContext: { outputs: Readonly<Record<string, unknown>> }) => Promise<unknown>): DurableStep => ({ id, preconditionHash, run: async (_attempt, stepContext) => run(stepContext) });

  return [
    step('validate-destroy-request', canonicalJson(request), async () => {
      if (approvalId.trim().length === 0) throw new WorkflowFailure('LP-DESTROY-REQUEST-APPROVAL-ID-REQUIRED', 'approvalId is required.');
      if (approvalToken.trim().length === 0) throw new WorkflowFailure('LP-DESTROY-REQUEST-TOKEN-REQUIRED', 'approvalToken is required.');
      if (!COMMIT_SHA_PATTERN.test(sourceCommit)) throw new WorkflowFailure('LP-DESTROY-REQUEST-COMMIT-INVALID', 'sourceCommit must be a 40-hex commit sha.');
      if (domain.trim().length === 0) throw new WorkflowFailure('LP-DESTROY-REQUEST-DOMAIN-REQUIRED', 'domain is required.');
      return { accepted: true };
    }),
    step('load-approved-manifest', manifestPrecondition, async () => {
      let content: string;
      try {
        content = await source.readFile(controlRepository, sourceCommit, manifestPath, context);
      } catch {
        // TR-LIFE-001: manifest disappearance is never a deletion.
        throw new WorkflowFailure('BLOCKED_MISSING_MANIFEST', `The manifest ${manifestPath} is not present at ${sourceCommit}; missing manifests never authorize deletion.`);
      }
      const manifest = manifestFor(applicationId, manifestPath, content, sourceCommit);
      const lifecycle = manifest.lifecycle;
      if (lifecycle.state !== 'approved-for-deletion') {
        throw new WorkflowFailure('LP-DESTROY-LIFECYCLE-BLOCKED', `Lifecycle must be 'approved-for-deletion' at ${sourceCommit}, got '${lifecycle.state}'.`, false, { state: lifecycle.state });
      }
      if (lifecycle.deletionProtection) throw new WorkflowFailure('LP-DESTROY-PROTECTION', 'deletionProtection is still enabled; destruction is refused.');
      if (!lifecycle.decommission.requestedAt) throw new WorkflowFailure('LP-DESTROY-REQUEST-MISSING', 'The approved manifest has no decommission.requestedAt.');
      if (!lifecycle.decommission.deleteAfter) throw new WorkflowFailure('LP-DESTROY-SCHEDULE-MISSING', 'The approved manifest has no decommission.deleteAfter.');
      if (new Date(lifecycle.decommission.deleteAfter).getTime() > new Date(now).getTime()) {
        throw new WorkflowFailure('LP-DESTROY-COOLING-OFF', `The cooling-off period has not elapsed (deleteAfter ${lifecycle.decommission.deleteAfter}).`, false, { deleteAfter: lifecycle.decommission.deleteAfter });
      }
      // Stale approval commit: the manifest must still be the reviewed
      // current state on main; any movement invalidates the approval.
      let mainContent: string;
      try {
        mainContent = await source.readFile(controlRepository, 'main', manifestPath, context);
      } catch {
        throw new WorkflowFailure('BLOCKED_MISSING_MANIFEST', `The manifest ${manifestPath} is not present on main; missing manifests never authorize deletion.`);
      }
      const mainManifest = manifestFor(applicationId, manifestPath, mainContent, 'main');
      if (canonicalJson(mainManifest) !== canonicalJson(manifest)) {
        throw new WorkflowFailure('LP-DESTROY-APPROVAL-COMMIT-STALE', `The manifest changed on main after ${sourceCommit}; the approval commit is stale and destruction is refused.`);
      }
      return { manifest, mainManifest };
    }),
    step('verify-approval', canonicalJson({ ...request, approvalTokenHash: '' }), async (stepContext) => {
      const manifest = manifestOutput(stepContext).manifest;
      const bound = productionDomainOf(manifest);
      if (bound !== domain) {
        throw new WorkflowFailure('LP-DESTROY-DOMAIN-MISMATCH', `The approved manifest's production domain '${bound}' does not match the approved binding '${domain}'.`);
      }
      return consumeDeletionApproval({ store, approvalId, binding: { applicationId, domain, sourceCommit, actor }, token: approvalToken, now });
    }),
    step('check-dependents', canonicalJson({ applicationId, dependentCatalog: dependentCatalog.map((application) => application.metadata.id) }), async (stepContext) => {
      const manifest = manifestOutput(stepContext).manifest;
      const dependents = findReverseDependents(applicationId, dependentCatalog, manifest.domains.map((item) => item.hostname));
      if (dependents.length > 0) {
        throw new WorkflowFailure('LP-DESTROY-DEPENDENTS', `Deletion is blocked by ${dependents.length} reverse dependent(s): ${dependents.map((dependent) => dependent.applicationId).join(', ')}.`, false, { dependents });
      }
      return { dependents: [] };
    }),
    step('check-operations-and-locks', canonicalJson(request), async (stepContext) => {
      const open = await store.listOpenWorkflowRuns(applicationId);
      // Exclude the current destroy run (same idempotency key across resumes).
      const blocking = open.filter((run) => run.idempotencyKey !== input.idempotencyKey);
      if (blocking.length > 0) {
        throw new WorkflowFailure('LP-DESTROY-BLOCKING-OPERATIONS', `Destruction is blocked by ${blocking.length} active operation(s): ${blocking.map((run) => run.id).join(', ')}.`, false, { operationIds: blocking.map((run) => run.id) });
      }
      const manifest = manifestOutput(stepContext).manifest;
      const locks: HeldLocks = {
        applicationId,
        ownerId: lockOwner,
        leaseSeconds: LOCK_LEASE_SECONDS,
        application: `application:${applicationId}`,
        domains: manifest.domains.map((item) => item.hostname),
      };
      if (!(await store.acquireLock(locks.application, locks.ownerId, locks.leaseSeconds, now))) {
        throw new WorkflowFailure('LP-LOCK-CONFLICT', `Application lock '${locks.application}' is held by another operation.`);
      }
      const acquired: string[] = [];
      try {
        for (const hostname of locks.domains) {
          const key = `domain:${hostname}`;
          if (!(await store.acquireLock(key, locks.ownerId, locks.leaseSeconds, now))) throw new WorkflowFailure('LP-LOCK-CONFLICT', `Domain lock '${key}' is held by another operation.`);
          acquired.push(key);
        }
      } catch (error) {
        await store.releaseLock(locks.application, locks.ownerId);
        for (const key of acquired) await store.releaseLock(key, locks.ownerId);
        throw error;
      }
      return { locks };
    }),
    step('stop-promotion', manifestBound, async () => {
      await store.updateApplicationStatus(applicationId, { syncStatus: 'DECOMMISSIONING', updatedAt: now });
      await store.appendAudit({ actor: `operator:${actor}`, action: 'PROMOTION_STOPPED', applicationId, details: { sourceCommit, reason: 'decommissioning' } });
      return { stopped: true };
    }),
    step('export-final-metadata', manifestBound, async (stepContext) => {
      const manifest = manifestOutput(stepContext).manifest;
      const [resources, deployments, audits] = await Promise.all([
        store.listResources(applicationId),
        store.listDeployments(applicationId, { limit: 200 }),
        store.listAudit(applicationId, { limit: 200 }),
      ]);
      const exportJson = canonicalJson({
        exportVersion: 1,
        application: manifest,
        resources: resources.map((resource) => ({
          provider: resource.provider,
          resourceType: resource.resourceType,
          resourceKey: resource.resourceKey,
          providerResourceId: resource.providerResourceId,
          desiredGeneration: resource.desiredGeneration,
          observedHash: resource.observedHash ?? '',
          ownershipFingerprint: resource.ownershipFingerprint,
          status: resource.status,
          firstSeenAt: resource.firstSeenAt,
          lastSeenAt: resource.lastSeenAt,
        })),
        deployments,
        audit: audits.map((event) => ({ actor: event.actor, action: event.action, createdAt: event.createdAt, details: event.details ?? {} })),
        approvedCommit: sourceCommit,
        exportedAt: now,
      });
      await store.appendAudit({ actor: `operator:${actor}`, action: 'DESTROY_EXPORT', applicationId, details: { exportJson, sourceCommit, exportedAt: now } });
      return { exportJson };
    }),
    step('cloudflare-proxy-off', manifestBound, async (stepContext) => {
      const manifest = manifestOutput(stepContext).manifest;
      const results: Array<{ hostname: string; proxiedBefore: boolean; proxiedAfter: boolean | null; skipped: string | null }> = [];
      for (const domain of domainsOf(manifest)) {
        if (!domain.proxied) {
          results.push({ hostname: domain.hostname, proxiedBefore: false, proxiedAfter: false, skipped: null });
          continue;
        }
        const zone = await provider.observeZone(domain.zoneRef, context);
        const record = await provider.observeRecord(zone.zoneId, domain.hostname, context);
        const expected = expectedDnsOwnership(applicationId, domain.hostname);
        if (record !== null && record.ownershipFingerprint !== null && record.ownershipFingerprint !== expected) {
          throw new WorkflowFailure('LP-DNS-CONFLICT-UNOWNED', `DNS record '${domain.hostname}' is owned by another party (${record.ownershipFingerprint.slice(0, 8)}…); refusing to touch it.`);
        }
        if (record === null || !record.proxied) {
          results.push({ hostname: domain.hostname, proxiedBefore: record?.proxied ?? false, proxiedAfter: record?.proxied ?? false, skipped: record === null ? 'record absent' : null });
          continue;
        }
        const required = await provider.requiredDnsRecords({ projectId: applicationId, hostname: domain.hostname, environment: domain.environment, mode: 'proxied' }, context);
        const first = required[0];
        if (!first) throw new WorkflowFailure('LP-DNS-REQUIRED-RECORD-MISSING', `No required DNS record for '${domain.hostname}'.`);
        await provider.ensureRecord(zone.zoneId, { ...first, proxied: false, providerRecordId: record.id }, expected, context);
        const verified = await provider.observeRecord(zone.zoneId, domain.hostname, context);
        if (verified !== null && verified.proxied) throw new WorkflowFailure('LP-DNS-READBACK-FAILED', `DNS record '${domain.hostname}' is still proxied after proxy-off.`);
        results.push({ hostname: domain.hostname, proxiedBefore: true, proxiedAfter: verified?.proxied ?? false, skipped: null });
      }
      return { domains: results };
    }),
    step('unassign-production-domain', manifestBound, async (stepContext) => {
      const manifest = manifestOutput(stepContext).manifest;
      const results: Array<{ hostname: string; unassigned: boolean; skipped: string | null }> = [];
      const project = await provider.observeProject({ projectId: applicationId }, context);
      for (const domain of domainsOf(manifest).filter((item) => item.environment === 'production')) {
        if (!('removeDomain' in provider)) {
          results.push({ hostname: domain.hostname, unassigned: false, skipped: 'provider lacks domain removal capability' });
          continue;
        }
        const assigned = Array.isArray(project?.configuration.domains) && (project.configuration.domains as string[]).includes(domain.hostname);
        if (!assigned) {
          results.push({ hostname: domain.hostname, unassigned: true, skipped: 'domain not assigned' });
          continue;
        }
        await provider.removeDomain(applicationId, domain.hostname, context);
        const readback = await provider.observeProject({ projectId: applicationId }, context);
        const stillAssigned = Array.isArray(readback?.configuration.domains) && (readback.configuration.domains as string[]).includes(domain.hostname);
        if (stillAssigned) throw new WorkflowFailure('LP-DOMAIN-UNASSIGN-READBACK-FAILED', `Production domain '${domain.hostname}' is still assigned after removal.`);
        results.push({ hostname: domain.hostname, unassigned: true, skipped: null });
      }
      return { domains: results };
    }),
    step('delete-owned-dns', manifestBound, async (stepContext) => {
      const manifest = manifestOutput(stepContext).manifest;
      const deleted: string[] = [];
      for (const domain of domainsOf(manifest)) {
        const zone = await provider.observeZone(domain.zoneRef, context);
        const record = await provider.observeRecord(zone.zoneId, domain.hostname, context);
        if (record === null) continue;
        const expected = expectedDnsOwnership(applicationId, domain.hostname);
        if (record.ownershipFingerprint === null || record.ownershipFingerprint !== expected) {
          throw new WorkflowFailure('LP-DNS-CONFLICT-UNOWNED', `DNS record '${domain.hostname}' (${record.id}) is not owned by '${applicationId}' (fingerprint ${record.ownershipFingerprint ?? 'missing'}); refusing to delete it.`);
        }
        await provider.deleteRecord(zone.zoneId, record.id, context, expected);
        const readback = await provider.observeRecord(zone.zoneId, domain.hostname, context);
        if (readback !== null) throw new WorkflowFailure('LP-DNS-DELETE-READBACK-FAILED', `DNS record '${domain.hostname}' (${record.id}) still exists after delete.`);
        deleted.push(domain.hostname);
      }
      return { deleted };
    }),
    step('release-custom-environments', canonicalJson({ applicationId }), async () => {
      const resources = await store.listResources(applicationId);
      const released: Array<{ providerResourceId: string; resourceKey: string }> = [];
      for (const resource of resources) {
        if (resource.resourceType === 'vercel.environment' && resource.status === 'ACTIVE') {
          await store.releaseResource(resource.provider, resource.providerResourceId, now);
          released.push({ providerResourceId: resource.providerResourceId, resourceKey: resource.resourceKey });
        }
      }
      return { released };
    }),
    step('delete-deployments-per-policy', canonicalJson({ applicationId }), async (stepContext) => {
      const manifest = manifestOutput(stepContext).manifest;
      if (manifest.lifecycle.decommission.preserveDeployments) return { preserved: true, deleted: [] };
      if (!('deleteDeployment' in provider)) return { preserved: false, deleted: [], skipped: 'provider lacks deployment deletion capability' };
      const deployments = await store.listDeployments(applicationId);
      const deleted: string[] = [];
      for (const deployment of deployments) {
        await provider.deleteDeployment(deployment.id, context);
        deleted.push(deployment.id);
      }
      return { preserved: false, deleted };
    }),
    step('remove-git-and-project', canonicalJson({ applicationId }), async (stepContext) => {
      const manifest = manifestOutput(stepContext).manifest;
      if (manifest.lifecycle.decommission.preserveDeployments) {
        return { retained: true, projectId: null, reason: 'preserveDeployments policy retains the project and its deployment history' };
      }
      const project = await provider.observeProject({ projectId: applicationId }, context);
      if (project === null) return { retained: false, projectId: null, reason: 'project already absent (idempotent resume)' };
      const ledger = await store.listResources(applicationId);
      const expected = projectLedgerFingerprint(ledger);
      if (expected === null || project.ownershipFingerprint === null || project.ownershipFingerprint !== expected) {
        throw new WorkflowFailure('LP-OWNERSHIP-CONFLICT', `Project '${project.providerResourceId}' does not match the recorded ownership fingerprint (${project.ownershipFingerprint ?? 'missing'} vs ${expected ?? 'none'}); refusing to delete it.`);
      }
      await provider.deleteProject(project.providerResourceId, context);
      const readback = await provider.observeProject({ projectId: applicationId }, context);
      if (readback !== null) throw new WorkflowFailure('LP-PROJECT-DELETE-READBACK-FAILED', `Project '${project.providerResourceId}' still exists after delete.`);
      return { retained: false, projectId: project.providerResourceId, reason: null };
    }),
    step('mark-deployments-inactive', canonicalJson({ applicationId }), async (stepContext) => {
      const manifest = manifestOutput(stepContext).manifest;
      if (manifest.lifecycle.decommission.preserveDeployments) return { marked: [] };
      if (typeof source.createDeploymentStatus !== 'function') return { marked: [] };
      const deployments = await store.listDeployments(applicationId, { environment: 'production' });
      const marked: string[] = [];
      for (const deployment of deployments) {
        await source.createDeploymentStatus({
          repository: manifest.repository.name,
          commitSha: deployment.commitSha,
          environment: 'production',
          state: 'inactive',
          description: 'Launchpad decommission: production deployments marked inactive',
          idempotencyKey: idempotencyKey('decommission-inactive', deployment.id),
        }, context);
        marked.push(deployment.id);
      }
      return { marked };
    }),
    step('record-tombstone', manifestBound, async (stepContext) => {
      const manifest = manifestOutput(stepContext).manifest;
      const retainUntil = new Date(new Date(now).getTime() + retentionMs).toISOString();
      const domain = productionDomainOf(manifest);
      // The D1 application row may lag behind the manifest; walk the explicit
      // lifecycle machine so 'deleted' is reachable from any prior state.
      const application = await store.getApplication(applicationId);
      const ORDER: LifecycleState[] = ['active', 'decommissioning', 'approved-for-deletion', 'deleted'];
      let current = application?.lifecycleState ?? 'active';
      const startIndex = ORDER.indexOf(current);
      for (const target of ORDER) {
        if (ORDER.indexOf(target) <= startIndex) continue;
        assertLifecycleTransition(current, target, { allowReactivateBeforeDeletionApproval: false });
        await store.setLifecycleState(applicationId, target, now);
        current = target;
      }
      await store.createTombstone({ applicationId, domain, deletedAt: now, retainUntil });
      await store.appendAudit({ actor: `operator:${actor}`, action: 'DELETED', applicationId, details: { retainUntil, domain, sourceCommit } });
      return { tombstone: { applicationId, domain, retainUntil } };
    }),
  ];
}

/** The step-run context adapter: durable runner passes outputs keyed by step id. */
interface StepRunContextShape { outputs: Readonly<Record<string, unknown>>; }

export async function runDecommissionWorkflow(input: DecommissionDestroyInput): Promise<DecommissionDestroyResult> {
  const runner = new DurableOperationRunner(input.store);
  const runInput = {
    applicationId: input.applicationId,
    workflowId: input.workflowId,
    action: 'DECOMMISSION',
    idempotencyKey: input.idempotencyKey,
    // The payload-hash formula is shared with the controller ingress
    // (`workflowPayloadHash` in apps/controller/src/api.ts): same version,
    // kind, applicationId, sourceCommit, sha256 of canonical JSON. The
    // ingress registers the durable run + idempotent-request ledger entry
    // with this hash, so the machine MUST present the identical value when
    // it resumes the run, or startWorkflowRun rejects the replay as
    // LP-DB-IDEMPOTENCY-REUSED. approvalId is deliberately excluded: it is
    // already part of the idempotency key (`delete:{app}:{approvalId}:{commit}`).
    payloadHash: await sha256Hex(canonicalJson({ version: DECOMMISSION_VERSION, kind: DECOMMISSION_KIND, applicationId: input.applicationId, sourceCommit: input.sourceCommit })),
    steps: buildDecommissionMachine(input),
    onFailure: async (failure: { failedStep: string; error: unknown; outputs: Readonly<Record<string, unknown>> }) => {
      await input.store.appendAudit({
        actor: `operator:${input.actor}`,
        action: 'DESTROY_FAILED',
        applicationId: input.applicationId,
        details: { failedStep: failure.failedStep, errorCode: errorCodeOf(failure.error) ?? 'LP-WORKFLOW-STEP-FAILED', correlationId: input.context.correlationId },
      });
      return { noted: true };
    },
    ...(input.sleep !== undefined ? { sleep: input.sleep } : {}),
  };
  // The lock-release closure runs inside `runner.run` (its finally path),
  // before the run result is available, so it must not capture `run`.
  // The approved manifest is instead re-read from the persisted step row.
  const operationId = await runner.startRun(runInput);
  const run: OperationRunResult = await runner.run({
    ...runInput,
    releaseLocks: async () => {
      const persisted = await input.store.getWorkflowStep(operationId, 'load-approved-manifest');
      const manifest = persisted?.result as { manifest?: DesiredApplication } | undefined;
      const domains = manifest?.manifest ? manifest.manifest.domains.map((item) => item.hostname) : [];
      await releaseOwnedLocks(input.store, input.applicationId, domains, input.workflowId);
    },
  });
  const exportOutput = run.outputs['export-final-metadata'] as ExportOutput | undefined;
  const tombstoneOutput = run.outputs['record-tombstone'] as TombstoneOutput | undefined;
  return {
    status: run.status === 'SUCCEEDED' ? 'DELETED' : 'FAILED',
    applicationId: input.applicationId,
    operationId: run.operationId,
    failedStep: run.failedStep,
    errorCode: errorCodeOf(run.error),
    exportJson: exportOutput?.exportJson ?? '',
    tombstone: tombstoneOutput?.tombstone ?? null,
    error: run.error,
  };
}
