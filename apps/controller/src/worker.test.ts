import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class WorkflowEntrypoint {
    readonly env: unknown;
    constructor(_context: unknown, env: unknown) { this.env = env; }
  },
}));

import worker from './worker.js';

describe('worker secret resolution', () => {
  it('resolves Secrets Store bindings for every event so rotations take effect without a deploy', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce('operator-token-before-rotation')
      .mockResolvedValueOnce('operator-token-after-rotation');
    const env = { SECRETS_OPERATOR_TOKEN: { get } } as never;

    expect((await worker.fetch(new Request('https://controller.test/healthz'), env, {} as never)).status).toBe(200);
    expect((await worker.fetch(new Request('https://controller.test/healthz'), env, {} as never)).status).toBe(200);
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe('worker automatic reconciliation gate', () => {
  it('does not start scheduled reconciliation unless runtime control plane is explicitly enabled', async () => {
    await expect(worker.scheduled({} as never, { LAUNCHPAD_CONTROL_PLANE_ENABLED: 'false', LAUNCHPAD_ALERTS_ENABLED: 'false' } as never)).resolves.toBeUndefined();
    await expect(worker.scheduled({} as never, { LAUNCHPAD_CONTROL_PLANE_ENABLED: 'true', LAUNCHPAD_ALERTS_ENABLED: 'false' } as never)).rejects.toThrow('LP-RECONCILIATION-WORKFLOW-BINDING-MISSING');
  });
});
