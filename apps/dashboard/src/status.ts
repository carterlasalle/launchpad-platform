// Status dimensions stay strictly separated (NFR-UX-003): sync, health,
// deployment and operation each have their own known-value set. A value from
// one dimension is NEVER accepted in another, and any value outside the known
// set classifies as UNKNOWN — the dashboard never invents a status.

export type StatusDimension = 'sync' | 'health' | 'deployment' | 'operation' | 'plan' | 'credential';
export type StatusTone = 'ok' | 'warn' | 'bad' | 'neutral';

const KNOWN_STATUS: Record<StatusDimension, ReadonlySet<string>> = {
  sync: new Set(['SYNCED', 'OUT_OF_SYNC', 'RECONCILING', 'BLOCKED', 'UNKNOWN', 'DECOMMISSIONING']),
  health: new Set(['HEALTHY', 'DEGRADED', 'UNHEALTHY', 'CHECKING', 'UNKNOWN']),
  deployment: new Set(['QUEUED', 'BUILDING', 'READY', 'ERROR', 'CANCELED', 'STAGED', 'CURRENT', 'REJECTED', 'ROLLED_BACK']),
  operation: new Set(['QUEUED', 'RUNNING', 'RETRYING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'ROLLED_BACK', 'SKIPPED']),
  plan: new Set(['READY', 'BLOCKED', 'DESTRUCTIVE']),
  credential: new Set(['VALID', 'EXPIRING_SOON', 'EXPIRED', 'REVOKED', 'UNKNOWN']),
};

const STATUS_TONES: Record<StatusDimension, Readonly<Record<string, StatusTone>>> = {
  sync: { SYNCED: 'ok', OUT_OF_SYNC: 'warn', RECONCILING: 'warn', BLOCKED: 'bad', UNKNOWN: 'neutral', DECOMMISSIONING: 'neutral' },
  health: { HEALTHY: 'ok', DEGRADED: 'warn', UNHEALTHY: 'bad', CHECKING: 'neutral', UNKNOWN: 'neutral' },
  deployment: { CURRENT: 'ok', READY: 'ok', STAGED: 'ok', BUILDING: 'neutral', QUEUED: 'neutral', CANCELED: 'bad', ERROR: 'bad', REJECTED: 'bad', ROLLED_BACK: 'bad' },
  operation: { SUCCEEDED: 'ok', RUNNING: 'neutral', QUEUED: 'neutral', RETRYING: 'warn', FAILED: 'bad', BLOCKED: 'bad', ROLLED_BACK: 'bad', SKIPPED: 'neutral' },
  plan: { READY: 'ok', BLOCKED: 'bad', DESTRUCTIVE: 'bad' },
  credential: { VALID: 'ok', EXPIRING_SOON: 'warn', EXPIRED: 'bad', REVOKED: 'bad', UNKNOWN: 'neutral' },
};

export interface ClassifiedStatus {
  known: boolean;
  label: string;
  tone: StatusTone;
}

export function classifyStatus(dimension: StatusDimension, value: string | null | undefined): ClassifiedStatus {
  const normalized = (value ?? '').trim().toUpperCase();
  const known = KNOWN_STATUS[dimension];
  if (known === undefined || !known.has(normalized)) return { known: false, label: 'UNKNOWN', tone: 'neutral' };
  const tone = STATUS_TONES[dimension]?.[normalized] ?? 'neutral';
  return { known: true, label: normalized.replaceAll('_', ' '), tone };
}
