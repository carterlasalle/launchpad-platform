/**
 * Recorded provider transport for integration tests: a fetch implementation
 * that records every request and answers from scripted, offline routes. The
 * provider adapters (GitHubAdapter/VercelAdapter/CloudflareAdapter), the
 * controller's own GitHub calls, OIDC JWKS lookups, and health probes all run
 * through one `RecordedTransport`, so tests can assert the EXACT request
 * sequence a flow makes (exact commits, no duplicate writes, no canary) while
 * staying fully deterministic and offline.
 */
export interface TransportRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyText: string | null;
  /** Parsed JSON body when the request carried JSON, otherwise null. */
  body: unknown;
}

export type TransportResponse = Response | { status?: number; body?: unknown; headers?: Record<string, string> } | { throw: unknown };

export interface TransportRouteContext {
  method: string;
  url: URL;
  headers: Record<string, string>;
  bodyText: string | null;
  body: unknown;
}

export type TransportRespond = (request: TransportRouteContext) => TransportResponse | Promise<TransportResponse>;

export interface TransportRoute {
  name: string;
  match: (method: string, url: URL) => boolean;
  respond: TransportRespond;
}

function toResponse(result: TransportResponse): Response {
  if (result instanceof Response) return result;
  if ('throw' in result) throw result.throw;
  const status = result.status ?? 200;
  const body = result.body === undefined ? null : typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
  return new Response(body, { status, headers: { 'content-type': 'application/json', ...(result.headers ?? {}) } });
}

export class RecordedTransport {
  readonly requests: TransportRequest[] = [];
  private readonly routes: TransportRoute[] = [];
  private unhandledResponses: Response[] = [];

  /** Mounts a named route; the first matching route answers each request. */
  route(name: string, match: (method: string, url: URL) => boolean, respond: TransportRespond): this {
    this.routes.push({ name, match, respond });
    return this;
  }

  /** Convenience: mounts a route matching method + URL substring. */
  routeUrl(name: string, method: string, urlIncludes: string, respond: TransportRespond): this {
    return this.route(name, (candidateMethod, url) => candidateMethod === method && url.href.includes(urlIncludes), respond);
  }

  /** Scripts a canned JSON response for any request matching method + URL substring. */
  scriptJson(method: string, urlIncludes: string, body: unknown, status = 200): this {
    return this.routeUrl(`script:${method} ${urlIncludes}`, method, urlIncludes, () => ({ status, body }));
  }

  /** Scripts a canned non-JSON response body (for health probes). */
  scriptText(method: string, urlIncludes: string, text: string, status = 200, headers: Record<string, string> = {}): this {
    return this.routeUrl(`script:${method} ${urlIncludes}`, method, urlIncludes, () => ({ status, body: text, headers: { 'content-type': 'text/plain', ...headers } }));
  }

  /** Any request that matched no route answers with this canned failure. */
  onUnhandled(status = 500, body: unknown = { error: 'unhandled request in recorded transport' }): void {
    this.unhandledResponses = [new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })];
  }

  get fetchImpl(): typeof fetch {
    const transport = this;
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? (typeof input === 'object' && input !== null && 'method' in input ? (input as Request).method : undefined) ?? 'GET').toUpperCase();
      const headers: Record<string, string> = {};
      const headerSource = init?.headers ?? (typeof input === 'object' && input !== null && 'headers' in input ? (input as Request).headers : undefined);
      if (headerSource) {
        new Headers(headerSource as HeadersInit).forEach((value, key) => { headers[key] = value; });
      }
      const bodyText = init?.body !== undefined ? String(init.body) : (typeof input === 'object' && input !== null && 'body' in input && (input as Request).body !== null ? await (input as Request).text() : null);
      let body: unknown = null;
      if (bodyText !== null && bodyText.length > 0) {
        try { body = JSON.parse(bodyText) as unknown; } catch { body = bodyText; }
      }
      const recorded: TransportRequest = { method, url: requestUrl, headers, bodyText, body };
      transport.requests.push(recorded);
      const url = new URL(requestUrl);
      for (const route of transport.routes) {
        if (route.match(method, url)) {
          return toResponse(await route.respond({ method, url, headers, bodyText, body }));
        }
      }
      const fallback = transport.unhandledResponses[0] ?? new Response(JSON.stringify({ error: `no recorded route for ${method} ${requestUrl}` }), { status: 500, headers: { 'content-type': 'application/json' } });
      return fallback.clone();
    };
  }

  // --- assertions ----------------------------------------------------------

  count(method: string, urlIncludes: string): number {
    return this.requests.filter((request) => request.method === method && request.url.includes(urlIncludes)).length;
  }

  requestsFor(method: string, urlIncludes: string): TransportRequest[] {
    return this.requests.filter((request) => request.method === method && request.url.includes(urlIncludes));
  }

  jsonBodies(method: string, urlIncludes: string): unknown[] {
    return this.requestsFor(method, urlIncludes).map((request) => request.body);
  }

  /** Concatenated raw bodies of every recorded request (for secret/canary scans). */
  allBodies(): string {
    return this.requests.map((request) => `${request.method} ${request.url} ${request.bodyText ?? ''}`).join('\n');
  }
}

export function jsonBody(request: TransportRouteContext): Record<string, unknown> {
  return typeof request.body === 'object' && request.body !== null && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {};
}
