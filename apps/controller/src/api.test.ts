import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportJWK, SignJWT } from 'jose';
import { InMemoryDatabase, InMemoryLaunchpadStore, LaunchpadRepositories } from '@launchpad/database';
import type { PlatformPlan } from '@launchpad/core';
import { canonicalJson, stableId } from '@launchpad/shared';
import { createControllerApp, sanitizeVercelWebhookEvent } from './api.js';
import type { WorkflowBinding } from './env.js';
import type { OidcConfig } from './env.js';

const ISSUER = 'https://token.actions.test';
const AUDIENCE = 'launchpad-test';
const OIDC: OidcConfig = { issuer: ISSUER, audience: AUDIENCE, jwks: `${ISSUER}/.well-known/jwks` };

const REPOSITORY = 'acme/web-app';
const REPOSITORY_ID = '123456789';
const OWNER_ID = '987654321';
const WORKFLOW_REF = `${REPOSITORY}/.github/workflows/preview.yml@refs/heads/main`;
const PUSH_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const MERGE_SHA = 'c'.repeat(40);
const PLAN_FINGERPRINT = 'f'.repeat(64);

interface TestHarness {
  app: ReturnType<typeof createControllerApp>;
  store: InMemoryLaunchpadStore;
  workflowCalls: Array<{ id: string; params: Record<string, unknown> }>;
  handlersCalled: string[];
  env: Record<string, unknown>;
}

let privateKey: CryptoKey;
let publicJwk: JsonWebKey;
let originalFetch: typeof fetch;
let fetchHandler: ((url: string) => Promise<Response> | Response) | null;
async function installJwks(): Promise<void> {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  publicJwk = { ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' } as JsonWebKey;
}

function mockFetch(): void {
  originalFetch = globalThis.fetch;
  fetchHandler = null;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `${ISSUER}/.well-known/jwks`) {
      return Promise.resolve(new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    if (fetchHandler) return Promise.resolve(fetchHandler(url));
    return Promise.resolve(new Response('not mocked', { status: 500 }));
  }) as typeof fetch;
}

async function signToken(claims: Record<string, unknown>, options: { expiresInSeconds?: number; issuedAtSeconds?: number } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(options.issuedAtSeconds ?? now)
    .setExpirationTime(now + (options.expiresInSeconds ?? 3600))
    .sign(privateKey);
}

function baseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: `repo:${OWNER_ID}:${REPOSITORY}:ref:refs/heads/main`,
    repository: REPOSITORY,
    repository_id: REPOSITORY_ID,
    repository_owner: 'acme',
    repository_owner_id: OWNER_ID,
    workflow_ref: WORKFLOW_REF,
    workflow: 'preview.yml',
    event_name: 'push',
    sha: PUSH_SHA,
    ref: 'refs/heads/main',
    actor: 'alice',
    run_id: '1234567890',
    ...overrides,
  };
}

function prClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return baseClaims({ event_name: 'pull_request', sha: MERGE_SHA, ref: 'refs/pull/42/merge', pull_request_number: '42', ...overrides });
}

function baseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    applicationId: 'app-demo',
    sourceCommit: PUSH_SHA,
    desiredGeneration: 2,
    planFingerprint: PLAN_FINGERPRINT,
    idempotencyKey: 'key-1',
    repositoryId: REPOSITORY_ID,
    ownerId: OWNER_ID,
    repository: REPOSITORY,
    workflowRef: WORKFLOW_REF,
    event: 'push',
    ref: 'refs/heads/main',
    actor: 'alice',
    ...overrides,
  };
}

/** A real PR-head plan for /v1/plans/verify: bound to the exact head SHA, fingerprint, and generation. */
function reviewPlan(overrides: Record<string, unknown> = {}): PlatformPlan {
  return {
    schemaVersion: 'launchpad.plan/v1',
    applicationId: 'app-demo',
    desiredGeneration: 2,
    sourceCommit: HEAD_SHA,
    createdAt: '2026-08-04T00:00:00.000Z',
    capabilitySnapshotHash: 'cap-1',
    observedStateHash: 'obs-1',
    operations: [{ id: 'op-1', resourceKey: 'vercel.project', provider: 'vercel', resourceType: 'vercel.project', action: 'CREATE', before: null, after: { name: 'demo' }, prerequisites: [], invalidates: [], idempotencyKey: 'ik-1', destructive: false, retryClass: 'NONE' }],
    downstreamEffects: [],
    policyResults: [],
    fingerprint: PLAN_FINGERPRINT,
    result: 'READY',
    ...overrides,
  };
}

/** Body for the reviewed-plan attestation endpoint: pull_request identity plus the real plan and desired-state binding. */
function reviewBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    applicationId: 'app-demo',
    sourceCommit: HEAD_SHA,
    desiredGeneration: 2,
    planFingerprint: PLAN_FINGERPRINT,
    desiredHash: 'd'.repeat(64),
    plan: reviewPlan(),
    repositoryId: REPOSITORY_ID,
    ownerId: OWNER_ID,
    repository: REPOSITORY,
    workflowRef: WORKFLOW_REF,
    event: 'pull_request',
    prNumber: 42,
    ref: 'refs/pull/42/merge',
    actor: 'alice',
    ...overrides,
  };
}

function createHarness(overrides: Partial<Parameters<typeof createControllerApp>[0]> = {}, envOverrides: Record<string, unknown> = {}): TestHarness {
  const store = new InMemoryLaunchpadStore();
  const repositories = new LaunchpadRepositories(new InMemoryDatabase());
  const workflowCalls: Array<{ id: string; params: Record<string, unknown> }> = [];
  const binding: WorkflowBinding = { create: async (input) => { workflowCalls.push({ id: input.id ?? '', params: input.params as Record<string, unknown> }); return { id: input.id ?? '' }; } };
  const handlersCalled: string[] = [];
  const app = createControllerApp({
    operatorToken: 'operator-token',
    oidc: OIDC,
    internalWorkflowToken: 'internal-token',
    githubToken: 'ghp_controller',
    store,
    repositories,
    workflowHandlers: {
      apply: async () => { handlersCalled.push('apply'); return { ok: true }; },
      preview: async () => { handlersCalled.push('preview'); return { ok: true }; },
      'app-preview': async (payload) => { handlersCalled.push('app-preview'); return { applicationId: payload.applicationId, deployment: payload.deployment, health: payload.health }; },
      'apply/validate-request': async () => { handlersCalled.push('apply/validate-request'); return { phase: 'validated' }; },
      failing: async () => { throw new Error('provider body leaked: super-secret-token-value'); },
      'coded-failure': async () => { throw new Error('LP-CONTROL-APPLICATION-NOT_FOUND: missing'); },
    },
    ...overrides,
  });
  const env: Record<string, unknown> = { APPLY_WORKFLOW: binding, PREVIEW_WORKFLOW: binding, APP_PREVIEW_STATUS_WORKFLOW: binding, RECONCILE_WORKFLOW: binding, DECOMMISSION_WORKFLOW: binding, PROVIDER_EVENTS: { send: async () => undefined }, HEALTH_CHECKS: { send: async () => undefined }, LAUNCHPAD_CONTROL_PLANE_ENABLED: 'true', ...envOverrides };
  return { app, store, workflowCalls, handlersCalled, env };
}

