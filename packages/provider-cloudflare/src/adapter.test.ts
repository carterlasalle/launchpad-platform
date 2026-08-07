import { expect, it } from 'vitest';
import { CloudflareAdapter, CloudflareClient } from './index.js';
import type { DnsVerificationResult, ProviderContext, RequiredDnsRecord, ZoneObservation } from '@launchpad/provider-contract';

const ctx: ProviderContext = { correlationId: 'corr', applicationId: 'app', workflowId: 'wf', actor: { kind: 'system', id: 'test' }, dryRun: false };
const API = 'https://api.cloudflare.com/client/v4';

const zoneObservation: ZoneObservation = { provider: 'cloudflare', zoneId: 'zone-1', name: 'example.com', nameservers: ['ns1.example.net', 'ns2.example.net'], status: 'active' };

function required(overrides: Partial<RequiredDnsRecord> = {}): RequiredDnsRecord {
  return { hostname: 'app.example.com', type: 'CNAME', value: 'target.example', ttl: 'auto', ...overrides };
}

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'record-1', name: 'app.example.com', type: 'CNAME', content: 'target.example', ttl: 1, proxied: false, comment: 'launchpad:owned', ...overrides };
}

function ok(result: unknown): unknown {
  return { success: true, result, errors: [], messages: [] };
}

function apiFail(errors: Array<{ code: number; message?: string }>): unknown {
  return { success: false, result: null, errors, messages: [] };
}

interface Step { method: string; path: string; status?: number; response: unknown; assertBody?: (body: unknown) => void; }

