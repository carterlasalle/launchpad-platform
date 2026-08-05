import { expect, it } from 'vitest';
import { CloudflareAdapter } from '@launchpad/provider-cloudflare';
import { ProviderRequestError, type ProviderContext, type RequiredDnsRecord, type ZoneObservation } from '@launchpad/provider-contract';
import { CONTRACT_CANARY_BODY, CONTRACT_CANARY_TOKEN, expectRequest, loadScenarios, recordedTransport, type RecordedRequest, type RecordedStep } from '../fixtures/recorded-transport.js';

const ctx: ProviderContext = { correlationId: 'contract-corr', applicationId: 'app', workflowId: 'wf', actor: { kind: 'system', id: 'contract' }, dryRun: false };
const BASE = 'https://api.cloudflare.test';

const zone: ZoneObservation = { provider: 'cloudflare', zoneId: 'zone-1', name: 'example.com', nameservers: ['ns1.example.net', 'ns2.example.net'], status: 'active' };

function required(overrides: Partial<RequiredDnsRecord> = {}): RequiredDnsRecord {
  return { hostname: 'app.example.com', type: 'CNAME', value: 'target.example', ttl: 'auto', ...overrides };
}

function mount(steps: RecordedStep[], options: { resolveDns?: CloudflareAdapter['resolveDns']; probeTimeoutMs?: number } = {}): { adapter: CloudflareAdapter; requests: RecordedRequest[] } {
  const transport = recordedTransport(steps);
  return { adapter: new CloudflareAdapter({ token: CONTRACT_CANARY_TOKEN, baseUrl: BASE, fetchImpl: transport.fetchImpl, resolveDns: options.resolveDns, probeTimeoutMs: options.probeTimeoutMs }), requests: transport.requests };
}

const noopSleep = async () => undefined;

/** Narrowed read of the verification result carried by LP-DNS-VERIFICATION-TIMEOUT errors. */
function verificationDetails(error: unknown): { state: string; attempts: number; nameservers: string[] } {
  if (!(error instanceof ProviderRequestError)) throw new Error('expected a ProviderRequestError');
  const value = error.safeDetails.verification;
  if (typeof value !== 'object' || value === null || !('state' in value) || !('attempts' in value) || !('nameservers' in value)) throw new Error('verification details missing');
  const { state, attempts, nameservers } = value;
  if (typeof state !== 'string' || typeof attempts !== 'number' || !Array.isArray(nameservers) || !nameservers.every((entry) => typeof entry === 'string')) throw new Error('verification details malformed');
  return { state, attempts, nameservers };
}

it('observes a zone with its authoritative nameservers and reports a missing zone as NOT_FOUND', async () => {
  const { adapter, requests } = mount(loadScenarios('cloudflare').zone);
  const observed = await adapter.observeZone('config://cloudflare/example.com', ctx);
  expect(observed).toEqual(zone);
  expectRequest(requests, 'GET', '/zones?name=example.com&status=active');
  const empty = mount(loadScenarios('cloudflare').zoneEmpty);
  await expect(empty.adapter.observeZone('config://cloudflare/example.com', ctx)).rejects.toMatchObject({ code: 'LP-CLOUDFLARE-ZONE-MISSING', class: 'NOT_FOUND', retryable: false });
  await expect(empty.adapter.observeZone('config://cloudflare/', ctx)).rejects.toMatchObject({ code: 'LP-CLOUDFLARE-ZONE-REF-INVALID', class: 'VALIDATION', retryable: false });
});

it('observes records with ownership fingerprints, filters by type, and fails closed on malformed lists', async () => {
  const record = { id: 'record-1', name: 'app.example.com', type: 'CNAME', content: 'target.example', ttl: 1, proxied: false, comment: 'launchpad:fp-1' };
  const present = mount([{ request: { method: 'GET', path: '/zones/zone-1/dns_records?name=app.example.com&type=CNAME' }, response: { status: 200, body: { success: true, result: [record], errors: [], messages: [] } } }]);
  await expect(present.adapter.observeRecord('zone-1', 'app.example.com', ctx, 'CNAME')).resolves.toMatchObject({ id: 'record-1', zoneId: 'zone-1', ownershipFingerprint: 'fp-1' });
  const empty = mount(loadScenarios('cloudflare').recordListEmpty);
  await expect(empty.adapter.observeRecord('zone-1', 'app.example.com', ctx, 'CNAME')).resolves.toBeNull();
  const malformed = mount(loadScenarios('cloudflare').recordListMalformed);
  await expect(malformed.adapter.observeRecord('zone-1', 'app.example.com', ctx)).rejects.toMatchObject({ code: 'LP-CLOUDFLARE-MALFORMED-RESPONSE', class: 'MALFORMED_PROVIDER_RESPONSE', retryable: false });
  const partial = mount(loadScenarios('cloudflare').recordMissingFields);
  await expect(partial.adapter.observeRecord('zone-1', 'app.example.com', ctx)).rejects.toMatchObject({ code: 'LP-CLOUDFLARE-MALFORMED-RESPONSE', class: 'MALFORMED_PROVIDER_RESPONSE' });
});

