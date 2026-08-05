import { describe, expect, it } from 'vitest';
import { retry } from '@launchpad/shared';
import { ProviderRequestError } from '@launchpad/provider-contract';
import type { ProviderName } from '@launchpad/core';
import { CONTRACT_CANARY_BODY, CONTRACT_CANARY_TOKEN, recordedTransport, type RecordedRequest, type RecordedStep } from '../fixtures/recorded-transport.js';

/**
 * Shared provider contract matrix (master plan section 31, "Provider contract
 * tests"). The exact same expectations run against every real adapter
 * (GitHubAdapter, VercelAdapter, CloudflareAdapter) through recorded
 * request/response transports: not-found, authentication, authorization,
 * rate limiting, transient 5xx, timeout, malformed/partial responses,
 * idempotent retry, verified postconditions, and canary-clean redaction.
 *
 * Each adapter harness supplies the recorded scripts and the operations; the
 * matrix owns the expectations, so a classification change applies to every
 * provider at once and a provider that mis-classifies fails here.
 */

export interface ProviderMatrixHarness {
  name: string;
  provider: ProviderName;
  /** Error code prefix, e.g. `LP-GITHUB`. */
  codePrefix: string;
  token: string;
  /** Builds the real adapter against the given transport. `token: undefined` simulates missing credentials. */
  create: (options: { fetchImpl: typeof fetch; token?: string; timeoutMs?: number }) => unknown;
  /** A strict read whose 404/5xx/malformed responses propagate as typed errors. */
  strictRead: (adapter: unknown) => Promise<unknown>;
  /** Script that makes the strict read surface the given error response. */
  strictReadError: (response: RecordedStep['response']) => RecordedStep[];
  /** A read that maps absence to a benign value (null / 'missing') instead of failing. */
  finderRead: (adapter: unknown) => Promise<unknown>;
  /** Expected benign result of the finder read when the resource is absent. */
  finderAbsentResult: unknown;
  /** Script for the finder read when the resource is absent. */
  finderAbsent: () => RecordedStep[];
  /** A write whose 401/403/429 responses propagate and that carries an idempotency key. */
  write: (adapter: unknown) => Promise<unknown>;
  /** Script that makes the write surface the given error response (pre-steps may be repeatable). */
  writeError: (response: RecordedStep['response']) => RecordedStep[];
  /** Script where the write succeeds (used for idempotency and transient-retry scenarios). */
  writeOk: () => RecordedStep[];
  /** Extracts the idempotency key the write sent from a recorded run (null when none was sent). */
  writeIdempotencyKey: (requests: RecordedRequest[]) => string | null;
  /** A fetch that never resolves until the request signal aborts (real client timeout path). */
  timeoutFetch: () => { fetchImpl: typeof fetch };
}

function expectError(error: unknown, expected: { class: string; retryable: boolean; code?: string; status?: number | null }): void {
  expect(error).toBeInstanceOf(ProviderRequestError);
  const typed = error as ProviderRequestError;
  expect(typed.class, `error class for ${typed.code}`).toBe(expected.class);
  expect(typed.retryable).toBe(expected.retryable);
  if (expected.code !== undefined) expect(typed.code).toBe(expected.code);
  if (expected.status !== undefined) expect(typed.status).toBe(expected.status);
}

