// Session lifecycle contract for the dashboard: read/write/clear through the
// namespaced sessionStorage key, fail-soft behavior when storage is
// unavailable, and the ApiClient integration — the stored token becomes the
// Bearer credential on protected reads, a rejected token (401) clears the
// session and fails closed with zero further network calls, and a missing
// token fails closed before any network call.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiClient, UnauthenticatedError } from './api.js';
import { readSessionToken, writeSessionToken } from './session.js';
import { FakeSessionStorage, installSessionStorage } from './test/fake-session-storage.js';

const SESSION_TOKEN_KEY = 'launchpad.dashboard.sessionToken';

let storage: FakeSessionStorage;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  storage = new FakeSessionStorage();
  installSessionStorage(storage);
});

afterEach(() => {
  vi.restoreAllMocks();
});

it('returns null when nothing is stored', () => {
  expect(storage.size).toBe(0);
  expect(readSessionToken()).toBeNull();
});

it('round-trips a stored token through write and read', () => {
  writeSessionToken('operator-token-123');
  expect(readSessionToken()).toBe('operator-token-123');
  expect(storage.getItem(SESSION_TOKEN_KEY)).toBe('operator-token-123');
});

it('clears the stored session when writeSessionToken(null) is called', () => {
  writeSessionToken('operator-token-123');
  writeSessionToken(null);
  expect(readSessionToken()).toBeNull();
  expect(storage.size).toBe(0);
});

it('stores the token only under the namespaced session key, never a bare key', () => {
  writeSessionToken('operator-token-123');
  expect(storage.keys()).toEqual([SESSION_TOKEN_KEY]);
  expect(storage.getItem(SESSION_TOKEN_KEY)).toBe('operator-token-123');
  expect(storage.getItem('sessionToken')).toBeNull();
  expect(storage.getItem('token')).toBeNull();
});

it('fails soft when storage is unavailable: read returns null and writes no-op', () => {
  installSessionStorage({
    getItem: () => {
      throw new Error('storage denied');
    },
    setItem: () => {
      throw new Error('storage denied');
    },
    removeItem: () => {
      throw new Error('storage denied');
    },
  });
  expect(readSessionToken()).toBeNull();
  expect(() => writeSessionToken('operator-token-123')).not.toThrow();
  expect(() => writeSessionToken(null)).not.toThrow();
});

it('sends the stored token as a Bearer credential on ApiClient requests', async () => {
  writeSessionToken('operator-token-123');
  const fetchImpl = vi.fn(async () => jsonResponse({ applications: [] }));
  const client = new ApiClient({ token: readSessionToken(), fetchImpl });
  await client.get('/v1/applications');
  expect(fetchImpl).toHaveBeenCalledWith(
    '/v1/applications',
    expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer operator-token-123' }),
    }),
  );
});

it('clears token and storage when the control plane rejects the session (401), then fails closed with zero network calls', async () => {
  writeSessionToken('expired-token');
  const fetchImpl = vi.fn(async () => jsonResponse({ error: 'operator authentication required' }, 401));
  const client = new ApiClient({
    token: readSessionToken(),
    fetchImpl,
    onUnauthorized: () => {
      // Mirrors the shell wiring: a rejected session logs the operator out at
      // both the in-memory client and the storage layer.
      writeSessionToken(null);
      client.setToken(null);
    },
  });
  await expect(client.get('/v1/applications')).rejects.toBeInstanceOf(UnauthenticatedError);
  expect(client.token).toBeNull();
  expect(readSessionToken()).toBeNull();
  expect(storage.size).toBe(0);
  // The cleared session fails closed before the network: no further calls.
  await expect(client.get('/v1/applications')).rejects.toBeInstanceOf(UnauthenticatedError);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('fails closed before any network call when no token is stored', async () => {
  const fetchImpl = vi.fn(async () => jsonResponse({ applications: [] }));
  const client = new ApiClient({ token: readSessionToken(), fetchImpl });
  await expect(client.get('/v1/applications')).rejects.toBeInstanceOf(UnauthenticatedError);
  expect(fetchImpl).not.toHaveBeenCalled();
});
