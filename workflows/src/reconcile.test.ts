import { describe, expect, it } from 'vitest';
import { FakeProvider } from '@launchpad/provider-testkit';
import { InMemoryLaunchpadStore } from '@launchpad/database';
import { loadCatalog } from '@launchpad/catalog';
import { stringify } from 'yaml';
import { runReconcileWorkflow, type ReconcileMode, type ReconcileWorkflowResult } from './index.js';
import type { DesiredApplication } from '@launchpad/core';
import type { ProviderContext } from '@launchpad/provider-contract';

const context: ProviderContext = { correlationId: 'corr', applicationId: 'app', workflowId: 'reconcile-wf', actor: { kind: 'operator', id: 'test' }, dryRun: false };

const desired: DesiredApplication = {
  apiVersion: 'launchpad.dev/v1', kind: 'Application',
  metadata: { id: 'app', displayName: 'App', owners: ['@platform'], labels: { tier: 'gold' }, annotations: { 'launchpad.dev/team': 'platform' } },
  repository: { provider: 'github', name: 'acme/app', productionBranch: 'main', deploymentRef: 'main' },
  vercel: { scope: {}, project: { name: 'app', framework: 'nextjs', rootDirectory: 'apps/web', nodeVersion: '24.x', build: { installCommand: 'yarn install', buildCommand: 'yarn build', outputDirectory: null, developmentCommand: null, ignoredBuildStep: null }, git: { connected: true, productionBranch: 'main' }, deployment: { autoAssignProductionDomains: false}, regions: { functions: [] }, protection: {}, settings: {} } },
  environments: { production: { enabled: true, variables: { LOG_LEVEL: 'info' }, health: { path: '/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 1, attempts: 1, intervalSeconds: 0 } } },
  domains: [{ hostname: 'app.example.com', environment: 'production', cloudflare: { zoneRef: 'config://cloudflare/example.com', mode: 'dns-only', ttl: 'auto' }, redirects: [] }],
  secrets: [],
  dependencies: { applications: [], external: [] },
  policies: { drift: { mode: 'open-pr', checkIntervalMinutes: 30 }, destructiveChanges: { allowInNormalApply: false }, preview: { requiredForMerge: true }, staging: { requiredForProduction: false }, health: { requiredForPromotion: true }, failures: { createIssueAfterFinalRetry: true, notifyOwners: true } },
  lifecycle: { state: 'active', deletionProtection: true, orphanPolicy: 'retain', decommission: { requestedAt: null, deleteAfter: null, approvalToken: null, preserveDeployments: true } },
};

const MANIFEST_PATH = 'catalog/apps/app.yaml';
const CONTROL_REPOSITORY = 'acme/control';
const TRIGGERED_AT = '2026-08-04T08:30:00.000Z';

function manifestContent(application: DesiredApplication = desired): string {
  return stringify(application as unknown as Record<string, unknown>);
}

async function seeded(options: { rootDirectory?: string } = {}): Promise<{ provider: FakeProvider; store: InMemoryLaunchpadStore }> {
  const provider = new FakeProvider();
  await provider.ensureProject({ id: 'app', name: 'app', teamId: null, framework: 'nextjs', rootDirectory: options.rootDirectory ?? '.', nodeVersion: '24.x', build: { installCommand: 'yarn install', buildCommand: 'yarn build', outputDirectory: null }, repository: 'acme/app', productionBranch: 'main', settings: { autoAssignProductionDomains: false} }, context);
  // The applied DNS record exists in the provider, matching the manifest.
  await provider.ensureRecord('zone_example.com', { hostname: 'app.example.com', type: 'CNAME', value: 'app.vercel-dns.example', ttl: 'auto', providerRecordId: null }, 'owned-dns', context);
  provider.files.set(MANIFEST_PATH, manifestContent());
  const store = new InMemoryLaunchpadStore();
  await store.upsertApplication({ id: 'app', displayName: 'App', sourcePath: MANIFEST_PATH, desiredGeneration: 1, desiredHash: 'desired', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
  return { provider, store };
}

function run(provider: FakeProvider, store: InMemoryLaunchpadStore, options: { mode?: ReconcileMode; triggeredAt?: string; now?: string; sourceCommit?: string | null } = {}): Promise<ReconcileWorkflowResult> {
  const triggeredAt = options.triggeredAt ?? TRIGGERED_AT;
  return runReconcileWorkflow({
    store, provider, source: provider, controlRepository: CONTROL_REPOSITORY, applicationId: 'app',
    mode: options.mode ?? 'open-pr',
    triggeredAt,
    sourceCommit: options.sourceCommit ?? null,
    context,
    now: options.now ?? triggeredAt,
  });
}

describe('granular reconciliation workflow (22.3)', () => {
  it('detects a manual provider change, persists OUT_OF_SYNC, and opens one reviewable control-repo PR', async () => {
    const { provider, store } = await seeded();
    provider.mutateProject('app', { rootDirectory: 'apps/manual-drift' });
    const result = await run(provider, store);
    expect(result.status).toBe('SUCCEEDED');
    expect(result.result?.status).toBe('OUT_OF_SYNC');
    expect(result.result?.driftFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.result?.drift.some((record) => record.resourceKey === 'vercel.project')).toBe(true);
    expect(result.result?.operation).toBe('restore-desired-state');
    expect(result.result?.pullRequest?.number).toBeTypeOf('number');

    // D1 status, drift event, and one open reconciliation request.
    expect((await store.getApplication('app'))?.syncStatus).toBe('OUT_OF_SYNC');
    const events = await store.listDriftEvents('app');
    expect(events.some((event) => event.category === 'OUT_OF_SYNC' && event.fingerprint === result.result?.driftFingerprint)).toBe(true);
    const request = await store.getOpenReconciliationRequest('app', result.result?.driftFingerprint ?? '');
    expect(request?.pullRequestNumber).toBe(result.result?.pullRequest?.number);

    // One reviewable PR against the control repository with the recognized catalog path.
    expect(provider.prCalls).toHaveLength(1);
    const prCall = provider.prCalls[0];
    if (prCall === undefined) throw new Error('Expected the reconciliation workflow to open exactly one PR; the PR step was skipped.');
    expect(prCall.repository).toBe(CONTROL_REPOSITORY);
    expect(prCall.branch).toBe(`reconcile/app/${result.result?.driftFingerprint ? prCall.branch.split('/')[2] : ''}`);
    expect(prCall.files[MANIFEST_PATH]).toBeDefined();
    expect(prCall.files[`reconciliation/app.yaml`]).toContain('operation: restore-desired-state');
    expect(prCall.baseSha).toBe('a'.repeat(40));
    expect(prCall.body).toContain('Drift fingerprint:');
    expect(prCall.title).toBe(`reconcile: app drift ${prCall.branch.split('/')[2]}`);

    // Every granular phase is a durable, persisted step.
    const runs = await store.listWorkflowRuns('app');
    const runRecord = runs.find((candidate) => candidate.id === result.operationId);
    expect(runRecord?.status).toBe('SUCCEEDED');
    const steps = await store.listWorkflowSteps(result.operationId ?? '');
    expect(steps.map((step) => step.stepId).sort()).toEqual(['diff-plan', 'load-desired', 'observe-live-state', 'open-or-update-pr', 'persist-status', 'report', 'resolve-main']);
    expect(steps.every((step) => step.status === 'SUCCEEDED')).toBe(true);
  });

  it('updates the same PR on repeated checks instead of duplicating it', async () => {
    const { provider, store } = await seeded();
    provider.mutateProject('app', { rootDirectory: 'apps/manual-drift' });
    const first = await run(provider, store, { triggeredAt: '2026-08-04T08:30:00.000Z' });
    const second = await run(provider, store, { triggeredAt: '2026-08-04T09:00:00.000Z', now: '2026-08-04T09:00:00.000Z' });
    expect(first.result?.driftFingerprint).toBe(second.result?.driftFingerprint);
    const firstPr = first.result?.pullRequest;
    const secondPr = second.result?.pullRequest;
    if (firstPr === undefined || firstPr === null) throw new Error('Expected the first reconciliation check to open a PR; absence would make this assertion vacuous.');
    if (secondPr === undefined || secondPr === null) throw new Error('Expected the second reconciliation check to open a PR; absence would make this assertion vacuous.');
    expect(firstPr.number).toBe(secondPr.number);
    expect(provider.prCalls).toHaveLength(2);
    expect(provider.prCalls[0]?.branch).toBe(provider.prCalls[1]?.branch);
    expect(provider.prCalls[1]?.files[MANIFEST_PATH]).toBe(provider.prCalls[0]?.files[MANIFEST_PATH]);
    // Exactly one open request per application + fingerprint.
    const requests = await store.listReconciliationRequests('app');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.status).toBe('OPEN');
    expect((await store.getApplication('app'))?.syncStatus).toBe('OUT_OF_SYNC');
  });

  it('keeps equivalent drift fingerprints stable across provider timestamps and changes them for different drift', async () => {
    const { provider, store } = await seeded();
    provider.mutateProject('app', { rootDirectory: 'apps/manual-drift' });
    const atNoon = await run(provider, store, { triggeredAt: '2026-08-04T12:00:00.000Z', now: '2026-08-04T12:00:00.000Z' });
    // The live observation carries a fresh observedAt; the fingerprint must not change.
    provider.mutateProject('app', { rootDirectory: 'apps/manual-drift' });
    const atNoonAgain = await run(provider, store, { triggeredAt: '2026-08-04T12:30:00.000Z', now: '2026-08-04T12:30:00.000Z' });
    expect(atNoon.result?.driftFingerprint).toBe(atNoonAgain.result?.driftFingerprint);
    // A genuinely different drift produces a different fingerprint and PR.
    provider.mutateProject('app', { rootDirectory: 'apps/other-drift' });
    const different = await run(provider, store, { triggeredAt: '2026-08-04T13:00:00.000Z', now: '2026-08-04T13:00:00.000Z' });
    expect(different.result?.driftFingerprint).not.toBe(atNoon.result?.driftFingerprint);
    expect(provider.prCalls[2]?.branch).not.toBe(provider.prCalls[0]?.branch);
    expect((await store.listReconciliationRequests('app')).length).toBe(2);
  });

  it('never reports synced when provider access is lost', async () => {
    const { provider, store } = await seeded();
    provider.mutateProject('app', { rootDirectory: 'apps/manual-drift' });
    provider.failNext('observeProject', { code: 'LP-VERCEL-ACCESS-LOST', retryable: false });
    const result = await run(provider, store);
    expect(result.status).toBe('SUCCEEDED');
    expect(result.result?.status).toBe('UNKNOWN');
    expect(result.result?.driftFingerprint).toBeNull();
    expect(result.result?.pullRequest).toBeNull();
    expect(result.result?.accessErrors[0]?.code).toBe('LP-VERCEL-ACCESS-LOST');
    expect((await store.getApplication('app'))?.syncStatus).toBe('UNKNOWN');
    expect(provider.prCalls).toHaveLength(0);
    expect((await store.listDriftEvents('app')).some((event) => event.category === 'UNKNOWN')).toBe(true);
  });

  it('never reports synced when the control-repo ref or manifest cannot be read', async () => {
    // Ref resolution fails (scheduled trigger without a payload sourceCommit).
    const { provider, store } = await seeded();
    provider.failNext('resolveRef', { code: 'LP-GITHUB-ACCESS-LOST', retryable: false });
    const refResult = await run(provider, store);
    expect(refResult.result?.status).toBe('UNKNOWN');
    expect(refResult.result?.pullRequest).toBeNull();
    expect((await store.getApplication('app'))?.syncStatus).toBe('UNKNOWN');

    // Manifest read fails (access loss on the control repository).
    const second = await seeded();
    second.provider.failNext('readFile', { code: 'LP-GITHUB-READ-FAILED', retryable: false });
    const readResult = await run(second.provider, second.store);
    expect(readResult.result?.status).toBe('UNKNOWN');
    expect((await second.store.getApplication('app'))?.syncStatus).toBe('UNKNOWN');
  });

  it('blocks a missing manifest without opening a PR', async () => {
    const { provider, store } = await seeded();
    provider.files.delete(MANIFEST_PATH);
    const result = await run(provider, store);
    expect(result.status).toBe('SUCCEEDED');
    expect(result.result?.status).toBe('BLOCKED');
    expect(result.result?.blockedReason).toBe('BLOCKED_MISSING_MANIFEST');
    expect(result.result?.pullRequest).toBeNull();
    expect((await store.getApplication('app'))?.syncStatus).toBe('BLOCKED');
    expect(provider.prCalls).toHaveLength(0);
  });

  it('blocks approved-deletion manifests and never destroys anything', async () => {
    const { provider, store } = await seeded();
    const callsBeforeRun = [...provider.calls];
    const deletion = { ...desired, lifecycle: { ...desired.lifecycle, state: 'approved-for-deletion' as const, deletionProtection: false, decommission: { requestedAt: '2026-08-01T00:00:00.000Z', deleteAfter: '2026-08-02T00:00:00.000Z', approvalToken: 'token', preserveDeployments: true } } };
    provider.files.set(MANIFEST_PATH, manifestContent(deletion));
    const result = await run(provider, store);
    expect(result.result?.status).toBe('BLOCKED');
    expect(result.result?.pullRequest).toBeNull();
    const callsDuringRun = provider.calls.slice(callsBeforeRun.length);
    expect(callsDuringRun.filter((call) => call.startsWith('ensure') || call === 'deleteProject' || call === 'deleteRecord' || call === 'promote' || call === 'rollback')).toEqual([]);
  });

  it('adopts observed state into a schema-valid full manifest preserving unrelated desired fields', async () => {
    const { provider, store } = await seeded();
    provider.mutateProject('app', { rootDirectory: 'apps/manual-drift' });
    const result = await run(provider, store, { mode: 'adopt-observed-state' });
    expect(result.result?.status).toBe('OUT_OF_SYNC');
    expect(result.result?.operation).toBe('adopt-observed-state');
    expect(result.result?.manifest).toBeDefined();
    expect(provider.prCalls[0]?.files[`reconciliation/app.yaml`]).toContain('operation: adopt-observed-state');

    // The written catalog manifest is schema-valid and preserves unrelated fields.
    const written = provider.prCalls[0]?.files[MANIFEST_PATH] ?? '';
    const catalog = loadCatalog([{ path: MANIFEST_PATH, content: written }]);
    expect(catalog.issues).toHaveLength(0);
    const adopted = catalog.applications[0];
    if (adopted === undefined) throw new Error('Expected the adopted manifest to parse as exactly one application.');
    expect(adopted.metadata.id).toBe('app');
    expect(adopted.vercel.project.rootDirectory).toBe('apps/manual-drift');
    expect(adopted.vercel.project.build.buildCommand).toBe('yarn build');
    expect(adopted.metadata.labels.tier).toBe('gold');
    expect(adopted.repository.name).toBe('acme/app');
    expect(adopted.environments.production?.health.path).toBe('/health');
  });

  it('restore mode writes the unchanged manifest plus a restore request', async () => {
    const { provider, store } = await seeded();
    provider.mutateProject('app', { rootDirectory: 'apps/manual-drift' });
    const seededManifest = manifestContent();
    const result = await run(provider, store, { mode: 'restore-desired-state' });
    expect(result.result?.operation).toBe('restore-desired-state');
    expect(provider.prCalls[0]?.files[MANIFEST_PATH]).toBe(seededManifest);
    expect(provider.prCalls[0]?.files[`reconciliation/app.yaml`]).toContain('operation: restore-desired-state');
    expect(provider.prCalls[0]?.files[`reconciliation/app.yaml`]).toContain(`driftFingerprint: sha256:${result.result?.driftFingerprint}`);
  });

  it('bases the PR on the latest protected main SHA when main advanced between checks', async () => {
    const { provider, store } = await seeded();
    provider.mutateProject('app', { rootDirectory: 'apps/manual-drift' });
    const first = await run(provider, store, { triggeredAt: '2026-08-04T08:30:00.000Z' });
    expect(provider.prCalls[0]?.baseSha).toBe('a'.repeat(40));
    provider.mainSha = 'b'.repeat(40);
    const second = await run(provider, store, { triggeredAt: '2026-08-04T09:00:00.000Z', now: '2026-08-04T09:00:00.000Z' });
    expect(provider.prCalls[1]?.baseSha).toBe('b'.repeat(40));
    // Same drift fingerprint reuses the same branch and PR; no duplicate.
    expect(second.result?.driftFingerprint).toBe(first.result?.driftFingerprint);
    expect(provider.prCalls[1]?.branch).toBe(provider.prCalls[0]?.branch);
    const firstPr = first.result?.pullRequest;
    const secondPr = second.result?.pullRequest;
    if (firstPr === undefined || firstPr === null) throw new Error('Expected the first check to open a PR; absence would make this assertion vacuous.');
    if (secondPr === undefined || secondPr === null) throw new Error('Expected the second check to open a PR; absence would make this assertion vacuous.');
    expect(secondPr.number).toBe(firstPr.number);
  });

  it('reports SYNCED for an applied application with no drift', async () => {
    const { provider, store } = await seeded({ rootDirectory: 'apps/web' });
    const result = await run(provider, store);
    expect(result.status).toBe('SUCCEEDED');
    expect(result.result?.status).toBe('SYNCED');
    expect(result.result?.driftFingerprint).toBeNull();
    expect(result.result?.pullRequest).toBeNull();
    expect((await store.getApplication('app'))?.syncStatus).toBe('SYNCED');
    expect(provider.prCalls).toHaveLength(0);
  });
});
