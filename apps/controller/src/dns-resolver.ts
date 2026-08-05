import { ProviderRequestError } from '@launchpad/provider-contract';
import type { DnsResolver } from '@launchpad/provider-cloudflare';

/**
 * Shared HTTPS authoritative-DNS resolver contract for the control plane.
 *
 * The configured endpoint is a worker-safe resolver that queries ONLY the
 * supplied authoritative nameservers for the given record type (never a
 * recursive resolver) and returns the record values it observes. The
 * controller never talks DNS itself: it posts the exact query envelope
 * `{hostname, type, nameservers}` over HTTPS and validates the strict
 * response envelope `{answers, nameservers}` before passing only the
 * answers to the Cloudflare adapter.
 *
 * Fail-closed guarantees:
 * - The endpoint URL must be an absolute, credential-free HTTPS URL
 *   (no http:, no embedded userinfo, no placeholder); anything else is a
 *   configuration error at construction time.
 * - Every request carries a per-request `x-launchpad-correlation-id`
 *   header so resolver round-trips are traceable end to end.
 * - The request body contains exactly the contract fields. Secret values
 *   never appear in the body, and raw response bodies never appear in
 *   errors (a resolver may echo values back).
 * - A bounded per-request timeout aborts the fetch; stalled, malformed,
 *   mismatched, or non-2xx responses throw typed errors, so the caller
 *   treats the resolution as unobserved rather than trusting partial data.
 */
export const AUTHORITATIVE_DNS_RESOLVER_CORRELATION_HEADER = 'x-launchpad-correlation-id';

export interface AuthoritativeDnsResolverOptions {
  /** HTTPS endpoint that resolves records against supplied authoritative nameservers. */
  url: string;
  /** Per-request timeout in milliseconds. Default 5000. */
  timeoutMs?: number;
  /** Test hook: fetch implementation. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Test hook: per-request correlation id. Defaults to a random UUID. */
  correlationId?: () => string;
}

/** Exact request envelope posted to the resolver endpoint. Never carries secrets. */
export interface AuthoritativeDnsQuery {
  hostname: string;
  type: string;
  nameservers: string[];
}

/** Validated response envelope; only `answers` ever reaches the DNS adapter. */
export interface AuthoritativeDnsResponse {
  answers: string[];
  nameservers: string[];
}

const DEFAULT_TIMEOUT_MS = 5_000;
const PLACEHOLDER_RE = /replace-in-/i;

function configError(): ProviderRequestError {
  return new ProviderRequestError({ code: 'LP-DNS-RESOLVER-CONFIG-INVALID', class: 'VALIDATION', provider: 'cloudflare', message: 'The authoritative DNS resolver URL must be an absolute, credential-free https:// URL.', retryable: false });
}

function queryError(): ProviderRequestError {
  return new ProviderRequestError({ code: 'LP-DNS-RESOLVER-QUERY-INVALID', class: 'VALIDATION', provider: 'cloudflare', message: 'Authoritative DNS resolution requires a hostname, a record type, and at least one nameserver.', retryable: false });
}

function malformedError(): ProviderRequestError {
  return new ProviderRequestError({ code: 'LP-DNS-RESOLVER-MALFORMED-RESPONSE', class: 'MALFORMED_PROVIDER_RESPONSE', provider: 'cloudflare', message: 'The authoritative DNS resolver returned a malformed response; refusing to trust partial answers.', retryable: false });
}

function mismatchError(queried: string[], echoed: string[]): ProviderRequestError {
  return new ProviderRequestError({ code: 'LP-DNS-RESOLVER-NAMESERVER-MISMATCH', class: 'MALFORMED_PROVIDER_RESPONSE', provider: 'cloudflare', message: 'The authoritative DNS resolver answered from different nameservers than the query; refusing to trust its answers.', retryable: false, safeDetails: { queried, echoed } });
}