function request(harness: TestHarness, path: string, init: RequestInit = {}): Promise<Response> {
  return harness.app.request(path, init, harness.env as never) as Promise<Response>;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

beforeEach(async () => {
  await installJwks();
  mockFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  fetchHandler = null;
});

describe('OIDC authentication', () => {
  it('rejects requests without a bearer token', async () => {
    const harness = createHarness();
    const response = await request(harness, '/v1/plans/verify', { method: 'POST', body: JSON.stringify(baseBody()), headers: { 'content-type': 'application/json' } });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-OIDC-TOKEN-MISSING', retryable: false } });
  });

  it('rejects tokens that fail cryptographic verification', async () => {
    const harness = createHarness();
    const response = await request(harness, '/v1/plans/verify', { method: 'POST', body: JSON.stringify(baseBody()), headers: { 'content-type': 'application/json', ...bearer('not-a.jwt.at-all') } });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-OIDC-VERIFICATION-FAILED' } });
  });

  it('rejects an expired token when no clock tolerance is configured', async () => {
    const harness = createHarness();
    const token = await signToken(baseClaims(), { expiresInSeconds: -60 });
    const response = await request(harness, '/v1/plans/verify', { method: 'POST', body: JSON.stringify(baseBody()), headers: { 'content-type': 'application/json', ...bearer(token) } });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-OIDC-VERIFICATION-FAILED' } });
  });

  it('accepts a slightly expired token within the configured clock tolerance', async () => {
    const harness = createHarness({ oidc: { ...OIDC, clockToleranceSeconds: 120 } });
    const token = await signToken(prClaims(), { expiresInSeconds: -60 });
    fetchHandler = () => new Response(JSON.stringify({ number: 42, head: { sha: HEAD_SHA } }), { status: 200, headers: { 'content-type': 'application/json' } });
    const response = await request(harness, '/v1/plans/verify', { method: 'POST', body: JSON.stringify(reviewBody()), headers: { 'content-type': 'application/json', ...bearer(token) } });
    expect(response.status).toBe(200);
  });

  it('accepts numeric repository identity fields from the CLI payload', async () => {
    const harness = createHarness();
    const token = await signToken(prClaims());
    fetchHandler = () => new Response(JSON.stringify({ number: 42, head: { sha: HEAD_SHA } }), { status: 200, headers: { 'content-type': 'application/json' } });
    const response = await request(harness, '/v1/plans/verify', { method: 'POST', body: JSON.stringify(reviewBody({ repositoryId: Number(REPOSITORY_ID), ownerId: Number(OWNER_ID) })), headers: { 'content-type': 'application/json', ...bearer(token) } });
    expect(response.status).toBe(200);
  });

  it('returns 503 when OIDC is not configured', async () => {
    const harness = createHarness({ oidc: undefined });
    const response = await request(harness, '/v1/plans/verify', { method: 'POST', body: JSON.stringify(baseBody()), headers: { 'content-type': 'application/json' } });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-OIDC-CONFIG-MISSING' } });
  });
});

describe('claim binding', () => {
  const mismatchCases: Array<[string, Record<string, unknown>, string]> = [
    ['repository', { repository: 'acme/other' }, 'LP-OIDC-CLAIM-MISMATCH-REPOSITORY'],
    ['repositoryId', { repositoryId: '999' }, 'LP-OIDC-CLAIM-MISMATCH-REPOSITORY_ID'],
    ['ownerId', { ownerId: '999' }, 'LP-OIDC-CLAIM-MISMATCH-REPOSITORY_OWNER_ID'],
    ['workflowRef', { workflowRef: 'acme/other/.github/workflows/x.yml@main' }, 'LP-OIDC-CLAIM-MISMATCH-WORKFLOW_REF'],
    ['event', { event: 'workflow_dispatch' }, 'LP-OIDC-CLAIM-MISMATCH-EVENT_NAME'],
    ['prNumber', { prNumber: 7 }, 'LP-OIDC-CLAIM-MISMATCH-PULL_REQUEST_NUMBER'],
    ['ref', { ref: 'refs/heads/other' }, 'LP-OIDC-CLAIM-MISMATCH-REF'],
    ['actor', { actor: 'mallory' }, 'LP-OIDC-CLAIM-MISMATCH-ACTOR'],
  ];

  for (const [label, override, code] of mismatchCases) {
    it(`rejects a ${label} mismatch before any D1 or workflow state is written`, async () => {
      const harness = createHarness();
      const token = await signToken(prClaims());
      const response = await request(harness, '/v1/plans/verify', { method: 'POST', body: JSON.stringify(reviewBody(override)), headers: { 'content-type': 'application/json', ...bearer(token) } });
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({ error: { code } });
      expect(harness.workflowCalls).toHaveLength(0);
      expect(await harness.store.listWorkflowRuns('app-demo')).toHaveLength(0);
      expect(await harness.store.listPlanReviewAttestations('app-demo')).toHaveLength(0);
    });
  }

  it('rejects a route/body application mismatch', async () => {
    const harness = createHarness();
    const token = await signToken(baseClaims());
    const response = await request(harness, '/v1/applications/app-other/preview/verify', { method: 'POST', body: JSON.stringify(baseBody()), headers: { 'content-type': 'application/json', ...bearer(token) } });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-OIDC-CLAIM-MISMATCH-APPLICATIONID' } });
    expect(harness.workflowCalls).toHaveLength(0);
  });

  it('rejects missing required bindings', async () => {
    const harness = createHarness();
    const token = await signToken(prClaims());
    for (const [field, body, code] of [
      ['applicationId', { ...reviewBody(), applicationId: '' }, 'LP-OIDC-BINDING-MISSING-APPLICATIONID'],
      ['repository', { ...reviewBody(), repository: undefined }, 'LP-OIDC-BINDING-MISSING-REPOSITORY'],
      ['repositoryId', { ...reviewBody(), repositoryId: undefined }, 'LP-OIDC-BINDING-MISSING-REPOSITORYID'],
      ['ownerId', { ...reviewBody(), ownerId: undefined }, 'LP-OIDC-BINDING-MISSING-OWNERID'],
      ['workflowRef', { ...reviewBody(), workflowRef: undefined }, 'LP-OIDC-BINDING-MISSING-WORKFLOWREF'],
      ['sourceCommit', { ...reviewBody(), sourceCommit: undefined }, 'LP-PAYLOAD-COMMIT-INVALID'],
      ['desiredHash', { ...reviewBody(), desiredHash: 'not-a-hash' }, 'LP-PLAN-REVIEW-DESIRED-HASH-INVALID'],
      ['plan', { ...reviewBody(), plan: undefined }, 'LP-PLAN-REVIEW-PLAN-INVALID'],
    ] as Array<[string, Record<string, unknown>, string]>) {
      const response = await request(harness, '/v1/plans/verify', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...bearer(token) } });
      expect(response.status, field).toBe(400);
      await expect(response.json(), field).resolves.toMatchObject({ error: { code } });
    }
    expect(harness.workflowCalls).toHaveLength(0);
  });

  it('requires prNumber for pull_request events', async () => {
    const harness = createHarness();
    const token = await signToken(prClaims());
    const response = await request(harness, '/v1/plans/verify', { method: 'POST', body: JSON.stringify(reviewBody({ prNumber: undefined })), headers: { 'content-type': 'application/json', ...bearer(token) } });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-OIDC-BINDING-MISSING-PRNUMBER' } });
  });

  it('rejects plan reviews from non-pull_request workflows', async () => {
    const harness = createHarness();
    const token = await signToken(baseClaims());
    const response = await request(harness, '/v1/plans/verify', { method: 'POST', body: JSON.stringify(reviewBody({ event: 'push', prNumber: undefined, ref: 'refs/heads/main', sourceCommit: PUSH_SHA, plan: reviewPlan({ sourceCommit: PUSH_SHA }) })), headers: { 'content-type': 'application/json', ...bearer(token) } });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-PLAN-REVIEW-REQUIRES-PULL-REQUEST' } });
    expect(await harness.store.listPlanReviewAttestations('app-demo')).toHaveLength(0);
  });

  it('rejects a plan that does not bind the submitted source commit, fingerprint, or generation', async () => {
    const harness = createHarness();
    const token = await signToken(prClaims());
    const cases: Array<[string, Record<string, unknown>]> = [
      ['sourceCommit', { plan: reviewPlan({ sourceCommit: 'z'.repeat(40) }) }],
      ['fingerprint', { plan: reviewPlan({ fingerprint: 'g'.repeat(64) }) }],
      ['generation', { plan: reviewPlan({ desiredGeneration: 9 }) }],
      ['applicationId', { plan: reviewPlan({ applicationId: 'app-other' }) }],
    ];
    for (const [label, override] of cases) {
      const response = await request(harness, '/v1/plans/verify', { method: 'POST', body: JSON.stringify(reviewBody(override)), headers: { 'content-type': 'application/json', ...bearer(token) } });
      expect(response.status, label).toBe(400);
      await expect(response.json(), label).resolves.toMatchObject({ error: { code: 'LP-PLAN-REVIEW-PLAN-MISMATCH' } });
    }
    expect(await harness.store.listPlanReviewAttestations('app-demo')).toHaveLength(0);
  });

  it('rejects a pull_request whose head sha is not the current PR head', async () => {
    const harness = createHarness();
    const token = await signToken(prClaims());
    fetchHandler = () => new Response(JSON.stringify({ number: 42, head: { sha: 'z'.repeat(40) } }), { status: 200, headers: { 'content-type': 'application/json' } });
    const response = await request(harness, '/v1/plans/verify', { method: 'POST', body: JSON.stringify(reviewBody()), headers: { 'content-type': 'application/json', ...bearer(token) } });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-OIDC-CLAIM-MISMATCH-SOURCECOMMIT' } });
    expect(harness.workflowCalls).toHaveLength(0);
    expect(await harness.store.listPlanReviewAttestations('app-demo')).toHaveLength(0);
  });

  it('rejects a pull_request when the PR API is unreachable', async () => {
    const harness = createHarness();
    const token = await signToken(prClaims());
    fetchHandler = () => new Response('boom', { status: 500 });
    const response = await request(harness, '/v1/plans/verify', { method: 'POST', body: JSON.stringify(reviewBody()), headers: { 'content-type': 'application/json', ...bearer(token) } });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-OIDC-PR-HEAD-UNVERIFIABLE', retryable: true } });
    expect(harness.workflowCalls).toHaveLength(0);
  });

  it('accepts a pull_request whose head sha matches the current PR head and persists the attestation idempotently', async () => {
    const harness = createHarness();
    const token = await signToken(prClaims());
    fetchHandler = (url) => {
      expect(url).toBe(`https://api.github.com/repos/${REPOSITORY}/pulls/42`);
      return new Response(JSON.stringify({ number: 42, head: { sha: HEAD_SHA } }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const response = await request(harness, '/v1/plans/verify', { method: 'POST', body: JSON.stringify(reviewBody()), headers: { 'content-type': 'application/json', ...bearer(token) } });
    expect(response.status).toBe(200);
    const body = await response.json() as { accepted: boolean; deduplicated: boolean; attestationId: string; applicationId: string; sourceCommit: string; desiredGeneration: number; desiredHash: string; planFingerprint: string; reviewFingerprint: string };
    expect(body).toMatchObject({ accepted: true, deduplicated: false, applicationId: 'app-demo', sourceCommit: HEAD_SHA, desiredGeneration: 2, desiredHash: 'd'.repeat(64), planFingerprint: PLAN_FINGERPRINT });
    expect(body.reviewFingerprint).toMatch(/^[0-9a-f]{64}$/);
    const stored = await harness.store.getPlanReviewAttestation('app-demo', body.reviewFingerprint);
    expect(stored).toMatchObject({ prHeadSourceCommit: HEAD_SHA, repository: REPOSITORY, actor: 'alice', workflowRef: WORKFLOW_REF });
    expect(harness.workflowCalls).toHaveLength(0);

    // Replay with the same reviewed plan returns the stored row: idempotent.
    const replay = await request(harness, '/v1/plans/verify', { method: 'POST', body: JSON.stringify(reviewBody()), headers: { 'content-type': 'application/json', ...bearer(token) } });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ accepted: true, deduplicated: true, attestationId: body.attestationId, reviewFingerprint: body.reviewFingerprint });
    expect(await harness.store.listPlanReviewAttestations('app-demo')).toHaveLength(1);
  });
});

