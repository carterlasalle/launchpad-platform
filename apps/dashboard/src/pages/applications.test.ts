// DOM tests for the application list page: hostile payload data must render
// literally (never parse as HTML), missing sessions must fail closed, and
// malformed or failing control-plane responses must produce explicit error
// states — never fake data.

import { beforeEach, expect, it, vi } from 'vitest';
import { ApiClient } from '../api.js';
import { renderApplicationsPage } from './applications.js';
import type { PageContext } from '../router.js';
import { asFakeElement, findTags, installDomShim } from '../test/dom-shim.js';

function context(fetchImpl: typeof fetch, token: string | null = 'operator-token'): PageContext {
  return { client: new ApiClient({ token, fetchImpl }), reload: () => undefined, openSession: () => undefined };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => installDomShim());

it('renders hostile application data as literal text with no parsed elements', async () => {
  const hostile = {
    application: 'acme',
    displayName: '<img src=x onerror=alert(1)>',
    owner: '<b>team</b>',
    sync: '"><script>alert(1)</script>',
    health: 'HEALTHY',
    deployment: 'CURRENT',
    productionUrl: 'javascript:alert(1)',
    updatedAt: '2026-08-04T00:00:00.000Z',
  };
  const view = await renderApplicationsPage(context(async () => jsonResponse({ applications: [hostile] })));
  expect(view.element.textContent).toContain('<img src=x onerror=alert(1)>');
  expect(view.element.textContent).toContain('<b>team</b>');
  // The hostile sync value is not a known status, so it must be replaced by
  // UNKNOWN rather than echoed back.
  expect(view.element.textContent).not.toContain('<script>');
  expect(findTags(asFakeElement(view.element), 'IMG')).toHaveLength(0);
  expect(findTags(asFakeElement(view.element), 'SCRIPT')).toHaveLength(0);
  // The javascript: production URL must not become a clickable link.
  const externalLinks = findTags(asFakeElement(view.element), 'A').filter((anchor) => anchor.getAttribute('target') === '_blank');
  expect(externalLinks).toHaveLength(0);
});

it('shows an explicit empty state when the catalog is empty', async () => {
  const view = await renderApplicationsPage(context(async () => jsonResponse({ applications: [] })));
  expect(view.element.textContent).toContain('No applications registered');
  expect(findTags(asFakeElement(view.element), 'TABLE')).toHaveLength(0);
});

it('shows a concise error state with log links when the control plane fails', async () => {
  const view = await renderApplicationsPage(
    context(async () => {
      throw new TypeError('fetch failed');
    }),
  );
  expect(view.element.textContent).toContain('Control plane read failed');
  expect(view.element.textContent).toContain('Control plane unreachable.');
  expect(view.element.textContent).toContain('VIEW AUDIT LOG');
  expect(view.element.textContent).toContain('VIEW OPERATIONS');
});

it('fails closed with an authentication state when no session token is set', async () => {
  const fetchImpl = vi.fn(async () => jsonResponse({ applications: [] }));
  const view = await renderApplicationsPage(context(fetchImpl, null));
  expect(view.element.textContent).toContain('Authentication required');
  expect(fetchImpl).not.toHaveBeenCalled();
  const buttons = findTags(asFakeElement(view.element), 'BUTTON');
  expect(buttons.some((button) => button.textContent === 'OPEN SESSION')).toBe(true);
});

it('fails closed on malformed payloads instead of showing a fake empty state', async () => {
  const view = await renderApplicationsPage(context(async () => jsonResponse({ unexpected: true })));
  expect(view.element.textContent).toContain('malformed application list');
  expect(view.element.textContent).not.toContain('No applications registered');
});

it('renders real status values through separated dimensions', async () => {
  const applications = [
    { application: 'a', displayName: 'A', owner: 'o', sync: 'SYNCED', health: 'HEALTHY', deployment: 'CURRENT', productionUrl: 'example.com', updatedAt: '2026-08-04T00:00:00.000Z' },
    { application: 'b', displayName: 'B', owner: 'o', sync: 'OUT_OF_SYNC', health: 'UNHEALTHY', deployment: 'ERROR', productionUrl: null, updatedAt: '2026-08-04T00:00:00.000Z' },
  ];
  const view = await renderApplicationsPage(context(async () => jsonResponse({ applications })));
  expect(view.element.textContent).toContain('SYNCED');
  expect(view.element.textContent).toContain('OUT OF SYNC');
  expect(view.element.textContent).toContain('UNHEALTHY');
  expect(view.element.textContent).toContain('ERROR');
  const externalLinks = findTags(asFakeElement(view.element), 'A').filter((anchor) => anchor.getAttribute('target') === '_blank');
  expect(externalLinks).toHaveLength(1);
  expect(externalLinks[0]?.getAttribute('href')).toBe('https://example.com/');
  const tables = findTags(asFakeElement(view.element), 'TABLE');
  expect(tables).toHaveLength(1);
  expect(findTags(asFakeElement(tables[0]), 'TR').length).toBe(3); // header + two rows
});