it('creates an owned record, verifying the write by follow-up observation', async () => {
  const { adapter, requests } = mount(loadScenarios('cloudflare').recordCreate);
  const result = await adapter.ensureRecord('zone-1', required(), 'fp-1', ctx);
  expect(result.changed).toBe(true);
  expect(result.resource).toMatchObject({ id: 'record-1', zoneId: 'zone-1', type: 'CNAME', content: 'target.example', ttl: 1, proxied: false, ownershipFingerprint: 'fp-1' });
  const create = expectRequest(requests, 'POST', '/zones/zone-1/dns_records');
  expect(create.body).toEqual({ type: 'CNAME', name: 'app.example.com', content: 'target.example', ttl: 1, proxied: false, comment: 'launchpad:fp-1' });
  expect(create.headers['idempotency-key']).toBeDefined();
});

it('updates an owned record in place and is a no-op when nothing changed', async () => {
  const update = mount(loadScenarios('cloudflare').recordUpdate);
  const result = await update.adapter.ensureRecord('zone-1', required(), 'fp-1', ctx);
  expect(result.changed).toBe(true);
  const put = expectRequest(update.requests, 'PUT', '/zones/zone-1/dns_records/record-1');
  expect(put.body).toMatchObject({ content: 'target.example', comment: 'launchpad:fp-1' });
  const noop = mount(loadScenarios('cloudflare').recordNoop);
  const unchanged = await noop.adapter.ensureRecord('zone-1', required(), 'fp-1', ctx);
  expect(unchanged.changed).toBe(false);
  expect(noop.requests.some((request) => request.method === 'POST' || request.method === 'PUT')).toBe(false);
});

it('fails closed on unowned, replaced, or missing tracked records', async () => {
  const unowned = mount(loadScenarios('cloudflare').recordUnowned);
  await expect(unowned.adapter.ensureRecord('zone-1', required(), 'fp-1', ctx)).rejects.toMatchObject({ code: 'LP-DNS-CONFLICT-UNOWNED', class: 'CONFLICT', retryable: false });
  const replaced = mount(loadScenarios('cloudflare').recordReplaced);
  await expect(replaced.adapter.ensureRecord('zone-1', required({ providerRecordId: 'record-1' }), 'fp-1', ctx)).rejects.toMatchObject({ code: 'LP-DNS-CONFLICT-RECORD-REPLACED', class: 'CONFLICT' });
  const gone = mount(loadScenarios('cloudflare').recordGone);
  await expect(gone.adapter.ensureRecord('zone-1', required({ providerRecordId: 'record-1' }), 'fp-1', ctx)).rejects.toMatchObject({ code: 'LP-DNS-CONFLICT-RECORD-MISSING', class: 'CONFLICT' });
});

it('requires explicit acknowledgment for proxied mode and rejects numeric TTL', async () => {
  const { adapter } = mount(loadScenarios('cloudflare').recordListEmpty);
  await expect(adapter.ensureRecord('zone-1', required({ proxied: true }), 'fp-1', ctx)).rejects.toMatchObject({ code: 'LP-DNS-PROXY-ACKNOWLEDGMENT-REQUIRED', class: 'POLICY_BLOCK', retryable: false });
  await expect(adapter.ensureRecord('zone-1', required({ proxied: true, proxyAcknowledgment: true, ttl: 300 }), 'fp-1', ctx)).rejects.toMatchObject({ code: 'LP-DNS-PROXY-TTL-INVALID', class: 'VALIDATION' });
  const proxied = mount(loadScenarios('cloudflare').recordProxied);
  const result = await proxied.adapter.ensureRecord('zone-1', required({ proxied: true, proxyAcknowledgment: true }), 'fp-1', ctx);
  expect(result.resource.proxied).toBe(true);
  expect(expectRequest(proxied.requests, 'POST', '/zones/zone-1/dns_records').body).toMatchObject({ ttl: 1, proxied: true });
});

