import { describe, expect, it } from 'vitest';
import { buildPlan, buildResourceGraph, renderPlanMarkdown, type DesiredApplication, type ObservedApplication } from './index.js';
import type { ProviderCapabilities } from '@launchpad/provider-contract';

const desired: DesiredApplication = {
  apiVersion: 'launchpad.dev/v1',
  kind: 'Application',
  metadata: { id: 'app', displayName: 'App', owners: ['@platform'], labels: {}, annotations: {} },
  repository: { provider: 'github', name: 'acme/app', productionBranch: 'main', deploymentRef: 'main' },
  vercel: { scope: {}, project: { name: 'app', framework: 'nextjs', rootDirectory: 'apps/web', nodeVersion: '24.x', build: { installCommand: 'yarn install', buildCommand: 'yarn build', outputDirectory: null, developmentCommand: null, ignoredBuildStep: null }, git: { connected: true, productionBranch: 'main' }, deployment: { autoAssignProductionDomains: false, prioritizeProductionBuilds: true, rollingRelease: null, skewProtection: false }, regions: { functions: [] }, protection: {}, settings: {} } },
  environments: { preview: { enabled: true, strategy: 'shadow-project', health: { path: '/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 10, attempts: 1, intervalSeconds: 0 } } },
  domains: [{ hostname: 'app.example.com', environment: 'production', canonical: true, cloudflare: { zoneRef: 'config://cloudflare/example.com', mode: 'dns-only', ttl: 'auto' }, redirects: [] }],
  secrets: [],
  dependencies: { applications: [], external: [] },
  policies: { drift: { mode: 'open-pr', checkIntervalMinutes: 30 }, destructiveChanges: { allowInNormalApply: false }, preview: { requiredForMerge: true }, staging: { requiredForProduction: false }, health: { requiredForPromotion: true }, failures: { createIssueAfterFinalRetry: true, notifyOwners: true } },
  lifecycle: { state: 'active', deletionProtection: true, orphanPolicy: 'retain', decommission: { requestedAt: null, deleteAfter: null, approvalToken: null, preserveDeployments: true } },
};

const capabilities: ProviderCapabilities = {
  provider: 'fake', adapterVersion: 'testkit-v1', snapshotHash: 'capabilities', features: { stagedProduction: true },
  fields: { 'project.rootDirectory': { read: true, create: true, update: true, delete: false, requiresRedeploy: true, destructiveWhenChanged: false }, 'project.framework': { read: true, create: true, update: true, delete: false, requiresRedeploy: true, destructiveWhenChanged: false } },
};

function observed(rootDirectory = '.'): ObservedApplication {
  return { applicationId: 'app', observedAt: '2026-08-04T00:00:00.000Z', desiredGeneration: 1, desiredHash: 'desired', observedHash: 'observed', resources: [{ provider: 'vercel', resourceType: 'vercel.project', providerResourceId: 'prj_1', resourceKey: 'app', configuration: { name: 'app', framework: 'nextjs', rootDirectory }, ownershipFingerprint: 'owned', observedAt: '2026-08-04T00:00:00.000Z' }], deployments: [], health: { status: 'UNKNOWN', latest: null } };
}

describe('resource graph and planner', () => {
  it('builds a dependency graph with provider and release nodes', () => {
    const graph = buildResourceGraph(desired, observed());
    expect(graph.nodes.map((node) => node.key)).toEqual(expect.arrayContaining(['github.repository', 'vercel.project', 'cloudflare.dns.app.example.com', 'production.promotion']));
    expect(graph.nodes.find((node) => node.key === 'production.promotion')?.dependencies).toContain('production.health');
  });

  it('classifies a root-directory change and downstream redeployments', async () => {
    const plan = await buildPlan({ desired, observed: observed(), capabilities, sourceCommit: 'a'.repeat(40), desiredGeneration: 2, now: '2026-08-04T00:00:00.000Z' });
    expect(plan.operations.some((operation) => operation.action === 'UPDATE_IN_PLACE' && operation.resourceKey === 'vercel.project')).toBe(true);
    expect(plan.operations.some((operation) => operation.action === 'REDEPLOY_REQUIRED' && operation.resourceKey === 'production.candidate')).toBe(true);
    expect(plan.result).toBe('READY');
    expect(renderPlanMarkdown(plan)).toContain('Plan fingerprint');
  });

  it('blocks destructive operations in normal apply', async () => {
    const deletion = { ...desired, lifecycle: { ...desired.lifecycle, state: 'approved-for-deletion' as const, deletionProtection: false } };
    const plan = await buildPlan({ desired: deletion, observed: observed(), capabilities, sourceCommit: 'b'.repeat(40), desiredGeneration: 3, now: '2026-08-04T00:00:00.000Z' });
    expect(plan.result).toBe('DESTRUCTIVE');
    expect(plan.policyResults.some((result) => result.result === 'BLOCK')).toBe(true);
    expect(plan.operations.some((operation) => operation.action === 'DESTROY')).toBe(true);
  });

  it('produces the same fingerprint for equivalent inputs', async () => {
    const input = { desired, observed: observed(), capabilities, sourceCommit: 'c'.repeat(40), desiredGeneration: 4, now: '2026-08-04T00:00:00.000Z' };
    const first = await buildPlan(input);
    const second = await buildPlan({ ...input, observed: { ...input.observed, resources: [...input.observed.resources].reverse() } });
    expect(first.fingerprint).toBe(second.fingerprint);
  });
});
