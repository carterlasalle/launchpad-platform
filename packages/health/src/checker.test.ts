import { expect, it } from 'vitest';
import { checkHealth } from './index.js';
import type { HealthSpec } from '@launchpad/core';

const spec: HealthSpec = { path: '/api/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 2, attempts: 2, intervalSeconds: 0, body: { jsonPath: '$.status', equals: 'ok' } };

it('passes status and JSON assertions', async () => {
  const result = await checkHealth({ applicationId: 'app', environment: 'production', deploymentId: 'dpl_1', baseUrl: 'https://app.example.com', spec, fetchImpl: async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }), sleep: async () => undefined });
  expect(result.result).toBe('PASSED');
  expect(result.assertionResults.every((assertion) => assertion.passed)).toBe(true);
});

it('fails after bounded attempts when response assertions do not pass', async () => {
  let attempts = 0;
  const result = await checkHealth({ applicationId: 'app', environment: 'production', deploymentId: null, baseUrl: 'https://app.example.com', spec, fetchImpl: async () => { attempts += 1; return new Response(JSON.stringify({ status: 'bad' }), { status: 500 }); }, sleep: async () => undefined });
  expect(result.result).toBe('FAILED');
  expect(result.attempt).toBe(2);
  expect(attempts).toBe(2);
});

it('returns ERROR for transport failure without claiming health', async () => {
  const result = await checkHealth({ applicationId: 'app', environment: 'production', deploymentId: null, baseUrl: 'https://app.example.com', spec: { ...spec, attempts: 1 }, fetchImpl: async () => { throw new Error('network'); }, sleep: async () => undefined });
  expect(result.result).toBe('ERROR');
  expect(result.errorCode).toBe('LP-HEALTH-REQUEST-FAILED');
});
