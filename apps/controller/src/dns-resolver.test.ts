import { expect, it } from 'vitest';
import { ProviderRequestError } from '@launchpad/provider-contract';
import { AUTHORITATIVE_DNS_RESOLVER_CORRELATION_HEADER, createAuthoritativeDnsResolver } from './dns-resolver.js';
import { createCloudflareAdapterForEnv } from './handlers.js';

const RESOLVER_URL = 'https://resolver.launchpad.internal/v1/dns';
const NAMESERVERS = ['ns1.example.com.', 'ns2.example.com.'];

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Records every resolver request and lets the test script the response. */
function capturingFetch(handler: (call: CapturedCall) => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    for (const [key, value] of new Headers(init?.headers).entries()) headers[key.toLowerCase()] = value;
    const body = typeof init?.body === 'string' && init.body.length > 0 ? (JSON.parse(init.body) as unknown) : undefined;
    const call = { url, method: (init?.method ?? 'GET').toUpperCase(), headers, body };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function rejection(promise: Promise<unknown>): Promise<ProviderRequestError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderRequestError) return error;
    throw new Error(`expected a ProviderRequestError, got '${String(error)}'`);
  }
  throw new Error('expected the resolver to reject');
}

function buildResolver(fetchImpl: typeof fetch, timeoutMs?: number) {
  return createAuthoritativeDnsResolver({ url: RESOLVER_URL, correlationId: () => 'corr-test-1', fetchImpl, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

it('posts the exact query contract to the configured HTTPS endpoint and returns only answers', async () => {
  const { fetchImpl, calls } = capturingFetch(() => jsonResponse({ answers: ['192.0.2.1', '192.0.2.2'], nameservers: [...NAMESERVERS] }));
  const resolver = buildResolver(fetchImpl);

  await expect(resolver('api.example.com', 'A', [...NAMESERVERS])).resolves.toEqual(['192.0.2.1', '192.0.2.2']);

  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  expect(call.method).toBe('POST');
  expect(call.url).toBe(RESOLVER_URL);
  expect(call.body).toEqual({ hostname: 'api.example.com', type: 'A', nameservers: [...NAMESERVERS] });
  // The query envelope carries exactly the contract fields: no secret or extra values may ever be smuggled in.
  expect(Object.keys(call.body as Record<string, unknown>).sort()).toEqual(['hostname', 'nameservers', 'type']);
  expect(call.headers['content-type']).toBe('application/json');
  expect(call.headers['accept']).toBe('application/json');
  expect(call.headers[AUTHORITATIVE_DNS_RESOLVER_CORRELATION_HEADER]).toBe('corr-test-1');
  expect(call.headers['authorization']).toBeUndefined();
});

it('accepts the nameserver echo in any order as long as the set matches the query', async () => {
  const { fetchImpl } = capturingFetch(() => jsonResponse({ answers: ['target.example.'], nameservers: [...NAMESERVERS].reverse() }));
  const resolver = buildResolver(fetchImpl);
  await expect(resolver('app.example.com', 'CNAME', [...NAMESERVERS])).resolves.toEqual(['target.example.']);
});

it('fails closed on malformed response bodies', async () => {
  const malformedBodies: unknown[] = [
    '{not-json',
    { answers: '192.0.2.1', nameservers: [...NAMESERVERS] },
    { answers: [1, 2], nameservers: [...NAMESERVERS] },
    { answers: [], nameservers: 'ns1.example.com.' },
    { answers: null, nameservers: [...NAMESERVERS] },
  ];
  for (const body of malformedBodies) {
    const { fetchImpl } = capturingFetch(() => jsonResponse(body));
    const error = await rejection(buildResolver(fetchImpl)('api.example.com', 'A', [...NAMESERVERS]));
    expect(error.code).toBe('LP-DNS-RESOLVER-MALFORMED-RESPONSE');
    expect(error.class).toBe('MALFORMED_PROVIDER_RESPONSE');
    expect(error.retryable).toBe(false);
  }
});

it('rejects a response that echoes different nameservers than the query', async () => {
  const { fetchImpl } = capturingFetch(() => jsonResponse({ answers: ['192.0.2.1'], nameservers: ['ns.other.example.com.'] }));
  const error = await rejection(buildResolver(fetchImpl)('api.example.com', 'A', [...NAMESERVERS]));
  expect(error.code).toBe('LP-DNS-RESOLVER-NAMESERVER-MISMATCH');
  expect(error.class).toBe('MALFORMED_PROVIDER_RESPONSE');
  expect(error.retryable).toBe(false);

  const partial = await rejection(
    buildResolver(capturingFetch(() => jsonResponse({ answers: ['192.0.2.1'], nameservers: [NAMESERVERS[0]!] })).fetchImpl)('api.example.com', 'A', [...NAMESERVERS]),
  );
  expect(partial.code).toBe('LP-DNS-RESOLVER-NAMESERVER-MISMATCH');
});

it('times out and fails closed when the endpoint stalls', async () => {
  // Never resolves; the resolver's own abort signal is the only way out.
  const stalling = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  }) as typeof fetch;
  const error = await rejection(buildResolver(stalling, 25)('api.example.com', 'A', [...NAMESERVERS]));
  expect(error.code).toBe('LP-DNS-RESOLVER-TIMEOUT');
  expect(error.class).toBe('TIMEOUT');
  expect(error.retryable).toBe(true);
});

it('fails closed on HTTP errors without echoing the response body', async () => {
  const { fetchImpl } = capturingFetch(() => new Response('gateway exploded secret-value', { status: 503 }));
  const error = await rejection(buildResolver(fetchImpl)('api.example.com', 'A', [...NAMESERVERS]));
  expect(error.code).toBe('LP-DNS-RESOLVER-HTTP-503');
  expect(error.class).toBe('TRANSIENT_PROVIDER');
  expect(error.retryable).toBe(true);
  expect(error.message).not.toContain('secret-value');

  const client = await rejection(
    buildResolver(capturingFetch(() => new Response('bad request secret-value', { status: 400 })).fetchImpl)('api.example.com', 'A', [...NAMESERVERS]),
  );
  expect(client.code).toBe('LP-DNS-RESOLVER-HTTP-400');
  expect(client.retryable).toBe(false);
});

it('rejects non-HTTPS, credentialed, placeholder, and unparsable resolver URLs at construction', () => {
  for (const badUrl of ['http://resolver.internal/v1/dns', 'ftp://resolver.internal/v1/dns', 'https://user:pass@resolver.internal/v1/dns', 'not a url', '', 'https://replace-in-production/v1/dns']) {
    expect(() => createAuthoritativeDnsResolver({ url: badUrl }), `URL '${badUrl}' must be rejected`).toThrow(ProviderRequestError);
    try {
      createAuthoritativeDnsResolver({ url: badUrl });
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderRequestError);
      expect((error as ProviderRequestError).code).toBe('LP-DNS-RESOLVER-CONFIG-INVALID');
      expect((error as ProviderRequestError).retryable).toBe(false);
    }
  }
  expect(() => createAuthoritativeDnsResolver({ url: RESOLVER_URL })).not.toThrow();
});

