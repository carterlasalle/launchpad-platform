// Asset-serving tests for the dashboard static assets: the Worker must serve
// HTML/CSS/JS with explicit content types, security headers and cache policy,
// serve exactly the assets the shell references, resolve every import in the
// served JavaScript bundle, and fail closed with JSON 404s for anything else.

import { expect, it } from 'vitest';
import { InMemoryLaunchpadStore } from '@launchpad/database';
import { createControllerApp } from './api.js';
import {
  dashboardAssetResponse,
  dashboardCssContentType,
  dashboardHtmlContentType,
  dashboardJsContentType,
  type DashboardAsset,
} from './dashboard.js';

const shellHtml =
  '<!doctype html><html lang="en"><head><link rel="stylesheet" href="/styles.css"><script type="module" src="/app.js"></script></head><body></body></html>';

function assetMap(html: string, modules: Record<string, string> = {}): Record<string, DashboardAsset> {
  const assets: Record<string, DashboardAsset> = {
    '/': { contentType: dashboardHtmlContentType, content: html },
    '/styles.css': { contentType: dashboardCssContentType, content: 'body { color: #fff; }' },
    '/app.js': { contentType: dashboardJsContentType, content: modules['/app.js'] ?? 'console.log("launchpad");' },
  };
  for (const [path, content] of Object.entries(modules)) {
    if (path !== '/app.js') assets[path] = { contentType: dashboardJsContentType, content };
  }
  return assets;
}

it('serves the dashboard shell and static assets with explicit content types', async () => {
  const app = createControllerApp({ operatorToken: 'operator-token', dashboardAssets: assetMap(shellHtml) });
  const html = await app.request('/');
  expect(html.status).toBe(200);
  expect(html.headers.get('content-type')).toBe(dashboardHtmlContentType);
  const styles = await app.request('/styles.css');
  expect(styles.status).toBe(200);
  expect(styles.headers.get('content-type')).toBe(dashboardCssContentType);
  const script = await app.request('/app.js');
  expect(script.status).toBe(200);
  expect(script.headers.get('content-type')).toBe(dashboardJsContentType);
});

it('serves deployed dashboard assets through the Worker ASSETS binding', async () => {
  const requestedPaths: string[] = [];
  const assets = {
    fetch: async (url: string): Promise<Response> => {
      requestedPaths.push(new URL(url).pathname);
      return new Response(shellHtml, { headers: { 'content-type': dashboardHtmlContentType } });
    },
  };
  const app = createControllerApp({ operatorToken: 'operator-token' });
  const response = await app.request('/', {}, { ASSETS: assets } as never);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(shellHtml);
  expect(requestedPaths).toEqual(['/']);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
});

it('applies security headers and cache policy to every dashboard asset', async () => {
  const app = createControllerApp({ operatorToken: 'operator-token', dashboardAssets: assetMap(shellHtml) });
  const html = await app.request('/');
  const styles = await app.request('/styles.css');
  const script = await app.request('/app.js');
  const responses = [html, styles, script];
  for (const response of responses) {
    for (const header of [
      'content-security-policy',
      'x-content-type-options',
      'referrer-policy',
      'x-frame-options',
      'permissions-policy',
      'cross-origin-opener-policy',
      'cross-origin-resource-policy',
    ]) {
      expect(response.headers.get(header), `${header} missing from ${response.url}`).toBeTruthy();
    }
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  }
  expect(html.headers.get('cache-control')).toBe('no-store');
  expect(styles.headers.get('cache-control')).toContain('max-age');
  expect(script.headers.get('cache-control')).toContain('max-age');
});

it('serves only assets the dashboard shell references', () => {
  const assets = assetMap(shellHtml);
  for (const match of shellHtml.matchAll(/(?:href|src)="(\/[^"]+)"/g)) {
    const path = match[1] ?? '';
    expect(dashboardAssetResponse(path, assets), `shell references ${path}`).not.toBeNull();
  }
});

it('serves every module imported by the served JavaScript bundle', () => {
  const modules: Record<string, string> = {
    '/app.js': 'import "./dom.js"; import "./pages/applications.js"; console.log("launchpad");',
    '/dom.js': 'export {};',
    '/pages/applications.js': 'import "../dom.js"; export {};',
  };
  const assets = assetMap(shellHtml, modules);
  for (const [path, asset] of Object.entries(assets)) {
    if (!path.endsWith('.js')) continue;
    for (const specifier of relativeImports(asset.content)) {
      const resolved = resolveSpecifier(path, specifier);
      expect(assets[resolved], `${path} imports ${specifier} -> ${resolved}`).toBeDefined();
    }
  }
});

it('fails closed with a typed JSON 404 for unknown dashboard asset paths', async () => {
  const app = createControllerApp({ operatorToken: 'operator-token', dashboardAssets: assetMap(shellHtml) });
  const response = await app.request('/missing.js');
  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toMatchObject({ error: { code: 'LP-NOT-FOUND', retryable: false } });
  expect(dashboardAssetResponse('/missing.js', assetMap(shellHtml))).toBeNull();
});

it('keeps protected dashboard API routes behind operator authentication', async () => {
  const app = createControllerApp({ operatorToken: 'operator-token', store: new InMemoryLaunchpadStore(), dashboardAssets: assetMap(shellHtml) });
  const unauthorized = await app.request('/v1/applications');
  expect(unauthorized.status).toBe(401);
  const authorized = await app.request('/v1/applications', { headers: { authorization: 'Bearer operator-token' } });
  expect(authorized.status).toBe(200);
  await expect(authorized.json()).resolves.toMatchObject({ applications: [] });
});

function relativeImports(source: string): string[] {
  const imports: string[] = [];
  const pattern = /(?:from|import)\s*["'](\.[^"']+\.js)["']/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier !== undefined) imports.push(specifier);
  }
  return imports;
}

function resolveSpecifier(fromPath: string, specifier: string): string {
  const base = fromPath.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') base.pop();
    else base.push(part);
  }
  return base.join('/');
}
