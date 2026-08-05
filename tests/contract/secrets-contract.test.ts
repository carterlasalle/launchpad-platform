import { expect, it } from 'vitest';
import { EnvironmentSecretProvider, EnvironmentTargetPolicy, TargetPolicySecretProvider, parseSecretReference } from '@launchpad/provider-secrets';
import { LaunchpadError } from '@launchpad/core';
import { SensitiveValue, scanCanary } from '@launchpad/shared';
import type { ProviderContext } from '@launchpad/provider-contract';

/**
 * Secret provider contract (the non-HTTP member of the provider matrix):
 * same error-class distinctions — not-found, authorization, unsupported,
 * validation — plus keyed fingerprints, target policies, and the guarantee
 * that resolved values can never be serialized or leaked.
 */

const ctx: ProviderContext = { correlationId: 'contract-corr', applicationId: 'app', workflowId: 'wf', actor: { kind: 'system', id: 'contract' }, dryRun: false };
const SECRET = 'lp-contract-canary-secret-5e8a2c41';
const REFERENCE = 'env://DATABASE_URL';

function platform(error: unknown): { code: string; class: string; retryable: boolean } {
  if (!(error instanceof LaunchpadError)) throw new Error(`expected a LaunchpadError, got ${String(error)}`);
  return { code: error.platform.code, class: error.platform.class, retryable: error.platform.retryable };
}

it('parses every supported reference shape into scheme, parts, and key', () => {
  expect(parseSecretReference('env://DATABASE_URL')).toEqual({ scheme: 'env', reference: 'env://DATABASE_URL', parts: ['DATABASE_URL'], key: 'DATABASE_URL' });
  expect(parseSecretReference('infisical://acme/production/secrets#API_KEY').scheme).toBe('infisical');
  expect(parseSecretReference('onepassword://vault/item/field').key).toBe('field');
  expect(parseSecretReference('encrypted-file://catalog/secrets.enc.yaml#tokentest.production.DATABASE_URL').parts).toEqual(['catalog', 'secrets.enc.yaml']);
});

it('distinguishes not-found from validation and unsupported scheme failures', async () => {
  const provider = new EnvironmentSecretProvider({});
  await expect(provider.resolve(REFERENCE, ctx)).rejects.toSatisfy((error: unknown) => {
    expect(platform(error)).toEqual({ code: 'LP-SECRET-NOT-FOUND', class: 'NOT_FOUND', retryable: false });
    return true;
  });
  await expect(provider.resolve('garbage', ctx)).rejects.toSatisfy((error: unknown) => {
    expect(platform(error)).toEqual({ code: 'LP-SECRET-REFERENCE-INVALID', class: 'VALIDATION', retryable: false });
    return true;
  });
  await expect(provider.resolve('infisical://acme/production/secrets#KEY', ctx)).rejects.toSatisfy((error: unknown) => {
    expect(platform(error)).toEqual({ code: 'LP-SECRET-UNSUPPORTED-SCHEME', class: 'UNSUPPORTED', retryable: false });
    return true;
  });
});

it('resolves values only as SensitiveValue and denies production-only secrets to preview', async () => {
  const provider = new EnvironmentSecretProvider({ DATABASE_URL: SECRET }, { policy: new EnvironmentTargetPolicy({ preview: false, staging: false }, 'Production-only.') });
  const value = await provider.resolveForTarget(REFERENCE, { environment: 'production' }, ctx);
  expect(value).toBeInstanceOf(SensitiveValue);
  expect(value.reveal()).toBe(SECRET);
  await expect(provider.resolveForTarget(REFERENCE, { environment: 'preview' }, ctx)).rejects.toSatisfy((error: unknown) => {
    expect(platform(error)).toEqual({ code: 'LP-SECRET-TARGET-DENIED', class: 'AUTHORIZATION', retryable: false });
    return true;
  });
  await expect(provider.fingerprintForTarget(REFERENCE, { environment: 'staging' }, ctx)).rejects.toMatchObject({ platform: { class: 'AUTHORIZATION' } });
});

it('produces stable keyed fingerprints that change on value or key rotation and never expose the value', async () => {
  // Same value under a rotated key: the key alone must change the fingerprint.
  const provider = new EnvironmentSecretProvider({ DATABASE_URL: SECRET, OTHER: SECRET });
  const first = await provider.fingerprint(REFERENCE, ctx);
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  expect(first).toBe(await provider.fingerprint(REFERENCE, ctx));
  expect(first).not.toBe(await provider.fingerprint('env://OTHER', ctx));
  const rotated = new EnvironmentSecretProvider({ DATABASE_URL: 'rotated-value' });
  expect(await rotated.fingerprint(REFERENCE, ctx)).not.toBe(first);
  const leaked = await scanCanary({ fingerprint: first }, [SECRET]);
  expect(leaked.leaked).toBe(false);

  // Missing references fail closed with the typed not-found error, never a fabricated fingerprint.
  await expect(provider.fingerprint('env://MISSING', ctx)).rejects.toSatisfy((error: unknown) => {
    expect(platform(error)).toEqual({ code: 'LP-SECRET-NOT-FOUND', class: 'NOT_FOUND', retryable: false });
    return true;
  });
});

it('decorates any inner provider with a target policy without weakening the plain surface', async () => {
  const inner = new EnvironmentSecretProvider({ DATABASE_URL: SECRET });
  const guarded = new TargetPolicySecretProvider(inner, new EnvironmentTargetPolicy({ preview: false }, 'No preview.'));
  expect((await guarded.resolve(REFERENCE, ctx)).reveal()).toBe(SECRET);
  expect(await guarded.exists(REFERENCE, ctx)).toBe(true);
  expect(await guarded.exists('env://MISSING', ctx)).toBe(false);
  await expect(guarded.resolveForTarget(REFERENCE, { environment: 'preview' }, ctx)).rejects.toMatchObject({ platform: { class: 'AUTHORIZATION' } });
  expect((await guarded.resolveForTarget(REFERENCE, { environment: 'production' }, ctx)).reveal()).toBe(SECRET);
});

it('never serializes resolved secrets and stays canary-clean in every observable surface', async () => {
  const provider = new EnvironmentSecretProvider({ DATABASE_URL: SECRET });
  const value = await provider.resolve(REFERENCE, ctx);
  expect(() => JSON.stringify({ value })).toThrow(/sensitive/i);
  expect(String(value)).toBe('[REDACTED]');
  const observable = { fingerprint: await provider.fingerprint(REFERENCE, ctx), value: value.redacted(), exists: await provider.exists(REFERENCE, ctx) };
  const scan = await scanCanary(observable, [SECRET]);
  expect(scan.leaked).toBe(false);
  expect(JSON.stringify(observable)).not.toContain(SECRET);
});
