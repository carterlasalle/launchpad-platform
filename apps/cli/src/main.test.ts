import { expect, it, afterEach, describe, vi } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseCliArgs, formatIssues, runCli } from './index.js';
import type { PlatformPlan } from '@launchpad/core';

const fixturePath = join(process.cwd(), 'tests/fixtures/catalog/invalid-root.yaml');
const sha = 'a'.repeat(40);
const zoneRegistry = 'apiVersion: launchpad.dev/v1\nzones:\n  - example.com\n';

function tempCatalog(extraFiles: Array<{ name: string; content: string }> = [], registryContent: string | null = zoneRegistry): string {
  const root = mkdtempSync(join(tmpdir(), 'launchpad-cli-catalog-'));
  const apps = join(root, 'apps');
  mkdirSync(apps, { recursive: true });
  cpSync(fixturePath, join(apps, 'invalid-root.yaml'));
  if (registryContent !== null) writeFileSync(join(root, 'zones.yaml'), registryContent);
  for (const file of extraFiles) writeFileSync(join(apps, file.name), file.content);
  return root;
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writer(): { write(value: string): void; text: string } {
  let text = '';
  return { write(value: string) { text += value; }, get text() { return text; } };
}

function planFor(applicationId = 'invalid-root'): PlatformPlan {
  return { schemaVersion: 'launchpad.plan/v1', applicationId, desiredGeneration: 1, sourceCommit: sha, createdAt: '2026-08-04T00:00:00.000Z', capabilitySnapshotHash: 'capabilities', observedStateHash: 'observed', operations: [{ id: '1', resourceKey: 'vercel.project', provider: 'vercel', resourceType: 'project', action: 'CREATE', before: null, after: { rootDirectory: 'apps/missing' }, prerequisites: [], invalidates: [], idempotencyKey: 'key', destructive: false, retryClass: 'NONE' }], downstreamEffects: [], policyResults: [], fingerprint: 'f'.repeat(64), result: 'READY' };
}

/** Routes fetch calls by URL substring; unmatched URLs 500 so tests fail loudly instead of silently passing. */
function stubFetch(routes: Array<{ match: RegExp; response: (url: string, init?: RequestInit) => Response | Promise<Response> }>): void {
  const { stubGlobal } = vi;
  stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const route = routes.find((candidate) => candidate.match.test(url));
    if (!route) return Promise.resolve(new Response(`Unstubbed fetch in test: ${url}`, { status: 500 }));
    return Promise.resolve(route.response(url, init));
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Fake GitHub Actions OIDC JWT returned by the stubbed request-token endpoint. */
const oidcJwt = 'header.payload.signature';

/** Stub for the GitHub Actions OIDC request-token endpoint (JSON envelope with a string value). */
function oidcRoute(): { match: RegExp; response: () => Response } {
  return { match: /oidc\.test\/request/, response: () => jsonResponse({ value: oidcJwt, header: { alg: 'RS256' }, expires_at: 1234567890 }) };
}

function bearerOf(init?: RequestInit): string | null {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.authorization ?? null;
}

describe('argument parsing', () => {
  it('parses commands and flags without accepting unknown options', () => {
    expect(parseCliArgs(['plan', '--catalog', 'catalog', '--format', 'json'])).toEqual({ command: 'plan', flags: { catalog: 'catalog', format: 'json' } });
    expect(() => parseCliArgs(['validate', '--unknown', 'value'])).toThrow(/unknown/i);
  });

  it('formats validation issues with source location and remediation', () => {
    const output = formatIssues([{ code: 'LP-SCHEMA-INVALID', file: 'catalog/apps/app.yaml', line: 4, column: 3, path: 'metadata.id', message: 'bad id', remediation: 'Use a stable id.' }]);
    expect(output).toContain('catalog/apps/app.yaml:4:3');
    expect(output).toContain('Use a stable id.');
  });
});

describe('validate', () => {
  it('emits machine-readable JSON and fails closed on schema issues', async () => {
    const catalog = tempCatalog([{ name: 'broken.yaml', content: 'kind: Application\nmetadata:\n  id: broken\n' }]);
    const out = writer();
    const exitCode = await runCli(['validate', '--catalog', catalog, '--format', 'json'], out);
    expect(exitCode).toBe(1);
    const report = JSON.parse(out.text) as { valid: boolean; applications: string[]; issues: Array<{ code: string }> };
    expect(report.valid).toBe(false);
    expect(report.issues.length).toBeGreaterThan(0);
    expect(report.issues.map((issue) => issue.code)).toContain('LP-SCHEMA-VERSION');
  });

  it('accepts a valid manifest catalog', async () => {
    const catalog = tempCatalog();
    const out = writer();
    const exitCode = await runCli(['validate', '--catalog', catalog], out);
    expect(exitCode).toBe(0);
    expect(out.text).toContain('Catalog valid: 1 application(s).');
  });
});

describe('zone registry', () => {
  afterEach(() => vi.unstubAllGlobals());

  const withDomain = (zoneRef: string): string => `apiVersion: launchpad.dev/v1
kind: Application
metadata: {id: zone-app, displayName: Zone App, owners: ["@platform"], labels: {}, annotations: {}}
repository: {provider: github, name: example/zone-app, productionBranch: main, deploymentRef: main}
vercel:
  scope: {}
  project:
    name: zone-app
    framework: nextjs
    rootDirectory: apps/web
    nodeVersion: "24.x"
    build: {installCommand: yarn install --immutable, buildCommand: yarn build, outputDirectory: null, developmentCommand: null, ignoredBuildStep: null}
    git: {connected: true, productionBranch: main}
    deployment: {autoAssignProductionDomains: false, prioritizeProductionBuilds: true, rollingRelease: null, skewProtection: false}
    regions: {functions: []}
    protection: {}
    settings: {}
environments:
  preview: {enabled: true, health: {path: /api/health, method: GET, expectedStatus: [200], timeoutSeconds: 10, attempts: 1, intervalSeconds: 0}}
  production: {enabled: true, health: {path: /api/health, method: GET, expectedStatus: [200], timeoutSeconds: 10, attempts: 1, intervalSeconds: 0}}
domains:
  - hostname: app.example.com
    environment: production
    canonical: true
    cloudflare: {zoneRef: ${zoneRef}, mode: dns-only, ttl: auto}
    redirects: []
secrets: []
dependencies: {applications: [], external: []}
policies: {}
lifecycle: {}
`;

  it('accepts a domain whose zone is registered (known zone passes)', async () => {
    const catalog = tempCatalog([{ name: 'zone-app.yaml', content: withDomain('config://cloudflare/example.com') }]);
    const out = writer();
    const exitCode = await runCli(['validate', '--catalog', catalog, '--format', 'json'], out);
    expect(exitCode).toBe(0);
    const report = JSON.parse(out.text) as { valid: boolean; issues: Array<{ code: string }> };
    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
    rmSync(catalog, { recursive: true, force: true });
  });

  it('blocks an unknown zone statically with the manifest file as context', async () => {
    const catalog = tempCatalog([{ name: 'zone-app.yaml', content: withDomain('config://cloudflare/other.com') }]);
    const out = writer();
    const exitCode = await runCli(['validate', '--catalog', catalog, '--format', 'json'], out);
    expect(exitCode).toBe(1);
    const report = JSON.parse(out.text) as { valid: boolean; issues: Array<{ code: string; file: string; path: string }> };
    expect(report.valid).toBe(false);
    const zoneIssue = report.issues.find((issue) => issue.code === 'LP-DOMAIN-ZONE-UNKNOWN');
    expect(zoneIssue).toBeDefined();
    expect(zoneIssue?.file).toContain('zone-app.yaml');
    expect(zoneIssue?.path).toBe('domains.0.cloudflare.zoneRef');
    rmSync(catalog, { recursive: true, force: true });
  });

  it('fails closed with file context when the registry is missing', async () => {
    const catalog = tempCatalog([{ name: 'zone-app.yaml', content: withDomain('config://cloudflare/example.com') }], null);
    await expect(runCli(['validate', '--catalog', catalog], writer())).rejects.toThrow(/LP-ZONE-REGISTRY-MISSING.*zones\.yaml/);
    rmSync(catalog, { recursive: true, force: true });
  });

  it('fails closed with file context when the registry is malformed', async () => {
    const catalog = tempCatalog([], 'zones: [example.com\n');
    await expect(runCli(['validate', '--catalog', catalog], writer())).rejects.toThrow(/LP-ZONE-REGISTRY-INVALID.*LP-ZONE-REGISTRY-YAML/);
    rmSync(catalog, { recursive: true, force: true });
  });

  it('never calls providers after a static zone failure in preflight', async () => {
    const catalog = tempCatalog([{ name: 'zone-app.yaml', content: withDomain('config://cloudflare/other.com') }]);
    const calls: string[] = [];
    stubFetch([{ match: /.*/, response: (url) => { calls.push(url); return jsonResponse({}, 500); } }]);
    const out = writer();
    const exitCode = await runCli(['preflight', '--catalog', catalog], out);
    expect(exitCode).toBe(1);
    expect(out.text).toContain('LP-DOMAIN-ZONE-UNKNOWN');
    expect(calls).toEqual([]);
    rmSync(catalog, { recursive: true, force: true });
  });

  it('never calls providers after a static zone failure in plan', async () => {
    const catalog = tempCatalog([{ name: 'zone-app.yaml', content: withDomain('config://cloudflare/other.com') }]);
    const calls: string[] = [];
    stubFetch([{ match: /.*/, response: (url) => { calls.push(url); return jsonResponse({}, 500); } }]);
    const out = writer();
    const exitCode = await runCli(['plan', '--catalog', catalog, '--sha', sha], out);
    expect(exitCode).toBe(1);
    expect(out.text).toContain('LP-DOMAIN-ZONE-UNKNOWN');
    expect(calls).toEqual([]);
    rmSync(catalog, { recursive: true, force: true });
  });
});

describe('plan', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('fails closed without an exact commit SHA', async () => {
    const catalog = tempCatalog();
    vi.stubEnv('GITHUB_SHA', '');
    await expect(runCli(['plan', '--catalog', catalog], writer())).rejects.toThrow(/LP-COMMIT-UNBOUND/);
  });

  it('fails closed without provider state (false-green regression)', async () => {
    const catalog = tempCatalog();
    vi.stubEnv('LAUNCHPAD_GITHUB_TOKEN', '');
    vi.stubEnv('LAUNCHPAD_VERCEL_TOKEN', '');
    await expect(runCli(['plan', '--catalog', catalog, '--sha', sha], writer())).rejects.toThrow(/LP-PROVIDER-STATE-UNAVAILABLE/);
  });

  it('exits non-zero when the declared root directory does not exist in the repository (invalid-root fixture)', async () => {
    const catalog = tempCatalog();
    const outputDir = tempDir('launchpad-cli-plan-');
    vi.stubEnv('LAUNCHPAD_GITHUB_TOKEN', 'github-token');
    vi.stubEnv('LAUNCHPAD_VERCEL_TOKEN', 'vercel-token');
    stubFetch([
      { match: /\/repos\/example\/invalid-root$/, response: () => jsonResponse({ id: 42, archived: false, private: true, default_branch: 'main' }) },
      { match: /\/contents\//, response: () => jsonResponse({ message: 'Not Found' }, 404) },
    ]);
    await expect(runCli(['plan', '--catalog', catalog, '--sha', sha, '--output', outputDir], writer())).rejects.toThrow(/LP-GITHUB-ROOT-MISSING/);
    rmSync(catalog, { recursive: true, force: true });
    rmSync(outputDir, { recursive: true, force: true });
  });

  it('builds a plan bound to the exact commit from live provider responses and writes bounded artifacts', async () => {
    const validApp = `apiVersion: launchpad.dev/v1
kind: Application
metadata: {id: valid-app, displayName: Valid App, owners: ["@platform"], labels: {}, annotations: {}}
repository: {provider: github, name: example/valid-app, productionBranch: main, deploymentRef: main}
vercel:
  scope: {}
  project:
    name: valid-app
    framework: nextjs
    rootDirectory: apps/web
    nodeVersion: "24.x"
    build: {installCommand: yarn install --immutable, buildCommand: yarn build, outputDirectory: null, developmentCommand: null, ignoredBuildStep: null}
    git: {connected: true, productionBranch: main}
    deployment: {autoAssignProductionDomains: false, prioritizeProductionBuilds: true, rollingRelease: null, skewProtection: false}
    regions: {functions: []}
    protection: {}
    settings: {}
environments:
  preview: {enabled: true, health: {path: /api/health, method: GET, expectedStatus: [200], timeoutSeconds: 10, attempts: 1, intervalSeconds: 0}}
  production: {enabled: true, health: {path: /api/health, method: GET, expectedStatus: [200], timeoutSeconds: 10, attempts: 1, intervalSeconds: 0}}
domains: []
secrets: []
dependencies: {applications: [], external: []}
policies:
  drift: {mode: open-pr, checkIntervalMinutes: 30}
  destructiveChanges: {allowInNormalApply: false}
  preview: {requiredForMerge: true}
  staging: {requiredForProduction: false}
  health: {requiredForPromotion: true}
  failures: {createIssueAfterFinalRetry: true, notifyOwners: true}
lifecycle:
  state: active
  deletionProtection: true
  orphanPolicy: retain
  decommission: {requestedAt: null, deleteAfter: null, approvalToken: null, preserveDeployments: true}
`;
    const catalog = tempCatalog([{ name: 'valid-app.yaml', content: validApp }]);
    const outputDir = tempDir('launchpad-cli-plan-');
    vi.stubEnv('LAUNCHPAD_GITHUB_TOKEN', 'github-token');
    vi.stubEnv('LAUNCHPAD_VERCEL_TOKEN', 'vercel-token');
    stubFetch([
      { match: /\/repos\/example\/valid-app$/, response: () => jsonResponse({ id: 42, archived: false, private: true, default_branch: 'main' }) },
      { match: /\/contents\//, response: () => jsonResponse({ type: 'dir' }) },
      { match: /\/v9\/projects\//, response: () => jsonResponse({ id: 'valid-app', name: 'valid-app', framework: 'nextjs', rootDirectory: 'apps/web', nodeVersion: '24.x', installCommand: 'yarn install --immutable', buildCommand: 'yarn build', outputDirectory: null, autoAssignProductionDomains: false, prioritizeProductionBuilds: true, rollingRelease: null, skewProtection: false }) },
      { match: /\/v7\/deployments\?/, response: () => jsonResponse({ deployments: [] }) },
    ]);
    const out = writer();
    const exitCode = await runCli(['plan', '--catalog', catalog, '--app', 'valid-app', '--sha', sha, '--format', 'json', '--output', outputDir], out);
    expect(exitCode).toBe(0);
    const plans = JSON.parse(out.text) as PlatformPlan[];
    expect(plans).toHaveLength(1);
    expect(plans[0]?.applicationId).toBe('valid-app');
    expect(plans[0]?.sourceCommit).toBe(sha);
    expect(plans[0]?.result).toBe('READY');
    expect(plans[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const artifacts = ['plans.json', 'plan.md', 'resource-graph.json', 'resource-graph.dot', 'provider-state-redacted.json'];
    for (const name of artifacts) expect(readFileSync(join(outputDir, name), 'utf8').length).toBeGreaterThan(0);
    const plansFile = JSON.parse(readFileSync(join(outputDir, 'plans.json'), 'utf8')) as PlatformPlan[];
    expect(plansFile[0]?.sourceCommit).toBe(sha);
    rmSync(catalog, { recursive: true, force: true });
    rmSync(outputDir, { recursive: true, force: true });
  });
});

describe('preview', () => {
  afterEach(() => vi.unstubAllGlobals());

  const controller = 'http://controller.test';
  const verifyRoute = /\/v1\/plans\/verify$/;
  const startRoute = /\/v1\/applications\/invalid-root\/preview\/verify$/;
  const operationRoute = /\/v1\/operations\/op-1$/;

  function previewEnv(): void {
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', 'http://oidc.test/request');
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'request-token');
    vi.stubEnv('LAUNCHPAD_OPERATOR_TOKEN', 'operator-token');
    vi.stubEnv('GITHUB_REPOSITORY', 'example/launchpad');
  }

  /** The reviewed-plan attestation the preview command records before starting a preview. */
  function attestationResponse(): { match: RegExp; response: () => Response } {
    return { match: verifyRoute, response: () => jsonResponse({ accepted: true, deduplicated: false, attestationId: 'att-1', applicationId: 'invalid-root', sourceCommit: sha, desiredGeneration: 1, desiredHash: 'd'.repeat(64), planFingerprint: 'f'.repeat(64), reviewFingerprint: 'r'.repeat(64), createdAt: '2026-08-04T00:00:00.000Z' }) };
  }

  it('fails closed without the plan job output', async () => {
    const catalog = tempCatalog();
    previewEnv();
    stubFetch([oidcRoute()]);
    await expect(runCli(['preview', '--catalog', catalog, '--sha', sha, '--controller', controller], writer())).rejects.toThrow(/LP-PLANS-FILE-MISSING/);
    rmSync(catalog, { recursive: true, force: true });
  });

  it('accepts 202, polls to terminal, and requires persisted previewUrl/buildState/healthState/sourceCommit', async () => {
    const catalog = tempCatalog();
    const outputDir = tempDir('launchpad-cli-preview-');
    const plansDir = tempDir('launchpad-cli-plans-');
    writeFileSync(join(plansDir, 'plans.json'), JSON.stringify([planFor()]));
    previewEnv();
    let startBody: Record<string, unknown> | null = null;
    stubFetch([
      oidcRoute(),
      attestationResponse(),
      { match: startRoute, response: (url, init) => {
        expect(bearerOf(init)).toBe(`Bearer ${oidcJwt}`);
        startBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ workflowId: 'wf-1', operationId: 'op-1', status: 'QUEUED' }, 202);
      } },
      { match: operationRoute, response: () => jsonResponse({ operationId: 'op-1', workflowId: 'wf-1', applicationId: 'invalid-root', kind: 'preview', status: 'SUCCEEDED', errorCode: null, sourceCommit: sha, result: { previewUrl: 'https://lp-pr-1-invalid-root.vercel.app', buildState: 'READY', healthState: 'PASSED' } }) },
    ]);
    const out = writer();
    const exitCode = await runCli(['preview', '--catalog', catalog, '--sha', sha, '--pr', '7', '--controller', controller, '--plans', join(plansDir, 'plans.json'), '--output', outputDir], out);
    expect(exitCode).toBe(0);
    expect(startBody).toMatchObject({
      version: 1,
      applicationId: 'invalid-root',
      sourceCommit: sha,
      idempotencyKey: `preview:invalid-root:${sha}:1`,
      prNumber: 7,
      desired: expect.objectContaining({ metadata: expect.objectContaining({ id: 'invalid-root' }), repository: expect.objectContaining({ name: 'example/invalid-root' }) }),
    });
    const summary = JSON.parse(out.text) as { sourceCommit: string; applications: Array<{ state: string; url: string }> };
    expect(summary.applications[0]).toMatchObject({ state: 'READY', url: 'https://lp-pr-1-invalid-root.vercel.app' });
    const written = JSON.parse(readFileSync(join(outputDir, 'preview-summary.json'), 'utf8')) as { sourceCommit: string; applications: Array<{ state: string }> };
    expect(written.sourceCommit).toBe(sha);
    expect(written.applications[0]?.state).toBe('READY');
    rmSync(catalog, { recursive: true, force: true });
    rmSync(outputDir, { recursive: true, force: true });
    rmSync(plansDir, { recursive: true, force: true });
  });

  it('fails closed when a succeeded operation lacks the preview URL (false-green regression)', async () => {
    const catalog = tempCatalog();
    const plansDir = tempDir('launchpad-cli-plans-');
    writeFileSync(join(plansDir, 'plans.json'), JSON.stringify([planFor()]));
    previewEnv();
    stubFetch([
      oidcRoute(),
      attestationResponse(),
      { match: startRoute, response: () => jsonResponse({ workflowId: 'wf-1', operationId: 'op-1', status: 'QUEUED' }, 202) },
      { match: operationRoute, response: () => jsonResponse({ operationId: 'op-1', workflowId: 'wf-1', status: 'SUCCEEDED', sourceCommit: sha, result: { buildState: 'READY', healthState: 'PASSED' } }) },
    ]);
    await expect(runCli(['preview', '--catalog', catalog, '--sha', sha, '--controller', controller, '--plans', join(plansDir, 'plans.json')], writer())).rejects.toThrow(/LP-PREVIEW-RESULT-INCOMPLETE/);
    rmSync(catalog, { recursive: true, force: true });
    rmSync(plansDir, { recursive: true, force: true });
  });

  it('fails closed when the operation result is bound to a different commit', async () => {
    const catalog = tempCatalog();
    const plansDir = tempDir('launchpad-cli-plans-');
    writeFileSync(join(plansDir, 'plans.json'), JSON.stringify([planFor()]));
    previewEnv();
    stubFetch([
      oidcRoute(),
      attestationResponse(),
      { match: startRoute, response: () => jsonResponse({ workflowId: 'wf-1', operationId: 'op-1', status: 'QUEUED' }, 202) },
      { match: operationRoute, response: () => jsonResponse({ operationId: 'op-1', workflowId: 'wf-1', status: 'SUCCEEDED', sourceCommit: 'b'.repeat(40), result: { previewUrl: 'https://x.vercel.app', buildState: 'READY', healthState: 'PASSED' } }) },
    ]);
    await expect(runCli(['preview', '--catalog', catalog, '--sha', sha, '--controller', controller, '--plans', join(plansDir, 'plans.json')], writer())).rejects.toThrow(/LP-PREVIEW-RESULT-INCOMPLETE/);
    rmSync(catalog, { recursive: true, force: true });
    rmSync(plansDir, { recursive: true, force: true });
  });

  it('turns a terminal failure into visible provider-error artifacts and exit 1', async () => {
    const catalog = tempCatalog();
    const outputDir = tempDir('launchpad-cli-preview-');
    const plansDir = tempDir('launchpad-cli-plans-');
    writeFileSync(join(plansDir, 'plans.json'), JSON.stringify([planFor()]));
    previewEnv();
    stubFetch([
      oidcRoute(),
      attestationResponse(),
      { match: startRoute, response: () => jsonResponse({ workflowId: 'wf-1', operationId: 'op-1', status: 'QUEUED' }, 202) },
      { match: operationRoute, response: () => jsonResponse({ operationId: 'op-1', workflowId: 'wf-1', status: 'FAILED', errorCode: 'LP-VERCEL-BUILD-FAILED', sourceCommit: sha, result: null }) },
    ]);
    const out = writer();
    const exitCode = await runCli(['preview', '--catalog', catalog, '--sha', sha, '--controller', controller, '--plans', join(plansDir, 'plans.json'), '--output', outputDir], out);
    expect(exitCode).toBe(1);
    const summary = JSON.parse(out.text) as { applications: Array<{ state: string }> };
    expect(summary.applications[0]?.state).toBe('ERROR');
    const errors = JSON.parse(readFileSync(join(outputDir, 'provider-error-redacted.json'), 'utf8')) as Array<{ code: string }>;
    expect(errors[0]?.code).toBe('LP-VERCEL-BUILD-FAILED');
    expect(readFileSync(join(outputDir, 'preview-summary.json'), 'utf8')).toContain('"ERROR"');
    rmSync(catalog, { recursive: true, force: true });
    rmSync(outputDir, { recursive: true, force: true });
    rmSync(plansDir, { recursive: true, force: true });
  });

  it('fails closed when the start response is not the 202 QUEUED contract', async () => {
    const catalog = tempCatalog();
    const plansDir = tempDir('launchpad-cli-plans-');
    writeFileSync(join(plansDir, 'plans.json'), JSON.stringify([planFor()]));
    previewEnv();
    stubFetch([
      oidcRoute(),
      attestationResponse(),
      { match: startRoute, response: () => jsonResponse({ error: { code: 'LP-OIDC-AUTH-REQUIRED', message: 'no', retryable: false } }, 401) },
    ]);
    await expect(runCli(['preview', '--catalog', catalog, '--sha', sha, '--controller', controller, '--plans', join(plansDir, 'plans.json')], writer())).rejects.toThrow(/LP-PREVIEW-START-REJECTED/);
    rmSync(catalog, { recursive: true, force: true });
    rmSync(plansDir, { recursive: true, force: true });
  });

  it('records the plan review with the real plan and desired-state binding before starting the preview', async () => {
    const catalog = tempCatalog();
    const outputDir = tempDir('launchpad-cli-preview-');
    const plansDir = tempDir('launchpad-cli-plans-');
    writeFileSync(join(plansDir, 'plans.json'), JSON.stringify([planFor()]));
    previewEnv();
    vi.stubEnv('GITHUB_EVENT_NAME', 'pull_request');
    const verifyCapture: { body?: Record<string, unknown> } = {};
    let startCalls = 0;
    stubFetch([
      oidcRoute(),
      { match: verifyRoute, response: (_url, init) => {
        verifyCapture.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ accepted: true, deduplicated: false, attestationId: 'att-1', applicationId: 'invalid-root', sourceCommit: sha, desiredGeneration: 1, desiredHash: 'd'.repeat(64), planFingerprint: 'f'.repeat(64), reviewFingerprint: 'r'.repeat(64), createdAt: '2026-08-04T00:00:00.000Z' });
      } },
      { match: startRoute, response: () => {
        startCalls += 1;
        return jsonResponse({ workflowId: 'wf-1', operationId: 'op-1', status: 'QUEUED' }, 202);
      } },
      { match: operationRoute, response: () => jsonResponse({ operationId: 'op-1', workflowId: 'wf-1', applicationId: 'invalid-root', kind: 'preview', status: 'SUCCEEDED', errorCode: null, sourceCommit: sha, result: { previewUrl: 'https://lp-pr-1-invalid-root.vercel.app', buildState: 'READY', healthState: 'PASSED' } }) },
    ]);
    const exitCode = await runCli(['preview', '--catalog', catalog, '--sha', sha, '--pr', '7', '--controller', controller, '--plans', join(plansDir, 'plans.json'), '--output', outputDir], writer());
    expect(exitCode).toBe(0);
    expect(startCalls).toBe(1);
    expect(verifyCapture.body).toMatchObject({ version: 1, applicationId: 'invalid-root', sourceCommit: sha, desiredGeneration: 1, planFingerprint: 'f'.repeat(64), event: 'pull_request', prNumber: 7 });
    const plan = verifyCapture.body?.plan as { sourceCommit: string; fingerprint: string } | undefined;
    expect(plan?.sourceCommit).toBe(sha);
    expect(plan?.fingerprint).toBe('f'.repeat(64));
    expect(String(verifyCapture.body?.desiredHash)).toMatch(/^[0-9a-f]{64}$/);
    rmSync(catalog, { recursive: true, force: true });
    rmSync(outputDir, { recursive: true, force: true });
    rmSync(plansDir, { recursive: true, force: true });
  });

  it('fails closed when the plan review attestation is rejected without starting the preview', async () => {
    const catalog = tempCatalog();
    const plansDir = tempDir('launchpad-cli-plans-');
    writeFileSync(join(plansDir, 'plans.json'), JSON.stringify([planFor()]));
    previewEnv();
    let startCalls = 0;
    stubFetch([
      oidcRoute(),
      { match: verifyRoute, response: () => jsonResponse({ error: { code: 'LP-OIDC-PR-HEAD-UNVERIFIABLE', message: 'no', retryable: true } }, 503) },
      { match: startRoute, response: () => {
        startCalls += 1;
        return jsonResponse({ workflowId: 'wf-1', operationId: 'op-1', status: 'QUEUED' }, 202);
      } },
    ]);
    await expect(runCli(['preview', '--catalog', catalog, '--sha', sha, '--pr', '7', '--controller', controller, '--plans', join(plansDir, 'plans.json')], writer())).rejects.toThrow(/LP-PLAN-REVIEW-REJECTED/);
    expect(startCalls).toBe(0);
    rmSync(catalog, { recursive: true, force: true });
    rmSync(plansDir, { recursive: true, force: true });
  });
});

describe('app-preview', () => {
  afterEach(() => vi.unstubAllGlobals());

  const controller = 'http://controller.test';
  const startRoute = /\/v1\/applications\/invalid-root\/preview\/verify$/;
  const operationRoute = /\/v1\/operations\/op-status-1$/;

  function appPreviewEnv(): void {
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', 'http://oidc.test/request');
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'request-token');
    vi.stubEnv('LAUNCHPAD_OPERATOR_TOKEN', 'operator-token');
    vi.stubEnv('GITHUB_REPOSITORY', 'example/invalid-root');
  }

  it('posts an app-repository status payload (no desired) and requires the gate result previewUrl', async () => {
    appPreviewEnv();
    let startBody: Record<string, unknown> | null = null;
    stubFetch([
      oidcRoute(),
      { match: startRoute, response: (_url, init) => {
        startBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ workflowId: 'wf-status-1', operationId: 'op-status-1', status: 'QUEUED' }, 202);
      } },
      { match: operationRoute, response: () => jsonResponse({ operationId: 'op-status-1', workflowId: 'wf-status-1', applicationId: 'invalid-root', kind: 'app-preview-status', status: 'SUCCEEDED', errorCode: null, sourceCommit: sha, result: { previewUrl: 'https://app-gate.vercel.app', buildState: 'READY', healthState: 'PASSED' } }) },
    ]);
    const out = writer();
    const exitCode = await runCli(['app-preview', '--application', 'invalid-root', '--sha', sha, '--controller', controller], out);
    expect(exitCode).toBe(0);
    // The app-repository status payload deliberately omits the catalog
    // desired block; the controller routes it to the dedicated
    // app-preview-status machine.
    expect(startBody).toMatchObject({
      version: 1,
      applicationId: 'invalid-root',
      sourceCommit: sha,
      idempotencyKey: `app-preview:invalid-root:${sha}`,
      repository: 'example/invalid-root',
    });
    expect('desired' in (startBody ?? {})).toBe(false);
    const summary = JSON.parse(out.text) as { operationId: string; previewUrl: string; buildState: string; healthState: string };
    expect(summary).toMatchObject({ operationId: 'op-status-1', previewUrl: 'https://app-gate.vercel.app', buildState: 'READY', healthState: 'PASSED' });
  });

  it('fails closed when the app-preview gate ends without a previewUrl', async () => {
    appPreviewEnv();
    stubFetch([
      oidcRoute(),
      { match: startRoute, response: () => jsonResponse({ workflowId: 'wf-status-2', operationId: 'op-status-1', status: 'QUEUED' }, 202) },
      { match: operationRoute, response: () => jsonResponse({ operationId: 'op-status-1', workflowId: 'wf-status-2', kind: 'app-preview-status', status: 'SUCCEEDED', sourceCommit: sha, result: { buildState: 'READY', healthState: 'PASSED' } }) },
    ]);
    await expect(runCli(['app-preview', '--application', 'invalid-root', '--sha', sha, '--controller', controller], writer())).rejects.toThrow(/LP-PREVIEW-RESULT-INCOMPLETE/);
  });

  it('fails closed when the gate operation is bound to a different commit', async () => {
    appPreviewEnv();
    stubFetch([
      oidcRoute(),
      { match: startRoute, response: () => jsonResponse({ workflowId: 'wf-status-3', operationId: 'op-status-1', status: 'QUEUED' }, 202) },
      { match: operationRoute, response: () => jsonResponse({ operationId: 'op-status-1', workflowId: 'wf-status-3', kind: 'app-preview-status', status: 'SUCCEEDED', sourceCommit: 'b'.repeat(40), result: { previewUrl: 'https://app-gate.vercel.app', buildState: 'READY', healthState: 'PASSED' } }) },
    ]);
    await expect(runCli(['app-preview', '--application', 'invalid-root', '--sha', sha, '--controller', controller], writer())).rejects.toThrow(/LP-PREVIEW-RESULT-INCOMPLETE/);
  });
});

