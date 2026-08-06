import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildPlan, type DesiredApplication, type ObservedApplication, type ProviderCapabilities } from '@launchpad/core';
import { canonicalJson, SensitiveValue, sha256Hex } from '@launchpad/shared';
import { loadCatalog } from '@launchpad/catalog';
import { GitHubAdapter } from '@launchpad/provider-github';
import { VercelAdapter } from '@launchpad/provider-vercel';
import { CloudflareAdapter } from '@launchpad/provider-cloudflare';
import type { ProviderContext } from '@launchpad/provider-contract';
import { CONTRACT_CANARY_TOKEN, expectRequest, loadScenarios, recordedTransport, type RecordedRequest, type RecordedStep } from '../fixtures/recorded-transport.js';

/**
 * Capability-matrix consistency (master plan section 18): every advertised
 * field/feature must map to a real, exercised adapter method, and anything
 * the matrix does not advertise must fail closed — at the adapter and at the
 * planner boundary with real adapter capability snapshots.
 */

const ctx: ProviderContext = { correlationId: 'cap-corr', applicationId: 'app', workflowId: 'wf', actor: { kind: 'system', id: 'cap' }, dryRun: false };
const NOW = '2026-08-04T00:00:00.000Z';

function vercelAdapter(steps: RecordedStep[]): { adapter: VercelAdapter; requests: RecordedRequest[] } {
  const transport = recordedTransport(steps);
  return { adapter: new VercelAdapter({ token: CONTRACT_CANARY_TOKEN, baseUrl: 'https://api.vercel.test', fetchImpl: transport.fetchImpl }), requests: transport.requests };
}

function cloudflareAdapter(steps: RecordedStep[], resolveDns?: CloudflareAdapter['resolveDns']): { adapter: CloudflareAdapter; requests: RecordedRequest[] } {
  const transport = recordedTransport(steps);
  return { adapter: new CloudflareAdapter({ token: CONTRACT_CANARY_TOKEN, baseUrl: 'https://api.cloudflare.test', fetchImpl: transport.fetchImpl, resolveDns }), requests: transport.requests };
}

const PROJECT_FIELDS = ['project.framework', 'project.rootDirectory', 'project.nodeVersion', 'project.build.installCommand', 'project.build.buildCommand', 'project.settings.autoAssignProductionDomains'];

