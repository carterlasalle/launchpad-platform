import { expect, it } from 'vitest';
import { createControllerApp } from './api.js';

it('serves health and rejects protected routes without operator authentication', async () => {
  const app = createControllerApp({ operatorToken: 'operator-token' });
  const health = await app.request('/healthz');
  expect(health.status).toBe(200);
  const applications = await app.request('/v1/applications');
  expect(applications.status).toBe(401);
  const authorized = await app.request('/v1/applications', { headers: { authorization: 'Bearer operator-token' } });
  expect(authorized.status).toBe(200);
  await expect(authorized.json()).resolves.toEqual({ applications: [] });
});

it('requires OIDC bearer authentication for workflow endpoints', async () => {
  const app = createControllerApp({ operatorToken: 'operator-token', oidc: { issuer: 'https://issuer.test', audience: 'launchpad', jwks: 'https://issuer.test/jwks' } });
  const response = await app.request('/v1/plans/verify', { method: 'POST', body: JSON.stringify({ applicationId: 'app' }), headers: { 'content-type': 'application/json' } });
  expect(response.status).toBe(401);
});
