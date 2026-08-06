import { expect, it } from 'vitest';
import { SensitiveValue, redactValue, scanCanary } from '@launchpad/shared';
import { artifactFiles, renderStickyComment } from '@launchpad/github-reporting';
import { checkHealth } from '@launchpad/health';
import type { PlatformPlan } from '@launchpad/core';

const secret = 'launchpad-canary-secret-7f1d';
const reference = 'env://DATABASE_URL';
const plan: PlatformPlan = { schemaVersion: 'launchpad.plan/v1', applicationId: 'app', desiredGeneration: 1, sourceCommit: 'a'.repeat(40), createdAt: '2026-08-04T00:00:00.000Z', capabilitySnapshotHash: 'cap', observedStateHash: 'obs', operations: [], downstreamEffects: [], policyResults: [], fingerprint: 'f'.repeat(64), result: 'READY' };

it('does not serialize SensitiveValue or leak provider artifacts', async () => {
  const sensitive = new SensitiveValue(secret);
  expect(() => JSON.stringify({ sensitive })).toThrow();
  const artifacts = artifactFiles({ plans: [plan], previews: [{ state: 'READY', url: null, message: 'ok' }], healths: [{ state: 'PASSED', message: 'ok' }], providerState: redactValue({ database: sensitive }), logs: [`token=${secret}`] });
  const comment = renderStickyComment({ plans: [plan], previews: [{ state: 'READY', url: null, message: `token=${secret}` }], healths: [{ state: 'PASSED', message: `secret=${secret}` }] });
  for (const value of Object.values(artifacts)) expect(value).not.toContain(secret);
  expect(comment).not.toContain(secret);
  const scan = await scanCanary({ ...artifacts, comment }, [secret]);
  expect(scan.leaked).toBe(false);
});

it('scans artifacts, comments, logs, and observed state for canaries', async () => {
  const artifacts = artifactFiles({ plans: [plan], previews: [{ state: 'READY', url: null, message: 'ok' }], healths: [{ state: 'PASSED', message: 'ok' }], providerState: { safe: 'ok' }, logs: ['build ok'] });
  const comment = renderStickyComment({ plans: [plan], previews: [{ state: 'READY', url: null, message: 'ok' }], healths: [{ state: 'PASSED', message: 'ok' }] });
  const observedState = redactValue({ variables: { DATABASE_URL: new SensitiveValue(secret) }, safe: 'ok' });
  const result = await scanCanary({ artifacts, comment, logs: ['deploying'], observedState }, [secret]);
  expect(result.leaked).toBe(false);
});

it('detects a canary that leaks into any artifact or log', async () => {
  const leaked = await scanCanary({ artifacts: { 'preview-summary.json': JSON.stringify({ url: 'https://x.example.com', token: secret }) }, comment: 'looks good', logs: [] }, [secret]);
  expect(leaked.leaked).toBe(true);
  expect(leaked.matches.some((match) => match.path.includes('preview-summary.json'))).toBe(true);
});

it('health records never carry secret-backed header values', async () => {
  const received: Headers = new Headers();
  const result = await checkHealth({
    applicationId: 'app',
    environment: 'production',
    deploymentId: 'dpl_1',
    baseUrl: 'https://app.example.com',
    spec: { path: '/api/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 2, attempts: 1, intervalSeconds: 0, headers: { 'X-Health-Key': { secretRef: reference } } },
    resolveSecret: async () => secret,
    dnsResolve: async () => undefined,
    sleep: async () => undefined,
    fetchImpl: async (_url, init) => { for (const [name, value] of new Headers(init?.headers).entries()) received.set(name, value); return new Response(JSON.stringify({ status: 'ok' }), { status: 200 }); },
  });
  expect(result.result).toBe('PASSED');
  expect(received.get('X-Health-Key')).toBe(secret);
  const scan = await scanCanary(result, [secret]);
  expect(scan.leaked).toBe(false);
  expect(JSON.stringify(result)).not.toContain(secret);
});


it('stepErrorView redacts provider error strings before they reach served views (gzg.6)', async () => {
  const { stepErrorView } = await import('../../apps/controller/src/api.js');
  const canary = `token=${secret}`;
  const canaryMessage = `Vercel deploy rejected: ${canary}`;

  // The projection function itself must never emit the canary: code and
  // message pass through redactText before the bounded slice is returned.
  const projected = stepErrorView(new Error(canaryMessage));
  expect(projected).not.toBeNull();
  expect(projected?.message).not.toContain(secret);
  expect(projected?.message).toContain('token=[REDACTED]');

  const objectError = stepErrorView({ code: 'LP-VERCEL-DEPLOY-REJECTED', message: canaryMessage });
  expect(objectError?.message).not.toContain(secret);
  expect(objectError?.code).not.toContain(secret);
  expect(objectError?.message).toContain('[REDACTED]');

  // End-to-end: a typed provider failure whose message carries a `token=`
  // canary is persisted raw by the internal dispatch, but the operator
  // dashboard operation view (which serves persisted step errors through
  // stepErrorView) must never emit the canary.
  const { InMemoryLaunchpadStore } = await import('@launchpad/database');
  const { createControllerApp } = await import('../../apps/controller/src/api.js');
  const store = new InMemoryLaunchpadStore();
  await store.upsertApplication({ id: 'app-canary', displayName: 'app-canary', sourcePath: 'catalog/apps/canary.yaml', desiredGeneration: 1, desiredHash: 'h', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
  const run = await store.startWorkflowRun({ id: 'run-1', applicationId: 'app-canary', workflowType: 'apply', idempotencyKey: 'k-1', payloadHash: 'p-1' });
  const typedProviderError = new Error(canaryMessage);
  typedProviderError.name = 'LP-VERCEL-DEPLOY-REJECTED';
  const app = createControllerApp({
    operatorToken: 'op-token',
    internalWorkflowToken: 'internal-token',
    store,
    workflowHandlers: { apply: async () => { throw typedProviderError; } },
  });
  const dispatch = await app.request('/internal/workflows/apply', {
    method: 'POST',
    body: JSON.stringify({ version: 1, applicationId: 'app-canary', operationId: run.id, workflowId: run.id, sourceCommit: 'a'.repeat(40), idempotencyKey: 'k-1' }),
    headers: { 'content-type': 'application/json', 'x-launchpad-workflow-token': 'internal-token' },
  });
  expect(dispatch.status).toBe(500);
  const persisted = await store.listWorkflowSteps('run-1');
  expect(persisted[0]?.error?.message).toContain(secret); // raw persistence is unchanged

  const served = await app.request('/v1/applications/app-canary/operations/run-1', { headers: { authorization: 'Bearer op-token' } });
  expect(served.status).toBe(200);
  const servedBody = JSON.stringify(await served.json());
  expect(servedBody).not.toContain(secret);
  expect(servedBody).toContain('token=[REDACTED]');

  const scan = await scanCanary({ served: servedBody }, [secret]);
  expect(scan.leaked).toBe(false);
});