/** Deterministic call-order scripted Cloudflare API mock. Any unexpected call fails the test. */
function scriptedApi(steps: Step[]): { fetchImpl: typeof fetch; calls: Array<{ method: string; path: string; body: unknown }> } {
  let index = 0;
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.replace(API, '');
    const step = steps[index];
    index += 1;
    if (!step) throw new Error(`Unexpected call: ${method} ${path}`);
    if (step.method !== method || step.path !== path) throw new Error(`Expected ${step.method} ${step.path}, got ${method} ${path}`);
    const body = typeof init?.body === 'string' && init.body.length > 0 ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ method, path, body });
    step.assertBody?.(body);
    return new Response(JSON.stringify(step.response), { status: step.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

// --- ensureRecord: create / update / no-op / conflicts / proxy mode ---

it('creates an owned DNS record with DNS-only mode by default and verified postcondition', async () => {
  const created = record({ id: 'record-1' });
  const { fetchImpl, calls } = scriptedApi([
    { method: 'GET', path: '/zones/zone-1/dns_records?name=app.example.com&type=CNAME', response: ok([]) },
    { method: 'POST', path: '/zones/zone-1/dns_records', response: ok(created), assertBody: (body) => expect(body).toEqual({ type: 'CNAME', name: 'app.example.com', content: 'target.example', ttl: 1, proxied: false, comment: 'launchpad:owned' }) },
    { method: 'GET', path: '/zones/zone-1/dns_records?name=app.example.com&type=CNAME', response: ok([created]) },
  ]);
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  const result = await adapter.ensureRecord('zone-1', required(), 'owned', ctx);
  expect(result.changed).toBe(true);
  expect(result.resource).toMatchObject({ id: 'record-1', zoneId: 'zone-1', proxied: false, ownershipFingerprint: 'owned' });
  expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /zones/zone-1/dns_records?name=app.example.com&type=CNAME', 'POST /zones/zone-1/dns_records', 'GET /zones/zone-1/dns_records?name=app.example.com&type=CNAME']);
});

it('updates an owned record in place and respects a numeric TTL', async () => {
  const current = record({ id: 'record-1', content: 'old.example', ttl: 120 });
  const updated = record({ id: 'record-1', content: 'target.example', ttl: 300 });
  const { fetchImpl, calls } = scriptedApi([
    { method: 'GET', path: '/zones/zone-1/dns_records?name=app.example.com&type=CNAME', response: ok([current]) },
    { method: 'PUT', path: '/zones/zone-1/dns_records/record-1', response: ok(updated), assertBody: (body) => expect(body).toEqual({ type: 'CNAME', name: 'app.example.com', content: 'target.example', ttl: 300, proxied: false, comment: 'launchpad:owned' }) },
    { method: 'GET', path: '/zones/zone-1/dns_records?name=app.example.com&type=CNAME', response: ok([updated]) },
  ]);
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  const result = await adapter.ensureRecord('zone-1', required({ value: 'target.example', ttl: 300 }), 'owned', ctx);
  expect(result.changed).toBe(true);
  expect(result.resource.ttl).toBe(300);
  expect(calls[1]?.method).toBe('PUT');
});

it('is a no-op when the owned record already matches the desired state', async () => {
  const current = record({ id: 'record-1', content: 'target.example', ttl: 1 });
  const { fetchImpl, calls } = scriptedApi([
    { method: 'GET', path: '/zones/zone-1/dns_records?name=app.example.com&type=CNAME', response: ok([current]) },
  ]);
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  const result = await adapter.ensureRecord('zone-1', required(), 'owned', ctx);
  expect(result.changed).toBe(false);
  expect(result.resource.id).toBe('record-1');
  expect(calls).toHaveLength(1);
});

it('refuses an existing record without Launchpad ownership metadata', async () => {
  const { fetchImpl } = scriptedApi([
    { method: 'GET', path: '/zones/zone-1/dns_records?name=app.example.com&type=CNAME', response: ok([record({ comment: null })]) },
  ]);
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  await expect(adapter.ensureRecord('zone-1', required(), 'owned', ctx)).rejects.toMatchObject({ code: 'LP-DNS-CONFLICT-UNOWNED', class: 'CONFLICT', retryable: false });
});

it('blocks when the tracked provider record id no longer matches the live record', async () => {
  const { fetchImpl } = scriptedApi([
    { method: 'GET', path: '/zones/zone-1/dns_records?name=app.example.com&type=CNAME', response: ok([record({ id: 'record-1' })]) },
  ]);
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  await expect(adapter.ensureRecord('zone-1', required({ providerRecordId: 'record-9' }), 'owned', ctx)).rejects.toMatchObject({ code: 'LP-DNS-CONFLICT-RECORD-REPLACED', class: 'CONFLICT' });
});

it('blocks when the tracked provider record has disappeared', async () => {
  const { fetchImpl } = scriptedApi([
    { method: 'GET', path: '/zones/zone-1/dns_records?name=app.example.com&type=CNAME', response: ok([]) },
  ]);
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  await expect(adapter.ensureRecord('zone-1', required({ providerRecordId: 'record-1' }), 'owned', ctx)).rejects.toMatchObject({ code: 'LP-DNS-CONFLICT-RECORD-MISSING', class: 'CONFLICT' });
});

it('refuses proxied mode without explicit acknowledgment', async () => {
  const { fetchImpl } = scriptedApi([]);
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  await expect(adapter.ensureRecord('zone-1', required({ proxied: true }), 'owned', ctx)).rejects.toMatchObject({ code: 'LP-DNS-PROXY-ACKNOWLEDGMENT-REQUIRED', class: 'POLICY_BLOCK', retryable: false });
});

it('creates a proxied record when explicitly acknowledged (automatic TTL enforced)', async () => {
  const created = record({ id: 'record-1', proxied: true });
  const { fetchImpl, calls } = scriptedApi([
    { method: 'GET', path: '/zones/zone-1/dns_records?name=app.example.com&type=CNAME', response: ok([]) },
    { method: 'POST', path: '/zones/zone-1/dns_records', response: ok(created), assertBody: (body) => expect(body).toMatchObject({ proxied: true, ttl: 1 }) },
    { method: 'GET', path: '/zones/zone-1/dns_records?name=app.example.com&type=CNAME', response: ok([created]) },
  ]);
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  const result = await adapter.ensureRecord('zone-1', required({ proxied: true, proxyAcknowledgment: true }), 'owned', ctx);
  expect(result.changed).toBe(true);
  expect(result.resource.proxied).toBe(true);
  expect(calls[1]?.body).toMatchObject({ proxied: true });
});

it('refuses proxied mode with a numeric TTL', async () => {
  const { fetchImpl } = scriptedApi([]);
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  await expect(adapter.ensureRecord('zone-1', required({ proxied: true, proxyAcknowledgment: true, ttl: 300 }), 'owned', ctx)).rejects.toMatchObject({ code: 'LP-DNS-PROXY-TTL-INVALID', class: 'VALIDATION' });
});

it('is a no-op for a proxied record that already matches', async () => {
  const current = record({ id: 'record-1', content: 'target.example', ttl: 1, proxied: true });
  const { fetchImpl } = scriptedApi([
    { method: 'GET', path: '/zones/zone-1/dns_records?name=app.example.com&type=CNAME', response: ok([current]) },
  ]);
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  const result = await adapter.ensureRecord('zone-1', required({ proxied: true, proxyAcknowledgment: true }), 'owned', ctx);
  expect(result.changed).toBe(false);
});

it('removes proxying when the requested mode returns to DNS-only', async () => {
  const current = record({ id: 'record-1', content: 'target.example', ttl: 1, proxied: true });
  const updated = record({ id: 'record-1', content: 'target.example', ttl: 1, proxied: false });
  const { fetchImpl } = scriptedApi([
    { method: 'GET', path: '/zones/zone-1/dns_records?name=app.example.com&type=CNAME', response: ok([current]) },
    { method: 'PUT', path: '/zones/zone-1/dns_records/record-1', response: ok(updated), assertBody: (body) => expect(body).toMatchObject({ proxied: false }) },
    { method: 'GET', path: '/zones/zone-1/dns_records?name=app.example.com&type=CNAME', response: ok([updated]) },
  ]);
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  const result = await adapter.ensureRecord('zone-1', required(), 'owned', ctx);
  expect(result.changed).toBe(true);
  expect(result.resource.proxied).toBe(false);
});

it('fails closed when the follow-up observation cannot verify the write', async () => {
  const created = record({ id: 'record-1' });
  const { fetchImpl } = scriptedApi([
    { method: 'GET', path: '/zones/zone-1/dns_records?name=app.example.com&type=CNAME', response: ok([]) },
    { method: 'POST', path: '/zones/zone-1/dns_records', response: ok(created) },
    { method: 'GET', path: '/zones/zone-1/dns_records?name=app.example.com&type=CNAME', response: ok([]) },
  ]);
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  await expect(adapter.ensureRecord('zone-1', required(), 'owned', ctx)).rejects.toMatchObject({ code: 'LP-DNS-POSTCONDITION-UNVERIFIED', class: 'TRANSIENT_PROVIDER', retryable: true });
});

it('fails closed on malformed required record fields', async () => {
  const { fetchImpl } = scriptedApi([]);
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  await expect(adapter.ensureRecord('zone-1', required({ value: '' }), 'owned', ctx)).rejects.toMatchObject({ code: 'LP-DNS-REQUIRED-RECORD-INVALID', class: 'VALIDATION' });
  await expect(adapter.ensureRecord('zone-1', required(), '', ctx)).rejects.toMatchObject({ code: 'LP-DNS-OWNERSHIP-FINGERPRINT-INVALID', class: 'VALIDATION' });
});

// --- verifyAuthoritative: authoritative nameservers, bounded backoff, typed timeout ---

it('verifies against the zone authoritative nameservers through the injected resolver', async () => {
  const resolverCalls: Array<{ hostname: string; type: string; nameservers: string[] }> = [];
  const adapter = new CloudflareAdapter({ token: 'token', resolveDns: async (hostname, type, nameservers) => { resolverCalls.push({ hostname, type, nameservers }); return ['target.example.']; } });
  await expect(adapter.verifyAuthoritative('app.example.com', required(), ctx, zoneObservation)).resolves.toBe(true);
  expect(resolverCalls).toEqual([{ hostname: 'app.example.com', type: 'CNAME', nameservers: ['ns1.example.net', 'ns2.example.net'] }]);
});

it('retries with bounded exponential backoff until propagation is observed', async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const adapter = new CloudflareAdapter({ token: 'token', resolveDns: async () => { calls += 1; return calls >= 2 ? ['target.example.'] : []; }, verification: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 1500, timeoutMs: 100_000, jitter: () => 0, sleep: async (ms) => { sleeps.push(ms); } } });
  await expect(adapter.verifyAuthoritative('app.example.com', required(), ctx, zoneObservation)).resolves.toBe(true);
  expect(calls).toBe(2);
  expect(sleeps).toEqual([1000]);
});

