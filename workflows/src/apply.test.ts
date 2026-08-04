import { expect, it } from 'vitest';
import { buildPlan, type DesiredApplication, type ObservedApplication } from '@launchpad/core';
import { FakeProvider } from '@launchpad/provider-testkit';
import { InMemoryDatabase, LaunchpadRepositories } from '@launchpad/database';
import { runApplyWorkflow } from './index.js';
import type { ProviderContext } from '@launchpad/provider-contract';

const desired: DesiredApplication = {
  apiVersion: 'launchpad.dev/v1', kind: 'Application', metadata: { id: 'app', displayName: 'App', owners: ['@platform'], labels: {}, annotations: {} }, repository: { provider: 'github', name: 'acme/app', productionBranch: 'main', deploymentRef: 'main' }, vercel: { scope: {}, project: { name: 'app', framework: 'nextjs', rootDirectory: '.', nodeVersion: '24.x', build: { installCommand: 'yarn install', buildCommand: 'yarn build', outputDirectory: null, developmentCommand: null, ignoredBuildStep: null }, git: { connected: true, productionBranch: 'main' }, deployment: { autoAssignProductionDomains: false, prioritizeProductionBuilds: true, rollingRelease: null, skewProtection: false }, regions: { functions: [] }, protection: {}, settings: {} } }, environments: { preview: { enabled: true, health: { path: '/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 1, attempts: 1, intervalSeconds: 0 } }, production: { enabled: true, health: { path: '/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 1, attempts: 1, intervalSeconds: 0 }, release: { strategy: 'staged-production', promoteExactBuild: true, autoPromoteAfterChecks: true }, rollback: { enabled: true, onFailedHealthCheck: true, previousKnownGood: true } } }, domains: [{ hostname: 'app.example.com', environment: 'production', cloudflare: { zoneRef: 'config://cloudflare/example.com', mode: 'dns-only', ttl: 'auto' }, redirects: [] }], secrets: [], dependencies: { applications: [], external: [] }, policies: { drift: { mode: 'open-pr', checkIntervalMinutes: 30 }, destructiveChanges: { allowInNormalApply: false }, preview: { requiredForMerge: true }, staging: { requiredForProduction: false }, health: { requiredForPromotion: true }, failures: { createIssueAfterFinalRetry: true, notifyOwners: true } }, lifecycle: { state: 'active', deletionProtection: true, orphanPolicy: 'retain', decommission: { requestedAt: null, deleteAfter: null, approvalToken: null, preserveDeployments: true } },
};
const context: ProviderContext = { correlationId: 'corr', applicationId: 'app', workflowId: 'apply', actor: { kind: 'system', id: 'test' }, dryRun: false };
const observed = (): ObservedApplication => ({ applicationId: 'app', observedAt: '2026-08-04T00:00:00.000Z', desiredGeneration: 1, desiredHash: '', observedHash: '', resources: [], deployments: [], health: { status: 'UNKNOWN', latest: null } });

it('applies, health-checks, and promotes the exact candidate', async () => {
  const provider = new FakeProvider();
  const plan = await buildPlan({ desired, observed: observed(), capabilities: await provider.capabilities(), sourceCommit: 'a'.repeat(40), desiredGeneration: 1, now: '2026-08-04T00:00:00.000Z' });
  const result = await runApplyWorkflow({ repositories: new LaunchpadRepositories(new InMemoryDatabase()), provider, desired, observed: observed(), plan, sourceCommit: plan.sourceCommit, context, fetchImpl: async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }), sleep: async () => undefined });
  expect(result.status).toBe('SUCCEEDED');
  expect(result.candidate?.commitSha).toBe(plan.sourceCommit);
  expect(result.rollback).toBeNull();
});

it('rejects a stale plan before provider writes', async () => {
  const provider = new FakeProvider();
  const plan = await buildPlan({ desired, observed: observed(), capabilities: await provider.capabilities(), sourceCommit: 'a'.repeat(40), desiredGeneration: 1, now: '2026-08-04T00:00:00.000Z' });
  const result = await runApplyWorkflow({ repositories: new LaunchpadRepositories(new InMemoryDatabase()), provider, desired, observed: observed(), plan, sourceCommit: 'b'.repeat(40), context, fetchImpl: fetch, sleep: async () => undefined });
  expect(result.status).toBe('FAILED');
  expect(result.errorCode).toBe('LP-PLAN-STALE');
  expect(provider.calls).toEqual([]);
});

it('fails the release while reporting successful rollback', async () => {
  const provider = new FakeProvider();
  await provider.ensureProject({ id: 'app', name: 'app', teamId: null, framework: 'nextjs', rootDirectory: '.', nodeVersion: '24.x', build: { installCommand: 'yarn install', buildCommand: 'yarn build', outputDirectory: null }, repository: 'acme/app', productionBranch: 'main', settings: {} }, context);
  const previous = await provider.createDeployment({ projectId: 'app', environment: 'production', repository: 'acme/app', commitSha: 'c'.repeat(40), desiredGeneration: 0, staged: false }, context);
  await provider.promote({ projectId: 'app', deploymentId: previous.id, expectedCommitSha: previous.commitSha }, context);
  const knownGood = { ...previous, state: 'CURRENT' as const };
  const plan = await buildPlan({ desired, observed: { ...observed(), deployments: [knownGood] }, capabilities: await provider.capabilities(), sourceCommit: 'a'.repeat(40), desiredGeneration: 1, now: '2026-08-04T00:00:00.000Z' });
  let healthCalls = 0;
  const result = await runApplyWorkflow({ repositories: new LaunchpadRepositories(new InMemoryDatabase()), provider, desired, observed: { ...observed(), deployments: [knownGood] }, plan, sourceCommit: plan.sourceCommit, context, fetchImpl: async () => { healthCalls += 1; return new Response(JSON.stringify({ status: healthCalls === 1 ? 'ok' : 'bad' }), { status: healthCalls === 1 ? 200 : 500 }); }, sleep: async () => undefined });
  expect(result.status).toBe('FAILED');
  expect(result.rollback?.restored).toBe(true);
});