function timeoutError(timeoutMs: number): ProviderRequestError {
  return new ProviderRequestError({ code: 'LP-DNS-RESOLVER-TIMEOUT', class: 'TIMEOUT', provider: 'cloudflare', message: `The authoritative DNS resolver did not answer within ${timeoutMs}ms.`, retryable: true, safeDetails: { timeoutMs } });
}

function networkError(cause: string): ProviderRequestError {
  return new ProviderRequestError({ code: 'LP-DNS-RESOLVER-NETWORK', class: 'TRANSIENT_PROVIDER', provider: 'cloudflare', message: 'The authoritative DNS resolver request failed before a response was received.', retryable: true, safeDetails: { cause } });
}

function httpError(status: number): ProviderRequestError {
  const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
  const errorClass: ProviderRequestError['class'] = status === 429 ? 'RATE_LIMITED' : retryable ? 'TRANSIENT_PROVIDER' : 'INTERNAL';
  // The response body is never read or echoed: resolvers may mirror values back.
  return new ProviderRequestError({ code: `LP-DNS-RESOLVER-HTTP-${status}`, class: errorClass, provider: 'cloudflare', message: `The authoritative DNS resolver request failed with HTTP ${status}.`, status, retryable, safeDetails: { status } });
}

/** Validates the configured endpoint URL and returns its normalized form. */
function validateResolverUrl(raw: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw configError();
  const value = raw.trim();
  if (PLACEHOLDER_RE.test(value)) throw configError();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw configError();
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.length === 0 || parsed.username !== '' || parsed.password !== '') throw configError();
  return parsed.toString();
}

function validateResponse(parsed: unknown, queriedNameservers: string[]): AuthoritativeDnsResponse {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw malformedError();
  const { answers, nameservers } = parsed as Record<string, unknown>;
  if (!Array.isArray(answers) || !answers.every((answer) => typeof answer === 'string')) throw malformedError();
  if (!Array.isArray(nameservers) || !nameservers.every((nameserver) => typeof nameserver === 'string')) throw malformedError();
  // Strict: the resolver must answer from exactly the nameservers the query
  // named. A partial or different echo means the answers did not come from
  // the authoritative servers and cannot be trusted.
  if (nameservers.length !== queriedNameservers.length || !queriedNameservers.every((nameserver) => nameservers.includes(nameserver))) {
    throw mismatchError(queriedNameservers, nameservers);
  }
  return { answers, nameservers };
}

/**
 * Builds the shared HTTPS authoritative-DNS resolver. The returned function
 * matches the Cloudflare adapter's `DnsResolver` contract and resolves to the
 * observed record values only when the endpoint answered over HTTPS from the
 * queried nameservers within the timeout.
 */
export function createAuthoritativeDnsResolver(options: AuthoritativeDnsResolverOptions): DnsResolver {
  const url = validateResolverUrl(options.url);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const correlationId = options.correlationId ?? (() => crypto.randomUUID());

  return async (hostname: string, type: string, nameservers: string[]): Promise<string[]> => {
    if (typeof hostname !== 'string' || hostname.length === 0 || typeof type !== 'string' || type.length === 0 || !Array.isArray(nameservers) || nameservers.length === 0 || nameservers.some((nameserver) => typeof nameserver !== 'string' || nameserver.length === 0)) {
      throw queryError();
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          [AUTHORITATIVE_DNS_RESOLVER_CORRELATION_HEADER]: correlationId(),
        },
        body: JSON.stringify({ hostname, type, nameservers } satisfies AuthoritativeDnsQuery),
        signal: controller.signal,
      });
      if (!response.ok) throw httpError(response.status);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await response.text()) as unknown;
      } catch {
        throw malformedError();
      }
      return validateResponse(parsed, nameservers).answers;
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') throw timeoutError(timeoutMs);
      throw networkError(error instanceof Error ? error.name : 'unknown');
    } finally {
      clearTimeout(timer);
    }
  };
}
