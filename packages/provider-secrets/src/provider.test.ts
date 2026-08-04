import { expect, it } from 'vitest';
import { EnvironmentSecretProvider } from './index.js';
import type { ProviderContext } from '@launchpad/provider-contract';

const ctx: ProviderContext = { correlationId: 'corr', applicationId: 'app', workflowId: 'wf', actor: { kind: 'system', id: 'test' }, dryRun: false };

it('resolves env references without exposing values in fingerprints', async () => {
  const provider = new EnvironmentSecretProvider({ DATABASE_URL: 'postgres://secret' });
  const value = await provider.resolve('env://DATABASE_URL', ctx);
  expect(value.reveal()).toBe('postgres://secret');
  expect(await provider.fingerprint('env://DATABASE_URL', ctx)).toMatch(/^[0-9a-f]{16}$/);
});
