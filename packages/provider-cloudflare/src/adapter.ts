import { idempotencyKey } from '@launchpad/shared';
import { ProviderRequestError, type DnsProvider, type DnsRecordObservation, type DnsVerificationResult, type MutationResult, type ProviderCapabilities, type ProviderContext, type ProxyCompatibilityRequest, type ProxyCompatibilityResult, type ProxyRouteProbeResult, type RequiredDnsRecord, type ZoneObservation } from '@launchpad/provider-contract';
import { CloudflareClient } from './client.js';
import { parseDnsRecord, parseEnvelope, parseZoneList } from './envelope.js';

const OWNERSHIP_PREFIX = 'launchpad:';

/**
 * Worker-safe authoritative DNS resolver. Implementations must query only the
 * supplied authoritative nameservers for the given record type (never a
 * recursive resolver) and return the record values they observe.
 */
export type DnsResolver = (hostname: string, type: string, nameservers: string[]) => Promise<string[]>;

export interface DnsVerificationPolicy {
  /** Maximum resolver attempts before a typed timeout error. Default 6. */
  maxAttempts?: number;
  /** Initial backoff delay. Default 2000ms. */
  baseDelayMs?: number;
  /** Cap on the exponential backoff delay. Default 30000ms. */
  maxDelayMs?: number;
  /** Overall verification window. Default 180000ms. */
  timeoutMs?: number;
  /** Test hook: replaces the timer-based sleep. */
  sleep?: (delayMs: number) => Promise<void>;
  /** Test hook: jitter added to each backoff delay; clamped to non-negative. */
  jitter?: () => number;
  /** Test hook: monotonic-ish clock. */
  now?: () => number;
}

export interface CloudflareAdapterOptions {
  token?: string | undefined;
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** Per-request client timeout. Defaults to the Cloudflare client default (20000ms). */
  timeoutMs?: number | undefined;
  resolveDns?: DnsResolver | undefined;
  verification?: DnsVerificationPolicy | undefined;
  /** Bound for origin/public proxy compatibility probes. Default 10000ms. */
  probeTimeoutMs?: number | undefined;
}

interface VerificationPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
  sleep: (delayMs: number) => Promise<void>;
  jitter: () => number;
  now: () => number;
}

function normalizeContent(value: string): string {
  return value.trim().replace(/\.$/, '').replace(/^"(.*)"$/, '$1');
}

function ownershipFromComment(comment: string | null): string | null {
  return comment !== null && comment.startsWith(OWNERSHIP_PREFIX) ? comment.slice(OWNERSHIP_PREFIX.length) : null;
}

function validateRequired(record: RequiredDnsRecord): void {
  if (typeof record.hostname !== 'string' || record.hostname.length === 0) throw new ProviderRequestError({ code: 'LP-DNS-REQUIRED-RECORD-INVALID', class: 'VALIDATION', provider: 'cloudflare', message: 'DNS record hostname is required.', retryable: false });
  if (record.type !== 'CNAME' && record.type !== 'A' && record.type !== 'TXT') throw new ProviderRequestError({ code: 'LP-DNS-REQUIRED-RECORD-INVALID', class: 'VALIDATION', provider: 'cloudflare', message: 'DNS record type must be CNAME, A, or TXT.', retryable: false });
  if (typeof record.value !== 'string' || record.value.length === 0) throw new ProviderRequestError({ code: 'LP-DNS-REQUIRED-RECORD-INVALID', class: 'VALIDATION', provider: 'cloudflare', message: 'DNS record content is required.', retryable: false });
  if (record.ttl !== 'auto' && (typeof record.ttl !== 'number' || !Number.isInteger(record.ttl) || record.ttl < 1)) throw new ProviderRequestError({ code: 'LP-DNS-REQUIRED-RECORD-INVALID', class: 'VALIDATION', provider: 'cloudflare', message: 'DNS record TTL must be auto or a positive integer.', retryable: false });
}

