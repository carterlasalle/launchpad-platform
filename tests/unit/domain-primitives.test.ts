import { describe, expect, it } from 'vitest';
import { canonicalJson, idempotencyKey, isRetryableError, retry, sha256Hex, stableId } from '@launchpad/shared';
import { redactDesired, redactEnvironmentSpec, secretBindingFingerprint, variableFingerprint } from '@launchpad/core';
import type { DesiredApplication, EnvironmentSpec } from '@launchpad/core';

it('resolves workspace package exports during tests', () => {
  expect(canonicalJson({ launchpad: true })).toBe('{"launchpad":true}');
});

describe('stableId', () => {
  it('is deterministic across processes (known vectors) with a stable shape', () => {
    expect(stableId('plan', 'app-demo', 'plan-fingerprint-1')).toBe('2c1a3408e6655a31');
    expect(stableId('operation', 'app', 'vercel.project', 'CREATE')).toBe('6eaaab6363fee89b');
    expect(stableId('plan', 'app-demo', 'plan-fingerprint-1')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('separates namespaces and parts so distinct identities never collide', () => {
    expect(stableId('plan', 'app')).not.toBe(stableId('plan-review', 'app'));
    expect(stableId('operation', 'app', 'x')).not.toBe(stableId('operation', 'app', 'y'));
    expect(stableId('operation', 'app', 'x')).toBe(stableId('operation', 'app', 'x'));
  });

  it('documents the colon-joined boundary: parts are joined, not escaped', () => {
    expect(stableId('a', 'b:c')).toBe(stableId('a', 'b', 'c'));
  });
});

describe('idempotencyKey', () => {
  it('is a deterministic, operation-scoped stableId (known vector)', () => {
    expect(idempotencyKey('apply', 'app', 'a'.repeat(40), '1')).toBe('b51b42c079872850');
    expect(idempotencyKey('apply', 'app', 'a'.repeat(40), '1')).toBe(idempotencyKey('apply', 'app', 'a'.repeat(40), '1'));
    expect(idempotencyKey('ownership', 'app', 'app.example.com')).toBe('46461e3969dacafe');
  });

  it('separates operations and input parts so replays reuse exactly one key', () => {
    expect(idempotencyKey('apply', 'app', 'sha', '1')).not.toBe(idempotencyKey('reconcile', 'app', 'sha', '1'));
    expect(idempotencyKey('apply', 'app', 'sha', '1')).not.toBe(idempotencyKey('apply', 'app', 'sha', '2'));
    expect(idempotencyKey('apply', 'app', 'sha', '1')).not.toBe(idempotencyKey('apply', 'app', 'sha', '1', 'extra'));
  });
});

describe('sha256Hex', () => {
  it('matches known SHA-256 vectors and accepts Uint8Array input', async () => {
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256Hex('abc')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('canonicalJson', () => {
  it('serializes dates as ISO-8601 and escapes JSON-sensitive keys deterministically', () => {
    expect(canonicalJson({ when: new Date('2026-08-04T00:00:00.000Z') })).toBe('{"when":"2026-08-04T00:00:00.000Z"}');
    expect(canonicalJson({ 'a"b': 1, 'c\\d': 2 })).toBe('{"a\\"b":1,"c\\\\d":2}');
  });

  it('rejects values that cannot be persisted or fingerprinted', () => {
    expect(() => canonicalJson({ big: 1n })).toThrow(/bigint/);
    expect(() => canonicalJson({ fn: () => undefined })).toThrow(/not serializable/);
    expect(() => canonicalJson(Symbol('x'))).toThrow(/not serializable/);
    expect(() => canonicalJson({ invalid: new Date('nope') })).toThrow(/invalid date/);
  });

  it('preserves array order and sorts object keys deterministically', () => {
    expect(canonicalJson({ b: [1, 2], a: { y: 1, x: 2 } })).toBe('{"a":{"x":2,"y":1},"b":[1,2]}');
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
    expect(canonicalJson({ z: 1, a: 2 })).toBe(canonicalJson({ a: 2, z: 1 }));
  });
});

describe('retry policy', () => {
  it('recognizes only explicit retryable markers', () => {
    expect(isRetryableError({ retryable: true })).toBe(true);
    expect(isRetryableError({ retryable: false })).toBe(false);
    expect(isRetryableError(new Error('nope'))).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError('retryable')).toBe(false);
  });

  it('rethrows non-retryable failures without further attempts', async () => {
    let attempts = 0;
    await expect(
      retry(async () => {
        attempts += 1;
        throw new Error('hard failure');
      }, { maxAttempts: 3, baseDelayMs: 0, sleep: async () => undefined }),
    ).rejects.toThrow('hard failure');
    expect(attempts).toBe(1);
  });

  it('validates maxAttempts and bounds exponential backoff', async () => {
    await expect(retry(async () => 'x', { maxAttempts: 0, baseDelayMs: 1 })).rejects.toThrow(/maxAttempts/);
    const sleeps: number[] = [];
    let attempts = 0;
    const result = await retry(
      async () => {
        attempts += 1;
        if (attempts < 4) throw Object.assign(new Error('busy'), { retryable: true });
        return 'ok';
      },
      { maxAttempts: 4, baseDelayMs: 8, maxDelayMs: 10, sleep: async (delayMs) => { sleeps.push(delayMs); } },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(4);
    expect(sleeps).toEqual([8, 10, 10]); // 8 * 2^0, then capped at maxDelayMs
  });
});

describe('keyed secret fingerprints and manifest redaction (packages/core)', () => {
  const REFERENCE = 'infisical://acme/production/secrets#API_KEY';
  const environment: EnvironmentSpec = {
    enabled: true,
    strategy: 'native-preview',
    branch: 'main',
    variables: {
      PUBLIC_URL: 'https://example.com',
      API_KEY: { secretRef: REFERENCE, sensitive: true },
    },
    health: { path: '/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 10, attempts: 1, intervalSeconds: 0 },
  };

  it('keys variable fingerprints by environment, name, and value', () => {
    expect(variableFingerprint('production', 'API_KEY', 'abc123')).toBe('152871cee3ca5423');
    expect(variableFingerprint('production', 'API_KEY', 'abc123')).toBe(variableFingerprint('production', 'API_KEY', 'abc123'));
    expect(variableFingerprint('production', 'API_KEY', 'abc123')).not.toBe(variableFingerprint('staging', 'API_KEY', 'abc123'));
    expect(variableFingerprint('production', 'API_KEY', 'abc123')).not.toBe(variableFingerprint('production', 'OTHER', 'abc123'));
    expect(variableFingerprint('production', 'API_KEY', 'abc123')).not.toBe(variableFingerprint('production', 'API_KEY', 'abc124'));
    expect(variableFingerprint('production', 'API_KEY', undefined)).toBeNull();
  });

  it('fingerprints reference bindings by reference, never by resolved value', () => {
    const binding = { secretRef: REFERENCE, sensitive: true as const };
    expect(variableFingerprint('production', 'API_KEY', binding)).toBe('a2934f707bddaa4a');
    expect(variableFingerprint('production', 'API_KEY', binding)).not.toBe(variableFingerprint('production', 'API_KEY', REFERENCE));
    expect(secretBindingFingerprint('production', { name: 'API_KEY', source: REFERENCE, environments: ['production'] })).toBe('a2934f707bddaa4a');
    expect(secretBindingFingerprint('production', { name: 'API_KEY', value: 'abc123', environments: ['production'] })).toBe('152871cee3ca5423');
    expect(secretBindingFingerprint('production', { name: 'API_KEY', source: REFERENCE, environments: ['production'] })).not.toBe(secretBindingFingerprint('production', { name: 'API_KEY', value: 'abc123', environments: ['production'] }));
  });

  it('redacts environment specs so raw values and references never enter artifacts', () => {
    const redacted = redactEnvironmentSpec(environment, 'production') as { variables: Record<string, { fingerprint: string | null }> };
    expect(redacted.variables.PUBLIC_URL).toEqual({ fingerprint: variableFingerprint('production', 'PUBLIC_URL', 'https://example.com') });
    expect(redacted.variables.API_KEY).toEqual({ fingerprint: variableFingerprint('production', 'API_KEY', { secretRef: REFERENCE, sensitive: true }) });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('https://example.com');
    expect(serialized).not.toContain(REFERENCE);
  });

  it('redacts desired applications without raw secret values, references, or source paths', () => {
    const desired: DesiredApplication = {
      apiVersion: 'launchpad.dev/v1',
      kind: 'Application',
      metadata: { id: 'app', displayName: 'App', owners: ['@platform'], labels: {}, annotations: {} },
      repository: { provider: 'github', name: 'acme/app', productionBranch: 'main', deploymentRef: 'main' },
      vercel: {
        scope: {},
        project: { name: 'app', framework: 'nextjs', rootDirectory: 'apps/web', nodeVersion: '24.x', build: { installCommand: 'yarn install', buildCommand: 'yarn build', outputDirectory: null, developmentCommand: null, ignoredBuildStep: null }, git: { connected: true, productionBranch: 'main' }, deployment: { autoAssignProductionDomains: false }, regions: { functions: [] }, protection: {}, settings: {} },
      },
      environments: {
        production: {
          enabled: true,
          strategy: 'custom-environment',
          variables: { PUBLIC_URL: 'https://example.com', API_KEY: 'super-secret-value' },
          health: { path: '/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 10, attempts: 3, intervalSeconds: 5 },
          release: { strategy: 'staged-production', promoteExactBuild: true, autoPromoteAfterChecks: true },
        },
      },
      domains: [],
      secrets: [{ name: 'API_KEY', source: REFERENCE, environments: ['production'] }],
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
      sourcePath: 'catalog/apps/fixture.yaml',
    };
    const redacted = redactDesired(desired) as Record<string, unknown>;
    const serialized = JSON.stringify(redacted);
    // Raw secret values, literal variable values, and loader-only source paths
    // never survive the projection.
    expect(serialized).not.toContain('super-secret-value');
    expect(serialized).not.toContain('https://example.com');
    expect(serialized).not.toContain('catalog/apps/fixture.yaml');
    expect('sourcePath' in redacted).toBe(false);
    // Secret *references* are pointers (already public in Git, needed to resolve at
    // apply time), so they survive; only the value material is replaced.
    expect((redacted.secrets as Array<{ name: string; source?: string; value?: unknown }>)[0]?.source).toBe(REFERENCE);
    const productionVariables = (redacted.environments as Record<string, { variables: Record<string, { fingerprint: string }> }>).production.variables;
    expect(productionVariables.API_KEY).toEqual({ fingerprint: variableFingerprint('production', 'API_KEY', 'super-secret-value') });
    expect(productionVariables.PUBLIC_URL).toEqual({ fingerprint: variableFingerprint('production', 'PUBLIC_URL', 'https://example.com') });
  });
});