describe('VercelAdapter capability matrix', () => {
  it('advertises a deterministic snapshot and only the fields it can actually manage', async () => {
    const adapter = vercelAdapter([]);
    const caps = await adapter.adapter.capabilities();
    expect(caps.provider).toBe('vercel');
    expect(caps.adapterVersion).not.toBe('');
    expect(caps.snapshotHash).toBe(await sha256Hex(canonicalJson(caps.fields)));
    for (const key of PROJECT_FIELDS) {
      expect(caps.fields[key], key).toBeDefined();
    }
    expect(caps.fields['domain.hostname']?.delete).toBe(true);
  });

  it('exercises every advertised project field through observeProject and ensureProject', async () => {
    const { adapter, requests } = vercelAdapter(loadScenarios('vercel').observeProject);
    const observed = await adapter.observeProject({ projectId: 'app' }, ctx);
    expect(observed).not.toBeNull();
    expectRequest(requests, 'GET', '/v9/projects/app');
    const write = vercelAdapter(loadScenarios('vercel').projectCreate);
    const result = await write.adapter.ensureProject({ id: 'app', name: 'app', teamId: null, framework: 'nextjs', rootDirectory: '.', nodeVersion: '24.x', build: { installCommand: 'yarn install', buildCommand: 'yarn build', outputDirectory: null }, repository: 'acme/app', productionBranch: 'main', settings: { autoAssignProductionDomains: false } }, ctx);
    expect(result.resource.providerResourceId).toBe('prj_1');
    expectRequest(write.requests, 'POST', '/v10/projects');
  });

  it('exercises the domain.hostname create and delete capabilities', async () => {
    const create = vercelAdapter(loadScenarios('vercel').domain);
    await create.adapter.ensureDomain({ projectId: 'app', hostname: 'app.example.com', environment: 'production', mode: 'dns-only' }, ctx);
    expectRequest(create.requests, 'POST', '/v10/projects/app/domains');
    const remove = vercelAdapter(loadScenarios('vercel').domainRemove);
    await expect(remove.adapter.removeDomain('app', 'app.example.com', ctx)).resolves.toBeUndefined();
    expectRequest(remove.requests, 'DELETE', '/v9/projects/app/domains/app.example.com');
  });

  it('maps every advertised feature to a present, working method', async () => {
    const caps = await vercelAdapter([]).adapter.capabilities();
    const features = caps.features;
    expect(features.customEnvironment).toBe(true);
    const empty = vercelAdapter([]);
    await empty.adapter.ensureEnvironment({ projectId: 'app', environment: 'preview', branch: 'main', variables: {} }, ctx);
    expect(empty.requests).toHaveLength(0);
    const envCreate = vercelAdapter(loadScenarios('vercel').environmentCreate);
    await envCreate.adapter.ensureEnvironment({ projectId: 'app', environment: 'production', branch: 'main', variables: { DATABASE_URL: new SensitiveValue('postgres://contract-db-secret'), API_TOKEN: new SensitiveValue('contract-token-secret') } }, ctx);
    expectRequest(envCreate.requests, 'POST', '/v10/projects/app/env');

    expect(features.stagedProduction).toBe(true);
    const staged = vercelAdapter(loadScenarios('vercel').deploymentCreateStaged);
    await staged.adapter.createDeployment({ projectId: 'app', environment: 'production', repository: 'acme/app', commitSha: 'a'.repeat(40), desiredGeneration: 1, staged: true }, ctx);
    expect(expectRequest(staged.requests, 'POST', '/v13/deployments').body).toMatchObject({ target: 'staging' });

    expect(features.exactPromotion).toBe(true);
    const promote = vercelAdapter(loadScenarios('vercel').promote);
    await promote.adapter.promote({ projectId: 'app', deploymentId: 'dpl_1', expectedCommitSha: 'a'.repeat(40) }, ctx);
    expectRequest(promote.requests, 'POST', '/v10/projects/app/promote/dpl_1');

    expect(features.deploymentLogs).toBe(true);
    const logs = vercelAdapter(loadScenarios('vercel').logsArray);
    await logs.adapter.fetchDeploymentLogs({ deploymentId: 'dpl_1', maxLines: 10, maxBytes: 1000 }, ctx);
    expectRequest(logs.requests, 'GET', '/v3/deployments/dpl_1/events?limit=100&direction=forward');

    expect(features.exactCommitLookup).toBe(true);
    const lookup = vercelAdapter(loadScenarios('vercel').deploymentsList);
    await lookup.adapter.findDeploymentByCommit('app', 'a'.repeat(40), ctx);
    expectRequest(lookup.requests, 'GET', '/v7/deployments?projectId=app&limit=100');

    expect(features.domainVerification).toBe(true);
    const domainRead = vercelAdapter(loadScenarios('vercel').domainObserveVerified);
    await domainRead.adapter.getDomain('app', 'app.example.com', ctx);
    expectRequest(domainRead.requests, 'GET', '/v9/projects/app/domains/app.example.com');
    const domainVerify = vercelAdapter(loadScenarios('vercel').domainVerify);
    await domainVerify.adapter.verifyDomain('app', 'app.example.com', ctx);
    expectRequest(domainVerify.requests, 'POST', '/v9/projects/app/domains/app.example.com/verify');

    expect(features.tlsReadiness).toBe(true);
    const tls = vercelAdapter(loadScenarios('vercel').certReady);
    await tls.adapter.getDomainTls('app.example.com', ctx);
    expectRequest(tls.requests, 'GET', '/v8/certs');
  });

  it('claims domain verification and TLS readiness only with callable methods', async () => {
    const adapter = vercelAdapter([]).adapter;
    const caps = await adapter.capabilities();
    // Every advertised feature must map to a present method: the workflows
    // gate these gates on method presence (`provider.getDomain` etc.), so
    // advertising a feature without the callable method would silently skip
    // verification instead of failing closed.
    expect(caps.features.domainVerification).toBe(true);
    expect(caps.features.tlsReadiness).toBe(true);
    expect('getDomain' in adapter).toBe(true);
    expect('verifyDomain' in adapter).toBe(true);
    expect('getDomainTls' in adapter).toBe(true);
    expect('removeDomain' in adapter).toBe(true);
    expect('deleteDeployment' in adapter).toBe(true);
  });
});

