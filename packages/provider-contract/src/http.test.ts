import { describe, expect, it } from 'vitest';
import { ProviderHttpClient, ProviderRequestError } from './index.js';

describe('provider HTTP client', () => {
  it('adds auth and correlation headers and parses JSON', async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token');
      expect(new Headers(init?.headers).get('x-launchpad-correlation-id')).toBe('corr');
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const client = new ProviderHttpClient({ baseUrl: 'https://provider.test/', token: 'token', provider: 'vercel', fetchImpl });
    await expect(client.request('/v1/test', { correlationId: 'corr' })).resolves.toEqual({ ok: true });
  });

  it('classifies rate limits and malformed responses without exposing credentials', async () => {
    const rateLimited: typeof fetch = async () => new Response('{"message":"slow"}', { status: 429 });
    const client = new ProviderHttpClient({ baseUrl: 'https://provider.test', token: 'secret-token', provider: 'github', fetchImpl: rateLimited });
    await expect(client.request('/rate')).rejects.toMatchObject({ class: 'RATE_LIMITED', retryable: true });
    const malformed: typeof fetch = async () => new Response('not-json', { status: 200 });
    const malformedClient = new ProviderHttpClient({ baseUrl: 'https://provider.test', token: 'secret-token', provider: 'github', fetchImpl: malformed });
    await expect(malformedClient.request('/malformed')).rejects.toMatchObject({ code: 'LP-GITHUB-MALFORMED-RESPONSE' });
  });

  it('strips CR/LF contamination from credential values so header setting never throws', async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      seen.push(new Headers(init?.headers).get('authorization') ?? '');
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const client = new ProviderHttpClient({ baseUrl: 'https://provider.test', token: 'abc\r\ndef\n', provider: 'github', fetchImpl });
    await expect(client.request('/v1')).resolves.toEqual({ ok: true });
    expect(seen[0]).toBe('Bearer abcdef');
  });

  it('names the underlying exception class and message in network failures', async () => {
    const failing: typeof fetch = async () => { throw new TypeError('fetch failed'); };
    const client = new ProviderHttpClient({ baseUrl: 'https://provider.test', token: 'token', provider: 'github', fetchImpl: failing });
    await expect(client.request('/v1')).rejects.toMatchObject({ code: 'LP-GITHUB-NETWORK', message: expect.stringContaining('TypeError: fetch failed') });
  });

  it('fails closed when credentials are missing', async () => {
    const client = new ProviderHttpClient({ baseUrl: 'https://provider.test', provider: 'cloudflare', fetchImpl: fetch });
    await expect(client.request('/v4')).rejects.toBeInstanceOf(ProviderRequestError);
  });
});
