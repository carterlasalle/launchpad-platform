import { describe, expect, it } from 'vitest';
import { canonicalPlanInput, createPlatformError, deploymentStatus, syncStatus, type PlatformError } from './index.js';

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
  });
});
