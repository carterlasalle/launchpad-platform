import { expect, it } from 'vitest';
import { FakeProvider } from '@launchpad/provider-testkit';
import { InMemoryDatabase, LaunchpadRepositories } from '@launchpad/database';
import { decommissionApplication, reconcileApplication, rollbackProduction } from './index.js';
import type { DesiredApplication, ObservedApplication } from '@launchpad/core';
import type { ProviderContext } from '@launchpad/provider-contract';

const context: ProviderContext = { correlationId: 'corr', applicationId: 'app', workflowId: 'wf', actor: { kind: 'operator', id: 'test' }, dryRun: false };
const desired: DesiredApplication = { apiVersion: 'launchpad.dev/v1', kind: 'Application', metadata: { id: 'app', displayName: 'App', owners: ['@platform'], labels: {}, annotations: {} }, repository: { provider: 'github', name: 'acme/app', productionBranch: 'main', deploymentRef: 'main' }, vercel: { scope: {}, project: { name: 'app', framework: 'nextjs', rootDirectory: 'apps/web', nodeVersion: '24.x', build: { installCommand: 'yarn install', buildCommand: 'yarn build', outputDirectory: null, developmentCommand: null, ignoredBuildStep: null }, git: { connected: true, productionBranch: 'main' }, deployment: { autoAssignProductionDomains: false, prioritizeProductionBuilds: true, rollingRelease: null, skewProtection: false }, regions: { functions: [] }, protection: {}, settings: {} } }, environments: { production: { enabled: true, health: { path: '/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 1, attempts: 1, intervalSeconds: 0 } } }, domains: [{ hostname: 'app.example.com', environment: 'production', cloudflare: { zoneRef: 'config://cloudflare/example.com', mode: 'dns-only', ttl: 'auto' }, redirects: [] }], secrets: [], dependencies: { applications: [], external: [] }, policies: { drift: { mode: 'open-pr', checkIntervalMinutes: 30 }, destructiveChanges: { allowInNormalApply: false }, preview: { requiredForMerge: true }, staging: { requiredForProduction: false }, health: { requiredForPromotion: true }, failures: { createIssueAfterFinalRetry: true, notifyOwners: true } }, lifecycle: { state: 'active', deletionProtection: true, orphanPolicy: 'retain', decommission: { requestedAt: null, deleteAfter: null, approvalToken: null, preserveDeployments: true } } };
const observed: ObservedApplication = { applicationId: 'app', observedAt: '2026-08-04T00:00:00.000Z', desiredGeneration: 1, desiredHash: 'desired', observedHash: 'observed', resources: [{ provider: 'vercel', resourceType: 'vercel.project', providerResourceId: 'app', resourceKey: 'app', configuration: { rootDirectory: '.' }, ownershipFingerprint: 'owned', observedAt: '2026-08-04T00:00:00.000Z' }], deployments: [], health: { status: 'UNKNOWN', latest: null } };

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
  provider.mutateProject('app', { rootDirectory: 'apps/web' });
  const result = await reconcileApplication({ provider, source: provider, desired, observed, context, mode: 'open-pr', mainCommit: 'a'.repeat(40) });
  expect(result.status).toBe('OUT_OF_SYNC');
  expect(result.pullRequest?.number).toBeTypeOf('number');
  expect(result.driftFingerprint).toMatch(/^[0-9a-f]{16}$/);
});

it('decommissions only with explicit approval and preserves a tombstone', async () => {
  const provider = new FakeProvider();
  await provider.ensureProject({ id: 'app', name: 'app', teamId: null, framework: 'nextjs', rootDirectory: '.', nodeVersion: '24.x', build: { installCommand: null, buildCommand: null, outputDirectory: null }, repository: 'acme/app', productionBranch: 'main', settings: {} }, context);
  const approvalToken = 'delete-app-token';
  const deletion = { ...desired, lifecycle: { ...desired.lifecycle, state: 'approved-for-deletion' as const, deletionProtection: false, decommission: { requestedAt: '2026-08-03T00:00:00.000Z', deleteAfter: '2026-08-03T00:00:00.000Z', approvalToken, preserveDeployments: true } } };
  const repositories = new LaunchpadRepositories(new InMemoryDatabase());
  const result = await decommissionApplication({ provider, repositories, desired: deletion, observed, approvalToken, now: '2026-08-04T00:00:00.000Z', context });
  expect(result.status).toBe('DELETED');
  expect(repositories.isTombstoned('app')).toBe(true);
});
