import { expect, it } from 'vitest';
import { defineRoute, matchRoute, parseHash } from './router.js';
import type { PageView } from './router.js';

const never = async (): Promise<PageView> => ({ title: 'never', element: document.createElement('div') });

const routes = [
  defineRoute('/', 'applications', never),
  defineRoute('/applications/:id', 'application', never),
  defineRoute('/applications/:id/resources', 'resources', never),
  defineRoute('/applications/:id/workflows/:operationId', 'workflow', never),
  defineRoute('/operations', 'operations', never),
];

it('parses hash paths', () => {
  expect(parseHash('#/applications/acme')).toBe('/applications/acme');
  expect(parseHash('#/')).toBe('/');
  expect(parseHash('')).toBe('/');
  expect(parseHash('#')).toBe('/');
});

it('matches routes and decodes parameters', () => {
  const match = matchRoute('/applications/acme%20inc/resources', routes);
  expect(match?.route.name).toBe('resources');
  expect(match?.params).toEqual({ id: 'acme inc' });
});

it('matches nested workflow routes with two parameters', () => {
  const match = matchRoute('/applications/acme/workflows/op-123', routes);
  expect(match?.route.name).toBe('workflow');
  expect(match?.params).toEqual({ id: 'acme', operationId: 'op-123' });
});

it('rejects malformed percent-encoding instead of matching', () => {
  expect(matchRoute('/applications/%E0%A4%A', routes)).toBeNull();
});

it('returns null for unknown routes', () => {
  expect(matchRoute('/applications/a/missing', routes)).toBeNull();
  expect(matchRoute('/nope', routes)).toBeNull();
  expect(matchRoute('/applications/a/resources/extra', routes)).toBeNull();
});

it('never matches a parameter route when a segment is missing', () => {
  expect(matchRoute('/applications', routes)).toBeNull();
  expect(matchRoute('/operations/x', routes)).toBeNull();
});
