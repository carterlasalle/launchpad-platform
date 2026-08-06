import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadCatalog } from '@launchpad/catalog';
import { buildPlan, desiredStateHash, planReviewFingerprint, type FieldCapability, type ProviderCapabilities } from '@launchpad/core';
import { InMemoryLaunchpadStore } from '@launchpad/database';
import { FakeProvider } from '@launchpad/provider-testkit';
import { stringify } from 'yaml';
import { applyObserveLiveState, issueDeletionApproval, makeApplyBase, runApplyWorkflow, runDecommissionWorkflow, runPreviewWorkflow, runReconcileWorkflow } from '@launchpad/workflows';
import type { ProviderContext } from '@launchpad/provider-contract';

const context: ProviderContext = { correlationId: 'e2e-correlation', applicationId: 'fixture-app', workflowId: 'e2e-workflow', actor: { kind: 'system', id: 'e2e' }, dryRun: false };
const MANIFEST_PATH = 'catalog/apps/fixture-app.yaml';
const COMMIT = 'a'.repeat(40);
const NOW = '2026-08-04T00:00:00.000Z';

function capability(requiresRedeploy = false): FieldCapability {
  return { read: true, create: true, update: true, delete: false, requiresRedeploy, destructiveWhenChanged: false };
}

/** Full capability matrix matching the fixture manifest surface, so plans build READY against the fake adapter. */
const FULL_CAPABILITIES: ProviderCapabilities = {
  provider: 'fake', adapterVersion: 'testkit-v1', snapshotHash: 'testkit-full',
  features: { stagedProduction: true, customEnvironment: true, exactPromotion: true },
  fields: {
    'project.name': capability(), 'project.framework': capability(true), 'project.rootDirectory': capability(true), 'project.nodeVersion': capability(true),
    'project.build.installCommand': capability(true), 'project.build.buildCommand': capability(true), 'project.build.outputDirectory': capability(true),
    'project.build.developmentCommand': capability(true), 'project.build.ignoredBuildStep': capability(true),
    'project.settings.autoAssignProductionDomains': capability(), 'project.settings.prioritizeProductionBuilds': capability(), 'project.settings.rollingRelease': capability(), 'project.settings.skewProtection': capability(),
    'project.regions.functions': capability(true),
    'domain.hostname': capability(), 'domain.environment': capability(), 'domain.canonical': capability(), 'domain.mode': capability(), 'domain.ttl': capability(), 'domain.zoneRef': capability(),
    'dns.record.proxied': capability(), 'dns.record.ttl': capability(), 'dns.record.zoneRef': capability(),
  },
};

