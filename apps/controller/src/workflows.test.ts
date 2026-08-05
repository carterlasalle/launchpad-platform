import { describe, expect, it, vi } from 'vitest';
import type { WorkflowStep } from 'cloudflare:workers';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class WorkflowEntrypoint {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) { this.env = env; }
  },
}));

import { ApplyApplicationWorkflow, AppPreviewStatusWorkflow, DecommissionApplicationWorkflow, PreviewApplicationWorkflow, ReconcileApplicationWorkflow } from './workflows.js';

function stepRunsCallbacks(): WorkflowStep {
  return { do: async (_name: string, callback: () => Promise<unknown>) => callback(), sleep: async (_name: string, _duration: string | number) => undefined } as WorkflowStep;
}

const validEnvelope = { version: 1, kind: 'reconcile', applicationId: 'tokentest', shard: 0, shardCount: 1, triggeredAt: '2026-08-04T08:30:00.000Z' };

describe('ReconcileApplicationWorkflow', () => {
  it('accepts a valid versioned per-application reconciliation envelope and proceeds to durable dispatch', async () => {
    const workflow = new ReconcileApplicationWorkflow({} as never, {});
    await expect(workflow.run({ payload: validEnvelope, timestamp: new Date(), instanceId: 'i', workflowName: 'reconcile-application' } as never, stepRunsCallbacks())).rejects.toThrow('LP-WORKFLOW-DISPATCH-CONFIG-MISSING');
  });

  it('rejects a payload that is not a valid reconciliation envelope', async () => {
    const workflow = new ReconcileApplicationWorkflow({} as never, {});
    await expect(workflow.run({ payload: { trigger: 'cron' } } as never, stepRunsCallbacks())).rejects.toThrow(/Invalid reconciliation envelope/);
  });
});

const applyPayload = { version: 1, kind: 'apply', applicationId: 'app', sourceCommit: 'a'.repeat(40), planFingerprint: 'f'.repeat(64), desiredGeneration: 1, idempotencyKey: 'ik-1', operationId: 'op-1', workflowId: 'inst-1', repositoryId: 1, ownerId: 'acme', repository: 'acme/app', workflowRef: 'refs/heads/main', event: 'push', actor: 'github-actions' };

/** Canned phase responses so the state machine can walk its full happy path. */
function phaseBody(kind: string): Record<string, unknown> {
  switch (kind) {
    case 'apply/validate-request': return { accepted: true };
    case 'apply/load-desired': return { desired: { metadata: { id: 'app' }, vercel: { project: {} }, domains: [] } };
    case 'apply/observe-live-state': return { observed: { deployments: [] }, capabilities: { snapshotHash: 'h' } };
    case 'apply/replan-verify': return { plan: { fingerprint: 'f'.repeat(64), result: 'READY' } };
    case 'apply/no-destroy-gate': return { accepted: true };
    case 'apply/acquire-locks': return { locks: { applicationId: 'app', ownerId: 'inst-1', leaseSeconds: 900, application: 'application:app', domains: ['app.example.com'] } };
    case 'apply/ensure-project': return { mutation: {}, verified: {} };
    case 'apply/ensure-git': return { mutation: {} };
    case 'apply/ensure-settings': return { verified: true, mismatches: [] };
    case 'apply/resolve-secrets': return { bindings: [] };
    case 'apply/ensure-environments': return { environment: 'production', skipped: false, mutation: {}, fingerprints: {}, resolved: [] };
    case 'apply/ensure-domains': return { domains: [] };
    case 'apply/ensure-dns': return { zones: [] };
    case 'apply/verify-authoritative': return { verified: true, hostnames: ['app.example.com'] };
    case 'apply/verify-vercel-domain': return { skipped: true, domains: [] };
    case 'apply/verify-tls': return { skipped: true, domains: [] };
    case 'apply/create-candidate': return { candidate: { id: 'dpl_1', projectId: 'app', environment: 'production', repository: 'acme/app', commitSha: 'a'.repeat(40), desiredGeneration: 1, state: 'STAGED', url: 'https://dpl_1.example.test', createdAt: '2026-08-04T00:00:00.000Z' } };
    case 'apply/wait-candidate': return { candidate: { id: 'dpl_1', projectId: 'app', environment: 'production', repository: 'acme/app', commitSha: 'a'.repeat(40), desiredGeneration: 1, state: 'STAGED', url: 'https://dpl_1.example.test', createdAt: '2026-08-04T00:00:00.000Z' } };
    case 'apply/proxy-compatibility': return { skipped: true, checks: [] };
    case 'apply/candidate-health': return { health: { id: 'h1', applicationId: 'app', environment: 'production', deploymentId: 'dpl_1', url: 'https://dpl_1.example.test', attempt: 1, dnsResolved: true, tlsValid: true, statusCode: 200, latencyMs: 5, assertionResults: [], result: 'PASSED', checkedAt: '2026-08-04T00:00:00.000Z', errorCode: null } };
    case 'apply/promote': return { promotion: { deployment: { id: 'dpl_1', projectId: 'app', environment: 'production', repository: 'acme/app', commitSha: 'a'.repeat(40), desiredGeneration: 1, state: 'CURRENT', url: 'https://dpl_1.example.test', createdAt: '2026-08-04T00:00:00.000Z' }, previousDeploymentId: null } };
    case 'apply/production-health': return { health: { id: 'h2', applicationId: 'app', environment: 'production', deploymentId: 'dpl_1', url: 'https://app.example.com', attempt: 1, dnsResolved: true, tlsValid: true, statusCode: 200, latencyMs: 5, assertionResults: [], result: 'PASSED', checkedAt: '2026-08-04T00:00:00.000Z', errorCode: null } };
    case 'apply/record-known-good': return { knownGood: 'dpl_1' };
    case 'apply/report': return { reported: true, summary: { status: 'SUCCEEDED' } };
    case 'apply/release-locks': return { released: ['application:app'], failed: [] };
    case 'apply/recover-on-failure': return { rollback: null, restored: false, rollbackError: null, reported: true, summary: { status: 'FAILED' } };
    default: return { value: true };
  }
}

