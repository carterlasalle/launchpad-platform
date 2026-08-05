import { stableId } from './ids.js';

/**
 * Alert configuration, attempts, and dedupe/cooldown decisions for the
 * control plane. Decisions are pure and durable: the caller persists
 * `lastFiredAt` through the incident store, so dedupe survives restarts.
 * Delivery failures are recorded on the incident row so a sink that stops
 * working is itself visible.
 */

export const ALERT_TYPES = ['DLQ', 'RECONCILIATION_FAILURE', 'CREDENTIAL_EXPIRY', 'CONTROLLER_ERROR_RATE'] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export type AlertSeverity = 'warning' | 'critical';

export interface AlertConfig {
  type: AlertType;
  enabled: boolean;
  /** Minimum seconds between two firings of the same fingerprint. */
  cooldownSeconds: number;
  /** Type-specific threshold (error rate, consecutive failures); null when not applicable. */
  threshold: number | null;
}

export const DEFAULT_ALERT_COOLDOWN_SECONDS = 3600;
export const DEFAULT_CREDENTIAL_EXPIRY_WINDOW_DAYS = 14;
export const DEFAULT_CONTROLLER_ERROR_RATE_THRESHOLD = 0.1;

export function defaultAlertConfigs(): AlertConfig[] {
  return [
    { type: 'DLQ', enabled: true, cooldownSeconds: DEFAULT_ALERT_COOLDOWN_SECONDS, threshold: null },
    { type: 'RECONCILIATION_FAILURE', enabled: true, cooldownSeconds: DEFAULT_ALERT_COOLDOWN_SECONDS, threshold: 3 },
    { type: 'CREDENTIAL_EXPIRY', enabled: true, cooldownSeconds: DEFAULT_ALERT_COOLDOWN_SECONDS, threshold: null },
    { type: 'CONTROLLER_ERROR_RATE', enabled: true, cooldownSeconds: DEFAULT_ALERT_COOLDOWN_SECONDS, threshold: DEFAULT_CONTROLLER_ERROR_RATE_THRESHOLD },
  ];
}

export function alertConfigFor(configs: readonly AlertConfig[], type: AlertType): AlertConfig | null {
  return configs.find((config) => config.type === type) ?? null;
}

/** Deterministic dedupe key: one incident row per (type, fingerprint). */
export function alertFingerprint(type: AlertType, ...parts: Array<string | number | null | undefined>): string {
  return stableId('alert', type, ...parts.map((part) => (part === null || part === undefined ? '' : String(part))));
}

export interface AlertAttempt {
  type: AlertType;
  fingerprint: string;
  severity: AlertSeverity;
  message: string;
  applicationId?: string | null;
  operationId?: string | null;
  details?: Record<string, unknown>;
  at: Date;
}

/** Durable state consulted for dedupe: the most recent firing of the fingerprint. */
export interface PreviousAlertState {
  lastFiredAt: string | null;
  resolvedAt: string | null;
}

export type AlertDecision =
  | { fire: true; reason: 'firing' }
  | { fire: false; reason: 'disabled' | 'cooldown-active' | 'below-threshold' };

/**
 * Decides whether an alert attempt fires. Fire only when the alert type is
 * enabled and the same fingerprint has not fired within its cooldown window.
 * A resolved incident is reopened on the next fire (the caller upserts the
 * row and clears `resolvedAt`).
 */
export function decideAlert(attempt: AlertAttempt, config: AlertConfig, previous: PreviousAlertState | null, now: Date): AlertDecision {
  if (!config.enabled) return { fire: false, reason: 'disabled' };
  if (previous?.lastFiredAt) {
    const lastFired = Date.parse(previous.lastFiredAt);
    if (Number.isFinite(lastFired) && now.getTime() - lastFired < config.cooldownSeconds * 1000) {
      return { fire: false, reason: 'cooldown-active' };
    }
  }
  return { fire: true, reason: 'firing' };
}
