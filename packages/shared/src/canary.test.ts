import { expect, it } from 'vitest';
import { LaunchpadLogger, MetricsRegistry, SensitiveValue, alertFingerprint, scanCanary, type AlertAttempt } from './index.js';

const canary = 'launchpad-canary-7f1d';

it('finds exact and substring canaries in nested state with paths', async () => {
  const state = { headers: { 'X-Key': canary }, logs: ['started', `prefix ${canary} suffix`], safe: 'nothing here' };
  const result = await scanCanary(state, [canary]);
  expect(result.leaked).toBe(true);
  expect(result.matches.map((match) => match.path)).toEqual(['$.headers.X-Key', '$.logs[1]']);
  expect(result.matches.every((match) => match.kind !== 'fingerprint')).toBe(true);
});

it('scans JSON-encoded strings and object keys', async () => {
  const payload = JSON.stringify({ token: canary });
  const result = await scanCanary({ payload, [canary]: 'value' }, [canary]);
  expect(result.leaked).toBe(true);
  expect(result.matches.map((match) => `${match.path}:${match.kind}`)).toEqual(['$.payload:substring', `$.${canary}:exact`]);
});

it('reports no leaks for clean artifacts, logs, and comments', async () => {
  const artifact = { plan: { result: 'READY', fingerprint: 'f'.repeat(64) }, providerState: redactForTest(), comment: 'Plan approved.' };
  const result = await scanCanary(artifact, [canary]);
  expect(result.leaked).toBe(false);
  expect(result.matches).toEqual([]);
});

it('treats keyed fingerprints as an expected representation, not a leak', async () => {
  const reference = 'infisical://acme/production/secrets#DATABASE_URL';
  const fingerprint = await new SensitiveValue(canary).keyedFingerprint(reference);
  const result = await scanCanary({ drift: { fingerprint } }, [canary], { fingerprintKeys: [reference] });
  expect(result.leaked).toBe(false);
  expect(result.matches).toEqual([{ path: '$.drift.fingerprint', kind: 'fingerprint' }]);
});

it('flags raw canaries even when a fingerprint is also present', async () => {
  const reference = 'env://DATABASE_URL';
  const fingerprint = await new SensitiveValue(canary).keyedFingerprint(reference);
  const result = await scanCanary({ retained: fingerprint, leaked: canary }, [canary], { fingerprintKeys: [reference] });
  expect(result.leaked).toBe(true);
  expect(result.matches).toEqual([
    { path: '$.retained', kind: 'fingerprint' },
    { path: '$.leaked', kind: 'exact' },
  ]);
});

it('traverses cyclic state without infinite recursion', async () => {
  const cyclic: Record<string, unknown> = { message: 'ok' };
  cyclic.self = cyclic;
  cyclic.secret = canary;
  const result = await scanCanary(cyclic, [canary]);
  expect(result.leaked).toBe(true);
  expect(result.matches).toHaveLength(1);
});

it('never leaks canary values through structured log lines', async () => {
  const lines: string[] = [];
  const logger = new LaunchpadLogger({ sink: (line) => lines.push(line) });
  logger.error('failure', { correlationId: 'corr-1', applicationId: 'app-demo', provider: 'vercel', errorCode: 'LP-X', token: new SensitiveValue(canary), headers: { 'x-api-key': canary } });
  const result = await scanCanary(lines, [canary]);
  expect(result.leaked).toBe(false);
  expect(result.matches).toEqual([]);
});

it('never leaks canary values through alert attempts or metric labels', async () => {
  const attempt: AlertAttempt = { type: 'DLQ', fingerprint: alertFingerprint('DLQ', 'q', 'm'), severity: 'critical', message: `dropped ${new SensitiveValue(canary).redacted()}`, at: new Date('2026-08-04T00:00:00.000Z') };
  const metrics = new MetricsRegistry();
  metrics.increment('failures', { workflow: 'apply', provider: 'vercel' });
  const state = { alertAttempt: attempt, metricSnapshots: metrics.snapshot() };
  const result = await scanCanary(state, [canary]);
  expect(result.leaked).toBe(false);
});

function redactForTest(): unknown {
  return { database: new SensitiveValue(canary).redacted() };
}
