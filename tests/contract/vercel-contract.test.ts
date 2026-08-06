import { expect, it } from 'vitest';
import { VercelAdapter } from '@launchpad/provider-vercel';
import { SensitiveValue } from '@launchpad/shared';
import type { ProjectSpec, ProviderContext } from '@launchpad/provider-contract';
import { CONTRACT_CANARY_BODY, CONTRACT_CANARY_TOKEN, expectRequest, loadScenarios, recordedTransport, type RecordedRequest, type RecordedStep } from '../fixtures/recorded-transport.js';

const ctx: ProviderContext = { correlationId: 'contract-corr', applicationId: 'app', workflowId: 'wf', actor: { kind: 'system', id: 'contract' }, dryRun: false };
const COMMIT = 'a'.repeat(40);
const BASE = 'https://api.vercel.test';
const CREATED_AT = 1782835200000;

const project: ProjectSpec = { id: 'app', name: 'app', teamId: null, framework: 'nextjs', rootDirectory: '.', nodeVersion: '24.x', build: { installCommand: 'yarn install', buildCommand: 'yarn build', outputDirectory: null }, repository: 'acme/app', productionBranch: 'main', settings: { autoAssignProductionDomains: false } };

function mount(steps: RecordedStep[]): { adapter: VercelAdapter; requests: RecordedRequest[] } {
  const transport = recordedTransport(steps);
  return { adapter: new VercelAdapter({ token: CONTRACT_CANARY_TOKEN, baseUrl: BASE, fetchImpl: transport.fetchImpl }), requests: transport.requests };
}

it('observes a project and returns null when it does not exist', async () => {
  const { adapter, requests } = mount(loadScenarios('vercel').observeProject);
  const observed = await adapter.observeProject({ projectId: 'app' }, ctx);
  expect(observed).toMatchObject({ provider: 'vercel', resourceType: 'vercel.project', resourceKey: 'app', providerResourceId: 'prj_1', ownershipFingerprint: 'prj_1' });
  expectRequest(requests, 'GET', '/v9/projects/app');
  const missing = mount(loadScenarios('vercel').observeProjectMissing);
  await expect(missing.adapter.observeProject({ projectId: 'app' }, ctx)).resolves.toBeNull();
});

it('creates a project with the official POST /v10/projects body', async () => {
  const { adapter, requests } = mount(loadScenarios('vercel').projectCreate);
  const result = await adapter.ensureProject(project, ctx);
  expect(result.resource.providerResourceId).toBe('prj_1');
  expect(result.changed).toBe(true);
  const create = expectRequest(requests, 'POST', '/v10/projects');
  expect(create.body).toEqual({
    name: 'app', framework: 'nextjs',
    installCommand: 'yarn install', buildCommand: 'yarn build', outputDirectory: null,
    autoAssignCustomDomains: false,
    gitRepository: { type: 'github', repo: 'acme/app' },
  });
  expect(create.headers['idempotency-key']).toBeDefined();
});

it('updates an existing project with PATCH and reports change via canonical readback', async () => {
  const changed = mount(loadScenarios('vercel').projectUpdate);
  const result = await changed.adapter.ensureProject(project, ctx);
  expect(result.changed).toBe(true);
  const patch = expectRequest(changed.requests, 'PATCH', '/v9/projects/prj_1');
  expect(patch.body).toMatchObject({ framework: 'nextjs', nodeVersion: '24.x', autoAssignCustomDomains: false });

  const noop = mount(loadScenarios('vercel').projectNoop);
  const unchanged = await noop.adapter.ensureProject(project, ctx);
  expect(unchanged.changed).toBe(false);
});

it('does not issue an invalid PATCH when the project is already Git-connected', async () => {
  const requests: string[] = [];
  const adapter = new VercelAdapter({
    token: 'token',
    baseUrl: 'https://vercel.sandbox.test',
    fetchImpl: async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ id: 'prj_1', link: { repo: 'acme/app', productionBranch: 'main' } }), { status: 200 });
    },
  });
  const result = await adapter.ensureGitConnection({ projectId: 'app', repository: 'acme/app', productionBranch: 'main' }, ctx);
  expect(result.changed).toBe(false);
  expect(result.resource.configuration).toEqual({ repository: 'acme/app', productionBranch: 'main' });
  expect(requests).toEqual(['https://vercel.sandbox.test/v9/projects/app']);
});

