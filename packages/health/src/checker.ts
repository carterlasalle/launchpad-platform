import type { EnvironmentName, HealthCheckRecord, HealthDependencySpec, HealthSpec } from '@launchpad/core';
import { evaluateAssertions, type AssertionResult } from './assertions.js';

export const HEALTH_ERROR_CODES = {
  NOT_RUN: 'LP-HEALTH-NOT-RUN',
  INVALID_SPEC: 'LP-HEALTH-INVALID-SPEC',
  DNS_FAILED: 'LP-HEALTH-DNS-FAILED',
  TLS_FAILED: 'LP-HEALTH-TLS-FAILED',
  TLS_EXPIRING: 'LP-HEALTH-TLS-EXPIRING',
  TIMEOUT: 'LP-HEALTH-TIMEOUT',
  REQUEST_FAILED: 'LP-HEALTH-REQUEST-FAILED',
  REDIRECT_FAILED: 'LP-HEALTH-REDIRECT-FAILED',
  ASSERTION_FAILED: 'LP-HEALTH-ASSERTION-FAILED',
  DEPENDENCY_FAILED: 'LP-HEALTH-DEPENDENCY-FAILED',
  SECRET_UNAVAILABLE: 'LP-HEALTH-SECRET-UNAVAILABLE',
} as const;
export type HealthErrorCode = (typeof HEALTH_ERROR_CODES)[keyof typeof HEALTH_ERROR_CODES];

export interface TlsProbeResult {
  valid: boolean;
  daysRemaining: number | null;
  detail?: string | null;
}

export interface DependencyResult {
  healthy: boolean;
  message: string;
}

export interface HealthCheckInput {
  applicationId: string;
  environment: EnvironmentName;
  deploymentId: string | null;
  baseUrl: string;
  spec: HealthSpec;
  fetchImpl?: typeof fetch | undefined;
  sleep?: ((delayMs: number) => Promise<void>) | undefined;
  resolveSecret?: ((reference: string) => Promise<string>) | undefined;
  dnsResolve?: ((hostname: string) => Promise<void>) | undefined;
  tlsProbe?: ((url: URL) => Promise<TlsProbeResult>) | undefined;
  resolveDependency?: ((dependency: HealthDependencySpec) => Promise<DependencyResult>) | undefined;
}

const MS_PER_DAY = 86_400_000;

async function defaultDnsResolve(hostname: string): Promise<void> {
  let dns: typeof import('node:dns/promises');
  try {
    dns = await import('node:dns/promises');
  } catch {
    return; // Runtime without node:dns (for example Workers); fetch will surface resolution failures.
  }
  try {
    await dns.lookup(hostname, { verbatim: true });
  } catch {
    // Best-effort default: an injected dnsResolve is authoritative and fails the check,
    // while the default resolver defers to fetch as the source of truth for connectivity.
  }
}

async function defaultTlsProbe(url: URL): Promise<TlsProbeResult> {
  let tls: typeof import('node:tls');
  try {
    tls = await import('node:tls');
  } catch {
    return { valid: true, daysRemaining: null }; // Runtime without node:tls; certificate validity cannot be verified here.
  }
  return new Promise<TlsProbeResult>((resolve) => {
    const socket = tls.connect({ host: url.hostname, port: Number(url.port) || 443, servername: url.hostname, rejectUnauthorized: true, timeout: 10_000 });
    const settle = (result: TlsProbeResult): void => {
      socket.destroy();
      resolve(result);
    };
    socket.once('secureConnect', () => {
      if (!socket.authorized) {
        settle({ valid: false, daysRemaining: null, detail: 'TLS certificate is not authorized.' });
        return;
      }
      const certificate = socket.getPeerCertificate();
      if (!certificate || !certificate.valid_to) {
        settle({ valid: true, daysRemaining: null, detail: 'TLS certificate validity period is unavailable.' });
        return;
      }
      const daysRemaining = Math.max(0, Math.ceil((Date.parse(certificate.valid_to) - Date.now()) / MS_PER_DAY));
      settle({ valid: true, daysRemaining });
    });
    socket.once('error', () => settle({ valid: false, daysRemaining: null, detail: 'TLS handshake failed.' }));
    socket.once('timeout', () => settle({ valid: false, daysRemaining: null, detail: 'TLS handshake timed out.' }));
  });
}

