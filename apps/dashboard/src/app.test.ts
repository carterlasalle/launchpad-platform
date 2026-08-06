// App-level end-to-end session test: imports the real dashboard shell
// (app.ts + HashRouter) against the DOM shim and a stubbed fetch, and proves
// the session token gates the first authenticated navigation. No token →
// fail-closed unauthenticated view with zero network calls; token entry
// through the session panel UI → authenticated reads and navigation with the
// Bearer credential; logout → fail-closed again with zero new network calls.
// A second scenario proves a token already in storage makes the first
// navigation authenticated from the start.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readSessionToken, writeSessionToken } from './session.js';
import { asFakeElement, findTags, fireWindowEvent, installDomShim, windowShim, type FakeElement } from './test/dom-shim.js';
import { FakeSessionStorage, installSessionStorage } from './test/fake-session-storage.js';

// The shell element ids app.ts resolves at import time.
const SHELL_IDS = ['view', 'auth-state', 'session-panel', 'session-token', 'session-hint', 'session-toggle', 'session-save', 'session-clear', 'current-time'];

const APPLICATION = {
  application: 'acme',
  displayName: 'Acme Corp',
  owner: 'platform',
  sync: 'SYNCED',
  health: 'HEALTHY',
  deployment: 'CURRENT',
  productionUrl: 'acme.example.com',
  updatedAt: '2026-08-04T00:00:00.000Z',
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function shellElement(id: string): FakeElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing shell element #${id}`);
  return asFakeElement(element);
}

// The startup render is a bounded chain of promise awaits (router.render ->
// ApiClient.request -> stubbed fetch -> undici response.text() -> JSON.parse
// -> page render); pumping the microtask queue settles it deterministically.
const flush = async (): Promise<void> => {
  for (let hop = 0; hop < 100; hop += 1) await Promise.resolve();
};

function fetchStub(): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/v1/credentials') return jsonResponse({ credentials: [] });
    return jsonResponse({ applications: [APPLICATION], limit: 500, truncated: false });
  });
}

beforeEach(() => {
  installDomShim();
  for (const id of SHELL_IDS) {
    const element = document.createElement('div');
    element.id = id;
  }
  installSessionStorage(new FakeSessionStorage());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('gates the first navigation on a session token: login via the session panel, authenticated navigation, logout', async () => {
  const fetchImpl = fetchStub();
  vi.stubGlobal('fetch', fetchImpl);
  vi.resetModules();

  await import('./app.js');
  await flush();

  const view = shellElement('view');
  const authState = shellElement('auth-state');

  // 1. No token in storage: the first navigation fails closed with an
  //    authentication view and ZERO network calls.
  expect(readSessionToken()).toBeNull();
  expect(authState.textContent).toContain('NO SESSION');
  expect(view.textContent).toContain('Authentication required');
  expect(view.textContent).toContain('OPEN SESSION');
  expect(fetchImpl).not.toHaveBeenCalled();

  // 2. Token entry through the session panel UI: authenticated reads now
  //    carry the Bearer credential and render catalog data.
  shellElement('session-token').value = 'operator-token-e2e';
  shellElement('session-save').click();
  await flush();
  expect(readSessionToken()).toBe('operator-token-e2e');
  expect(authState.textContent).toContain('SESSION ACTIVE');
  expect(view.textContent).toContain('Acme Corp');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl).toHaveBeenCalledWith(
    '/v1/applications',
    expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer operator-token-e2e' }) }),
  );

  // 3. Authenticated hash navigation reaches other protected views with the
  //    same credential.
  windowShim.location.hash = '#/credentials';
  fireWindowEvent('hashchange');
  await flush();
  expect(view.textContent).toContain('Credentials');
  expect(view.textContent).toContain('has not recorded credential metadata');
  expect(fetchImpl).toHaveBeenCalledWith(
    '/v1/credentials',
    expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer operator-token-e2e' }) }),
  );

  // 4. Logout clears storage and the in-memory token; the next navigation
  //    fails closed again with zero NEW network calls.
  const callsBeforeLogout = fetchImpl.mock.calls.length;
  shellElement('session-clear').click();
  await flush();
  expect(readSessionToken()).toBeNull();
  expect(authState.textContent).toContain('NO SESSION');
  expect(view.textContent).toContain('Authentication required');

  windowShim.location.hash = '#/operations';
  fireWindowEvent('hashchange');
  await flush();
  expect(view.textContent).toContain('Authentication required');
  expect(fetchImpl.mock.calls.length).toBe(callsBeforeLogout);
});

it('makes the first navigation authenticated when a token is already stored', async () => {
  const fetchImpl = fetchStub();
  vi.stubGlobal('fetch', fetchImpl);
  writeSessionToken('stored-token-e2e');
  vi.resetModules();

  await import('./app.js');
  await flush();

  const view = shellElement('view');
  expect(readSessionToken()).toBe('stored-token-e2e');
  expect(shellElement('auth-state').textContent).toContain('SESSION ACTIVE');
  expect(view.textContent).toContain('Acme Corp');
  expect(view.textContent).not.toContain('Authentication required');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl).toHaveBeenCalledWith(
    '/v1/applications',
    expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer stored-token-e2e' }) }),
  );
  // A table renders the catalog row.
  const tables = findTags(asFakeElement(view), 'TABLE');
  expect(tables).toHaveLength(1);
});
