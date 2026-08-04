import type { HealthSpec } from '@launchpad/core';

export interface AssertionResult { name: string; passed: boolean; message: string; }

function readJsonPath(value: unknown, path: string): unknown {
  if (path === '$') return value;
  if (!path.startsWith('$.')) return undefined;
  let current: unknown = value;
  for (const segment of path.slice(2).split('.')) {
    if (current !== null && typeof current === 'object' && segment in current) current = (current as Record<string, unknown>)[segment];
    else return undefined;
  }
  return current;
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
      results.push({ name: `jsonPath:${spec.body.jsonPath}`, passed: JSON.stringify(actual) === JSON.stringify(spec.body.equals), message: `Expected JSONPath value ${JSON.stringify(spec.body.equals)}; received ${JSON.stringify(actual)}.` });
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
