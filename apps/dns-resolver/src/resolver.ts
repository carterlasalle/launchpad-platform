/**
 * Pure authoritative DNS resolver core.
 *
 * Validates the exact request shape and restrictions, resolves each
 * authoritative nameserver hostname to an IP address (solely to locate it),
 * sends an isolated query through each configured server, intersects the
 * string answers across every server, and echoes the original nameserver
 * strings exactly.
 *
 * The core is deterministic: lookup and query functions are injected, so
 * every path can be exercised in tests without real DNS traffic.
 */

export const ZONE_HOSTNAME = 'carterlasalle.com';
export const NAMESERVER_SUFFIX = '.ns.cloudflare.com';
export const ALLOWED_RECORD_TYPES = ['CNAME', 'A', 'TXT'] as const;
export type DnsRecordType = (typeof ALLOWED_RECORD_TYPES)[number];

export const DEFAULT_QUERY_TIMEOUT_MS = 3_000;
export const DEFAULT_OVERALL_TIMEOUT_MS = 8_000;
export const DEFAULT_MAX_ANSWERS = 64;
export const DEFAULT_MAX_ANSWER_LENGTH = 512;

export interface DnsQuery {
  readonly hostname: string;
  readonly type: DnsRecordType;
  readonly nameservers: readonly string[];
}

export interface DnsResolution {
  readonly answers: string[];
  readonly nameservers: string[];
}

/** An authoritative nameserver located to an IP address for direct querying. */
export interface NameserverEndpoint {
  readonly hostname: string;
  readonly address: string;
}

export interface ResolverDependencies {
  /** Ordinary lookup of an authoritative nameserver hostname to an IP address. */
  readonly lookup: (hostname: string) => Promise<string>;
  /**
   * Isolated query of one authoritative server for `hostname`/`type`.
   * `signal` is aborted when the overall resolution deadline expires so
   * adapters can cancel their in-flight network request.
   */
  readonly query: (endpoint: NameserverEndpoint, hostname: string, type: DnsRecordType, signal?: AbortSignal) => Promise<string[]>;
}

export type DnsResolverErrorCode =
  | 'INVALID_QUERY'
  | 'REQUEST_TOO_LARGE'
  | 'NAMESERVER_LOOKUP_FAILED'
  | 'QUERY_FAILED'
  | 'RESPONSE_BOUND_EXCEEDED'
  | 'TIMEOUT';

export class DnsResolverFailure extends Error {
  readonly code: DnsResolverErrorCode;

  constructor(code: DnsResolverErrorCode, message: string) {
    super(message);
    this.name = 'DnsResolverFailure';
    this.code = code;
  }
}

export interface ResolveOptions {
  readonly overallTimeoutMs?: number;
  readonly maxAnswers?: number;
  readonly maxAnswerLength?: number;
}

const HOSTNAME_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;

function invalidQuery(message: string): DnsResolverFailure {
  return new DnsResolverFailure('INVALID_QUERY', message);
}

function isValidHostname(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) return false;
  if (value.endsWith('.')) return false;
  return HOSTNAME_PATTERN.test(value.toLowerCase());
}

/** Rejects hostnames that are not `carterlasalle.com` or a subdomain of it. */
export function assertZoneHostname(value: unknown): string {
  if (!isValidHostname(value)) throw invalidQuery('hostname must be a valid DNS hostname.');
  const hostname = value.toLowerCase();
  if (hostname !== ZONE_HOSTNAME && !hostname.endsWith(`.${ZONE_HOSTNAME}`)) {
    throw invalidQuery(`hostname must be ${ZONE_HOSTNAME} or a subdomain of it.`);
  }
  return hostname;
}

export function assertRecordType(value: unknown): DnsRecordType {
  if (value === 'CNAME' || value === 'A' || value === 'TXT') return value;
  throw invalidQuery(`type must be one of: ${ALLOWED_RECORD_TYPES.join(', ')}.`);
}

/** Requires 1-2 Cloudflare nameserver hostnames ending in `.ns.cloudflare.com`. */
export function assertNameservers(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    throw invalidQuery('nameservers must contain between 1 and 2 nameservers.');
  }
  for (const nameserver of value) {
    if (!isValidHostname(nameserver) || !nameserver.toLowerCase().endsWith(NAMESERVER_SUFFIX)) {
      throw invalidQuery(`nameservers must be hostnames ending in ${NAMESERVER_SUFFIX}.`);
    }
  }
  return [...value];
}

/**
 * Validates the exact request shape: a JSON object containing exactly
 * `hostname`, `type`, and `nameservers`. Returns the typed query with the
 * original nameserver strings untouched so they can be echoed verbatim.
 */
