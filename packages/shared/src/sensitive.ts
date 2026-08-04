import { sha256Hex } from './hash.js';

const sensitiveMarker = Symbol('launchpad.sensitive');

export class SensitiveValue<T> {
  readonly [sensitiveMarker] = true;
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  reveal(): T {
    return this.#value;
  }

  fingerprint(): string {
    const text = typeof this.#value === 'string' ? this.#value : JSON.stringify(this.#value);
    let hash = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(text ?? '')) {
      hash ^= BigInt(byte);
      hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return hash.toString(16).padStart(16, '0');
  }

  redacted(): '[REDACTED]' {
    return '[REDACTED]';
  }

  toJSON(): never {
    throw new TypeError('SensitiveValue cannot be serialized without explicit redaction');
  }
}

export function isSensitiveValue(value: unknown): value is SensitiveValue<unknown> {
  return typeof value === 'object' && value !== null && sensitiveMarker in value;
}

export function redactValue(value: unknown): unknown {
  if (isSensitiveValue(value)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
  }
  return value;
}

export async function secureFingerprint(value: SensitiveValue<unknown>): Promise<string> {
  const raw = value.reveal();
  return sha256Hex(typeof raw === 'string' ? raw : JSON.stringify(raw));
}
