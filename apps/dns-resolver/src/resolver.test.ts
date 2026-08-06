import { describe, expect, it, vi } from 'vitest';

import {
  DnsResolverFailure,
  parseDnsQuery,
  resolveAuthoritative,
  type DnsQuery,
  type NameserverEndpoint,
  type ResolverDependencies,
} from './resolver.js';

const NS_ADA = 'ada.ns.cloudflare.com';
const NS_CHIP = 'chip.ns.cloudflare.com';
const ADDRESS = '192.0.2.53';

function query(overrides: Partial<DnsQuery> = {}): DnsQuery {
  return { hostname: 'www.carterlasalle.com', type: 'A', nameservers: [NS_ADA, NS_CHIP], ...overrides };
}

interface FakeServerBehavior {
  answers?: string[];
  failure?: DnsResolverFailure | Error;
}

function dependenciesFor(behaviors: Record<string, FakeServerBehavior>): {
  dependencies: ResolverDependencies;
  queryCalls: Array<{ endpoint: NameserverEndpoint; hostname: string; type: string }>;
  lookupCalls: string[];
} {
  const queryCalls: Array<{ endpoint: NameserverEndpoint; hostname: string; type: string }> = [];
  const lookupCalls: string[] = [];
  const dependencies: ResolverDependencies = {
    lookup: vi.fn(async (hostname: string) => {
      lookupCalls.push(hostname);
      return ADDRESS;
    }),
    query: vi.fn(async (endpoint: NameserverEndpoint, hostname: string, type: string) => {
      queryCalls.push({ endpoint, hostname, type });
      const behavior = behaviors[endpoint.hostname];
      if (behavior?.failure) throw behavior.failure;
      return behavior?.answers ?? [];
    }),
  };
  return { dependencies, queryCalls, lookupCalls };
}

function expectInvalid(body: unknown, code = 'INVALID_QUERY'): void {
  let failure: DnsResolverFailure | null = null;
  try {
    parseDnsQuery(body);
  } catch (error) {
    if (error instanceof DnsResolverFailure) failure = error;
    else throw error;
  }
  expect(failure).not.toBeNull();
  expect(failure?.code).toBe(code);
}

describe('parseDnsQuery', () => {
  it('accepts the exact request shape and normalizes the hostname case', () => {
    expect(parseDnsQuery({ hostname: 'WWW.CarterLaSalle.COM', type: 'TXT', nameservers: [NS_ADA, NS_CHIP] })).toEqual({
      hostname: 'www.carterlasalle.com',
      type: 'TXT',
      nameservers: [NS_ADA, NS_CHIP],
    });
  });

  it('accepts the zone apex and a single nameserver', () => {
    expect(parseDnsQuery({ hostname: 'carterlasalle.com', type: 'CNAME', nameservers: [NS_ADA] })).toEqual({
      hostname: 'carterlasalle.com',
      type: 'CNAME',
      nameservers: [NS_ADA],
    });
  });

  it('accepts TXT records required by the provider contract', () => {
    expect(parseDnsQuery({ hostname: 'verification.carterlasalle.com', type: 'TXT', nameservers: [NS_ADA] })).toEqual({
      hostname: 'verification.carterlasalle.com',
      type: 'TXT',
      nameservers: [NS_ADA],
    });
  });

  it.each<[string, unknown]>([
    ['a non-object body', 42],
    ['an array body', []],
    ['a null body', null],
    ['a missing hostname', { type: 'A', nameservers: [NS_ADA] }],
    ['a missing type', { hostname: 'www.carterlasalle.com', nameservers: [NS_ADA] }],
    ['a missing nameservers field', { hostname: 'www.carterlasalle.com', type: 'A' }],
    ['an extra key', { hostname: 'www.carterlasalle.com', type: 'A', nameservers: [NS_ADA], debug: true }],
  ])('rejects a request body with %s', (_label, body) => {
    expectInvalid(body);
  });

  it.each<[string, unknown]>([
    ['an out-of-zone hostname', 'evil.example.com'],
    ['a suffix-spoofing hostname', 'carterlasalle.com.evil.com'],
    ['a lookalike zone', 'notcarterlasalle.com'],
    ['a non-hostname string', 'has_underscore.carterlasalle.com'],
    ['an empty hostname', ''],
    ['a trailing-dot hostname', 'www.carterlasalle.com.'],
    ['an overlong label', `${'a'.repeat(64)}.carterlasalle.com`],
    ['a leading-dash label', '-www.carterlasalle.com'],
    ['an IP-literal hostname', '192.0.2.1'],
  ])('rejects %s', (_label, hostname) => {
    expectInvalid({ hostname, type: 'A', nameservers: [NS_ADA] });
  });

  it.each<[string, unknown]>([
    ['a lowercase type', 'a'],
    ['an unsupported type', 'MX'],
    ['a deprecated type', 'AAAA'],
    ['a numeric type', 1],
    ['a null type', null],
  ])('rejects %s', (_label, type) => {
    expectInvalid({ hostname: 'www.carterlasalle.com', type, nameservers: [NS_ADA] });
  });

  it.each<[string, unknown]>([
    ['no nameservers', []],
    ['three nameservers', [NS_ADA, NS_CHIP, 'bea.ns.cloudflare.com']],
    ['a non-Cloudflare nameserver', ['ns1.google.com']],
    ['a bare ns.cloudflare.com', ['ns.cloudflare.com']],
    ['a suffix-spoofing nameserver', ['ns.cloudflare.com.evil.com']],
    ['a non-hostname nameserver', ['under_score.ns.cloudflare.com']],
    ['a non-string nameserver', [42]],
    ['a mixed valid and invalid list', [NS_ADA, 'ns1.google.com']],
  ])('rejects nameservers with %s', (_label, nameservers) => {
    expectInvalid({ hostname: 'www.carterlasalle.com', type: 'A', nameservers });
  });
});

