// DOM tests for the operator action controls: every control must issue the
// exact existing control-plane endpoint with the session token, show
// pending/success/error states, and refuse to send destructive or
// provider-affecting requests (rollback, cancel, config changes) until the
// operator confirms. Config changes only ever create PR requests against the
// control repository — never a provider API.

import { beforeEach, expect, it, vi } from 'vitest';
import { ApiClient } from './api.js';
import { cancelIdempotencyKey, configChangeControls, operatorActionControls } from './actions.js';
import { asFakeElement, findTags, installDomShim, type FakeElement } from './test/dom-shim.js';

beforeEach(() => installDomShim());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// The action chain after a click is a bounded sequence of promise awaits
// (fetch -> undici response.text() -> JSON.parse -> status render). undici
// resolves stream reads across several microtask hops; pumping the microtask
// queue a bounded number of times settles it deterministically without
// wall-clock timers.
const flush = async (): Promise<void> => {
  for (let hop = 0; hop < 50; hop += 1) await Promise.resolve();
};

function buttons(root: HTMLElement): FakeElement[] {
  return findTags(asFakeElement(root), 'BUTTON');
}

function buttonByText(root: HTMLElement, text: string): FakeElement {
  const found = buttons(root).find((button) => button.textContent === text);
  if (!found) throw new Error(`no button with text '${text}'`);
  return found;
}

function inputs(root: HTMLElement): FakeElement[] {
  return findTags(asFakeElement(root), 'INPUT');
}

it('posts a retry to the exact existing action endpoint with the session token', async () => {
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ workflowId: 'w-1', operationId: 'op-1', status: 'QUEUED', retriedOperationId: 'op-1' }, 202));
  const client = new ApiClient({ token: 'operator-token', fetchImpl });
  const root = operatorActionControls({ client, applicationId: 'acme', operationId: 'op-1', kinds: ['retry'] });
  buttonByText(root, 'RETRY').click();
  await flush();
  expect(fetchImpl).toHaveBeenCalledWith(
    '/v1/applications/acme/actions/retry',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer operator-token', 'content-type': 'application/json' }),
    }),
  );
  const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
  expect(init?.body !== undefined ? JSON.parse(String(init.body)) : null).toEqual({ operationId: 'op-1' });
  expect(root.textContent).toContain('Retry queued for op-1');
});

it('requires confirmation before canceling and posts the deterministic idempotency key', async () => {
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ workflowId: 'op-9', operationId: 'op-9', status: 'CANCELED', replay: false }));
  const client = new ApiClient({ token: 'operator-token', fetchImpl });
  const root = operatorActionControls({ client, applicationId: 'acme', operationId: 'op-9', kinds: ['cancel'] });
  const cancel = buttonByText(root, 'CANCEL');
  cancel.click();
  // The first click only arms the confirmation; nothing is sent.
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(cancel.textContent).toBe('CONFIRM CANCEL');
  cancel.click();
  await flush();
  expect(fetchImpl).toHaveBeenCalledWith(
    '/v1/applications/acme/actions/cancel',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'idempotency-key': cancelIdempotencyKey('acme', 'op-9'), authorization: 'Bearer operator-token' }),
    }),
  );
  const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
  expect(init?.body !== undefined ? JSON.parse(String(init.body)) : null).toEqual({ operationId: 'op-9' });
  expect(root.textContent).toContain('Operation op-9 canceled');
});

it('posts recheck directly and rollback only after confirmation', async () => {
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ workflowId: 'w', status: 'QUEUED', dispatched: 'handler' }, 202));
  const client = new ApiClient({ token: 'token', fetchImpl });
  const root = operatorActionControls({ client, applicationId: 'acme', kinds: ['recheck', 'rollback'] });
  buttonByText(root, 'RECHECK HEALTH').click();
  await flush();
  expect(fetchImpl).toHaveBeenCalledWith('/v1/applications/acme/actions/recheck', expect.objectContaining({ method: 'POST' }));
  const rollback = buttonByText(root, 'ROLLBACK');
  rollback.click();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  rollback.click();
  await flush();
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(fetchImpl.mock.calls[1]?.[0]).toBe('/v1/applications/acme/actions/rollback');
  const init = fetchImpl.mock.calls[1]?.[1] as RequestInit | undefined;
  expect(init?.body !== undefined ? JSON.parse(String(init.body)) : null).toEqual({});
  expect(root.textContent).toContain('Rollback queued to known-good');
});

it('shows pending while in flight, disables controls, and reports success', async () => {
  const pending: { resolve?: (response: Response) => void } = {};
  const promise = new Promise<Response>((resolve) => { pending.resolve = resolve; });
  const fetchImpl = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => promise);
  const client = new ApiClient({ token: 'token', fetchImpl });
  const root = operatorActionControls({ client, applicationId: 'acme', operationId: 'op-1', kinds: ['cancel'] });
  const cancel = buttonByText(root, 'CANCEL');
  cancel.click();
  cancel.click();
  expect(root.textContent).toContain('CANCEL pending…');
  // The DOM shim has no `disabled` member; the component sets it as a plain property.
  const cancelButton = cancel as unknown as { disabled?: boolean };
  expect(cancelButton.disabled).toBe(true);
  if (!pending.resolve) throw new Error('response resolver was not initialized');
  pending.resolve(jsonResponse({ workflowId: 'op-1', operationId: 'op-1', status: 'CANCELED', replay: false }));
  await flush();
  expect(root.textContent).toContain('Operation op-1 canceled');
  expect(cancelButton.disabled).toBe(false);
});