const DB_SECRET = 'postgres://contract-db-secret';
const TOKEN_SECRET = 'contract-token-secret';

it('reconciles every declared variable through the official env list/create/readback routes', async () => {
  const { adapter, requests } = mount(loadScenarios('vercel').environmentCreate);
  const result = await adapter.ensureEnvironment({ projectId: 'app', environment: 'production', branch: 'main', variables: { DATABASE_URL: new SensitiveValue(DB_SECRET), API_TOKEN: new SensitiveValue(TOKEN_SECRET) } }, ctx);
  expect(result.resource.resourceKey).toBe('app:production');
  expect(result.changed).toBe(true);
  expectRequest(requests, 'GET', '/v9/projects/app/env');
  const creates = requests.filter((request) => request.method === 'POST' && request.path === '/v10/projects/app/env');
  expect(creates).toHaveLength(2);
  expect(creates[0]!.body).toEqual({ key: 'DATABASE_URL', value: DB_SECRET, type: 'encrypted', target: ['production'], gitBranch: 'main' });
  expect(creates[1]!.body).toEqual({ key: 'API_TOKEN', value: TOKEN_SECRET, type: 'encrypted', target: ['production'], gitBranch: 'main' });
  expect(creates[0]!.headers['idempotency-key']).toBeDefined();
  // Every created variable is verified through the decrypt-capable single-env readback.
  expect(requests.filter((request) => request.method === 'GET' && request.path.startsWith('/v9/projects/app/env/env_'))).toHaveLength(2);
  // Raw values never appear in the serialized result (configuration is value-free).
  const resultJson = JSON.stringify(result);
  expect(resultJson).not.toContain(DB_SECRET);
  expect(resultJson).not.toContain(TOKEN_SECRET);
});

it('updates an existing variable with the official PATCH body and verifies the readback', async () => {
  const { adapter, requests } = mount(loadScenarios('vercel').environmentUpdate);
  const result = await adapter.ensureEnvironment({ projectId: 'app', environment: 'production', branch: 'main', variables: { DATABASE_URL: new SensitiveValue(DB_SECRET) } }, ctx);
  expect(result.changed).toBe(true);
  const patch = expectRequest(requests, 'PATCH', '/v9/projects/app/env/env_1');
  expect(patch.body).toEqual({ key: 'DATABASE_URL', value: DB_SECRET, type: 'encrypted', target: ['production'], gitBranch: 'main' });
  expect(patch.headers['idempotency-key']).toBeDefined();
  expect(requests.filter((request) => request.method === 'GET' && request.path === '/v9/projects/app/env/env_1')).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain(DB_SECRET);
});

it('replays an already-converged environment as a no-op with no writes', async () => {
  const { adapter, requests } = mount(loadScenarios('vercel').environmentNoop);
  const result = await adapter.ensureEnvironment({ projectId: 'app', environment: 'production', branch: 'main', variables: { DATABASE_URL: new SensitiveValue(DB_SECRET) } }, ctx);
  expect(result.changed).toBe(false);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ method: 'GET', path: '/v9/projects/app/env' });
  expect(JSON.stringify(result)).not.toContain(DB_SECRET);
});

it('fails closed with a typed non-leaking postcondition error when the readback mismatches', async () => {
  const { adapter } = mount(loadScenarios('vercel').environmentReadbackMismatch);
  await expect(adapter.ensureEnvironment({ projectId: 'app', environment: 'production', branch: 'main', variables: { DATABASE_URL: new SensitiveValue(DB_SECRET) } }, ctx)).rejects.toSatisfy((error: unknown) => {
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain(DB_SECRET);
    expect(serialized).not.toContain('provider-tampered-value');
    expect(error).toMatchObject({ code: 'LP-VERCEL-ENV-POSTCONDITION-FAILED', class: 'CONFLICT', retryable: false });
    return true;
  });
});

it('fails closed when the written variable cannot be read back', async () => {
  const { adapter } = mount(loadScenarios('vercel').environmentReadbackMissing);
  await expect(adapter.ensureEnvironment({ projectId: 'app', environment: 'production', branch: 'main', variables: { DATABASE_URL: new SensitiveValue(DB_SECRET) } }, ctx)).rejects.toMatchObject({ code: 'LP-VERCEL-ENV-POSTCONDITION-FAILED', class: 'CONFLICT', retryable: false });
});

