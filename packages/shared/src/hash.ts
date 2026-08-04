export type CanonicalPrimitive = string | number | boolean | null;

function canonicalize(value: unknown, path: string): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Value at ${path} must be finite`);
    return JSON.stringify(value);
  }
  if (typeof value === 'undefined') throw new TypeError(`Value at ${path} is undefined`);
  if (typeof value === 'bigint') throw new TypeError(`Value at ${path} is bigint`);
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`Value at ${path} is not serializable`);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError(`Value at ${path} is an invalid date`);
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalize(item, `${path}[${index}]`)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], `${path}.${key}`)}`).join(',')}}`;
  }
  throw new TypeError(`Value at ${path} is not serializable`);
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value, '$');
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
