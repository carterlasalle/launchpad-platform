import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from './index.js';

describe('MetricsRegistry', () => {
  it('records bounded counters and timers and snapshots totals', () => {
    let nowValue = new Date('2026-08-04T00:00:00.000Z');
    const registry = new MetricsRegistry({ now: () => nowValue });
    registry.increment('successes', { workflow: 'apply' });
    registry.increment('successes', { workflow: 'apply' });
    registry.increment('failures', { workflow: 'apply', provider: 'vercel' });
    registry.recordDuration(250, { workflow: 'apply' });
    registry.recordDuration(750, { workflow: 'apply' });
    nowValue = new Date('2026-08-04T00:30:00.000Z');
    const snapshots = registry.snapshot();
    const successes = snapshots.find((snapshot) => snapshot.metric === 'successes');
    const failures = snapshots.find((snapshot) => snapshot.metric === 'failures');
    const durations = snapshots.find((snapshot) => snapshot.metric === 'duration_ms');
    expect(successes).toMatchObject({ total: 2, count: 2 });
    expect(failures).toMatchObject({ total: 1, labels: { workflow: 'apply', provider: 'vercel' } });
    expect(durations).toMatchObject({ total: 1000, count: 2 });
    expect(durations?.rate).toBeCloseTo(1000 / 1800, 5);
    expect(snapshots[0]!.windowSeconds).toBe(1800);
  });

  it('derives provider_error_rate from the window counters', () => {
    const registry = new MetricsRegistry({ now: () => new Date('2026-08-04T00:30:00.000Z') });
    registry.increment('successes');
    registry.increment('failures');
    registry.increment('failures');
    const snapshot = registry.snapshot().find((entry) => entry.metric === 'provider_error_rate');
    expect(snapshot).toMatchObject({ total: 2, count: 3, rate: 2 / 3 });
  });

  it('rejects unknown metric names and unbounded label values', () => {
    const registry = new MetricsRegistry();
    expect(() => registry.increment('not-a-metric' as never)).toThrow(/LP-METRIC/);
    expect(() => registry.increment('successes', { provider: 'not-a-provider' as never })).toThrow(/LP-METRIC-LABEL-INVALID/);
    expect(() => registry.increment('successes', { applicationId: 'app-demo' } as never)).toThrow(/LP-METRIC-LABEL-INVALID/);
    expect(() => registry.increment('successes', {}, -1)).toThrow(/LP-METRIC-DELTA-INVALID/);
  });

  it('only accepts gauge names for set() and timer names for recordDuration()', () => {
    const registry = new MetricsRegistry();
    registry.set('drift_count', 7);
    expect(() => registry.set('successes' as never, 1)).toThrow(/LP-METRIC/);
    expect(() => registry.recordDuration(100, { workflow: 'apply' })).not.toThrow();
    const snapshot = registry.snapshot();
    expect(snapshot.find((entry) => entry.metric === 'drift_count')).toMatchObject({ total: 7 });
    expect(snapshot.find((entry) => entry.metric === 'duration_ms')).toMatchObject({ total: 100 });
  });

  it('errorRate reports failures over the live window without resetting', () => {
    const registry = new MetricsRegistry();
    registry.increment('successes');
    registry.increment('successes');
    registry.increment('failures');
    expect(registry.errorRate()).toBeCloseTo(1 / 3, 5);
    registry.reset();
    expect(registry.errorRate()).toBe(0);
  });

  it('snapshot clears the window so consecutive snapshots do not double count', () => {
    const registry = new MetricsRegistry({ now: () => new Date('2026-08-04T00:30:00.000Z') });
    registry.increment('failures');
    const first = registry.snapshot();
    registry.increment('failures');
    const second = registry.snapshot();
    expect(first.find((entry) => entry.metric === 'failures')?.total).toBe(1);
    expect(second.find((entry) => entry.metric === 'failures')?.total).toBe(1);
  });
});
