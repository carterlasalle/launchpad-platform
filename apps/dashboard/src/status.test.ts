import { expect, it } from 'vitest';
import { classifyStatus } from './status.js';

it('keeps sync, health, deployment and operation statuses in separate dimensions', () => {
  expect(classifyStatus('sync', 'SYNCED').known).toBe(true);
  expect(classifyStatus('sync', 'OUT_OF_SYNC').known).toBe(true);
  expect(classifyStatus('health', 'HEALTHY').known).toBe(true);
  expect(classifyStatus('deployment', 'CURRENT').known).toBe(true);
  expect(classifyStatus('operation', 'FAILED').known).toBe(true);
  // A value from one dimension is never accepted in another.
  expect(classifyStatus('health', 'SYNCED').known).toBe(false);
  expect(classifyStatus('sync', 'HEALTHY').known).toBe(false);
  expect(classifyStatus('deployment', 'SUCCEEDED').known).toBe(false);
  expect(classifyStatus('operation', 'CURRENT').known).toBe(false);
  expect(classifyStatus('operation', 'READY').known).toBe(false);
});

it('renders unknown values as UNKNOWN without inventing a status', () => {
  expect(classifyStatus('sync', 'FANCY-NEW-STATUS')).toEqual({ known: false, label: 'UNKNOWN', tone: 'neutral' });
  expect(classifyStatus('health', null)).toEqual({ known: false, label: 'UNKNOWN', tone: 'neutral' });
  expect(classifyStatus('deployment', undefined)).toEqual({ known: false, label: 'UNKNOWN', tone: 'neutral' });
  expect(classifyStatus('operation', '')).toEqual({ known: false, label: 'UNKNOWN', tone: 'neutral' });
  expect(classifyStatus('health', '')).toEqual({ known: false, label: 'UNKNOWN', tone: 'neutral' });
});

it('assigns tones per dimension', () => {
  expect(classifyStatus('sync', 'SYNCED').tone).toBe('ok');
  expect(classifyStatus('sync', 'OUT_OF_SYNC').tone).toBe('warn');
  expect(classifyStatus('sync', 'BLOCKED').tone).toBe('bad');
  expect(classifyStatus('health', 'HEALTHY').tone).toBe('ok');
  expect(classifyStatus('health', 'DEGRADED').tone).toBe('warn');
  expect(classifyStatus('health', 'UNHEALTHY').tone).toBe('bad');
  expect(classifyStatus('deployment', 'ERROR').tone).toBe('bad');
  expect(classifyStatus('deployment', 'READY').tone).toBe('ok');
  expect(classifyStatus('operation', 'SUCCEEDED').tone).toBe('ok');
  expect(classifyStatus('operation', 'RETRYING').tone).toBe('warn');
  expect(classifyStatus('operation', 'BLOCKED').tone).toBe('bad');
});

it('normalizes known values without leaking raw casing into labels', () => {
  expect(classifyStatus('sync', 'out_of_sync')).toEqual({ known: true, label: 'OUT OF SYNC', tone: 'warn' });
  expect(classifyStatus('health', ' healthy ').label).toBe('HEALTHY');
});

it('classifies plan results and credential statuses in their own dimensions', () => {
  expect(classifyStatus('plan', 'READY')).toEqual({ known: true, label: 'READY', tone: 'ok' });
  expect(classifyStatus('plan', 'BLOCKED')).toEqual({ known: true, label: 'BLOCKED', tone: 'bad' });
  expect(classifyStatus('plan', 'DESTRUCTIVE')).toEqual({ known: true, label: 'DESTRUCTIVE', tone: 'bad' });
  expect(classifyStatus('plan', 'SYNCED').known).toBe(false);
  expect(classifyStatus('credential', 'VALID')).toEqual({ known: true, label: 'VALID', tone: 'ok' });
  expect(classifyStatus('credential', 'EXPIRING_SOON')).toEqual({ known: true, label: 'EXPIRING SOON', tone: 'warn' });
  expect(classifyStatus('credential', 'EXPIRED')).toEqual({ known: true, label: 'EXPIRED', tone: 'bad' });
  expect(classifyStatus('credential', 'REVOKED')).toEqual({ known: true, label: 'REVOKED', tone: 'bad' });
  expect(classifyStatus('credential', 'HEALTHY').known).toBe(false);
});

it('accepts the durable step status SKIPPED in the operation dimension', () => {
  expect(classifyStatus('operation', 'SKIPPED')).toEqual({ known: true, label: 'SKIPPED', tone: 'neutral' });
});
