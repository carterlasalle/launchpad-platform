import { expect, it, vi } from 'vitest';
import { ApiClient, ApiError, requireArrayField, UnauthenticatedError } from './api.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

it('fails closed without a session token and never issues a request', async () => {
  const fetchImpl = vi.fn(async () => jsonResponse({ applications: [] }));
  const client = new ApiClient({ token: null, fetchImpl });
  await expect(client.get('/v1/applications')).rejects.toBeInstanceOf(UnauthenticatedError);
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('sends the operator token as a bearer credential on protected reads', async () => {
  const fetchImpl = vi.fn(async () => jsonResponse({ applications: [] }));
  const client = new ApiClient({ token: 'operator-token', fetchImpl });
  await client.get('/v1/applications');
  expect(fetchImpl).toHaveBeenCalledWith(
    '/v1/applications',
    expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer operator-token', accept: 'application/json' }),
    }),
  );
});

it('treats a rejected token as unauthenticated and notifies the shell', async () => {
  const onUnauthorized = vi.fn();
  const client = new ApiClient({
    token: 'expired-token',
    fetchImpl: async () => jsonResponse({ error: 'operator authentication required' }, 401),
    onUnauthorized,
  });
  await expect(client.get('/v1/applications')).rejects.toBeInstanceOf(UnauthenticatedError);
  expect(onUnauthorized).toHaveBeenCalledOnce();
});

it('surfaces server errors with a concise message from the error body', async () => {
  const client = new ApiClient({ token: 'token', fetchImpl: async () => jsonResponse({ error: 'control plane exploded' }, 500) });
  const error = await client.get('/v1/applications').catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ code: 'SERVER', status: 500, message: 'control plane exploded' });
});

it('truncates long server messages to a concise summary', async () => {
  const longMessage = 'x'.repeat(500);
  const client = new ApiClient({ token: 'token', fetchImpl: async () => jsonResponse({ error: longMessage }, 500) });
  const error = await client.get('/v1/applications').catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).message.length).toBeLessThanOrEqual(161);
  expect((error as ApiError).message.endsWith('…')).toBe(true);
});

it('fails closed on malformed non-JSON responses instead of guessing', async () => {
  const client = new ApiClient({ token: 'token', fetchImpl: async () => new Response('<html>not json</html>', { status: 200 }) });
  const error = await client.get('/v1/applications').catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ code: 'INVALID_RESPONSE' });
});

it('maps network failures to a concise NETWORK error', async () => {
  const client = new ApiClient({
    token: 'token',
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  const error = await client.get('/v1/applications').catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ code: 'NETWORK', message: 'Control plane unreachable.' });
});

it('sends idempotency keys on mutations', async () => {
  const fetchImpl = vi.fn(async () => jsonResponse({ workflowId: 'w-1', status: 'QUEUED' }, 202));
  const client = new ApiClient({ token: 'token', fetchImpl });
  await client.post('/v1/applications/app/actions/retry', {}, 'idem-1');
  expect(fetchImpl).toHaveBeenCalledWith(
    '/v1/applications/app/actions/retry',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'idempotency-key': 'idem-1', 'content-type': 'application/json' }),
    }),
  );
});

it('rejects malformed payloads through requireArrayField', () => {
  expect(() => requireArrayField({ applications: 'not-an-array' }, 'applications', 'application list')).toThrowError(
    expect.objectContaining({ code: 'INVALID_RESPONSE', message: 'Control plane returned a malformed application list.' }),
  );
  expect(() => requireArrayField({}, 'applications', 'application list')).toThrowError(ApiError);
  expect(requireArrayField({ applications: [{ id: 'a' }] }, 'applications', 'application list')).toEqual([{ id: 'a' }]);
});