it('proves catalog, preview, apply, drift, reconciliation, and safe deletion', async () => {
  const catalog = loadCatalog([{ path: 'tests/fixtures/catalog/fixture-app.yaml', content: readFileSync('tests/fixtures/catalog/fixture-app.yaml', 'utf8') }]);
  expect(catalog.issues).toEqual([]);
  const desired = catalog.applications[0];
  if (!desired) throw new Error('Fixture application missing');
  const provider = new FakeProvider();
  const store = new InMemoryLaunchpadStore({ now: () => new Date(NOW) });
  const preview = await runPreviewWorkflow({ store, provider, source: provider as never, desired, pullRequestNumber: 1, repositoryId: 12345, revision: 1, sourceCommit: COMMIT, planFingerprint: 'e2e-preview', health: desired.environments.preview?.health ?? { path: '/api/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 1, attempts: 1, intervalSeconds: 0 }, context, fetchImpl: async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }), sleep: async () => undefined });
  expect(preview.status, `preview failed with ${preview.errorCode ?? 'unknown'}`).toBe('READY');
  expect(preview.health === null || preview.health.result === 'PASSED').toBe(true);
  provider.capabilities = async () => FULL_CAPABILITIES;
  // The plan diff compares manifest settings/protection against observed
  // provider state; keep them empty for the from-scratch fixture journey
  // (the same shape the apply unit fixtures use).
  desired.vercel.project.settings = {};
  desired.vercel.project.protection = {};
  desired.vercel.project.regions.functions = [];
  desired.vercel.project.build.developmentCommand = null;
  const applyBase = await makeApplyBase({ applicationId: desired.metadata.id, sourceCommit: 'b'.repeat(40), planFingerprint: 'pending', desiredGeneration: 1, idempotencyKey: 'e2e-apply', workflowId: 'e2e-apply-wf' });
  const live = await applyObserveLiveState({ base: applyBase, store, provider, desired, context });
  const ownership: Record<string, string> = {};
  for (const resource of await store.listResources(desired.metadata.id)) ownership[resource.resourceKey] = resource.ownershipFingerprint ?? '';
  const plan = await buildPlan({ desired, observed: live.observed, capabilities: live.capabilities, sourceCommit: applyBase.sourceCommit, desiredGeneration: 1, now: NOW, ownership });
  // Record the reviewed-plan attestation the apply gate requires (the PR-head
  // review evidence for this exact plan and desired state).
  await store.savePlanReviewAttestation({ applicationId: desired.metadata.id, prHeadSourceCommit: plan.sourceCommit, desiredHash: await desiredStateHash(desired), generation: plan.desiredGeneration, planFingerprint: plan.fingerprint, reviewFingerprint: await planReviewFingerprint(plan), repository: 'acme/fixture', actor: 'e2e', workflowRef: 'acme/fixture/.github/workflows/apply.yml@refs/heads/main' });
  const applied = await runApplyWorkflow({ store, provider, desired, observed: live.observed, plan, sourceCommit: plan.sourceCommit, context, fetchImpl: async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }), sleep: async () => undefined });
  expect(applied.status, `apply failed with ${applied.errorCode ?? 'unknown'}`).toBe('SUCCEEDED');

  // Reconciliation: the pristine applied manifest is the control-repository
  // desired state; a manual provider change must surface as OUT_OF_SYNC
  // through the granular workflow and open one reviewable control-repo PR.
  const pristine = structuredClone(desired);
  const { sourcePath: _sourcePath, ...pristineBody } = pristine;
  const manifestYaml = stringify(pristineBody as unknown as Record<string, unknown>, { aliasDuplicateObjects: false, lineWidth: 0 });
  provider.files.set(MANIFEST_PATH, manifestYaml);
  provider.mutateProject(desired.metadata.id, { rootDirectory: 'apps/manual-drift' });
  const drift = await runReconcileWorkflow({ store, provider, source: provider, controlRepository: 'acme/control', applicationId: desired.metadata.id, mode: 'open-pr', sourceCommit: plan.sourceCommit, triggeredAt: NOW, context, now: NOW });
  expect(drift.status, `reconcile failed with ${drift.errorCode ?? 'unknown'} at ${drift.failedStep ?? '?'}`).toBe('SUCCEEDED');
  expect(drift.result?.status).toBe('OUT_OF_SYNC');
  expect(drift.result?.drift.some((record) => record.resourceKey === 'vercel.project')).toBe(true);

  // Safe deletion: only the reviewed flow (approved manifest + single-use
  // token + ownership evidence) may destroy anything. The approved manifest
  // is the unmutated fixture (schema-complete) with the reviewed lifecycle.
  const approved = { ...pristine, lifecycle: { ...pristine.lifecycle, state: 'approved-for-deletion' as const, deletionProtection: false, decommission: { ...pristine.lifecycle.decommission, requestedAt: '2026-08-03T00:00:00.000Z', deleteAfter: '2026-08-03T00:00:00.000Z', approvalToken: null } } };
  const approvedBody = { ...approved } as Record<string, unknown>;
  delete approvedBody.sourcePath;
  provider.files.set(MANIFEST_PATH, stringify(approvedBody, { aliasDuplicateObjects: false, lineWidth: 0 }));
  const project = await provider.observeProject({ projectId: desired.metadata.id }, context);
  if (project === null) throw new Error('fixture project missing after apply');
  await store.upsertResource({ applicationId: desired.metadata.id, provider: 'vercel', resourceType: 'vercel.project', resourceKey: 'vercel.project', providerResourceId: project.providerResourceId, desiredGeneration: 1, observedHash: 'h', ownershipFingerprint: project.ownershipFingerprint });
  const issued = await issueDeletionApproval({ store, binding: { applicationId: desired.metadata.id, domain: 'fixture.example.com', sourceCommit: COMMIT, actor: 'e2e-operator', expiresAt: '2026-08-10T00:00:00.000Z' }, now: NOW });
  const removed = await runDecommissionWorkflow({
    applicationId: desired.metadata.id,
    approvalId: issued.approvalId,
    approvalToken: issued.token,
    sourceCommit: COMMIT,
    domain: 'fixture.example.com',
    actor: 'e2e-operator',
    now: NOW,
    idempotencyKey: 'e2e-destroy',
    workflowId: 'e2e-destroy-wf',
    controlRepository: 'acme/control',
    manifestPath: MANIFEST_PATH,
    dependentCatalog: [],
    provider,
    source: provider,
    store,
    context,
  });
  expect(removed.status, `destroy failed with ${removed.errorCode ?? 'unknown'} at ${removed.failedStep ?? '?'}`).toBe('DELETED');
  expect(removed.exportJson).toContain('exportVersion');
  expect(removed.tombstone?.applicationId).toBe(desired.metadata.id);
  expect(await store.isTombstoned(desired.metadata.id)).toBe(true);
  expect((await store.getApplication(desired.metadata.id))?.lifecycleState).toBe('deleted');
});