it('fails closed on a malformed env list', async () => {
  const { adapter } = mount(loadScenarios('vercel').environmentListMalformed);
  await expect(adapter.ensureEnvironment({ projectId: 'app', environment: 'production', branch: 'main', variables: { DATABASE_URL: new SensitiveValue(DB_SECRET) } }, ctx)).rejects.toMatchObject({ code: 'LP-VERCEL-ENV-MALFORMED', class: 'MALFORMED_PROVIDER_RESPONSE', retryable: false });
});

it('resolves an omitted list value through the readback and replays as a no-op', async () => {
  const { adapter, requests } = mount(loadScenarios('vercel').environmentOmittedListValue);
  const result = await adapter.ensureEnvironment({ projectId: 'app', environment: 'production', branch: 'main', variables: { DATABASE_URL: new SensitiveValue(DB_SECRET) } }, ctx);
  expect(result.changed).toBe(false);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toMatchObject({ method: 'GET', path: '/v9/projects/app/env' });
  expect(requests[1]).toMatchObject({ method: 'GET', path: '/v9/projects/app/env/env_1' });
  expect(JSON.stringify(result)).not.toContain(DB_SECRET);
});

it('makes no provider calls when no variables are declared', async () => {
  const { adapter, requests } = mount([]);
  const result = await adapter.ensureEnvironment({ projectId: 'app', environment: 'production', branch: 'main', variables: {} }, ctx);
  expect(result.changed).toBe(false);
  expect(requests).toHaveLength(0);
});

it('sends stable idempotency keys across repeated environment creates', async () => {
  const spec = { projectId: 'app', environment: 'production', branch: 'main', variables: { DATABASE_URL: new SensitiveValue(DB_SECRET), API_TOKEN: new SensitiveValue(TOKEN_SECRET) } };
  const first = mount(loadScenarios('vercel').environmentCreate);
  await first.adapter.ensureEnvironment(spec, ctx);
  const second = mount(loadScenarios('vercel').environmentCreate);
  await second.adapter.ensureEnvironment(spec, ctx);
  const keyOne = first.requests.find((request) => request.method === 'POST')?.headers['idempotency-key'];
  const keyTwo = second.requests.find((request) => request.method === 'POST')?.headers['idempotency-key'];
  expect(keyOne).toBeDefined();
  expect(keyTwo).toBeDefined();
  expect(keyOne).toBe(keyTwo);
});

it('attaches a domain with the official POST body', async () => {
  const { adapter, requests } = mount(loadScenarios('vercel').domain);
  const result = await adapter.ensureDomain({ projectId: 'app', hostname: 'app.example.com', environment: 'production', mode: 'dns-only' }, ctx);
  expect(result.resource.providerResourceId).toBe('dom_1');
  const create = expectRequest(requests, 'POST', '/v10/projects/app/domains');
  expect(create.body).toEqual({ name: 'app.example.com' });
});

it('reads and verifies project-domain state through the official v9 endpoints', async () => {
  const verified = mount(loadScenarios('vercel').domainObserveVerified);
  await expect(verified.adapter.capabilities()).resolves.toMatchObject({
    features: { domainVerification: true, tlsReadiness: true },
  });
  await expect(verified.adapter.getDomain('app', 'app.example.com', ctx)).resolves.toMatchObject({
    provider: 'vercel',
    projectId: 'app',
    hostname: 'app.example.com',
    verified: true,
    verificationState: 'VERIFIED',
    challenges: [],
    redirect: null,
    gitBranch: null,
    customEnvironmentId: null,
  });
  expectRequest(verified.requests, 'GET', '/v9/projects/app/domains/app.example.com');

  const pending = mount(loadScenarios('vercel').domainObservePending);
  await expect(pending.adapter.getDomain('app', 'app.example.com', ctx)).resolves.toMatchObject({
    verified: false,
    verificationState: 'PENDING',
    challenges: [{ type: 'TXT', domain: '_vercel.app.example.com', value: 'verify-me', reason: 'pending' }],
  });

  const missing = mount(loadScenarios('vercel').domainObserveMissing);
  await expect(missing.adapter.getDomain('app', 'app.example.com', ctx)).resolves.toBeNull();

  const verify = mount(loadScenarios('vercel').domainVerify);
  await expect(verify.adapter.verifyDomain('app', 'app.example.com', ctx)).resolves.toMatchObject({
    verified: true,
    verificationState: 'VERIFIED',
  });
  expectRequest(verify.requests, 'POST', '/v9/projects/app/domains/app.example.com/verify');

  const malformed = mount(loadScenarios('vercel').domainObserveMalformed);
  await expect(malformed.adapter.getDomain('app', 'app.example.com', ctx)).rejects.toMatchObject({
    code: 'LP-VERCEL-DOMAIN-MALFORMED',
    class: 'MALFORMED_PROVIDER_RESPONSE',
    retryable: false,
  });
});

