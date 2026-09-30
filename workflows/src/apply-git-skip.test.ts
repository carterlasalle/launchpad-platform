import { describe, expect, test } from 'vitest';
import { applyEnsureGit } from './apply-app.js';

// `git.connected: false` is a supported desired state: the application deploys
// via direct gitSource deployments and the Vercel project is intentionally not
// git-linked. ensure-git must skip (idempotent no-op) instead of demanding a
// link the API cannot set on an existing project (LP-VERCEL-GIT-CONNECTION-UNSUPPORTED).
describe('applyEnsureGit', () => {
  test('skips the git connection when git.connected is false', async () => {
    let called = false;
    const provider = {
      ensureGitConnection: async () => {
        called = true;
        throw new Error('must not be called');
      },
      observeProject: async () => null,
    };
    const store = {
      acquireLock: async () => true,
      renewLock: async () => true,
      releaseLock: async () => {},
    };
    const locks = { application: 'app', ownerId: 'owner', leaseSeconds: 60, domains: [] as string[] };
    const result = await applyEnsureGit({
      base: {} as never,
      store: store as never,
      provider: provider as never,
      desired: {
        metadata: { id: 'app' },
        repository: { name: 'acme/app', productionBranch: 'main' },
        vercel: { project: { name: 'app', framework: 'nextjs', rootDirectory: '.', nodeVersion: '24.x', build: { installCommand: 'yarn install', buildCommand: 'yarn build', outputDirectory: null, developmentCommand: null, ignoredBuildStep: null }, git: { connected: false, productionBranch: 'main' }, deployment: { autoAssignProductionDomains: false }, regions: { functions: [] }, protection: {}, settings: {} } },
      } as never,
      plan: {} as never,
      locks: locks as never,
      context: {} as never,
    });
    expect(called).toBe(false);
    expect(result.mutation.changed).toBe(false);
    expect(result.mutation.operationId).toContain('vercel-git-skip');
  });

  test('still ensures the git connection when git.connected is true', async () => {
    let called = false;
    const provider = {
      ensureGitConnection: async () => {
        called = true;
        return { changed: false, operationId: 'vercel-git-op', resource: {} };
      },
      observeProject: async () => ({ configuration: {} }),
    };
    const store = {
      acquireLock: async () => true,
      renewLock: async () => true,
      releaseLock: async () => {},
    };
    const locks = { application: 'app', ownerId: 'owner', leaseSeconds: 60, domains: [] as string[] };
    await applyEnsureGit({
      base: {} as never,
      store: store as never,
      provider: provider as never,
      desired: {
        metadata: { id: 'app' },
        repository: { name: 'acme/app', productionBranch: 'main' },
        vercel: { project: { name: 'app', framework: 'nextjs', rootDirectory: '.', nodeVersion: '24.x', build: { installCommand: 'yarn install', buildCommand: 'yarn build', outputDirectory: null, developmentCommand: null, ignoredBuildStep: null }, git: { connected: true, productionBranch: 'main' }, deployment: { autoAssignProductionDomains: false }, regions: { functions: [] }, protection: {}, settings: {} } },
      } as never,
      plan: {} as never,
      locks: locks as never,
      context: {} as never,
    });
    expect(called).toBe(true);
  });
});
