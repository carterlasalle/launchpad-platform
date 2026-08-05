import { expect, it } from 'vitest';
import { checkHealth, HEALTH_ERROR_CODES, type HealthCheckInput } from './index.js';
import type { HealthSpec } from '@launchpad/core';
import { scanCanary } from '@launchpad/shared';

const noDns = async (): Promise<void> => undefined;
const noSleep = async (): Promise<void> => undefined;
const okBody = '{"status": "ok", "services": [{"name": "db", "healthy": true}]}';

const baseSpec: HealthSpec = { path: '/api/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 2, attempts: 1, intervalSeconds: 0 };

function input(overrides: Partial<HealthCheckInput> = {}, spec: HealthSpec = baseSpec): HealthCheckInput {
  return {
    applicationId: 'app',
    environment: 'production',
    deploymentId: 'dpl_1',
    baseUrl: 'https://app.example.com',
    spec,
    fetchImpl: async () => new Response(okBody, { status: 200 }),
    sleep: noSleep,
    dnsResolve: noDns,
    ...overrides,
  };
}

it('passes status and dotted JSONPath assertions', async () => {
  const result = await checkHealth(input());
  expect(result.result).toBe('PASSED');
  expect(result.errorCode).toBeNull();
  expect(result.dnsResolved).toBe(true);
  expect(result.tlsValid).toBe(true);
  expect(result.statusCode).toBe(200);
  expect(result.latencyMs).toBeTypeOf('number');
  expect(result.assertionResults.every((assertion) => assertion.passed)).toBe(true);
  expect(result.id).toMatch(/^app:production:/);
});

it('supports JSONPath root, bracket notation, and key-order-insensitive equality', async () => {
  const bracket: HealthSpec = { ...baseSpec, body: { jsonPath: "$['services'][0]['name']", equals: 'db' } };
  const root: HealthSpec = { ...baseSpec, body: { jsonPath: '$', equals: { status: 'ok', services: [{ name: 'db', healthy: true }] } } };
  const reordered: HealthSpec = { ...baseSpec, body: { jsonPath: '$.services[0]', equals: { healthy: true, name: 'db' } } };
  for (const spec of [bracket, root, reordered]) {
    const result = await checkHealth(input({}, spec));
    expect(result.result).toBe('PASSED');
  }
});

it('accepts any status in the expected set', async () => {
  const spec: HealthSpec = { ...baseSpec, expectedStatus: [200, 204] };
  const result = await checkHealth(input({ fetchImpl: async () => new Response(null, { status: 204 }) }, spec));
  expect(result.result).toBe('PASSED');
});

it('supports string contains and regular-expression body checks', async () => {
  const contains: HealthSpec = { ...baseSpec, body: { contains: '"healthy": true' } };
  const matches: HealthSpec = { ...baseSpec, body: { matches: '"status": "ok"' } };
  for (const spec of [contains, matches]) {
    const result = await checkHealth(input({}, spec));
    expect(result.result).toBe('PASSED');
  }
});

it('fails when the body does not match the configured expression', async () => {
  const spec: HealthSpec = { ...baseSpec, body: { matches: '"status": "degraded"' } };
  const result = await checkHealth(input({}, spec));
  expect(result.result).toBe('FAILED');
  expect(result.errorCode).toBe(HEALTH_ERROR_CODES.ASSERTION_FAILED);
  expect(result.assertionResults.find((assertion) => assertion.name === 'body-matches')?.passed).toBe(false);
});

it('fails closed when the configured regular expression is invalid', async () => {
  const spec: HealthSpec = { ...baseSpec, body: { matches: '(' } };
  const result = await checkHealth(input({}, spec));
  expect(result.result).toBe('FAILED');
  expect(result.errorCode).toBe(HEALTH_ERROR_CODES.ASSERTION_FAILED);
  expect(result.assertionResults.find((assertion) => assertion.name === 'body-matches')?.passed).toBe(false);
});

it('fails on status mismatch with a stable FAILED code', async () => {
  const result = await checkHealth(input({ fetchImpl: async () => new Response(okBody, { status: 500 }) }));
  expect(result.result).toBe('FAILED');
  expect(result.errorCode).toBe(HEALTH_ERROR_CODES.ASSERTION_FAILED);
  expect(result.assertionResults.find((assertion) => assertion.name === 'status')?.passed).toBe(false);
});

it('sends safe and secret-backed headers, and never leaks the secret into the record', async () => {
  const secret = 'header-secret-9c2e';
  const received: Headers = new Headers();
  const result = await checkHealth(input({
    spec: { ...baseSpec, headers: { 'X-Safe': 'plain', 'X-Health-Key': { secretRef: 'env://HEALTH_KEY' } } },
    resolveSecret: async (reference) => { expect(reference).toBe('env://HEALTH_KEY'); return secret; },
    fetchImpl: async (_url, init) => { for (const [name, value] of new Headers(init?.headers).entries()) received.set(name, value); return new Response(okBody, { status: 200 }); },
  }));
  expect(result.result).toBe('PASSED');
  expect(received.get('X-Safe')).toBe('plain');
  expect(received.get('X-Health-Key')).toBe(secret);
  const leaked = await scanCanary(result, [secret]);
  expect(leaked.leaked).toBe(false);
});

it('fails closed when a secret-backed header cannot be resolved', async () => {
  const missingResolver = await checkHealth(input({ spec: { ...baseSpec, headers: { 'X-Key': { secretRef: 'env://KEY' } } } }));
  expect(missingResolver.result).toBe('ERROR');
  expect(missingResolver.errorCode).toBe(HEALTH_ERROR_CODES.SECRET_UNAVAILABLE);

  const failingResolver = await checkHealth(input({
    spec: { ...baseSpec, headers: { 'X-Key': { secretRef: 'env://KEY' } } },
    resolveSecret: async () => { throw new Error('vault unavailable'); },
  }));
  expect(failingResolver.result).toBe('ERROR');
  expect(failingResolver.errorCode).toBe(HEALTH_ERROR_CODES.SECRET_UNAVAILABLE);
});

it('uses the configured HTTP method', async () => {
  let seenMethod = '';
  const result = await checkHealth(input({
    spec: { ...baseSpec, method: 'POST' },
    fetchImpl: async (_url, init) => { seenMethod = init?.method ?? ''; return new Response(okBody, { status: 200 }); },
  }));
  expect(result.result).toBe('PASSED');
  expect(seenMethod).toBe('POST');
});

it('supports plain HTTP when TLS is not required', async () => {
  const result = await checkHealth(input({ baseUrl: 'http://app.example.com' }));
  expect(result.result).toBe('PASSED');
  expect(result.tlsValid).toBe(true);
});

it('blocks redirects when the policy forbids them', async () => {
  const spec: HealthSpec = { ...baseSpec, redirects: { allowed: false } };
  const result = await checkHealth(input({ fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://app.example.com/new' } }) }, spec));
  expect(result.result).toBe('FAILED');
  expect(result.errorCode).toBe(HEALTH_ERROR_CODES.REDIRECT_FAILED);
  expect(result.assertionResults.find((assertion) => assertion.name === 'redirect-policy')?.passed).toBe(false);
});

it('follows redirects when the policy allows them', async () => {
  const spec: HealthSpec = { ...baseSpec, redirects: { allowed: true } };
  let seenRedirect: string | undefined;
  const result = await checkHealth(input({
    spec,
    fetchImpl: async (_url, init) => { seenRedirect = init?.redirect; return new Response(okBody, { status: 200 }); },
  }));
  expect(result.result).toBe('PASSED');
  expect(seenRedirect).toBe('follow');
});

it('requires TLS when configured and fails on plain HTTP', async () => {
  const spec: HealthSpec = { ...baseSpec, tls: { required: true } };
  const http = await checkHealth(input({ baseUrl: 'http://app.example.com' }, spec));
  expect(http.result).toBe('FAILED');
  expect(http.errorCode).toBe(HEALTH_ERROR_CODES.ASSERTION_FAILED);
  expect(http.tlsValid).toBe(false);
  expect(http.assertionResults.find((assertion) => assertion.name === 'tls')?.passed).toBe(false);
});

it('passes TLS verification with a valid probe', async () => {
  const spec: HealthSpec = { ...baseSpec, tls: { required: true } };
  const result = await checkHealth(input({ tlsProbe: async () => ({ valid: true, daysRemaining: 30 }) }, spec));
  expect(result.result).toBe('PASSED');
  expect(result.tlsValid).toBe(true);
  expect(result.assertionResults.find((assertion) => assertion.name === 'tls')?.passed).toBe(true);
});

it('returns ERROR when the TLS handshake fails', async () => {
  const spec: HealthSpec = { ...baseSpec, tls: { required: true } };
  const result = await checkHealth(input({ tlsProbe: async () => ({ valid: false, daysRemaining: null }) }, spec));
  expect(result.result).toBe('ERROR');
  expect(result.errorCode).toBe(HEALTH_ERROR_CODES.TLS_FAILED);
  expect(result.tlsValid).toBe(false);
});

it('fails when the certificate expires sooner than the minimum validity', async () => {
  const spec: HealthSpec = { ...baseSpec, tls: { required: true, minimumDaysRemaining: 7 } };
  const expiring = await checkHealth(input({ tlsProbe: async () => ({ valid: true, daysRemaining: 3 }) }, spec));
  expect(expiring.result).toBe('FAILED');
  expect(expiring.errorCode).toBe(HEALTH_ERROR_CODES.TLS_EXPIRING);
  expect(expiring.assertionResults.find((assertion) => assertion.name === 'tls-validity')?.passed).toBe(false);

  const ok = await checkHealth(input({ tlsProbe: async () => ({ valid: true, daysRemaining: 30 }) }, spec));
  expect(ok.result).toBe('PASSED');
});

it('fails closed when the certificate validity cannot be verified', async () => {
  const spec: HealthSpec = { ...baseSpec, tls: { required: true, minimumDaysRemaining: 7 } };
  const result = await checkHealth(input({ tlsProbe: async () => ({ valid: true, daysRemaining: null }) }, spec));
  expect(result.result).toBe('FAILED');
  expect(result.errorCode).toBe(HEALTH_ERROR_CODES.TLS_EXPIRING);
});

it('fails when the latency threshold is exceeded', async () => {
  const spec: HealthSpec = { ...baseSpec, latencyMs: 0 };
  const slow = await checkHealth(input({ fetchImpl: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return new Response(okBody, { status: 200 }); } }, spec));
  expect(slow.result).toBe('FAILED');
  expect(slow.assertionResults.find((assertion) => assertion.name === 'latency')?.passed).toBe(false);
});

it('retries with interval and bounded exponential backoff, and stops after attempts', async () => {
  const delays: number[] = [];
  let calls = 0;
  const spec: HealthSpec = { ...baseSpec, attempts: 3, intervalSeconds: 1, backoff: { multiplier: 2, maxDelaySeconds: 5 } };
  const result = await checkHealth(input({
    spec,
    sleep: async (delayMs) => { delays.push(delayMs); },
    fetchImpl: async () => { calls += 1; throw new Error('network'); },
  }));
  expect(result.result).toBe('ERROR');
  expect(result.errorCode).toBe(HEALTH_ERROR_CODES.REQUEST_FAILED);
  expect(result.attempt).toBe(3);
  expect(calls).toBe(3);
  expect(delays).toEqual([1000, 2000]);
});

it('caps backoff delays at the configured maximum', async () => {
  const delays: number[] = [];
  const spec: HealthSpec = { ...baseSpec, attempts: 3, intervalSeconds: 10, backoff: { multiplier: 10, maxDelaySeconds: 15 } };
  await checkHealth(input({ spec, sleep: async (delayMs) => { delays.push(delayMs); }, fetchImpl: async () => { throw new Error('network'); } }));
  expect(delays).toEqual([10000, 15000]);
});

it('retries and succeeds on a later attempt', async () => {
  let calls = 0;
  const spec: HealthSpec = { ...baseSpec, attempts: 3, intervalSeconds: 0 };
  const result = await checkHealth(input({
    spec,
    fetchImpl: async () => { calls += 1; if (calls < 3) throw new Error('network'); return new Response(okBody, { status: 200 }); },
  }));
  expect(result.result).toBe('PASSED');
  expect(result.attempt).toBe(3);
});

it('reports a stable ERROR code for transport failure', async () => {
  const result = await checkHealth(input({ fetchImpl: async () => { throw new Error('network'); } }));
  expect(result.result).toBe('ERROR');
  expect(result.errorCode).toBe(HEALTH_ERROR_CODES.REQUEST_FAILED);
});

it('reports LP-HEALTH-TIMEOUT when a request exceeds the timeout', async () => {
  const spec: HealthSpec = { ...baseSpec, timeoutSeconds: 1 };
  const result = await checkHealth(input({
    spec,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); }),
  }));
  expect(result.result).toBe('ERROR');
  expect(result.errorCode).toBe(HEALTH_ERROR_CODES.TIMEOUT);
});

