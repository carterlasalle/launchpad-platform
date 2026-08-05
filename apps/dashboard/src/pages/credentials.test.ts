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
