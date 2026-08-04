import { expect, it } from 'vitest';
import { SensitiveValue, redactValue } from '@launchpad/shared';
import { artifactFiles, renderStickyComment } from '@launchpad/github-reporting';
import type { PlatformPlan } from '@launchpad/core';

const secret = 'launchpad-canary-secret-7f1d';
const plan: PlatformPlan = { schemaVersion: 'launchpad.plan/v1', applicationId: 'app', desiredGeneration: 1, sourceCommit: 'a'.repeat(40), createdAt: '2026-08-04T00:00:00.000Z', capabilitySnapshotHash: 'cap', observedStateHash: 'obs', operations: [], downstreamEffects: [], policyResults: [], fingerprint: 'f'.repeat(64), result: 'READY' };

it('does not serialize SensitiveValue or leak provider artifacts', () => {
  const sensitive = new SensitiveValue(secret);
  expect(() => JSON.stringify({ sensitive })).toThrow();
  const artifacts = artifactFiles({ plan, preview: { state: 'READY', url: null, message: 'ok' }, health: { state: 'PASSED', message: 'ok' }, providerState: redactValue({ database: sensitive }), logs: [`token=${secret}`] });
  const comment = renderStickyComment({ plan, preview: { state: 'READY', url: null, message: `token=${secret}` }, health: { state: 'PASSED', message: `secret=${secret}` } });
  for (const value of Object.values(artifacts)) expect(value).not.toContain(secret);
  expect(comment).not.toContain(secret);
});
