// DOM tests for the plan page: real plan records must render, hostile plan
// data must render literally (never parse as HTML), and malformed or empty
// control-plane responses must produce explicit states — never fake data.

import { beforeEach, expect, it } from 'vitest';
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
