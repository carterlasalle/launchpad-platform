import { expect, it } from 'vitest';
import { EnvironmentSecretProvider, EnvironmentTargetPolicy, TargetPolicySecretProvider, isSecretReference, parseSecretReference, productionOnlyTargetPolicy } from './index.js';
import { LaunchpadError } from '@launchpad/core';
import type { ProviderContext } from '@launchpad/provider-contract';
import { SensitiveValue, scanCanary } from '@launchpad/shared';

const ctx: ProviderContext = { correlationId: 'corr', applicationId: 'app', workflowId: 'wf', actor: { kind: 'system', id: 'test' }, dryRun: false };
const secret = 'postgres://secret';
const reference = 'env://DATABASE_URL';

it('parses and validates all supported reference formats', () => {
  const infisical = parseSecretReference('infisical://acme/production/secrets#DATABASE_URL');
  expect(infisical).toEqual({ scheme: 'infisical', reference: 'infisical://acme/production/secrets#DATABASE_URL', parts: ['acme', 'production', 'secrets'], key: 'DATABASE_URL' });

  const onepassword = parseSecretReference('onepassword://vault/item/field');
  expect(onepassword).toEqual({ scheme: 'onepassword', reference: 'onepassword://vault/item/field', parts: ['vault', 'item', 'field'], key: 'field' });

  const encryptedFile = parseSecretReference('encrypted-file://catalog/secrets.enc.yaml#tokentest.production.DATABASE_URL');
  expect(encryptedFile.scheme).toBe('encrypted-file');
  expect(encryptedFile.parts).toEqual(['catalog', 'secrets.enc.yaml']);
  expect(encryptedFile.key).toBe('tokentest.production.DATABASE_URL');

  expect(parseSecretReference('env://DATABASE_URL').key).toBe('DATABASE_URL');
});

it('rejects invalid reference syntax', () => {
  for (const invalid of ['http://example.com/secret', 'infisical://missing-key', 'onepassword://only-two', 'env://', 'encrypted-file://no-key#', '']) {
    expect(isSecretReference(invalid)).toBe(false);
    expect(() => parseSecretReference(invalid)).toThrow(LaunchpadError);
  }
  expect(isSecretReference(42)).toBe(false);
});

it('checks existence and resolves values wrapped in SensitiveValue', async () => {
  const provider = new EnvironmentSecretProvider({ DATABASE_URL: secret });
  expect(await provider.exists(reference, ctx)).toBe(true);
  expect(await provider.exists('env://MISSING', ctx)).toBe(false);

  const value = await provider.resolve(reference, ctx);
  expect(value).toBeInstanceOf(SensitiveValue);
  expect(value.reveal()).toBe(secret);
  await expect(provider.resolve('env://MISSING', ctx)).rejects.toMatchObject({ platform: { code: 'LP-SECRET-NOT-FOUND', class: 'NOT_FOUND' } });
});

it('rejects unsupported schemes and malformed references with typed errors', async () => {
  const provider = new EnvironmentSecretProvider({});
  await expect(provider.resolve('infisical://acme/production/secrets#KEY', ctx)).rejects.toMatchObject({ platform: { code: 'LP-SECRET-UNSUPPORTED-SCHEME', class: 'UNSUPPORTED' } });
  await expect(provider.resolve('garbage', ctx)).rejects.toMatchObject({ platform: { code: 'LP-SECRET-REFERENCE-INVALID', class: 'VALIDATION' } });
});

it('produces keyed fingerprints that are stable per reference and never expose the value', async () => {
  // `env://OTHER` holds the same value under a rotated key: the fingerprint must
  // change on key rotation alone, not only when the value changes.
  const provider = new EnvironmentSecretProvider({ DATABASE_URL: secret, OTHER: secret });
  const first = await provider.fingerprint(reference, ctx);
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  expect(first).toBe(await provider.fingerprint(reference, ctx));
  expect(first).not.toBe(await provider.fingerprint('env://OTHER', ctx));
  expect(first).not.toContain(secret);

  const rotated = new EnvironmentSecretProvider({ DATABASE_URL: 'postgres://rotated' });
  expect(await rotated.fingerprint(reference, ctx)).not.toBe(first);

  // Missing references fail closed: no fingerprint is fabricated for unconfigured keys.
  await expect(provider.fingerprint('env://MISSING', ctx)).rejects.toMatchObject({ platform: { code: 'LP-SECRET-NOT-FOUND', class: 'NOT_FOUND' } });
});

it('enforces the target policy on the target-aware surface', async () => {
  const provider = new EnvironmentSecretProvider({ DATABASE_URL: secret }, { policy: productionOnlyTargetPolicy });

  await provider.assertTargetPermitted(reference, { environment: 'production' }, ctx);
  await expect(provider.assertTargetPermitted(reference, { environment: 'preview' }, ctx)).rejects.toMatchObject({ platform: { code: 'LP-SECRET-TARGET-DENIED', class: 'AUTHORIZATION' } });

  const production = await provider.resolveForTarget(reference, { environment: 'production' }, ctx);
  expect(production.reveal()).toBe(secret);
  await expect(provider.resolveForTarget(reference, { environment: 'preview' }, ctx)).rejects.toMatchObject({ platform: { code: 'LP-SECRET-TARGET-DENIED' } });
  await expect(provider.fingerprintForTarget(reference, { environment: 'staging' }, ctx)).rejects.toMatchObject({ platform: { code: 'LP-SECRET-TARGET-DENIED' } });
  expect(await provider.fingerprintForTarget(reference, { environment: 'production' }, ctx)).toMatch(/^[0-9a-f]{64}$/);
});

it('decorates any provider with a target policy', async () => {
  const inner = new EnvironmentSecretProvider({ DATABASE_URL: secret });
  const guarded = new TargetPolicySecretProvider(inner, new EnvironmentTargetPolicy({ preview: false }, 'Preview cannot receive this secret.'));

  expect(await guarded.resolve(reference, ctx)).toBeInstanceOf(SensitiveValue);
  expect(await guarded.exists(reference, ctx)).toBe(true);
  expect(await guarded.exists('env://MISSING', ctx)).toBe(false);

  await expect(guarded.resolveForTarget(reference, { environment: 'preview' }, ctx)).rejects.toMatchObject({ platform: { code: 'LP-SECRET-TARGET-DENIED' } });
  const value = await guarded.resolveForTarget(reference, { environment: 'production' }, ctx);
  expect(value.reveal()).toBe(secret);
  expect(await guarded.fingerprintForTarget(reference, { environment: 'production' }, ctx)).toBe(await inner.fingerprint(reference, ctx));
});

it('never serializes resolved secrets or leaks them into scans', async () => {
  const provider = new EnvironmentSecretProvider({ DATABASE_URL: secret }, { policy: productionOnlyTargetPolicy });
  const value = await provider.resolveForTarget(reference, { environment: 'production' }, ctx);
  expect(() => JSON.stringify({ value })).toThrow(/sensitive/i);

  const observable = { fingerprint: await provider.fingerprint(reference, ctx), value: value.redacted() };
  const scan = await scanCanary(observable, [secret], { fingerprintKeys: [reference] });
  expect(scan.leaked).toBe(false);
});
