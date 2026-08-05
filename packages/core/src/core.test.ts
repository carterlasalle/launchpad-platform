import { describe, expect, it } from 'vitest';
import { buildPlan, canonicalEqual, canonicalPlanInput, createPlatformError, deploymentStatus, desiredStateHash, healthStatus, planReviewFingerprint, syncStatus, type DesiredApplication, type PlatformError, type PlatformPlan } from './index.js';
import { capabilities, desired, minimalObserved } from './fixtures.js';

describe('core domain primitives', () => {
  it('canonicalizes plan inputs without timestamps', () => {
    const input = canonicalPlanInput({
      desired: { applicationId: 'app', generation: 2 },
      observed: { resourceIds: ['b', 'a'] },
      capabilities: { vercel: ['rootDirectory'] },
      policy: { allowDestroy: false },
    });
    expect(input).toBe('{"capabilities":{"vercel":["rootDirectory"]},"desired":{"applicationId":"app","generation":2},"observed":{"resourceIds":["b","a"]},"policy":{"allowDestroy":false}}');
  });

  it('compares values canonically: key order ignored, array order significant', () => {
    expect(canonicalEqual({ b: 1, a: { y: true, x: null } }, { a: { x: null, y: true }, b: 1 })).toBe(true);
    expect(canonicalEqual(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(canonicalEqual('a', 'a')).toBe(true);
    expect(canonicalEqual(null, undefined)).toBe(false);
    expect(canonicalEqual({ rootDirectory: '.' }, { rootDirectory: 'apps/web' })).toBe(false);
  });

  it('compares undefined leaves deterministically without weakening strict serialization', () => {
    expect(canonicalEqual(undefined, undefined)).toBe(true);
    expect(canonicalEqual(undefined, null)).toBe(false);
    expect(canonicalEqual(undefined, false)).toBe(false);
    expect(canonicalEqual({ skewProtection: undefined }, { skewProtection: undefined })).toBe(true);
    expect(canonicalEqual({ skewProtection: undefined }, { skewProtection: false })).toBe(false);
    expect(canonicalEqual({ skewProtection: undefined }, {})).toBe(false);
    expect(canonicalEqual([undefined, 1], [undefined, 1])).toBe(true);
    expect(canonicalEqual([undefined, 1], [null, 1])).toBe(false);
    // Persisted/fingerprinted payloads still reject undefined.
    expect(() => canonicalPlanInput({ value: undefined })).toThrow(/undefined/);
  });

  it('creates serializable typed errors with safe details', () => {
    const error: PlatformError = createPlatformError({
      code: 'LP-PLAN-STALE',
      class: 'STALE_PLAN',
      message: 'The approved plan is stale.',
      remediation: 'Re-run planning.',
      retryable: false,
      safeDetails: { applicationId: 'app' },
    });
    expect(error.code).toBe('LP-PLAN-STALE');
    expect(error.retryable).toBe(false);
    expect(error.provider).toBeNull();
    expect(error.causeFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('keeps synchronization, health, and deployment status separate', () => {
    expect(syncStatus('desired-hash', 'observed-hash')).toBe('OUT_OF_SYNC');
    expect(syncStatus('same', 'same')).toBe('SYNCED');
    expect(deploymentStatus('ERROR')).toBe('ERROR');
    expect(healthStatus(true)).toBe('HEALTHY');
    expect(healthStatus(null)).toBe('UNKNOWN');
  });
});

describe('plan review fingerprint', () => {
  it('is source-commit neutral: identical plan content at different commits fingerprints identically', async () => {
    const prHead = await buildPlan({ desired, observed: minimalObserved(), capabilities, sourceCommit: 'a'.repeat(40), desiredGeneration: 1, now: '2026-08-04T00:00:00.000Z' });
    const merged = await buildPlan({ desired, observed: minimalObserved(), capabilities, sourceCommit: 'b'.repeat(40), desiredGeneration: 1, now: '2026-08-05T00:00:00.000Z' });
    expect(prHead.fingerprint).not.toBe(merged.fingerprint);
    expect(await planReviewFingerprint(prHead)).toBe(await planReviewFingerprint(merged));
  });

  it('changes when desired state, generation, or provider state changes', async () => {
    const base = await buildPlan({ desired, observed: minimalObserved(), capabilities, sourceCommit: 'a'.repeat(40), desiredGeneration: 1, now: '2026-08-04T00:00:00.000Z' });
    const changedDesired = await buildPlan({ desired: { ...desired, vercel: { ...desired.vercel, project: { ...desired.vercel.project, framework: 'remix' } } } as DesiredApplication, observed: minimalObserved(), capabilities, sourceCommit: 'a'.repeat(40), desiredGeneration: 1, now: '2026-08-04T00:00:00.000Z' });
    const changedGeneration = await buildPlan({ desired, observed: minimalObserved(), capabilities, sourceCommit: 'a'.repeat(40), desiredGeneration: 2, now: '2026-08-04T00:00:00.000Z' });
    const drifted = await buildPlan({ desired, observed: minimalObserved('app', 'apps/web'), capabilities, sourceCommit: 'a'.repeat(40), desiredGeneration: 1, now: '2026-08-04T00:00:00.000Z' });
    const review = await planReviewFingerprint(base);
    expect(await planReviewFingerprint(changedDesired)).not.toBe(review);
    expect(await planReviewFingerprint(changedGeneration)).not.toBe(review);
    expect(await planReviewFingerprint(drifted)).not.toBe(review);
    expect(JSON.stringify(base)).not.toContain('infisical://');
  });

  it('never carries raw secret values in the desired-state hash', async () => {
    const secretValue = 'super-secret-value';
    const withSecret: DesiredApplication = { ...desired, secrets: [{ name: 'API_KEY', value: secretValue, environments: ['production'] }] };
    const hash = await desiredStateHash(withSecret);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(secretValue);
    const same = await desiredStateHash({ ...withSecret, metadata: { ...withSecret.metadata } });
    expect(same).toBe(hash);
    const rotated = await desiredStateHash({ ...withSecret, secrets: [{ name: 'API_KEY', value: 'rotated-value', environments: ['production'] }] });
    expect(rotated).not.toBe(hash);
    expect(await desiredStateHash(desired)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats a plan-shaped fingerprint input consistently for blocked plans', async () => {
    const blocked: PlatformPlan = {
      schemaVersion: 'launchpad.plan/v1', applicationId: 'app', desiredGeneration: 1, sourceCommit: 'a'.repeat(40),
      createdAt: '2026-08-04T00:00:00.000Z', capabilitySnapshotHash: 'ch', observedStateHash: 'sh', fingerprint: 'fp',
      result: 'BLOCKED', blockedReason: 'BLOCKED_MISSING_MANIFEST', operations: [], downstreamEffects: [], policyResults: [],
      layers: [], drift: null,
    };
    const sameCommit = { ...blocked, sourceCommit: 'b'.repeat(40) };
    expect(await planReviewFingerprint(blocked)).toBe(await planReviewFingerprint(sameCommit));
    expect(await planReviewFingerprint({ ...blocked, desiredGeneration: 2 })).not.toBe(await planReviewFingerprint(blocked));
  });
});