it('reports TLS readiness from Vercel certificates independently from domain verification', async () => {
  const ready = mount(loadScenarios('vercel').certReady);
  await expect(ready.adapter.getDomainTls('app.example.com', ctx)).resolves.toMatchObject({
    provider: 'vercel',
    hostname: 'app.example.com',
    state: 'READY',
    certificateId: 'cert_1',
    expiresAt: '2030-01-01T00:00:00.000Z',
    autoRenew: true,
  });
  expectRequest(ready.requests, 'GET', '/v8/certs');

  const pending = mount(loadScenarios('vercel').certPending);
  await expect(pending.adapter.getDomainTls('app.example.com', ctx)).resolves.toMatchObject({
    state: 'PENDING',
    certificateId: null,
    expiresAt: null,
    autoRenew: false,
  });

  const expired = mount(loadScenarios('vercel').certExpired);
  await expect(expired.adapter.getDomainTls('app.example.com', ctx)).resolves.toMatchObject({
    state: 'FAILED',
    certificateId: 'cert_expired',
    expiresAt: '2021-01-01T00:00:00.000Z',
  });

  const malformed = mount(loadScenarios('vercel').certMalformed);
  await expect(malformed.adapter.getDomainTls('app.example.com', ctx)).rejects.toMatchObject({
    code: 'LP-VERCEL-CERTS-MALFORMED',
    class: 'MALFORMED_PROVIDER_RESPONSE',
    retryable: false,
  });
});

it('derives the required CNAME from the current official domain-config shape', async () => {
  const current = mount(loadScenarios('vercel').dnsConfigCurrent);
  const records = await current.adapter.requiredDnsRecords({ projectId: 'app', hostname: 'app.example.com', environment: 'production', mode: 'dns-only' }, ctx);
  expect(records).toEqual([{ hostname: 'app.example.com', type: 'CNAME', value: 'cname.vercel-dns.com', ttl: 'auto', providerRecordId: null, proxied: false }]);
  expectRequest(current.requests, 'GET', '/v6/domains/app.example.com/config');
  const legacy = mount(loadScenarios('vercel').dnsConfigLegacy);
  await expect(legacy.adapter.requiredDnsRecords({ projectId: 'app', hostname: 'app.example.com', environment: 'production', mode: 'dns-only' }, ctx)).resolves.toEqual([expect.objectContaining({ value: 'cname.vercel-dns.com' })]);
  const missing = mount(loadScenarios('vercel').dnsConfigMissing);
  await expect(missing.adapter.requiredDnsRecords({ projectId: 'app', hostname: 'app.example.com', environment: 'production', mode: 'dns-only' }, ctx)).rejects.toMatchObject({ code: 'LP-VERCEL-DNS-REQUIREMENT-MISSING', class: 'MALFORMED_PROVIDER_RESPONSE', retryable: false });
});