it('separates DNS failures from HTTP failures', async () => {
  const result = await checkHealth(input({ dnsResolve: async () => { throw new Error('ENOTFOUND'); } }));
  expect(result.result).toBe('ERROR');
  expect(result.errorCode).toBe(HEALTH_ERROR_CODES.DNS_FAILED);
  expect(result.dnsResolved).toBe(false);
  expect(result.statusCode).toBeNull();
});

it('fails closed on invalid specs with LP-HEALTH-INVALID-SPEC', async () => {
  const badBaseUrl = await checkHealth(input({ baseUrl: 'not a url' }));
  expect(badBaseUrl.result).toBe('ERROR');
  expect(badBaseUrl.errorCode).toBe(HEALTH_ERROR_CODES.INVALID_SPEC);

  const zeroAttempts = await checkHealth(input({}, { ...baseSpec, attempts: 0 }));
  expect(zeroAttempts.errorCode).toBe(HEALTH_ERROR_CODES.INVALID_SPEC);

  const noStatuses = await checkHealth(input({}, { ...baseSpec, expectedStatus: [] }));
  expect(noStatuses.errorCode).toBe(HEALTH_ERROR_CODES.INVALID_SPEC);

  const badBackoff = await checkHealth(input({}, { ...baseSpec, backoff: { multiplier: 1 } }));
  expect(badBackoff.errorCode).toBe(HEALTH_ERROR_CODES.INVALID_SPEC);
});

