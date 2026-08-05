import { describe, expect, it } from 'vitest';
import { decideAlert, alertFingerprint, defaultAlertConfigs, type AlertAttempt } from './index.js';

const T0 = new Date('2026-08-04T00:00:00.000Z');

function attempt(overrides: Partial<AlertAttempt> = {}): AlertAttempt {
  return { type: 'DLQ', fingerprint: 'queue:msg-1', severity: 'critical', message: 'message dropped', at: T0, ...overrides };
}

describe('decideAlert', () => {
  it('fires when enabled with no previous firing', () => {
    const config = defaultAlertConfigs()[0]!;
    expect(decideAlert(attempt(), config, null, T0)).toEqual({ fire: true, reason: 'firing' });
  });

  it('deduplicates within the cooldown window', () => {
    const config = defaultAlertConfigs()[0]!;
    const previous = { lastFiredAt: T0.toISOString(), resolvedAt: null };
    const later = new Date(T0.getTime() + 60_000);
    expect(decideAlert(attempt({ at: later }), config, previous, later)).toEqual({ fire: false, reason: 'cooldown-active' });
  });

  it('refires after the cooldown window elapses', () => {
    const config = defaultAlertConfigs()[0]!;
    const previous = { lastFiredAt: T0.toISOString(), resolvedAt: null };
    const later = new Date(T0.getTime() + defaultAlertConfigs()[0]!.cooldownSeconds * 1000 + 1);
    expect(decideAlert(attempt({ at: later }), config, previous, later)).toEqual({ fire: true, reason: 'firing' });
  });

  it('never fires when disabled', () => {
    const config = { ...defaultAlertConfigs()[0]!, enabled: false };
    expect(decideAlert(attempt(), config, null, T0)).toEqual({ fire: false, reason: 'disabled' });
  });

  it('reopens a resolved incident on the next firing', () => {
    const config = defaultAlertConfigs()[0]!;
    const previous = { lastFiredAt: T0.toISOString(), resolvedAt: '2026-08-04T01:00:00.000Z' };
    const later = new Date(T0.getTime() + config.cooldownSeconds * 1000 + 1);
    expect(decideAlert(attempt({ at: later }), config, previous, later)).toEqual({ fire: true, reason: 'firing' });
  });

  it('fingerprints are deterministic per type and parts', () => {
    expect(alertFingerprint('DLQ', 'launchpad-provider-events', 'msg-1')).toBe(alertFingerprint('DLQ', 'launchpad-provider-events', 'msg-1'));
    expect(alertFingerprint('DLQ', 'queue', 'msg-1')).not.toBe(alertFingerprint('CREDENTIAL_EXPIRY', 'queue', 'msg-1'));
    expect(alertFingerprint('DLQ', 'queue', null)).toBe(alertFingerprint('DLQ', 'queue', undefined));
  });
});
