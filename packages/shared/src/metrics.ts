/**
 * Bounded metrics registry for the control plane.
 *
 * Every metric has a fixed name and a fixed label shape (provider + workflow
 * from bounded enums); unknown names or label keys throw. The registry keeps
 * counters/timers/gauges in memory and produces snapshots that are persisted
 * to D1 (`metric_snapshots`) — never per-request label series, so storage and
 * queries stay bounded.
 */

export type MetricProvider = 'github' | 'vercel' | 'cloudflare' | 'secrets' | 'platform' | 'other';
export type MetricWorkflow = 'apply' | 'preview' | 'app-preview' | 'reconcile' | 'decommission' | 'health-check' | 'provider-event' | 'webhook' | 'scheduled' | 'other';

export const METRIC_PROVIDERS: readonly MetricProvider[] = ['github', 'vercel', 'cloudflare', 'secrets', 'platform', 'other'];
export const METRIC_WORKFLOWS: readonly MetricWorkflow[] = ['apply', 'preview', 'app-preview', 'reconcile', 'decommission', 'health-check', 'provider-event', 'webhook', 'scheduled', 'other'];

export type MetricKind = 'counter' | 'timer' | 'gauge' | 'rate';

export const METRIC_DEFINITIONS = {
  successes: { kind: 'counter' },
  failures: { kind: 'counter' },
  retries: { kind: 'counter' },
  duration_ms: { kind: 'timer' },
  drift_count: { kind: 'gauge' },
  preview_cleanup_backlog: { kind: 'gauge' },
  preview_cleanup_failures: { kind: 'counter' },
  rollback_count: { kind: 'counter' },
  dlq_count: { kind: 'counter' },
  provider_error_rate: { kind: 'rate' },
} as const satisfies Record<string, { kind: MetricKind }>;

export type MetricName = keyof typeof METRIC_DEFINITIONS;
export type CounterMetricName = { [K in MetricName]: (typeof METRIC_DEFINITIONS)[K]['kind'] extends 'counter' ? K : never }[MetricName];
export type GaugeMetricName = { [K in MetricName]: (typeof METRIC_DEFINITIONS)[K]['kind'] extends 'gauge' ? K : never }[MetricName];
export type RateMetricName = { [K in MetricName]: (typeof METRIC_DEFINITIONS)[K]['kind'] extends 'rate' ? K : never }[MetricName];

/** Fixed, bounded label shape. No free-form or per-request label keys. */
export interface MetricLabels {
  provider?: MetricProvider;
  workflow?: MetricWorkflow;
}

const LABEL_KEYS = ['provider', 'workflow'] as const;

/** Maps a workflow/kind string onto the bounded workflow label set. */
export function metricWorkflowOf(kind: string | null | undefined): MetricWorkflow {
  switch (kind) {
    case 'apply': return 'apply';
    case 'preview':
    case 'app-preview':
    case 'app-preview-status': return 'app-preview';
    case 'reconcile': return 'reconcile';
    case 'decommission': return 'decommission';
    case 'health-check': return 'health-check';
    case 'provider-event': return 'provider-event';
    case 'webhook': return 'webhook';
    case 'scheduled': return 'scheduled';
    default: return 'other';
  }
}

function labelKey(labels: MetricLabels | undefined): string {
  if (!labels) return '';
  for (const key of Object.keys(labels)) {
    if (!(LABEL_KEYS as readonly string[]).includes(key)) {
      throw new RangeError(`LP-METRIC-LABEL-INVALID: '${key}' is not a bounded metric label key.`);
    }
  }
  for (const key of LABEL_KEYS) {
    if (labels[key] !== undefined && labels[key] !== null) {
      const value = labels[key] as string;
      const allowed = key === 'provider' ? METRIC_PROVIDERS : METRIC_WORKFLOWS;
      if (!allowed.includes(value as never)) {
        throw new RangeError(`LP-METRIC-LABEL-INVALID: '${value}' is not a bounded ${key} label.`);
      }
    }
  }
  return `${labels.provider ?? '*'}|${labels.workflow ?? '*'}`;
}

interface Series {
  total: number;
  count: number;
}

export interface MetricSnapshot {
  metric: MetricName;
  kind: MetricKind;
  /** Persisted label set; bounded by construction. */
  labels: MetricLabels;
  /** Counters/gauges: current total. Timers: accumulated milliseconds. */
  total: number;
  /** Number of recorded samples (counters/gauges: 1 per update; timers: number of durations). */
  count: number;
  /**
   * Derived rate: timers expose ms/second of the window; the computed
   * `provider_error_rate` exposes failures/(successes+failures). Null when
   * not derivable for the metric kind.
   */
  rate: number | null;
  windowSeconds: number;
  capturedAt: string;
}

