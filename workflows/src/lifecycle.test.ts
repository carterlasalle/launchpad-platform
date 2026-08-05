import { expect, it } from 'vitest';
import { FakeProvider } from '@launchpad/provider-testkit';
import { InMemoryLaunchpadStore } from '@launchpad/database';
import { rollbackProduction, runReconcileWorkflow } from './index.js';
import { stringify } from 'yaml';
import type { DesiredApplication } from '@launchpad/core';
import type { ProviderContext } from '@launchpad/provider-contract';

const context: ProviderContext = { correlationId: 'corr', applicationId: 'app', workflowId: 'wf', actor: { kind: 'operator', id: 'test' }, dryRun: false };
const desired: DesiredApplication = { apiVersion: 'launchpad.dev/v1', kind: 'Application', metadata: { id: 'app', displayName: 'App', owners: ['@platform'], labels: {}, annotations: {} }, repository: { provider: 'github', name: 'acme/app', productionBranch: 'main', deploymentRef: 'main' }, vercel: { scope: {}, project: { name: 'app', framework: 'nextjs', rootDirectory: 'apps/web', nodeVersion: '24.x', build: { installCommand: 'yarn install', buildCommand: 'yarn build', outputDirectory: null, developmentCommand: null, ignoredBuildStep: null }, git: { connected: true, productionBranch: 'main' }, deployment: { autoAssignProductionDomains: false, prioritizeProductionBuilds: true, rollingRelease: null, skewProtection: false }, regions: { functions: [] }, protection: {}, settings: {} } }, environments: { production: { enabled: true, health: { path: '/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 1, attempts: 1, intervalSeconds: 0 } } }, domains: [{ hostname: 'app.example.com', environment: 'production', cloudflare: { zoneRef: 'config://cloudflare/example.com', mode: 'dns-only', ttl: 'auto' }, redirects: [] }], secrets: [], dependencies: { applications: [], external: [] }, policies: { drift: { mode: 'open-pr', checkIntervalMinutes: 30 }, destructiveChanges: { allowInNormalApply: false }, preview: { requiredForMerge: true }, staging: { requiredForProduction: false }, health: { requiredForPromotion: true }, failures: { createIssueAfterFinalRetry: true, notifyOwners: true } }, lifecycle: { state: 'active', deletionProtection: true, orphanPolicy: 'retain', decommission: { requestedAt: null, deleteAfter: null, approvalToken: null, preserveDeployments: true } } };

it('rolls back to an exact known-good deployment', async () => {
  const provider = new FakeProvider();
  await provider.ensureProject({ id: 'app', name: 'app', teamId: null, framework: 'nextjs', rootDirectory: '.', nodeVersion: '24.x', build: { installCommand: null, buildCommand: null, outputDirectory: null }, repository: 'acme/app', productionBranch: 'main', settings: {} }, context);
  const knownGood = await provider.createDeployment({ projectId: 'app', environment: 'production', repository: 'acme/app', commitSha: 'a'.repeat(40), desiredGeneration: 1, staged: false }, context);
  const failed = await provider.createDeployment({ projectId: 'app', environment: 'production', repository: 'acme/app', commitSha: 'b'.repeat(40), desiredGeneration: 2, staged: true }, context);
  const result = await rollbackProduction({ provider, projectId: 'app', failedDeploymentId: failed.id, knownGoodDeploymentId: knownGood.id, context });
  expect(result.restored).toBe(true);
});

it('opens one reconciliation PR for stable drift', async () => {
  const provider = new FakeProvider();
  await provider.ensureProject({ id: 'app', name: 'app', teamId: null, framework: 'nextjs', rootDirectory: '.', nodeVersion: '24.x', build: { installCommand: null, buildCommand: null, outputDirectory: null }, repository: 'acme/app', productionBranch: 'main', settings: {} }, context);
  provider.mutateProject('app', { rootDirectory: 'apps/manual-drift' });
  provider.files.set('catalog/apps/app.yaml', stringify(desired as unknown as Record<string, unknown>));
  const store = new InMemoryLaunchpadStore();
  await store.upsertApplication({ id: 'app', displayName: 'App', sourcePath: 'catalog/apps/app.yaml', desiredGeneration: 1, desiredHash: 'desired', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
  const result = await runReconcileWorkflow({ store, provider, source: provider, controlRepository: 'acme/control', applicationId: 'app', mode: 'open-pr', triggeredAt: '2026-08-04T08:30:00.000Z', context, now: '2026-08-04T08:30:00.000Z' });
  expect(result.status).toBe('SUCCEEDED');
  expect(result.result?.status).toBe('OUT_OF_SYNC');
  expect(result.result?.pullRequest?.number).toBeTypeOf('number');
  expect(result.result?.driftFingerprint).toMatch(/^[0-9a-f]{64}$/);
  // Reconciliation PRs target the control repository, never the app repository.
  expect(provider.prCalls[0]?.repository).toBe('acme/control');
});