describe('CloudflareAdapter capability matrix', () => {
  it('advertises and exercises both DNS fields across create, update, read, and delete', async () => {
    const caps = await cloudflareAdapter([]).adapter.capabilities();
    expect(caps.provider).toBe('cloudflare');
    for (const key of ['dns.record.content', 'dns.record.proxied']) {
      const field = caps.fields[key];
      expect(field, key).toBeDefined();
      expect(field?.read).toBe(true);
      expect(field?.create).toBe(true);
      expect(field?.update).toBe(true);
      expect(field?.delete).toBe(true);
    }
    const create = cloudflareAdapter(loadScenarios('cloudflare').recordCreate);
    await create.adapter.ensureRecord('zone-1', { hostname: 'app.example.com', type: 'CNAME', value: 'target.example', ttl: 'auto' }, 'fp-1', ctx);
    expectRequest(create.requests, 'POST', '/zones/zone-1/dns_records');
    const update = cloudflareAdapter(loadScenarios('cloudflare').recordUpdate);
    await update.adapter.ensureRecord('zone-1', { hostname: 'app.example.com', type: 'CNAME', value: 'target.example', ttl: 'auto' }, 'fp-1', ctx);
    expectRequest(update.requests, 'PUT', '/zones/zone-1/dns_records/record-1');
    const remove = cloudflareAdapter(loadScenarios('cloudflare').recordDelete);
    await remove.adapter.deleteRecord('zone-1', 'record-1', ctx, 'fp-1');
    expectRequest(remove.requests, 'DELETE', '/zones/zone-1/dns_records/record-1');
  });

  it('maps every advertised feature to a present, working method', async () => {
    const caps = await cloudflareAdapter([]).adapter.capabilities();
    expect(caps.features.authoritativeVerification).toBe(true);
    const verified = cloudflareAdapter([], async () => ['target.example']);
    await expect(verified.adapter.verifyAuthoritative('app.example.com', { hostname: 'app.example.com', type: 'CNAME', value: 'target.example', ttl: 'auto' }, ctx, { provider: 'cloudflare', zoneId: 'zone-1', name: 'example.com', nameservers: ['ns1.example.net'], status: 'active' })).resolves.toBe(true);

    expect(caps.features.proxyMode).toBe(true);
    const proxied = cloudflareAdapter(loadScenarios('cloudflare').recordProxied);
    const result = await proxied.adapter.ensureRecord('zone-1', { hostname: 'app.example.com', type: 'CNAME', value: 'target.example', ttl: 'auto', proxied: true, proxyAcknowledgment: true }, 'fp-1', ctx);
    expect(result.resource.proxied).toBe(true);

    expect(caps.features.proxyCompatibilityCheck).toBe(true);
    expect('checkProxyCompatibility' in cloudflareAdapter([]).adapter).toBe(true);
  });

  it('fails closed on writes the matrix policy does not permit', async () => {
    const { adapter } = cloudflareAdapter(loadScenarios('cloudflare').recordListEmpty);
    await expect(adapter.ensureRecord('zone-1', { hostname: 'app.example.com', type: 'CNAME', value: 'target.example', ttl: 'auto', proxied: true }, 'fp-1', ctx)).rejects.toMatchObject({ code: 'LP-DNS-PROXY-ACKNOWLEDGMENT-REQUIRED', class: 'POLICY_BLOCK', retryable: false });
    await expect(adapter.ensureRecord('zone-1', { hostname: 'app.example.com', type: 'MX', value: 'mx.example', ttl: 'auto' }, 'fp-1', ctx)).rejects.toMatchObject({ code: 'LP-DNS-REQUIRED-RECORD-INVALID', class: 'VALIDATION', retryable: false });
  });
});

describe('source providers', () => {
  it('GitHubAdapter is a source-only adapter and claims no manageability surface', async () => {
    const adapter = new GitHubAdapter({ token: CONTRACT_CANARY_TOKEN, fetchImpl: async () => new Response('{}', { status: 200 }) });
    expect('capabilities' in adapter).toBe(false);
  });
});

