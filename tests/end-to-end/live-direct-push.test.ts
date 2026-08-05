/**
 * Focused deterministic unit tests for the executable `direct-push-rejected`
 * live probe (tests/end-to-end/live-direct-push.ts).
 *
 * Fully offline: the real probe code runs against a recorded/fake fetch
 * transport (tests/fixtures/recorded-transport.ts) — no network calls are
 * ever made. Every request is asserted for method/path/body shape:
 * unattached child commit with the head's tree/parents, non-force
 * fast-forward ref update, ref-unchanged readback, and forced restoration
 * of the original ref on unexpected success.
 *
 * Live wiring: tests/end-to-end/live-acceptance.test.ts runs the same probe
 * against the real GitHub API as its `direct-push-rejected` phase.
 */

import { describe, expect, it } from 'vitest';
import { probeDirectPushRejected, type DirectPushRejectionEvidence } from './live-direct-push.js';
import { expectRequest, recordedTransport, type RecordedRequest, type RecordedStep } from '../fixtures/recorded-transport.js';

const REPOSITORY = 'acme/launchpad-live-sandbox';
const BASE = 'https://github.sandbox.test';
const TOKEN = 'lp-live-github-token';
const HEAD_SHA = 'a'.repeat(40);
const TREE_SHA = 'b'.repeat(40);
const PROBE_SHA = 'c'.repeat(40);
const REPO_PATH = '/repos/acme/launchpad-live-sandbox';
const REF_PATH = '/repos/acme/launchpad-live-sandbox/git/refs/heads/main';

interface ProbeHarness {
  client: { baseUrl: string; token: string; fetchImpl: typeof fetch; timeoutMs: number };
  requests: RecordedRequest[];
}

function mount(steps: RecordedStep[]): ProbeHarness {
  const transport = recordedTransport(steps);
  return { client: { baseUrl: BASE, token: TOKEN, fetchImpl: transport.fetchImpl, timeoutMs: 5_000 }, requests: transport.requests };
}

const repoStep: RecordedStep = {
  request: { method: 'GET', path: REPO_PATH },
  response: { status: 200, body: { id: 424243, default_branch: 'main', permissions: { push: true } } },
};
const headRefStep: RecordedStep = {
  request: { method: 'GET', path: `${REPO_PATH}/git/ref/heads/main` },
  response: { status: 200, body: { object: { sha: HEAD_SHA } } },
};
const headCommitStep: RecordedStep = {
  request: { method: 'GET', path: `${REPO_PATH}/git/commits/${HEAD_SHA}` },
  response: { status: 200, body: { sha: HEAD_SHA, tree: { sha: TREE_SHA } } },
};
const probeCommitStep: RecordedStep = {
  request: { method: 'POST', path: `${REPO_PATH}/git/commits` },
  response: { status: 201, body: { sha: PROBE_SHA } },
};
const updateStep: RecordedStep = { request: { method: 'PATCH', path: REF_PATH }, response: { status: 422, body: {} } };
const readbackStep: RecordedStep = {
  request: { method: 'GET', path: REF_PATH },
  response: { status: 200, body: { ref: 'refs/heads/main', object: { sha: HEAD_SHA } } },
};

function runProbe(steps: RecordedStep[], repository = REPOSITORY): Promise<DirectPushRejectionEvidence> {
  return probeDirectPushRejected({ client: mount(steps).client, repository });
}

