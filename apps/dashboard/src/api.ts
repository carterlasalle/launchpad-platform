// Authenticated API client for the control-plane dashboard routes.
//
// The client FAILS CLOSED: without a session token every request throws
// UnauthenticatedError before any network call is made. Server errors are
// surfaced as concise ApiError messages (NFR-UX-004) — the raw body is never
// rendered, only a trimmed `error` field when the control plane supplies one.

export type ApiErrorCode = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'SERVER' | 'CLIENT' | 'NETWORK' | 'TIMEOUT' | 'INVALID_RESPONSE';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number | null;

  constructor(code: ApiErrorCode, message: string, status: number | null = null, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export class UnauthenticatedError extends ApiError {
  constructor(message = 'operator authentication required') {
    super('UNAUTHENTICATED', message, 401);
    this.name = 'UnauthenticatedError';
  }
}

export interface ApiClientOptions {
  token: string | null;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onUnauthorized?: () => void;
}

const MAX_ERROR_MESSAGE_LENGTH = 160;
const MAX_ERROR_BODY_LENGTH = 4096;

function conciseMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.length <= MAX_ERROR_MESSAGE_LENGTH ? trimmed : `${trimmed.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`;
}

function errorCodeForStatus(status: number): ApiErrorCode {
  if (status === 404) return 'NOT_FOUND';
  if (status >= 500) return 'SERVER';
  return 'CLIENT';
}

// Reads a concise `error` field from a JSON error body; falls back to the raw
// (truncated) text when the body is not JSON. Never exposes secrets: the
// control plane's error convention is a single `error` string.
async function errorMessageFrom(response: Response): Promise<string | null> {
  const text = await response.text().catch(() => null);
  if (text === null || text === '') return null;
  const trimmed = text.slice(0, MAX_ERROR_BODY_LENGTH);
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const fromField = conciseMessage((parsed as Record<string, unknown>).error);
      if (fromField !== null) return fromField;
    }
  } catch {
    // Not JSON — fall through to the raw truncated text.
  }
  return conciseMessage(trimmed);
}

interface RequestOptions {
  method: 'GET' | 'POST';
  body?: unknown;
  idempotencyKey?: string;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly onUnauthorized: (() => void) | null;
  private tokenValue: string | null;

  constructor(options: ApiClientOptions) {
    this.tokenValue = options.token;
    this.baseUrl = options.baseUrl ?? '';
    this.fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.onUnauthorized = options.onUnauthorized ?? null;
  }

  get token(): string | null {
    return this.tokenValue;
  }

  setToken(token: string | null): void {
    this.tokenValue = token;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'GET' });
  }

  async post<T>(path: string, body: unknown, idempotencyKey?: string): Promise<T> {
    const options: RequestOptions = { method: 'POST', body };
    if (idempotencyKey !== undefined) options.idempotencyKey = idempotencyKey;
    return this.request<T>(path, options);
  }

  private async request<T>(path: string, options: RequestOptions): Promise<T> {
    if (!this.tokenValue) {
      throw new UnauthenticatedError('no operator session token; protected control-plane reads fail closed until a session is saved');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        accept: 'application/json',
        authorization: `Bearer ${this.tokenValue}`,
      };
      const init: RequestInit = { method: options.method, headers, signal: controller.signal };
      if (options.body !== undefined) {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(options.body);
        if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;
      }
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
      } catch (error) {
        if (controller.signal.aborted) throw new ApiError('TIMEOUT', `Control plane request timed out after ${this.timeoutMs}ms.`, null, error);
        throw new ApiError('NETWORK', 'Control plane unreachable.', null, error);
      }
      if (response.status === 401) {
        this.onUnauthorized?.();
        throw new UnauthenticatedError('operator authentication rejected by the control plane');
      }
      if (response.status === 403) {
        this.onUnauthorized?.();
        throw new ApiError('FORBIDDEN', 'The operator session is not authorized for this control-plane resource.', 403);
      }
      if (!response.ok) {
        const message = await errorMessageFrom(response);
        throw new ApiError(errorCodeForStatus(response.status), message ?? `Control plane returned HTTP ${response.status}.`, response.status);
      }
      const text = await response.text().catch(() => null);
      if (text === null) throw new ApiError('NETWORK', 'Control plane response could not be read.', response.status);
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new ApiError('INVALID_RESPONSE', 'Control plane returned a non-JSON response.', response.status);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Validates that `payload` carries an array under `field`. Malformed payloads
 * throw INVALID_RESPONSE — they are never silently treated as empty data.
 */
export function requireArrayField(payload: unknown, field: string, description: string): unknown[] {
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    const value = (payload as Record<string, unknown>)[field];
    if (Array.isArray(value)) return value;
  }
  throw new ApiError('INVALID_RESPONSE', `Control plane returned a malformed ${description}.`);
}
