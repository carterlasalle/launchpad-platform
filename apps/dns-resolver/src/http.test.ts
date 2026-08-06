import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDnsHttpAdapter, createDnsHttpHandler, JSON_CONTENT_TYPE, type DnsHttpRequest } from './http.js';
import { DnsResolverFailure, type ResolverDependencies } from './resolver.js';

const NS_ADA = 'ada.ns.cloudflare.com';
const NS_CHIP = 'chip.ns.cloudflare.com';

function fakeDependencies(answers: string[] = ['192.0.2.10']): ResolverDependencies {
  return {
    lookup: vi.fn(async () => '192.0.2.53'),
    query: vi.fn(async () => answers),
  };
}

function failingDependencies(failure: DnsResolverFailure | Error): ResolverDependencies {
  return {
    lookup: vi.fn(async () => '192.0.2.53'),
    query: vi.fn(async () => {
      throw failure;
    }),
  };
}

function request(overrides: Partial<DnsHttpRequest> = {}): DnsHttpRequest {
  return {
    method: 'POST',
    contentType: 'application/json',
    body: JSON.stringify({ hostname: 'www.carterlasalle.com', type: 'A', nameservers: [NS_ADA, NS_CHIP] }),
    ...overrides,
  };
}

describe('createDnsHttpAdapter', () => {
  it('emits the exact success envelope with a JSON content type', async () => {
    const adapter = createDnsHttpAdapter(fakeDependencies(['192.0.2.10']));
    const response = await adapter(request());
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe(JSON_CONTENT_TYPE);
    expect(response.headers['cache-control']).toBe('no-store');
    const parsed = JSON.parse(response.body) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['answers', 'nameservers']);
    expect(parsed).toEqual({ answers: ['192.0.2.10'], nameservers: [NS_ADA, NS_CHIP] });
  });

  it('rejects unsupported methods with 405 and Allow: POST without querying', async () => {
    const dependencies = fakeDependencies();
    const adapter = createDnsHttpAdapter(dependencies);
    for (const method of ['GET', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
      const response = await adapter(request({ method }));
      expect(response.status).toBe(405);
      expect(response.headers['allow']).toBe('POST');
    }
    expect(dependencies.query).not.toHaveBeenCalled();
  });

  it('rejects non-JSON content types with 415', async () => {
    const adapter = createDnsHttpAdapter(fakeDependencies());
    for (const contentType of [undefined, 'text/plain', 'application/x-www-form-urlencoded']) {
      const response = await adapter(request({ contentType }));
      expect(response.status).toBe(415);
      expect(JSON.parse(response.body)).toEqual({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: expect.any(String) } });
    }
  });

  it('accepts a JSON content type with parameters', async () => {
    const adapter = createDnsHttpAdapter(fakeDependencies());
    const response = await adapter(request({ contentType: 'application/json; charset=utf-8' }));
    expect(response.status).toBe(200);
  });

  it('rejects malformed JSON with 400', async () => {
    const adapter = createDnsHttpAdapter(fakeDependencies());
    const response = await adapter(request({ body: '{"hostname":' }));
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: { code: 'INVALID_JSON', message: expect.any(String) } });
  });

  it('rejects semantically invalid hostname, type, nameserver, and body shapes with 400', async () => {
    const adapter = createDnsHttpAdapter(fakeDependencies());
    const bodies = [
      JSON.stringify({ hostname: 'evil.example.com', type: 'A', nameservers: [NS_ADA] }),
      JSON.stringify({ hostname: 'www.carterlasalle.com', type: 'MX', nameservers: [NS_ADA] }),
      JSON.stringify({ hostname: 'www.carterlasalle.com', type: 'A', nameservers: ['ns1.google.com'] }),
      JSON.stringify({ hostname: 'www.carterlasalle.com', type: 'A', nameservers: [NS_ADA], debug: true }),
      JSON.stringify({ hostname: 'www.carterlasalle.com', type: 'A' }),
      '[1,2,3]',
    ];
    for (const body of bodies) {
      const response = await adapter(request({ body }));
      expect(response.status, body).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: { code: 'INVALID_QUERY', message: expect.any(String) } });
    }
  });

  it('rejects an empty JSON request body with 400 INVALID_JSON', async () => {
    const adapter = createDnsHttpAdapter(fakeDependencies());
    const response = await adapter(request({ body: '' }));
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: { code: 'INVALID_JSON', message: expect.any(String) } });
  });

  it('rejects an oversized request body with 413', async () => {
    const adapter = createDnsHttpAdapter(fakeDependencies(), { maxRequestBytes: 32 });
    const response = await adapter(request());
    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toEqual({ error: { code: 'REQUEST_TOO_LARGE', message: expect.any(String) } });
  });

  it('maps upstream timeouts to 504', async () => {
    const adapter = createDnsHttpAdapter(failingDependencies(new DnsResolverFailure('TIMEOUT', 'timeout')));
    const response = await adapter(request());
    expect(response.status).toBe(504);
    expect(JSON.parse(response.body)).toEqual({ error: { code: 'TIMEOUT', message: expect.any(String) } });
  });

  it('maps lookup and query failures to 502 without leaking provider detail', async () => {
    const adapter = createDnsHttpAdapter(failingDependencies(new Error('EHOSTUNREACH ns.cloudflare.com 10.0.0.1')));
    const response = await adapter(request());
    expect(response.status).toBe(502);
    expect(response.body).not.toContain('EHOSTUNREACH');
    expect(response.body).not.toContain('10.0.0.1');
    expect(response.body).not.toContain(NS_ADA);
    expect(JSON.parse(response.body)).toEqual({ error: { code: 'QUERY_FAILED', message: expect.any(String) } });

    const lookupFailure = createDnsHttpAdapter({
      lookup: vi.fn(async () => {
        throw new Error('EAI_AGAIN');
      }),
      query: vi.fn(async () => []),
    });
    const lookupResponse = await lookupFailure(request());
    expect(lookupResponse.status).toBe(502);
    expect(JSON.parse(lookupResponse.body)).toEqual({ error: { code: 'NAMESERVER_LOOKUP_FAILED', message: expect.any(String) } });
  });

  it('maps answers beyond the response bound to 502', async () => {
    const adapter = createDnsHttpAdapter(failingDependencies(new DnsResolverFailure('RESPONSE_BOUND_EXCEEDED', 'bound')));
    const response = await adapter(request());
    expect(response.status).toBe(502);
    expect(JSON.parse(response.body)).toEqual({ error: { code: 'RESPONSE_BOUND_EXCEEDED', message: expect.any(String) } });
  });
});

