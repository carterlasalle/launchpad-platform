import { expect, it } from 'vitest';
import { inspect } from 'node:util';
import { isSensitiveValue, redactValue, secureFingerprint, sha256Hex, SensitiveValue } from './index.js';

const secret = 'database-password-9f3a';

it('throws on JSON serialization without explicit redaction', () => {
  const value = new SensitiveValue(secret);
  expect(() => JSON.stringify(value)).toThrow(/sensitive/i);
  expect(() => JSON.stringify({ nested: { value } })).toThrow(/sensitive/i);
});

it('renders redacted through string coercion, template literals, and console inspection', () => {
  const value = new SensitiveValue(secret);
  expect(String(value)).toBe('[REDACTED]');
  expect(`${value}`).toBe('[REDACTED]');
  expect(Object.prototype.toString.call(value)).toBe('[object SensitiveValue]');
  const inspected = inspect(value, { depth: null });
  expect(inspected).toContain('[REDACTED]');
  expect(inspected).not.toContain(secret);
  expect(value.redacted()).toBe('[REDACTED]');
});

it('refuses non-string primitive coercion', () => {
  const value = new SensitiveValue('42');
  expect(() => value as unknown as number + 1).toThrow(/coerced/i);
  expect(Boolean(value)).toBe(true);
});

it('reveals only through the explicit escape hatch', () => {
  const value = new SensitiveValue(secret);
  expect(value.reveal()).toBe(secret);
  expect(isSensitiveValue(value)).toBe(true);
  expect(isSensitiveValue({})).toBe(false);
});

it('produces stable keyed fingerprints bound to the key', async () => {
  const value = new SensitiveValue(secret);
  const first = await value.keyedFingerprint('env://DATABASE_URL');
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  expect(first).toBe(await value.keyedFingerprint('env://DATABASE_URL'));
  expect(first).not.toBe(await value.keyedFingerprint('env://OTHER'));
  expect(first).not.toBe(await new SensitiveValue('different-value').keyedFingerprint('env://DATABASE_URL'));
  expect(first).not.toContain(secret);
});

it('keeps the legacy non-keyed fingerprint stable', () => {
  const value = new SensitiveValue(secret);
  expect(value.fingerprint()).toMatch(/^[0-9a-f]{16}$/);
  expect(value.fingerprint()).toBe(new SensitiveValue(secret).fingerprint());
  expect(value.fingerprint()).not.toBe(new SensitiveValue('other').fingerprint());
});

it('never uses the non-keyed fingerprint for security-relevant per-reference equality', async () => {
  // The legacy fingerprint is reference-blind: the same value under two different
  // references fingerprints identically, so it cannot serve as a security-relevant
  // equality marker for secret material bound to distinct references. Only the
  // keyed variant distinguishes bindings.
  const referenceA = 'infisical://acme/production/secrets#DATABASE_URL';
  const referenceB = 'env://DATABASE_URL';
  const value = new SensitiveValue(secret);
  expect(value.fingerprint()).toBe(new SensitiveValue(secret).fingerprint()); // same value, any binding
  expect(await value.keyedFingerprint(referenceA)).not.toBe(await value.keyedFingerprint(referenceB));
  expect(value.fingerprint()).not.toBe(await value.keyedFingerprint(referenceA));
});

it('produces keyed fingerprints that are stable cross-process equality markers', async () => {
  // Persisted equality markers (for example D1 value_fingerprint rows) must be
  // reproducible on any later run: the keyed fingerprint is a deterministic SHA-256
  // over `key\u0000value`, so the persisted key makes the marker stable across
  // processes. This is the same construction the canary scanner treats as an
  // expected representation of a secret.
  const reference = 'infisical://acme/production/secrets#DATABASE_URL';
  const value = new SensitiveValue(secret);
  const marker = await value.keyedFingerprint(reference);
  const separator = '\u0000';
  expect(marker).toBe(await sha256Hex(`${reference}${separator}${secret}`));
  expect(marker).toBe(await new SensitiveValue(secret).keyedFingerprint(reference));
  expect(marker).not.toBe(await new SensitiveValue(secret).keyedFingerprint(`${reference}#v2`));
  expect(marker).not.toContain(secret);
});

it('keeps secureFingerprint deterministic but reference-blind for keyless verification', async () => {
  const first = await secureFingerprint(new SensitiveValue(secret));
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  expect(first).toBe(await secureFingerprint(new SensitiveValue(secret)));
  expect(first).toBe(await sha256Hex(secret));
  // Reference-blind: the same value in two bindings fingerprints identically, which
  // is why keyedFingerprint is preferred whenever a stable key exists.
  expect(first).not.toBe(await new SensitiveValue(secret).keyedFingerprint('env://DATABASE_URL'));
  expect(first).not.toContain(secret);
});

it('redacts nested values, arrays, and cyclic structures without leaking', () => {
  const value = new SensitiveValue(secret);
  const cyclic: Record<string, unknown> = { safe: 'ok', list: [value, { deep: value }] };
  cyclic.self = cyclic;
  const redacted = redactValue(cyclic) as Record<string, unknown>;
  expect(JSON.stringify(redacted)).not.toContain(secret);
  expect(redacted.list).toEqual(['[REDACTED]', { deep: '[REDACTED]' }]);
  expect(redacted.self).toBe('[Circular]');
});
