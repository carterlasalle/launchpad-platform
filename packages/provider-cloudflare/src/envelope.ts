import { ProviderRequestError } from '@launchpad/provider-contract';

export interface CloudflareZone {
  id: string;
  name: string;
  name_servers?: string[];
  status?: string;
}
export interface CloudflareDnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  proxied: boolean;
  comment: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function malformed(message: string): ProviderRequestError {
  return new ProviderRequestError({ code: 'LP-CLOUDFLARE-MALFORMED-RESPONSE', class: 'MALFORMED_PROVIDER_RESPONSE', provider: 'cloudflare', message: `Cloudflare returned a malformed response: ${message}.`, retryable: false });
}

/**
 * Cloudflare API error codes mapped to typed classes. Unknown codes fail closed
 * as non-retryable INTERNAL errors rather than guessing.
 */
function classForErrorCode(code: number): { class: ProviderRequestError['class']; retryable: boolean } {
  if (code === 9103 || code === 9104 || code === 9106 || code === 9107 || code === 9109) return { class: 'AUTHENTICATION', retryable: false };
  if (code === 9111) return { class: 'AUTHORIZATION', retryable: false };
  if (code === 9100 || code === 9101 || code === 9102 || code === 1003 || code === 1004 || code === 1005 || code === 81044) return { class: 'NOT_FOUND', retryable: false };
  if (code === 1001) return { class: 'RATE_LIMITED', retryable: true };
  if (code === 9105 || code === 1006) return { class: 'VALIDATION', retryable: false };
  return { class: 'INTERNAL', retryable: false };
}

/**
 * Strictly parses a Cloudflare API envelope. Any shape violation fails closed
 * with a typed MALFORMED_PROVIDER_RESPONSE error; `success: false` envelopes
 * are translated into typed errors carrying only numeric error codes (raw
 * provider bodies and messages are never exposed).
 */
export function parseEnvelope<T>(body: unknown): T | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw malformed('envelope must be a JSON object');
  const envelope = body as Record<string, unknown>;
  if (typeof envelope.success !== 'boolean') throw malformed('envelope is missing a boolean success field');
  if (!envelope.success) {
    const codes = Array.isArray(envelope.errors)
      ? envelope.errors.map((entry) => record(entry).code).filter((code): code is number => typeof code === 'number')
      : [];
    const code = codes[0];
    if (code === undefined) {
      throw new ProviderRequestError({ code: 'LP-CLOUDFLARE-API-UNKNOWN', class: 'INTERNAL', provider: 'cloudflare', message: 'Cloudflare API request failed without a typed error code.', retryable: false });
    }
    const { class: cls, retryable } = classForErrorCode(code);
    throw new ProviderRequestError({ code: `LP-CLOUDFLARE-API-${code}`, class: cls, provider: 'cloudflare', message: `Cloudflare API request failed (error ${code}).`, retryable, safeDetails: { codes } });
  }
  if (!('result' in envelope)) throw malformed('successful envelope is missing its result field');
  return envelope.result as T | null;
}

export function parseZoneList(result: unknown): CloudflareZone[] {
  if (!Array.isArray(result)) throw malformed('zone list must be an array');
  return result.map(parseZone);
}

export function parseZone(value: unknown): CloudflareZone {
  const data = record(value);
  if (typeof data.id !== 'string' || data.id.length === 0 || typeof data.name !== 'string' || data.name.length === 0) throw malformed('zone result is missing its id or name');
  if (data.name_servers !== undefined && (!Array.isArray(data.name_servers) || data.name_servers.some((entry) => typeof entry !== 'string'))) throw malformed('zone result has an invalid name_servers field');
  if (data.status !== undefined && typeof data.status !== 'string') throw malformed('zone result has an invalid status field');
  const zone: CloudflareZone = { id: data.id, name: data.name };
  if (data.name_servers !== undefined) zone.name_servers = data.name_servers as string[];
  if (data.status !== undefined) zone.status = data.status;
  return zone;
}

export function parseDnsRecord(value: unknown): CloudflareDnsRecord {
  const data = record(value);
  if (typeof data.id !== 'string' || data.id.length === 0) throw malformed('DNS record result is missing its id');
  if (typeof data.name !== 'string' || data.name.length === 0) throw malformed('DNS record result is missing its name');
  if (typeof data.type !== 'string' || data.type.length === 0) throw malformed('DNS record result is missing its type');
  if (typeof data.content !== 'string') throw malformed('DNS record result is missing its content');
  if (typeof data.ttl !== 'number' || !Number.isInteger(data.ttl) || data.ttl < 1) throw malformed('DNS record result has an invalid ttl');
  if (data.proxied !== undefined && typeof data.proxied !== 'boolean') throw malformed('DNS record result has an invalid proxied field');
  if (data.comment !== undefined && data.comment !== null && typeof data.comment !== 'string') throw malformed('DNS record result has an invalid comment field');
  return { id: data.id, name: data.name, type: data.type, content: data.content, ttl: data.ttl, proxied: data.proxied === true, comment: typeof data.comment === 'string' ? data.comment : null };
}