function specError(spec: HealthSpec): string | null {
  if (typeof spec.path !== 'string' || !spec.path.startsWith('/')) return 'Health spec path must be a string starting with "/".';
  if (typeof spec.method !== 'string' || spec.method.length === 0) return 'Health spec method must be a non-empty string.';
  if (!Array.isArray(spec.expectedStatus) || spec.expectedStatus.length === 0) return 'Health spec expectedStatus must list at least one status code.';
  if (!Number.isInteger(spec.attempts) || spec.attempts < 1) return 'Health spec attempts must be a positive integer.';
  if (!Number.isInteger(spec.timeoutSeconds) || spec.timeoutSeconds < 1) return 'Health spec timeoutSeconds must be a positive integer.';
  if (!Number.isInteger(spec.intervalSeconds) || spec.intervalSeconds < 0) return 'Health spec intervalSeconds must be a non-negative integer.';
  if (spec.backoff) {
    if (spec.backoff.multiplier !== undefined && (typeof spec.backoff.multiplier !== 'number' || !Number.isFinite(spec.backoff.multiplier) || spec.backoff.multiplier <= 1)) return 'Health spec backoff.multiplier must be a finite number greater than 1.';
    if (spec.backoff.maxDelaySeconds !== undefined && (!Number.isInteger(spec.backoff.maxDelaySeconds) || spec.backoff.maxDelaySeconds < 0)) return 'Health spec backoff.maxDelaySeconds must be a non-negative integer.';
  }
  if (spec.tls?.required && spec.tls.minimumDaysRemaining !== undefined && (!Number.isInteger(spec.tls.minimumDaysRemaining) || spec.tls.minimumDaysRemaining < 0)) return 'Health spec tls.minimumDaysRemaining must be a non-negative integer.';
  return null;
}

function recordFor(input: HealthCheckInput, url: string, attempt: number, overrides: Partial<Omit<HealthCheckRecord, 'id' | 'applicationId' | 'environment' | 'deploymentId' | 'url' | 'attempt'>>): HealthCheckRecord {
  return {
    id: `${input.applicationId}:${input.environment}:${Date.now()}`,
    applicationId: input.applicationId,
    environment: input.environment,
    deploymentId: input.deploymentId,
    url,
    attempt,
    dnsResolved: false,
    tlsValid: !input.spec.tls?.required,
    statusCode: null,
    latencyMs: null,
    assertionResults: [],
    result: 'ERROR',
    checkedAt: new Date().toISOString(),
    errorCode: HEALTH_ERROR_CODES.NOT_RUN,
    ...overrides,
  };
}

async function dependencyAssertions(specs: readonly HealthDependencySpec[], resolveDependency: ((dependency: HealthDependencySpec) => Promise<DependencyResult>) | undefined, timeoutSeconds: number, fetchImpl: typeof fetch): Promise<{ results: AssertionResult[]; requiredFailed: boolean }> {
  const results: AssertionResult[] = [];
  let requiredFailed = false;
  for (const dependency of specs) {
    let outcome: DependencyResult;
    if (resolveDependency) {
      try {
        outcome = await resolveDependency(dependency);
      } catch {
        outcome = { healthy: false, message: `Dependency '${dependency.id}' check errored.` };
      }
    } else if (dependency.type === 'external' && dependency.url) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
      try {
        const response = await fetchImpl(dependency.url, { method: 'GET', redirect: 'follow', signal: controller.signal });
        outcome = response.ok ? { healthy: true, message: `Dependency '${dependency.id}' responded with HTTP ${response.status}.` } : { healthy: false, message: `Dependency '${dependency.id}' responded with HTTP ${response.status}.` };
      } catch {
        outcome = { healthy: false, message: `Dependency '${dependency.id}' could not be reached.` };
      } finally {
        clearTimeout(timeout);
      }
    } else {
      outcome = { healthy: false, message: `Dependency '${dependency.id}' cannot be probed; configure a URL or a resolveDependency resolver.` };
    }
    results.push({ name: `dependency:${dependency.id}`, passed: outcome.healthy, message: outcome.message });
    if (dependency.required && !outcome.healthy) requiredFailed = true;
  }
  return { results, requiredFailed };
}

