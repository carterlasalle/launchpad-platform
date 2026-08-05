import { describe, expect, it } from 'vitest';
import { FakeProvider } from './index.js';
import type { ProviderContext, ProjectSpec } from '@launchpad/provider-contract';

const context: ProviderContext = {
  correlationId: 'corr-test',
  applicationId: 'fixture-app',
  workflowId: 'workflow-test',
  actor: { kind: 'system', id: 'test' },
  dryRun: false,
};

const project: ProjectSpec = {
  id: 'fixture-app',
  name: 'fixture-app',
  teamId: 'team-test',
  framework: 'nextjs',
  rootDirectory: '.',
  nodeVersion: '24.x',
  build: { installCommand: 'yarn install --immutable', buildCommand: 'yarn build', outputDirectory: null },
  repository: 'example/fixture',
  productionBranch: 'main',
  settings: { autoAssignProductionDomains: false },
};

describe('fake provider contract', () => {
  it('returns capabilities and applies idempotent project mutations', async () => {
    const provider = new FakeProvider();
    const capabilities = await provider.capabilities();
    expect(capabilities.provider).toBe('fake');
    expect(capabilities.fields['project.rootDirectory']?.requiresRedeploy).toBe(true);

    const first = await provider.ensureProject(project, context);
    const second = await provider.ensureProject(project, context);
    expect(first.resource.providerResourceId).toBe(second.resource.providerResourceId);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
  });

  it('simulates drift and provider failures without leaking state', async () => {
    const provider = new FakeProvider();
    await provider.ensureProject(project, context);
    provider.mutateProject('fixture-app', { rootDirectory: 'apps/web' });
    const observed = await provider.observeProject({ projectId: 'fixture-app' }, context);
    expect(observed?.configuration.rootDirectory).toBe('apps/web');

    provider.failNext('observeProject', { code: 'LP-FAKE-TIMEOUT', retryable: true });
    await expect(provider.observeProject({ projectId: 'fixture-app' }, context)).rejects.toMatchObject({ code: 'LP-FAKE-TIMEOUT', retryable: true });
  });

  it('creates staged deployments and promotes or rolls back exact records', async () => {
    const provider = new FakeProvider();
    await provider.ensureProject(project, context);
    const deployment = await provider.createDeployment({ projectId: 'fixture-app', environment: 'production', repository: 'example/fixture', commitSha: 'a'.repeat(40), desiredGeneration: 1, staged: true }, context);
    expect(deployment.state).toBe('STAGED');
    const promoted = await provider.promote({ projectId: 'fixture-app', deploymentId: deployment.id, expectedCommitSha: 'a'.repeat(40) }, context);
    expect(promoted.deployment.state).toBe('CURRENT');
    const rolledBack = await provider.rollback({ projectId: 'fixture-app', deploymentId: deployment.id, previousKnownGoodId: deployment.id }, context);
    expect(rolledBack.deploymentId).toBe(deployment.id);
  });

  it('maps DNS mode and acknowledgment into required DNS records like the Vercel adapter', async () => {
    const provider = new FakeProvider();
    const base = { projectId: 'fixture-app', hostname: 'app.example.com', environment: 'production' as const };
    const acknowledged = await provider.requiredDnsRecords({ ...base, mode: 'proxied', proxyAcknowledgment: true }, context);
    expect(acknowledged[0]).toMatchObject({ proxied: true, proxyAcknowledgment: true });
    const [dnsOnlyRecord] = await provider.requiredDnsRecords({ ...base, mode: 'dns-only' }, context);
    expect(dnsOnlyRecord).toMatchObject({ proxied: false });
    expect(dnsOnlyRecord?.proxyAcknowledgment).toBeUndefined();
    const [unacknowledgedRecord] = await provider.requiredDnsRecords({ ...base, mode: 'proxied' }, context);
    expect(unacknowledgedRecord).toMatchObject({ proxied: false });
    expect(unacknowledgedRecord?.proxyAcknowledgment).toBeUndefined();
  });
});
