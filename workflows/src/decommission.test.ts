import { expect, it } from 'vitest';
import { FakeProvider } from '@launchpad/provider-testkit';
import { InMemoryLaunchpadStore } from '@launchpad/database';
import { idempotencyKey, sha256Hex } from '@launchpad/shared';
import { stringify } from 'yaml';
import {
  assertLifecycleTransition,
  assertTombstoneReuseAllowed,
  consumeDeletionApproval,
  findReverseDependents,
  issueDeletionApproval,
  planDecommission,
  reactivateApplication,
  runDecommissionWorkflow,
  type DecommissionDestroyInput,
} from './index.js';
import type { DesiredApplication } from '@launchpad/core';
import type { ProviderContext } from '@launchpad/provider-contract';

const CONTEXT: ProviderContext = { correlationId: 'corr', applicationId: 'app', workflowId: 'wf', actor: { kind: 'operator', id: 'test' }, dryRun: false };
const NOW = '2026-08-04T00:00:00.000Z';
const APPROVED_COMMIT = 'a'.repeat(40);
const MANIFEST_PATH = 'catalog/apps/app.yaml';

function baseManifest(): DesiredApplication {
  return {
    apiVersion: 'launchpad.dev/v1',
    kind: 'Application',
    metadata: { id: 'app', displayName: 'App', owners: ['@platform'], labels: {}, annotations: {} },
    repository: { provider: 'github', name: 'acme/app', productionBranch: 'main', deploymentRef: 'main' },
    vercel: {
      scope: {},
      project: {
        name: 'app', framework: 'nextjs', rootDirectory: '.', nodeVersion: '24.x',
        build: { installCommand: 'yarn install', buildCommand: 'yarn build', outputDirectory: null, developmentCommand: null, ignoredBuildStep: null },
        git: { connected: true, productionBranch: 'main' },
        deployment: { autoAssignProductionDomains: false, prioritizeProductionBuilds: true, rollingRelease: null, skewProtection: false },
        regions: { functions: [] }, protection: {}, settings: {},
      },
    },
    environments: { production: { enabled: true, health: { path: '/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 1, attempts: 1, intervalSeconds: 0 } } },
    domains: [{ hostname: 'app.example.com', environment: 'production', cloudflare: { zoneRef: 'config://cloudflare/example.com', mode: 'dns-only', ttl: 'auto' }, redirects: [] }],
    secrets: [],
    dependencies: { applications: [], external: [] },
    policies: {
      drift: { mode: 'open-pr', checkIntervalMinutes: 30 },
      destructiveChanges: { allowInNormalApply: false },
      preview: { requiredForMerge: true },
      staging: { requiredForProduction: false },
      health: { requiredForPromotion: true },
      failures: { createIssueAfterFinalRetry: true, notifyOwners: true },
    },
    lifecycle: { state: 'active', deletionProtection: true, orphanPolicy: 'retain', decommission: { requestedAt: null, deleteAfter: null, approvalToken: null, preserveDeployments: true } },
  };
}

function approvedManifest(overrides: { lifecycle?: Partial<DesiredApplication['lifecycle']>; preserveDeployments?: boolean; mode?: 'dns-only' | 'proxied' } = {}): DesiredApplication {
  const manifest = baseManifest();
  manifest.lifecycle = {
    state: 'approved-for-deletion',
    deletionProtection: false,
    orphanPolicy: 'retain',
    decommission: { requestedAt: '2026-08-01T00:00:00.000Z', deleteAfter: '2026-08-03T00:00:00.000Z', approvalToken: null, preserveDeployments: overrides.preserveDeployments ?? false },
    ...overrides.lifecycle,
  };
  if (overrides.mode !== undefined) {
    const first = manifest.domains[0]!;
    manifest.domains[0] = { ...first, cloudflare: { ...first.cloudflare, mode: overrides.mode } };
  }
  return manifest;
}

function fixtureContent(manifest: DesiredApplication): string {
  return stringify(manifest as unknown as Record<string, unknown>, { aliasDuplicateObjects: false, lineWidth: 0 });
}

async function seededStore(lifecycleState: DesiredApplication['lifecycle']['state'] = 'approved-for-deletion'): Promise<InMemoryLaunchpadStore> {
  const store = new InMemoryLaunchpadStore({ now: () => new Date(NOW) });
  await store.upsertApplication({ id: 'app', displayName: 'App', sourcePath: MANIFEST_PATH, desiredGeneration: 1, desiredHash: '', syncStatus: 'SYNCED', healthStatus: 'UNKNOWN', lifecycleState, domain: 'app.example.com' });
  return store;
}

async function seededProvider(manifest: DesiredApplication): Promise<FakeProvider> {
  const provider = new FakeProvider();
  await provider.ensureProject({ id: 'app', name: 'app', teamId: null, framework: 'nextjs', rootDirectory: '.', nodeVersion: '24.x', build: { installCommand: null, buildCommand: null, outputDirectory: null }, repository: 'acme/app', productionBranch: 'main', settings: {} }, CONTEXT);
  const domain = manifest.domains[0]!;
  await provider.ensureDomain({ projectId: 'app', hostname: 'app.example.com', environment: 'production', mode: domain.cloudflare.mode }, CONTEXT);
  const zone = await provider.observeZone('config://cloudflare/example.com', CONTEXT);
  await provider.ensureRecord(zone.zoneId, { hostname: 'app.example.com', type: 'CNAME', value: 'app.vercel-dns.example', ttl: 'auto', providerRecordId: null, proxied: domain.cloudflare.mode === 'proxied' }, idempotencyKey('ownership', 'app', 'app.example.com'), CONTEXT);
  provider.files.set(MANIFEST_PATH, fixtureContent(manifest));
  return provider;
}

/** Records the ownership ledger the apply machine is expected to have written (live fingerprint, provider-assigned). */
async function seedLedger(store: InMemoryLaunchpadStore, provider: FakeProvider): Promise<void> {
  const project = await provider.observeProject({ projectId: 'app' }, CONTEXT);
  if (project === null) throw new Error('test setup: project missing');
  await store.upsertResource({ applicationId: 'app', provider: 'vercel', resourceType: 'vercel.project', resourceKey: 'vercel.project', providerResourceId: project.providerResourceId, desiredGeneration: 1, observedHash: 'h', ownershipFingerprint: project.ownershipFingerprint });
}

interface DestroyOverrides {
  manifest?: DesiredApplication;
  approvalToken?: string;
  /** Actor the approval is issued to (defaults to 'alice'). */
  approvalActor?: string;
  domain?: string;
  actor?: string;
  sourceCommit?: string;
  now?: string;
  idempotencyKey?: string;
  dependentCatalog?: DesiredApplication[];
  files?: Record<string, string>;
}

async function runDestroy(store: InMemoryLaunchpadStore, provider: FakeProvider, overrides: DestroyOverrides = {}) {
  const manifest = overrides.manifest ?? approvedManifest();
  let token = overrides.approvalToken;
  if (token === undefined) {
    const issued = await issueDeletionApproval({ store, binding: { applicationId: 'app', domain: 'app.example.com', sourceCommit: APPROVED_COMMIT, actor: overrides.approvalActor ?? 'alice', expiresAt: '2026-08-10T00:00:00.000Z' }, now: NOW });
    token = issued.token;
  }
  const files: Record<string, string> = overrides.files ?? { [MANIFEST_PATH]: fixtureContent(manifest) };
  provider.files.clear();
  for (const [path, content] of Object.entries(files)) provider.files.set(path, content);
  const input: DecommissionDestroyInput = {
    applicationId: 'app',
    approvalId: (await store.listDeletionApprovals('app'))[0]?.id ?? 'missing',
    approvalToken: token,
    sourceCommit: overrides.sourceCommit ?? APPROVED_COMMIT,
    domain: overrides.domain ?? 'app.example.com',
    actor: overrides.actor ?? 'alice',
    now: overrides.now ?? NOW,
    idempotencyKey: overrides.idempotencyKey ?? 'destroy-1',
    workflowId: 'destroy-wf',
    controlRepository: 'acme/control',
    manifestPath: MANIFEST_PATH,
    dependentCatalog: overrides.dependentCatalog ?? [],
    provider,
    source: provider,
    store,
    context: { ...CONTEXT, workflowId: 'destroy-wf' },
  };
  return runDecommissionWorkflow(input);
}

async function fullySeeded(overrides: DestroyOverrides = {}): Promise<{ store: InMemoryLaunchpadStore; provider: FakeProvider; manifest: DesiredApplication }> {
  const manifest = overrides.manifest ?? approvedManifest();
  const store = await seededStore();
  const provider = await seededProvider(manifest);
  await seedLedger(store, provider);
  return { store, provider, manifest };
}

// ---------------------------------------------------------------------------
// Lifecycle transitions and first PR
// ---------------------------------------------------------------------------

it('enforces explicit lifecycle transitions and gates reactivation on the recovery policy', () => {
  const codeOf = (fn: () => void): string => {
    try {
      fn();
      return 'no-throw';
    } catch (error) {
      return error instanceof Error ? error.name : 'unknown';
    }
  };
  expect(codeOf(() => assertLifecycleTransition('active', 'decommissioning', undefined))).toBe('no-throw');
  expect(codeOf(() => assertLifecycleTransition('decommissioning', 'approved-for-deletion', undefined))).toBe('no-throw');
  expect(codeOf(() => assertLifecycleTransition('approved-for-deletion', 'deleted', undefined))).toBe('no-throw');
  expect(codeOf(() => assertLifecycleTransition('active', 'deleted', undefined))).toBe('LP-LIFECYCLE-TRANSITION-INVALID');
  expect(codeOf(() => assertLifecycleTransition('approved-for-deletion', 'active', { allowReactivateBeforeDeletionApproval: true }))).toBe('LP-LIFECYCLE-TRANSITION-INVALID');
  expect(codeOf(() => assertLifecycleTransition('decommissioning', 'active', undefined))).toBe('LP-LIFECYCLE-RECOVERY-POLICY-REQUIRED');
  expect(codeOf(() => assertLifecycleTransition('decommissioning', 'active', { allowReactivateBeforeDeletionApproval: true }))).toBe('no-throw');
});

it('opens the first deletion PR with the impact report, reverse dependents, and cooling-off schedule', async () => {
  const provider = new FakeProvider();
  const manifest = baseManifest();
  const dependent: DesiredApplication = { ...baseManifest(), metadata: { ...baseManifest().metadata, id: 'consumer' }, dependencies: { applications: ['app'], external: [] } };
  provider.files.set(MANIFEST_PATH, fixtureContent(manifest));
  const result = await planDecommission({
    source: provider,
    controlRepository: 'acme/control',
    manifestPath: MANIFEST_PATH,
    applicationId: 'app',
    manifest,
    catalog: [dependent, { ...baseManifest(), metadata: { ...baseManifest().metadata, id: 'unrelated' } }],
    requestedAt: NOW,
    coolingOffMs: 48 * 60 * 60 * 1000,
    context: CONTEXT,
  });
  expect(result.status).toBe('PR_OPENED');
  expect(result.pullRequest?.number).toBeTypeOf('number');
  expect(result.report?.requestedAt).toBe(NOW);
  expect(result.report?.deleteAfter).toBe('2026-08-06T00:00:00.000Z');
  expect(result.report?.promotionStopped).toBe(true);
  expect(result.report?.serviceKept).toBe(true);
  expect(result.report?.reverseDependents.map((item) => item.applicationId)).toEqual(['consumer']);
  expect(result.report?.blockingDependents).toEqual(['consumer']);
});

it('finds reverse dependents through external URLs referencing owned domains', () => {
  const external: DesiredApplication = { ...baseManifest(), metadata: { ...baseManifest().metadata, id: 'ext-consumer' }, dependencies: { applications: [], external: [{ id: 'api', type: 'http', url: 'https://app.example.com/api', requiredBefore: ['production'] }] } };
  const dependents = findReverseDependents('app', [external], ['app.example.com']);
  expect(dependents).toHaveLength(1);
  expect(dependents[0]?.via).toBe('external-url');
});

it('does not re-open a PR when decommissioning is already in progress, and blocks reactivation after approval', async () => {
  const provider = new FakeProvider();
  const decommissioning = { ...baseManifest(), lifecycle: { ...baseManifest().lifecycle, state: 'decommissioning' as const } };
  const planned = await planDecommission({ source: provider, controlRepository: 'acme/control', manifestPath: MANIFEST_PATH, applicationId: 'app', manifest: decommissioning, catalog: [], context: CONTEXT });
  expect(planned.status).toBe('ALREADY_DECOMMISSIONING');
  const reactivated = await reactivateApplication({ source: provider, controlRepository: 'acme/control', manifestPath: MANIFEST_PATH, applicationId: 'app', manifest: decommissioning, reason: 'service restored', context: CONTEXT });
  expect(reactivated.status).toBe('PR_OPENED');
  const approved = approvedManifest();
  const afterApproval = await reactivateApplication({ source: provider, controlRepository: 'acme/control', manifestPath: MANIFEST_PATH, applicationId: 'app', manifest: approved, reason: 'too late', context: CONTEXT });
  expect(afterApproval.status).toBe('BLOCKED');
  expect(afterApproval.errorCode).toBe('LP-LIFECYCLE-REACTIVATION-AFTER-APPROVAL-BLOCKED');
});

// ---------------------------------------------------------------------------
// Approval token service
// ---------------------------------------------------------------------------

it('persists only the SHA-256 fingerprint of the approval token, never the plaintext', async () => {
  const store = await seededStore();
  const issued = await issueDeletionApproval({ store, binding: { applicationId: 'app', domain: 'app.example.com', sourceCommit: APPROVED_COMMIT, actor: 'alice', expiresAt: '2026-08-10T00:00:00.000Z' }, now: NOW });
  expect(issued.token).toMatch(/^[0-9a-f]{64}$/);
  const approvals = await store.listDeletionApprovals('app');
  expect(approvals[0]?.tokenHash).toBe(await sha256Hex(issued.token));
  expect(approvals[0]?.tokenHash).not.toBe(issued.token);
  const serialized = JSON.stringify({ approvals, audit: await store.listAudit('app') });
  expect(serialized).not.toContain(issued.token);
});

it('rejects an approval whose expiry is not in the future', async () => {
  const store = await seededStore();
  await expect(issueDeletionApproval({ store, binding: { applicationId: 'app', domain: 'app.example.com', sourceCommit: APPROVED_COMMIT, actor: 'alice', expiresAt: '2026-08-01T00:00:00.000Z' }, now: NOW })).rejects.toMatchObject({ name: 'LP-APPROVAL-EXPIRY-INVALID' });
});

it('refuses an expired approval at destruction time', async () => {
  const { store, provider } = await fullySeeded();
  const issued = await issueDeletionApproval({ store, binding: { applicationId: 'app', domain: 'app.example.com', sourceCommit: APPROVED_COMMIT, actor: 'alice', expiresAt: '2026-08-03T00:00:00.000Z' }, now: '2026-08-02T00:00:00.000Z' });
  const result = await runDestroy(store, provider, { approvalToken: issued.token });
  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-DESTROY-APPROVAL-EXPIRED');
  expect(provider.calls).not.toContain('removeDomain');
  expect(provider.calls).not.toContain('deleteRecord');
  expect(provider.calls).not.toContain('deleteProject');
});

it('refuses a binding mismatch: the destroy domain or actor must match the approved binding', async () => {
  const { store, provider } = await fullySeeded();
  const issued = await issueDeletionApproval({ store, binding: { applicationId: 'app', domain: 'app.example.com', sourceCommit: APPROVED_COMMIT, actor: 'alice', expiresAt: '2026-08-10T00:00:00.000Z' }, now: NOW });
  const wrongDomain = await runDestroy(store, provider, { approvalToken: issued.token, domain: 'other.example.com' });
  expect(wrongDomain.errorCode).toBe('LP-DESTROY-DOMAIN-MISMATCH');
  const wrongActor = await runDestroy(store, provider, { approvalToken: issued.token, actor: 'mallory' });
  expect(wrongActor.errorCode).toBe('LP-DESTROY-APPROVAL-BINDING-MISMATCH');
  expect(provider.calls).not.toContain('removeDomain');
});

it('is single-use: a consumed token can never authorize destruction again', async () => {
  const { store, provider } = await fullySeeded();
  const issued = await issueDeletionApproval({ store, binding: { applicationId: 'app', domain: 'app.example.com', sourceCommit: APPROVED_COMMIT, actor: 'alice', expiresAt: '2026-08-10T00:00:00.000Z' }, now: NOW });
  const first = await runDestroy(store, provider, { approvalToken: issued.token });
  expect(first.status).toBe('DELETED');
  const approvals = await store.listDeletionApprovals('app');
  expect(approvals[0]?.status).toBe('USED');
  const second = await runDestroy(store, provider, { approvalToken: issued.token, idempotencyKey: 'destroy-2' });
  expect(second.status).toBe('FAILED');
  expect(second.errorCode).toBe('LP-DESTROY-APPROVAL-USED');
});

// ---------------------------------------------------------------------------
// Destroy gates
// ---------------------------------------------------------------------------

it('produces BLOCKED_MISSING_MANIFEST with zero provider deletions when the manifest is absent', async () => {
  const { store, provider } = await fullySeeded();
  const result = await runDestroy(store, provider, { files: { 'catalog/apps/unrelated.yaml': 'apiVersion: launchpad.dev/v1\nkind: Application\n' } });
  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('BLOCKED_MISSING_MANIFEST');
  expect(provider.calls).not.toContain('removeDomain');
  expect(provider.calls).not.toContain('deleteRecord');
  expect(provider.calls).not.toContain('deleteDeployment');
  expect(provider.calls).not.toContain('deleteProject');
});

it('blocks destruction while the cooling-off period has not elapsed', async () => {
  const manifest = approvedManifest({ lifecycle: { decommission: { requestedAt: '2026-08-01T00:00:00.000Z', deleteAfter: '2026-08-10T00:00:00.000Z', approvalToken: null, preserveDeployments: false } } });
  const { store, provider } = await fullySeeded({ manifest });
  const result = await runDestroy(store, provider, { manifest });
  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-DESTROY-COOLING-OFF');
  expect(provider.calls).not.toContain('deleteProject');
});

it('blocks destruction when the lifecycle is not exactly approved-for-deletion', async () => {
  const manifest = { ...approvedManifest(), lifecycle: { ...approvedManifest().lifecycle, state: 'decommissioning' as const } };
  const { store, provider } = await fullySeeded({ manifest });
  const result = await runDestroy(store, provider, { manifest });
  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-DESTROY-LIFECYCLE-BLOCKED');
});

it('blocks destruction when the approval commit is stale (manifest moved on main)', async () => {
  const { store, provider } = await fullySeeded();
  const reverted = { ...approvedManifest(), lifecycle: { ...approvedManifest().lifecycle, state: 'active' as const, deletionProtection: true } };
  const result = await runDestroy(store, provider, { files: { [MANIFEST_PATH]: fixtureContent(approvedManifest()), [`${MANIFEST_PATH}@main`]: fixtureContent(reverted) } });
  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-DESTROY-APPROVAL-COMMIT-STALE');
  expect(provider.calls).not.toContain('deleteProject');
});

it('blocks destruction on reverse dependents, checked immediately before teardown', async () => {
  const { store, provider } = await fullySeeded();
  const consumer: DesiredApplication = { ...baseManifest(), metadata: { ...baseManifest().metadata, id: 'consumer' }, dependencies: { applications: ['app'], external: [] } };
  const result = await runDestroy(store, provider, { dependentCatalog: [consumer] });
  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-DESTROY-DEPENDENTS');
  expect(provider.calls).not.toContain('removeDomain');
});

it('blocks destruction when a blocking operation holds the application lock', async () => {
  const { store, provider } = await fullySeeded();
  await store.acquireLock('application:app', 'other-owner', 900, NOW);
  const result = await runDestroy(store, provider);
  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-LOCK-CONFLICT');
});

it('refuses to delete a DNS record that is not owned by the application', async () => {
  const { store, provider } = await fullySeeded();
  const zone = await provider.observeZone('config://cloudflare/example.com', CONTEXT);
  const existing = await provider.observeRecord(zone.zoneId, 'app.example.com', CONTEXT);
  if (existing !== null) provider.records.set(`${zone.zoneId}:app.example.com`, { ...existing, ownershipFingerprint: 'someone-elses-fingerprint' });
  const result = await runDestroy(store, provider);
  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-DNS-CONFLICT-UNOWNED');
  expect((await provider.observeRecord(zone.zoneId, 'app.example.com', CONTEXT))).not.toBeNull();
});

it('refuses to delete a project whose ownership fingerprint does not match the recorded ledger', async () => {
  const { store, provider } = await fullySeeded();
  await store.upsertResource({ applicationId: 'app', provider: 'vercel', resourceType: 'vercel.project', resourceKey: 'vercel.project', providerResourceId: 'app', desiredGeneration: 1, observedHash: 'h', ownershipFingerprint: 'different-owner' });
  const result = await runDestroy(store, provider);
  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-OWNERSHIP-CONFLICT');
  expect(provider.projects.has('app')).toBe(true);
});

// ---------------------------------------------------------------------------
// Ordered teardown, interruption, and resume
// ---------------------------------------------------------------------------

it('runs the ordered teardown: proxy off, domain unassign, owned DNS, deployments, project, tombstone', async () => {
  const { store, provider } = await fullySeeded({ manifest: approvedManifest({ mode: 'proxied', preserveDeployments: false }) });
  const deployment = await provider.createDeployment({ projectId: 'app', environment: 'production', repository: 'acme/app', commitSha: APPROVED_COMMIT, desiredGeneration: 1, staged: false }, CONTEXT);
  await store.recordDeployment({ id: deployment.id, applicationId: 'app', projectId: 'app', environment: 'production', repository: 'acme/app', commitSha: deployment.commitSha, desiredGeneration: 1, state: deployment.state, url: deployment.url, createdAt: deployment.createdAt });
  const result = await runDestroy(store, provider);
  expect(result.status).toBe('DELETED');
  expect(result.exportJson).toContain('exportVersion');
  expect(result.tombstone?.applicationId).toBe('app');
  const order = ['ensureRecord', 'removeDomain', 'deleteRecord', 'deleteDeployment', 'deleteProject'].map((call) => provider.calls.indexOf(call)).filter((index) => index >= 0);
  expect(order).toEqual([...order].sort((left, right) => left - right));
  expect(provider.projects.has('app')).toBe(false);
  expect(provider.deployments.has(deployment.id)).toBe(false);
  const zone = await provider.observeZone('config://cloudflare/example.com', CONTEXT);
  expect(await provider.observeRecord(zone.zoneId, 'app.example.com', CONTEXT)).toBeNull();
  expect((await store.getApplication('app'))?.lifecycleState).toBe('deleted');
  expect(await store.isTombstoned('app')).toBe(true);
  const audit = await store.listAudit('app');
  expect(audit.some((event) => event.action === 'DESTROY_EXPORT')).toBe(true);
  expect(audit.some((event) => event.action === 'DELETED')).toBe(true);
});

it('preserves deployments and the project when the approved policy says so', async () => {
  const manifest = approvedManifest({ preserveDeployments: true });
  const { store, provider } = await fullySeeded({ manifest });
  const result = await runDestroy(store, provider, { manifest });
  expect(result.status).toBe('DELETED');
  expect(provider.projects.has('app')).toBe(true);
  expect(await store.isTombstoned('app')).toBe(true);
});

it('resumes from the last durable boundary after an interruption, without re-running completed steps', async () => {
  const { store, provider } = await fullySeeded();
  const issued = await issueDeletionApproval({ store, binding: { applicationId: 'app', domain: 'app.example.com', sourceCommit: APPROVED_COMMIT, actor: 'alice', expiresAt: '2026-08-10T00:00:00.000Z' }, now: NOW });
  provider.failNext('deleteProject', { code: 'LP-FAKE-TRANSIENT', retryable: true });
  provider.failNext('deleteProject', { code: 'LP-FAKE-TRANSIENT', retryable: true });
  provider.failNext('deleteProject', { code: 'LP-FAKE-TRANSIENT', retryable: true });
  const first = await runDestroy(store, provider, { approvalToken: issued.token });
  expect(first.status).toBe('FAILED');
  expect(first.failedStep).toBe('remove-git-and-project');
  expect(first.errorCode).toBe('LP-FAKE-TRANSIENT');
  expect(provider.projects.has('app')).toBe(true);
  expect(await store.isTombstoned('app')).toBe(false);
  const stepCount = [...provider.calls].length;
  const second = await runDestroy(store, provider, { approvalToken: issued.token });
  expect(second.status).toBe('DELETED');
  expect(second.tombstone).not.toBeNull();
  // Resume skipped already-completed steps instead of replaying the teardown.
  const resumedCalls = [...provider.calls].slice(stepCount);
  expect(resumedCalls).not.toContain('removeDomain');
  expect(resumedCalls).not.toContain('deleteRecord');
  expect(resumedCalls).toContain('deleteProject');
});

it('fails safely on partial failure mid-teardown and completes on resume', async () => {
  const { store, provider } = await fullySeeded();
  const issued = await issueDeletionApproval({ store, binding: { applicationId: 'app', domain: 'app.example.com', sourceCommit: APPROVED_COMMIT, actor: 'alice', expiresAt: '2026-08-10T00:00:00.000Z' }, now: NOW });
  provider.failNext('deleteRecord', { code: 'LP-FAKE-TRANSIENT', retryable: true });
  provider.failNext('deleteRecord', { code: 'LP-FAKE-TRANSIENT', retryable: true });
  provider.failNext('deleteRecord', { code: 'LP-FAKE-TRANSIENT', retryable: true });
  const first = await runDestroy(store, provider, { approvalToken: issued.token });
  expect(first.status).toBe('FAILED');
  expect(first.failedStep).toBe('delete-owned-dns');
  expect(await store.isTombstoned('app')).toBe(false);
  const zone = await provider.observeZone('config://cloudflare/example.com', CONTEXT);
  expect(await provider.observeRecord(zone.zoneId, 'app.example.com', CONTEXT)).not.toBeNull();
  const second = await runDestroy(store, provider, { approvalToken: issued.token });
  expect(second.status).toBe('DELETED');
  expect(await store.isTombstoned('app')).toBe(true);
});

// ---------------------------------------------------------------------------
// Tombstone retention and reviewed override
// ---------------------------------------------------------------------------

it('blocks reuse of a tombstoned application ID and domain until retention elapses or a reviewed override is supplied', async () => {
  const { store, provider } = await fullySeeded();
  const destroyed = await runDestroy(store, provider);
  expect(destroyed.status).toBe('DELETED');
  expect(await store.isTombstoned('app')).toBe(true);
  const blocked = await assertTombstoneReuseAllowed({ store, applicationId: 'app', domain: 'app.example.com', now: NOW });
  expect(blocked.allowed).toBe(false);
  if (!blocked.allowed) expect(blocked.code).toBe('LP-TOMBSTONE-REUSE-BLOCKED');
  await expect(store.upsertApplication({ id: 'app', displayName: 'App', sourcePath: MANIFEST_PATH, desiredGeneration: 1, desiredHash: '', syncStatus: 'SYNCED', healthStatus: 'UNKNOWN', lifecycleState: 'active', domain: 'app.example.com' })).rejects.toMatchObject({ name: 'LP-DB-TOMBSTONE-REUSE-BLOCKED' });
  await expect(store.upsertApplication({ id: 'reborn-app', displayName: 'Reborn', sourcePath: MANIFEST_PATH, desiredGeneration: 1, desiredHash: '', syncStatus: 'SYNCED', healthStatus: 'UNKNOWN', lifecycleState: 'active', domain: 'app.example.com' })).rejects.toMatchObject({ name: 'LP-DB-TOMBSTONE-REUSE-BLOCKED' });
  const incomplete = await assertTombstoneReuseAllowed({ store, applicationId: 'app', domain: 'app.example.com', now: NOW, override: { reviewedBy: 'alice', reviewedAt: NOW, reason: '' } });
  expect(incomplete.allowed).toBe(false);
  if (!incomplete.allowed) expect(incomplete.code).toBe('LP-TOMBSTONE-OVERRIDE-REQUIRED');
  const override = await assertTombstoneReuseAllowed({ store, applicationId: 'app', domain: 'app.example.com', now: NOW, override: { reviewedBy: 'alice', reviewedAt: NOW, reason: 'recreated after incident review', evidenceUrl: 'https://github.com/acme/control/pull/99' } });
  expect(override.allowed).toBe(true);
  expect(await store.isTombstoned('app')).toBe(false);
});

it('allows reuse once retention has elapsed', async () => {
  const { store, provider } = await fullySeeded();
  await runDestroy(store, provider);
  expect(await store.isTombstoned('app')).toBe(true);
  const later = '2026-09-20T00:00:00.000Z';
  const elapsed = await assertTombstoneReuseAllowed({ store, applicationId: 'app', domain: 'app.example.com', now: later });
  expect(elapsed.allowed).toBe(true);
  expect(await store.isTombstoned('app')).toBe(false);
});
