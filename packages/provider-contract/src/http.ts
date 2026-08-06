import { ProviderRequestError } from './errors.js';
import type { ProviderName } from '@launchpad/core';

export interface ProviderHttpClientOptions { baseUrl: string; token?: string | undefined; provider: ProviderName; fetchImpl?: typeof fetch | undefined; timeoutMs?: number | undefined; }

export class ProviderHttpClient {
  readonly baseUrl: string;
  readonly token: string | undefined;
  readonly provider: ProviderName;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;

  constructor(options: ProviderHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.provider = options.provider;
    // Workerd's global fetch is this-sensitive; storing it in a property and
    // calling `this.fetchImpl(...)` throws "Illegal invocation". The arrow
    // wrapper preserves a bare call so the default path always works.
    this.fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 30_000;
    // CR/LF can never be legitimate token characters; a paste artifact with
    // embedded newlines would otherwise throw TypeError on Headers.set and
    // surface as a misleading provider NETWORK failure.
    this.token = options.token === undefined ? undefined : options.token.replace(/[\r\n]+/g, '').trim();
  }

  async request<T>(path: string, init: RequestInit & { correlationId?: string; idempotencyKey?: string } = {}): Promise<T> {
    if (!this.token) throw new ProviderRequestError({ code: `LP-${this.provider.toUpperCase()}-AUTH-MISSING`, class: 'AUTHENTICATION', provider: this.provider, message: `${this.provider} provider token is not configured.`, retryable: false });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${this.token}`);
    headers.set('accept', 'application/json');
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    if (init.correlationId) headers.set('x-launchpad-correlation-id', init.correlationId);
    if (init.idempotencyKey) headers.set('idempotency-key', init.idempotencyKey);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers, signal: controller.signal });
      const text = await response.text();
      let body: unknown = null;
      if (text.length > 0) {
        try { body = JSON.parse(text) as unknown; } catch { throw new ProviderRequestError({ code: `LP-${this.provider.toUpperCase()}-MALFORMED-RESPONSE`, class: 'MALFORMED_PROVIDER_RESPONSE', provider: this.provider, message: 'Provider returned invalid JSON.', status: response.status, retryable: false }); }
      }
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        const errorClass: ProviderRequestError['class'] = response.status === 401 ? 'AUTHENTICATION' : response.status === 403 ? 'AUTHORIZATION' : response.status === 404 ? 'NOT_FOUND' : response.status === 409 || response.status === 422 ? 'CONFLICT' : response.status === 429 ? 'RATE_LIMITED' : retryable ? 'TRANSIENT_PROVIDER' : 'INTERNAL';
        // Raw provider bodies never enter error details: they are persisted
        // into provider_errors.safe_details_json and surfaced in logs, and
        // providers may echo secret values back in error responses.
        throw new ProviderRequestError({ code: `LP-${this.provider.toUpperCase()}-HTTP-${response.status}`, class: errorClass, provider: this.provider, message: `Provider request failed with HTTP ${response.status}.`, status: response.status, retryable, safeDetails: { status: response.status } });
      }
      return body as T;
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') throw new ProviderRequestError({ code: `LP-${this.provider.toUpperCase()}-TIMEOUT`, class: 'TIMEOUT', provider: this.provider, message: 'Provider request timed out.', retryable: true });
      const cause = error instanceof Error ? error.name : 'unknown';
      const detail = error instanceof Error ? error.message : 'unknown';
      throw new ProviderRequestError({ code: `LP-${this.provider.toUpperCase()}-NETWORK`, class: 'TRANSIENT_PROVIDER', provider: this.provider, message: `Provider request failed before a response was received (cause: ${cause}: ${detail.slice(0, 300)}).`, retryable: true, safeDetails: { cause, detail: detail.slice(0, 300) } });
    } finally {
      clearTimeout(timeout);
    }
  }
}
