// DOM tests for the application detail page: the four status dimensions must
// render as separate panels, operations must come from the API response, and
// a missing application must produce an explicit unknown state.

import { beforeEach, expect, it, vi } from 'vitest';
import { ApiClient } from '../api.js';
import type { PageContext } from '../router.js';
import { asFakeElement, findTags, installDomShim, type FakeElement } from '../test/dom-shim.js';
import { renderApplicationDetailPage } from './application.js';

function context(fetchImpl: typeof fetch): PageContext {
  return { client: new ApiClient({ token: 'operator-token', fetchImpl }), reload: () => undefined, openSession: () => undefined };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const application = {
  application: 'acme',
  displayName: 'Acme Corp',
  owner: 'platform',
  sync: 'SYNCED',
  health: 'HEALTHY',
  deployment: 'CURRENT',
  productionUrl: 'acme.example.com',
  updatedAt: '2026-08-04T00:00:00.000Z',
};

beforeEach(() => installDomShim());

it('separates sync, health, deployment and operation status panels', async () => {
  const operations = [
    { id: 'op-1', workflowId: 'wf-1', applicationId: 'acme', action: 'APPLY', status: 'SUCCEEDED', idempotencyKey: 'k-1', payloadHash: 'h-1', startedAt: '2026-08-01T00:00:00.000Z', completedAt: '2026-08-01T00:01:00.000Z', errorCode: null },
    { id: 'op-2', workflowId: 'wf-2', applicationId: 'acme', action: 'HEALTH_CHECK', status: 'FAILED', idempotencyKey: 'k-2', payloadHash: 'h-2', startedAt: '2026-08-02T00:00:00.000Z', completedAt: null, errorCode: 'LP-HEALTH-FAILED' },
  ];
  const view = await renderApplicationDetailPage(context(async () => jsonResponse({ application, operations })), { id: 'acme' });
  const text = view.element.textContent;
  for (const label of ['SYNC STATUS', 'HEALTH STATUS', 'DEPLOYMENT', 'LATEST OPERATION']) {
    expect(text).toContain(label);
  }
  // Latest operation is the newest record and its status comes from the API.
  expect(text).toContain('FAILED');
  expect(text).toContain('LP-HEALTH-FAILED');
  expect(text).toContain('SUCCEEDED');
  // Production URL validated and normalized to https.
  const externalLinks = findTags(asFakeElement(view.element), 'A').filter((anchor) => anchor.getAttribute('target') === '_blank');
  expect(externalLinks).toHaveLength(1);
  expect(externalLinks[0]?.getAttribute('href')).toBe('https://acme.example.com/');
  // Operations table lists both records.
  const rows = findTags(asFakeElement(view.element), 'TR');
  expect(rows.length).toBe(3); // header + two operations
});

it('shows an unknown state when the application is not found', async () => {
  const view = await renderApplicationDetailPage(context(async () => jsonResponse({ application: null, operations: [] })), { id: 'ghost' });
  expect(view.element.textContent).toContain('Application not found');
  expect(view.element.textContent).toContain('ghost');
  expect(view.element.textContent).toContain('BACK TO APPLICATIONS');
});

it('shows a concise error state when the control plane fails', async () => {
  const view = await renderApplicationDetailPage(
    context(async () => {
      throw new TypeError('fetch failed');
    }),
    { id: 'acme' },
  );
  expect(view.element.textContent).toContain('Control plane read failed');
  expect(view.element.textContent).toContain('VIEW OPERATIONS');
});

// The action chain after a click is a bounded sequence of promise awaits
// (fetch -> undici response.text() -> JSON.parse -> status render); pumping
// the microtask queue settles it deterministically without wall-clock timers.
const flush = async (): Promise<void> => {
  for (let hop = 0; hop < 50; hop += 1) await Promise.resolve();
};

function buttonsOf(view: { element: HTMLElement }): FakeElement[] {
  return findTags(asFakeElement(view.element), 'BUTTON');
}

it('renders recovery and config-change controls and posts recheck to the exact endpoint', async () => {
  const payload = { application, operations: [] };
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return jsonResponse({ workflowId: 'w-1', operationId: 'w-1', status: 'QUEUED', dispatched: 'handler' }, 202);
    return jsonResponse(payload);
  });
  const view = await renderApplicationDetailPage(context(fetchImpl), { id: 'acme' });
  expect(view.element.textContent).toContain('Recovery actions');
  expect(view.element.textContent).toContain('Config changes (pull request)');
  const recheck = buttonsOf(view).find((button) => button.textContent === 'RECHECK HEALTH');
  expect(recheck).toBeDefined();
  recheck?.click();
  await flush();
  expect(fetchImpl).toHaveBeenCalledWith(
    '/v1/applications/acme/actions/recheck',
    expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ authorization: 'Bearer operator-token' }) }),
  );
  // Rollback is destructive: the first click only arms the confirmation.
  const rollback = buttonsOf(view).find((button) => button.textContent === 'ROLLBACK');
  expect(rollback).toBeDefined();
  rollback?.click();
  expect(fetchImpl.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
  rollback?.click();
  await flush();
  const posts = fetchImpl.mock.calls.filter((call) => call[1]?.method === 'POST');
  expect(posts).toHaveLength(2);
  expect(posts[1]?.[0]).toBe('/v1/applications/acme/actions/rollback');
});

it('config change buttons only create control-repository PR requests', async () => {
  const payload = { application, operations: [] };
  const calls: Array<{ url: string; method: string }> = [];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    if (init?.method === 'POST') return jsonResponse({ applicationId: 'acme', change: 'restore', replay: false, pullRequest: { number: 12, url: 'https://github.com/acme/control/pull/12' } });
    return jsonResponse(payload);
  });
  const view = await renderApplicationDetailPage(context(fetchImpl), { id: 'acme' });
  const restore = buttonsOf(view).find((button) => button.textContent === 'OPEN PR: RESTORE DESIRED STATE');
  expect(restore).toBeDefined();
  restore?.click();
  expect(fetchImpl).toHaveBeenCalledTimes(1); // only the page read
  restore?.click();
  await flush();
  expect(calls.filter((call) => call.method === 'POST')).toEqual([{ url: '/v1/applications/acme/changes/restore', method: 'POST' }]);
  expect(view.element.textContent).toContain('Pull request opened: https://github.com/acme/control/pull/12');
});