describe('resolveAuthoritative', () => {
  it('intersects answers from every queried server and echoes the original nameservers exactly', async () => {
    const { dependencies, queryCalls, lookupCalls } = dependenciesFor({
      [NS_ADA]: { answers: ['192.0.2.10', '192.0.2.11', '192.0.2.11'] },
      [NS_CHIP]: { answers: ['192.0.2.11', '192.0.2.12'] },
    });
    const requested = query();
    const result = await resolveAuthoritative(requested, dependencies);

    // Intersection of both servers, in the first server's order, deduplicated.
    expect(result).toEqual({ answers: ['192.0.2.11'], nameservers: [NS_ADA, NS_CHIP] });
    // The echo is a fresh array carrying the original strings, order preserved.
    expect(result.nameservers).toEqual(requested.nameservers);
    expect(result.nameservers).not.toBe(requested.nameservers);

    expect(lookupCalls).toEqual([NS_ADA, NS_CHIP]);
    expect(queryCalls).toHaveLength(2);
    expect(queryCalls[0]).toEqual({ endpoint: { hostname: NS_ADA, address: ADDRESS }, hostname: 'www.carterlasalle.com', type: 'A' });
    expect(queryCalls[1]).toEqual({ endpoint: { hostname: NS_CHIP, address: ADDRESS }, hostname: 'www.carterlasalle.com', type: 'A' });
  });

  it('returns no answers when every server reports none', async () => {
    const { dependencies } = dependenciesFor({ [NS_ADA]: { answers: [] }, [NS_CHIP]: { answers: [] } });
    await expect(resolveAuthoritative(query(), dependencies)).resolves.toEqual({ answers: [], nameservers: [NS_ADA, NS_CHIP] });
  });

  it('never fabricates answers when servers disagree (empty intersection)', async () => {
    const { dependencies } = dependenciesFor({
      [NS_ADA]: { answers: ['192.0.2.10'] },
      [NS_CHIP]: { answers: [] },
    });
    await expect(resolveAuthoritative(query(), dependencies)).resolves.toEqual({ answers: [], nameservers: [NS_ADA, NS_CHIP] });
  });

  it('fails closed when one nameserver query fails, after querying every server independently', async () => {
    const { dependencies, queryCalls } = dependenciesFor({
      [NS_ADA]: { answers: ['192.0.2.10'] },
      [NS_CHIP]: { failure: new Error('network unreachable') },
    });
    await expect(resolveAuthoritative(query(), dependencies)).rejects.toMatchObject({ code: 'QUERY_FAILED' });
    expect(queryCalls).toHaveLength(2);
  });

  it('propagates a per-server timeout as TIMEOUT', async () => {
    const { dependencies } = dependenciesFor({
      [NS_ADA]: { failure: new DnsResolverFailure('TIMEOUT', 'timeout') },
      [NS_CHIP]: { answers: ['192.0.2.10'] },
    });
    await expect(resolveAuthoritative(query(), dependencies)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('fails closed when a nameserver hostname cannot be located', async () => {
    const dependencies: ResolverDependencies = {
      lookup: vi.fn(async (hostname: string) => {
        if (hostname === NS_CHIP) throw new Error('ENOTFOUND');
        return ADDRESS;
      }),
      query: vi.fn(async () => ['192.0.2.10']),
    };
    await expect(resolveAuthoritative(query(), dependencies)).rejects.toMatchObject({ code: 'NAMESERVER_LOOKUP_FAILED' });
  });

  it('resolves TXT records end to end, intersecting across servers', async () => {
    const { dependencies, queryCalls } = dependenciesFor({
      [NS_ADA]: { answers: ['v=spf1 include:_spf.carterlasalle.com ~all', 'google-site-verification=abc'] },
      [NS_CHIP]: { answers: ['v=spf1 include:_spf.carterlasalle.com ~all'] },
    });
    const result = await resolveAuthoritative(query({ type: 'TXT' }), dependencies);
    expect(result.answers).toEqual(['v=spf1 include:_spf.carterlasalle.com ~all']);
    expect(queryCalls.every((call) => call.type === 'TXT')).toBe(true);
  });

  it('does not abort completed queries when the resolution finishes in time', async () => {
    const aborted: string[] = [];
    const dependencies: ResolverDependencies = {
      lookup: vi.fn(async () => ADDRESS),
      query: vi.fn(async (endpoint: NameserverEndpoint, _hostname: string, _type: string, signal?: AbortSignal) => {
        signal?.addEventListener('abort', () => aborted.push(endpoint.hostname), { once: true });
        return ['192.0.2.10'];
      }),
    };
    await expect(resolveAuthoritative(query(), dependencies, { overallTimeoutMs: 500 })).resolves.toEqual({
      answers: ['192.0.2.10'],
      nameservers: [NS_ADA, NS_CHIP],
    });
    expect(aborted).toEqual([]);
  });

  it('aborts every in-flight authoritative query when the overall deadline expires', async () => {
    const aborted: string[] = [];
    const dependencies: ResolverDependencies = {
      lookup: vi.fn(async () => ADDRESS),
      query: vi.fn(async (endpoint: NameserverEndpoint, _hostname: string, _type: string, signal?: AbortSignal) => new Promise<string[]>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          aborted.push(endpoint.hostname);
          reject(new DnsResolverFailure('TIMEOUT', 'aborted'));
        }, { once: true });
      })),
    };

    await expect(resolveAuthoritative(query(), dependencies, { overallTimeoutMs: 1 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(aborted.sort()).toEqual([NS_ADA, NS_CHIP].sort());
  });

  it('aborts with TIMEOUT when resolution exceeds the overall bound', async () => {
    const dependencies: ResolverDependencies = {
      lookup: vi.fn(async () => ADDRESS),
      query: vi.fn(() => new Promise<string[]>(() => undefined)),
    };
    await expect(resolveAuthoritative(query(), dependencies, { overallTimeoutMs: 30 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('rejects answers beyond the response bound', async () => {
    const { dependencies } = dependenciesFor({
      [NS_ADA]: { answers: Array.from({ length: 65 }, (_, index) => `192.0.2.${index}`) },
      [NS_CHIP]: { answers: [] },
    });
    await expect(resolveAuthoritative(query(), dependencies)).rejects.toMatchObject({ code: 'RESPONSE_BOUND_EXCEEDED' });
  });

  it('rejects overlong answers', async () => {
    const { dependencies } = dependenciesFor({
      [NS_ADA]: { answers: ['x'.repeat(513)] },
      [NS_CHIP]: { answers: ['x'.repeat(513)] },
    });
    await expect(resolveAuthoritative(query(), dependencies)).rejects.toMatchObject({ code: 'RESPONSE_BOUND_EXCEEDED' });
  });

  it('re-validates the query even when called directly with a typed query', async () => {
    const { dependencies } = dependenciesFor({});
    await expect(resolveAuthoritative(query({ hostname: 'evil.example.com' }), dependencies)).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    await expect(resolveAuthoritative(query({ nameservers: ['ns1.google.com'] }), dependencies)).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    await expect(resolveAuthoritative(query({ type: 'MX' as never }), dependencies)).rejects.toMatchObject({ code: 'INVALID_QUERY' });
  });
});