describe('planner boundary with real capability snapshots', () => {
  const manifest = loadCatalog([{ path: 'catalog/apps/fixture.yaml', content: readFileSync('catalog/apps/fixture.yaml', 'utf8') }]);
  const desired = manifest.applications[0];
  if (!desired) throw new Error('Fixture manifest did not load');
  const unsupportedDesired: DesiredApplication = {
    ...desired,
    vercel: {
      ...desired.vercel,
      project: {
        ...desired.vercel.project,
        build: { ...desired.vercel.project.build, developmentCommand: 'yarn dev' },
        regions: { functions: ['iad1'] },
        protection: { preview: 'public', production: 'public' },
        settings: { ...desired.vercel.project.settings, webAnalytics: true, speedInsights: true },
      },
    },
  };

  function observedWith(projectConfig: Record<string, unknown>): ObservedApplication {
    return {
      applicationId: desired.metadata.id,
      observedAt: NOW,
      desiredGeneration: 1,
      desiredHash: 'desired',
      observedHash: 'observed',
      resources: [{ provider: 'vercel', resourceType: 'vercel.project', providerResourceId: 'prj', resourceKey: 'vercel.project', configuration: projectConfig, ownershipFingerprint: 'fp', observedAt: NOW }],
      deployments: [],
      health: { status: 'UNKNOWN', latest: null },
    };
  }

  it('blocks any field the real Vercel matrix does not advertise', async () => {
    const caps: ProviderCapabilities = await vercelAdapter([]).adapter.capabilities();
    const plan = await buildPlan({ desired: unsupportedDesired, observed: observedWith({}), capabilities: caps, sourceCommit: 'a'.repeat(40), desiredGeneration: 1, now: NOW });
    expect(plan.result).toBe('BLOCKED');
    expect(plan.blockedReason).toBe('LP-UNSUPPORTED-FIELD');
    const unsupported = plan.policyResults.filter((result) => result.rule === 'capability.unsupported' && result.result === 'BLOCK');
    expect(unsupported.length).toBeGreaterThan(0);
    const messages = unsupported.map((result) => result.message).join('\n');
    // The fixture manifest sets fields outside the real matrix
    // (developmentCommand, regions.functions, protection.*, and settings
    // keys the matrix never advertises like webAnalytics/speedInsights) —
    // none may be guessed. Fields the matrix does advertise
    // (autoAssignProductionDomains, prioritizeProductionBuilds, rollingRelease,
    // skewProtection) must NOT be reported as unsupported.
    expect(messages).toContain('project.build.developmentCommand');
    expect(messages).toContain('project.regions.functions');
    expect(messages).toContain('project.protection.preview');
    expect(messages).toContain('project.settings.webAnalytics');
    expect(messages).toContain('project.settings.speedInsights');
    expect(messages).not.toContain('project.settings.prioritizeProductionBuilds');
    expect(messages).not.toContain('project.settings.rollingRelease');
    expect(messages).not.toContain('project.settings.skewProtection');
    // The plan is BLOCKED end to end: no operation on a blocked field may
    // ever be applied, because the controller refuses BLOCKED plans.
    expect(plan.blockedReason).toBe('LP-UNSUPPORTED-FIELD');
  });

  it('plans READY when the manifest stays inside the advertised matrix', async () => {
    const trimmed: DesiredApplication = {
      ...desired,
      domains: [],
      secrets: [],
      environments: {
        production: { enabled: true, health: desired.environments.production?.health ?? { path: '/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 1, attempts: 1, intervalSeconds: 0 } },
      },
      vercel: {
        ...desired.vercel,
        project: {
          ...desired.vercel.project,
          build: { ...desired.vercel.project.build, developmentCommand: null },
          deployment: { ...desired.vercel.project.deployment, prioritizeProductionBuilds: false, skewProtection: false },
          regions: { functions: [] },
          protection: {},
          settings: { autoAssignProductionDomains: false },
        },
      },
    };
    const observed = observedWith({
      name: trimmed.vercel.project.name,
      framework: trimmed.vercel.project.framework,
      rootDirectory: trimmed.vercel.project.rootDirectory,
      nodeVersion: trimmed.vercel.project.nodeVersion,
      installCommand: trimmed.vercel.project.build.installCommand,
      buildCommand: trimmed.vercel.project.build.buildCommand,
      autoAssignProductionDomains: false,
    });
    const caps: ProviderCapabilities = await vercelAdapter([]).adapter.capabilities();
    const plan = await buildPlan({ desired: trimmed, observed, capabilities: caps, sourceCommit: 'a'.repeat(40), desiredGeneration: 1, now: NOW });
    expect(plan.result).toBe('READY');
    expect(plan.policyResults.every((result) => result.result !== 'BLOCK')).toBe(true);
  });
});
