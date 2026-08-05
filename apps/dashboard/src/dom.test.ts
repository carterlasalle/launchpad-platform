import { beforeEach, expect, it } from 'vitest';
import { append, el, setText, stateElement, statusBadge } from './dom.js';
import { asFakeElement, findTags, innerHTMLWrites, installDomShim } from './test/dom-shim.js';
import { externalLink, safeExternalUrl } from './urls.js';

beforeEach(() => installDomShim());

it('renders untrusted strings as literal text and never parses them as HTML', () => {
  const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const container = el('div');
  const title = el('h1');
  setText(title, hostile);
  append(container, title, stateElement({ kind: 'empty', title: hostile, message: hostile }));
  expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  expect(container.textContent).toContain('<script>alert(2)</script>');
  expect(findTags(asFakeElement(container), 'IMG')).toHaveLength(0);
  expect(findTags(asFakeElement(container), 'SCRIPT')).toHaveLength(0);
});

it('never assigns innerHTML while rendering data-driven views', () => {
  const container = el('div');
  append(
    container,
    statusBadge('sync', 'SYNCED'),
    statusBadge('health', '<img src=x onerror=alert(1)>'),
    stateElement({ kind: 'error', title: 'boom', message: '<script>alert(1)</script>', actions: [statusBadge('operation', 'FAILED')] }),
  );
  expect(innerHTMLWrites).toHaveLength(0);
});

it('classifies hostile status values as UNKNOWN and keeps them out of class names', () => {
  const hostile = '"><img src=x onerror=alert(1)>';
  const badge = asFakeElement(statusBadge('sync', hostile));
  expect(badge.textContent).toBe('UNKNOWN');
  expect(badge.className).not.toContain('"><');
  expect(badge.className).toContain('status-badge--neutral');
  expect(findTags(badge, 'IMG')).toHaveLength(0);
});

it('accepts only validated https external URLs', () => {
  expect(safeExternalUrl('https://example.com/path?q=1')).toBe('https://example.com/path?q=1');
  expect(safeExternalUrl('example.com')).toBe('https://example.com/');
  expect(safeExternalUrl('https://sub.example.com:8443/x')).toBe('https://sub.example.com:8443/x');
  expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
  expect(safeExternalUrl('data:text/html,<script>1</script>')).toBeNull();
  expect(safeExternalUrl('http://evil.example/x')).toBeNull();
  expect(safeExternalUrl('https://user:pass@example.com/')).toBeNull();
  expect(safeExternalUrl('')).toBeNull();
  expect(safeExternalUrl(null)).toBeNull();
  expect(safeExternalUrl(undefined)).toBeNull();
  expect(safeExternalUrl('http://localhost:8787/')).toBeNull();
  expect(safeExternalUrl('http://localhost:8787/', { allowHttp: true })).toBe('http://localhost:8787/');
  expect(safeExternalUrl('http://127.0.0.1:8787/', { allowHttp: true })).toBe('http://127.0.0.1:8787/');
});

it('renders invalid URLs as inert text, never as clickable links', () => {
  const invalid = asFakeElement(externalLink('javascript:alert(1)'));
  expect(invalid.tagName).toBe('SPAN');
  expect(invalid.getAttribute('href')).toBeNull();
  const schemeLess = asFakeElement(externalLink('example.com'));
  expect(schemeLess.tagName).toBe('A');
  expect(schemeLess.getAttribute('href')).toBe('https://example.com/');
  const safe = asFakeElement(externalLink('https://example.com/x', 'prod'));
  expect(safe.tagName).toBe('A');
  expect(safe.getAttribute('href')).toBe('https://example.com/x');
  expect(safe.getAttribute('rel')).toBe('noopener noreferrer');
  expect(safe.getAttribute('target')).toBe('_blank');
  expect(safe.textContent).toBe('prod');
});
