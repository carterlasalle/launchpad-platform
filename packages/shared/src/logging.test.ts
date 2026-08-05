import { describe, expect, it } from 'vitest';
import { LaunchpadLogger, redactLogValue, SensitiveValue } from './index.js';

const canary = 'launchpad-canary-9f3c';

function collectingLogger(): { logger: LaunchpadLogger; lines: string[] } {
  const lines: string[] = [];
  const logger = new LaunchpadLogger({ sink: (line) => lines.push(line), level: 'debug' });
  return { logger, lines };
}

describe('LaunchpadLogger', () => {
  it('emits one structured JSON line with the fixed correlation fields', () => {
    const { logger, lines } = collectingLogger();
    logger.error('provider call failed', { correlationId: 'corr-1', applicationId: 'app-demo', workflowId: 'wf-1', operationId: 'op-1', provider: 'vercel', step: 'ensure-project', errorCode: 'LP-VERCEL-500', retryable: true });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry).toMatchObject({ level: 'error', message: 'provider call failed', correlationId: 'corr-1', applicationId: 'app-demo', workflowId: 'wf-1', operationId: 'op-1', provider: 'vercel', step: 'ensure-project', errorCode: 'LP-VERCEL-500', retryable: true });
    expect(typeof entry.timestamp).toBe('string');
  });

  it('redacts SensitiveValue structurally, never via raw serialization', () => {
    const { logger, lines } = collectingLogger();
    const token = new SensitiveValue(canary);
    logger.info('request handled', { headers: { authorization: token }, nested: { token } });
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry).toMatchObject({ headers: { authorization: '[REDACTED]' }, nested: { token: '[REDACTED]' } });
    expect(lines[0]).not.toContain(canary);
  });

  it('bounds long strings and cuts cycles instead of throwing', () => {
    const { logger, lines } = collectingLogger();
    const cyclic: Record<string, unknown> = { message: 'ok' };
    cyclic.self = cyclic;
    logger.warn('cycle', { cyclic, big: 'x'.repeat(10_000) });
    const entry = JSON.parse(lines[0]!) as { cyclic: { self: unknown }; big: string };
    expect(entry.cyclic.self).toBe('[Circular]');
    expect(entry.big.length).toBeLessThan(10_000);
    expect(entry.big.endsWith('[truncated]')).toBe(true);
  });

  it('never throws when a field cannot be serialized', () => {
    const { logger, lines } = collectingLogger();
    expect(() => logger.error('broken', { weird: { toJSON: () => { throw new Error('boom'); } } })).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).level).toBe('error');
  });

  it('drops values below the configured level', () => {
    const lines: string[] = [];
    const logger = new LaunchpadLogger({ sink: (line) => lines.push(line), level: 'info' });
    logger.debug('hidden');
    expect(lines).toHaveLength(0);
  });

  it('child loggers merge context into every entry', () => {
    const { logger, lines } = collectingLogger();
    const child = logger.child({ applicationId: 'app-demo', correlationId: 'corr-9' });
    child.info('child entry', { step: 'report' });
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry).toMatchObject({ applicationId: 'app-demo', correlationId: 'corr-9', step: 'report' });
  });

  it('redactLogValue scrubs credential-shaped text in plain strings', () => {
    const redacted = redactLogValue({ url: 'https://x.example?token=abc123def' }) as { url: string };
    expect(redacted.url).not.toContain('abc123def');
    expect(redacted.url).toContain('[REDACTED]');
  });
});
