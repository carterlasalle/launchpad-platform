import { lookup as systemLookup, Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';

import {
  DEFAULT_QUERY_TIMEOUT_MS,
  DnsResolverFailure,
  type DnsRecordType,
  type NameserverEndpoint,
  type ResolverDependencies,
} from './resolver.js';

export interface NodeDnsOptions {
  readonly queryTimeoutMs?: number;
}

/**
 * Real Node DNS client for the resolver core.
 *
 * `lookup` uses the system recursive resolver solely to locate each
 * authoritative nameserver; `query` then sends an isolated query through a
 * fresh `dns.promises.Resolver` configured with exactly that server's IP, so
 * the record data can only ever come from the supplied authoritative server.
 */
export function createNodeDnsDependencies(options: NodeDnsOptions = {}): ResolverDependencies {
  const queryTimeoutMs = options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  return {
    async lookup(hostname) {
      let address: string;
      try {
        ({ address } = await systemLookup(hostname, { verbatim: true }));
      } catch {
        throw new DnsResolverFailure('NAMESERVER_LOOKUP_FAILED', 'The nameserver hostname could not be resolved to an address.');
      }
      if (isIP(address) === 0) {
        throw new DnsResolverFailure('NAMESERVER_LOOKUP_FAILED', 'The nameserver hostname did not resolve to an IP address.');
      }
      return address;
    },
    async query(endpoint: NameserverEndpoint, hostname: string, type: DnsRecordType, signal?: AbortSignal) {
      const resolver = new Resolver();
      resolver.setServers([endpoint.address]);
      try {
        return await withQueryTimeout(resolveRecord(resolver, hostname, type), queryTimeoutMs, signal, () => resolver.cancel());
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
        // NODATA / NXDOMAIN from the queried server is an authoritative
        // absence, not a failure: it contributes no answers to the
        // intersection instead of failing the whole query.
        if (code === 'ENODATA' || code === 'ENOTFOUND') return [];
        throw classifyQueryError(error);
      }
    },
  };
}

function resolveRecord(resolver: Resolver, hostname: string, type: DnsRecordType): Promise<string[]> {
  switch (type) {
    case 'A': return resolver.resolve(hostname, 'A');
    case 'CNAME': return resolver.resolve(hostname, 'CNAME');
    // Node reports TXT records as one chunk array per record; the contract
    // answer is the record's chunks concatenated into a single string.
    case 'TXT': return resolver.resolve(hostname, 'TXT').then((records) => records.map((chunks) => chunks.join('')));
  }
}

/**
 * Races `work` against the per-query timeout and the core's abort signal.
 * Whichever deadline wins first cancels the underlying resolver exactly
 * once; all timers and listeners are cleaned up when the query settles.
 */
function withQueryTimeout<T>(work: Promise<T>, timeoutMs: number, signal: AbortSignal | undefined, cancel: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settle(new DnsResolverFailure('TIMEOUT', `The authoritative server did not answer within ${timeoutMs}ms.`));
    }, timeoutMs);
    const onAbort = (): void => {
      settle(new DnsResolverFailure('TIMEOUT', 'The authoritative server did not answer within the timeout.'));
    };
    const settle = (failure: DnsResolverFailure): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      cancel();
      reject(failure);
    };
    if (signal) {
      if (signal.aborted) {
        settle(new DnsResolverFailure('TIMEOUT', 'The authoritative server did not answer within the timeout.'));
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function classifyQueryError(error: unknown): DnsResolverFailure {
  if (error instanceof DnsResolverFailure) return error;
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === 'ETIMEOUT' || code === 'ECANCELLED' || code === 'ABORT_ERR') {
    return new DnsResolverFailure('TIMEOUT', 'The authoritative server did not answer within the timeout.');
  }
  return new DnsResolverFailure('QUERY_FAILED', 'The authoritative server query failed.');
}