describe('health', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fails closed without a deployment URL', async () => {
    const catalog = tempCatalog();
    await expect(runCli(['health', '--catalog', catalog, '--sha', sha], writer())).rejects.toThrow(/LP-PREVIEW-URL-MISSING/);
    rmSync(catalog, { recursive: true, force: true });
  });

  it('checks the returned deployment URL and exits non-zero on a failed health result', async () => {
    const catalog = tempCatalog();
    const outputDir = tempDir('launchpad-cli-health-');
    stubFetch([{ match: /https:\/\/lp-pr-1-invalid-root\.vercel\.app\//, response: () => new Response('boom', { status: 503 }) }]);
    const out = writer();
    const exitCode = await runCli(['health', '--catalog', catalog, '--sha', sha, '--url', 'https://lp-pr-1-invalid-root.vercel.app', '--output', outputDir], out);
    expect(exitCode).toBe(1);
    const results = JSON.parse(readFileSync(join(outputDir, 'health-results.json'), 'utf8')) as { applications: Array<{ result: { result: string } }> };
    expect(results.applications[0]?.result.result).toBe('FAILED');
    rmSync(catalog, { recursive: true, force: true });
    rmSync(outputDir, { recursive: true, force: true });
  });

  it('passes when the returned deployment URL is healthy', async () => {
    const catalog = tempCatalog();
    stubFetch([{ match: /https:\/\/ok\.vercel\.app\//, response: () => new Response('ok', { status: 200 }) }]);
    const out = writer();
    const exitCode = await runCli(['health', '--catalog', catalog, '--sha', sha, '--url', 'https://ok.vercel.app'], out);
    expect(exitCode).toBe(0);
    const results = JSON.parse(out.text) as { applications: Array<{ result: { result: string } }> };
    expect(results.applications[0]?.result.result).toBe('PASSED');
    rmSync(catalog, { recursive: true, force: true });
  });

  it('uses the requested environment health policy and records that environment', async () => {
    const catalog = tempCatalog();
    const manifest = join(catalog, 'apps', 'invalid-root.yaml');
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(
      'production: {enabled: true, health: {path: /api/health,',
      'production: {enabled: true, health: {path: /readyz,',
    ));
    stubFetch([{ match: /https:\/\/prod\.example\.com\/readyz/, response: () => new Response('ok', { status: 200 }) }]);
    const out = writer();

    const exitCode = await runCli(['health', '--catalog', catalog, '--sha', sha, '--environment', 'production', '--url', 'https://prod.example.com'], out);

    expect(exitCode).toBe(0);
    const results = JSON.parse(out.text) as { applications: Array<{ result: { environment: string } }> };
    expect(results.applications[0]?.result.environment).toBe('production');
    rmSync(catalog, { recursive: true, force: true });
  });


  it('rejects a health check for an environment the application does not enable', async () => {
    const catalog = tempCatalog();
    await expect(runCli(['health', '--catalog', catalog, '--sha', sha, '--environment', 'staging', '--url', 'https://staging.example.com'], writer())).rejects.toThrow(/LP-ENVIRONMENT-NOT-CONFIGURED/);
    rmSync(catalog, { recursive: true, force: true });
  });
  it('rejects an unknown health environment', async () => {
    const catalog = tempCatalog();
    await expect(runCli(['health', '--catalog', catalog, '--sha', sha, '--environment', 'qa', '--url', 'https://qa.example.com'], writer())).rejects.toThrow(/LP-ENVIRONMENT-INVALID/);
    rmSync(catalog, { recursive: true, force: true });
  });
});

describe('status', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fails closed without a controller', async () => {
    vi.stubEnv('LAUNCHPAD_CONTROLLER_URL', '');
    await expect(runCli(['status'], writer())).rejects.toThrow(/LP-CONTROLLER-UNAVAILABLE/);
  });

  it('fails closed without a controller token', async () => {
    vi.stubEnv('LAUNCHPAD_CONTROLLER_URL', 'http://controller.test');
    vi.stubEnv('LAUNCHPAD_OPERATOR_TOKEN', '');
    await expect(runCli(['status'], writer())).rejects.toThrow(/LP-CONTROLLER-TOKEN-MISSING/);
  });

  it('reports real persisted state from controller responses as machine-readable JSON', async () => {
    vi.stubEnv('LAUNCHPAD_OPERATOR_TOKEN', 'operator-token');
    stubFetch([
      { match: /\/v1\/applications$/, response: () => jsonResponse({ applications: [{ id: 'app-1', owner: '@platform' }] }) },
      { match: /\/v1\/applications\/app-1$/, response: () => jsonResponse({ application: { id: 'app-1' }, operations: [{ id: 'op-1', status: 'SUCCEEDED' }] }) },
      { match: /\/v1\/applications\/app-1\/health$/, response: () => jsonResponse({ applicationId: 'app-1', checks: [{ result: 'PASSED' }] }) },
      { match: /\/v1\/applications\/app-1\/deployments$/, response: () => jsonResponse({ applicationId: 'app-1', deployments: [{ id: 'd-1', state: 'CURRENT', url: 'https://app.example.com' }] }) },
    ]);
    const out = writer();
    const exitCode = await runCli(['status'], out);
    expect(exitCode).toBe(0);
    const report = JSON.parse(out.text) as { applications: Array<{ application: string; sync: string; health: string; deployment: string }> };
    expect(report.applications[0]).toMatchObject({ application: 'app-1', sync: 'SYNCED', health: 'PASSED', deployment: 'https://app.example.com' });
  });

  it('fails closed when the controller rejects a status read', async () => {
    vi.stubEnv('LAUNCHPAD_OPERATOR_TOKEN', 'operator-token');
    stubFetch([
      { match: /\/v1\/applications$/, response: () => jsonResponse({ error: 'operator authentication required' }, 401) },
    ]);
    await expect(runCli(['status'], writer())).rejects.toThrow(/LP-CONTROLLER-RESPONSE-INVALID/);
  });
});