it('times out with a typed TIMEOUT error carrying the verification result', async () => {
  const sleeps: number[] = [];
  let t = 0;
  const adapter = new CloudflareAdapter({ token: 'token', resolveDns: async () => [], verification: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 4000, timeoutMs: 2500, jitter: () => 0, sleep: async (ms) => { sleeps.push(ms); t += ms; }, now: () => t } });
  const error = await adapter.verifyAuthoritative('app.example.com', required(), ctx, zoneObservation).catch((err: unknown) => err);
  expect(error).toMatchObject({ code: 'LP-DNS-VERIFICATION-TIMEOUT', class: 'TIMEOUT', retryable: true });
  const verification = (error as { safeDetails: { verification: DnsVerificationResult } }).safeDetails.verification;
  expect(verification.state).toBe('TIMED_OUT');
  expect(verification.hostname).toBe('app.example.com');
  expect(verification.nameservers).toEqual(['ns1.example.net', 'ns2.example.net']);
  expect(verification.attempts).toBe(2); // overall deadline cut the third attempt short
  expect(sleeps).toEqual([1000, 2000]);
});

it('caps backoff delay growth and applies jitter', async () => {
  const sleeps: number[] = [];
  const adapter = new CloudflareAdapter({ token: 'token', resolveDns: async () => [], verification: { maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 1500, timeoutMs: 100_000, jitter: () => 500, sleep: async (ms) => { sleeps.push(ms); } } });
  await expect(adapter.verifyAuthoritative('app.example.com', required(), ctx, zoneObservation)).rejects.toMatchObject({ code: 'LP-DNS-VERIFICATION-TIMEOUT' });
  expect(sleeps).toEqual([1500, 2000, 2000]);
});