const APPLY_PHASE_SEQUENCE = [
  'apply/validate-request', 'apply/load-desired', 'apply/observe-live-state', 'apply/replan-verify', 'apply/no-destroy-gate', 'apply/acquire-locks',
  'apply/ensure-project', 'apply/ensure-git', 'apply/ensure-settings', 'apply/resolve-secrets', 'apply/ensure-environments',
  'apply/ensure-domains', 'apply/ensure-dns', 'apply/verify-authoritative', 'apply/verify-vercel-domain', 'apply/verify-tls',
  'apply/create-candidate', 'apply/wait-candidate', 'apply/proxy-compatibility', 'apply/candidate-health', 'apply/promote', 'apply/production-health',
  'apply/record-known-good', 'apply/report', 'apply/release-locks',
];

describe('ApplyApplicationWorkflow', () => {
  it('runs a granular step.do sequence per 22.1 phase, passing outputs forward explicitly', async () => {
    const dispatches: Array<{ kind: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const kind = String(url).split('/internal/workflows/')[1];
      if (kind === undefined) throw new Error(`Unexpected dispatch URL: ${String(url)}`);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      dispatches.push({ kind, body });
      return new Response(JSON.stringify(phaseBody(kind)), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const workflow = new ApplyApplicationWorkflow({} as never, { CONTROLLER_INTERNAL_URL: 'http://controller.test', CONTROLLER_INTERNAL_TOKEN: 'internal-token' });
      const result = await workflow.run({ payload: applyPayload, timestamp: new Date(), instanceId: 'inst-1', workflowName: 'apply-application' } as never, stepRunsCallbacks());
      expect(result.status).toBe('SUCCEEDED');
      expect(result.operationId).toBe('op-1');
      expect(dispatches.map((dispatch) => dispatch.kind)).toEqual(APPLY_PHASE_SEQUENCE);
      // Outputs are passed forward explicitly: later phases carry earlier phases' results.
      const waitDispatch = dispatches.find((dispatch) => dispatch.kind === 'apply/wait-candidate');
      expect(waitDispatch?.body.candidate).toMatchObject({ id: 'dpl_1' });
      const promoteDispatch = dispatches.find((dispatch) => dispatch.kind === 'apply/promote');
      expect(promoteDispatch?.body.candidate).toMatchObject({ id: 'dpl_1' });
      const knownGoodDispatch = dispatches.find((dispatch) => dispatch.kind === 'apply/record-known-good');
      expect(knownGoodDispatch?.body.productionHealth).toMatchObject({ result: 'PASSED' });
      // Internal dispatch carries the authenticated token.
      expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ 'x-launchpad-workflow-token': 'internal-token' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects payloads that are not versioned apply requests before dispatch', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const workflow = new ApplyApplicationWorkflow({} as never, { CONTROLLER_INTERNAL_URL: 'http://controller.test', CONTROLLER_INTERNAL_TOKEN: 'internal-token' });
      await expect(workflow.run({ payload: { ...applyPayload, version: 2 }, timestamp: new Date(), instanceId: 'inst-2', workflowName: 'apply-application' } as never, stepRunsCallbacks())).rejects.toThrow('Invalid apply payload version or kind.');
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('restores previous known-good on post-promotion failure and releases locks, keeping the run failed', async () => {
    const dispatches: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const kind = String(url).split('/internal/workflows/')[1];
      if (kind === undefined) throw new Error(`Unexpected dispatch URL: ${String(url)}`);
      dispatches.push(kind);
      if (kind === 'apply/promote') {
        return new Response(JSON.stringify({ error: { code: 'LP-PROMOTION-COMMIT-MISMATCH', message: 'Candidate commit does not match the approved source commit.', retryable: false, correlationId: 'corr-1' } }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(phaseBody(kind)), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const workflow = new ApplyApplicationWorkflow({} as never, { CONTROLLER_INTERNAL_URL: 'http://controller.test', CONTROLLER_INTERNAL_TOKEN: 'internal-token' });
      await expect(workflow.run({ payload: applyPayload, timestamp: new Date(), instanceId: 'inst-3', workflowName: 'apply-application' } as never, stepRunsCallbacks())).rejects.toThrow('Candidate commit does not match the approved source commit.');
      const failureTail = dispatches.slice(-2);
      expect(failureTail).toEqual(['apply/recover-on-failure', 'apply/release-locks']);
      expect(dispatches).not.toContain('apply/report');
      expect(dispatches).not.toContain('apply/record-known-good');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

const decommissionPayload = { version: 1, kind: 'decommission', applicationId: 'app', idempotencyKey: 'del-1', approvalId: 'ap-1', approvalToken: 'f'.repeat(64), sourceCommit: 'a'.repeat(40), domain: 'app.example.com', actor: 'alice', now: '2026-08-04T00:00:00.000Z' };

const PREVIEW_STAGES = ['validate', 'supersede', 'create-shadow-project', 'apply-settings', 'create-deployment', 'wait-for-build', 'collect-build-logs', 'build-gate', 'health-check', 'report', 'schedule-cleanup'] as const;

const previewPayload = {
  version: 1,
  kind: 'preview',
  applicationId: 'app',
  sourceCommit: 'a'.repeat(40),
  desiredGeneration: 1,
  planFingerprint: 'f'.repeat(64),
  idempotencyKey: 'preview-1',
  operationId: 'op-preview-1',
  workflowId: 'inst-preview-1',
  repositoryId: 123,
  ownerId: 456,
  repository: 'acme/app',
  workflowRef: 'acme/app/.github/workflows/preview.yml@refs/heads/main',
  event: 'pull_request',
  prNumber: 7,
  ref: 'refs/pull/7/merge',
  actor: 'alice',
  pullRequestNumber: 7,
  revision: 1,
  desired: { metadata: { id: 'app' }, vercel: { project: {} }, domains: [] },
};

describe('PreviewApplicationWorkflow', () => {
  it('runs the real shadow preview stages, forwarding the loaded desired application to every stage', async () => {
    const dispatches: Array<{ kind: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const kind = String(url).split('/internal/workflows/')[1];
      if (kind === undefined) throw new Error(`Unexpected dispatch URL: ${String(url)}`);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      dispatches.push({ kind, body });
      return new Response(JSON.stringify({ value: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const workflow = new PreviewApplicationWorkflow({} as never, { CONTROLLER_INTERNAL_URL: 'http://controller.test', CONTROLLER_INTERNAL_TOKEN: 'internal-token' });
      const result = await workflow.run({ payload: previewPayload, timestamp: new Date(), instanceId: 'inst-preview-1', workflowName: 'preview-application' } as never, stepRunsCallbacks());
      expect(Object.keys(result)).toEqual([...PREVIEW_STAGES]);
      // The machine dispatches the single `preview` handler kind with the
      // stage id in the body; the handler runs the durable store-backed stage.
      expect(dispatches.map((dispatch) => dispatch.kind)).toEqual(PREVIEW_STAGES.map(() => 'preview'));
      expect(dispatches.map((dispatch) => dispatch.body.stage)).toEqual([...PREVIEW_STAGES]);
      for (const dispatch of dispatches) {
        // Every stage carries the loaded DesiredApplication and its stage id.
        expect(dispatch.body.desired).toMatchObject({ metadata: { id: 'app' } });
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects malformed preview payloads before any dispatch', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const workflow = new PreviewApplicationWorkflow({} as never, { CONTROLLER_INTERNAL_URL: 'http://controller.test', CONTROLLER_INTERNAL_TOKEN: 'internal-token' });
      await expect(workflow.run({ payload: { ...previewPayload, sourceCommit: undefined }, timestamp: new Date(), instanceId: 'inst-preview-2', workflowName: 'preview-application' } as never, stepRunsCallbacks())).rejects.toThrow('LP-WORKFLOW-PREVIEW-PAYLOAD-INVALID');
      await expect(workflow.run({ payload: { ...previewPayload, applicationId: '' }, timestamp: new Date(), instanceId: 'inst-preview-3', workflowName: 'preview-application' } as never, stepRunsCallbacks())).rejects.toThrow('LP-WORKFLOW-PREVIEW-PAYLOAD-INVALID');
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

const appPreviewStatusPayload = {
  version: 1,
  kind: 'app-preview-status',
  applicationId: 'app',
  sourceCommit: 'a'.repeat(40),
  idempotencyKey: 'app-preview-status-1',
  operationId: 'op-status-1',
  workflowId: 'inst-status-1',
  repositoryId: 123,
  ownerId: 456,
  repository: 'acme/app',
  workflowRef: 'acme/app/.github/workflows/reusable-app-preview.yml@refs/tags/v1',
  event: 'pull_request',
  prNumber: 7,
  ref: 'refs/pull/7/merge',
  actor: 'alice',
  correlationId: 'corr-status-1',
};

const appPreviewStatusEvidence = {
  status: 'SUCCEEDED', gateState: 'PASSED', operationId: 'inner-op-1', applicationId: 'app', sourceCommit: 'a'.repeat(40),
  deployment: { id: 'dpl_1', state: 'READY', url: 'https://app-123.vercel.app' }, buildState: 'READY', healthState: 'PASSED',
  commentBody: '<!-- launchpad:app-preview -->', deploymentStatus: { state: 'success' },
};

describe('AppPreviewStatusWorkflow', () => {
  it('accepts a valid versioned envelope and dispatches the real app-preview-status handler once', async () => {
    const dispatches: Array<{ kind: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const kind = String(url).split('/internal/workflows/')[1];
      if (kind === undefined) throw new Error(`Unexpected dispatch URL: ${String(url)}`);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      dispatches.push({ kind, body });
      return new Response(JSON.stringify(appPreviewStatusEvidence), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const workflow = new AppPreviewStatusWorkflow({} as never, { CONTROLLER_INTERNAL_URL: 'http://controller.test', CONTROLLER_INTERNAL_TOKEN: 'internal-token' });
      const result = await workflow.run({ payload: appPreviewStatusPayload, timestamp: new Date(), instanceId: 'inst-status-1', workflowName: 'app-preview-status-application' } as never, stepRunsCallbacks());
      expect(result).toMatchObject({ gateState: 'PASSED', buildState: 'READY', healthState: 'PASSED' });
      expect(dispatches).toHaveLength(1);
      expect(dispatches[0]?.kind).toBe('app-preview-status');
      expect(dispatches[0]?.body).toMatchObject({ version: 1, kind: 'app-preview-status', applicationId: 'app', sourceCommit: 'a'.repeat(40), repository: 'acme/app', event: 'pull_request', repositoryId: 123, ownerId: 456, workflowId: 'inst-status-1' });
      // Internal dispatch carries the authenticated token.
      expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ 'x-launchpad-workflow-token': 'internal-token' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects malformed versioned envelopes before any dispatch', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const workflow = new AppPreviewStatusWorkflow({} as never, { CONTROLLER_INTERNAL_URL: 'http://controller.test', CONTROLLER_INTERNAL_TOKEN: 'internal-token' });
      for (const broken of [
        { ...appPreviewStatusPayload, version: 2 },
        { ...appPreviewStatusPayload, kind: 'app-preview' },
        { ...appPreviewStatusPayload, applicationId: '' },
        { ...appPreviewStatusPayload, sourceCommit: 'not-a-sha' },
        { ...appPreviewStatusPayload, repository: '' },
        { ...appPreviewStatusPayload, event: undefined },
        { ...appPreviewStatusPayload, repositoryId: undefined },
        { ...appPreviewStatusPayload, ownerId: null },
      ]) {
        await expect(workflow.run({ payload: broken, timestamp: new Date(), instanceId: 'inst-status-broken', workflowName: 'app-preview-status-application' } as never, stepRunsCallbacks())).rejects.toThrow('LP-WORKFLOW-APP-PREVIEW-STATUS-PAYLOAD-INVALID');
      }
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('records the failure through observability and rethrows after a handler failure', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'LP-VERCEL-PREVIEW-NOT_FOUND', message: 'No Vercel preview deployment exists for this commit.', retryable: false, correlationId: 'corr-1' } }), { status: 404, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const workflow = new AppPreviewStatusWorkflow({} as never, { CONTROLLER_INTERNAL_URL: 'http://controller.test', CONTROLLER_INTERNAL_TOKEN: 'internal-token' });
      await expect(workflow.run({ payload: appPreviewStatusPayload, timestamp: new Date(), instanceId: 'inst-status-fail', workflowName: 'app-preview-status-application' } as never, stepRunsCallbacks())).rejects.toThrow('No Vercel preview deployment exists for this commit.');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('DecommissionApplicationWorkflow', () => {
  it('validates the destroy envelope and dispatches the granular destroy handler once', async () => {
    const dispatches: Array<{ kind: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const kind = String(url).split('/internal/workflows/')[1];
      if (kind === undefined) throw new Error(`Unexpected dispatch URL: ${String(url)}`);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      dispatches.push({ kind, body });
      return new Response(JSON.stringify({ status: 'DELETED', applicationId: 'app', operationId: 'op-1', failedStep: null, errorCode: null, exportJson: '{}', tombstone: { applicationId: 'app', domain: 'app.example.com', retainUntil: '2026-09-03T00:00:00.000Z' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const workflow = new DecommissionApplicationWorkflow({} as never, { CONTROLLER_INTERNAL_URL: 'http://controller.test', CONTROLLER_INTERNAL_TOKEN: 'internal-token' });
      const result = await workflow.run({ payload: decommissionPayload, timestamp: new Date(), instanceId: 'inst-del-1', workflowName: 'decommission-application' } as never, stepRunsCallbacks());
      expect(result.status).toBe('DELETED');
      expect(dispatches.map((dispatch) => dispatch.kind)).toEqual(['decommission/destroy']);
      expect(dispatches[0]?.body.workflowId).toBe('inst-del-1');
      expect(dispatches[0]?.body.approvalToken).toBe(decommissionPayload.approvalToken);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects malformed destroy envelopes before any dispatch', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const workflow = new DecommissionApplicationWorkflow({} as never, { CONTROLLER_INTERNAL_URL: 'http://controller.test', CONTROLLER_INTERNAL_TOKEN: 'internal-token' });
      await expect(workflow.run({ payload: { ...decommissionPayload, sourceCommit: 'not-a-sha' }, timestamp: new Date(), instanceId: 'inst-del-2', workflowName: 'decommission-application' } as never, stepRunsCallbacks())).rejects.toThrow('LP-WORKFLOW-DECOMMISSION-PAYLOAD-INVALID');
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
