import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  DEFAULT_OVERALL_TIMEOUT_MS,
  DnsResolverFailure,
  parseDnsQuery,
  resolveAuthoritative,
  type DnsQuery,
  type ResolverDependencies,
} from './resolver.js';

export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
export const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024;

export interface DnsHttpRequest {
  readonly method: string | undefined;
  readonly contentType: string | undefined;
  readonly body: string;
}

export interface DnsHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface DnsHttpOptions {
  readonly overallTimeoutMs?: number;
  readonly maxRequestBytes?: number;
}

export type DnsHttpAdapter = (request: DnsHttpRequest) => Promise<DnsHttpResponse>;

/**
 * Pure HTTP behavior for the `/api/dns` function: method gate, content-type
 * gate, bounded request body, exact request-shape validation, and safe error
 * mapping. Never logs request bodies or responses, and error payloads carry
 * only static codes and messages — never raw DNS or provider detail.
 */
export function createDnsHttpAdapter(dependencies: ResolverDependencies, options: DnsHttpOptions = {}): DnsHttpAdapter {
  const overallTimeoutMs = options.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS;
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  return async (request) => {
    if (request.method !== 'POST') {
      return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Only POST is accepted.', { allow: 'POST' });
    }
    if (typeof request.contentType !== 'string' || !request.contentType.toLowerCase().startsWith('application/json')) {
      return errorResponse(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
    }
    if (Buffer.byteLength(request.body, 'utf8') > maxRequestBytes) {
      return errorResponse(413, 'REQUEST_TOO_LARGE', 'Request body exceeds the size bound.');
    }
    let query: DnsQuery;
    try {
      query = parseDnsQuery(JSON.parse(request.body) as unknown);
    } catch (error) {
      if (error instanceof DnsResolverFailure) return errorResponse(400, error.code, 'Invalid request.');
      return errorResponse(400, 'INVALID_JSON', 'Request body must be valid JSON.');
    }
    try {
      const resolution = await resolveAuthoritative(query, dependencies, { overallTimeoutMs });
      return {
        status: 200,
        headers: { 'content-type': JSON_CONTENT_TYPE, 'cache-control': 'no-store' },
        body: JSON.stringify({ answers: resolution.answers, nameservers: resolution.nameservers }),
      };
    } catch (error) {
      return classifyResolutionError(error);
    }
  };
}

export interface DnsHttpHandler {
  (request: IncomingMessage, response: ServerResponse): void;
}

/**
 * Node HTTP adapter used by the Vercel function entrypoint. Reads the
 * bounded request body, runs the pure adapter, and writes the response.
 */
export function createDnsHttpHandler(dependencies: ResolverDependencies, options: DnsHttpOptions = {}): DnsHttpHandler {
  const adapter = createDnsHttpAdapter(dependencies, options);
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  return (request, response) => {
    readRequestBody(request, maxRequestBytes)
      .then((body) => adapter({ method: request.method, contentType: request.headers['content-type'], body }))
      .then((result) => {
        response.writeHead(result.status, result.headers);
        response.end(result.body);
      })
      .catch((error: unknown) => {
        const result = classifyResolutionError(error);
        response.writeHead(result.status, result.headers);
        response.end(result.body);
      });
  };
}

function errorResponse(status: number, code: string, message: string, extraHeaders: Readonly<Record<string, string>> = {}): DnsHttpResponse {
  return {
    status,
    headers: { 'content-type': JSON_CONTENT_TYPE, ...extraHeaders },
    body: JSON.stringify({ error: { code, message } }),
  };
}

function classifyResolutionError(error: unknown): DnsHttpResponse {
  if (error instanceof DnsResolverFailure) {
    switch (error.code) {
      case 'TIMEOUT':
        return errorResponse(504, error.code, 'The authoritative resolution timed out.');
      case 'NAMESERVER_LOOKUP_FAILED':
      case 'QUERY_FAILED':
      case 'RESPONSE_BOUND_EXCEEDED':
        return errorResponse(502, error.code, 'The authoritative resolution failed.');
      case 'INVALID_QUERY':
        return errorResponse(400, error.code, 'Invalid request.');
      case 'REQUEST_TOO_LARGE':
        return errorResponse(413, error.code, 'Request body exceeds the size bound.');
    }
  }
  return errorResponse(500, 'INTERNAL_ERROR', 'The request could not be processed.');
}

function readRequestBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        fail(new DnsResolverFailure('REQUEST_TOO_LARGE', 'Request body exceeds the size bound.'));
        // Drain and discard the remainder so the 413 response can still be delivered.
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', (error: Error) => fail(error));
  });
}
