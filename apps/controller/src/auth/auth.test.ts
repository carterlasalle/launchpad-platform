import { expect, it } from 'vitest';
import { verifyGithubOidc } from './oidc.js';
import { verifyWebhookSignature } from './webhooks.js';

it('rejects missing or malformed OIDC tokens', async () => {
  await expect(verifyGithubOidc(null, { issuer: 'https://issuer.test', audience: 'launchpad', jwks: 'https://issuer.test/jwks' })).rejects.toThrow(/OIDC bearer token/);
});

it('accepts a correctly signed webhook and rejects a tampered payload', async () => {
  const payload = '{"id":"event-1"}';
  const secret = 'webhook-secret';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  const signature = `sha256=${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  await expect(verifyWebhookSignature(payload, signature, secret)).resolves.toBe(true);
  await expect(verifyWebhookSignature(`${payload}!`, signature, secret)).resolves.toBe(false);
});