it('fails closed when the follow-up observation cannot verify the write', async () => {
  const { adapter } = mount(loadScenarios('cloudflare').recordPostconditionFail);
  await expect(adapter.ensureRecord('zone-1', required(), 'fp-1', ctx)).rejects.toMatchObject({ code: 'LP-DNS-POSTCONDITION-UNVERIFIED', class: 'TRANSIENT_PROVIDER', retryable: true });
});

it('verifies authoritative DNS through the injected resolver against the zone nameservers', async () => {
  const calls: Array<{ hostname: string; type: string; nameservers: string[] }> = [];
  const { adapter } = mount([], {
    resolveDns: async (hostname, type, nameservers) => {
      calls.push({ hostname, type, nameservers: [...nameservers] });
      return ['target.example'];
    },
    probeTimeoutMs: 1000,
  });
  await expect(adapter.verifyAuthoritative('app.example.com', required(), ctx, zone)).resolves.toBe(true);
  expect(calls).toEqual([{ hostname: 'app.example.com', type: 'CNAME', nameservers: ['ns1.example.net', 'ns2.example.net'] }]);
});

it('times out with a typed TIMEOUT carrying the verification result when the record never appears', async () => {
  const timed = new CloudflareAdapter({
    token: CONTRACT_CANARY_TOKEN, baseUrl: BASE, fetchImpl: async () => new Response('{}', { status: 200 }),
    resolveDns: async () => [],
    verification: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, timeoutMs: 1000, sleep: noopSleep, jitter: () => 0, now: () => 0 },
  });
  await expect(timed.verifyAuthoritative('app.example.com', required(), ctx, zone)).rejects.toSatisfy((error: unknown) => {
    expect(error).toMatchObject({ code: 'LP-DNS-VERIFICATION-TIMEOUT', class: 'TIMEOUT', retryable: true });
    expect(verificationDetails(error)).toEqual({ state: 'TIMED_OUT', attempts: 3, nameservers: ['ns1.example.net', 'ns2.example.net'] });
    return true;
  });
});

it('fails closed when authoritative verification lacks nameservers or a resolver', async () => {
  const noResolver = mount([], { resolveDns: undefined });
  await expect(noResolver.adapter.verifyAuthoritative('app.example.com', required(), ctx, zone)).rejects.toMatchObject({ code: 'LP-DNS-RESOLVER-UNCONFIGURED', class: 'UNSUPPORTED', retryable: false });
  const { adapter: withResolver } = mount([], { resolveDns: async () => [] });
  await expect(withResolver.verifyAuthoritative('app.example.com', required(), ctx, { ...zone, nameservers: [] })).rejects.toMatchObject({ code: 'LP-DNS-AUTHORITATIVE-NAMESERVERS-MISSING', class: 'VALIDATION', retryable: false });
});

it('deletes an owned record and verifies the postcondition', async () => {
  const { adapter, requests } = mount(loadScenarios('cloudflare').recordDelete);
  await expect(adapter.deleteRecord('zone-1', 'record-1', ctx, 'fp-1')).resolves.toBeUndefined();
  expectRequest(requests, 'DELETE', '/zones/zone-1/dns_records/record-1');
  const unowned = mount(loadScenarios('cloudflare').recordDeleteUnowned);
  await expect(unowned.adapter.deleteRecord('zone-1', 'record-1', ctx, 'fp-1')).rejects.toMatchObject({ code: 'LP-DNS-CONFLICT-UNOWNED', class: 'CONFLICT', retryable: false });
  const unverified = mount(loadScenarios('cloudflare').recordDeleteUnverified);
  await expect(unverified.adapter.deleteRecord('zone-1', 'record-1', ctx, 'fp-1')).rejects.toMatchObject({ code: 'LP-DNS-DELETE-UNVERIFIED', class: 'TRANSIENT_PROVIDER', retryable: true });
});