it('clamps negative jitter to zero', async () => {
  const sleeps: number[] = [];
  const adapter = new CloudflareAdapter({ token: 'token', resolveDns: async () => [], verification: { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 1500, timeoutMs: 100_000, jitter: () => -9000, sleep: async (ms) => { sleeps.push(ms); } } });
  await expect(adapter.verifyAuthoritative('app.example.com', required(), ctx, zoneObservation)).rejects.toMatchObject({ code: 'LP-DNS-VERIFICATION-TIMEOUT' });
  expect(sleeps).toEqual([1000]);
});

it('fails closed when no authoritative nameservers are supplied', async () => {
  const adapter = new CloudflareAdapter({ token: 'token', resolveDns: async () => [] });
  await expect(adapter.verifyAuthoritative('app.example.com', required(), ctx)).rejects.toMatchObject({ code: 'LP-DNS-AUTHORITATIVE-NAMESERVERS-MISSING', class: 'VALIDATION', retryable: false });
});

it('fails closed when no resolver is configured', async () => {
  const adapter = new CloudflareAdapter({ token: 'token' });
  await expect(adapter.verifyAuthoritative('app.example.com', required(), ctx, zoneObservation)).rejects.toMatchObject({ code: 'LP-DNS-RESOLVER-UNCONFIGURED', class: 'UNSUPPORTED', retryable: false });
});

it('normalizes trailing dots and TXT quotes when comparing answers', async () => {
  const adapter = new CloudflareAdapter({ token: 'token', resolveDns: async () => ['"target.example"'] });
  await expect(adapter.verifyAuthoritative('app.example.com', required({ value: 'target.example' }), ctx, zoneObservation)).resolves.toBe(true);
});

// --- envelope parsing, error mapping, redaction ---

it('maps Cloudflare rate-limit envelopes to typed RATE_LIMITED errors', async () => {
  const { fetchImpl } = scriptedApi([
    { method: 'GET', path: '/zones/zone-1/dns_records?name=app.example.com', response: apiFail([{ code: 1001, message: 'rate limited' }]) },
  ]);
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  const error = await adapter.observeRecord('zone-1', 'app.example.com', ctx).catch((err: unknown) => err);
  expect(error).toMatchObject({ code: 'LP-CLOUDFLARE-API-1001', class: 'RATE_LIMITED', retryable: true });
  expect((error as { safeDetails: { codes: number[] } }).safeDetails.codes).toEqual([1001]);
  expect(JSON.stringify((error as { safeDetails: Record<string, unknown> }).safeDetails)).not.toContain('rate limited');
});

