import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { D1LaunchpadStore, InMemoryDatabase, LaunchpadRepositories } from '@launchpad/database';
import { verifyGithubOidc } from './auth/oidc.js';
import { verifyWebhookSignature } from './auth/webhooks.js';
import { dashboardHtml } from './dashboard.js';
import type { ControllerEnv, OidcConfig } from './env.js';

export type WorkflowHandler = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
export interface ControllerDependencies { operatorToken: string; oidc?: OidcConfig | undefined; webhookSecret?: string | undefined; internalWorkflowToken?: string | undefined; repositories?: LaunchpadRepositories | undefined; store?: D1LaunchpadStore | undefined; workflowHandlers?: Record<string, WorkflowHandler> | undefined; }

function bearer(request: Request): string | null {
  const value = request.headers.get('authorization');
  return value?.startsWith('Bearer ') ? value.slice('Bearer '.length) : null;
}

function operatorMiddleware(dependencies: ControllerDependencies): MiddlewareHandler<ControllerEnv> {
  return async (context, next) => {
    if (!dependencies.operatorToken || bearer(context.req.raw) !== dependencies.operatorToken) return context.json({ error: 'operator authentication required' }, 401);
    await next();
  };
}

export function createControllerApp(dependencies: ControllerDependencies): Hono<ControllerEnv> {
  const repositories = dependencies.repositories ?? new LaunchpadRepositories(new InMemoryDatabase());
  const app = new Hono<ControllerEnv>();
  app.get('/healthz', (context) => context.json({ status: 'ok', service: 'launchpad-control-plane' }));
  app.get('/', (context) => new Response(dashboardHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
  app.use('/v1/applications/*', operatorMiddleware(dependencies));
  app.get('/v1/applications', operatorMiddleware(dependencies), async (context) => context.json({ applications: dependencies.store ? await dependencies.store.listApplications() : repositories.listApplications() }));
  app.get('/v1/applications/:id/audit', (context) => context.json({ applicationId: context.req.param('id'), events: repositories.listAudit(context.req.param('id')) }));
  app.get('/v1/applications/:id', (context) => context.json({ application: repositories.getApplication(context.req.param('id')), operations: repositories.listOperations(context.req.param('id')) }));
  app.get('/v1/applications/:id/resources', (context) => context.json({ applicationId: context.req.param('id'), resources: [] }));
  app.get('/v1/applications/:id/operations', (context) => context.json({ applicationId: context.req.param('id'), operations: repositories.listOperations(context.req.param('id')) }));
  app.get('/v1/applications/:id/deployments', (context) => context.json({ applicationId: context.req.param('id'), deployments: [] }));
  app.get('/v1/applications/:id/health', (context) => context.json({ applicationId: context.req.param('id'), checks: [] }));
  app.get('/v1/applications/:id/drift', (context) => context.json({ applicationId: context.req.param('id'), drift: [] }));
  app.post('/v1/applications/:id/changes/propose', async (context) => {
    const body = await context.req.json<{ payloadHash?: string }>();
    const operation = repositories.startOperation({ applicationId: context.req.param('id'), workflowId: crypto.randomUUID(), action: 'PROPOSE_CHANGE', idempotencyKey: context.req.header('idempotency-key') ?? crypto.randomUUID(), payloadHash: body.payloadHash ?? 'propose-change' });
    repositories.appendAudit({ actor: 'operator:dashboard', action: 'PROPOSE_CHANGE', applicationId: context.req.param('id'), details: { operationId: operation.id } });
    return context.json({ workflowId: operation.id, status: operation.status }, 202);
  });
  app.post('/v1/applications/:id/actions/retry', (context) => context.json({ workflowId: repositories.startOperation({ applicationId: context.req.param('id'), workflowId: crypto.randomUUID(), action: 'RETRY', idempotencyKey: context.req.header('idempotency-key') ?? crypto.randomUUID(), payloadHash: 'retry' }).id }, 202));
  app.post('/v1/applications/:id/actions/recheck', (context) => context.json({ workflowId: repositories.startOperation({ applicationId: context.req.param('id'), workflowId: crypto.randomUUID(), action: 'HEALTH_CHECK', idempotencyKey: context.req.header('idempotency-key') ?? crypto.randomUUID(), payloadHash: 'recheck' }).id }, 202));
  app.post('/v1/applications/:id/actions/rollback', (context) => context.json({ workflowId: repositories.startOperation({ applicationId: context.req.param('id'), workflowId: crypto.randomUUID(), action: 'ROLLBACK', idempotencyKey: context.req.header('idempotency-key') ?? crypto.randomUUID(), payloadHash: 'rollback' }).id }, 202));
  app.post('/v1/plans/verify', async (context) => {
    if (!dependencies.oidc) return context.json({ error: 'OIDC is not configured' }, 503);
    try { const claims = await verifyGithubOidc(bearer(context.req.raw), dependencies.oidc); return context.json({ verified: true, repository: claims.repository, sha: claims.sha ?? null }); } catch (error) { return context.json({ error: error instanceof Error ? error.message : 'OIDC verification failed' }, 401); }
  });
  app.post('/v1/applications/:id/preview/verify', async (context) => {
    if (!dependencies.oidc) return context.json({ error: 'OIDC is not configured' }, 503);
    try { await verifyGithubOidc(bearer(context.req.raw), dependencies.oidc); } catch (error) { return context.json({ error: error instanceof Error ? error.message : 'OIDC verification failed' }, 401); }
    const body = await context.req.json<Record<string, unknown>>();
    const handler = dependencies.workflowHandlers?.[body.desired ? 'preview' : 'app-preview'];
    if (handler) return context.json(await handler({ ...body, applicationId: context.req.param('id') }));
    const operation = repositories.startOperation({ applicationId: context.req.param('id'), workflowId: crypto.randomUUID(), action: 'PREVIEW', idempotencyKey: context.req.header('idempotency-key') ?? crypto.randomUUID(), payloadHash: 'preview' });
    return context.json({ workflowId: operation.id, status: operation.status }, 202);
  });

  app.post('/v1/applications/:id/apply', async (context) => {
    if (!dependencies.oidc) return context.json({ error: 'OIDC is not configured' }, 503);
    try { await verifyGithubOidc(bearer(context.req.raw), dependencies.oidc); } catch (error) { return context.json({ error: error instanceof Error ? error.message : 'OIDC verification failed' }, 401); }
    const body = await context.req.json<Record<string, unknown>>();
    const handler = dependencies.workflowHandlers?.apply;
    if (handler) return context.json(await handler({ ...body, applicationId: context.req.param('id') }));
    const operation = repositories.startOperation({ applicationId: context.req.param('id'), workflowId: crypto.randomUUID(), action: 'APPLY', idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : crypto.randomUUID(), payloadHash: typeof body.payloadHash === 'string' ? body.payloadHash : 'apply' });
    return context.json({ workflowId: operation.id, status: operation.status }, 202);
  });
  app.post('/v1/cli/:command', operatorMiddleware(dependencies), async (context) => {
    const operation = repositories.startOperation({ applicationId: 'platform', workflowId: crypto.randomUUID(), action: context.req.param('command').toUpperCase(), idempotencyKey: context.req.header('idempotency-key') ?? crypto.randomUUID(), payloadHash: 'cli' });
    return context.json({ workflowId: operation.id, status: operation.status }, 202);
  });
  app.post('/internal/workflows/:kind', async (context) => {
    const expected = dependencies.internalWorkflowToken;
    if (!expected || context.req.header('x-launchpad-workflow-token') !== expected) return context.json({ error: 'workflow authentication required' }, 401);
    const payload = await context.req.json<Record<string, unknown>>();
    const applicationId = typeof payload.applicationId === 'string' ? payload.applicationId : null;
    if (!applicationId) return context.json({ error: 'applicationId is required' }, 400);
    const handler = dependencies.workflowHandlers?.[context.req.param('kind')];
    if (handler) return context.json(await handler(payload));
    const operation = repositories.startOperation({ applicationId, workflowId: crypto.randomUUID(), action: context.req.param('kind').toUpperCase(), idempotencyKey: typeof payload.idempotencyKey === 'string' ? payload.idempotencyKey : crypto.randomUUID(), payloadHash: context.req.param('kind') });
    return context.json({ workflowId: operation.id, status: operation.status }, 202);
  });
  app.post('/webhooks/vercel', async (context) => {
    const body = await context.req.text();
    if (!(await verifyWebhookSignature(body, context.req.header('x-vercel-signature') ?? null, dependencies.webhookSecret))) return context.json({ error: 'invalid webhook signature' }, 401);
    return context.json({ accepted: true }, 202);
  });
  app.onError((error, context) => context.json({ error: error.message }, 500));
  app.notFound((context) => context.json({ error: 'not found' }, 404));
  return app;
}
