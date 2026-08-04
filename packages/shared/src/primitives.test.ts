import { describe, expect, it } from 'vitest';
import { canonicalJson, redactValue, sha256Hex, stableId, SensitiveValue, retry } from './index.js';

describe('shared primitives', () => {
  it('canonicalizes object key order and preserves array order', () => {
    expect(canonicalJson({ z: 1, a: [2, { y: true, x: null }] })).toBe('{"a":[2,{"x":null,"y":true}],"z":1}');
  });

  it('rejects unsupported canonical values', () => {
    expect(() => canonicalJson({ value: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(/finite/);
  });

  it('hashes canonical input deterministically', async () => {
    const left = await sha256Hex(canonicalJson({ a: 1, b: 2 }));
    const right = await sha256Hex(canonicalJson({ b: 2, a: 1 }));
    expect(left).toBe(right);
    expect(left).toMatch(/^[0-9a-f]{64}$/);
  });

  it('creates stable namespaced ids', () => {
    expect(stableId('operation', 'app', '123')).toBe(stableId('operation', 'app', '123'));
    expect(stableId('operation', 'app', '123')).not.toBe(stableId('operation', 'app', '124'));
  });

  it('redacts sensitive nested values and rejects accidental serialization', () => {
    const secret = new SensitiveValue('database-password');
    expect(() => JSON.stringify({ secret })).toThrow(/sensitive/i);
    expect(redactValue({ secret, safe: 'ok' })).toEqual({ secret: '[REDACTED]', safe: 'ok' });
    expect(secret.fingerprint()).toMatch(/^[0-9a-f]{16}$/);
  });

  it('retries only retryable failures and returns the successful value', async () => {
    let attempts = 0;
    const result = await retry(async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('busy'), { retryable: true });
      return 'ok';
    }, { maxAttempts: 3, baseDelayMs: 0, sleep: async () => undefined });
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });
});
