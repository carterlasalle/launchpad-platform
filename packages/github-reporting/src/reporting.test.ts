import { expect, it } from 'vitest';
import { artifactFiles, renderStickyComment } from './index.js';
import type { PlatformPlan } from '@launchpad/core';

const plan: PlatformPlan = { schemaVersion: 'launchpad.plan/v1', applicationId: 'app', desiredGeneration: 2, sourceCommit: 'a'.repeat(40), createdAt: '2026-08-04T00:00:00.000Z', capabilitySnapshotHash: 'capabilities', observedStateHash: 'observed', operations: [{ id: '1', resourceKey: 'vercel.project', provider: 'vercel', resourceType: 'project', action: 'UPDATE_IN_PLACE', before: { rootDirectory: '.' }, after: { rootDirectory: 'apps/web' }, prerequisites: [], invalidates: [], idempotencyKey: 'key', destructive: false, retryClass: 'NONE' }], downstreamEffects: [{ resourceKey: 'production.candidate', action: 'REDEPLOY_REQUIRED', reason: 'root directory changed', severity: 'INFO' }], policyResults: [{ rule: 'policy', result: 'PASS', message: 'ok', remediation: null }], fingerprint: 'f'.repeat(64), result: 'READY' };

it('renders one stable sticky comment with escaped provider text', () => {
  const body = renderStickyComment({ plan, preview: { state: 'ERROR', url: 'https://preview.example', message: '<script>alert(1)</script>' }, health: { state: 'FAILED', message: 'body mismatch' } });
  expect(body).toContain('<!-- launchpad:plan -->');
  expect(body).toContain('sha256:');
  expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(body).not.toContain('<script>');
});

it('creates redacted machine-readable artifacts', () => {
  const artifacts = artifactFiles({ plan, preview: { state: 'READY', url: 'https://preview.example', message: 'ok' }, health: { state: 'PASSED', message: 'ok' }, providerState: { secret: '[REDACTED]' }, logs: ['ok'] });
  expect(Object.keys(artifacts)).toEqual(expect.arrayContaining(['plan.json', 'plan.md', 'resource-graph.json', 'preview-summary.json', 'health-results.json', 'build-log-tail.txt']));
  expect(artifacts['plan.json']).toContain('"fingerprint"');
  expect(artifacts['build-log-tail.txt']).toBe('ok');
});