export async function checkHealth(input: HealthCheckInput): Promise<HealthCheckRecord> {
  const { spec } = input;
  const sleep = input.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const fetchImpl = input.fetchImpl ?? fetch;
  const dnsResolve = input.dnsResolve ?? defaultDnsResolve;
  const tlsProbe = input.tlsProbe ?? defaultTlsProbe;

  const invalid = specError(spec);
  if (invalid) return recordFor(input, input.baseUrl, 0, { errorCode: HEALTH_ERROR_CODES.INVALID_SPEC, assertionResults: [{ name: 'spec', passed: false, message: invalid }] });

  let url: URL;
  try {
    url = new URL(spec.path, input.baseUrl);
  } catch {
    return recordFor(input, input.baseUrl, 0, { errorCode: HEALTH_ERROR_CODES.INVALID_SPEC, assertionResults: [{ name: 'spec', passed: false, message: 'baseUrl is not a valid URL.' }] });
  }
  const urlString = url.toString();

  // Headers are resolved once up front. A secret-backed header that cannot be resolved fails
  // closed: the check never runs without the headers the spec requires.
  const headers = new Headers();
  for (const [name, value] of Object.entries(spec.headers ?? {})) {
    if (typeof value === 'string') {
      headers.set(name, value);
    } else {
      if (!input.resolveSecret) return recordFor(input, urlString, 0, { errorCode: HEALTH_ERROR_CODES.SECRET_UNAVAILABLE, assertionResults: [{ name: `header:${name}`, passed: false, message: `Secret-backed header '${name}' cannot be resolved because no secret resolver is configured.` }] });
      try {
        headers.set(name, await input.resolveSecret(value.secretRef));
      } catch {
        return recordFor(input, urlString, 0, { errorCode: HEALTH_ERROR_CODES.SECRET_UNAVAILABLE, assertionResults: [{ name: `header:${name}`, passed: false, message: `Secret-backed header '${name}' could not be resolved.` }] });
      }
    }
  }

  const delaySeconds = (attempt: number): number => {
    const multiplier = spec.backoff?.multiplier ?? 1;
    const exponential = spec.intervalSeconds * multiplier ** (attempt - 1);
    return Math.min(exponential, spec.backoff?.maxDelaySeconds ?? Number.MAX_SAFE_INTEGER);
  };

  let last = recordFor(input, urlString, 0, {});
  for (let attempt = 1; attempt <= spec.attempts; attempt += 1) {
    const started = performance.now();

    try {
      await dnsResolve(url.hostname);
    } catch {
      last = recordFor(input, urlString, attempt, { dnsResolved: false, result: 'ERROR', errorCode: HEALTH_ERROR_CODES.DNS_FAILED });
      if (attempt < spec.attempts) await sleep(delaySeconds(attempt) * 1000);
      continue;
    }

    let tlsValidity: { valid: boolean; daysRemaining: number | null } | null = null;
    let tlsValid = !spec.tls?.required;
    if (spec.tls?.required && url.protocol === 'https:') {
      const probe = await tlsProbe(url);
      tlsValidity = probe;
      tlsValid = probe.valid;
      if (!probe.valid) {
        last = recordFor(input, urlString, attempt, { dnsResolved: true, tlsValid: false, result: 'ERROR', errorCode: HEALTH_ERROR_CODES.TLS_FAILED });
        if (attempt < spec.attempts) await sleep(delaySeconds(attempt) * 1000);
        continue;
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), spec.timeoutSeconds * 1000);
    try {
      const response = await fetchImpl(urlString, { method: spec.method, headers, redirect: spec.redirects?.allowed === false ? 'manual' : 'follow', signal: controller.signal });
      const bodyText = await response.text();
      const latencyMs = Math.round(performance.now() - started);
      const responseAssertions: AssertionResult[] = evaluateAssertions(spec, { status: response.status, url: response.url || urlString, latencyMs }, bodyText);
      if (spec.tls?.required && spec.tls.minimumDaysRemaining !== undefined && url.protocol === 'https:') {
        const daysRemaining = tlsValidity?.daysRemaining ?? null;
        responseAssertions.push({ name: 'tls-validity', passed: daysRemaining !== null && daysRemaining >= (spec.tls.minimumDaysRemaining ?? 0), message: daysRemaining === null ? 'TLS certificate validity could not be verified.' : `TLS certificate expires in ${daysRemaining} days; minimum ${spec.tls.minimumDaysRemaining} days required.` });
      }
      const dependencyOutcome = await dependencyAssertions(spec.dependencies ?? [], input.resolveDependency, spec.timeoutSeconds, fetchImpl);
      const assertionResults: AssertionResult[] = [...responseAssertions, ...dependencyOutcome.results];
      const responsePassed = responseAssertions.every((assertion) => assertion.passed);
      const passed = responsePassed && !dependencyOutcome.requiredFailed;
      const errorCode: HealthErrorCode | null = passed ? null : dependencyOutcome.requiredFailed ? HEALTH_ERROR_CODES.DEPENDENCY_FAILED : responseAssertions.some((assertion) => assertion.name === 'redirect-policy' && !assertion.passed) ? HEALTH_ERROR_CODES.REDIRECT_FAILED : responseAssertions.some((assertion) => assertion.name === 'tls-validity' && !assertion.passed) ? HEALTH_ERROR_CODES.TLS_EXPIRING : HEALTH_ERROR_CODES.ASSERTION_FAILED;
      last = recordFor(input, urlString, attempt, { dnsResolved: true, tlsValid, statusCode: response.status, latencyMs, assertionResults, result: passed ? 'PASSED' : 'FAILED', errorCode });
      if (passed) return last;
    } catch (error) {
      const aborted = (error instanceof DOMException || (error instanceof Error && error.name === 'AbortError')) && error.name === 'AbortError';
      last = recordFor(input, urlString, attempt, { dnsResolved: true, tlsValid, result: 'ERROR', errorCode: aborted ? HEALTH_ERROR_CODES.TIMEOUT : HEALTH_ERROR_CODES.REQUEST_FAILED });
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < spec.attempts) await sleep(delaySeconds(attempt) * 1000);
  }
  return last;
}