export function parseDnsQuery(body: unknown): DnsQuery {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidQuery('Request body must be a JSON object.');
  }
  const keys = Object.keys(body);
  if (keys.length !== 3 || !('hostname' in body) || !('type' in body) || !('nameservers' in body)) {
    throw invalidQuery('Request body must contain exactly hostname, type, and nameservers.');
  }
  const record = body as Record<string, unknown>;
  return {
    hostname: assertZoneHostname(record['hostname']),
    type: assertRecordType(record['type']),
    nameservers: assertNameservers(record['nameservers']),
  };
}

function assertQuery(query: DnsQuery): void {
  assertZoneHostname(query.hostname);
  assertRecordType(query.type);
  assertNameservers(query.nameservers);
}

function boundAnswers(answers: string[], maxAnswers: number, maxAnswerLength: number): string[] {
  if (answers.length > maxAnswers) {
    throw new DnsResolverFailure('RESPONSE_BOUND_EXCEEDED', `A nameserver returned more than ${maxAnswers} answers.`);
  }
  if (answers.some((answer) => typeof answer !== 'string' || answer.length > maxAnswerLength)) {
    throw new DnsResolverFailure('RESPONSE_BOUND_EXCEEDED', `A nameserver returned an answer exceeding ${maxAnswerLength} characters.`);
  }
  return answers;
}

/**
 * Intersects the answer sets from every queried server, preserving the first
 * server's ordering. A single propagated, stale, or compromised server can
 * therefore never produce a false positive: every returned answer was
 * observed on every queried authoritative server.
 */
function intersectAnswers(groups: readonly string[][]): string[] {
  const first = groups[0];
  if (!first) return [];
  const intersection: string[] = [];
  for (const candidate of first) {
    if (intersection.includes(candidate)) continue;
    if (groups.every((group) => group.includes(candidate))) intersection.push(candidate);
  }
  return intersection;
}

/**
 * Resolves `query` against every supplied authoritative nameserver.
 *
 * Fails closed: any lookup failure, query failure, or timeout aborts the
 * whole resolution; answers are returned only when every queried server
 * succeeded, intersected across all of them. NODATA/NXDOMAIN from a server
 * is an authoritative absence, not a failure, and simply contributes no
 * answers to the intersection.
 */
export async function resolveAuthoritative(query: DnsQuery, dependencies: ResolverDependencies, options: ResolveOptions = {}): Promise<DnsResolution> {
  assertQuery(query);
  const maxAnswers = options.maxAnswers ?? DEFAULT_MAX_ANSWERS;
  const maxAnswerLength = options.maxAnswerLength ?? DEFAULT_MAX_ANSWER_LENGTH;
  const overallTimeoutMs = options.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS;

  // Aborted when the overall deadline expires so every in-flight query is
  // signalled to cancel its underlying network request.
  const controller = new AbortController();

  const resolve = async (): Promise<DnsResolution> => {
    // Locate every authoritative server first; each failure aborts the query.
    const endpoints = await Promise.all(
      query.nameservers.map(async (hostname): Promise<NameserverEndpoint> => {
        try {
          return { hostname, address: await dependencies.lookup(hostname) };
        } catch (error) {
          // Injected lookups may throw DnsResolverFailure to signal a
          // specific class; anything else is a generic lookup failure.
          if (error instanceof DnsResolverFailure) throw error;
          throw new DnsResolverFailure('NAMESERVER_LOOKUP_FAILED', 'An authoritative nameserver address could not be resolved.');
        }
      }),
    );

    // Query every server independently and concurrently. Any failure fails closed.
    const groups = await Promise.all(
      endpoints.map(async (endpoint): Promise<string[]> => {
        try {
          return boundAnswers(await dependencies.query(endpoint, query.hostname, query.type, controller.signal), maxAnswers, maxAnswerLength);
        } catch (error) {
          // Injected queries may throw DnsResolverFailure (e.g. TIMEOUT) to
          // signal a specific class; anything else is a generic query failure.
          if (error instanceof DnsResolverFailure) throw error;
          throw new DnsResolverFailure('QUERY_FAILED', 'An authoritative nameserver query failed.');
        }
      }),
    );

    return {
      answers: intersectAnswers(groups),
      nameservers: [...query.nameservers],
    };
  };

  return withOverallTimeout(resolve(), overallTimeoutMs, () => controller.abort());
}

function withOverallTimeout<T>(work: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  if (timeoutMs <= 0) return work;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new DnsResolverFailure('TIMEOUT', `Resolution exceeded the overall ${timeoutMs}ms bound.`));
    }, timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