function matchesDesired(observed: DnsRecordObservation, required: RequiredDnsRecord, ttl: number, proxied: boolean): boolean {
  return observed.type === required.type
    && normalizeContent(observed.content) === normalizeContent(required.value)
    && observed.ttl === ttl
    && observed.proxied === proxied;
}

export class CloudflareAdapter implements DnsProvider {
  readonly client: CloudflareClient;
  readonly resolveDns: DnsResolver | undefined;
  readonly probeTimeoutMs: number;
  private readonly policy: VerificationPolicy;

  constructor(options: CloudflareAdapterOptions = {}) {
    this.client = new CloudflareClient({ token: options.token, baseUrl: options.baseUrl, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs });
    this.resolveDns = options.resolveDns;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 10_000;
    const verification = options.verification ?? {};
    this.policy = {
      maxAttempts: verification.maxAttempts ?? 6,
      baseDelayMs: verification.baseDelayMs ?? 2_000,
      maxDelayMs: verification.maxDelayMs ?? 30_000,
      timeoutMs: verification.timeoutMs ?? 180_000,
      sleep: verification.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs))),
      jitter: verification.jitter ?? (() => Math.floor(Math.random() * 251)),
      now: verification.now ?? (() => Date.now()),
    };
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return { provider: 'cloudflare', adapterVersion: 'dns-rest-v1', fields: { 'dns.record.content': { read: true, create: true, update: true, delete: true, requiresRedeploy: false, destructiveWhenChanged: false }, 'dns.record.proxied': { read: true, create: true, update: true, delete: true, requiresRedeploy: false, destructiveWhenChanged: false }, 'dns.record.ttl': { read: true, create: true, update: true, delete: true, requiresRedeploy: false, destructiveWhenChanged: false }, 'dns.record.zoneRef': { read: true, create: true, update: true, delete: false, requiresRedeploy: false, destructiveWhenChanged: false } }, features: { authoritativeVerification: true, proxyMode: true, proxyCompatibilityCheck: true }, snapshotHash: 'cloudflare-dns-rest-v1' };
  }

  async observeZone(zoneRef: string, ctx: ProviderContext): Promise<ZoneObservation> {
    const name = zoneRef.replace(/^config:\/\/cloudflare\//, '');
    if (name.length === 0) throw new ProviderRequestError({ code: 'LP-CLOUDFLARE-ZONE-REF-INVALID', class: 'VALIDATION', provider: 'cloudflare', message: 'Cloudflare zone reference must name a zone.', retryable: false });
    const response = await this.client.request<unknown>(`/zones?name=${encodeURIComponent(name)}&status=active`, { correlationId: ctx.correlationId });
    const zones = parseZoneList(parseEnvelope(response));
    const zone = zones[0];
    if (!zone) throw new ProviderRequestError({ code: 'LP-CLOUDFLARE-ZONE-MISSING', class: 'NOT_FOUND', provider: 'cloudflare', message: `Cloudflare zone '${name}' was not found.`, retryable: false });
    return { provider: 'cloudflare', zoneId: zone.id, name: zone.name, nameservers: zone.name_servers ?? [], status: zone.status ?? 'unknown' };
  }

  async observeRecord(zoneId: string, hostname: string, ctx: ProviderContext, type?: string): Promise<DnsRecordObservation | null> {
    const query = new URLSearchParams({ name: hostname });
    if (type !== undefined) query.set('type', type);
    const response = await this.client.request<unknown>(`/zones/${encodeURIComponent(zoneId)}/dns_records?${query.toString()}`, { correlationId: ctx.correlationId });
    const result = parseEnvelope<unknown>(response);
    if (!Array.isArray(result)) throw new ProviderRequestError({ code: 'LP-CLOUDFLARE-MALFORMED-RESPONSE', class: 'MALFORMED_PROVIDER_RESPONSE', provider: 'cloudflare', message: 'Cloudflare returned a malformed response: DNS record list must be an array.', retryable: false });
    const candidates = result.map(parseDnsRecord).filter((candidate) => type === undefined || candidate.type === type);
    const first = candidates[0];
    if (!first) return null;
    return { provider: 'cloudflare', id: first.id, zoneId, name: first.name, type: first.type, content: first.content, ttl: first.ttl, proxied: first.proxied, ownershipFingerprint: ownershipFromComment(first.comment) };
  }

  async ensureRecord(zoneId: string, required: RequiredDnsRecord, ownershipFingerprint: string, ctx: ProviderContext): Promise<MutationResult<DnsRecordObservation>> {
    validateRequired(required);
    if (typeof ownershipFingerprint !== 'string' || ownershipFingerprint.length === 0) throw new ProviderRequestError({ code: 'LP-DNS-OWNERSHIP-FINGERPRINT-INVALID', class: 'VALIDATION', provider: 'cloudflare', message: 'DNS record ownership fingerprint is required.', retryable: false });
    const proxied = required.proxied === true;
    if (proxied && required.proxyAcknowledgment !== true) throw new ProviderRequestError({ code: 'LP-DNS-PROXY-ACKNOWLEDGMENT-REQUIRED', class: 'POLICY_BLOCK', provider: 'cloudflare', message: 'Proxied Cloudflare mode requires explicit proxy acknowledgment.', retryable: false });
    if (proxied && required.ttl !== 'auto') throw new ProviderRequestError({ code: 'LP-DNS-PROXY-TTL-INVALID', class: 'VALIDATION', provider: 'cloudflare', message: 'Proxied Cloudflare records must use automatic TTL.', retryable: false });
    const ttl = required.ttl === 'auto' ? 1 : required.ttl;
    const operationId = idempotencyKey('cloudflare-dns-operation', zoneId, required.hostname, ownershipFingerprint);
    const current = await this.observeRecord(zoneId, required.hostname, ctx, required.type);
    if (required.providerRecordId) {
      if (!current) throw new ProviderRequestError({ code: 'LP-DNS-CONFLICT-RECORD-MISSING', class: 'CONFLICT', provider: 'cloudflare', message: `Tracked DNS record for '${required.hostname}' no longer exists on the provider.`, retryable: false });
      if (current.id !== required.providerRecordId) throw new ProviderRequestError({ code: 'LP-DNS-CONFLICT-RECORD-REPLACED', class: 'CONFLICT', provider: 'cloudflare', message: `DNS record '${required.hostname}' was replaced on the provider; refusing to mutate an untracked record.`, retryable: false });
    }
    if (current && current.ownershipFingerprint !== ownershipFingerprint) throw new ProviderRequestError({ code: 'LP-DNS-CONFLICT-UNOWNED', class: 'CONFLICT', provider: 'cloudflare', message: `DNS record '${required.hostname}' is not owned by this Launchpad application.`, retryable: false });
    if (current && matchesDesired(current, required, ttl, proxied)) return { resource: current, changed: false, operationId };
    const body = { type: required.type, name: required.hostname, content: required.value, ttl, proxied, comment: `launchpad:${ownershipFingerprint}` };
    const endpoint = current ? `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(current.id)}` : `/zones/${encodeURIComponent(zoneId)}/dns_records`;
    const response = await this.client.request<unknown>(endpoint, { method: current ? 'PUT' : 'POST', body: JSON.stringify(body), correlationId: ctx.correlationId, idempotencyKey: idempotencyKey('cloudflare-dns', zoneId, required.hostname, ownershipFingerprint) });
    const created = parseDnsRecord(parseEnvelope(response));
    const observed = await this.observeRecord(zoneId, required.hostname, ctx, required.type);
    if (!observed || observed.id !== created.id || !matchesDesired(observed, required, ttl, proxied)) throw new ProviderRequestError({ code: 'LP-DNS-POSTCONDITION-UNVERIFIED', class: 'TRANSIENT_PROVIDER', provider: 'cloudflare', message: `DNS mutation for '${required.hostname}' could not be verified by follow-up observation.`, retryable: true });
    return { resource: observed, changed: true, operationId };
  }

  async verifyAuthoritative(hostname: string, expected: RequiredDnsRecord, _ctx: ProviderContext, zone?: ZoneObservation): Promise<boolean> {
    validateRequired(expected);
    if (!zone || !Array.isArray(zone.nameservers) || zone.nameservers.length === 0) throw new ProviderRequestError({ code: 'LP-DNS-AUTHORITATIVE-NAMESERVERS-MISSING', class: 'VALIDATION', provider: 'cloudflare', message: `Authoritative DNS verification requires the zone's nameservers; none were supplied for '${hostname}'.`, retryable: false });
    if (!this.resolveDns) throw new ProviderRequestError({ code: 'LP-DNS-RESOLVER-UNCONFIGURED', class: 'UNSUPPORTED', provider: 'cloudflare', message: 'Authoritative DNS verification requires a configured resolver.', retryable: false });
    const expectedValue = normalizeContent(expected.value);
    const nameservers = [...zone.nameservers];
    const startedAt = new Date(this.policy.now()).toISOString();
    const deadline = this.policy.now() + this.policy.timeoutMs;
    let attempts = 0;
    for (let attempt = 1; attempt <= this.policy.maxAttempts; attempt += 1) {
      if (this.policy.now() >= deadline) break;
      attempts = attempt;
      let values: string[] = [];
      try {
        values = await this.resolveDns(hostname, expected.type, nameservers);
      } catch {
        values = [];
      }
      if (values.some((value) => normalizeContent(value) === expectedValue)) return true;
      if (attempt < this.policy.maxAttempts && this.policy.now() < deadline) {
        const bounded = Math.min(this.policy.maxDelayMs, this.policy.baseDelayMs * 2 ** (attempt - 1));
        const delay = bounded + Math.max(0, this.policy.jitter());
        await this.policy.sleep(Math.round(delay));
      }
    }
    const verification: DnsVerificationResult = { state: 'TIMED_OUT', hostname, nameservers, attempts, startedAt };
    throw new ProviderRequestError({ code: 'LP-DNS-VERIFICATION-TIMEOUT', class: 'TIMEOUT', provider: 'cloudflare', message: `Authoritative DNS did not return the ${expected.type} record for ${hostname} within the verification window.`, retryable: true, safeDetails: { verification } });
  }

  async deleteRecord(zoneId: string, recordId: string, ctx: ProviderContext, ownershipFingerprint?: string): Promise<void> {
    if (typeof recordId !== 'string' || recordId.length === 0) throw new ProviderRequestError({ code: 'LP-DNS-RECORD-ID-INVALID', class: 'VALIDATION', provider: 'cloudflare', message: 'DNS record id is required for deletion.', retryable: false });
    if (ownershipFingerprint !== undefined) {
      const record = await this.observeRecordById(zoneId, recordId, ctx);
      if (!record) throw new ProviderRequestError({ code: 'LP-DNS-RECORD-MISSING', class: 'NOT_FOUND', provider: 'cloudflare', message: `DNS record '${recordId}' does not exist on the provider.`, retryable: false });
      if (record.ownershipFingerprint !== ownershipFingerprint) throw new ProviderRequestError({ code: 'LP-DNS-CONFLICT-UNOWNED', class: 'CONFLICT', provider: 'cloudflare', message: `Refusing to delete DNS record '${recordId}' because it is not owned by this Launchpad application.`, retryable: false });
    }
    parseEnvelope(await this.client.request<unknown>(`/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`, { method: 'DELETE', correlationId: ctx.correlationId, idempotencyKey: idempotencyKey('cloudflare-dns-delete', zoneId, recordId) }));
    const remaining = await this.observeRecordById(zoneId, recordId, ctx).catch((error) => {
      if (error instanceof ProviderRequestError && error.class === 'NOT_FOUND') return null;
      throw error;
    });
    if (remaining) throw new ProviderRequestError({ code: 'LP-DNS-DELETE-UNVERIFIED', class: 'TRANSIENT_PROVIDER', provider: 'cloudflare', message: `DNS record deletion for '${recordId}' could not be verified by follow-up observation.`, retryable: true });
  }

  async checkProxyCompatibility(request: ProxyCompatibilityRequest, _ctx: ProviderContext): Promise<ProxyCompatibilityResult> {
    if (request.proxyAcknowledgment !== true) throw new ProviderRequestError({ code: 'LP-DNS-PROXY-ACKNOWLEDGMENT-REQUIRED', class: 'POLICY_BLOCK', provider: 'cloudflare', message: 'Proxy compatibility checks require explicit proxy acknowledgment.', retryable: false });
    if (typeof request.hostname !== 'string' || request.hostname.length === 0 || typeof request.originHost !== 'string' || request.originHost.length === 0) throw new ProviderRequestError({ code: 'LP-DNS-PROXY-REQUEST-INVALID', class: 'VALIDATION', provider: 'cloudflare', message: 'Proxy compatibility checks require a hostname and an origin host.', retryable: false });
    const healthPath = request.healthPath ?? '/';
    const timeoutMs = request.timeoutMs ?? this.probeTimeoutMs;
    const [origin, publicRoute] = await Promise.all([
      this.probe(`https://${request.originHost}${healthPath}`, { route: 'origin', cfConnectingIp: true }, timeoutMs),
      this.probe(`https://${request.hostname}${healthPath}`, { route: 'public', cfConnectingIp: false }, timeoutMs),
    ]);
    const routeOk = (route: ProxyRouteProbeResult): boolean => route.reachable && route.tls === 'ok' && route.statusCode !== null && route.statusCode < 500;
    return { hostname: request.hostname, mode: 'proxied', acknowledgment: true, origin, public: publicRoute, compatible: routeOk(origin) && routeOk(publicRoute) && origin.connectingIpHeader, checkedAt: new Date(this.policy.now()).toISOString() };
  }

  private async observeRecordById(zoneId: string, recordId: string, ctx: ProviderContext): Promise<DnsRecordObservation | null> {
    const response = await this.client.request<unknown>(`/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`, { correlationId: ctx.correlationId });
    const result = parseEnvelope<unknown>(response);
    if (result === null) return null;
    const record = parseDnsRecord(result);
    return { provider: 'cloudflare', id: record.id, zoneId, name: record.name, type: record.type, content: record.content, ttl: record.ttl, proxied: record.proxied, ownershipFingerprint: ownershipFromComment(record.comment) };
  }

  private async probe(url: string, probeKind: { route: 'origin' | 'public'; cfConnectingIp: boolean }, timeoutMs: number): Promise<ProxyRouteProbeResult> {
    const started = this.policy.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers();
      if (probeKind.cfConnectingIp) headers.set('cf-connecting-ip', '203.0.113.10');
      const response = await this.client.fetchImpl(url, { headers, signal: controller.signal, redirect: 'follow' });
      const latencyMs = this.policy.now() - started;
      return { route: probeKind.route, url, reachable: true, statusCode: response.status, tls: 'ok', connectingIpHeader: response.headers.get('cf-connecting-ip') !== null, latencyMs, observedAt: new Date(this.policy.now()).toISOString() };
    } catch (error) {
      const latencyMs = this.policy.now() - started;
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      return { route: probeKind.route, url, reachable: false, statusCode: null, tls: aborted ? 'unknown' : 'failed', connectingIpHeader: false, latencyMs, observedAt: new Date(this.policy.now()).toISOString() };
    } finally {
      clearTimeout(timer);
    }
  }
}