it('fails when a required dependency is unhealthy and passes when it is healthy', async () => {
  const spec: HealthSpec = { ...baseSpec, dependencies: [{ id: 'db', type: 'external', url: 'https://db.example.com/health', required: true }] };
  const unhealthy = await checkHealth(input({
    spec,
    resolveDependency: async () => ({ healthy: false, message: 'Dependency db is down.' }),
  }));
  expect(unhealthy.result).toBe('FAILED');
  expect(unhealthy.errorCode).toBe(HEALTH_ERROR_CODES.DEPENDENCY_FAILED);
  expect(unhealthy.assertionResults.find((assertion) => assertion.name === 'dependency:db')?.passed).toBe(false);

  const healthy = await checkHealth(input({
    spec,
    resolveDependency: async () => ({ healthy: true, message: 'Dependency db is up.' }),
  }));
  expect(healthy.result).toBe('PASSED');
  expect(healthy.assertionResults.find((assertion) => assertion.name === 'dependency:db')?.passed).toBe(true);
});

it('probes external dependency URLs with the configured fetch and treats failures as unhealthy', async () => {
  const spec: HealthSpec = { ...baseSpec, dependencies: [{ id: 'api', type: 'external', url: 'https://api.example.com/health', required: true }] };
  const result = await checkHealth(input({
    spec,
    fetchImpl: async (url) => (url === 'https://api.example.com/health' ? new Response('', { status: 500 }) : new Response(okBody, { status: 200 })),
  }));
  expect(result.result).toBe('FAILED');
  expect(result.errorCode).toBe(HEALTH_ERROR_CODES.DEPENDENCY_FAILED);
});

it('records optional dependency status without failing the check', async () => {
  const spec: HealthSpec = { ...baseSpec, dependencies: [{ id: 'metrics', type: 'external', url: 'https://metrics.example.com', required: false }] };
  const result = await checkHealth(input({
    spec,
    resolveDependency: async () => ({ healthy: false, message: 'Optional dependency metrics is down.' }),
  }));
  expect(result.result).toBe('PASSED');
  expect(result.assertionResults.find((assertion) => assertion.name === 'dependency:metrics')?.passed).toBe(false);
});