it('maps Cloudflare authentication error codes to AUTHENTICATION', async () => {
  const { fetchImpl } = scriptedApi([
    { method: 'GET', path: '/zones?name=example.com&status=active', response: apiFail([{ code: 9109, message: 'invalid token' }]) },
  ]);
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  const error = await adapter.observeZone('config://cloudflare/example.com', ctx).catch((err: unknown) => err);
  expect(error).toMatchObject({ code: 'LP-CLOUDFLARE-API-9109', class: 'AUTHENTICATION', retryable: false });
  expect(JSON.stringify((error as { safeDetails: Record<string, unknown> }).safeDetails)).not.toContain('invalid token');
});

it('fails closed on unknown Cloudflare error codes', async () => {
  const { fetchImpl } = scriptedApi([
    { method: 'GET', path: '/zones?name=example.com&status=active', response: apiFail([{ code: 9999 }]) },
  ]);
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  await expect(adapter.observeZone('config://cloudflare/example.com', ctx)).rejects.toMatchObject({ code: 'LP-CLOUDFLARE-API-9999', class: 'INTERNAL', retryable: false });
});

it('fails closed when a failure envelope carries no error codes', async () => {
  const { fetchImpl } = scriptedApi([
    { method: 'GET', path: '/zones?name=example.com&status=active', response: apiFail([]) },
  ]);
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  await expect(adapter.observeZone('config://cloudflare/example.com', ctx)).rejects.toMatchObject({ code: 'LP-CLOUDFLARE-API-UNKNOWN', class: 'INTERNAL' });
});

it('fails closed when the envelope lacks a success field', async () => {
  const { fetchImpl } = scriptedApi([
    { method: 'GET', path: '/zones/zone-1/dns_records?name=app.example.com', response: { result: [] } },
  ]);
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  await expect(adapter.observeRecord('zone-1', 'app.example.com', ctx)).rejects.toMatchObject({ code: 'LP-CLOUDFLARE-MALFORMED-RESPONSE', class: 'MALFORMED_PROVIDER_RESPONSE', retryable: false });
});

it('fails closed on non-JSON provider bodies', async () => {
  const fetchImpl = (async () => new Response('definitely not json', { status: 200 })) as typeof fetch;
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  await expect(adapter.observeZone('config://cloudflare/example.com', ctx)).rejects.toMatchObject({ code: 'LP-CLOUDFLARE-MALFORMED-RESPONSE', class: 'MALFORMED_PROVIDER_RESPONSE', retryable: false });
});

it('fails closed when a returned DNS record is missing required fields', async () => {
  const { fetchImpl } = scriptedApi([
    { method: 'GET', path: '/zones/zone-1/dns_records?name=app.example.com', response: ok([{ name: 'app.example.com', type: 'CNAME', content: 'x', ttl: 1 }]) },
  ]);
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  await expect(adapter.observeRecord('zone-1', 'app.example.com', ctx)).rejects.toMatchObject({ code: 'LP-CLOUDFLARE-MALFORMED-RESPONSE', class: 'MALFORMED_PROVIDER_RESPONSE' });
});

it('redacts raw provider bodies from HTTP error details', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ success: false, errors: [{ code: 1001, message: 'top secret provider detail' }] }), { status: 429, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const client = new CloudflareClient({ token: 'token', fetchImpl });
  const error = await client.request<unknown>('/zones').catch((err: unknown) => err);
  expect(error).toMatchObject({ code: 'LP-CLOUDFLARE-HTTP-429', class: 'RATE_LIMITED', retryable: true });
  const safeDetails = (error as { safeDetails: Record<string, unknown> }).safeDetails;
  expect('body' in safeDetails).toBe(false);
  expect(JSON.stringify(safeDetails)).not.toContain('secret');
  expect((error as Error).message).not.toContain('secret');
});

// --- deleteRecord: ownership, postcondition ---

