import { sha256Hex } from './hash.js';

export type CanaryMatchKind = 'exact' | 'substring' | 'fingerprint';

export interface CanaryMatch {
  /** JSON-like path to the offending location, for example `$.headers.X-Key` or `$.logs[2]`. */
  path: string;
  kind: CanaryMatchKind;
}

export interface CanaryScanResult {
  /** True when a raw canary value was found; keyed fingerprints do not count as leaks. */
  leaked: boolean;
  matches: CanaryMatch[];
}

export interface CanaryScanOptions {
  /**
   * Secret-reference keys whose keyed fingerprints are an *expected* representation of the
   * canary. Strings equal to `sha256(key \u0000 canary)` are reported with kind
   * `fingerprint` and never count as leaks.
   */
  fingerprintKeys?: readonly string[];
}

/**
 * Recursively scans artifacts, logs, comments, and observed state for canary secret values.
 * Walks object values and keys, arrays, and strings (including JSON-encoded text).
 * Cyclic structures are traversed once per object.
 */
export async function scanCanary(value: unknown, canaries: readonly string[], options: CanaryScanOptions = {}): Promise<CanaryScanResult> {
  const matches: CanaryMatch[] = [];
  const seen = new WeakSet<object>();
  const expectedFingerprints = new Set<string>();
  for (const key of options.fingerprintKeys ?? []) {
    for (const canary of canaries) {
      expectedFingerprints.add(await sha256Hex(`${key}\u0000${canary}`));
    }
  }

  const scanString = (text: string, path: string): void => {
    for (const canary of canaries) {
      if (text === canary) matches.push({ path, kind: 'exact' });
      else if (text.includes(canary)) matches.push({ path, kind: 'substring' });
    }
    if (expectedFingerprints.has(text)) matches.push({ path, kind: 'fingerprint' });
  };

  const scan = (current: unknown, path: string): void => {
    if (typeof current === 'string') {
      scanString(current, path);
      return;
    }
    if (current === null || typeof current !== 'object' || seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((item, index) => scan(item, `${path}[${index}]`));
      return;
    }
    for (const [key, item] of Object.entries(current)) {
      scanString(key, `${path}.${key}`);
      scan(item, `${path}.${key}`);
    }
  };

  scan(value, '$');
  return { leaked: matches.some((match) => match.kind !== 'fingerprint'), matches };
}
