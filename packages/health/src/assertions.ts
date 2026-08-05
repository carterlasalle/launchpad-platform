import type { HealthSpec } from '@launchpad/core';

export interface AssertionResult {
  name: string;
  passed: boolean;
  message: string;
}

/**
 * Tokenizes a JSONPath expression of the forms `$`, `$.a.b`, `$.a[0].b`, `$['a'][1]`.
 * Returns `null` for anything that is not a supported JSONPath expression.
 */
export function tokenizeJsonPath(path: string): string[] | null {
  if (path === '$') return [];
  if (!path.startsWith('$')) return null;
  const tokens: string[] = [];
  let rest = path.slice(1);
  while (rest.length > 0) {
    if (rest.startsWith('.')) {
      rest = rest.slice(1);
      const match = /^[A-Za-z_$][A-Za-z0-9_$-]*/.exec(rest);
      if (!match) return null;
      const token = match[0]!;
      tokens.push(token);
      rest = rest.slice(token.length);
    } else if (rest.startsWith('[')) {
      const close = rest.indexOf(']');
      if (close < 0) return null;
      const inner = rest.slice(1, close);
      rest = rest.slice(close + 1);
      const quoted = /^(['"])(.*)\1$/.exec(inner);
      if (quoted) tokens.push(quoted[2]!);
      else if (/^\d+$/.test(inner)) tokens.push(inner);
      else return null;
    } else {
      return null;
    }
  }
  return tokens;
}

export function readJsonPath(value: unknown, path: string): unknown {
  const tokens = tokenizeJsonPath(path);
  if (tokens === null) return undefined;
  let current: unknown = value;
  for (const token of tokens) {
    if (current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(token)) return undefined;
      const index = Number(token);
      if (index >= current.length) return undefined;
      current = current[index];
    } else if (token in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Deep equality that is insensitive to object key order. */
export function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
    return leftKeys.every((key) => deepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
  }
  return false;
}

export function evaluateAssertions(spec: HealthSpec, response: { status: number; url: string; latencyMs: number }, bodyText: string): AssertionResult[] {
  const results: AssertionResult[] = [{ name: 'status', passed: spec.expectedStatus.includes(response.status), message: `Expected ${spec.expectedStatus.join(', ')}; received ${response.status}.` }];
  if (spec.redirects?.allowed === false) results.push({ name: 'redirect-policy', passed: response.status < 300 || response.status >= 400, message: response.status >= 300 && response.status < 400 ? 'Redirects are not allowed.' : 'No redirect observed.' });
  if (spec.latencyMs !== undefined) results.push({ name: 'latency', passed: response.latencyMs <= spec.latencyMs, message: `Latency ${response.latencyMs}ms; threshold ${spec.latencyMs}ms.` });
  if (spec.tls?.required) results.push({ name: 'tls', passed: response.url.startsWith('https://'), message: response.url.startsWith('https://') ? 'HTTPS is in use.' : 'TLS is required.' });
  if (spec.body) {
    let parsed: unknown = null;
    try { parsed = JSON.parse(bodyText) as unknown; } catch { parsed = null; }
    if (spec.body.jsonPath) {
      const actual = readJsonPath(parsed, spec.body.jsonPath);
      results.push({ name: `jsonPath:${spec.body.jsonPath}`, passed: deepEqual(actual, spec.body.equals), message: `Expected JSONPath value ${JSON.stringify(spec.body.equals)}; received ${JSON.stringify(actual)}.` });
    }
    if (spec.body.contains) results.push({ name: 'body-contains', passed: bodyText.includes(spec.body.contains), message: `Body ${bodyText.includes(spec.body.contains) ? 'contains' : 'does not contain'} the expected string.` });
    if (spec.body.matches) {
      let passed = false;
      try { passed = new RegExp(spec.body.matches).test(bodyText); } catch { passed = false; }
      results.push({ name: 'body-matches', passed, message: passed ? 'Body matches the configured expression.' : 'Body does not match the configured expression.' });
    }
  }
  return results;
}