it('deletes an owned record after verifying ownership and postcondition', async () => {
  const current = record({ id: 'record-1' });
  const { fetchImpl, calls } = scriptedApi([
    { method: 'GET', path: '/zones/zone-1/dns_records/record-1', response: ok(current) },
    { method: 'DELETE', path: '/zones/zone-1/dns_records/record-1', response: ok({ id: 'record-1' }) },
    { method: 'GET', path: '/zones/zone-1/dns_records/record-1', response: apiFail([{ code: 81044 }]) },
  ]);
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  await adapter.deleteRecord('zone-1', 'record-1', ctx, 'owned');
  expect(calls.map((call) => call.method)).toEqual(['GET', 'DELETE', 'GET']);
});

it('refuses to delete a record owned by another application', async () => {
  const current = record({ id: 'record-1', comment: 'launchpad:someone-else' });
  const { fetchImpl, calls } = scriptedApi([
    { method: 'GET', path: '/zones/zone-1/dns_records/record-1', response: ok(current) },
  ]);
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  await expect(adapter.deleteRecord('zone-1', 'record-1', ctx, 'owned')).rejects.toMatchObject({ code: 'LP-DNS-CONFLICT-UNOWNED', class: 'CONFLICT', retryable: false });
  expect(calls).toHaveLength(1);
});

it('fails closed when the record still exists after deletion', async () => {
  const current = record({ id: 'record-1' });
  const { fetchImpl } = scriptedApi([
    { method: 'GET', path: '/zones/zone-1/dns_records/record-1', response: ok(current) },
    { method: 'DELETE', path: '/zones/zone-1/dns_records/record-1', response: ok({ id: 'record-1' }) },
    { method: 'GET', path: '/zones/zone-1/dns_records/record-1', response: ok(current) },
  ]);
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  await expect(adapter.deleteRecord('zone-1', 'record-1', ctx, 'owned')).rejects.toMatchObject({ code: 'LP-DNS-DELETE-UNVERIFIED', class: 'TRANSIENT_PROVIDER', retryable: true });
});

it('deletes without an ownership fingerprint and still verifies the postcondition', async () => {
  const { fetchImpl, calls } = scriptedApi([
    { method: 'DELETE', path: '/zones/zone-1/dns_records/record-1', response: ok({ id: 'record-1' }) },
    { method: 'GET', path: '/zones/zone-1/dns_records/record-1', response: apiFail([{ code: 81044 }]) },
  ]);
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  await adapter.deleteRecord('zone-1', 'record-1', ctx);
  expect(calls.map((call) => call.method)).toEqual(['DELETE', 'GET']);
});

it('reports NOT_FOUND when an owned record to delete does not exist', async () => {
  const { fetchImpl } = scriptedApi([
    { method: 'GET', path: '/zones/zone-1/dns_records/record-1', response: apiFail([{ code: 81044 }]) },
  ]);
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  await expect(adapter.deleteRecord('zone-1', 'record-1', ctx, 'owned')).rejects.toMatchObject({ code: 'LP-CLOUDFLARE-API-81044', class: 'NOT_FOUND', retryable: false });
});

// --- observeZone / observeRecord ---

it('observes a zone with its authoritative nameservers', async () => {
  const { fetchImpl } = scriptedApi([
    { method: 'GET', path: '/zones?name=example.com&status=active', response: ok([{ id: 'zone-1', name: 'example.com', name_servers: ['ns1.example.net'], status: 'active' }]) },
  ]);
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  await expect(adapter.observeZone('config://cloudflare/example.com', ctx)).resolves.toEqual({ provider: 'cloudflare', zoneId: 'zone-1', name: 'example.com', nameservers: ['ns1.example.net'], status: 'active' });
});

it('reports a missing zone as NOT_FOUND', async () => {
  const { fetchImpl } = scriptedApi([
    { method: 'GET', path: '/zones?name=example.com&status=active', response: ok([]) },
  ]);
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  await expect(adapter.observeZone('config://cloudflare/example.com', ctx)).rejects.toMatchObject({ code: 'LP-CLOUDFLARE-ZONE-MISSING', class: 'NOT_FOUND', retryable: false });
});

it('fails closed on a malformed zone result', async () => {
  const { fetchImpl } = scriptedApi([
    { method: 'GET', path: '/zones?name=example.com&status=active', response: ok([{ name: 'example.com' }]) },
  ]);
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  await expect(adapter.observeZone('config://cloudflare/example.com', ctx)).rejects.toMatchObject({ code: 'LP-CLOUDFLARE-MALFORMED-RESPONSE', class: 'MALFORMED_PROVIDER_RESPONSE' });
});

