// Static-asset response policy for the dashboard SPA.
//
// Production assets are deployed through Wrangler's `ASSETS` binding from
// apps/dashboard/dist. The controller remains first in the request path so
// it can add the same security and cache headers used by injected test assets.
// The dashboard uses hash routing; unknown server paths remain typed 404s.

export interface DashboardAsset {
  contentType: string;
  content: string;
}

export const dashboardHtmlContentType = 'text/html; charset=utf-8';
export const dashboardCssContentType = 'text/css; charset=utf-8';
export const dashboardJsContentType = 'text/javascript; charset=utf-8';

export const dashboardSecurityHeaders: Readonly<Record<string, string>> = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

const HTML_CACHE_CONTROL = 'no-store';
const STATIC_CACHE_CONTROL = 'public, max-age=300';

export function dashboardAssetResponse(path: string, assets: Record<string, DashboardAsset>): Response | null {
  const asset = assets[path];
  if (asset === undefined) return null;
  const cacheControl = asset.contentType === dashboardHtmlContentType ? HTML_CACHE_CONTROL : STATIC_CACHE_CONTROL;
  return new Response(asset.content, {
    headers: { 'content-type': asset.contentType, 'cache-control': cacheControl, ...dashboardSecurityHeaders },
  });
}

export interface DashboardAssetFetcher {
  fetch(input: string): Promise<Response>;
}

export async function dashboardAssetBindingResponse(url: string, fetcher: DashboardAssetFetcher): Promise<Response | null> {
  const response = await fetcher.fetch(url);
  if (response.status === 404) return null;
  const headers = new Headers(response.headers);
  const contentType = headers.get('content-type')?.toLowerCase() ?? '';
  headers.set('cache-control', contentType.startsWith('text/html') ? HTML_CACHE_CONTROL : STATIC_CACHE_CONTROL);
  for (const [name, value] of Object.entries(dashboardSecurityHeaders)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