describe('direct-push-rejected live probe (offline, recorded transport)', () => {
  it('passes when branch protection rejects the update (422 + protected-branch reason) and the ref is confirmed unchanged', async () => {
    const { client, requests } = mount([
      repoStep,
      headRefStep,
      headCommitStep,
      probeCommitStep,
      { ...updateStep, response: { status: 422, body: { message: 'Cannot edit published ref', errors: [{ code: 'custom', field: 'ref', message: 'Protected branch update failed for refs/heads/main.', type: 'protected_branch' }], documentation_url: 'https://docs.github.com/rest/git/refs#update-a-reference' } } },
      readbackStep,
    ]);
    const evidence = await probeDirectPushRejected({ client, repository: REPOSITORY, correlationId: 'live-probe' });
    expect(evidence).toEqual({ defaultBranch: 'main', headSha: HEAD_SHA, probeSha: PROBE_SHA, attemptStatus: 422, rejectionReason: 'branch-protection' });

    const probeCommit = expectRequest(requests, 'POST', `${REPO_PATH}/git/commits`);
    expect(probeCommit.body).toMatchObject({ tree: TREE_SHA, parents: [HEAD_SHA] });
    expect(JSON.stringify(probeCommit.body)).toContain('unattached');
    const update = expectRequest(requests, 'PATCH', REF_PATH);
    expect(update.body).toEqual({ sha: PROBE_SHA, force: false });
    expect(update.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(update.headers['x-github-api-version']).toBe('2022-11-28');
    expect(update.headers['x-launchpad-correlation-id']).toBe('live-probe');
    // Initial head read + post-rejection readback; no restore PATCH.
    expect(requests.filter((request) => request.method === 'GET' && request.path === REF_PATH)).toHaveLength(1);
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
  });

  it('passes when a ruleset rejects the update (403 + GH013/rule reason)', async () => {
    const { client, requests } = mount([
      repoStep,
      headRefStep,
      headCommitStep,
      probeCommitStep,
      { ...updateStep, response: { status: 403, body: { message: 'GH013: Repository rule violations found for refs/heads/main.', errors: [{ message: "Cannot push to branch because it is protected by ruleset 'launchpad-main'.", type: 'rule' }], request_id: 'REQ-1' } } },
      readbackStep,
    ]);
    const evidence = await probeDirectPushRejected({ client, repository: REPOSITORY });
    expect(evidence).toEqual({ defaultBranch: 'main', headSha: HEAD_SHA, probeSha: PROBE_SHA, attemptStatus: 403, rejectionReason: 'ruleset' });
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
  });

  it('passes when the rejection cites a required pull request (422 + pull-request reason)', async () => {
    const { client } = mount([
      repoStep,
      headRefStep,
      headCommitStep,
      probeCommitStep,
      { ...updateStep, response: { status: 422, body: { message: 'Push to refs/heads/main is not allowed because it would require pull request reviews.', errors: [{ message: 'At least 1 approving review is required by reviewers with write access.', type: 'custom' }] } } },
      readbackStep,
    ]);
    const evidence = await probeDirectPushRejected({ client, repository: REPOSITORY });
    expect(evidence).toMatchObject({ attemptStatus: 422, rejectionReason: 'pull-request-required' });
  });

  it('fails when the update is rejected generically (403 without a rule/protection reason)', async () => {
    const { client, requests } = mount([
      repoStep,
      headRefStep,
      headCommitStep,
      probeCommitStep,
      { ...updateStep, response: { status: 403, body: { message: 'Resource not accessible by integration' } } },
    ]);
    await expect(probeDirectPushRejected({ client, repository: REPOSITORY })).rejects.toMatchObject({ code: 'LP_LIVE_DIRECT_PUSH_GENERIC_REJECTION' });
    // No restore was attempted and no readback is claimed.
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
  });

  it('fails on an auth-class failure (401) — never treated as a ruleset rejection', async () => {
    await expect(runProbe([
      repoStep,
      headRefStep,
      headCommitStep,
      probeCommitStep,
      { ...updateStep, response: { status: 401, body: { message: 'Bad credentials' } } },
    ])).rejects.toMatchObject({ code: 'LP_LIVE_DIRECT_PUSH_GENERIC_FAILURE' });
  });

  it('fails closed when the repository cannot be read (404)', async () => {
    await expect(runProbe([
      { request: { method: 'GET', path: REPO_PATH }, response: { status: 404, body: { message: 'Not Found' } } },
    ])).rejects.toMatchObject({ code: 'LP_LIVE_DIRECT_PUSH_READ' });
  });

  it('fails closed when the token has no effective push permission', async () => {
    await expect(runProbe([
      { ...repoStep, response: { status: 200, body: { id: 424243, default_branch: 'main', permissions: { push: false } } } },
    ])).rejects.toMatchObject({ code: 'LP_LIVE_DIRECT_PUSH_PREREQ' });
  });

  it('restores the original ref and fails loudly when the update unexpectedly succeeds', async () => {
    const { client, requests } = mount([
      repoStep,
      headRefStep,
      headCommitStep,
      probeCommitStep,
      { ...updateStep, response: { status: 200, body: { ref: 'refs/heads/main', object: { sha: PROBE_SHA } } } },
      { ...updateStep, response: { status: 200, body: { ref: 'refs/heads/main', object: { sha: HEAD_SHA } } } },
    ]);
    const error = await probeDirectPushRejected({ client, repository: REPOSITORY }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'LP_LIVE_DIRECT_PUSH_UNEXPECTED_SUCCESS' });
    expect(String((error as Error).message)).toContain('force-restored original ref');
    const patches = requests.filter((request) => request.method === 'PATCH');
    expect(patches).toHaveLength(2);
    expect(patches[0]?.body).toEqual({ sha: PROBE_SHA, force: false });
    expect(patches[1]?.body).toEqual({ sha: HEAD_SHA, force: true });
  });

  it('fails loudly when the restore itself is rejected (unexpected success + failed restore)', async () => {
    const { client } = mount([
      repoStep,
      headRefStep,
      headCommitStep,
      probeCommitStep,
      { ...updateStep, response: { status: 200, body: { ref: 'refs/heads/main', object: { sha: PROBE_SHA } } } },
      { ...updateStep, response: { status: 422, body: { message: 'Protected branch update failed for refs/heads/main.', errors: [{ type: 'protected_branch' }] } } },
    ]);
    const error = await probeDirectPushRejected({ client, repository: REPOSITORY }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'LP_LIVE_DIRECT_PUSH_UNEXPECTED_SUCCESS' });
    expect(String((error as Error).message)).toContain('restore PATCH returned HTTP 422');
  });

  it('fails when the ref moved despite the rejected update (readback mismatch)', async () => {
    await expect(runProbe([
      repoStep,
      headRefStep,
      headCommitStep,
      probeCommitStep,
      { ...updateStep, response: { status: 422, body: { message: 'Cannot edit published ref', errors: [{ message: 'Protected branch update failed for refs/heads/main.', type: 'protected_branch' }] } } },
      { ...readbackStep, response: { status: 200, body: { ref: 'refs/heads/main', object: { sha: 'd'.repeat(40) } } } },
    ])).rejects.toMatchObject({ code: 'LP_LIVE_DIRECT_PUSH_REF_MOVED' });
  });

  it('never records the token or raw response bodies in probe evidence', async () => {
    const { client } = mount([
      repoStep,
      headRefStep,
      headCommitStep,
      probeCommitStep,
      { ...updateStep, response: { status: 422, body: { message: 'Cannot edit published ref', errors: [{ message: `Protected branch update failed for refs/heads/main (token ${TOKEN}).`, type: 'protected_branch' }] } } },
      readbackStep,
    ]);
    const evidence = await probeDirectPushRejected({ client, repository: REPOSITORY });
    expect(JSON.stringify(evidence)).not.toContain(TOKEN);
    expect(JSON.stringify(evidence)).not.toContain('Cannot edit published ref');
  });
});