it('filters observed records by type', async () => {
  const cname = record({ id: 'record-1', type: 'CNAME', content: 'target.example' });
  const txt = record({ id: 'record-2', type: 'TXT', content: '"v=spf1 -all"' });
  const { fetchImpl } = scriptedApi([
    { method: 'GET', path: '/zones/zone-1/dns_records?name=app.example.com&type=TXT', response: ok([cname, txt]) },
  ]);
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  await expect(adapter.observeRecord('zone-1', 'app.example.com', ctx, 'TXT')).resolves.toMatchObject({ id: 'record-2', type: 'TXT' });
});

// --- checkProxyCompatibility: origin/public results ---

it('refuses proxy compatibility checks without acknowledgment', async () => {
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl: (async () => { throw new Error('must not probe'); }) as typeof fetch });
  await expect(adapter.checkProxyCompatibility({ hostname: 'app.example.com', originHost: 'app.vercel.app', proxyAcknowledgment: false }, ctx)).rejects.toMatchObject({ code: 'LP-DNS-PROXY-ACKNOWLEDGMENT-REQUIRED', class: 'POLICY_BLOCK' });
});

it('reports origin and public route results and derives compatibility', async () => {
  const probeCalls: Array<{ url: string; headers: Headers }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input);
    probeCalls.push({ url, headers: new Headers(init?.headers) });
    if (new URL(url).host === 'app.vercel.app') return new Response('ok', { status: 200, headers: { 'cf-connecting-ip': '203.0.113.10' } });
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  const result = await adapter.checkProxyCompatibility({ hostname: 'app.example.com', originHost: 'app.vercel.app', healthPath: '/api/health', proxyAcknowledgment: true }, ctx);
  expect(result.compatible).toBe(true);
  expect(result.origin).toMatchObject({ route: 'origin', url: 'https://app.vercel.app/api/health', reachable: true, statusCode: 200, tls: 'ok', connectingIpHeader: true });
  expect(result.public).toMatchObject({ route: 'public', url: 'https://app.example.com/api/health', reachable: true, statusCode: 200, tls: 'ok', connectingIpHeader: false });
  expect(probeCalls[0]?.url).toBe('https://app.vercel.app/api/health');
  expect(probeCalls[0]?.headers.get('cf-connecting-ip')).toBe('203.0.113.10');
  expect(probeCalls[1]?.headers.get('cf-connecting-ip')).toBeNull();
});

it('reports incompatible when the origin does not carry CF-Connecting-IP through', async () => {
  const fetchImpl = (async () => new Response('ok', { status: 200 })) as typeof fetch;
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  const result = await adapter.checkProxyCompatibility({ hostname: 'app.example.com', originHost: 'app.vercel.app', proxyAcknowledgment: true }, ctx);
  expect(result.compatible).toBe(false);
  expect(result.origin.connectingIpHeader).toBe(false);
  expect(result.public.reachable).toBe(true);
});

it('reports a failed origin route when the direct probe errors', async () => {
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input);
    if (new URL(url).host === 'app.vercel.app') throw new TypeError('fetch failed');
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  const result = await adapter.checkProxyCompatibility({ hostname: 'app.example.com', originHost: 'app.vercel.app', proxyAcknowledgment: true }, ctx);
  expect(result.compatible).toBe(false);
  expect(result.origin).toMatchObject({ reachable: false, statusCode: null, tls: 'failed' });
  expect(result.public.reachable).toBe(true);
});

it('bounds proxy probes with a timeout and reports tls as unknown', async () => {
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
  }) as typeof fetch;
  const adapter = new CloudflareAdapter({ token: 'token', fetchImpl });
  const result = await adapter.checkProxyCompatibility({ hostname: 'app.example.com', originHost: 'app.vercel.app', proxyAcknowledgment: true, timeoutMs: 20 }, ctx);
  expect(result.origin).toMatchObject({ reachable: false, statusCode: null, tls: 'unknown' });
  expect(result.public).toMatchObject({ reachable: false, statusCode: null, tls: 'unknown' });
  expect(result.compatible).toBe(false);
});
