import { stableId } from '@launchpad/shared';
import type { DesiredApplication, FieldCapability, ObservedApplication, ObservedResource, ProviderCapabilities, ProviderName } from './index.js';

export const OWNERSHIP = stableId('ownership', 'app', 'vercel.project', 'app');

export function capability(overrides: Partial<FieldCapability> = {}): FieldCapability {
  return { read: true, create: true, update: true, delete: false, requiresRedeploy: false, destructiveWhenChanged: false, ...overrides };
}

export const capabilities: ProviderCapabilities = {
  provider: 'fake',
  adapterVersion: 'testkit-v1',
  snapshotHash: 'capabilities',
  features: { stagedProduction: true, customEnvironment: true },
  fields: {
    'project.rootDirectory': capability({ requiresRedeploy: true }),
    'project.framework': capability({ requiresRedeploy: true }),
    'project.nodeVersion': capability({ requiresRedeploy: true }),
    'project.build.installCommand': capability({ requiresRedeploy: true }),
    'project.build.buildCommand': capability({ requiresRedeploy: true }),
    'project.settings.autoAssignProductionDomains': capability(),
    'project.settings.prioritizeProductionBuilds': capability(),
    'project.settings.skewProtection': capability(),
    'domain.hostname': capability(),
    'domain.environment': capability(),
    'domain.canonical': capability(),
    'domain.mode': capability(),
    'domain.ttl': capability(),
    'domain.zoneRef': capability(),
    'dns.record.proxied': capability(),
    'dns.record.ttl': capability(),
    'dns.record.zoneRef': capability(),
  },
};

export const desired: DesiredApplication = {
  apiVersion: 'launchpad.dev/v1',
  kind: 'Application',
  metadata: { id: 'app', displayName: 'App', owners: ['@platform'], labels: {}, annotations: {} },
  repository: { provider: 'github', name: 'acme/app', productionBranch: 'main', deploymentRef: 'main' },
  vercel: {
    scope: {},
    project: {
      name: 'app',
      framework: 'nextjs',
      rootDirectory: 'apps/web',
      nodeVersion: '24.x',
      build: { installCommand: 'yarn install', buildCommand: 'yarn build', outputDirectory: null, developmentCommand: null, ignoredBuildStep: null },
      git: { connected: true, productionBranch: 'main' },
      deployment: { autoAssignProductionDomains: false, prioritizeProductionBuilds: true, rollingRelease: null, skewProtection: false },
      regions: { functions: [] },
      protection: {},
      settings: {},
    },
  },
  environments: {
    preview: {
      enabled: true,
      strategy: 'shadow-project',
      health: { path: '/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 10, attempts: 1, intervalSeconds: 0 },
    },
    production: {
      enabled: true,
      strategy: 'custom-environment',
      health: { path: '/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 10, attempts: 3, intervalSeconds: 5 },
      release: { strategy: 'staged-production', promoteExactBuild: true, autoPromoteAfterChecks: true },
    },
  },
  domains: [{ hostname: 'app.example.com', environment: 'production', canonical: true, cloudflare: { zoneRef: 'config://cloudflare/example.com', mode: 'dns-only', ttl: 'auto' }, redirects: [] }],
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

export function resource(provider: ProviderName, type: string, key: string, configuration: Record<string, unknown>, ownershipFingerprint: string | null = OWNERSHIP): ObservedResource {
  return { provider, resourceType: type, providerResourceId: `id:${key}`, resourceKey: key, configuration, ownershipFingerprint, observedAt: '2026-08-04T00:00:00.000Z' };
}

/** Minimal observed state: only the Vercel project resource (legacy 'app' key). */
export function minimalObserved(applicationId = 'app', rootDirectory = '.'): ObservedApplication {
  return {
    applicationId,
    observedAt: '2026-08-04T00:00:00.000Z',
    desiredGeneration: 1,
    desiredHash: 'desired',
    observedHash: 'observed',
    resources: [resource('vercel', 'vercel.project', applicationId, { name: 'app', framework: 'nextjs', rootDirectory })],
    deployments: [],
    health: { status: 'UNKNOWN', latest: null },
  };
}

/** Fully synced observed state: every manifest dimension observed and matching. */
export function syncedObserved(rootDirectory = 'apps/web'): ObservedApplication {
  return {
    applicationId: 'app',
    observedAt: '2026-08-04T00:00:00.000Z',
    desiredGeneration: 1,
    desiredHash: 'desired',
    observedHash: 'observed',
    lifecycleState: 'active',
    resources: [
      resource('github', 'repository', 'github.repository', { provider: 'github', name: 'acme/app', productionBranch: 'main', deploymentRef: 'main' }),
      resource('github', 'repository-access', 'github.repository-access', { productionBranch: 'main', deploymentRef: 'main', requirePrivateAccessVerification: true, requireVercelGitAccess: true }),
      resource('vercel', 'project', 'vercel.project', {
        name: 'app',
        framework: 'nextjs',
        rootDirectory,
        nodeVersion: '24.x',
        installCommand: 'yarn install',
        buildCommand: 'yarn build',
        autoAssignProductionDomains: false,
        prioritizeProductionBuilds: true,
        skewProtection: false,
      }),
      resource('vercel', 'git-connection', 'vercel.git', { connected: true, productionBranch: 'main', repository: 'acme/app' }),
      resource('vercel', 'environment', 'vercel.environment.preview', desired.environments.preview as unknown as Record<string, unknown>),
      resource('vercel', 'environment', 'vercel.environment.production', desired.environments.production as unknown as Record<string, unknown>),
      resource('vercel', 'project-domain', 'vercel.domain.app.example.com', { hostname: 'app.example.com', environment: 'production', canonical: true, mode: 'dns-only', ttl: 'auto', zoneRef: 'config://cloudflare/example.com' }),
      resource('cloudflare', 'dns-record', 'cloudflare.dns.app.example.com', { zoneRef: 'config://cloudflare/example.com', mode: 'dns-only', ttl: 'auto', proxied: false }),
      resource('vercel', 'domain-verification', 'domain.verification.app.example.com', { verified: true }),
      resource('vercel', 'deployment', 'production.candidate', { state: 'READY' }),
      resource('vercel', 'health-check', 'production.health', { result: 'PASSED' }),
      resource('vercel', 'promotion', 'production.promotion', { current: true }),
      resource('vercel', 'health-check', 'production.post-health', { result: 'PASSED' }),
    ],
    deployments: [],
    health: { status: 'HEALTHY', latest: null },
  };
}
