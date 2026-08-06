// DOM tests for the plan page: real plan records must render, hostile plan
// data must render literally (never parse as HTML), and malformed or empty
// control-plane responses must produce explicit states — never fake data.

import { beforeEach, expect, it, vi } from 'vitest';
import { ApiClient } from '../api.js';
import { renderPlanPage } from './plan.js';
import type { PageContext } from '../router.js';
import { asFakeElement, findTags, installDomShim } from '../test/dom-shim.js';

function context(fetchImpl: typeof fetch, token: string | null = 'operator-token'): PageContext {
  return { client: new ApiClient({ token, fetchImpl }), reload: () => undefined, openSession: () => undefined };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => installDomShim());

it('renders real plan records from the control plane', async () => {
  const plans = [
    { id: 'p1', fingerprint: 'f'.repeat(64), sourceCommit: 'c'.repeat(40), result: 'READY', createdAt: '2026-08-04T00:00:00.000Z', operationCount: 2, operations: [] },
    { id: 'p2', fingerprint: 'g'.repeat(64), sourceCommit: 'c'.repeat(40), result: 'BLOCKED', createdAt: '2026-08-04T01:00:00.000Z', operationCount: 0, operations: [] },
  ];
  const view = await renderPlanPage(context(async () => jsonResponse({ plans })), { id: 'app-demo' });
  expect(view.element.textContent).toContain('READY');
  expect(view.element.textContent).toContain('BLOCKED');
  expect(view.element.textContent).toContain('2 operations');
  expect(view.element.textContent).toContain('none');
  expect(findTags(asFakeElement(view.element), 'TABLE')).toHaveLength(1);
});

it('renders hostile plan data literally with no parsed elements', async () => {
  const hostile = { id: '<img src=x onerror=alert(1)>', fingerprint: '"><script>alert(1)</script>', sourceCommit: 'x', result: '"><img src=x>', createdAt: '2026-08-04T00:00:00.000Z', operationCount: 1, operations: [] };
  const view = await renderPlanPage(context(async () => jsonResponse({ plans: [hostile] })), { id: 'app-demo' });
  // The hostile fingerprint is shortened and rendered as literal text; the
  // hostile result is not a known plan status and classifies as UNKNOWN.
  expect(view.element.textContent).toContain('"><script>');
  expect(view.element.textContent).toContain('UNKNOWN');
  expect(findTags(asFakeElement(view.element), 'IMG')).toHaveLength(0);
  expect(findTags(asFakeElement(view.element), 'SCRIPT')).toHaveLength(0);
});

it('shows an explicit empty state and fails closed on malformed payloads', async () => {
  const empty = await renderPlanPage(context(async () => jsonResponse({ plans: [] })), { id: 'app-demo' });
  expect(empty.element.textContent).toContain('has not recorded plans');
  const malformed = await renderPlanPage(context(async () => jsonResponse({ unexpected: true })), { id: 'app-demo' });
  expect(malformed.element.textContent).toContain('malformed plan list');
  expect(malformed.element.textContent).not.toContain('has not recorded plans');
});

it('renders redacted fingerprints and source commits, never the full values', async () => {
  const fingerprint = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const commit = 'c'.repeat(40);
  const plans = [
    { id: 'p1', fingerprint, sourceCommit: commit, result: 'READY', createdAt: '2026-08-04T00:00:00.000Z', operationCount: 3, operations: [] },
  ];
  const view = await renderPlanPage(context(async () => jsonResponse({ plans })), { id: 'app-demo' });
  const text = view.element.textContent;
  expect(text).toContain(`${fingerprint.slice(0, 16)}…`);
  expect(text).toContain(`${commit.slice(0, 12)}…`);
  expect(text).toContain('3 operations');
  expect(text).not.toContain(fingerprint);
  expect(text).not.toContain(commit);
});

it('renders plan results through separated badges including DESTRUCTIVE and UNKNOWN', async () => {
  const plans = [
    { id: 'p1', fingerprint: 'f'.repeat(64), sourceCommit: 'c'.repeat(40), result: 'READY', createdAt: '2026-08-04T00:00:00.000Z', operationCount: 0, operations: [] },
    { id: 'p2', fingerprint: 'g'.repeat(64), sourceCommit: 'c'.repeat(40), result: 'DESTRUCTIVE', createdAt: '2026-08-04T01:00:00.000Z', operationCount: 1, operations: [] },
    { id: 'p3', fingerprint: 'h'.repeat(64), sourceCommit: '', result: '"><img src=x onerror=alert(1)>', createdAt: '2026-08-04T02:00:00.000Z', operationCount: 0, operations: [] },
  ];
  const view = await renderPlanPage(context(async () => jsonResponse({ plans })), { id: 'app-demo' });
  expect(view.element.textContent).toContain('DESTRUCTIVE');
  // Unknown results classify as UNKNOWN and are never echoed as markup.
  expect(view.element.textContent).toContain('UNKNOWN');
  expect(view.element.textContent).not.toContain('<img');
  // An empty source commit renders the dash placeholder.
  expect(view.element.textContent).toContain('—');
  expect(findTags(asFakeElement(view.element), 'IMG')).toHaveLength(0);
});

it('shows a concise error state when the plan read fails', async () => {
  const view = await renderPlanPage(context(async () => {
    throw new TypeError('fetch failed');
  }), { id: 'app-demo' });
  expect(view.element.textContent).toContain('Control plane read failed');
  expect(view.element.textContent).toContain('Control plane unreachable.');
  expect(view.element.textContent).toContain('RETRY');
  expect(view.element.textContent).toContain('VIEW AUDIT LOG');
});

it('fails closed with an authentication state when no session token is set', async () => {
  const fetchImpl = vi.fn(async () => jsonResponse({ plans: [] }));
  const view = await renderPlanPage(context(fetchImpl, null), { id: 'app-demo' });
  expect(view.element.textContent).toContain('Authentication required');
  expect(fetchImpl).not.toHaveBeenCalled();
  const buttons = findTags(asFakeElement(view.element), 'BUTTON');
  expect(buttons.some((button) => button.textContent === 'OPEN SESSION')).toBe(true);
});