describe('report-pr', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts one sticky comment from real artifacts and fails closed when plan artifacts are missing', async () => {
    const catalog = tempCatalog();
    const artifactsDir = tempDir('launchpad-cli-report-');
    const plan = planFor();
    writeFileSync(join(artifactsDir, 'plans.json'), JSON.stringify([plan]));
    writeFileSync(join(artifactsDir, 'preview-summary.json'), JSON.stringify({ sourceCommit: sha, applications: [{ applicationId: 'invalid-root', state: 'READY', url: 'https://lp.example', message: 'Build READY; health PASSED.' }] }));
    writeFileSync(join(artifactsDir, 'health-results.json'), JSON.stringify({ sourceCommit: sha, applications: [{ applicationId: 'invalid-root', url: 'https://lp.example', result: { result: 'PASSED', errorCode: null } }] }));
    vi.stubEnv('GITHUB_REPOSITORY', 'example/launchpad');
    vi.stubEnv('GITHUB_TOKEN', 'github-token');
    vi.stubEnv('GITHUB_PR_NUMBER', '7');
    stubFetch([
      { match: /\/repos\/example\/launchpad\/issues\/7\/comments\?/, response: () => jsonResponse([]) },
      { match: /\/repos\/example\/launchpad\/issues\/7\/comments$/, response: (url, init) => {
        const body = JSON.parse(String(init?.body)) as { body: string };
        expect(body.body).toContain('<!-- launchpad:plan -->');
        expect(body.body).toContain('sha256:');
        expect(body.body).toContain('[open preview](https://lp.example)');
        return jsonResponse({ id: 1, html_url: 'https://github.com/example/launchpad/pull/7#issuecomment-1' }, 201);
      } },
    ]);
    const out = writer();
    const exitCode = await runCli(['report-pr', '--catalog', catalog, '--sha', sha, '--artifacts', artifactsDir], out);
    expect(exitCode).toBe(0);
    expect(out.text).toContain('Launchpad PR comment: https://github.com/example/launchpad/pull/7#issuecomment-1');
    rmSync(catalog, { recursive: true, force: true });
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('fails closed when the plan artifact is absent', async () => {
    const catalog = tempCatalog();
    const artifactsDir = tempDir('launchpad-cli-report-');
    vi.stubEnv('GITHUB_REPOSITORY', 'example/launchpad');
    vi.stubEnv('GITHUB_TOKEN', 'github-token');
    vi.stubEnv('GITHUB_PR_NUMBER', '7');
    await expect(runCli(['report-pr', '--catalog', catalog, '--sha', sha, '--artifacts', artifactsDir], writer())).rejects.toThrow(/LP-ARTIFACT-MISSING/);
    rmSync(catalog, { recursive: true, force: true });
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('posts one escaped redacted failure comment and returns non-zero when schema/catalog jobs failed and no plans exist', async () => {
    const catalog = tempCatalog([{ name: 'broken.yaml', content: 'kind: Application\nmetadata:\n  id: broken\n' }]);
    const artifactsDir = tempDir('launchpad-cli-report-');
    writeFileSync(join(artifactsDir, 'job-results.json'), JSON.stringify({
      schemaVersion: 'launchpad.job-results/v1',
      sourceCommit: sha,
      jobs: [
        { name: 'schema', result: 'failure' },
        { name: 'catalog', result: 'failure' },
        { name: 'provider-preflight', result: 'skipped' },
        { name: 'plan', result: 'skipped' },
        { name: 'preview', result: 'skipped' },
        { name: 'health', result: 'skipped' },
      ],
    }));
    writeFileSync(join(artifactsDir, 'provider-error-redacted.json'), JSON.stringify({ code: 'LP-SCHEMA-INVALID', message: '<script>token=super-secret-value</script>', operationId: null, retryable: false }));
    vi.stubEnv('GITHUB_REPOSITORY', 'example/launchpad');
    vi.stubEnv('GITHUB_TOKEN', 'github-token');
    vi.stubEnv('GITHUB_PR_NUMBER', '7');
    stubFetch([
      { match: /\/repos\/example\/launchpad\/issues\/7\/comments\?/, response: () => jsonResponse([]) },
      { match: /\/repos\/example\/launchpad\/issues\/7\/comments$/, response: (url, init) => {
        const body = JSON.parse(String(init?.body)) as { body: string };
        expect(body.body).toContain('<!-- launchpad:plan -->');
        expect(body.body).toContain('### Launchpad validation failed');
        expect(body.body).toContain('`schema` — failure');
        expect(body.body).toContain('&lt;script&gt;');
        expect(body.body).not.toContain('<script>');
        expect(body.body).toContain('token=[REDACTED]');
        expect(body.body).not.toContain('super-secret-value');
        expect(body.body).not.toContain('READY');
        return jsonResponse({ id: 2, html_url: 'https://github.com/example/launchpad/pull/7#issuecomment-2' }, 201);
      } },
    ]);
    const out = writer();
    const exitCode = await runCli(['report-pr', '--catalog', catalog, '--sha', sha, '--artifacts', artifactsDir], out);
    expect(exitCode).toBe(1);
    expect(out.text).toContain('Launchpad PR comment: https://github.com/example/launchpad/pull/7#issuecomment-2');
    rmSync(catalog, { recursive: true, force: true });
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('updates the sticky failure comment in place when upstream jobs failed and no plans exist', async () => {
    const catalog = tempCatalog();
    const artifactsDir = tempDir('launchpad-cli-report-');
    writeFileSync(join(artifactsDir, 'job-results.json'), JSON.stringify({ jobs: [{ name: 'schema', result: 'failure' }, { name: 'plan', result: 'cancelled' }] }));
    writeFileSync(join(artifactsDir, 'preview-summary.json'), JSON.stringify({ sourceCommit: sha, applications: [{ applicationId: 'invalid-root', state: 'ERROR', url: 'https://lp.example', message: 'build failed' }] }));
    vi.stubEnv('GITHUB_REPOSITORY', 'example/launchpad');
    vi.stubEnv('GITHUB_TOKEN', 'github-token');
    vi.stubEnv('GITHUB_PR_NUMBER', '7');
    stubFetch([
      { match: /\/repos\/example\/launchpad\/issues\/7\/comments\?/, response: () => jsonResponse([{ id: 41, body: '<!-- launchpad:plan -->\nstale READY report' }]) },
      { match: /\/repos\/example\/launchpad\/issues\/comments\/41$/, response: (url, init) => {
        const body = JSON.parse(String(init?.body)) as { body: string };
        expect(body.body).toContain('### Launchpad validation failed');
        expect(body.body).toContain('`plan` — cancelled');
        expect(body.body).toContain('### Preview failures');
        expect(body.body).toContain('build failed');
        expect(body.body).not.toContain('stale READY report');
        return jsonResponse({ id: 41, html_url: 'https://github.com/example/launchpad/pull/7#issuecomment-41' }, 200);
      } },
    ]);
    const out = writer();
    const exitCode = await runCli(['report-pr', '--catalog', catalog, '--sha', sha, '--artifacts', artifactsDir], out);
    expect(exitCode).toBe(1);
    expect(out.text).toContain('Launchpad PR comment: https://github.com/example/launchpad/pull/7#issuecomment-41');
    rmSync(catalog, { recursive: true, force: true });
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('bounds an oversized report body at 60,000 chars with a truncation link marker', async () => {
    const catalog = tempCatalog();
    const artifactsDir = tempDir('launchpad-cli-report-');
    writeFileSync(join(artifactsDir, 'job-results.json'), JSON.stringify({ jobs: [{ name: 'schema', result: 'failure' }] }));
    writeFileSync(join(artifactsDir, 'provider-error-redacted.json'), JSON.stringify({ code: 'LP-SCHEMA-INVALID', message: `token=canary-secret ${'x'.repeat(100_000)}`, operationId: null, retryable: false }));
    vi.stubEnv('GITHUB_REPOSITORY', 'example/launchpad');
    vi.stubEnv('GITHUB_TOKEN', 'github-token');
    vi.stubEnv('GITHUB_PR_NUMBER', '7');
    vi.stubEnv('GITHUB_SERVER_URL', 'https://github.test');
    vi.stubEnv('GITHUB_RUN_ID', '123456');
    stubFetch([
      { match: /\/repos\/example\/launchpad\/issues\/7\/comments\?/, response: () => jsonResponse([]) },
      { match: /\/repos\/example\/launchpad\/issues\/7\/comments$/, response: (url, init) => {
        const body = JSON.parse(String(init?.body)) as { body: string };
        expect(body.body.length).toBeLessThanOrEqual(60_000);
        expect(body.body.startsWith('<!-- launchpad:plan -->')).toBe(true);
        expect(body.body).toContain('…[truncated]');
        expect(body.body).toContain('https://github.test/example/launchpad/actions/runs/123456');
        expect(body.body).toContain('token=[REDACTED]');
        expect(body.body).not.toContain('canary-secret');
        return jsonResponse({ id: 3, html_url: 'https://github.com/example/launchpad/pull/7#issuecomment-3' }, 201);
      } },
    ]);
    const out = writer();
    const exitCode = await runCli(['report-pr', '--catalog', catalog, '--sha', sha, '--artifacts', artifactsDir], out);
    expect(exitCode).toBe(1);
    expect(out.text).toContain('Launchpad PR comment: https://github.com/example/launchpad/pull/7#issuecomment-3');
    rmSync(catalog, { recursive: true, force: true });
    rmSync(artifactsDir, { recursive: true, force: true });
  });
});

describe('controller token selection', () => {
  afterEach(() => vi.unstubAllGlobals());

  const controller = 'http://controller.test';

  /** Simulates a workflow run with both OIDC env present and an explicit operator token. */
  function bothEnv(): void {
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', 'http://oidc.test/request');
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'request-token');
    vi.stubEnv('LAUNCHPAD_OPERATOR_TOKEN', 'operator-token');
    vi.stubEnv('GITHUB_REPOSITORY', 'example/launchpad');
  }

  it('reconcile authenticates with the explicit operator token even when workflow OIDC env is present', async () => {
    const catalog = tempCatalog();
    bothEnv();
    stubFetch([
      oidcRoute(),
      { match: /\/v1\/cli\/reconcile$/, response: (url, init) => {
        expect(bearerOf(init)).toBe('Bearer operator-token');
        expect(JSON.parse(String(init?.body))).toMatchObject({ applicationIds: ['invalid-root'], automatic: false });
        return jsonResponse({ status: 'QUEUED', instanceIds: ['wf-1'], applicationIds: ['invalid-root'] }, 202);
      } },
    ]);
    const out = writer();
    const exitCode = await runCli(['reconcile', '--catalog', catalog, '--controller', controller], out);
    expect(exitCode).toBe(0);
    expect(JSON.parse(out.text)).toMatchObject({ status: 'QUEUED', instanceIds: ['wf-1'] });
    rmSync(catalog, { recursive: true, force: true });
  });

  it('marks a scheduled reconciliation request as automatic only when explicitly configured', async () => {
    const catalog = tempCatalog();
    bothEnv();
    vi.stubEnv('LAUNCHPAD_AUTOMATED_RECONCILIATION', 'true');
    stubFetch([
      oidcRoute(),
      { match: /\/v1\/cli\/reconcile$/, response: (url, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({ applicationIds: ['invalid-root'], automatic: true });
        return jsonResponse({ status: 'QUEUED', instanceIds: ['wf-1'], applicationIds: ['invalid-root'] }, 202);
      } },
    ]);
    await expect(runCli(['reconcile', '--catalog', catalog, '--controller', controller], writer())).resolves.toBe(0);
    rmSync(catalog, { recursive: true, force: true });
  });

  it('destroy authenticates with the explicit operator token even when workflow OIDC env is present', async () => {
    const catalog = tempCatalog();
    bothEnv();
    stubFetch([
      oidcRoute(),
      { match: /\/v1\/cli\/destroy$/, response: (url, init) => {
        expect(bearerOf(init)).toBe('Bearer operator-token');
        expect(JSON.parse(String(init?.body))).toMatchObject({ applicationId: 'invalid-root', approvalToken: 'approval-1' });
        return jsonResponse({ status: 'QUEUED', workflowId: 'wf-1' }, 202);
      } },
    ]);
    const out = writer();
    const exitCode = await runCli(['destroy', '--catalog', catalog, '--app', 'invalid-root', '--approval-token', 'approval-1', '--controller', controller], out);
    expect(exitCode).toBe(0);
    rmSync(catalog, { recursive: true, force: true });
  });

  it('preview authenticates with the workflow OIDC token, never the operator token', async () => {
    const catalog = tempCatalog();
    const plansDir = tempDir('launchpad-cli-plans-');
    writeFileSync(join(plansDir, 'plans.json'), JSON.stringify([planFor()]));
    bothEnv();
    stubFetch([
      oidcRoute(),
      { match: /\/v1\/plans\/verify$/, response: (url, init) => {
        expect(bearerOf(init)).toBe(`Bearer ${oidcJwt}`);
        return jsonResponse({ accepted: true, deduplicated: false, attestationId: 'att-1' });
      } },
      { match: /\/v1\/applications\/invalid-root\/preview\/verify$/, response: (url, init) => {
        expect(bearerOf(init)).toBe(`Bearer ${oidcJwt}`);
        return jsonResponse({ workflowId: 'wf-1', operationId: 'op-1', status: 'QUEUED' }, 202);
      } },
      { match: /\/v1\/operations\/op-1$/, response: () => jsonResponse({ operationId: 'op-1', workflowId: 'wf-1', applicationId: 'invalid-root', kind: 'preview', status: 'SUCCEEDED', errorCode: null, sourceCommit: sha, result: { previewUrl: 'https://lp.example', buildState: 'READY', healthState: 'PASSED' } }) },
    ]);
    const out = writer();
    const exitCode = await runCli(['preview', '--catalog', catalog, '--sha', sha, '--controller', controller, '--plans', join(plansDir, 'plans.json')], out);
    expect(exitCode).toBe(0);
    expect(JSON.parse(out.text)).toMatchObject({ applications: [{ state: 'READY', url: 'https://lp.example' }] });
    rmSync(catalog, { recursive: true, force: true });
    rmSync(plansDir, { recursive: true, force: true });
  });

  it('apply authenticates with the workflow OIDC token, never the operator token', async () => {
    const catalog = tempCatalog();
    const plansDir = tempDir('launchpad-cli-plans-');
    writeFileSync(join(plansDir, 'plans.json'), JSON.stringify([planFor()]));
    bothEnv();
    stubFetch([
      oidcRoute(),
      { match: /\/v1\/applications\/invalid-root\/apply$/, response: (url, init) => {
        expect(bearerOf(init)).toBe(`Bearer ${oidcJwt}`);
        return jsonResponse({ workflowId: 'wf-1', operationId: 'op-1', status: 'QUEUED' }, 202);
      } },
      { match: /\/v1\/operations\/op-1$/, response: () => jsonResponse({ operationId: 'op-1', workflowId: 'wf-1', applicationId: 'invalid-root', kind: 'apply', status: 'SUCCEEDED', errorCode: null, sourceCommit: sha, result: {} }) },
    ]);
    const out = writer();
    const exitCode = await runCli(['apply', '--catalog', catalog, '--sha', sha, '--controller', controller, '--plans', join(plansDir, 'plans.json')], out);
    expect(exitCode).toBe(0);
    expect(out.text).toContain('"status": "SUCCEEDED"');
    rmSync(catalog, { recursive: true, force: true });
    rmSync(plansDir, { recursive: true, force: true });
  });

  it('fails closed with LP-CONTROLLER-TOKEN-MISSING when the OIDC endpoint returns JSON without a non-empty string value', async () => {
    const catalog = tempCatalog();
    const plansDir = tempDir('launchpad-cli-plans-');
    writeFileSync(join(plansDir, 'plans.json'), JSON.stringify([planFor()]));
    bothEnv();
    for (const body of [{ value: 42 }, { value: '' }, {}]) {
      stubFetch([
        { match: /oidc\.test\/request/, response: () => jsonResponse(body) },
        { match: /\/v1\/applications\/invalid-root\/preview\/verify$/, response: (url, init) => {
          expect(bearerOf(init)).not.toContain('{'); // raw JSON text is never sent as a bearer
          return jsonResponse({ workflowId: 'wf-1', operationId: 'op-1', status: 'QUEUED' }, 202);
        } },
      ]);
      await expect(runCli(['preview', '--catalog', catalog, '--sha', sha, '--controller', controller, '--plans', join(plansDir, 'plans.json')], writer())).rejects.toThrow(/LP-CONTROLLER-TOKEN-MISSING/);
    }
    rmSync(catalog, { recursive: true, force: true });
    rmSync(plansDir, { recursive: true, force: true });
  });
});

describe('workflow least permissions', () => {
  const workflowsRoot = join(process.cwd(), '.github/workflows');

  it('keeps reconcile and destroy on operator credentials only: no id-token: write, top-level permissions: {}, contents: read, operator token env wired', () => {
    for (const name of ['reconcile.yml', 'destroy.yml']) {
      const content = readFileSync(join(workflowsRoot, name), 'utf8');
      expect(content, name).toContain('permissions: {}');
      expect(content, name).toContain('contents: read');
      expect(content, name).not.toContain('id-token');
      expect(content, name).toContain('LAUNCHPAD_OPERATOR_TOKEN');
    }
  });

  it('retains id-token: write for the OIDC-authenticated apply and preview workflows', () => {
    const apply = readFileSync(join(workflowsRoot, 'apply.yml'), 'utf8');
    const validatePlan = readFileSync(join(workflowsRoot, 'validate-plan.yml'), 'utf8');
    const reusablePreview = readFileSync(join(workflowsRoot, 'reusable-app-preview.yml'), 'utf8');
    expect(apply).toContain('id-token: write');
    expect(validatePlan).toContain('id-token: write');
    expect(reusablePreview).toContain('id-token: write');
  });
});
