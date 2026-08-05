import { readFileSync } from 'node:fs';

/**
 * Recorded request/response transport for the provider contract suites.
 * Fixture files under tests/fixtures/provider/ hold named scenarios; each
 * scenario is an ordered list of recorded steps (request expectations and the
 * response to replay). The transport replays steps in order, records every
 * actual request for later assertions, and fails loudly on any request that
 * matches no remaining step — so a changed request path or body surface is
 * never silently accepted.
 */

/** Bounded secret canaries embedded in recorded fixtures; tests assert they never leak into errors, logs, or redacted output. */
export const CONTRACT_CANARY_TOKEN = 'lp-contract-canary-token-7f3c9d1e';
export const CONTRACT_CANARY_BODY = 'lp-contract-canary-body-9b2a4f6c';

export interface RecordedRequest {
  method: string;
  /** Full URL including base URL. */
  url: string;
  /** Pathname + search, e.g. `/repos/acme/app?ref=main`. */
  path: string;
  headers: Record<string, string>;
  /** Parsed JSON request body, or undefined when the request had no body. */
  body: unknown;
}

export interface RecordedStep {
  request: {
    method: string;
    /** Exact `pathname + search` match; `*` acts as a wildcard segment. */
    path: string;
  };
  response: {
    status: number;
    /** JSON body to replay. */
    body?: unknown;
    /** Raw text body (served verbatim) when `body` is absent. */
    raw?: string;
    /** Extra response headers (used by proxy-compatibility probes). */
    headers?: Record<string, string>;
  };
  /** When true, the step keeps replaying for every matching request instead of being consumed once. */
  repeat?: boolean;
}

export type ScenarioSet = Record<string, RecordedStep[]>;

/** Loads the named scenario file for a provider (github | vercel | cloudflare). */
export function loadScenarios(provider: 'github' | 'vercel' | 'cloudflare'): ScenarioSet {
  const url = new URL(`./provider/${provider}-scenarios.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as ScenarioSet;
}

/**
 * Loads the shared error scenario fixtures (errors.json). Each entry is a
 * response shape (`{ status, body }`) or a raw body string (malformed);
 * entries are normalized into single-step scenarios whose request is a
 * wildcard so tests can mount them onto any operation.
 */
export function loadErrorScenarios(): ScenarioSet {
  const url = new URL('./provider/errors.json', import.meta.url);
  const parsed = JSON.parse(readFileSync(url, 'utf8')) as Record<string, unknown>;
  const scenarios: ScenarioSet = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === 'string') {
      scenarios[name] = [{ request: { method: 'GET', path: '*' }, response: { status: 200, raw: value } }];
    } else if (value !== null && typeof value === 'object' && 'status' in value) {
      const { status, body } = value as { status: number; body?: unknown };
      scenarios[name] = [{ request: { method: 'GET', path: '*' }, response: { status, ...(body !== undefined ? { body } : {}) } }];
    }
  }
  return scenarios;
}

function matchesPath(step: string, actual: string): boolean {
  if (step === actual) return true;
  const pattern = step.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${pattern}$`).test(actual);
}

export interface RecordedTransport {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
}

/**
 * Builds a fetch implementation that replays the given recorded steps. Steps
 * are consumed in order; `repeat` steps are never consumed. A request that
 * matches no remaining step throws, making unexpected request surfaces fail
 * the test.
 */
export function recordedTransport(steps: RecordedStep[]): RecordedTransport {
  const requests: RecordedRequest[] = [];
  const remaining = steps.map((step, index) => ({ step, index }));
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    const headers: Record<string, string> = {};
    for (const [key, value] of new Headers(init?.headers).entries()) headers[key] = value;
    let body: unknown;
    if (init?.body !== undefined && typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body) as unknown;
      } catch {
        body = init.body;
      }
    }
    const method = init?.method ?? 'GET';
    requests.push({ method, url, path, headers, body });
    const matchIndex = remaining.findIndex((entry) => {
      const { step } = entry;
      return step.request.method === method && matchesPath(step.request.path, path) && (!step.repeat || remaining[0] === entry);
    });
    if (matchIndex === -1) {
      const replayable = remaining.map(({ step }) => `${step.request.method} ${step.request.path}`).join(', ');
      throw new Error(`Unexpected provider request: ${method} ${path} (remaining steps: ${replayable || 'none'})`);
    }
    const { step } = remaining[matchIndex]!;
    if (!step.repeat) remaining.splice(matchIndex, 1);
    const response = step.response;
    if (response.raw !== undefined) return new Response(response.raw, { status: response.status, headers: { 'content-type': 'application/json', ...response.headers } });
    const text = response.body === undefined ? '' : JSON.stringify(response.body);
    return new Response(text, { status: response.status, headers: { 'content-type': 'application/json', ...response.headers } });
  };
  return { fetchImpl, requests };
}

/** Asserts a recorded request exists with the given method/path and returns it. */
export function expectRequest(requests: RecordedRequest[], method: string, path: string): RecordedRequest {
  const found = requests.find((request) => request.method === method && request.path === path);
  if (!found) {
    const seen = requests.map((request) => `${request.method} ${request.path}`).join(', ');
    throw new Error(`Expected request ${method} ${path} was not recorded (seen: ${seen || 'none'})`);
  }
  return found;
}
