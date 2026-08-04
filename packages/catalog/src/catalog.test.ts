import { describe, expect, it } from 'vitest';
import { loadCatalog } from './index.js';

const valid = (overrides = '') => `
apiVersion: launchpad.dev/v1
kind: Application
metadata:
  id: fixture-app
  displayName: Fixture App
  owners: ["@platform"]
  labels: {team: platform}
  annotations: {}
repository:
  provider: github
  name: example/fixture
  productionBranch: main
  deploymentRef: main
vercel:
  scope: {}
  project:
    name: fixture-app
    framework: nextjs
    rootDirectory: .
    nodeVersion: "24.x"
    build:
      installCommand: yarn install --immutable
      buildCommand: yarn build
      outputDirectory: null
      developmentCommand: yarn dev
      ignoredBuildStep: null
    git: {connected: true, productionBranch: main}
    deployment:
      autoAssignProductionDomains: false
      prioritizeProductionBuilds: true
      rollingRelease: null
      skewProtection: false
    regions: {functions: [iad1]}
    protection: {preview: public, production: public}
    settings: {webAnalytics: true}
environments:
  preview:
    enabled: true
    strategy: shadow-project
    health: {path: /api/health, method: GET, expectedStatus: [200], timeoutSeconds: 10, attempts: 2, intervalSeconds: 1}
  production:
    enabled: true
    health: {path: /api/health, method: GET, expectedStatus: [200], timeoutSeconds: 10, attempts: 2, intervalSeconds: 1}
domains:
  - hostname: fixture.example.com
    environment: production
    canonical: true
    cloudflare: {zoneRef: config://cloudflare/example.com, mode: dns-only, ttl: auto}
    redirects: []
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
${overrides}`;

describe('catalog loader and semantic validator', () => {
  it('loads a valid application and produces canonical output', () => {
    const result = loadCatalog([{ path: 'catalog/apps/fixture.yaml', content: valid() }]);
    expect(result.issues).toEqual([]);
    expect(result.applications[0]?.metadata.id).toBe('fixture-app');
    expect(result.canonical).toContain('fixture-app');
  });

  it('reports unknown fields with file and field context', () => {
    const result = loadCatalog([{ path: 'catalog/apps/bad.yaml', content: `${valid()}unknownField: true\n` }]);
    expect(result.issues.some((issue) => issue.path.includes('unknownField'))).toBe(true);
    expect(result.issues[0]?.file).toBe('catalog/apps/bad.yaml');
  });

  it('blocks duplicate ids, projects, and domains', () => {
    const second = valid().replace('    name: fixture-app', '    name: second-project');
    const result = loadCatalog([
      { path: 'catalog/apps/a.yaml', content: valid() },
      { path: 'catalog/apps/b.yaml', content: second },
    ]);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['LP-CATALOG-DUPLICATE-ID', 'LP-CATALOG-DUPLICATE-DOMAIN']));
  });

  it('blocks dependency cycles and missing references', () => {
    const first = valid().replace('applications: []', 'applications: [second]');
    const second = valid().replaceAll('fixture-app', 'second').replace('applications: []', 'applications: [fixture-app]');
    const result = loadCatalog([
      { path: 'catalog/apps/a.yaml', content: first },
      { path: 'catalog/apps/b.yaml', content: second },
    ]);
    expect(result.issues.some((issue) => issue.code === 'LP-CATALOG-DEPENDENCY-CYCLE')).toBe(true);
  });

  it('blocks plaintext sensitive values', () => {
    const result = loadCatalog([{ path: 'catalog/apps/secrets.yaml', content: valid().replace('secrets: []', 'secrets:\n  - name: TOKEN\n    value: plain\n    sensitive: true\n    environments: [production]') }]);
    expect(result.issues.some((issue) => issue.code === 'LP-SECRET-PLAINTEXT')).toBe(true);
  });

  it('blocks invalid lifecycle transitions when prior state is supplied', () => {
    const result = loadCatalog([{ path: 'catalog/apps/lifecycle.yaml', content: valid().replace('state: active', 'state: deleted') }], { previousLifecycle: { 'fixture-app': 'active' } });
    expect(result.issues.some((issue) => issue.code === 'LP-LIFECYCLE-TRANSITION')).toBe(true);
  });
});