describe('createDnsHttpHandler', () => {
  let server: Server | null = null;

  afterEach(async () => {
    const current = server;
    server = null;
    if (!current) return;
    await new Promise<void>((resolve, reject) => current.close((error) => (error ? reject(error) : resolve())));
  });

  async function withServer(dependencies: ResolverDependencies): Promise<URL> {
    server = createServer(createDnsHttpHandler(dependencies));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return new URL(`http://127.0.0.1:${port}/api/dns`);
  }

  it('serves the exact envelope over real HTTP and fails closed', async () => {
    const url = await withServer(fakeDependencies(['192.0.2.10']));

    const ok = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostname: 'www.carterlasalle.com', type: 'A', nameservers: [NS_ADA, NS_CHIP] }),
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe(JSON_CONTENT_TYPE);
    expect(await ok.json()).toEqual({ answers: ['192.0.2.10'], nameservers: [NS_ADA, NS_CHIP] });

    const wrongMethod = await fetch(url, { method: 'GET' });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('POST');

    const malformed = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' });
    expect(malformed.status).toBe(400);

    const outOfZone = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostname: 'evil.example.com', type: 'A', nameservers: [NS_ADA] }),
    });
    expect(outOfZone.status).toBe(400);
  });

  it('rejects an oversized streamed request body with 413', async () => {
    const url = await withServer(fakeDependencies());
    const oversized = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostname: `www.carterlasalle.com`, type: 'A', nameservers: [NS_ADA], padding: 'x'.repeat(20 * 1024) }),
    });
    expect(oversized.status).toBe(413);
  });
});