describe('durable enqueue contract', () => {
  it('enqueues a Cloudflare Workflow instance and returns 202 with stable IDs, without running handlers', async () => {
    const harness = createHarness();
    const token = await signToken(baseClaims());
    const response = await request(harness, '/v1/applications/app-demo/preview/verify', { method: 'POST', body: JSON.stringify(baseBody()), headers: { 'content-type': 'application/json', ...bearer(token) } });
    expect(response.status).toBe(202);
    const body = await response.json() as { workflowId: string; operationId: string; status: string };
    expect(body.status).toBe('QUEUED');
    expect(body.workflowId).toMatch(/^lp-app-preview-status-[0-9a-f]{16}$/);
    expect(body.operationId).toMatch(/^[0-9a-f]{16}$/);
    // No synchronous provider work: handlers were never invoked.
    expect(harness.handlersCalled).toEqual([]);
    expect(harness.workflowCalls).toHaveLength(1);
    expect(harness.workflowCalls[0]?.id).toBe(body.workflowId);
    const params = harness.workflowCalls[0]?.params as Record<string, unknown>;
    expect(params).toMatchObject({ version: 1, kind: 'app-preview-status', applicationId: 'app-demo', sourceCommit: PUSH_SHA, desiredGeneration: 2, planFingerprint: PLAN_FINGERPRINT, idempotencyKey: 'key-1', repositoryId: REPOSITORY_ID, ownerId: OWNER_ID, repository: REPOSITORY, workflowRef: WORKFLOW_REF, event: 'push', ref: 'refs/heads/main', actor: 'alice' });
    expect(params.operationId).toBe(body.operationId);
    expect(params.workflowId).toBe(body.workflowId);
    expect(params.desired).toBeUndefined();
    expect(params.plan).toBeUndefined();
    // D1 state: workflow run, idempotent request, audit binding.
    const runs = await harness.store.listWorkflowRuns('app-demo');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: body.operationId, status: 'QUEUED', workflowType: 'app-preview-status', idempotencyKey: 'key-1' });
    const idempotent = await harness.store.getIdempotentRequest('key-1');
    expect(idempotent?.operationId).toBe(body.operationId);
    const audit = await harness.store.listAudit('app-demo');
    expect(audit.some((event) => event.action === 'OIDC_OPERATION_START' && event.details?.operationId === body.operationId && event.details?.repositoryId === REPOSITORY_ID)).toBe(true);
  });

  it('dispatches catalog previews carrying a loaded desired application to the shadow preview machine', async () => {
    const harness = createHarness();
    const token = await signToken(baseClaims());
    const desired = { metadata: { id: 'app-demo' }, vercel: { project: {} }, domains: [] };
    const response = await request(harness, '/v1/applications/app-demo/preview/verify', { method: 'POST', body: JSON.stringify(baseBody({ desired })), headers: { 'content-type': 'application/json', ...bearer(token) } });
    expect(response.status).toBe(202);
    const body = await response.json() as { workflowId: string };
    expect(body.workflowId).toMatch(/^lp-preview-[0-9a-f]{16}$/);
    expect(harness.workflowCalls[0]?.params).toMatchObject({ version: 1, kind: 'preview', applicationId: 'app-demo', sourceCommit: PUSH_SHA, desired });
    const runs = await harness.store.listWorkflowRuns('app-demo');
    expect(runs[0]).toMatchObject({ workflowType: 'preview' });
  });

  it('replays the same payload with the same IDs and does not duplicate state', async () => {
    const harness = createHarness();
    const token = await signToken(baseClaims());
    const first = await request(harness, '/v1/applications/app-demo/preview/verify', { method: 'POST', body: JSON.stringify(baseBody()), headers: { 'content-type': 'application/json', ...bearer(token) } });
    const firstBody = await first.json() as { workflowId: string; operationId: string };
    const second = await request(harness, '/v1/applications/app-demo/preview/verify', { method: 'POST', body: JSON.stringify(baseBody()), headers: { 'content-type': 'application/json', ...bearer(token) } });
    expect(second.status).toBe(202);
    await expect(second.json()).resolves.toEqual({ workflowId: firstBody.workflowId, operationId: firstBody.operationId, status: 'QUEUED' });
    expect(harness.workflowCalls).toHaveLength(2);
    expect(harness.workflowCalls[1]?.id).toBe(firstBody.workflowId);
    expect(await harness.store.listWorkflowRuns('app-demo')).toHaveLength(1);
    expect((await harness.store.listAudit('app-demo')).filter((event) => event.action === 'OIDC_OPERATION_START')).toHaveLength(1);
  });

  it('rejects the same key with a different payload as 409', async () => {
    const harness = createHarness();
    const token = await signToken(baseClaims());
    const first = await request(harness, '/v1/applications/app-demo/preview/verify', { method: 'POST', body: JSON.stringify(baseBody()), headers: { 'content-type': 'application/json', ...bearer(token) } });
    expect(first.status).toBe(202);
    const second = await request(harness, '/v1/applications/app-demo/preview/verify', { method: 'POST', body: JSON.stringify(baseBody({ planFingerprint: 'g'.repeat(64) })), headers: { 'content-type': 'application/json', ...bearer(token) } });
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ error: { code: 'LP-IDEMPOTENCY-CONFLICT', retryable: false } });
    expect(harness.workflowCalls).toHaveLength(1);
  });

  it('does not return 202 when the workflow instance cannot be created', async () => {
    const harness = createHarness();
    const token = await signToken(baseClaims());
    harness.env.APP_PREVIEW_STATUS_WORKFLOW = { create: async () => { throw new Error('workflow runtime down'); } };
    const response = await request(harness, '/v1/applications/app-demo/preview/verify', { method: 'POST', body: JSON.stringify(baseBody()), headers: { 'content-type': 'application/json', ...bearer(token) } });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-WORKFLOW-CREATE-FAILED', retryable: true } });
    expect(harness.handlersCalled).toEqual([]);
  });

  it('does not return 202 without durable persistence', async () => {
    const harness = createHarness({ store: undefined });
    const token = await signToken(baseClaims());
    const response = await request(harness, '/v1/applications/app-demo/preview/verify', { method: 'POST', body: JSON.stringify(baseBody()), headers: { 'content-type': 'application/json', ...bearer(token) } });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-PERSISTENCE-CONFIG-MISSING' } });
    expect(harness.workflowCalls).toHaveLength(0);
  });

  it('does not return 202 without a workflow binding', async () => {
    const harness = createHarness({}, { APP_PREVIEW_STATUS_WORKFLOW: undefined });
    const token = await signToken(baseClaims());
    const response = await request(harness, '/v1/applications/app-demo/preview/verify', { method: 'POST', body: JSON.stringify(baseBody()), headers: { 'content-type': 'application/json', ...bearer(token) } });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-WORKFLOW-BINDING-MISSING' } });
    expect(harness.workflowCalls).toHaveLength(0);
  });

  it('registers the application row on first operation and records the operation hash', async () => {
    const harness = createHarness();
    const token = await signToken(baseClaims());
    const response = await request(harness, '/v1/applications/app-demo/apply', { method: 'POST', body: JSON.stringify(baseBody()), headers: { 'content-type': 'application/json', ...bearer(token) } });
    expect(response.status).toBe(202);
    const application = await harness.store.getApplication('app-demo');
    expect(application).toMatchObject({ id: 'app-demo', syncStatus: 'UNKNOWN' });
    const run = await harness.store.getWorkflowRun((await response.json() as { operationId: string }).operationId);
    expect(run?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('requires planFingerprint and desiredGeneration for apply', async () => {
    const harness = createHarness();
    const token = await signToken(baseClaims());
    for (const body of [baseBody({ planFingerprint: undefined }), baseBody({ desiredGeneration: undefined }), baseBody({ desiredGeneration: 0 })]) {
      const response = await request(harness, '/v1/applications/app-demo/apply', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...bearer(token) } });
      expect(response.status).toBe(400);
    }
    expect(harness.workflowCalls).toHaveLength(0);
  });

  it('blocks OIDC apply while the runtime control-plane gate is disabled', async () => {
    const harness = createHarness({}, { LAUNCHPAD_CONTROL_PLANE_ENABLED: 'false' });
    const token = await signToken(baseClaims());
    const response = await request(harness, '/v1/applications/app-demo/apply', { method: 'POST', body: JSON.stringify(baseBody()), headers: { 'content-type': 'application/json', ...bearer(token) } });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-CONTROL-PLANE-DISABLED', retryable: false } });
    expect(harness.workflowCalls).toHaveLength(0);
  });

  it('blocks automatic reconciliation while the runtime control-plane gate is disabled', async () => {
    const harness = createHarness({}, { LAUNCHPAD_CONTROL_PLANE_ENABLED: 'false' });
    const response = await request(harness, '/v1/cli/reconcile', { method: 'POST', body: JSON.stringify({ applicationIds: ['app-demo'], automatic: true }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-CONTROL-PLANE-DISABLED', retryable: false } });
    expect(harness.workflowCalls).toHaveLength(0);
  });

  it('keeps explicit operator reconciliation available while the runtime control-plane gate is disabled', async () => {
    const harness = createHarness({}, { LAUNCHPAD_CONTROL_PLANE_ENABLED: 'false' });
    const response = await request(harness, '/v1/cli/reconcile', { method: 'POST', body: JSON.stringify({ applicationIds: ['app-demo'], automatic: false }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(response.status).toBe(202);
    expect(harness.workflowCalls).toHaveLength(1);
  });

  it('enqueues health runs against the dedicated app-preview-status workflow', async () => {
    const harness = createHarness();
    const token = await signToken(baseClaims());
    const response = await request(harness, '/v1/applications/app-demo/health/run', { method: 'POST', body: JSON.stringify(baseBody()), headers: { 'content-type': 'application/json', ...bearer(token) } });
    expect(response.status).toBe(202);
    const body = await response.json() as { workflowId: string };
    expect(body.workflowId).toMatch(/^lp-app-preview-status-[0-9a-f]{16}$/);
    expect(harness.workflowCalls[0]?.params).toMatchObject({ kind: 'app-preview-status' });
  });

  it('fails closed for health runs without the app-preview-status workflow binding', async () => {
    const harness = createHarness({}, { APP_PREVIEW_STATUS_WORKFLOW: undefined });
    const token = await signToken(baseClaims());
    const response = await request(harness, '/v1/applications/app-demo/health/run', { method: 'POST', body: JSON.stringify(baseBody()), headers: { 'content-type': 'application/json', ...bearer(token) } });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-WORKFLOW-BINDING-MISSING' } });
    expect(harness.workflowCalls).toHaveLength(0);
  });

  it('does not require operator authentication on OIDC enqueue routes', async () => {
    const harness = createHarness();
    const token = await signToken(baseClaims());
    const response = await request(harness, '/v1/applications/app-demo/preview/verify', { method: 'POST', body: JSON.stringify(baseBody()), headers: { 'content-type': 'application/json', ...bearer(token) } });
    expect(response.status).toBe(202);
  });
});

describe('claim-scoped operation polling', () => {
  async function startOperation(harness: TestHarness, claims: Record<string, unknown>, body: Record<string, unknown>): Promise<{ operationId: string }> {
    const token = await signToken(claims);
    const response = await request(harness, '/v1/applications/app-demo/preview/verify', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...bearer(token) } });
    expect(response.status).toBe(202);
    return response.json() as Promise<{ operationId: string }>;
  }

  it('returns safe status for the operation bound to the caller', async () => {
    const harness = createHarness();
    const { operationId } = await startOperation(harness, baseClaims(), baseBody());
    const token = await signToken(baseClaims());
    const response = await request(harness, `/v1/operations/${operationId}`, { headers: bearer(token) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ operationId, applicationId: 'app-demo', kind: 'app-preview-status', status: 'QUEUED', sourceCommit: PUSH_SHA, result: null });
  });

  it('derives terminal status and a safe result projection from the internal execute step', async () => {
    const harness = createHarness();
    const { operationId } = await startOperation(harness, baseClaims(), baseBody());
    const internalPayload = { applicationId: 'app-demo', operationId, sourceCommit: PUSH_SHA, idempotencyKey: 'key-1' };
    const dispatch = await request(harness, '/internal/workflows/app-preview', {
      method: 'POST',
      body: JSON.stringify({ ...internalPayload, deployment: { url: 'https://app-demo-abc.vercel.app', state: 'READY' }, health: { result: 'PASSED' } }),
      headers: { 'content-type': 'application/json', 'x-launchpad-workflow-token': 'internal-token' },
    });
    expect(dispatch.status).toBe(200);
    expect(harness.handlersCalled).toContain('app-preview');
    const token = await signToken(baseClaims());
    const response = await request(harness, `/v1/operations/${operationId}`, { headers: bearer(token) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'SUCCEEDED', errorCode: null, completedAt: expect.any(String) as unknown as string, result: { previewUrl: 'https://app-demo-abc.vercel.app', buildState: 'READY', healthState: 'PASSED' } });
  });

  it('returns 403 for an operation bound to a different repository', async () => {
    const harness = createHarness();
    const { operationId } = await startOperation(harness, baseClaims(), baseBody());
    const token = await signToken(baseClaims({ repository: 'acme/other', repository_id: '111', sub: 'repo:111:acme/other:ref:refs/heads/main' }));
    const response = await request(harness, `/v1/operations/${operationId}`, { headers: bearer(token) });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-OIDC-OPERATION-NOT-BOUND' } });
  });

  it('returns 403 for a different actor on the same repository', async () => {
    const harness = createHarness();
    const { operationId } = await startOperation(harness, baseClaims(), baseBody());
    const token = await signToken(baseClaims({ actor: 'mallory' }));
    const response = await request(harness, `/v1/operations/${operationId}`, { headers: bearer(token) });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-OIDC-OPERATION-NOT-BOUND' } });
  });

  it('fails closed when the recorded audit details are malformed', async () => {
    const harness = createHarness();
    await harness.store.upsertApplication({ id: 'app-demo', displayName: 'Demo', sourcePath: 'catalog/apps/app-demo.yaml', desiredGeneration: 1, desiredHash: '', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
    const run = await harness.store.startWorkflowRun({ applicationId: 'app-demo', workflowType: 'app-preview', idempotencyKey: 'broken-1', payloadHash: 'h' });
    await harness.store.appendAudit({ actor: 'oidc:acme/web-app', action: 'OIDC_OPERATION_START', applicationId: 'app-demo', details: { operationId: run.id, workflowId: 'w', kind: 'app-preview' } });
    const token = await signToken(baseClaims());
    const response = await request(harness, `/v1/operations/${run.id}`, { headers: bearer(token) });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-OIDC-OPERATION-NOT-BOUND' } });
  });

  it('returns 404 for an unknown operation', async () => {
    const harness = createHarness();
    const token = await signToken(baseClaims());
    const response = await request(harness, '/v1/operations/0000000000000000', { headers: bearer(token) });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-OPERATION-NOT-FOUND' } });
  });

  it('binds pull_request operations by PR number instead of the merge sha', async () => {
    const harness = createHarness();
    fetchHandler = () => new Response(JSON.stringify({ number: 42, head: { sha: HEAD_SHA } }), { status: 200, headers: { 'content-type': 'application/json' } });
    const prTokenClaims = prClaims();
    const { operationId } = await startOperation(harness, prTokenClaims, baseBody({ event: 'pull_request', prNumber: 42, sourceCommit: HEAD_SHA, ref: 'refs/pull/42/merge' }));
    const token = await signToken(prTokenClaims);
    const response = await request(harness, `/v1/operations/${operationId}`, { headers: bearer(token) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ sourceCommit: HEAD_SHA });
  });
});

describe('internal workflow dispatch', () => {
  it('requires the internal token', async () => {
    const harness = createHarness();
    const response = await request(harness, '/internal/workflows/apply', { method: 'POST', body: JSON.stringify({ applicationId: 'app-demo' }), headers: { 'content-type': 'application/json' } });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-WORKFLOW-AUTH-REQUIRED' } });
  });

  it('dispatches phase handlers via :kind/:phase', async () => {
    const harness = createHarness();
    const response = await request(harness, '/internal/workflows/apply/validate-request', {
      method: 'POST',
      body: JSON.stringify({ applicationId: 'app-demo' }),
      headers: { 'content-type': 'application/json', 'x-launchpad-workflow-token': 'internal-token' },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ phase: 'validated' });
    expect(harness.handlersCalled).toContain('apply/validate-request');
  });

  it('redacts provider bodies from handler failures', async () => {
    const harness = createHarness();
    const response = await request(harness, '/internal/workflows/failing', {
      method: 'POST',
      body: JSON.stringify({ applicationId: 'app-demo' }),
      headers: { 'content-type': 'application/json', 'x-launchpad-workflow-token': 'internal-token' },
    });
    expect(response.status).toBe(500);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('LP-WORKFLOW-STEP-FAILED');
    expect(body.error.message).not.toContain('super-secret-token-value');
  });

  it('preserves LP-* error codes and marks the run failed only for untracked runs', async () => {
    const harness = createHarness();
    const token = await signToken(baseClaims());
    const enqueue = await request(harness, '/v1/applications/app-demo/preview/verify', { method: 'POST', body: JSON.stringify(baseBody()), headers: { 'content-type': 'application/json', ...bearer(token) } });
    const { operationId } = await enqueue.json() as { operationId: string };
    const response = await request(harness, '/internal/workflows/coded-failure', {
      method: 'POST',
      body: JSON.stringify({ applicationId: 'app-demo', operationId }),
      headers: { 'content-type': 'application/json', 'x-launchpad-workflow-token': 'internal-token' },
    });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-CONTROL-APPLICATION-NOT_FOUND' } });
    const run = await harness.store.getWorkflowRun(operationId);
    expect(run?.status).toBe('FAILED');
    expect(run?.errorCode).toBe('LP-CONTROL-APPLICATION-NOT_FOUND');
  });
});

describe('operator dashboard reads', () => {
  const readPaths = [
    '/v1/applications',
    '/v1/applications/app-demo',
    '/v1/applications/app-demo/resources',
    '/v1/applications/app-demo/plan',
    '/v1/applications/app-demo/operations',
    '/v1/applications/app-demo/operations/op-1',
    '/v1/applications/app-demo/deployments',
    '/v1/applications/app-demo/health',
    '/v1/applications/app-demo/drift',
    '/v1/applications/app-demo/audit',
    '/v1/credentials',
  ];

  it('requires operator authentication on every read endpoint', async () => {
    const harness = createHarness();
    for (const path of readPaths) {
      const response = await request(harness, path);
      expect(response.status, path).toBe(401);
      await expect(response.json(), path).resolves.toMatchObject({ error: { code: 'LP-OPERATOR-AUTH-REQUIRED' } });
    }
  });

  it('fails closed without durable persistence', async () => {
    const harness = createHarness({ store: undefined });
    const response = await request(harness, '/v1/applications', { headers: bearer('operator-token') });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-PERSISTENCE-CONFIG-MISSING' } });
  });

  it('rejects invalid list limits and honors bounded pagination truthfully', async () => {
    const harness = createHarness();
    for (let index = 0; index < 3; index += 1) {
      await harness.store.upsertApplication({ id: `app-${index}`, displayName: `App ${index}`, sourcePath: `catalog/apps/app-${index}.yaml`, desiredGeneration: 1, desiredHash: '', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
    }
    const invalid = await request(harness, '/v1/applications?limit=0', { headers: bearer('operator-token') });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: { code: 'LP-QUERY-LIMIT-INVALID' } });
    const response = await request(harness, '/v1/applications?limit=2', { headers: bearer('operator-token') });
    expect(response.status).toBe(200);
    const body = await response.json() as { applications: Array<Record<string, unknown>>; truncated: boolean; limit: number };
    expect(body.limit).toBe(2);
    expect(body.truncated).toBe(true);
    expect(body.applications).toHaveLength(2);
    expect(body.applications[0]).toMatchObject({ application: 'app-0', owner: 'unassigned', sync: 'UNKNOWN', health: 'UNKNOWN' });
  });

  it('serializes application detail with separated status dimensions from store rows', async () => {
    const harness = createHarness();
    await harness.store.upsertApplication({ id: 'app-demo', displayName: 'Demo', sourcePath: 'catalog/apps/app-demo.yaml', desiredGeneration: 3, desiredHash: 'abc', syncStatus: 'OUT_OF_SYNC', healthStatus: 'UNHEALTHY', lifecycleState: 'active', owners: ['ops@acme'] });
    const run = await harness.store.startWorkflowRun({ applicationId: 'app-demo', workflowType: 'apply', idempotencyKey: 'k1', payloadHash: 'h1' });
    await harness.store.recordDeployment({ id: 'dep-1', applicationId: 'app-demo', projectId: 'p1', environment: 'production', repository: 'acme/app', commitSha: 'c'.repeat(40), desiredGeneration: 3, state: 'CURRENT', url: 'https://app-demo.example.com', createdAt: '2026-08-04T00:00:00.000Z' });
    await harness.store.recordKnownGoodDeployment('app-demo', 'production', 'dep-1');
    const response = await request(harness, '/v1/applications/app-demo', { headers: bearer('operator-token') });
    expect(response.status).toBe(200);
    const body = await response.json() as { application: Record<string, unknown>; operations: Array<Record<string, unknown>>; knownGoodDeployment: Record<string, unknown> };
    expect(body.application).toMatchObject({ application: 'app-demo', owner: 'ops@acme', sync: 'OUT_OF_SYNC', health: 'UNHEALTHY', deployment: 'CURRENT', currentDeploymentCommit: 'c'.repeat(40), productionUrl: 'https://app-demo.example.com', desiredGeneration: 3 });
    expect(body.operations).toHaveLength(1);
    expect(body.operations[0]).toMatchObject({ id: run.id, applicationId: 'app-demo', action: 'apply', status: 'QUEUED', idempotencyKey: 'k1' });
    expect(body.knownGoodDeployment).toMatchObject({ id: 'dep-1', state: 'CURRENT' });
  });

  it('returns 404 for an unknown application detail', async () => {
    const harness = createHarness();
    const response = await request(harness, '/v1/applications/ghost', { headers: bearer('operator-token') });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-APPLICATION-NOT-FOUND' } });
  });

  it('serves resources, plans, deployments, health, drift, audit and credentials from the store', async () => {
    const harness = createHarness();
    await harness.store.upsertApplication({ id: 'app-demo', displayName: 'Demo', sourcePath: 'catalog/apps/app-demo.yaml', desiredGeneration: 2, desiredHash: '', syncStatus: 'SYNCED', healthStatus: 'HEALTHY', lifecycleState: 'active' });
    await harness.store.upsertResource({ applicationId: 'app-demo', provider: 'vercel', resourceType: 'vercel.project', resourceKey: 'vercel.project', providerResourceId: 'prj_1', desiredGeneration: 2, observedHash: 'oh', ownershipFingerprint: 'fp', firstSeenAt: '2026-08-04T00:00:00.000Z', lastSeenAt: '2026-08-04T01:00:00.000Z' });
    await harness.store.recordObservation({ applicationId: 'app-demo', observedHash: 'oh', payload: { applicationId: 'app-demo', observedAt: '2026-08-04T01:00:00.000Z', desiredGeneration: 2, desiredHash: '', observedHash: 'oh', resources: [{ provider: 'vercel', resourceType: 'vercel.project', providerResourceId: 'prj_1', resourceKey: 'vercel.project', configuration: { rootDirectory: 'src' }, ownershipFingerprint: 'fp', observedAt: '2026-08-04T01:00:00.000Z' }], deployments: [], health: { status: 'HEALTHY', latest: null } } });
    const plan: PlatformPlan = { schemaVersion: 'launchpad.plan/v1', applicationId: 'app-demo', desiredGeneration: 2, sourceCommit: 'c'.repeat(40), createdAt: '2026-08-04T00:00:00.000Z', capabilitySnapshotHash: 'ch', observedStateHash: 'sh', operations: [{ id: 'op-1', resourceKey: 'vercel.project', provider: 'vercel', resourceType: 'vercel.project', action: 'UPDATE_IN_PLACE', before: null, after: null, prerequisites: [], invalidates: [], idempotencyKey: 'ik', destructive: false, retryClass: 'NONE' }], downstreamEffects: [], policyResults: [], fingerprint: 'pf', result: 'READY' };
    const storedPlan = await harness.store.savePlan({ applicationId: 'app-demo', plan });
    await harness.store.replacePlanOperations(storedPlan.id, plan.operations);
    await harness.store.recordDeployment({ id: 'dep-1', applicationId: 'app-demo', projectId: 'p1', environment: 'production', repository: 'acme/app', commitSha: 'c'.repeat(40), desiredGeneration: 2, state: 'CURRENT', url: 'https://app-demo.example.com', createdAt: '2026-08-04T00:00:00.000Z' });
    await harness.store.recordHealthCheck({ id: 'hc-1', applicationId: 'app-demo', environment: 'production', deploymentId: 'dep-1', url: 'https://app-demo.example.com/api/health', attempt: 1, dnsResolved: true, tlsValid: true, statusCode: 200, latencyMs: 42, assertionResults: [], result: 'PASSED', checkedAt: '2026-08-04T00:30:00.000Z', errorCode: null });
    await harness.store.recordDriftEvent({ applicationId: 'app-demo', fingerprint: 'df-1', category: 'CHANGED_SETTING', payload: { resourceKey: 'vercel.project.rootDirectory', desired: '.', observed: 'src' } });
    await harness.store.appendAudit({ actor: 'operator:dashboard', action: 'TEST_EVENT', applicationId: 'app-demo', details: { note: 'hello' } });
    await harness.store.upsertCredentialMetadata({ id: 'cred-1', provider: 'vercel', purpose: 'controller', valueFingerprint: 'vf', lastCheckedAt: '2026-08-04T00:00:00.000Z', status: 'VALID' });

    const resources = await (await request(harness, '/v1/applications/app-demo/resources', { headers: bearer('operator-token') })).json() as { resources: Array<Record<string, unknown>> };
    expect(resources.resources[0]).toMatchObject({ provider: 'vercel', resourceType: 'vercel.project', providerResourceId: 'prj_1', ownershipFingerprint: 'fp', observedAt: '2026-08-04T01:00:00.000Z' });
    expect(resources.resources[0]?.configuration).toEqual({ rootDirectory: 'src' });

    const plans = await (await request(harness, '/v1/applications/app-demo/plan', { headers: bearer('operator-token') })).json() as { plans: Array<Record<string, unknown>> };
    expect(plans.plans[0]).toMatchObject({ fingerprint: 'pf', sourceCommit: 'c'.repeat(40), result: 'READY', operationCount: 1 });
    expect(plans.plans[0]?.operations).toEqual([{ id: 'op-1', resourceKey: 'vercel.project', action: 'UPDATE_IN_PLACE', destructive: false }]);

    const operations = await (await request(harness, '/v1/applications/app-demo/operations', { headers: bearer('operator-token') })).json() as { operations: Array<Record<string, unknown>> };
    expect(operations.operations).toEqual([]);

    const deployments = await (await request(harness, '/v1/applications/app-demo/deployments', { headers: bearer('operator-token') })).json() as { deployments: Array<Record<string, unknown>> };
    expect(deployments.deployments[0]).toMatchObject({ id: 'dep-1', environment: 'production', state: 'CURRENT', commitSha: 'c'.repeat(40), url: 'https://app-demo.example.com' });

    const health = await (await request(harness, '/v1/applications/app-demo/health', { headers: bearer('operator-token') })).json() as { checks: Array<Record<string, unknown>> };
    expect(health.checks[0]).toMatchObject({ environment: 'production', result: 'PASSED', statusCode: 200, latencyMs: 42, url: 'https://app-demo.example.com/api/health' });

    const drift = await (await request(harness, '/v1/applications/app-demo/drift', { headers: bearer('operator-token') })).json() as { drift: Array<Record<string, unknown>> };
    expect(drift.drift[0]).toMatchObject({ fingerprint: 'df-1', category: 'CHANGED_SETTING', resourceKey: 'vercel.project.rootDirectory', desired: '.', observed: 'src' });

    const audit = await (await request(harness, '/v1/applications/app-demo/audit', { headers: bearer('operator-token') })).json() as { events: Array<Record<string, unknown>> };
    expect(audit.events.some((event) => event.action === 'TEST_EVENT')).toBe(true);

    const credentials = await (await request(harness, '/v1/credentials', { headers: bearer('operator-token') })).json() as { credentials: Array<Record<string, unknown>> };
    expect(credentials.credentials[0]).toMatchObject({ id: 'cred-1', provider: 'vercel', purpose: 'controller', status: 'VALID', valueFingerprint: 'vf' });
  });

  it('exposes operation steps with redacted errors and safe result projections', async () => {
    const harness = createHarness();
    await harness.store.upsertApplication({ id: 'app-demo', displayName: 'Demo', sourcePath: 'catalog/apps/app-demo.yaml', desiredGeneration: 1, desiredHash: '', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
    const run = await harness.store.startWorkflowRun({ applicationId: 'app-demo', workflowType: 'apply', idempotencyKey: 'k2', payloadHash: 'h2' });
    await harness.store.recordWorkflowStep({ workflowId: run.id, stepId: 'execute', status: 'FAILED', attempt: 1, preconditionHash: 'h2', error: { code: 'LP-BUILD-FAILED', message: 'provider body leaked: super-secret-token-value' } });
    await harness.store.recordWorkflowStep({ workflowId: run.id, stepId: 'validate-request', status: 'SUCCEEDED', attempt: 1, preconditionHash: 'h2', result: { ok: true } });
    const response = await request(harness, `/v1/applications/app-demo/operations/${run.id}`, { headers: bearer('operator-token') });
    expect(response.status).toBe(200);
    const body = await response.json() as { operation: Record<string, unknown>; steps: Array<{ stepId: string; status: string; error: { code: string; message: string } | null }> };
    expect(body.operation).toMatchObject({ id: run.id, action: 'apply', status: 'QUEUED' });
    expect(body.steps).toHaveLength(2);
    const execute = body.steps.find((step) => step.stepId === 'execute');
    expect(execute).toMatchObject({ status: 'FAILED', attempt: 1, error: { code: 'LP-BUILD-FAILED', message: 'provider body leaked: super-secret-token-value' } });
    const validated = body.steps.find((step) => step.stepId === 'validate-request');
    expect(validated?.error).toBeNull();
  });

  it('never upgrades provider read failures into healthy or synced statuses', async () => {
    const harness = createHarness();
    await harness.store.upsertApplication({ id: 'app-demo', displayName: 'Demo', sourcePath: 'catalog/apps/app-demo.yaml', desiredGeneration: 1, desiredHash: '', syncStatus: 'BLOCKED', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
    const response = await request(harness, '/v1/applications', { headers: bearer('operator-token') });
    const body = await response.json() as { applications: Array<Record<string, unknown>> };
    expect(body.applications[0]).toMatchObject({ sync: 'BLOCKED', health: 'UNKNOWN', deployment: null, productionUrl: null });
  });

  it('survives hostile persisted audit details without crashing or leaking', async () => {
    const harness = createHarness();
    await harness.store.upsertApplication({ id: 'app-demo', displayName: 'Demo', sourcePath: 'catalog/apps/app-demo.yaml', desiredGeneration: 1, desiredHash: '', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
    await harness.store.appendAudit({ actor: 'hostile', action: 'XSS_TEST', applicationId: 'app-demo', details: { note: '<script>alert(1)</script>', nested: ['<img src=x onerror=alert(1)>'] } });
    const response = await request(harness, '/v1/applications/app-demo/audit', { headers: bearer('operator-token') });
    expect(response.status).toBe(200);
    const body = await response.json() as { events: Array<{ details: Record<string, unknown> }> };
    expect(body.events[0]?.details.note).toBe('<script>alert(1)</script>');
  });

  it('returns a typed error, never a fabricated partial success, when a read fails', async () => {
    const harness = createHarness();
    await harness.store.upsertApplication({ id: 'app-demo', displayName: 'Demo', sourcePath: 'catalog/apps/app-demo.yaml', desiredGeneration: 1, desiredHash: '', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
    const failing = harness.store;
    const original = failing.listWorkflowRuns.bind(failing);
    failing.listWorkflowRuns = async () => {
      throw new Error('D1 unavailable');
    };
    try {
      const response = await request(harness, '/v1/applications/app-demo', { headers: bearer('operator-token') });
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-INTERNAL-ERROR', retryable: true } });
    } finally {
      failing.listWorkflowRuns = original;
    }
  });
});

describe('operator recovery actions', () => {
  async function seedApplication(harness: TestHarness): Promise<void> {
    await harness.store.upsertApplication({ id: 'app-demo', displayName: 'Demo', sourcePath: 'catalog/apps/app-demo.yaml', desiredGeneration: 1, desiredHash: '', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
  }

  async function startFailedRun(harness: TestHarness): Promise<string> {
    const token = await signToken(baseClaims());
    const response = await request(harness, '/v1/applications/app-demo/preview/verify', { method: 'POST', body: JSON.stringify(baseBody()), headers: { 'content-type': 'application/json', ...bearer(token) } });
    expect(response.status).toBe(202);
    const { operationId } = await response.json() as { operationId: string };
    await harness.store.updateWorkflowRun(operationId, { status: 'FAILED', completedAt: new Date().toISOString(), errorCode: 'LP-BUILD-FAILED' });
    return operationId;
  }

  it('retries a failed operation as a new audited durable run', async () => {
    const harness = createHarness();
    const operationId = await startFailedRun(harness);
    const before = harness.workflowCalls.length;
    const response = await request(harness, '/v1/applications/app-demo/actions/retry', { method: 'POST', body: JSON.stringify({ operationId }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(response.status).toBe(202);
    const body = await response.json() as { workflowId: string; operationId: string; status: string; retriedOperationId: string };
    expect(body.retriedOperationId).toBe(operationId);
    expect(body.operationId).not.toBe(operationId);
    expect(body.workflowId).toMatch(/^lp-app-preview-status-/);
    expect(harness.workflowCalls).toHaveLength(before + 1);
    expect(harness.workflowCalls.at(-1)?.params).toMatchObject({ applicationId: 'app-demo', sourceCommit: PUSH_SHA, desiredGeneration: 2, planFingerprint: PLAN_FINGERPRINT, kind: 'app-preview-status' });
    expect((harness.workflowCalls.at(-1)?.params as Record<string, unknown>).operationId).toBe(body.operationId);
    const retryRun = await harness.store.getWorkflowRun(body.operationId);
    expect(retryRun).toMatchObject({ status: 'QUEUED', workflowType: 'app-preview-status', idempotencyKey: `retry:${operationId}` });
    const audit = await harness.store.listAudit('app-demo');
    expect(audit.some((event) => event.action === 'OPERATOR_RETRY' && event.details?.retryOperationId === body.operationId)).toBe(true);
  });

  it('replays the same retry request idempotently without duplicate runs', async () => {
    const harness = createHarness();
    const operationId = await startFailedRun(harness);
    const first = await request(harness, '/v1/applications/app-demo/actions/retry', { method: 'POST', body: JSON.stringify({ operationId }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    const firstBody = await first.json() as { operationId: string };
    const second = await request(harness, '/v1/applications/app-demo/actions/retry', { method: 'POST', body: JSON.stringify({ operationId }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(second.status).toBe(202);
    await expect(second.json()).resolves.toMatchObject({ operationId: firstBody.operationId });
    const runs = await harness.store.listWorkflowRuns('app-demo');
    expect(runs.filter((run) => run.idempotencyKey === `retry:${operationId}`)).toHaveLength(1);
  });

  it('refuses to retry operations that are not failed and unknown operations', async () => {
    const harness = createHarness();
    const token = await signToken(baseClaims());
    const enqueue = await request(harness, '/v1/applications/app-demo/preview/verify', { method: 'POST', body: JSON.stringify(baseBody()), headers: { 'content-type': 'application/json', ...bearer(token) } });
    const { operationId } = await enqueue.json() as { operationId: string };
    const notFailed = await request(harness, '/v1/applications/app-demo/actions/retry', { method: 'POST', body: JSON.stringify({ operationId }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(notFailed.status).toBe(409);
    await expect(notFailed.json()).resolves.toMatchObject({ error: { code: 'LP-RETRY-NOT-FAILED' } });
    const unknown = await request(harness, '/v1/applications/app-demo/actions/retry', { method: 'POST', body: JSON.stringify({ operationId: '0000000000000000' }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(unknown.status).toBe(404);
    const missing = await request(harness, '/v1/applications/app-demo/actions/retry', { method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({ error: { code: 'LP-RETRY-OPERATION-ID-REQUIRED' } });
  });

  it('rejects retry when the original enqueue params were not recorded', async () => {
    const harness = createHarness();
    await seedApplication(harness);
    const run = await harness.store.startWorkflowRun({ applicationId: 'app-demo', workflowType: 'health-check', idempotencyKey: 'hc-1', payloadHash: 'h' });
    await harness.store.updateWorkflowRun(run.id, { status: 'FAILED', errorCode: 'LP-CHECK-FAILED' });
    const response = await request(harness, '/v1/applications/app-demo/actions/retry', { method: 'POST', body: JSON.stringify({ operationId: run.id }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-RETRY-PARAMS-UNAVAILABLE' } });
  });

  it('rejects retry when the recorded enqueue params are malformed instead of guessing values', async () => {
    const harness = createHarness();
    await seedApplication(harness);
    const run = await harness.store.startWorkflowRun({ applicationId: 'app-demo', workflowType: 'app-preview', idempotencyKey: 'malformed-1', payloadHash: 'h' });
    await harness.store.updateWorkflowRun(run.id, { status: 'FAILED', errorCode: 'LP-BUILD-FAILED' });
    await harness.store.appendAudit({ actor: 'oidc:acme/web-app', action: 'OIDC_OPERATION_START', applicationId: 'app-demo', details: { operationId: run.id, workflowId: 'w', kind: 'app-preview', params: { version: 1, kind: 'app-preview', applicationId: 'app-demo' } } });
    const response = await request(harness, '/v1/applications/app-demo/actions/retry', { method: 'POST', body: JSON.stringify({ operationId: run.id }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-RETRY-PARAMS-MALFORMED' } });
    expect(harness.workflowCalls).toHaveLength(0);
  });

  it('rechecks health through the queue with a durable audited operation', async () => {
    const harness = createHarness();
    await seedApplication(harness);
    const sent: Array<Record<string, unknown>> = [];
    harness.env.HEALTH_CHECKS = { send: async (envelope: unknown) => { sent.push(envelope as Record<string, unknown>); } };
    const response = await request(harness, '/v1/applications/app-demo/actions/recheck', { method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(response.status).toBe(202);
    const body = await response.json() as { workflowId: string; operationId: string; status: string; dispatched: string };
    expect(body.dispatched).toBe('queue');
    expect(body.status).toBe('QUEUED');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'health-check', payload: { applicationId: 'app-demo', operationId: body.operationId } });
    const run = await harness.store.getWorkflowRun(body.operationId);
    expect(run).toMatchObject({ workflowType: 'health-check', status: 'QUEUED' });
    const audit = await harness.store.listAudit('app-demo');
    expect(audit.some((event) => event.action === 'OPERATOR_RECHECK' && event.details?.dispatched === 'queue')).toBe(true);
    // Replay of the same request never dispatches a duplicate check.
    const replay = await request(harness, '/v1/applications/app-demo/actions/recheck', { method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(replay.status).toBe(202);
    await expect(replay.json()).resolves.toMatchObject({ operationId: body.operationId, replay: true });
    expect(sent).toHaveLength(1);
  });

  it('runs recheck synchronously through a registered health-check handler', async () => {
    const harness = createHarness();
    await seedApplication(harness);
    const handlerCalls: Array<Record<string, unknown>> = [];
    harness.env.HEALTH_CHECKS = undefined;
    harness.app = createControllerApp({
      operatorToken: 'operator-token',
      oidc: OIDC,
      internalWorkflowToken: 'internal-token',
      githubToken: 'ghp_controller',
      store: harness.store,
      repositories: new LaunchpadRepositories(new InMemoryDatabase()),
      workflowHandlers: {
        'health-check': async (payload) => {
          handlerCalls.push(payload);
          return { check: { result: 'PASSED', checkedAt: '2026-08-04T00:00:00.000Z' } };
        },
      },
    });
    const response = await request(harness, '/v1/applications/app-demo/actions/recheck', { method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(response.status).toBe(202);
    const body = await response.json() as { operationId: string; status: string; dispatched: string };
    expect(body.dispatched).toBe('handler');
    expect(body.status).toBe('SUCCEEDED');
    expect(handlerCalls).toHaveLength(1);
    const run = await harness.store.getWorkflowRun(body.operationId);
    expect(run?.status).toBe('SUCCEEDED');
    const steps = await harness.store.listWorkflowSteps(body.operationId);
    expect(steps.some((step) => step.stepId === 'execute' && step.status === 'SUCCEEDED')).toBe(true);
  });

  it('rolls back to the recorded known-good deployment through the rollback handler', async () => {
    const harness = createHarness();
    await seedApplication(harness);
    const rollbackCalls: Array<Record<string, unknown>> = [];
    harness.app = createControllerApp({
      operatorToken: 'operator-token',
      oidc: OIDC,
      internalWorkflowToken: 'internal-token',
      githubToken: 'ghp_controller',
      store: harness.store,
      repositories: new LaunchpadRepositories(new InMemoryDatabase()),
      workflowHandlers: {
        rollback: async (payload) => {
          rollbackCalls.push(payload);
          return { deploymentId: payload.failedDeploymentId, restored: true };
        },
      },
    });
    await harness.store.recordDeployment({ id: 'dep-good', applicationId: 'app-demo', projectId: 'prj', environment: 'production', repository: 'acme/app', commitSha: 'a'.repeat(40), desiredGeneration: 1, state: 'CURRENT', url: 'https://good.example.com', createdAt: '2026-08-04T00:00:00.000Z' });
    await harness.store.recordKnownGoodDeployment('app-demo', 'production', 'dep-good');
    await harness.store.recordDeployment({ id: 'dep-bad', applicationId: 'app-demo', projectId: 'prj', environment: 'production', repository: 'acme/app', commitSha: 'b'.repeat(40), desiredGeneration: 2, state: 'READY', url: 'https://bad.example.com', createdAt: '2026-08-04T01:00:00.000Z' });
    const response = await request(harness, '/v1/applications/app-demo/actions/rollback', { method: 'POST', body: JSON.stringify({ deploymentId: 'dep-bad' }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(response.status).toBe(200);
    const body = await response.json() as { operationId: string; status: string; failedDeploymentId: string; knownGoodDeploymentId: string };
    expect(body).toMatchObject({ status: 'SUCCEEDED', failedDeploymentId: 'dep-bad', knownGoodDeploymentId: 'dep-good' });
    expect(rollbackCalls[0]).toMatchObject({ applicationId: 'app-demo', failedDeploymentId: 'dep-bad', knownGoodDeploymentId: 'dep-good' });
    const run = await harness.store.getWorkflowRun(body.operationId);
    expect(run).toMatchObject({ workflowType: 'rollback', status: 'SUCCEEDED' });
    const steps = await harness.store.listWorkflowSteps(body.operationId);
    expect(steps.some((step) => step.stepId === 'execute' && step.status === 'SUCCEEDED')).toBe(true);
    const audit = await harness.store.listAudit('app-demo');
    expect(audit.some((event) => event.action === 'OPERATOR_ROLLBACK')).toBe(true);
    // Replay returns the recorded result without touching the provider again.
    const replay = await request(harness, '/v1/applications/app-demo/actions/rollback', { method: 'POST', body: JSON.stringify({ deploymentId: 'dep-bad' }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ operationId: body.operationId, replayed: true });
    expect(rollbackCalls).toHaveLength(1);
  });

  it('refuses rollback without a known-good deployment or when already on known-good', async () => {
    const harness = createHarness();
    await seedApplication(harness);
    const withoutKnownGood = await request(harness, '/v1/applications/app-demo/actions/rollback', { method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(withoutKnownGood.status).toBe(409);
    await expect(withoutKnownGood.json()).resolves.toMatchObject({ error: { code: 'LP-ROLLBACK-NO-KNOWN-GOOD' } });
    await harness.store.recordDeployment({ id: 'dep-good', applicationId: 'app-demo', projectId: 'prj', environment: 'production', repository: 'acme/app', commitSha: 'a'.repeat(40), desiredGeneration: 1, state: 'CURRENT', url: 'https://good.example.com', createdAt: '2026-08-04T00:00:00.000Z' });
    await harness.store.recordKnownGoodDeployment('app-demo', 'production', 'dep-good', '2026-08-04T00:00:00.000Z');
    const alreadyKnownGood = await request(harness, '/v1/applications/app-demo/actions/rollback', { method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(alreadyKnownGood.status).toBe(409);
    await expect(alreadyKnownGood.json()).resolves.toMatchObject({ error: { code: 'LP-ROLLBACK-ALREADY-KNOWN-GOOD' } });
  });

  it('refuses rollback when no rollback handler is configured', async () => {
    const harness = createHarness();
    await seedApplication(harness);
    await harness.store.recordDeployment({ id: 'dep-good', applicationId: 'app-demo', projectId: 'prj', environment: 'production', repository: 'acme/app', commitSha: 'a'.repeat(40), desiredGeneration: 1, state: 'CURRENT', url: 'https://good.example.com', createdAt: '2026-08-04T00:00:00.000Z' });
    await harness.store.recordKnownGoodDeployment('app-demo', 'production', 'dep-good', '2026-08-04T00:00:00.000Z');
    await harness.store.recordDeployment({ id: 'dep-bad', applicationId: 'app-demo', projectId: 'prj', environment: 'production', repository: 'acme/app', commitSha: 'b'.repeat(40), desiredGeneration: 2, state: 'READY', url: 'https://bad.example.com', createdAt: '2026-08-04T01:00:00.000Z' });
    const response = await request(harness, '/v1/applications/app-demo/actions/rollback', { method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-ROLLBACK-HANDLER-UNAVAILABLE' } });
  });

  it('redacts rollback handler failures and marks the run failed', async () => {
    const harness = createHarness();
    await seedApplication(harness);
    harness.app = createControllerApp({
      operatorToken: 'operator-token',
      oidc: OIDC,
      internalWorkflowToken: 'internal-token',
      githubToken: 'ghp_controller',
      store: harness.store,
      repositories: new LaunchpadRepositories(new InMemoryDatabase()),
      workflowHandlers: {
        rollback: async () => {
          throw new Error('provider body leaked: super-secret-token-value');
        },
      },
    });
    await harness.store.recordDeployment({ id: 'dep-good', applicationId: 'app-demo', projectId: 'prj', environment: 'production', repository: 'acme/app', commitSha: 'a'.repeat(40), desiredGeneration: 1, state: 'CURRENT', url: 'https://good.example.com', createdAt: '2026-08-04T00:00:00.000Z' });
    await harness.store.recordKnownGoodDeployment('app-demo', 'production', 'dep-good');
    await harness.store.recordDeployment({ id: 'dep-bad', applicationId: 'app-demo', projectId: 'prj', environment: 'production', repository: 'acme/app', commitSha: 'b'.repeat(40), desiredGeneration: 2, state: 'READY', url: 'https://bad.example.com', createdAt: '2026-08-04T01:00:00.000Z' });
    const response = await request(harness, '/v1/applications/app-demo/actions/rollback', { method: 'POST', body: JSON.stringify({ deploymentId: 'dep-bad' }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(response.status).toBe(500);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('LP-WORKFLOW-STEP-FAILED');
    expect(body.error.message).not.toContain('super-secret-token-value');
    const runs = await harness.store.listWorkflowRuns('app-demo');
    const rollbackRun = runs.find((run) => run.workflowType === 'rollback');
    expect(rollbackRun?.status).toBe('FAILED');
  });
});

describe('operator cancel action', () => {
  async function seedApplication(harness: TestHarness): Promise<void> {
    await harness.store.upsertApplication({ id: 'app-demo', displayName: 'Demo', sourcePath: 'catalog/apps/app-demo.yaml', desiredGeneration: 1, desiredHash: '', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
  }

  let queuedRunSeq = 0;
  async function startQueuedRun(harness: TestHarness): Promise<string> {
    queuedRunSeq += 1;
    const run = await harness.store.startWorkflowRun({ applicationId: 'app-demo', workflowType: 'apply', idempotencyKey: `ik-cancel-run-${queuedRunSeq}`, payloadHash: `p-${queuedRunSeq}` });
    return run.id;
  }

  function cancelRequest(harness: TestHarness, operationId: string, overrides: { idempotencyKey?: string; headers?: Record<string, string> } = {}): Promise<Response> {
    const { idempotencyKey = 'cancel-key-1', headers = {} } = overrides;
    return request(harness, '/v1/applications/app-demo/actions/cancel', { method: 'POST', body: JSON.stringify({ operationId, idempotencyKey }), headers: { 'content-type': 'application/json', ...bearer('operator-token'), ...headers } });
  }

  it('requires operator authentication', async () => {
    const harness = createHarness();
    const denied = await request(harness, '/v1/applications/app-demo/actions/cancel', { method: 'POST', body: JSON.stringify({ operationId: 'op-1', idempotencyKey: 'k' }), headers: { 'content-type': 'application/json' } });
    expect(denied.status).toBe(401);
    await expect(denied.json()).resolves.toMatchObject({ error: { code: 'LP-OPERATOR-AUTH-REQUIRED' } });
  });

  it('requires operationId and an idempotency key', async () => {
    const harness = createHarness();
    const missingOperation = await cancelRequest(harness, '', { idempotencyKey: 'k' });
    expect(missingOperation.status).toBe(400);
    await expect(missingOperation.json()).resolves.toMatchObject({ error: { code: 'LP-CANCEL-OPERATION-ID-REQUIRED' } });
    const missingKey = await cancelRequest(harness, 'op-1', { idempotencyKey: '' });
    expect(missingKey.status).toBe(400);
    await expect(missingKey.json()).resolves.toMatchObject({ error: { code: 'LP-IDEMPOTENCY-KEY-REQUIRED' } });
    // The key may come from the idempotency-key header instead of the body.
    const headerKey = await request(harness, '/v1/applications/app-demo/actions/cancel', { method: 'POST', body: JSON.stringify({ operationId: 'op-missing' }), headers: { 'content-type': 'application/json', 'idempotency-key': 'header-key-1', ...bearer('operator-token') } });
    expect(headerKey.status).toBe(404);
  });

  it('cancels exactly the matching QUEUED run and records the immutable audit', async () => {
    const harness = createHarness();
    await seedApplication(harness);
    const operationId = await startQueuedRun(harness);
    const response = await cancelRequest(harness, operationId);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ workflowId: operationId, operationId, status: 'CANCELED', replay: false });
    const run = await harness.store.getWorkflowRun(operationId);
    expect(run).toMatchObject({ status: 'CANCELED' });
    expect(run?.completedAt).not.toBeNull();
    const audit = await harness.store.listAudit('app-demo');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: 'operator:dashboard', action: 'OPERATOR_CANCEL', applicationId: 'app-demo' });
    expect(audit[0]?.details).toEqual({ operationId, idempotencyKey: 'cancel-key-1', status: 'CANCELED' });
  });

  it('replays a successful cancel idempotently without a second state change or audit event', async () => {
    const harness = createHarness();
    await seedApplication(harness);
    const operationId = await startQueuedRun(harness);
    const first = await cancelRequest(harness, operationId);
    expect(first.status).toBe(200);
    const replay = await cancelRequest(harness, operationId);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ operationId, status: 'CANCELED', replay: true });
    const run = await harness.store.getWorkflowRun(operationId);
    expect(run?.status).toBe('CANCELED');
    expect((await harness.store.listAudit('app-demo')).filter((event) => event.action === 'OPERATOR_CANCEL')).toHaveLength(1);
  });

  it('refuses a replayed idempotency key bound to a different operation', async () => {
    const harness = createHarness();
    await seedApplication(harness);
    const first = await startQueuedRun(harness);
    const second = await startQueuedRun(harness);
    await cancelRequest(harness, first, { idempotencyKey: 'shared-key' });
    const mismatched = await cancelRequest(harness, second, { idempotencyKey: 'shared-key' });
    expect(mismatched.status).toBe(409);
    await expect(mismatched.json()).resolves.toMatchObject({ error: { code: 'LP-IDEMPOTENCY-CONFLICT' } });
    expect((await harness.store.getWorkflowRun(second))?.status).toBe('QUEUED');
  });

  it('never cancels a RUNNING operation', async () => {
    const harness = createHarness();
    await seedApplication(harness);
    const operationId = await startQueuedRun(harness);
    await harness.store.updateWorkflowRun(operationId, { status: 'RUNNING' });
    const response = await cancelRequest(harness, operationId);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-CANCEL-RUNNING' } });
    expect((await harness.store.getWorkflowRun(operationId))?.status).toBe('RUNNING');
    expect(await harness.store.listAuditAll()).toHaveLength(0);
  });

  it('refuses cancel of terminal and mid-machine runs', async () => {
    const harness = createHarness();
    await seedApplication(harness);
    const succeeded = await startQueuedRun(harness);
    await harness.store.updateWorkflowRun(succeeded, { status: 'SUCCEEDED', completedAt: '2026-08-04T00:00:05.000Z' });
    const terminal = await cancelRequest(harness, succeeded);
    expect(terminal.status).toBe(409);
    await expect(terminal.json()).resolves.toMatchObject({ error: { code: 'LP-CANCEL-TERMINAL' } });
    const promoting = await startQueuedRun(harness);
    await harness.store.updateWorkflowRun(promoting, { status: 'PROMOTING' });
    const midMachine = await cancelRequest(harness, promoting);
    expect(midMachine.status).toBe(409);
    await expect(midMachine.json()).resolves.toMatchObject({ error: { code: 'LP-CANCEL-NOT-QUEUED' } });
    expect((await harness.store.getWorkflowRun(succeeded))?.status).toBe('SUCCEEDED');
    expect((await harness.store.getWorkflowRun(promoting))?.status).toBe('PROMOTING');
    expect(await harness.store.listAuditAll()).toHaveLength(0);
  });

  it('returns 404 for unknown and foreign operations', async () => {
    const harness = createHarness();
    await seedApplication(harness);
    const unknown = await cancelRequest(harness, '0000000000000000');
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toMatchObject({ error: { code: 'LP-OPERATION-NOT-FOUND' } });
    await harness.store.upsertApplication({ id: 'other-app', displayName: 'Other', sourcePath: 'catalog/apps/other-app.yaml', desiredGeneration: 1, desiredHash: '', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
    const foreign = await harness.store.startWorkflowRun({ applicationId: 'other-app', workflowType: 'apply', idempotencyKey: 'ik-other', payloadHash: 'p' });
    const foreignResponse = await cancelRequest(harness, foreign.id);
    expect(foreignResponse.status).toBe(409);
    await expect(foreignResponse.json()).resolves.toMatchObject({ error: { code: 'LP-CANCEL-OPERATION-FOREIGN' } });
    expect((await harness.store.getWorkflowRun(foreign.id))?.status).toBe('QUEUED');
    expect(await harness.store.listAuditAll()).toHaveLength(0);
  });
});

describe('PR-only config changes', () => {
  const MINIMAL_MANIFEST = `
apiVersion: launchpad.dev/v1
kind: Application
metadata:
  id: minimal-app
  owners: ["@platform"]
repository:
  provider: github
  name: example/minimal
  productionBranch: main
  deploymentRef: main
vercel:
  project:
    name: minimal-app
environments: {}
domains: []
secrets: []
dependencies: {}
policies: {}
lifecycle: {}
`;

  const ZONE_REGISTRY = 'apiVersion: launchpad.dev/v1\nzones:\n  - example.com\n';

  interface RecordedCall {
    url: string;
    method: string;
    body?: string;
  }

  function controlRepoFetch(calls: RecordedCall[], manifest: string = MINIMAL_MANIFEST, zoneRegistry: string | null = ZONE_REGISTRY): typeof fetch {
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
      if (url === 'https://api.github.com/repos/acme/control') return json({ default_branch: 'main' });
      if (url.includes('/git/ref/heads/main')) return json({ object: { sha: 'a'.repeat(40) } });
      if (url.includes('/git/refs')) return json({ ref: 'refs/heads/x' }, 201);
      if (url.includes('ghost-app.yaml')) return new Response('not found', { status: 404 });
      if (url.includes('/contents/catalog/zones.yaml')) {
        if (zoneRegistry === null) return new Response('not found', { status: 404 });
        return json({ content: Buffer.from(zoneRegistry).toString('base64'), encoding: 'base64', sha: 'zones-sha' });
      }
      if (url.includes('/contents/') && url.includes('?ref=main')) return json({ content: Buffer.from(manifest).toString('base64'), encoding: 'base64', sha: 'manifest-sha' });
      if (url.includes('/contents/') && url.includes('?ref=launchpad')) return new Response('not found', { status: 404 });
      if (url.includes('/contents/')) return json({ content: { sha: 'new-sha' } });
      if (url.includes('/pulls?state=open')) return json([]);
      if (url.endsWith('/pulls')) return json({ number: 7, html_url: 'https://github.com/acme/control/pull/7' }, 201);
      return new Response(`not mocked: ${url}`, { status: 500 });
    }) as typeof fetch;
  }

  function changeHarness(calls: RecordedCall[], manifest: string = MINIMAL_MANIFEST, zoneRegistry: string | null = ZONE_REGISTRY): TestHarness {
    const harness = createHarness({ controlRepository: 'acme/control' });
    globalThis.fetch = controlRepoFetch(calls, manifest, zoneRegistry);
    return harness;
  }

  function decodedManifest(call: RecordedCall | undefined): string {
    if (!call?.body) return '';
    const body = JSON.parse(call.body) as { content?: string };
    return typeof body.content === 'string' ? Buffer.from(body.content, 'base64').toString('utf8') : '';
  }

  it('requires operator auth and configured GitHub credentials', async () => {
    const calls: RecordedCall[] = [];
    const harness = changeHarness(calls);
    const denied = await request(harness, '/v1/applications/minimal-app/changes/root', { method: 'POST', body: JSON.stringify({ value: 'src' }), headers: { 'content-type': 'application/json' } });
    expect(denied.status).toBe(401);
    const withoutToken = createHarness({ controlRepository: 'acme/control', githubToken: undefined });
    const missing = await request(withoutToken, '/v1/applications/minimal-app/changes/root', { method: 'POST', body: JSON.stringify({ value: 'src' }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(missing.status).toBe(503);
    await expect(missing.json()).resolves.toMatchObject({ error: { code: 'LP-GITHUB-CONFIG-MISSING' } });
    expect(calls).toHaveLength(0);
  });

  it('creates a control-repository PR for a root directory change and never mutates providers', async () => {
    const calls: RecordedCall[] = [];
    const harness = changeHarness(calls);
    await harness.store.upsertApplication({ id: 'minimal-app', displayName: 'Minimal', sourcePath: 'catalog/apps/minimal-app.yaml', desiredGeneration: 1, desiredHash: '', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
    const response = await request(harness, '/v1/applications/minimal-app/changes/root', { method: 'POST', body: JSON.stringify({ value: 'apps/web' }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(response.status).toBe(200);
    const body = await response.json() as { applicationId: string; change: string; replay: boolean; pullRequest: { number: number; url: string; branch: string } };
    expect(body).toMatchObject({ applicationId: 'minimal-app', change: 'root', replay: false, pullRequest: { number: 7, url: 'https://github.com/acme/control/pull/7' } });
    expect(body.pullRequest.branch).toMatch(/^launchpad\/root\/minimal-app\//);
    // The manifest PUT carried the validated change.
    const putCall = calls.find((call) => call.method === 'PUT' && call.url.includes('/contents/catalog/apps/minimal-app.yaml'));
    expect(putCall).toBeDefined();
    expect(decodedManifest(putCall)).toContain('rootDirectory: apps/web');
    expect(decodedManifest(putCall)).not.toContain('sourcePath');
    // No provider was touched: no workflow instance was created and no
    // provider API call was made.
    expect(harness.workflowCalls).toHaveLength(0);
    expect(calls.every((call) => call.url.startsWith('https://api.github.com/repos/acme/control'))).toBe(true);
    // The change is durably audited and idempotent.
    const audit = await harness.store.listAudit('minimal-app');
    const event = audit.find((entry) => entry.action === 'CONFIG_CHANGE_ROOT');
    expect(event?.details?.pullRequestUrl).toBe('https://github.com/acme/control/pull/7');
    const replay = await request(harness, '/v1/applications/minimal-app/changes/root', { method: 'POST', body: JSON.stringify({ value: 'apps/web' }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ replay: true, pullRequest: { url: 'https://github.com/acme/control/pull/7' } });
    const callsAfterReplay = calls.length;
    expect(callsAfterReplay).toBeGreaterThan(0);
  });

  it('fails closed when the recorded change details are malformed', async () => {
    const calls: RecordedCall[] = [];
    const harness = changeHarness(calls);
    await harness.store.upsertApplication({ id: 'minimal-app', displayName: 'Minimal', sourcePath: 'catalog/apps/minimal-app.yaml', desiredGeneration: 1, desiredHash: '', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
    // Deterministic audit id for the change, exactly as applyConfigChange computes it.
    const requestFingerprint = stableId('config-change', 'minimal-app', 'root', canonicalJson({ change: 'root', value: 'apps/web' }));
    await harness.store.appendAudit({ id: stableId('audit', 'minimal-app', 'CONFIG_CHANGE_ROOT', requestFingerprint), actor: 'operator:dashboard', action: 'CONFIG_CHANGE_ROOT', applicationId: 'minimal-app', details: { change: 'root', requestFingerprint, branch: 'launchpad/root/minimal-app/broken', params: { change: 'root', value: 'apps/web' } } });
    const response = await request(harness, '/v1/applications/minimal-app/changes/root', { method: 'POST', body: JSON.stringify({ value: 'apps/web' }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-CHANGE-RECORD-MISSING' } });
    expect(calls).toHaveLength(0);
  });

  it('rejects invalid change input without creating a PR', async () => {
    const calls: RecordedCall[] = [];
    const harness = changeHarness(calls);
    await harness.store.upsertApplication({ id: 'minimal-app', displayName: 'Minimal', sourcePath: 'catalog/apps/minimal-app.yaml', desiredGeneration: 1, desiredHash: '', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
    const before = calls.length;
    const invalid = await request(harness, '/v1/applications/minimal-app/changes/root', { method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: { code: 'LP-CHANGE-VALUE-REQUIRED' } });
    const badDomain = await request(harness, '/v1/applications/minimal-app/changes/domain', { method: 'POST', body: JSON.stringify({ hostname: 'not a hostname' }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(badDomain.status).toBe(400);
    await expect(badDomain.json()).resolves.toMatchObject({ error: { code: 'LP-CHANGE-DOMAIN-HOSTNAME-INVALID' } });
    expect(calls.length).toBe(before);
  });

  it('updates proxy mode, sets environment variables, and guards domain additions through PRs', async () => {
    const WITH_DOMAIN = MINIMAL_MANIFEST.replace('domains: []', 'domains:\n  - hostname: app.example.com\n    environment: production\n    cloudflare:\n      zoneRef: config://cloudflare/example.com\n      mode: dns-only\n      ttl: auto\n    redirects: []');
    const calls: RecordedCall[] = [];
    const harness = changeHarness(calls, WITH_DOMAIN);
    await harness.store.upsertApplication({ id: 'minimal-app', displayName: 'Minimal', sourcePath: 'catalog/apps/minimal-app.yaml', desiredGeneration: 1, desiredHash: '', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
    const proxy = await request(harness, '/v1/applications/minimal-app/changes/proxy', { method: 'POST', body: JSON.stringify({ hostname: 'app.example.com', value: 'proxied' }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(proxy.status).toBe(200);
    const proxyPut = calls.filter((call) => call.method === 'PUT' && call.url.includes('/contents/catalog/apps/minimal-app.yaml')).at(-1);
    expect(decodedManifest(proxyPut)).toContain('mode: proxied');
    expect(decodedManifest(proxyPut)).toContain('acknowledgeDoubleCdn: true');
    const env = await request(harness, '/v1/applications/minimal-app/changes/env', { method: 'POST', body: JSON.stringify({ environment: 'production', name: 'API_URL', value: 'https://api.example.com' }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(env.status).toBe(200);
    const envPut = calls.filter((call) => call.method === 'PUT' && call.url.includes('/contents/catalog/apps/minimal-app.yaml')).at(-1);
    expect(decodedManifest(envPut)).toContain('API_URL');
    expect(decodedManifest(envPut)).toContain('https://api.example.com');
    const duplicateDomain = await request(harness, '/v1/applications/minimal-app/changes/domain', { method: 'POST', body: JSON.stringify({ hostname: 'app.example.com', zoneRef: 'config://cloudflare/example.com' }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(duplicateDomain.status).toBe(409);
    await expect(duplicateDomain.json()).resolves.toMatchObject({ error: { code: 'LP-DOMAIN-EXISTS' } });
    const newDomain = await request(harness, '/v1/applications/minimal-app/changes/domain', { method: 'POST', body: JSON.stringify({ hostname: 'other.example.com', zoneRef: 'config://cloudflare/example.com', mode: 'dns-only' }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(newDomain.status).toBe(200);
    const domainPut = calls.filter((call) => call.method === 'PUT' && call.url.includes('/contents/catalog/apps/minimal-app.yaml')).at(-1);
    expect(decodedManifest(domainPut)).toContain('hostname: other.example.com');
    expect(harness.workflowCalls).toHaveLength(0);
  });

  it('creates a restore-desired-state reconciliation request PR without touching the manifest', async () => {
    const calls: RecordedCall[] = [];
    const harness = changeHarness(calls);
    await harness.store.upsertApplication({ id: 'minimal-app', displayName: 'Minimal', sourcePath: 'catalog/apps/minimal-app.yaml', desiredGeneration: 4, desiredHash: '', syncStatus: 'OUT_OF_SYNC', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
    const response = await request(harness, '/v1/applications/minimal-app/changes/restore', { method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(response.status).toBe(200);
    const putCall = calls.find((call) => call.method === 'PUT' && call.url.includes('/contents/reconciliation/minimal-app.yaml'));
    expect(putCall).toBeDefined();
    const requestBody = putCall?.body ? JSON.parse(putCall.body) as { content?: string } : null;
    const requestYaml = requestBody?.content ? Buffer.from(requestBody.content, 'base64').toString('utf8') : '';
    expect(requestYaml).toContain('operation: restore-desired-state');
    expect(requestYaml).toContain('desiredGeneration: 4');
    expect(calls.some((call) => call.method === 'PUT' && call.url.includes('/contents/catalog/apps/minimal-app.yaml'))).toBe(false);
    expect(harness.workflowCalls).toHaveLength(0);
  });

  it('fails closed when the control manifest is missing or invalid', async () => {
    const calls: RecordedCall[] = [];
    const harness = changeHarness(calls);
    await harness.store.upsertApplication({ id: 'ghost-app', displayName: 'Ghost', sourcePath: 'catalog/apps/ghost-app.yaml', desiredGeneration: 1, desiredHash: '', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
    const missing = await request(harness, '/v1/applications/ghost-app/changes/root', { method: 'POST', body: JSON.stringify({ value: 'src' }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ error: { code: 'LP-CONTROL-MANIFEST-NOT-FOUND' } });
    const unregistered = await request(harness, '/v1/applications/ghost/changes/root', { method: 'POST', body: JSON.stringify({ value: 'src' }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(unregistered.status).toBe(404);
    await expect(unregistered.json()).resolves.toMatchObject({ error: { code: 'LP-APPLICATION-NOT-FOUND' } });
  });

  it('rejects manifest edits that would produce an invalid manifest', async () => {
    // The minimal manifest declares no domains, so proxy edits for a
    // non-declared hostname fail before any PR is opened.
    const calls: RecordedCall[] = [];
    const harness = changeHarness(calls);
    await harness.store.upsertApplication({ id: 'minimal-app', displayName: 'Minimal', sourcePath: 'catalog/apps/minimal-app.yaml', desiredGeneration: 1, desiredHash: '', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
    const proxy = await request(harness, '/v1/applications/minimal-app/changes/proxy', { method: 'POST', body: JSON.stringify({ hostname: 'app.example.com', value: 'proxied' }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(proxy.status).toBe(404);
    await expect(proxy.json()).resolves.toMatchObject({ error: { code: 'LP-DOMAIN-NOT-FOUND' } });
    const badEnv = await request(harness, '/v1/applications/minimal-app/changes/env', { method: 'POST', body: JSON.stringify({ environment: 'staging', name: 'FOO', value: 'x' }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(badEnv.status).toBe(404);
    await expect(badEnv.json()).resolves.toMatchObject({ error: { code: 'LP-ENVIRONMENT-NOT-FOUND' } });
    // Only read calls happened; no PR was opened and no provider was touched.
    expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
    expect(calls.filter((call) => call.url.includes('/pulls'))).toHaveLength(0);
  });

  it('reads the zone registry from the protected ref and blocks unknown zones in proposed changes', async () => {
    const WITH_DOMAIN = MINIMAL_MANIFEST.replace('domains: []', 'domains:\n  - hostname: app.example.com\n    environment: production\n    cloudflare:\n      zoneRef: config://cloudflare/example.com\n      mode: dns-only\n      ttl: auto\n    redirects: []');
    const calls: RecordedCall[] = [];
    const harness = changeHarness(calls, WITH_DOMAIN);
    await harness.store.upsertApplication({ id: 'minimal-app', displayName: 'Minimal', sourcePath: 'catalog/apps/minimal-app.yaml', desiredGeneration: 1, desiredHash: '', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
    const unknownZone = await request(harness, '/v1/applications/minimal-app/changes/domain', { method: 'POST', body: JSON.stringify({ hostname: 'other.example.com', zoneRef: 'config://cloudflare/other.com', mode: 'dns-only' }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(unknownZone.status).toBe(422);
    await expect(unknownZone.json()).resolves.toMatchObject({ error: { code: 'LP-CHANGE-INVALID-MANIFEST' } });
    // The registry was read from the protected ref (catalog/zones.yaml on main).
    expect(calls.some((call) => call.method === 'GET' && call.url.includes('/contents/catalog/zones.yaml') && call.url.includes('ref=main'))).toBe(true);
    // No PR was opened, no manifest was written, and no provider was touched.
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
    expect(calls.filter((call) => call.url.includes('/pulls'))).toHaveLength(0);
    expect(harness.workflowCalls).toHaveLength(0);
  });

  it('blocks a current manifest whose zone is not registered, before any PR is opened', async () => {
    const WITH_UNKNOWN_ZONE = MINIMAL_MANIFEST.replace('domains: []', 'domains:\n  - hostname: app.example.com\n    environment: production\n    cloudflare:\n      zoneRef: config://cloudflare/other.com\n      mode: dns-only\n      ttl: auto\n    redirects: []');
    const calls: RecordedCall[] = [];
    const harness = changeHarness(calls, WITH_UNKNOWN_ZONE);
    await harness.store.upsertApplication({ id: 'minimal-app', displayName: 'Minimal', sourcePath: 'catalog/apps/minimal-app.yaml', desiredGeneration: 1, desiredHash: '', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
    const response = await request(harness, '/v1/applications/minimal-app/changes/root', { method: 'POST', body: JSON.stringify({ value: 'src' }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-CONTROL-MANIFEST-INVALID' } });
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
    expect(harness.workflowCalls).toHaveLength(0);
  });

  it('fails closed when the zone registry is missing from the protected ref', async () => {
    const calls: RecordedCall[] = [];
    const harness = changeHarness(calls, MINIMAL_MANIFEST, null);
    await harness.store.upsertApplication({ id: 'minimal-app', displayName: 'Minimal', sourcePath: 'catalog/apps/minimal-app.yaml', desiredGeneration: 1, desiredHash: '', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
    const response = await request(harness, '/v1/applications/minimal-app/changes/root', { method: 'POST', body: JSON.stringify({ value: 'src' }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-ZONE-REGISTRY-MISSING' } });
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
    expect(harness.workflowCalls).toHaveLength(0);
  });

  it('fails closed when the zone registry is malformed', async () => {
    const calls: RecordedCall[] = [];
    const harness = changeHarness(calls, MINIMAL_MANIFEST, 'zones: [unclosed\n');
    await harness.store.upsertApplication({ id: 'minimal-app', displayName: 'Minimal', sourcePath: 'catalog/apps/minimal-app.yaml', desiredGeneration: 1, desiredHash: '', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
    const response = await request(harness, '/v1/applications/minimal-app/changes/root', { method: 'POST', body: JSON.stringify({ value: 'src' }), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-ZONE-REGISTRY-INVALID' } });
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
    expect(harness.workflowCalls).toHaveLength(0);
  });

  it('adopts the observed root directory from the latest persisted observation', async () => {
    const calls: RecordedCall[] = [];
    const harness = changeHarness(calls);
    await harness.store.upsertApplication({ id: 'minimal-app', displayName: 'Minimal', sourcePath: 'catalog/apps/minimal-app.yaml', desiredGeneration: 1, desiredHash: '', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
    await harness.store.recordObservation({ applicationId: 'minimal-app', observedHash: 'oh', payload: { applicationId: 'minimal-app', observedAt: '2026-08-04T00:00:00.000Z', desiredGeneration: 1, desiredHash: '', observedHash: 'oh', resources: [{ provider: 'vercel', resourceType: 'vercel.project', providerResourceId: 'prj', resourceKey: 'vercel.project', configuration: { rootDirectory: 'apps/observed' }, ownershipFingerprint: null, observedAt: '2026-08-04T00:00:00.000Z' }], deployments: [], health: { status: 'UNKNOWN', latest: null } } });
    const response = await request(harness, '/v1/applications/minimal-app/changes/adopt', { method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    expect(response.status).toBe(200);
    expect(decodedManifest(calls.find((call) => call.method === 'PUT'))).toContain('rootDirectory: apps/observed');
    const noObservation = await request(harness, '/v1/applications/minimal-app/changes/adopt', { method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json', ...bearer('operator-token') } });
    // The adopt request is fingerprinted identically, so it replays the same PR.
    expect(noObservation.status).toBe(200);
    await expect(noObservation.json()).resolves.toMatchObject({ replay: true });
  });
});

describe('preserved routes', () => {
  it('still requires operator authentication for dashboard routes', async () => {
    const harness = createHarness();
    const response = await request(harness, '/v1/applications');
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-OPERATOR-AUTH-REQUIRED' } });
    const authorized = await request(harness, '/v1/applications', { headers: bearer('operator-token') });
    expect(authorized.status).toBe(200);
  });

  it('still verifies webhook signatures', async () => {
    const harness = createHarness({ webhookSecret: 'webhook-secret' });
    const response = await request(harness, '/webhooks/vercel', { method: 'POST', body: '{"id":"e1"}', headers: { 'content-type': 'application/json', 'x-vercel-signature': 'sha256=deadbeef' } });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-WEBHOOK-SIGNATURE-INVALID' } });
  });

  describe('Vercel webhook provider events', () => {
    async function sign(body: string): Promise<string> {
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('webhook-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
      return `sha256=${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    }

    function delivery(harness: TestHarness, body: string): Promise<Response> {
      return request(harness, '/webhooks/vercel', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-vercel-signature': signature } });
    }

    const CANARY = 'launchpad-canary-e71a';
    let signature: string;
    let body: string;

    beforeEach(async () => {
      body = JSON.stringify({ id: 'evt-webhook-1', type: 'deployment.ready', payload: { deploymentId: 'dpl_webhook', projectId: 'prj_webhook', url: 'https://deploy.example/private', token: CANARY }, deployment: { id: 'dpl_webhook', url: 'https://deploy.example/private' }, project: { id: 'prj_webhook', name: 'private-project' } });
      signature = await sign(body);
    });

    it('persists the sanitized receipt before enqueueing, and a replay heals a failed send exactly once', async () => {
      const harness = createHarness({ webhookSecret: 'webhook-secret' });
      const sent: Array<Record<string, unknown>> = [];
      let queueDown = true;
      harness.env.PROVIDER_EVENTS = { send: async (envelope: unknown) => { if (queueDown) throw new Error('queue unavailable'); sent.push(envelope as Record<string, unknown>); } };

      // First delivery: the queue is down, so the webhook fails with a
      // retryable 503 — but the receipt was already persisted durably.
      const first = await delivery(harness, body);
      expect(first.status).toBe(503);
      await expect(first.json()).resolves.toMatchObject({ error: { code: 'LP-WEBHOOK-PERSIST-FAILED', retryable: true } });
      const receipt = await harness.store.getWebhookReceipt('vercel', 'evt-webhook-1');
      expect(receipt).not.toBeNull();
      expect(receipt?.dispatchedAt).toBeNull();
      expect(JSON.stringify(receipt?.payload)).not.toContain(CANARY);
      expect(sent).toEqual([]);

      // Replay: the receipt exists but was never dispatched, so the envelope
      // is sent exactly once and the receipt is marked dispatched.
      queueDown = false;
      const replay = await delivery(harness, body);
      expect(replay.status).toBe(202);
      await expect(replay.json()).resolves.toMatchObject({ accepted: true, deduplicated: true });
      expect(sent).toHaveLength(1);
      expect((await harness.store.getWebhookReceipt('vercel', 'evt-webhook-1'))?.dispatchedAt).toBeDefined();
    });

    it('enqueues exactly one sanitized envelope and never exposes the raw body', async () => {
      const harness = createHarness({ webhookSecret: 'webhook-secret' });
      const sent: Array<Record<string, unknown>> = [];
      harness.env.PROVIDER_EVENTS = { send: async (envelope: unknown) => { sent.push(envelope as Record<string, unknown>); } };

      const response = await delivery(harness, body);
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({ accepted: true, deduplicated: false });
      expect(sent).toHaveLength(1);
      const envelope = sent[0] as { version: number; kind: string; id: string; payload: Record<string, unknown> };
      expect(envelope.kind).toBe('provider-event');
      expect(envelope.id).toBe('webhook:vercel:evt-webhook-1');
      expect(envelope.payload).toEqual({ eventId: 'evt-webhook-1', type: 'deployment.ready', deploymentId: 'dpl_webhook', projectId: 'prj_webhook' });

      // No raw body, canary, url, or project name survives in queue, receipt,
      // or audit — only event id/type and non-secret resource identifiers.
      const serializedQueue = JSON.stringify(sent);
      expect(serializedQueue).not.toContain(CANARY);
      expect(serializedQueue).not.toContain('deploy.example');
      expect(serializedQueue).not.toContain('private-project');
      const receipt = await harness.store.getWebhookReceipt('vercel', 'evt-webhook-1');
      expect(receipt?.dispatchedAt).toBeDefined();
      expect(receipt?.payload).toEqual({ eventId: 'evt-webhook-1', type: 'deployment.ready', deploymentId: 'dpl_webhook', projectId: 'prj_webhook' });
      const audits = await harness.store.listAuditAll();
      expect(JSON.stringify(audits)).not.toContain(CANARY);
      expect(JSON.stringify(audits)).not.toContain('deploy.example');
      expect(audits.find((event) => event.action === 'WEBHOOK_RECEIVED')?.details).toEqual({ eventId: 'evt-webhook-1', type: 'deployment.ready' });
    });

    it('replays a completed delivery without sending a second envelope', async () => {
      const harness = createHarness({ webhookSecret: 'webhook-secret' });
      const sent: Array<Record<string, unknown>> = [];
      harness.env.PROVIDER_EVENTS = { send: async (envelope: unknown) => { sent.push(envelope as Record<string, unknown>); } };

      const first = await delivery(harness, body);
      expect(first.status).toBe(202);
      await expect(first.json()).resolves.toMatchObject({ accepted: true, deduplicated: false });
      const second = await delivery(harness, body);
      expect(second.status).toBe(202);
      await expect(second.json()).resolves.toMatchObject({ accepted: true, deduplicated: true });
      expect(sent).toHaveLength(1);
      const audits = await harness.store.listAuditAll();
      expect(audits.some((event) => event.action === 'WEBHOOK_RECEIVED')).toBe(true);
      expect(audits.some((event) => event.action === 'WEBHOOK_DEDUPLICATED')).toBe(true);
    });

    it('never sends on a bad signature', async () => {
      const harness = createHarness({ webhookSecret: 'webhook-secret' });
      const sent: Array<Record<string, unknown>> = [];
      harness.env.PROVIDER_EVENTS = { send: async (envelope: unknown) => { sent.push(envelope as Record<string, unknown>); } };
      const bad = await request(harness, '/webhooks/vercel', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-vercel-signature': 'sha256=deadbeef' } });
      expect(bad.status).toBe(401);
      expect(sent).toEqual([]);
      expect(await harness.store.getWebhookReceipt('vercel', 'evt-webhook-1')).toBeNull();
    });

    it('fails closed with a retryable 503 when the provider-events queue is missing', async () => {
      const harness = createHarness({ webhookSecret: 'webhook-secret' });
      harness.env.PROVIDER_EVENTS = undefined;
      const response = await delivery(harness, body);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-WEBHOOK-PERSIST-FAILED', retryable: true } });
      expect((await harness.store.getWebhookReceipt('vercel', 'evt-webhook-1'))?.dispatchedAt).toBeNull();
    });

    it('sanitizes only allowlisted identifiers and drops everything else', () => {
      const event = sanitizeVercelWebhookEvent({ id: 'evt-unit', type: 'deployment.created', payload: { deploymentId: 'dpl_unit', token: CANARY, secret: { value: 'x' } }, project: { id: 'prj_unit' }, deployment: { id: 'dpl_unit' }, extra: { nested: true }, url: 'https://x.example' }, 'evt-unit', 'deployment.created');
      expect(event).toEqual({ eventId: 'evt-unit', type: 'deployment.created', deploymentId: 'dpl_unit', projectId: 'prj_unit' });
      expect(JSON.stringify(event)).not.toContain(CANARY);
    });
  });

  it('serves health checks publicly', async () => {
    const harness = createHarness();
    const response = await request(harness, '/healthz');
    expect(response.status).toBe(200);
  });

  it('keeps the operator CLI and dashboard mutation routes under operator auth', async () => {
    const harness = createHarness();
    const denied = await request(harness, '/v1/cli/plan', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(denied.status).toBe(401);
    await harness.store.upsertApplication({ id: 'app-demo', displayName: 'Demo', sourcePath: 'catalog/apps/app-demo.yaml', desiredGeneration: 1, desiredHash: '', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active' });
    const allowed = await request(harness, '/v1/applications/app-demo/actions/recheck', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', authorization: 'Bearer operator-token' } });
    expect(allowed.status).toBe(202);
    const unauthorizedChange = await request(harness, '/v1/applications/app-demo/changes/root', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(unauthorizedChange.status).toBe(401);
  });
});

describe('lifecycle and deletion operator routes', () => {
  it('requires operator auth and enqueues the durable destroy with the approval token never persisted in audit', async () => {
    const harness = createHarness();
    const denied = await request(harness, '/v1/applications/app-demo/delete', { method: 'POST', body: JSON.stringify({ approvalId: 'ap-1', approvalToken: 'f'.repeat(64), sourceCommit: 'a'.repeat(40), domain: 'demo.example.com' }), headers: { 'content-type': 'application/json' } });
    expect(denied.status).toBe(401);
    const accepted = await request(harness, '/v1/applications/app-demo/delete', { method: 'POST', body: JSON.stringify({ approvalId: 'ap-1', approvalToken: 'f'.repeat(64), sourceCommit: 'a'.repeat(40), domain: 'demo.example.com' }), headers: { 'content-type': 'application/json', authorization: 'Bearer operator-token' } });
    expect(accepted.status).toBe(202);
    await expect(accepted.json()).resolves.toMatchObject({ status: 'QUEUED' });
    const enqueued = harness.workflowCalls.find((call) => call.params.kind === 'decommission' || (call.params as Record<string, unknown>).approvalToken !== undefined);
    expect(enqueued).toBeDefined();
    const params = enqueued?.params as Record<string, unknown>;
    expect(params.approvalToken).toBe('f'.repeat(64));
    expect(params.approvalId).toBe('ap-1');
    const audit = await harness.store.listAudit('app-demo');
    const deleteRequested = audit.find((event) => event.action === 'DELETE_REQUESTED');
    expect(deleteRequested).toBeDefined();
    expect(JSON.stringify(deleteRequested?.details)).not.toContain('f'.repeat(64));
  });

  it('rejects invalid delete payloads before enqueue', async () => {
    const harness = createHarness();
    const response = await request(harness, '/v1/applications/app-demo/delete', { method: 'POST', body: JSON.stringify({ approvalId: 'ap-1', approvalToken: 'f'.repeat(64), sourceCommit: 'short', domain: 'demo.example.com' }), headers: { 'content-type': 'application/json', authorization: 'Bearer operator-token' } });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-DELETE-COMMIT-INVALID' } });
    expect(harness.workflowCalls).toHaveLength(0);
  });

  it('keeps decommission, approval, reactivate, and tombstone-release routes under operator auth', async () => {
    const harness = createHarness();
    for (const path of ['/v1/applications/app-demo/decommission', '/v1/applications/app-demo/decommission/approval', '/v1/applications/app-demo/decommission/reactivate', '/v1/applications/app-demo/tombstone/release']) {
      const response = await request(harness, path, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
      expect(response.status, path).toBe(401);
    }
  });
});
