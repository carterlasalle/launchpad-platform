import type { EnvironmentName, HealthCheckRecord, HealthSpec } from '@launchpad/core';
import { evaluateAssertions, type AssertionResult } from './assertions.js';

export interface HealthCheckInput { applicationId: string; environment: EnvironmentName; deploymentId: string | null; baseUrl: string; spec: HealthSpec; fetchImpl?: typeof fetch | undefined; sleep?: ((delayMs: number) => Promise<void>) | undefined; resolveSecret?: ((reference: string) => Promise<string>) | undefined; }

function headersFor(spec: HealthSpec, resolveSecret?: (reference: string) => Promise<string>): Promise<Headers> {
  const headers = new Headers();
  const entries = Object.entries(spec.headers ?? {});
  return entries.reduce(async (promise, [name, value]) => {
    const result = await promise;
    if (typeof value === 'string') result.set(name, value);
    else if (resolveSecret) result.set(name, await resolveSecret(value.secretRef));
    return result;
  }, Promise.resolve(headers));
}

export async function checkHealth(input: HealthCheckInput): Promise<HealthCheckRecord> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const url = new URL(input.spec.path, input.baseUrl).toString();
  let last: HealthCheckRecord = { id: `${input.applicationId}:${input.environment}:${Date.now()}`, applicationId: input.applicationId, environment: input.environment, deploymentId: input.deploymentId, url, attempt: 0, dnsResolved: false, tlsValid: !input.spec.tls?.required || url.startsWith('https://'), statusCode: null, latencyMs: null, assertionResults: [], result: 'ERROR', checkedAt: new Date().toISOString(), errorCode: 'LP-HEALTH-NOT-RUN' };
  const headers = await headersFor(input.spec, input.resolveSecret);
  for (let attempt = 1; attempt <= input.spec.attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.spec.timeoutSeconds * 1000);
    const started = performance.now();
    try {
      const response = await fetchImpl(url, { method: input.spec.method, headers, redirect: input.spec.redirects?.allowed === false ? 'manual' : 'follow', signal: controller.signal });
      const body = await response.text();
      const latencyMs = Math.round(performance.now() - started);
      const assertionResults: AssertionResult[] = evaluateAssertions(input.spec, { status: response.status, url: response.url || url, latencyMs }, body);
      const passed = assertionResults.every((assertion) => assertion.passed);
      last = { id: `${input.applicationId}:${input.environment}:${Date.now()}`, applicationId: input.applicationId, environment: input.environment, deploymentId: input.deploymentId, url, attempt, dnsResolved: true, tlsValid: !input.spec.tls?.required || url.startsWith('https://'), statusCode: response.status, latencyMs, assertionResults, result: passed ? 'PASSED' : 'FAILED', checkedAt: new Date().toISOString(), errorCode: passed ? null : 'LP-HEALTH-ASSERTION-FAILED' };
      if (passed) return last;
    } catch (error) {
      last = { ...last, attempt, result: 'ERROR', checkedAt: new Date().toISOString(), errorCode: error instanceof DOMException && error.name === 'AbortError' ? 'LP-HEALTH-TIMEOUT' : 'LP-HEALTH-REQUEST-FAILED' };
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < input.spec.attempts) await sleep(input.spec.intervalSeconds * 1000);
  }
  return last;
}
