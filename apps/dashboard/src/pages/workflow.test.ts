// DOM tests for the workflow detail page: the operation record and its
// durable steps render from the control-plane envelope; hostile step errors
// render literally; missing operations and malformed payloads produce
// explicit states.

import { beforeEach, expect, it, vi } from 'vitest';
import { ApiClient } from '../api.js';
import { cancelIdempotencyKey } from '../actions.js';
import { renderWorkflowPage } from './workflow.js';
import type { PageContext } from '../router.js';
import { asFakeElement, findTags, installDomShim, type FakeElement } from '../test/dom-shim.js';

function context(fetchImpl: typeof fetch, token: string | null = 'operator-token'): PageContext {
  return { client: new ApiClient({ token, fetchImpl }), reload: () => undefined, openSession: () => undefined };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const OPERATION = { id: 'op-1', workflowId: 'op-1', applicationId: 'app-demo', action: 'apply', status: 'FAILED', idempotencyKey: 'ik', payloadHash: 'ph', startedAt: '2026-08-04T00:00:00.000Z', completedAt: null, errorCode: 'LP-BUILD-FAILED' };

beforeEach(() => installDomShim());

it('renders the operation record and its durable steps', async () => {
  const payload = {
    applicationId: 'app-demo',
    operation: OPERATION,
    steps: [
      { stepId: 'validate-request', status: 'SUCCEEDED', attempt: 1, preconditionHash: 'h', result: null, error: null },
      { stepId: 'execute', status: 'FAILED', attempt: 1, preconditionHash: 'h', result: null, error: { code: 'LP-BUILD-FAILED', message: 'build failed' } },
      { stepId: 'cleanup', status: 'SKIPPED', attempt: 1, preconditionHash: 'h', result: null, error: null },
    ],
  };
  const view = await renderWorkflowPage(context(async () => jsonResponse(payload)), { id: 'app-demo', operationId: 'op-1' });
  expect(view.element.textContent).toContain('apply');
  expect(view.element.textContent).toContain('LP-BUILD-FAILED');
  expect(view.element.textContent).toContain('build failed');
  expect(view.element.textContent).toContain('SKIPPED');
  expect(view.element.textContent).toContain('validate-request');
  expect(findTags(asFakeElement(view.element), 'TABLE')).toHaveLength(1);
});

it('renders hostile step error data literally with no parsed elements', async () => {
  const payload = {
    applicationId: 'app-demo',
    operation: { ...OPERATION, action: '<img src=x onerror=alert(1)>' },
    steps: [
      { stepId: '<script>alert(1)</script>', status: '"><img src=x>', attempt: 1, preconditionHash: 'h', result: null, error: { code: '<b>code</b>', message: '<img src=x onerror=alert(2)>' } },
    ],
  };
  const view = await renderWorkflowPage(context(async () => jsonResponse(payload)), { id: 'app-demo', operationId: 'op-1' });
  // Hostile strings render as literal text — never as parsed elements.
  expect(view.element.textContent).toContain('<img src=x onerror=alert(1)>');
  expect(view.element.textContent).toContain('<script>alert(1)</script>');
  expect(view.element.textContent).toContain('<b>code</b>');
  expect(findTags(asFakeElement(view.element), 'IMG')).toHaveLength(0);
  expect(findTags(asFakeElement(view.element), 'SCRIPT')).toHaveLength(0);
  expect(findTags(asFakeElement(view.element), 'B')).toHaveLength(0);
});

it('shows an unknown state when the operation is missing and fails closed on malformed payloads', async () => {
  const missing = await renderWorkflowPage(context(async () => jsonResponse({ applicationId: 'app-demo', operation: null, steps: [] })), { id: 'app-demo', operationId: 'op-9' });
  expect(missing.element.textContent).toContain('Workflow not found');
  const malformed = await renderWorkflowPage(context(async () => jsonResponse({ unexpected: true })), { id: 'app-demo', operationId: 'op-1' });
  expect(malformed.element.textContent).toContain('Workflow not found');
});

// The action chain after a click is a bounded sequence of promise awaits
// (fetch -> undici response.text() -> JSON.parse -> status render). undici
// resolves stream reads across several microtask hops; pumping the microtask
// queue a bounded number of times settles it deterministically without
// wall-clock timers.
const flush = async (): Promise<void> => {
  for (let hop = 0; hop < 50; hop += 1) await Promise.resolve();
};

function buttonsOf(view: { element: HTMLElement }): FakeElement[] {
  return findTags(asFakeElement(view.element), 'BUTTON');
}

it('offers retry for failed operations and posts to the exact existing endpoint', async () => {
  const payload = { applicationId: 'app-demo', operation: { ...OPERATION, status: 'FAILED' }, steps: [] };
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return jsonResponse({ workflowId: 'op-1', operationId: 'op-1', status: 'QUEUED', retriedOperationId: 'op-1' }, 202);
    return jsonResponse(payload);
  });
  const view = await renderWorkflowPage(context(fetchImpl), { id: 'app-demo', operationId: 'op-1' });
  expect(view.element.textContent).toContain('Operator actions');
  const retry = buttonsOf(view).find((button) => button.textContent === 'RETRY');
  expect(retry).toBeDefined();
  retry?.click();
  await flush();
  expect(fetchImpl).toHaveBeenCalledWith(
    '/v1/applications/app-demo/actions/retry',
    expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ authorization: 'Bearer operator-token' }) }),
  );
  expect(view.element.textContent).toContain('Retry queued for op-1');
});

it('offers cancel for queued operations only after confirmation, with the idempotency key', async () => {
  const payload = { applicationId: 'app-demo', operation: { ...OPERATION, status: 'QUEUED' }, steps: [] };
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return jsonResponse({ workflowId: 'op-1', operationId: 'op-1', status: 'CANCELED', replay: false });
    return jsonResponse(payload);
  });
  const view = await renderWorkflowPage(context(fetchImpl), { id: 'app-demo', operationId: 'op-1' });
  const cancel = buttonsOf(view).find((button) => button.textContent === 'CANCEL');
  expect(cancel).toBeDefined();
  cancel?.click();
  // The first click only arms the confirmation; only the page read happened.
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  cancel?.click();
  await flush();
  expect(fetchImpl).toHaveBeenCalledWith(
    '/v1/applications/app-demo/actions/cancel',
    expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'idempotency-key': cancelIdempotencyKey('app-demo', 'op-1') }) }),
  );
  expect(view.element.textContent).toContain('Operation op-1 canceled');
});

it('renders no action controls for terminal operations', async () => {
  const payload = { applicationId: 'app-demo', operation: { ...OPERATION, status: 'SUCCEEDED' }, steps: [] };
  const view = await renderWorkflowPage(context(async () => jsonResponse(payload)), { id: 'app-demo', operationId: 'op-1' });
  expect(view.element.textContent).toContain('No operator actions are available for a SUCCEEDED operation.');
  expect(buttonsOf(view)).toHaveLength(0);
});
