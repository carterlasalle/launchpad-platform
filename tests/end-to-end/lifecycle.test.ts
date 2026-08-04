import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadCatalog } from '@launchpad/catalog';
import { buildPlan } from '@launchpad/core';
import { InMemoryDatabase, LaunchpadRepositories } from '@launchpad/database';
import { FakeProvider } from '@launchpad/provider-testkit';
import { runApplyWorkflow, runPreviewWorkflow, reconcileApplication, decommissionApplication } from '@launchpad/workflows';
import type { ProviderContext } from '@launchpad/provider-contract';

const context: ProviderContext = { correlationId: 'e2e-correlation', applicationId: 'fixture-app', workflowId: 'e2e-workflow', actor: { kind: 'system', id: 'e2e' }, dryRun: false };

it('proves catalog, preview, apply, drift, reconciliation, and safe deletion', async () => {
  const catalog = loadCatalog([{ path: 'catalog/apps/fixture.yaml', content: readFileSync('catalog/apps/fixture.yaml', 'utf8') }]);
  expect(catalog.issues).toEqual([]);
  const desired = catalog.applications[0];
  if (!desired) throw new Error('Fixture application missing');
  const provider = new FakeProvider();
  const repositories = new LaunchpadRepositories(new InMemoryDatabase());
  const preview = await runPreviewWorkflow({ provider, project: { id: desired.metadata.id, name: desired.vercel.project.name, teamId: null, framework: desired.vercel.project.framework, rootDirectory: desired.vercel.project.rootDirectory, nodeVersion: desired.vercel.project.nodeVersion, build: { installCommand: desired.vercel.project.build.installCommand, buildCommand: desired.vercel.project.build.buildCommand, outputDirectory: desired.vercel.project.build.outputDirectory }, repository: desired.repository.name, productionBranch: desired.repository.productionBranch, settings: desired.vercel.project.settings }, pullRequestNumber: 1, revision: 1, commitSha: 'a'.repeat(40), health: desired.environments.preview?.health ?? { path: '/api/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 1, attempts: 1, intervalSeconds: 0 }, context, fetchImpl: async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }), sleep: async () => undefined });
  expect(preview.health.result).toBe('PASSED');
  const plan = await buildPlan({ desired, observed: { applicationId: desired.metadata.id, observedAt: '2026-08-04T00:00:00.000Z', desiredGeneration: 1, desiredHash: '', observedHash: '', resources: [], deployments: [], health: { status: 'UNKNOWN', latest: null } }, capabilities: await provider.capabilities(), sourceCommit: 'b'.repeat(40), desiredGeneration: 1, now: '2026-08-04T00:00:00.000Z' });
  const applied = await runApplyWorkflow({ repositories, provider, desired, observed: { applicationId: desired.metadata.id, observedAt: '2026-08-04T00:00:00.000Z', desiredGeneration: 1, desiredHash: '', observedHash: '', resources: [], deployments: [], health: { status: 'UNKNOWN', latest: null } }, plan, sourceCommit: plan.sourceCommit, context, fetchImpl: async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }), sleep: async () => undefined });
  expect(applied.status).toBe('SUCCEEDED');
  provider.mutateProject(desired.metadata.id, { rootDirectory: 'apps/manual-drift' });
  const drift = await reconcileApplication({ provider, source: provider, desired, observed: { applicationId: desired.metadata.id, observedAt: '2026-08-04T00:00:00.000Z', desiredGeneration: 1, desiredHash: '', observedHash: '', resources: [], deployments: [], health: { status: 'UNKNOWN', latest: null } }, context, mode: 'open-pr', mainCommit: plan.sourceCommit });
  expect(drift.status).toBe('OUT_OF_SYNC');
  const deletion = { ...desired, lifecycle: { ...desired.lifecycle, state: 'approved-for-deletion' as const, deletionProtection: false, decommission: { requestedAt: '2026-08-03T00:00:00.000Z', deleteAfter: '2026-08-03T00:00:00.000Z', approvalToken: 'delete-fixture', preserveDeployments: true } } };
  const removed = await decommissionApplication({ provider, repositories, desired: deletion, observed: { applicationId: desired.metadata.id, observedAt: '2026-08-04T00:00:00.000Z', desiredGeneration: 1, desiredHash: '', observedHash: '', resources: [], deployments: [], health: { status: 'UNKNOWN', latest: null } }, approvalToken: 'delete-fixture', now: '2026-08-04T00:00:00.000Z', context });
  expect(removed.status).toBe('DELETED');
  expect(repositories.isTombstoned(desired.metadata.id)).toBe(true);
});
