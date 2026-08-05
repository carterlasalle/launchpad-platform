import { describe, expect, it } from 'vitest';
import { stableId } from '@launchpad/shared';
import { buildPlan, type DesiredApplication, type ObservedApplication, type PlatformPlan, type ProviderCapabilities } from './index.js';
import { capabilities, desired, minimalObserved, resource, syncedObserved } from './fixtures.js';

const NOW = '2026-08-04T00:00:00.000Z';

function build(input: Partial<Parameters<typeof buildPlan>[0]>): Promise<PlatformPlan> {
  return buildPlan({ desired, observed: minimalObserved(), capabilities, sourceCommit: 'a'.repeat(40), desiredGeneration: 1, now: NOW, ...input });
}

describe('planner', () => {
  it('emits explicit NO_CHANGE for every dimension of a fully synced manifest', async () => {
    const plan = await build({ observed: syncedObserved() });
    expect(plan.result).toBe('READY');
    expect(plan.operations.length).toBeGreaterThan(10);
    expect(plan.operations.every((operation) => operation.action === 'NO_CHANGE')).toBe(true);
    expect(plan.layers).toBeDefined();
    expect((plan.layers as string[][]).flat().length).toBeGreaterThan(10);
  });

  it('classifies a root-directory change with downstream redeployments', async () => {
    const plan = await build({ observed: minimalObserved('app', '.') });
    expect(plan.operations.some((operation) => operation.action === 'UPDATE_IN_PLACE' && operation.resourceKey === 'vercel.project')).toBe(true);
    expect(plan.operations.some((operation) => operation.action === 'REDEPLOY_REQUIRED' && operation.resourceKey === 'production.candidate')).toBe(true);
    expect(plan.downstreamEffects.some((effect) => effect.resourceKey === 'production.candidate' && effect.action === 'REDEPLOY_REQUIRED')).toBe(true);
    expect(plan.result).toBe('READY');
  });

  it('scopes operation ids and idempotency keys per application', async () => {
    const other: DesiredApplication = { ...desired, metadata: { ...desired.metadata, id: 'other' } };
    const planApp = await build({});
    const planOther = await build({ desired: other, observed: minimalObserved('other') });
    const appOp = planApp.operations.find((operation) => operation.resourceKey === 'vercel.project') as NonNullable<PlatformPlan['operations'][number]>;
    const otherOp = planOther.operations.find((operation) => operation.resourceKey === 'vercel.project') as NonNullable<PlatformPlan['operations'][number]>;
    expect(appOp.id).not.toBe(otherOp.id);
    expect(appOp.idempotencyKey).not.toBe(otherOp.idempotencyKey);
    const repeat = await build({});
    const repeatOp = repeat.operations.find((operation) => operation.resourceKey === 'vercel.project') as NonNullable<PlatformPlan['operations'][number]>;
    expect(repeatOp.id).toBe(appOp.id);
    expect(repeatOp.idempotencyKey).toBe(appOp.idempotencyKey);
  });

  it('blocks destructive deletion plans unless the deletion gate passes', async () => {
    const deletion: DesiredApplication = {
      ...desired,
      lifecycle: {
        ...desired.lifecycle,
        state: 'approved-for-deletion',
        deletionProtection: false,
        decommission: { ...desired.lifecycle.decommission, approvalToken: 'delete-token', deleteAfter: '2026-08-01T00:00:00.000Z' },
      },
    };
    const plan = await build({ desired: deletion });
    expect(plan.result).toBe('DESTRUCTIVE');
    expect(plan.blockedReason).toBe('BLOCKED_DESTRUCTIVE_CHANGE');
    expect(plan.operations.filter((operation) => operation.action === 'DESTROY').length).toBeGreaterThan(0);
    expect(plan.policyResults.some((result) => result.rule === 'destructiveChanges.allowInNormalApply' && result.result === 'BLOCK')).toBe(true);

    const premature: DesiredApplication = { ...deletion, lifecycle: { ...deletion.lifecycle, decommission: { ...deletion.lifecycle.decommission, approvalToken: null } } };
    const blocked = await build({ desired: premature });
    expect(blocked.result).toBe('BLOCKED');
    expect(blocked.blockedReason).toBe('LP-DELETION-TOKEN-MISSING');
    expect(blocked.operations.some((operation) => operation.action === 'DESTROY')).toBe(false);
    expect(blocked.policyResults.some((result) => result.rule === 'lifecycle.deletionGate' && result.result === 'BLOCK')).toBe(true);

    const cooling: DesiredApplication = { ...deletion, lifecycle: { ...deletion.lifecycle, decommission: { ...deletion.lifecycle.decommission, deleteAfter: '2026-08-10T00:00:00.000Z' } } };
    const coolingOff = await build({ desired: cooling });
    expect(coolingOff.result).toBe('BLOCKED');
    expect(coolingOff.blockedReason).toBe('LP-DELETION-COOLING-OFF');
  });

  it('blocks with BLOCKED_MISSING_MANIFEST when the manifest is absent', async () => {
    const plan = await build({ desired: null });
    expect(plan.result).toBe('BLOCKED');
    expect(plan.blockedReason).toBe('BLOCKED_MISSING_MANIFEST');
    expect(plan.operations.some((operation) => operation.resourceKey === 'application.manifest' && operation.action === 'BLOCKED')).toBe(true);
    expect(plan.policyResults.some((result) => result.rule === 'lifecycle.missingManifest' && result.result === 'BLOCK')).toBe(true);
    expect(plan.operations.some((operation) => operation.action === 'DESTROY')).toBe(false);
  });

  it('blocks unsupported fields instead of guessing writes', async () => {
    const limited: ProviderCapabilities = {
      ...capabilities,
      fields: Object.fromEntries(Object.entries(capabilities.fields).filter(([key]) => key !== 'project.build.installCommand')),
    };
    const plan = await build({ capabilities: limited });
    expect(plan.result).toBe('BLOCKED');
    expect(plan.blockedReason).toBe('LP-UNSUPPORTED-FIELD');
    expect(plan.policyResults.some((result) => result.rule === 'capability.unsupported' && result.result === 'BLOCK' && result.message.includes('installCommand'))).toBe(true);
  });

  it('blocks ambiguous ownership and missing ownership evidence', async () => {
    const mismatched = await build({ ownership: { app: 'recorded-elsewhere' } });
    expect(mismatched.result).toBe('BLOCKED');
    expect(mismatched.blockedReason).toBe('LP-OWNERSHIP-AMBIGUOUS');
    expect(mismatched.policyResults.some((result) => result.rule === 'ownership.ambiguous' && result.result === 'BLOCK')).toBe(true);

    const noEvidence: ObservedApplication = {
      ...minimalObserved(),
      resources: [resource('vercel', 'vercel.project', 'app', { name: 'app', framework: 'nextjs', rootDirectory: '.' }, null)],
    };
    const plan = await build({ observed: noEvidence });
    expect(plan.result).toBe('BLOCKED');
    expect(plan.blockedReason).toBe('LP-OWNERSHIP-AMBIGUOUS');
  });

  it('keeps the fingerprint stable for equivalent inputs and sensitive to every manifest dimension', async () => {
    const first = await build({});
    const same = await build({
      now: '2026-08-05T00:00:00.000Z',
      observed: { ...minimalObserved(), observedAt: '2026-08-05T00:00:00.000Z', resources: [...minimalObserved().resources].reverse() },
    });
    expect(first.fingerprint).toBe(same.fingerprint);
    expect(first.createdAt).not.toBe(same.createdAt);

    expect((await build({ sourceCommit: 'b'.repeat(40) })).fingerprint).not.toBe(first.fingerprint);
    expect((await build({ capabilities: { ...capabilities, adapterVersion: 'testkit-v2' } })).fingerprint).not.toBe(first.fingerprint);
    expect((await build({ ownership: { 'vercel.project': 'x' } })).fingerprint).not.toBe(first.fingerprint);
    expect((await build({ desiredGeneration: 9 })).fingerprint).not.toBe(first.fingerprint);
    const changedFramework: DesiredApplication = { ...desired, vercel: { ...desired.vercel, project: { ...desired.vercel.project, framework: 'remix' } } };
    expect((await build({ desired: changedFramework })).fingerprint).not.toBe(first.fingerprint);
    expect((await build({ observed: minimalObserved('app', 'apps/web') })).fingerprint).not.toBe(first.fingerprint);
    expect((await build({ mode: 'reconcile' })).fingerprint).not.toBe(first.fingerprint);
  });

  it('classifies drift as RECONCILE with a stable drift fingerprint in reconcile mode', async () => {
    const plan = await build({ mode: 'reconcile' });
    expect(plan.operations.some((operation) => operation.action === 'RECONCILE' && operation.resourceKey === 'vercel.project')).toBe(true);
    expect(plan.drift?.detected).toBe(true);
    expect(plan.drift?.records.some((record) => record.resourceKey === 'vercel.project')).toBe(true);

    const reordered = await build({
      mode: 'reconcile',
      observed: { ...minimalObserved(), resources: [...minimalObserved().resources].reverse() },
    });
    expect(reordered.drift?.fingerprint).toBe(plan.drift?.fingerprint);

    const synced = await build({ mode: 'reconcile', observed: syncedObserved() });
    expect(synced.drift?.detected).toBe(false);
    expect(synced.operations.every((operation) => operation.action === 'NO_CHANGE')).toBe(true);
  });

  it('disables promotion without destroying anything while decommissioning', async () => {
    const decommissioning: DesiredApplication = { ...desired, lifecycle: { ...desired.lifecycle, state: 'decommissioning' } };
    const plan = await build({ desired: decommissioning });
    expect(plan.result).toBe('READY');
    expect(plan.operations.some((operation) => operation.action === 'DECOMMISSION' && operation.resourceKey === 'production.promotion')).toBe(true);
    expect(plan.operations.some((operation) => operation.action === 'DESTROY')).toBe(false);
    expect(plan.policyResults.some((result) => result.rule === 'lifecycle.decommissioning' && result.result === 'WARN')).toBe(true);
  });

  it('keeps variable and secret values out of plans while tracking keyed fingerprints', async () => {
    const withSecret: DesiredApplication = {
      ...desired,
      environments: {
        ...desired.environments,
        preview: { ...desired.environments.preview!, variables: { API_KEY: { secretRef: 'infisical://project/preview#API_KEY', sensitive: true } } },
      },
    };
    const plan = await build({ desired: withSecret });
    const createOp = plan.operations.find((operation) => operation.resourceKey === 'vercel.variable.preview.API_KEY') as NonNullable<PlatformPlan['operations'][number]>;
    expect(createOp.action).toBe('CREATE');
    const after = createOp.after as { fingerprint: string; sensitive: boolean };
    expect(after.fingerprint).toBe(stableId('secret-ref-fingerprint', 'preview', 'API_KEY', 'infisical://project/preview#API_KEY'));
    expect(JSON.stringify(plan)).not.toContain('infisical://');

    const rotated: ObservedApplication = {
      ...syncedObserved(),
      resources: [
        ...syncedObserved().resources,
        resource('vercel', 'environment-variable', 'vercel.variable.preview.API_KEY', { fingerprint: stableId('secret-ref-fingerprint', 'preview', 'API_KEY', 'infisical://old#API_KEY'), sensitive: true }),
      ],
    };
    const rotatedPlan = await build({ desired: withSecret, observed: rotated });
    const updateOp = rotatedPlan.operations.find((operation) => operation.resourceKey === 'vercel.variable.preview.API_KEY') as NonNullable<PlatformPlan['operations'][number]>;
    expect(updateOp.action).toBe('UPDATE_IN_PLACE');
    expect(rotatedPlan.downstreamEffects.some((effect) => effect.action === 'REDEPLOY_REQUIRED' && effect.reason.includes('previous deployments retain the old value'))).toBe(true);
  });

  it('compares declared settings safely when the observed project omits them', async () => {
    const withSettings: DesiredApplication = {
      ...desired,
      vercel: { ...desired.vercel, project: { ...desired.vercel.project, settings: { autoAssignProductionDomains: false } } },
    };
    const plan = await build({ desired: withSettings, observed: minimalObserved() });
    const settingsOp = plan.operations.find((operation) => operation.resourceKey === 'vercel.settings') as NonNullable<PlatformPlan['operations'][number]>;
    expect(settingsOp.action).toBe('UPDATE_IN_PLACE');
    expect(settingsOp.before).toEqual({ autoAssignProductionDomains: null });
    expect(settingsOp.after).toEqual({ autoAssignProductionDomains: false });
    expect(plan.result).toBe('READY');
  });

  it('plans TLS readiness only when required by the health policy', async () => {
    const withTls: DesiredApplication = {
      ...desired,
      environments: {
        ...desired.environments,
        production: { ...desired.environments.production!, health: { ...desired.environments.production!.health, tls: { required: true, minimumDaysRemaining: 30 } } },
      },
    };
    const tlsKey = 'domain.tls.app.example.com';
    const productionEnv = { ...withTls.environments.production! } as unknown as Record<string, unknown>;
    const withTlsObserved = (tlsConfiguration: Record<string, unknown>): ObservedApplication => {
      const synced = syncedObserved();
      const resources = synced.resources.map((observed) => observed.resourceKey === 'vercel.environment.production' ? resource('vercel', 'environment', 'vercel.environment.production', productionEnv) : observed);
      resources.push(resource('vercel', 'domain-tls', tlsKey, tlsConfiguration));
      return { ...synced, resources };
    };

    const pending = await build({ desired: withTls, observed: withTlsObserved({ valid: false, daysRemaining: 5 }) });
    expect(pending.operations.some((operation) => operation.resourceKey === tlsKey && operation.action === 'UPDATE_IN_PLACE')).toBe(true);

    const healthy = await build({ desired: withTls, observed: withTlsObserved({ valid: true, daysRemaining: 45 }) });
    expect(healthy.operations.some((operation) => operation.resourceKey === tlsKey && operation.action === 'NO_CHANGE')).toBe(true);
    expect(healthy.result).toBe('READY');

    const withoutTls = await build({ observed: syncedObserved() });
    expect(withoutTls.operations.some((operation) => operation.resourceKey === tlsKey)).toBe(false);
  });

  it('surfaces untracked observed resources as warnings without operations', async () => {
    const untracked: ObservedApplication = {
      ...syncedObserved(),
      resources: [...syncedObserved().resources, resource('cloudflare', 'dns-record', 'cloudflare.dns.unknown.example.com', { zoneRef: 'config://cloudflare/example.com', mode: 'dns-only', ttl: 'auto', proxied: false })],
    };
    const plan = await build({ observed: untracked });
    expect(plan.result).toBe('READY');
    expect(plan.downstreamEffects.some((effect) => effect.resourceKey === 'cloudflare.dns.unknown.example.com' && effect.action === 'UNTRACKED' && effect.severity === 'WARNING')).toBe(true);
    expect(plan.operations.some((operation) => operation.resourceKey === 'cloudflare.dns.unknown.example.com')).toBe(false);
  });
});