export function runProviderContractMatrix(harness: ProviderMatrixHarness): void {
  describe(`provider contract matrix: ${harness.name}`, () => {
    it('fails closed when no credentials are configured, without calling the provider', async () => {
      const transport = recordedTransport([]);
      const adapter = harness.create({ fetchImpl: transport.fetchImpl, token: undefined });
      await expect(harness.write(adapter)).rejects.toSatisfy((error: unknown) => {
        expectError(error, { class: 'AUTHENTICATION', retryable: false, code: `${harness.codePrefix}-AUTH-MISSING` });
        return true;
      });
      expect(transport.requests).toHaveLength(0);
    });

    it('distinguishes provider not-found on strict reads', async () => {
      const transport = recordedTransport(harness.strictReadError({ status: 404, body: { message: 'not found' } }));
      const adapter = harness.create({ fetchImpl: transport.fetchImpl, token: harness.token });
      await expect(harness.strictRead(adapter)).rejects.toSatisfy((error: unknown) => {
        expectError(error, { class: 'NOT_FOUND', retryable: false, code: `${harness.codePrefix}-HTTP-404`, status: 404 });
        return true;
      });
    });

    it('turns not-found into a benign absence on finder reads, never a failure', async () => {
      const transport = recordedTransport(harness.finderAbsent());
      const adapter = harness.create({ fetchImpl: transport.fetchImpl, token: harness.token });
      await expect(harness.finderRead(adapter)).resolves.toBe(harness.finderAbsentResult);
    });

    it('distinguishes authentication failures (401)', async () => {
      const transport = recordedTransport(harness.writeError({ status: 401, body: { message: 'unauthorized' } }));
      const adapter = harness.create({ fetchImpl: transport.fetchImpl, token: harness.token });
      await expect(harness.write(adapter)).rejects.toSatisfy((error: unknown) => {
        expectError(error, { class: 'AUTHENTICATION', retryable: false, code: `${harness.codePrefix}-HTTP-401`, status: 401 });
        return true;
      });
    });

    it('distinguishes authorization failures (403)', async () => {
      const transport = recordedTransport(harness.writeError({ status: 403, body: { message: 'forbidden' } }));
      const adapter = harness.create({ fetchImpl: transport.fetchImpl, token: harness.token });
      await expect(harness.write(adapter)).rejects.toSatisfy((error: unknown) => {
        expectError(error, { class: 'AUTHORIZATION', retryable: false, code: `${harness.codePrefix}-HTTP-403`, status: 403 });
        return true;
      });
    });

    it('classifies rate limits with retry metadata (429)', async () => {
      const transport = recordedTransport(harness.writeError({ status: 429, body: { message: 'rate limited' } }));
      const adapter = harness.create({ fetchImpl: transport.fetchImpl, token: harness.token });
      await expect(harness.write(adapter)).rejects.toSatisfy((error: unknown) => {
        expectError(error, { class: 'RATE_LIMITED', retryable: true, code: `${harness.codePrefix}-HTTP-429`, status: 429 });
        const typed = error as ProviderRequestError;
        expect(typed.safeDetails).toEqual({ status: 429 });
        return true;
      });
    });

    it('classifies transient 5xx responses as retryable', async () => {
      for (const status of [503, 500]) {
        const transport = recordedTransport(harness.strictReadError({ status, body: { message: 'unavailable' } }));
        const adapter = harness.create({ fetchImpl: transport.fetchImpl, token: harness.token });
        await expect(harness.strictRead(adapter)).rejects.toSatisfy((error: unknown) => {
          expectError(error, { class: 'TRANSIENT_PROVIDER', retryable: true, code: `${harness.codePrefix}-HTTP-${status}`, status });
          return true;
        });
      }
    });

    it('classifies request timeouts as retryable TIMEOUT', async () => {
      const { fetchImpl } = harness.timeoutFetch();
      const adapter = harness.create({ fetchImpl, token: harness.token, timeoutMs: 20 });
      await expect(harness.strictRead(adapter)).rejects.toSatisfy((error: unknown) => {
        expectError(error, { class: 'TIMEOUT', retryable: true, code: `${harness.codePrefix}-TIMEOUT` });
        return true;
      });
    });

    it('fails closed on malformed provider JSON', async () => {
      const transport = recordedTransport(harness.strictReadError({ status: 200, raw: 'not-json' }));
      const adapter = harness.create({ fetchImpl: transport.fetchImpl, token: harness.token });
      await expect(harness.strictRead(adapter)).rejects.toSatisfy((error: unknown) => {
        expectError(error, { class: 'MALFORMED_PROVIDER_RESPONSE', retryable: false, code: `${harness.codePrefix}-MALFORMED-RESPONSE` });
        return true;
      });
    });

    it('never leaks tokens or raw provider bodies into typed errors', async () => {
      const transport = recordedTransport(harness.writeError({ status: 403, body: { message: CONTRACT_CANARY_BODY } }));
      const adapter = harness.create({ fetchImpl: transport.fetchImpl, token: harness.token });
      await expect(harness.write(adapter)).rejects.toSatisfy((error: unknown) => {
        expectError(error, { class: 'AUTHORIZATION', retryable: false });
        const serialized = JSON.stringify(error);
        expect(serialized).not.toContain(CONTRACT_CANARY_TOKEN);
        expect(serialized).not.toContain(CONTRACT_CANARY_BODY);
        const typed = error as ProviderRequestError;
        expect('body' in typed.safeDetails).toBe(false);
        expect((error as Error).message).not.toContain(CONTRACT_CANARY_BODY);
        return true;
      });
    });

    it('sends stable idempotency keys so provider-side retries dedupe', async () => {
      const first = recordedTransport(harness.writeOk());
      const adapterOne = harness.create({ fetchImpl: first.fetchImpl, token: harness.token });
      await harness.write(adapterOne);
      const second = recordedTransport(harness.writeOk());
      const adapterTwo = harness.create({ fetchImpl: second.fetchImpl, token: harness.token });
      await harness.write(adapterTwo);
      const keyOne = harness.writeIdempotencyKey(first.requests);
      const keyTwo = harness.writeIdempotencyKey(second.requests);
      expect(keyOne).not.toBeNull();
      expect(keyTwo).not.toBeNull();
      expect(keyOne).toBe(keyTwo);
    });

    it('recovers a transient failure on retry with the same idempotency key', async () => {
      const steps = [...harness.writeError({ status: 503, body: { message: 'unavailable' } }), ...harness.writeOk()];
      const transport = recordedTransport(steps);
      const adapter = harness.create({ fetchImpl: transport.fetchImpl, token: harness.token });
      const result = await retry(() => harness.write(adapter), { maxAttempts: 2, baseDelayMs: 0, sleep: async () => undefined });
      expect(result).toBeDefined();
      const failedRun = transport.requests.slice(0, Math.floor(transport.requests.length / 2));
      const retriedRun = transport.requests.slice(Math.floor(transport.requests.length / 2));
      expect(harness.writeIdempotencyKey(failedRun)).toBe(harness.writeIdempotencyKey(retriedRun));
    });
  });
}