it('rejects invalid queries before any request is made', async () => {
  const { fetchImpl, calls } = capturingFetch(() => jsonResponse({ answers: [], nameservers: [...NAMESERVERS] }));
  const resolver = buildResolver(fetchImpl);
  const cases: Array<[string, string, string[]]> = [
    ['', 'A', [...NAMESERVERS]],
    ['api.example.com', '', [...NAMESERVERS]],
    ['api.example.com', 'A', []],
    ['api.example.com', 'A', ['', 'ns2.example.com.']],
  ];
  for (const [hostname, type, nameservers] of cases) {
    const error = await rejection(resolver(hostname, type, nameservers));
    expect(error.code).toBe('LP-DNS-RESOLVER-QUERY-INVALID');
    expect(error.retryable).toBe(false);
  }
  expect(calls).toHaveLength(0);
});

it('wires a callable resolver into production CloudflareAdapter construction', () => {
  // Production construction with the resolver URL configured exposes a callable resolver.
  const production = createCloudflareAdapterForEnv({ LAUNCHPAD_ENV: 'production', CLOUDFLARE_TOKEN: 'token', LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL: RESOLVER_URL });
  expect(typeof production.resolveDns).toBe('function');

  // Without the URL the adapter keeps the legacy behavior (typed resolver-unconfigured failure at verify time).
  const unconfigured = createCloudflareAdapterForEnv({ LAUNCHPAD_ENV: 'production', CLOUDFLARE_TOKEN: 'token' });
  expect(production.resolveDns).toBeDefined();
  expect(unconfigured.resolveDns).toBeUndefined();

  // A configured but invalid URL fails closed at construction instead of silently disabling verification.
  try {
    createCloudflareAdapterForEnv({ LAUNCHPAD_ENV: 'production', LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL: 'http://resolver.internal/v1/dns' });
    expect.unreachable('construction with a non-HTTPS resolver URL must throw');
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderRequestError);
    expect((error as ProviderRequestError).code).toBe('LP-DNS-RESOLVER-CONFIG-INVALID');
  }
});
