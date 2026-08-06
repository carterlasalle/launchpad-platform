// DOM tests for the credential metadata page: metadata renders from the
// control-plane envelope (fingerprints only — secret values never appear),
// hostile metadata renders literally, and empty or malformed responses
// produce explicit states.

import { beforeEach, expect, it } from 'vitest';
import { ApiClient } from '../api.js';
import { renderCredentialsPage } from './credentials.js';
import type { PageContext } from '../router.js';
import { asFakeElement, findTags, installDomShim } from '../test/dom-shim.js';

function context(fetchImpl: typeof fetch, token: string | null = 'operator-token'): PageContext {
  return { client: new ApiClient({ token, fetchImpl }), reload: () => undefined, openSession: () => undefined };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => installDomShim());

it('renders credential metadata without exposing secret values', async () => {
  const credentials = [
    { id: 'c1', provider: 'vercel', purpose: 'controller', valueFingerprint: 'f'.repeat(64), expiresAt: '2026-12-31T00:00:00.000Z', lastCheckedAt: '2026-08-04T00:00:00.000Z', status: 'VALID' },
    { id: 'c2', provider: 'cloudflare', purpose: 'dns', valueFingerprint: null, expiresAt: null, lastCheckedAt: '2026-08-04T00:00:00.000Z', status: 'EXPIRING_SOON' },
  ];
  const view = await renderCredentialsPage(context(async () => jsonResponse({ credentials })));
  expect(view.element.textContent).toContain('VALID');
  expect(view.element.textContent).toContain('EXPIRING SOON');
  expect(view.element.textContent).toContain('vercel');
  expect(view.element.textContent).toContain('Secret values are never displayed');
  expect(findTags(asFakeElement(view.element), 'TABLE')).toHaveLength(1);
});

it('renders hostile credential metadata literally with no parsed elements', async () => {
  const credentials = [
    { id: 'c1', provider: '<img src=x onerror=alert(1)>', purpose: '<script>alert(2)</script>', valueFingerprint: '"><b>bold</b>', expiresAt: '2026-08-04T00:00:00.000Z', lastCheckedAt: '2026-08-04T00:00:00.000Z', status: '"><img src=x>' },
  ];
  const view = await renderCredentialsPage(context(async () => jsonResponse({ credentials })));
  expect(view.element.textContent).toContain('<img src=x onerror=alert(1)>');
  expect(view.element.textContent).toContain('<script>alert(2)</script>');
  expect(findTags(asFakeElement(view.element), 'IMG')).toHaveLength(0);
  expect(findTags(asFakeElement(view.element), 'SCRIPT')).toHaveLength(0);
  expect(findTags(asFakeElement(view.element), 'B')).toHaveLength(0);
});

it('shows an explicit empty state and fails closed on malformed payloads', async () => {
  const empty = await renderCredentialsPage(context(async () => jsonResponse({ credentials: [] })));
  expect(empty.element.textContent).toContain('has not recorded credential metadata');
  const malformed = await renderCredentialsPage(context(async () => jsonResponse({ unexpected: true })));
  expect(malformed.element.textContent).toContain('malformed credential metadata list');
  expect(malformed.element.textContent).not.toContain('has not recorded');
});

it('renders expiry and status for every credential state', async () => {
  const credentials = [
    { id: 'c1', provider: 'vercel', purpose: 'controller', valueFingerprint: 'f'.repeat(64), expiresAt: '2026-12-31T00:00:00.000Z', lastCheckedAt: '2026-08-04T00:00:00.000Z', status: 'VALID' },
    { id: 'c2', provider: 'cloudflare', purpose: 'dns', valueFingerprint: null, expiresAt: null, lastCheckedAt: '2026-08-04T00:00:00.000Z', status: 'EXPIRING_SOON' },
    { id: 'c3', provider: 'github', purpose: 'ruleset', valueFingerprint: 'g'.repeat(64), expiresAt: '2026-06-30T00:00:00.000Z', lastCheckedAt: '2026-08-04T00:00:00.000Z', status: 'EXPIRED' },
    { id: 'c4', provider: 'vercel', purpose: 'deploy', valueFingerprint: 'h'.repeat(64), expiresAt: '2026-01-15T00:00:00.000Z', lastCheckedAt: '2026-08-04T00:00:00.000Z', status: 'REVOKED' },
  ];
  const view = await renderCredentialsPage(context(async () => jsonResponse({ credentials })));
  expect(view.element.textContent).toContain('4 credentials tracked');
  expect(view.element.textContent).toContain('EXPIRED');
  expect(view.element.textContent).toContain('REVOKED');
  expect(view.element.textContent).toContain(new Date('2026-12-31T00:00:00.000Z').toLocaleString());
  expect(view.element.textContent).toContain(new Date('2026-06-30T00:00:00.000Z').toLocaleString());
  // Credentials without an expiry render the dash placeholder, never a date.
  expect(view.element.textContent).toContain('—');
  const tables = findTags(asFakeElement(view.element), 'TABLE');
  expect(findTags(asFakeElement(tables[0]), 'TR')).toHaveLength(5); // header + four rows
});

it('renders keyed fingerprints only — secret values never appear', async () => {
  const secret = 'sk-live-abcdef1234567890-super-secret-value';
  const credentials = [
    { id: 'c1', provider: 'vercel', purpose: 'controller', value: secret, valueFingerprint: 'f'.repeat(64), expiresAt: '2026-12-31T00:00:00.000Z', lastCheckedAt: '2026-08-04T00:00:00.000Z', status: 'VALID' },
    { id: 'c2', provider: 'cloudflare', purpose: 'dns', value: secret, valueFingerprint: null, expiresAt: null, lastCheckedAt: '2026-08-04T00:00:00.000Z', status: 'EXPIRING_SOON' },
  ];
  const view = await renderCredentialsPage(context(async () => jsonResponse({ credentials })));
  const text = view.element.textContent;
  // Fingerprints render truncated (never in full); the secret value field is
  // never read, so even a hostile payload carrying one cannot leak it.
  expect(text).toContain(`${'f'.repeat(16)}…`);
  expect(text).toContain('—');
  expect(text).not.toContain(secret);
  expect(text).not.toContain('sk-live');
  expect(text).not.toContain('f'.repeat(64));
  expect(text).not.toContain('super-secret-value');
});

it('shows a concise error state when the credential read fails', async () => {
  const view = await renderCredentialsPage(context(async () => {
    throw new TypeError('fetch failed');
  }));
  expect(view.element.textContent).toContain('Control plane read failed');
  expect(view.element.textContent).toContain('Control plane unreachable.');
  expect(view.element.textContent).toContain('VIEW AUDIT LOG');
  expect(view.element.textContent).toContain('VIEW OPERATIONS');
});