it('checks proxy compatibility through origin and public probes with CF-Connecting-IP pass-through', async () => {
  const steps: RecordedStep[] = [
    { request: { method: 'GET', path: '/health' }, response: { status: 200, body: { ok: true }, headers: { 'cf-connecting-ip': '203.0.113.10' } } },
    { request: { method: 'GET', path: '/health' }, response: { status: 200, body: { ok: true } } },
  ];
  const { adapter, requests } = mount(steps, { probeTimeoutMs: 1000 });
  const result = await adapter.checkProxyCompatibility({ hostname: 'app.example.com', originHost: 'app-1.vercel.app', healthPath: '/health', proxyAcknowledgment: true }, ctx);
  expect(result.compatible).toBe(true);
  expect(result.origin).toMatchObject({ route: 'origin', url: 'https://app-1.vercel.app/health', reachable: true, statusCode: 200, tls: 'ok', connectingIpHeader: true });
  expect(result.public).toMatchObject({ route: 'public', url: 'https://app.example.com/health', reachable: true, statusCode: 200, connectingIpHeader: false });
  expect(requests[0]?.headers['cf-connecting-ip']).toBe('203.0.113.10');

  const incompatible = mount([
    { request: { method: 'GET', path: '/health' }, response: { status: 200, body: {} } },
    { request: { method: 'GET', path: '/health' }, response: { status: 200, body: {} } },
  ], { probeTimeoutMs: 1000 });
  await expect(incompatible.adapter.checkProxyCompatibility({ hostname: 'app.example.com', originHost: 'app-1.vercel.app', proxyAcknowledgment: true }, ctx)).resolves.toMatchObject({ compatible: false });

  const unacknowledged = mount([], { probeTimeoutMs: 1000 });
  await expect(unacknowledged.adapter.checkProxyCompatibility({ hostname: 'app.example.com', originHost: 'app-1.vercel.app', proxyAcknowledgment: false }, ctx)).rejects.toMatchObject({ code: 'LP-DNS-PROXY-ACKNOWLEDGMENT-REQUIRED', class: 'POLICY_BLOCK', retryable: false });
});

it('maps recorded envelope errors to typed classes with only numeric codes', async () => {
  const rateLimited = mount(loadScenarios('cloudflare').envelopeRateLimited);
  await expect(rateLimited.adapter.observeRecord('zone-1', 'app.example.com', ctx)).rejects.toSatisfy((error: unknown) => {
    expect(error).toMatchObject({ code: 'LP-CLOUDFLARE-API-1001', class: 'RATE_LIMITED', retryable: true });
    if (!(error instanceof ProviderRequestError)) throw new Error('expected a ProviderRequestError');
    expect(JSON.stringify(error.safeDetails)).not.toContain('rate limit exceeded');
    return true;
  });
  const auth = mount(loadScenarios('cloudflare').envelopeAuth);
  await expect(auth.adapter.observeZone('config://cloudflare/example.com', ctx)).rejects.toMatchObject({ code: 'LP-CLOUDFLARE-API-9109', class: 'AUTHENTICATION', retryable: false });
  const forbidden = mount(loadScenarios('cloudflare').envelopeForbidden);
  await expect(forbidden.adapter.observeZone('config://cloudflare/example.com', ctx)).rejects.toMatchObject({ code: 'LP-CLOUDFLARE-API-9111', class: 'AUTHORIZATION', retryable: false });
  const unknown = mount(loadScenarios('cloudflare').envelopeUnknownCode);
  await expect(unknown.adapter.observeZone('config://cloudflare/example.com', ctx)).rejects.toMatchObject({ code: 'LP-CLOUDFLARE-API-9999', class: 'INTERNAL', retryable: false });
  const noCodes = mount(loadScenarios('cloudflare').envelopeNoCodes);
  await expect(noCodes.adapter.observeZone('config://cloudflare/example.com', ctx)).rejects.toMatchObject({ code: 'LP-CLOUDFLARE-API-UNKNOWN', class: 'INTERNAL', retryable: false });
  const missingSuccess = mount(loadScenarios('cloudflare').envelopeMissingSuccess);
  await expect(missingSuccess.adapter.observeZone('config://cloudflare/example.com', ctx)).rejects.toMatchObject({ code: 'LP-CLOUDFLARE-MALFORMED-RESPONSE', class: 'MALFORMED_PROVIDER_RESPONSE' });
  const nonJson = mount(loadScenarios('cloudflare').nonJson);
  await expect(nonJson.adapter.observeZone('config://cloudflare/example.com', ctx)).rejects.toMatchObject({ code: 'LP-CLOUDFLARE-MALFORMED-RESPONSE', class: 'MALFORMED_PROVIDER_RESPONSE' });
});

it('keeps provider error bodies and tokens out of typed errors', async () => {
  const { adapter } = mount(loadScenarios('cloudflare').errorCanary);
  await expect(adapter.observeZone('config://cloudflare/example.com', ctx)).rejects.toSatisfy((error: unknown) => {
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain(CONTRACT_CANARY_BODY);
    expect(serialized).not.toContain(CONTRACT_CANARY_TOKEN);
    expect(error).toMatchObject({ code: 'LP-CLOUDFLARE-HTTP-403', class: 'AUTHORIZATION', retryable: false });
    return true;
  });
});
