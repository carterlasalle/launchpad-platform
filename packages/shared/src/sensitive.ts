import { sha256Hex } from './hash.js';

const sensitiveMarker = Symbol('launchpad.sensitive');
const nodeInspect = Symbol.for('nodejs.util.inspect.custom');

export class SensitiveValue<T> {
  readonly [sensitiveMarker] = true;
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  /**
   * Explicit escape hatch. Revealing a value is intended exclusively for provider write
   * paths (for example sending the resolved value to a provider API). Every other consumer
   * MUST use `redacted()` or one of the fingerprint methods instead.
   */
  reveal(): T {
    return this.#value;
  }

  /**
   * LEGACY non-keyed fingerprint (FNV-1a, 64-bit).
   *
   * Kept only for compatibility with pre-keyed callers and tests. It is reference-blind
   * (the same value under two different references fingerprints identically) and
   * low-entropy (16 hex chars, 64 bits), so it is NOT a security-relevant equality
   * marker and MUST NOT be used to persist equality markers (D1 rows, drift records,
   * credential value fingerprints, plan artifacts) or to compare secret material.
   *
   * Use `keyedFingerprint(key)` when the secret is bound to a stored reference (the key
   * keeps fingerprints from being confused across keys) and `secureFingerprint(value)`
   * for keyless one-off verification.
   */
  fingerprint(): string {
    const text = typeof this.#value === 'string' ? this.#value : JSON.stringify(this.#value);
    let hash = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(text ?? '')) {
      hash ^= BigInt(byte);
      hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return hash.toString(16).padStart(16, '0');
  }

  /**
   * SHA-256 fingerprint keyed by `key` (for example the secret reference the value was
   * retrieved from). Deterministic for the same key and value across processes, so a
   * keyed fingerprint may be persisted as a stable equality marker (for example a D1
   * `value_fingerprint` column or a drift record): the persisted key makes the marker
   * reproducible on any later run. A random-keyed HMAC would break that cross-process
   * determinism, so the caller-supplied key is the required keying material — never a
   * per-process secret. Changes when either the key or the value changes; the raw value
   * is never exposed in the fingerprint.
   */
  async keyedFingerprint(key: string): Promise<string> {
    const raw = typeof this.#value === 'string' ? this.#value : JSON.stringify(this.#value);
    return sha256Hex(`${key}\u0000${raw ?? ''}`);
  }

  redacted(): '[REDACTED]' {
    return '[REDACTED]';
  }

  toString(): string {
    return '[REDACTED]';
  }

  [Symbol.toPrimitive](hint: 'string' | 'number' | 'default'): string | never {
    if (hint === 'string') return '[REDACTED]';
    throw new TypeError('SensitiveValue cannot be coerced to a non-string primitive');
  }

  get [Symbol.toStringTag](): string {
    return 'SensitiveValue';
  }

  [nodeInspect](): string {
    return 'SensitiveValue([REDACTED])';
  }

  toJSON(): never {
    throw new TypeError('SensitiveValue cannot be serialized without explicit redaction');
  }
}

export function isSensitiveValue(value: unknown): value is SensitiveValue<unknown> {
  return typeof value === 'object' && value !== null && sensitiveMarker in value;
}

export function redactValue(value: unknown): unknown {
  // Ancestor-stack guard: only genuine cycles are replaced. Shared references
  // (e.g. the same health spec used by several plan operations) must
  // serialize fully — a global seen-set would corrupt the plan artifact that
  // the plan-review attestation binds.
  const ancestors = new WeakSet<object>();
  const redact = (current: unknown): unknown => {
    if (isSensitiveValue(current)) return '[REDACTED]';
    if (Array.isArray(current)) {
      if (ancestors.has(current)) return '[Circular]';
      ancestors.add(current);
      const out = current.map((item) => redact(item));
      ancestors.delete(current);
      return out;
    }
    if (current !== null && typeof current === 'object') {
      if (ancestors.has(current)) return '[Circular]';
      ancestors.add(current);
      const out = Object.fromEntries(Object.entries(current).map(([key, item]) => [key, redact(item)]));
      ancestors.delete(current);
      return out;
    }
    return current;
  };
  return redact(value);
}

/**
 * Unkeyed SHA-256 fingerprint of a secret value. Deterministic for the same value
 * across processes, but NOT reference-bound: the same value in two different bindings
 * fingerprints identically, so prefer `SensitiveValue.keyedFingerprint(key)` whenever a
 * stable key (secret reference) exists. Reserved for keyless one-off verification;
 * never use it to persist equality markers for secret material when a key is available.
 */
export async function secureFingerprint(value: SensitiveValue<unknown>): Promise<string> {
  const raw = value.reveal();
  return sha256Hex(typeof raw === 'string' ? raw : JSON.stringify(raw));
}