it('creates preview, staged-production, and production deployments with the official target values', async () => {
  const preview = mount(loadScenarios('vercel').deploymentCreatePreview);
  const previewDeployment = await preview.adapter.createDeployment({ projectId: 'app', environment: 'preview', repository: 'acme/app', commitSha: COMMIT, desiredGeneration: 1, staged: false }, ctx);
  expect(previewDeployment).toMatchObject({ id: 'dpl_1', state: 'QUEUED', url: 'https://app-1.vercel.app', commitSha: COMMIT, createdAt: new Date(CREATED_AT).toISOString() });
  const previewBody = expectRequest(preview.requests, 'POST', '/v13/deployments');
  expect(previewBody.body).toMatchObject({ name: 'app', project: 'app', gitSource: { type: 'github', repo: 'acme/app', ref: COMMIT, sha: COMMIT }, meta: { launchpadApplicationId: 'app', desiredGeneration: '1' } });
  if (previewBody.body !== null && typeof previewBody.body === 'object') {
    expect('target' in previewBody.body).toBe(false);
  }

  const staged = mount(loadScenarios('vercel').deploymentCreateStaged);
  await staged.adapter.createDeployment({ projectId: 'app', environment: 'production', repository: 'acme/app', commitSha: COMMIT, desiredGeneration: 1, staged: true }, ctx);
  expect(expectRequest(staged.requests, 'POST', '/v13/deployments').body).toMatchObject({ target: 'staging' });

  const production = mount(loadScenarios('vercel').deploymentCreateProduction);
  await production.adapter.createDeployment({ projectId: 'app', environment: 'production', repository: 'acme/app', commitSha: COMMIT, desiredGeneration: 1, staged: false }, ctx);
  expect(expectRequest(production.requests, 'POST', '/v13/deployments').body).toMatchObject({ target: 'production' });
});

it('waits for a deployment, polling until a terminal state', async () => {
  const ready = mount(loadScenarios('vercel').deploymentWaitReady);
  await expect(ready.adapter.waitForDeployment({ projectId: 'app', deploymentId: 'dpl_1', timeoutMs: 1000, pollMs: 5 }, ctx)).resolves.toMatchObject({ id: 'dpl_1', state: 'READY' });
  const polling = mount(loadScenarios('vercel').deploymentWaitPolling);
  await expect(polling.adapter.waitForDeployment({ projectId: 'app', deploymentId: 'dpl_1', timeoutMs: 1000, pollMs: 1 }, ctx)).resolves.toMatchObject({ state: 'READY' });
  expect(polling.requests).toHaveLength(2);
  const failed = mount(loadScenarios('vercel').deploymentWaitError);
  await expect(failed.adapter.waitForDeployment({ projectId: 'app', deploymentId: 'dpl_1', timeoutMs: 1000, pollMs: 5 }, ctx)).resolves.toMatchObject({ state: 'ERROR' });
});

it('times out with a typed TIMEOUT when no terminal state arrives', async () => {
  const { adapter } = mount(loadScenarios('vercel').deploymentWaitTimeout);
  await expect(adapter.waitForDeployment({ projectId: 'app', deploymentId: 'dpl_1', timeoutMs: 30, pollMs: 3 }, ctx)).rejects.toMatchObject({ code: 'LP-VERCEL-DEPLOYMENT-TIMEOUT', class: 'TIMEOUT', retryable: true });
});

it('promotes via the official path-based endpoint and reports a CURRENT deployment', async () => {
  const { adapter, requests } = mount(loadScenarios('vercel').promote);
  const result = await adapter.promote({ projectId: 'app', deploymentId: 'dpl_1', expectedCommitSha: COMMIT }, ctx);
  expect(result.deployment).toMatchObject({ id: 'dpl_1', environment: 'production', commitSha: COMMIT, state: 'CURRENT' });
  expect(result.previousDeploymentId).toBeNull();
  expectRequest(requests, 'POST', '/v10/projects/app/promote/dpl_1');
});

it('rolls back via the official path-based endpoint', async () => {
  const { adapter, requests } = mount(loadScenarios('vercel').rollback);
  const result = await adapter.rollback({ projectId: 'app', deploymentId: 'dpl_bad', previousKnownGoodId: 'dpl_prev' }, ctx);
  expect(result).toEqual({ deploymentId: 'dpl_prev', restored: true });
  expectRequest(requests, 'POST', '/v1/projects/app/rollback/dpl_prev');
});

it('lists shadow projects through the search-scoped projects endpoint', async () => {
  const { adapter, requests } = mount(loadScenarios('vercel').shadowProjects);
  const projects = await adapter.listOwnedShadowProjects(ctx);
  expect(projects).toHaveLength(1);
  expect(projects[0]).toMatchObject({ resourceType: 'vercel.shadow-project', resourceKey: 'lp-pr-12-app', providerResourceId: 'prj_shadow' });
  expectRequest(requests, 'GET', '/v9/projects?search=lp-pr-');
});

