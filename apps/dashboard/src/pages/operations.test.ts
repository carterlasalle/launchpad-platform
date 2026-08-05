// DOM tests for the platform operations page: every application's operations
// render with per-row recovery controls, and those controls issue the exact
// existing action endpoints with the session token. Queued operations offer
// CANCEL (after confirmation); failed/blocked operations offer RETRY;
// terminal operations offer nothing.

import { beforeEach, expect, it, vi } from 'vitest';
import { ApiClient } from '../api.js';
import { cancelIdempotencyKey } from '../actions.js';
import type { PageContext } from '../router.js';
import { asFakeElement, findTags, installDomShim, type FakeElement } from '../test/dom-shim.js';
import { renderOperationsPage } from './operations.js';

function context(fetchImpl: typeof fetch): PageContext {
  return { client: new ApiClient({ token: 'operator-token', fetchImpl }), reload: () => undefined, openSession: () => undefined };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
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

function operation(overrides: Record<string, unknown>): Record<string, unknown> {
  return { id: 'op-1', workflowId: 'op-1', applicationId: 'acme', action: 'apply', status: 'QUEUED', idempotencyKey: 'k', payloadHash: 'h', startedAt: '2026-08-04T00:00:00.000Z', completedAt: null, errorCode: null, ...overrides };
}

beforeEach(() => installDomShim());

// The action chain after a click is a bounded sequence of promise awaits
// (fetch -> undici response.text() -> JSON.parse -> status render); pumping
// the microtask queue settles it deterministically without wall-clock timers.
const flush = async (): Promise<void> => {
  for (let hop = 0; hop < 50; hop += 1) await Promise.resolve();
};

function buttonsOf(view: { element: HTMLElement }): FakeElement[] {
  return findTags(asFakeElement(view.element), 'BUTTON');
}

it('renders per-row retry and cancel controls that hit the exact endpoints', async () => {
  const operations = [
    operation({ id: 'op-failed', status: 'FAILED', errorCode: 'LP-BUILD-FAILED' }),
    operation({ id: 'op-queued', status: 'QUEUED' }),
    operation({ id: 'op-done', status: 'SUCCEEDED', completedAt: '2026-08-04T00:01:00.000Z' }),
  ];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return jsonResponse({ workflowId: 'x', operationId: 'x', status: 'CANCELED', replay: false });
    if (String(url).endsWith('/operations')) return jsonResponse({ applicationId: 'acme', operations, limit: 50, truncated: false });
    return jsonResponse({ applications: [application], limit: 500, truncated: false });
  });
  const view = await renderOperationsPage(context(fetchImpl));
  expect(view.element.textContent).toContain('ACTIONS');
  // Failed -> RETRY, queued -> CANCEL; terminal rows get no controls.
  expect(buttonsOf(view).map((button) => button.textContent)).toEqual(['RETRY', 'CANCEL']);
  // Retry posts to the exact endpoint with the session token.
  const retry = buttonsOf(view).find((button) => button.textContent === 'RETRY');
  retry?.click();
  await flush();
  expect(fetchImpl).toHaveBeenCalledWith(
    '/v1/applications/acme/actions/retry',
    expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ authorization: 'Bearer operator-token' }) }),
  );
  // Cancel requires confirmation, then posts with the deterministic key.
  const cancel = buttonsOf(view).find((button) => button.textContent === 'CANCEL');
  cancel?.click();
  const postsBeforeConfirm = fetchImpl.mock.calls.filter((call) => call[1]?.method === 'POST');
  expect(postsBeforeConfirm).toHaveLength(1);
  cancel?.click();
  await flush();
  const posts = fetchImpl.mock.calls.filter((call) => call[1]?.method === 'POST');
  expect(posts).toHaveLength(2);
  expect(posts[1]?.[0]).toBe('/v1/applications/acme/actions/cancel');
  expect(posts[1]?.[1]).toEqual(expect.objectContaining({ headers: expect.objectContaining({ 'idempotency-key': cancelIdempotencyKey('acme', 'op-queued') }) }));
  expect(view.element.textContent).toContain('Operation op-queued canceled');
});