export class MetricsRegistry {
  readonly #series = new Map<string, Map<string, Series>>();
  readonly #now: () => Date;
  #windowStartedAt: number;

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#windowStartedAt = this.#now().getTime();
  }

  private series(metric: MetricName, labels: MetricLabels | undefined): Series {
    const byLabels = this.#series.get(metric) ?? new Map<string, Series>();
    this.#series.set(metric, byLabels);
    const key = labelKey(labels);
    const existing = byLabels.get(key);
    if (existing) return existing;
    const created: Series = { total: 0, count: 0 };
    byLabels.set(key, created);
    return created;
  }

  private requireKind(metric: string, kind: MetricKind): void {
    const definition = METRIC_DEFINITIONS[metric as MetricName];
    if (!definition || definition.kind !== kind) {
      throw new RangeError(`LP-METRIC-KIND-INVALID: '${metric}' is not a ${kind} metric.`);
    }
  }

  /** Increments a counter metric by `by` (default 1). */
  increment(metric: CounterMetricName, labels: MetricLabels = {}, by = 1): void {
    this.requireKind(metric, 'counter');
    if (!Number.isFinite(by) || by < 0) throw new RangeError('LP-METRIC-DELTA-INVALID: increments must be non-negative finite numbers.');
    const series = this.series(metric, labels);
    series.total += by;
    series.count += 1;
  }

  /** Sets a gauge metric to `value`. */
  set(metric: GaugeMetricName, value: number, labels: MetricLabels = {}): void {
    this.requireKind(metric, 'gauge');
    if (!Number.isFinite(value) || value < 0) throw new RangeError('LP-METRIC-GAUGE-INVALID: gauges must be non-negative finite numbers.');
    const series = this.series(metric, labels);
    series.total = value;
    series.count = 1;
  }

  /** Records one duration sample in milliseconds. */
  recordDuration(milliseconds: number, labels: MetricLabels = {}): void {
    this.requireKind('duration_ms', 'timer');
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new RangeError('LP-METRIC-DURATION-INVALID: durations must be non-negative finite numbers.');
    const series = this.series('duration_ms', labels);
    series.total += milliseconds;
    series.count += 1;
  }

  /**
   * Produces the bounded snapshot of every tracked series since the last
   * window (or registry creation). Rates: timers expose ms/second; the
   * derived `provider_error_rate` is computed from the successes/failures
   * totals of the window. Resets the window so consecutive snapshots are
   * non-overlapping.
   */
  snapshot(): MetricSnapshot[] {
    const now = this.#now();
    const windowSeconds = Math.max(1, Math.round((now.getTime() - this.#windowStartedAt) / 1000));
    const snapshots: MetricSnapshot[] = [];
    let failureTotal = 0;
    let successTotal = 0;
    for (const [metric, byLabels] of this.#series) {
      if (metric === 'provider_error_rate') continue; // derived below
      const kind = METRIC_DEFINITIONS[metric as MetricName].kind;
      for (const [key, series] of byLabels) {
        if (metric === 'failures') failureTotal += series.total;
        if (metric === 'successes') successTotal += series.total;
        const [provider, workflow] = key.split('|');
        const labels: MetricLabels = {};
        if (provider !== '*') labels.provider = provider as MetricProvider;
        if (workflow !== '*') labels.workflow = workflow as MetricWorkflow;
        const rate = kind === 'timer' && windowSeconds > 0 ? series.total / windowSeconds : null;
        snapshots.push({ metric: metric as MetricName, kind, labels, total: series.total, count: series.count, rate, windowSeconds, capturedAt: now.toISOString() });
      }
    }
    const denominator = failureTotal + successTotal;
    if (denominator > 0) {
      snapshots.push({ metric: 'provider_error_rate', kind: 'rate', labels: {}, total: failureTotal, count: denominator, rate: failureTotal / denominator, windowSeconds, capturedAt: now.toISOString() });
    }
    // Reset series for the next window; provider_error_rate is recomputed
    // per window from the same counters.
    this.#series.clear();
    this.#windowStartedAt = now.getTime();
    return snapshots;
  }

  /** Current failure rate over the live window (failures / (successes + failures)), 0 when empty. */
  errorRate(): number {
    const failures = this.#series.get('failures');
    const successes = this.#series.get('successes');
    const failureTotal = failures ? [...failures.values()].reduce((sum, series) => sum + series.total, 0) : 0;
    const successTotal = successes ? [...successes.values()].reduce((sum, series) => sum + series.total, 0) : 0;
    return failureTotal + successTotal > 0 ? failureTotal / (failureTotal + successTotal) : 0;
  }

  reset(): void {
    this.#series.clear();
    this.#windowStartedAt = this.#now().getTime();
  }
}