it('locates the exact-commit preview deployment and rejects production, mismatched repos, and partial entries', async () => {
  const exact = mount(loadScenarios('vercel').deploymentsList);
  await expect(exact.adapter.findDeploymentByCommit('app', COMMIT, ctx)).resolves.toMatchObject({ id: 'dpl_exact', commitSha: COMMIT, environment: 'preview', url: 'https://app-exact.vercel.app' });
  const production = mount(loadScenarios('vercel').deploymentsListProductionOnly);
  await expect(production.adapter.findDeploymentByCommit('app', COMMIT, ctx)).resolves.toBeNull();
  const mismatch = mount(loadScenarios('vercel').deploymentsListRepositoryMismatch);
  await expect(mismatch.adapter.findDeploymentByCommit('app', COMMIT, ctx, { expectedRepository: 'acme/app' })).resolves.toBeNull();
  const partial = mount(loadScenarios('vercel').deploymentsListPartial);
  await expect(partial.adapter.findDeploymentByCommit('app', COMMIT, ctx)).resolves.toBeNull();
  const malformed = mount(loadScenarios('vercel').deploymentsListMalformed);
  await expect(malformed.adapter.findDeploymentByCommit('app', COMMIT, ctx)).rejects.toMatchObject({ code: 'LP-VERCEL-DEPLOYMENTS-MALFORMED', class: 'MALFORMED_PROVIDER_RESPONSE', retryable: false });
});

it('returns a bounded log excerpt from the current official events array', async () => {
  const array = mount(loadScenarios('vercel').logsArray);
  const excerpt = await array.adapter.fetchDeploymentLogs({ deploymentId: 'dpl_1', maxLines: 10, maxBytes: 1000 }, ctx);
  expect(excerpt).toEqual({ deploymentId: 'dpl_1', excerpt: 'build ok\nnpm run build', truncated: false });
  expectRequest(array.requests, 'GET', '/v3/deployments/dpl_1/events?limit=100&direction=forward');
  const wrapper = mount(loadScenarios('vercel').logsWrapper);
  await expect(wrapper.adapter.fetchDeploymentLogs({ deploymentId: 'dpl_1', maxLines: 10, maxBytes: 1000 }, ctx)).resolves.toMatchObject({ excerpt: 'legacy line', truncated: false });
  const malformed = mount(loadScenarios('vercel').logsMalformed);
  await expect(malformed.adapter.fetchDeploymentLogs({ deploymentId: 'dpl_1', maxLines: 10, maxBytes: 1000 }, ctx)).rejects.toMatchObject({ code: 'LP-VERCEL-LOGS-MALFORMED', class: 'MALFORMED_PROVIDER_RESPONSE', retryable: false });
});

it('deletes projects, domains, and deployments with idempotent DELETE requests', async () => {
  const projectDelete = mount(loadScenarios('vercel').projectDelete);
  await expect(projectDelete.adapter.deleteProject('app', ctx)).resolves.toBeUndefined();
  expect(expectRequest(projectDelete.requests, 'DELETE', '/v9/projects/app').headers['idempotency-key']).toBeDefined();

  const domainRemove = mount(loadScenarios('vercel').domainRemove);
  await expect(domainRemove.adapter.removeDomain('app', 'app.example.com', ctx)).resolves.toBeUndefined();
  expect(expectRequest(domainRemove.requests, 'DELETE', '/v9/projects/app/domains/app.example.com').headers['idempotency-key']).toBeDefined();

  const deploymentDelete = mount(loadScenarios('vercel').deploymentDelete);
  await expect(deploymentDelete.adapter.deleteDeployment('dpl_1', ctx)).resolves.toBeUndefined();
  expect(expectRequest(deploymentDelete.requests, 'DELETE', '/v13/deployments/dpl_1').headers['idempotency-key']).toBeDefined();
});

it('keeps provider error bodies and tokens out of typed errors', async () => {
  const { adapter } = mount(loadScenarios('vercel').errorCanary);
  await expect(adapter.observeProject({ projectId: 'app' }, ctx)).rejects.toSatisfy((error: unknown) => {
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain(CONTRACT_CANARY_BODY);
    expect(serialized).not.toContain(CONTRACT_CANARY_TOKEN);
    expect(error).toMatchObject({ code: 'LP-VERCEL-HTTP-401', class: 'AUTHENTICATION', retryable: false });
    return true;
  });
});
