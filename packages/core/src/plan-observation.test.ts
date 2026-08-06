import { expect, it } from 'vitest';
import { buildPlanObservedState, buildPlan, satisfiedProjection, type DesiredApplication, type ObservedResource } from './index.js';
import { canonicalJson, sha256Hex } from '@launchpad/shared';

const desired = {
  metadata: { id: 'app', displayName: 'App', owners: ['@platform'], labels: {}, annotations: {} },
  repository: { provider: 'github' as const, name: 'acme/app', productionBranch: 'main', deploymentRef: 'main' },
  vercel: {
    scope: {},
    project: { name: 'app', framework: null, rootDirectory: '.', nodeVersion: '24.x', build: { installCommand: 'yarn install', buildCommand: 'yarn build', outputDirectory: null, developmentCommand: null, ignoredBuildStep: null }, git: { connected: true, productionBranch: 'main' }, deployment: { autoAssignProductionDomains: false }, regions: { functions: [] }, protection: {}, settings: {} },
  },
  environments: {},
  domains: [
    { hostname: 'app.example.com', environment: 'production' as const, canonical: true, cloudflare: { zoneRef: 'config://cloudflare/example.com', mode: 'dns-only' as const, ttl: 'auto' as const }, redirects: [] },
  ],
  secrets: [],
  dependencies: { applications: [], external: [] },
  policies: {},
  lifecycle: { state: 'active' as const, deletionProtection: true, orphanPolicy: 'retain' as const, decommission: { requestedAt: null, deleteAfter: null, approvalToken: null, preserveDeployments: true } },
} as unknown as DesiredApplication;

const project: ObservedResource = {
  provider: 'vercel', resourceType: 'project', resourceKey: 'vercel.project', providerResourceId: 'app',
  configuration: { name: 'app', rootDirectory: '.', framework: null }, ownershipFingerprint: 'own-1', observedAt: 't1',
};

it('assembles the exact provider-visible resource projection both callers must share', () => {
  const observed = buildPlanObservedState({
    applicationId: 'app',
    desired,
    project,
    deployment: { id: 'dpl_1', projectId: 'app', environment: 'preview', repository: 'acme/app', commitSha: 'a'.repeat(40), desiredGeneration: 0, state: 'READY', url: 'https://app.vercel.app', createdAt: 't' },
    dns: [{ domain: desired.domains[0]!, zoneId: 'zone_1', record: { id: 'rec_1', ownershipFingerprint: 'own-dns' } }],
  });
  expect(observed.resources).toEqual([
    project,
    {
      provider: 'vercel', resourceType: 'project-domain', resourceKey: 'vercel.domain.app.example.com', providerResourceId: 'app:app.example.com',
      configuration: satisfiedProjection({ hostname: 'app.example.com', environment: 'production', canonical: true, mode: 'dns-only', ttl: 'auto', zoneRef: 'config://cloudflare/example.com' }),
      ownershipFingerprint: expect.stringMatching(/^[0-9a-f]+$/) as unknown as string, observedAt: expect.any(String) as unknown as string,
    },
    {
      provider: 'cloudflare', resourceType: 'dns-record', resourceKey: 'cloudflare.dns.app.example.com', providerResourceId: 'rec_1',
      configuration: { zoneRef: 'config://cloudflare/example.com', mode: 'dns-only', ttl: 'auto', proxied: false },
      ownershipFingerprint: 'own-dns', observedAt: expect.any(String) as unknown as string,
    },
  ]);
  expect(observed.deployments).toHaveLength(1);
  expect(observed.health).toEqual({ status: 'UNKNOWN', latest: null });
  expect(observed.lifecycleState).toBeNull();
});

it('is deterministic: equal inputs yield equal observed state and fingerprints', async () => {
  const first = buildPlanObservedState({ applicationId: 'app', desired, project, deployment: null, dns: [{ domain: desired.domains[0]!, zoneId: 'zone_1', record: null }] });
  const second = buildPlanObservedState({ applicationId: 'app', desired, project, deployment: null, dns: [{ domain: desired.domains[0]!, zoneId: 'zone_1', record: null }] });
  const resources = (observed: ReturnType<typeof buildPlanObservedState>) => observed.resources.map(({ observedAt: _observedAt, ...resource }) => resource);
  expect(canonicalJson(resources(first))).toBe(canonicalJson(resources(second)));
  const capabilities = { provider: 'vercel' as const, adapterVersion: 'composite-v1', fields: {}, features: {}, snapshotHash: 'snapshot' };
  const planFor = (observed: ReturnType<typeof buildPlanObservedState>) => buildPlan({ desired, observed, capabilities, sourceCommit: 'a'.repeat(40), desiredGeneration: 1, mode: 'apply', now: '2026-08-04T00:00:00.000Z' });
  expect((await planFor(first)).fingerprint).toBe((await planFor(second)).fingerprint);
});

it('the fingerprint depends on observed provider resources (the drift the gate must catch)', async () => {
  const base = buildPlanObservedState({ applicationId: 'app', desired, project: null, deployment: null, dns: [{ domain: desired.domains[0]!, zoneId: 'zone_1', record: null }] });
  const drifted = buildPlanObservedState({ applicationId: 'app', desired, project: { ...project, configuration: { ...project.configuration, rootDirectory: 'apps/changed' } }, deployment: null, dns: [{ domain: desired.domains[0]!, zoneId: 'zone_1', record: null }] });
  const capabilities = { provider: 'vercel' as const, adapterVersion: 'composite-v1', fields: {}, features: {}, snapshotHash: 'snapshot' };
  const planFor = (observed: ReturnType<typeof buildPlanObservedState>) => buildPlan({ desired, observed, capabilities, sourceCommit: 'a'.repeat(40), desiredGeneration: 1, mode: 'apply', now: '2026-08-04T00:00:00.000Z' });
  expect((await planFor(base)).fingerprint).not.toBe((await planFor(drifted)).fingerprint);
});