it('shows a concise error when the control plane rejects the action', async () => {
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ error: { code: 'LP-CANCEL-RUNNING', message: 'The operation is RUNNING; canceling a running operation is not allowed.', retryable: false } }, 409));
  const client = new ApiClient({ token: 'token', fetchImpl });
  const root = operatorActionControls({ client, applicationId: 'acme', operationId: 'op-1', kinds: ['cancel'] });
  const cancel = buttonByText(root, 'CANCEL');
  cancel.click();
  cancel.click();
  await flush();
  // The control plane's error envelope surfaces (bounded) as the status text.
  expect(root.textContent).toContain('Action failed:');
  expect(root.textContent).toContain('LP-CANCEL-RUNNING');
});

it('fails closed without a session token: no request is ever issued', async () => {
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({}));
  const client = new ApiClient({ token: null, fetchImpl });
  const root = operatorActionControls({ client, applicationId: 'acme', operationId: 'op-1', kinds: ['retry'] });
  buttonByText(root, 'RETRY').click();
  await flush();
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(root.textContent).toContain('Action failed: no operator session token');
});

it('skips operation-bound kinds when no operationId is supplied', () => {
  const client = new ApiClient({ token: 'token', fetchImpl: async () => jsonResponse({}) });
  const root = operatorActionControls({ client, applicationId: 'acme', kinds: ['retry', 'recheck'] });
  expect(buttons(root).map((button) => button.textContent)).toEqual(['RECHECK HEALTH']);
});

it('announces status changes through an aria-live region', () => {
  const client = new ApiClient({ token: 'token', fetchImpl: async () => jsonResponse({}) });
  const root = operatorActionControls({ client, applicationId: 'acme', kinds: ['recheck'] });
  const live = findTags(asFakeElement(root), 'P').find((p) => p.getAttribute('aria-live') === 'polite');
  expect(live).toBeDefined();
});

it('config change controls only create control-repository PR requests', async () => {
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ applicationId: 'acme', change: 'root', replay: false, pullRequest: { number: 7, url: 'https://github.com/acme/control/pull/7', branch: 'launchpad/root/acme/x' } }));
  const client = new ApiClient({ token: 'operator-token', fetchImpl });
  const root = configChangeControls({ client, applicationId: 'acme' });
  const rootInput = inputs(root).find((input) => input.getAttribute('placeholder') === 'apps/web');
  expect(rootInput).toBeDefined();
  rootInput?.setAttribute('value', 'apps/web');
  const openPr = buttonByText(root, 'OPEN PR: ROOT DIRECTORY');
  openPr.click();
  expect(fetchImpl).not.toHaveBeenCalled();
  openPr.click();
  await flush();
  expect(fetchImpl).toHaveBeenCalledWith(
    '/v1/applications/acme/changes/root',
    expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ authorization: 'Bearer operator-token' }) }),
  );
  const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
  expect(init?.body !== undefined ? JSON.parse(String(init.body)) : null).toEqual({ value: 'apps/web' });
  expect(root.textContent).toContain('Pull request opened: https://github.com/acme/control/pull/7');
  // Every requested URL is a control-plane changes endpoint — never a provider API.
  for (const call of fetchImpl.mock.calls) expect(String(call[0])).toMatch(/^\/v1\/applications\/[^/]+\/changes\/[a-z]+$/);
});

it('adopt and restore changes post with no body fields after confirmation', async () => {
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ applicationId: 'acme', change: 'adopt', replay: false, pullRequest: { number: 8, url: 'https://github.com/acme/control/pull/8' } }));
  const client = new ApiClient({ token: 'token', fetchImpl });
  const root = configChangeControls({ client, applicationId: 'acme' });
  const adopt = buttonByText(root, 'OPEN PR: ADOPT OBSERVED ROOT');
  adopt.click();
  expect(fetchImpl).not.toHaveBeenCalled();
  adopt.click();
  await flush();
  expect(fetchImpl).toHaveBeenCalledWith('/v1/applications/acme/changes/adopt', expect.objectContaining({ method: 'POST' }));
  const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
  expect(init?.body !== undefined ? JSON.parse(String(init.body)) : null).toEqual({});
  expect(root.textContent).toContain('Pull request opened: https://github.com/acme/control/pull/8');
});

it('sends env change fields from the form inputs', async () => {
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ applicationId: 'acme', change: 'env', replay: false, pullRequest: { number: 9, url: 'https://github.com/acme/control/pull/9' } }));
  const client = new ApiClient({ token: 'token', fetchImpl });
  const root = configChangeControls({ client, applicationId: 'acme' });
  const nameInput = inputs(root).find((input) => input.getAttribute('placeholder') === 'API_URL');
  const valueInput = inputs(root).find((input) => input.getAttribute('placeholder') === 'https://api.example.com');
  nameInput?.setAttribute('value', 'LOG_LEVEL');
  valueInput?.setAttribute('value', 'debug');
  const button = buttonByText(root, 'OPEN PR: ENVIRONMENT VARIABLE');
  button.click();
  button.click();
  await flush();
  expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('/v1/applications/acme/changes/env');
  const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
  expect(init?.body !== undefined ? JSON.parse(String(init.body)) : null).toEqual({ environment: 'production', name: 'LOG_LEVEL', value: 'debug' });
});
