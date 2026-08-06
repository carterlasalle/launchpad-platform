import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@launchpad/shared';
import { loadCatalog, migrateSchemaVersion, parseZoneRegistry } from './index.js';
import type { CatalogIssue } from './source.js';

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

/** Position of the first occurrence of a needle, 1-based line and column. */
function at(content: string, needle: string): { line: number; column: number } {
  const index = content.indexOf(needle);
  if (index < 0) throw new Error(`Needle not found in manifest: ${needle}`);
  const before = content.slice(0, index);
  return { line: before.split('\n').length, column: index - before.lastIndexOf('\n') };
}

const codes = (issues: CatalogIssue[]): string[] => issues.map((issue) => issue.code);
const findIssue = (issues: CatalogIssue[], code: string): CatalogIssue => {
  const issue = issues.find((candidate) => candidate.code === code);
  if (!issue) throw new Error(`Expected issue ${code} not found in ${codes(issues).join(', ')}`);
  return issue;
};

const cloudflareFlow = 'cloudflare: {zoneRef: config://cloudflare/example.com, mode: dns-only, ttl: auto}';

describe('catalog loader and semantic validator', () => {
  it('loads a valid application and produces canonical output', () => {
    const result = loadCatalog([{ path: 'catalog/apps/fixture.yaml', content: valid() }]);
    expect(result.issues).toEqual([]);
    expect(result.applications[0]?.metadata.id).toBe('fixture-app');
    expect(result.canonical).toContain('fixture-app');
  });

  it('reports unknown fields with exact file, line, column, and field path', () => {
    const content = valid().replace('  annotations: {}', '  annotations: {}\n  extra: true');
    const result = loadCatalog([{ path: 'catalog/apps/bad.yaml', content }]);
    const issue = findIssue(result.issues, 'LP-SCHEMA-UNKNOWN-FIELD');
    expect(issue.file).toBe('catalog/apps/bad.yaml');
    expect(issue.path).toBe('metadata.extra');
    expect(issue.line).toBe(at(content, 'extra: true').line);
    expect(issue.column).toBe(at(content, 'extra: true').column);
    expect(issue.remediation).toContain('Remove the unknown field');
  });

  it('reports missing required fields with a field path', () => {
    const content = valid().replace('  id: fixture-app\n', '');
    const result = loadCatalog([{ path: 'catalog/apps/missing-id.yaml', content }]);
    const issue = findIssue(result.issues, 'LP-SCHEMA-INVALID');
    expect(issue.path).toBe('metadata.id');
    expect(issue.line).toBeGreaterThan(0);
  });

  it('blocks duplicate ids, projects, and domains with exact locations', () => {
    const second = valid().replace('    name: fixture-app', '    name: second-project');
    const result = loadCatalog([
      { path: 'catalog/apps/a.yaml', content: valid() },
      { path: 'catalog/apps/b.yaml', content: second },
    ]);
    expect(codes(result.issues)).toEqual(expect.arrayContaining(['LP-CATALOG-DUPLICATE-ID', 'LP-CATALOG-DUPLICATE-DOMAIN']));
    const duplicateId = findIssue(result.issues, 'LP-CATALOG-DUPLICATE-ID');
    expect(duplicateId.file).toBe('catalog/apps/b.yaml');
    expect(duplicateId.path).toBe('metadata.id');
    expect(duplicateId.line).toBe(at(second, 'id: fixture-app').line);
    const duplicateDomain = findIssue(result.issues, 'LP-CATALOG-DUPLICATE-DOMAIN');
    expect(duplicateDomain.path).toBe('domains.0.hostname');
    expect(duplicateDomain.line).toBe(at(second, 'fixture.example.com').line);
  });

  it('blocks dependency cycles and missing references with exact locations', () => {
    const first = valid().replace('applications: []', 'applications: [second]');
    const second = valid().replaceAll('fixture-app', 'second').replace('applications: []', 'applications: [fixture-app]');
    const result = loadCatalog([
      { path: 'catalog/apps/a.yaml', content: first },
      { path: 'catalog/apps/b.yaml', content: second },
    ]);
    const cycle = findIssue(result.issues, 'LP-CATALOG-DEPENDENCY-CYCLE');
    expect(cycle.path).toBe('dependencies.applications.0');
    expect(cycle.line).toBe(at(first, 'second').line);
    expect(cycle.column).toBe(at(first, 'second').column);
  });

  it('blocks missing application dependencies at the exact reference', () => {
    const content = valid().replace('applications: []', 'applications: [ghost-app]');
    const result = loadCatalog([{ path: 'catalog/apps/ghost.yaml', content }]);
    const issue = findIssue(result.issues, 'LP-CATALOG-MISSING-DEPENDENCY');
    expect(issue.path).toBe('dependencies.applications.0');
    expect(issue.line).toBe(at(content, 'ghost-app').line);
    expect(issue.column).toBe(at(content, 'ghost-app').column);
  });

  it('blocks plaintext sensitive values', () => {
    const content = valid().replace('secrets: []', 'secrets:\n  - name: TOKEN\n    value: plain\n    sensitive: true\n    environments: [production]');
    const result = loadCatalog([{ path: 'catalog/apps/secrets.yaml', content }]);
    const issue = findIssue(result.issues, 'LP-SECRET-PLAINTEXT');
    expect(issue.path).toBe('secrets.0.value');
    expect(issue.line).toBe(at(content, 'value: plain').line);
    expect(issue.column).toBe(at(content, 'value: plain').column);
  });

  it('requires exactly one secret source or value', () => {
    const neither = valid().replace('secrets: []', 'secrets:\n  - name: TOKEN\n    environments: [production]');
    const both = valid().replace('secrets: []', 'secrets:\n  - name: TOKEN\n    source: infisical://app/prod/TOKEN\n    value: x\n    environments: [production]');
    expect(codes(loadCatalog([{ path: 'catalog/apps/s1.yaml', content: neither }]).issues)).toContain('LP-SECRET-SOURCE');
    expect(codes(loadCatalog([{ path: 'catalog/apps/s2.yaml', content: both }]).issues)).toContain('LP-SECRET-SOURCE');
  });

  it('allows one secret name per environment, blocks overlapping environments', () => {
    const disjoint = valid().replace('secrets: []', 'secrets:\n  - name: DATABASE_URL\n    source: infisical://app/prod/DATABASE_URL\n    environments: [production]\n  - name: DATABASE_URL\n    source: infisical://app/staging/DATABASE_URL\n    environments: [preview]');
    const overlapping = valid().replace('secrets: []', 'secrets:\n  - name: DATABASE_URL\n    source: infisical://app/prod/DATABASE_URL\n    environments: [production]\n  - name: DATABASE_URL\n    source: infisical://app/staging/DATABASE_URL\n    environments: [preview, production]');
    expect(loadCatalog([{ path: 'catalog/apps/s3.yaml', content: disjoint }]).issues).toEqual([]);
    const issue = findIssue(loadCatalog([{ path: 'catalog/apps/s4.yaml', content: overlapping }]).issues, 'LP-SECRET-DUPLICATE-ENVIRONMENT');
    expect(issue.path).toBe('secrets.1.name');
  });

  it('resolves secret references from variables and health headers', () => {
    const withSecrets = (variables: string): string =>
      valid()
        .replace('secrets: []', 'secrets:\n  - name: TOKEN\n    source: infisical://app/prod/TOKEN\n    environments: [preview]\n  - name: PUBLIC_BASE\n    value: https://example.com\n    sensitive: false\n    environments: [preview]')
        .replace('    strategy: shadow-project\n', `    strategy: shadow-project\n    variables:${variables}\n`);

    const missing = findIssue(loadCatalog([{ path: 'catalog/apps/v1.yaml', content: withSecrets('\n      API_TOKEN: {secretRef: GHOST, sensitive: true}') }]).issues, 'LP-SECRET-REFERENCE-MISSING');
    expect(missing.path).toBe('environments.preview.variables.API_TOKEN');

    const nonSensitive = findIssue(loadCatalog([{ path: 'catalog/apps/v2.yaml', content: withSecrets('\n      API_TOKEN: {secretRef: PUBLIC_BASE, sensitive: true}') }]).issues, 'LP-SECRET-REFERENCE-SENSITIVITY');
    expect(nonSensitive.path).toBe('environments.preview.variables.API_TOKEN');

    const resolved = withSecrets('\n      API_TOKEN: {secretRef: TOKEN, sensitive: true}');
    expect(loadCatalog([{ path: 'catalog/apps/v3.yaml', content: resolved }]).issues).toEqual([]);

    const headerContent = valid().replace(
      '    strategy: shadow-project\n    health: {path: /api/health, method: GET, expectedStatus: [200], timeoutSeconds: 10, attempts: 2, intervalSeconds: 1}',
      '    strategy: shadow-project\n    health:\n      path: /api/health\n      method: GET\n      expectedStatus: [200]\n      timeoutSeconds: 10\n      attempts: 2\n      intervalSeconds: 1\n      headers: {Authorization: {secretRef: GHOST}}',
    );
    const headerMissing = findIssue(loadCatalog([{ path: 'catalog/apps/v5.yaml', content: headerContent }]).issues, 'LP-SECRET-REFERENCE-MISSING');
    expect(headerMissing.path).toBe('environments.preview.health.headers.Authorization');
  });

  it('blocks invalid lifecycle transitions and reverse recovery without policy', () => {
    const deleted = valid().replace('state: active', 'state: deleted');
    const transition = findIssue(loadCatalog([{ path: 'catalog/apps/lifecycle.yaml', content: deleted }], { previousLifecycle: { 'fixture-app': 'active' } }).issues, 'LP-LIFECYCLE-TRANSITION');
    expect(transition.path).toBe('lifecycle.state');
    expect(transition.line).toBe(at(deleted, 'state: deleted').line);
    const recovery = findIssue(loadCatalog([{ path: 'catalog/apps/lifecycle.yaml', content: valid() }], { previousLifecycle: { 'fixture-app': 'decommissioning' } }).issues, 'LP-LIFECYCLE-RECOVERY');
    expect(recovery.path).toBe('lifecycle.state');
    const permitted = valid().replace('lifecycle:\n  state: active', 'lifecycle:\n  state: active\n  recoveryPolicy: {allowReactivateBeforeDeletionApproval: true}');
    expect(loadCatalog([{ path: 'catalog/apps/lifecycle.yaml', content: permitted }], { previousLifecycle: { 'fixture-app': 'decommissioning' } }).issues).toEqual([]);
  });

  it('requires complete deletion fields at approved-for-deletion', () => {
    const incomplete = valid()
      .replace('  state: active', '  state: approved-for-deletion')
      .replace('  deletionProtection: true', '  deletionProtection: false');
    const result = loadCatalog([{ path: 'catalog/apps/delete.yaml', content: incomplete }], { previousLifecycle: { 'fixture-app': 'decommissioning' } });
    expect(codes(result.issues)).toContain('LP-LIFECYCLE-DECOMMISSION-REQUEST');
    expect(codes(result.issues)).toContain('LP-LIFECYCLE-DELETION-SCHEDULE');
    expect(findIssue(result.issues, 'LP-LIFECYCLE-DECOMMISSION-REQUEST').path).toBe('lifecycle.decommission.requestedAt');
    expect(findIssue(result.issues, 'LP-LIFECYCLE-DELETION-SCHEDULE').path).toBe('lifecycle.decommission.deleteAfter');
    const complete = incomplete.replace('requestedAt: null', 'requestedAt: 2026-08-04T00:00:00Z').replace('deleteAfter: null', 'deleteAfter: 2026-08-11T00:00:00Z');
    expect(loadCatalog([{ path: 'catalog/apps/delete.yaml', content: complete }], { previousLifecycle: { 'fixture-app': 'decommissioning' } }).issues).toEqual([]);
  });

  it('blocks deletion approval while deletionProtection remains enabled', () => {
    const content = valid().replace('  state: active', '  state: approved-for-deletion');
    const result = loadCatalog([{ path: 'catalog/apps/protect.yaml', content }], { previousLifecycle: { 'fixture-app': 'decommissioning' } });
    expect(codes(result.issues)).toContain('LP-LIFECYCLE-PROTECTION');
  });

  it('enforces canonical-domain, environment, zone, and redirect rules', () => {
    const twoCanonical = valid().replace(
      `domains:\n  - hostname: fixture.example.com\n    environment: production\n    canonical: true\n    ${cloudflareFlow}\n    redirects: []`,
      `domains:\n  - hostname: fixture.example.com\n    environment: production\n    canonical: true\n    ${cloudflareFlow}\n    redirects: []\n  - hostname: second.example.com\n    environment: production\n    canonical: true\n    ${cloudflareFlow}\n    redirects: []`,
    );
    const canonicalIssue = findIssue(loadCatalog([{ path: 'catalog/apps/domains.yaml', content: twoCanonical }]).issues, 'LP-DOMAIN-CANONICAL-DUPLICATE');
    expect(canonicalIssue.path).toBe('domains.1.canonical');

    const disabledEnv = valid().replace('  preview:\n    enabled: true', '  preview:\n    enabled: false').replace('    environment: production', '    environment: preview');
    const disabledIssue = findIssue(loadCatalog([{ path: 'catalog/apps/domains.yaml', content: disabledEnv }]).issues, 'LP-DOMAIN-DISABLED-ENVIRONMENT');
    expect(disabledIssue.path).toBe('domains.0.environment');

    const unknownEnv = valid().replace('    environment: production', '    environment: staging');
    const unknownEnvIssue = findIssue(loadCatalog([{ path: 'catalog/apps/domains.yaml', content: unknownEnv }]).issues, 'LP-DOMAIN-UNKNOWN-ENVIRONMENT');
    expect(unknownEnvIssue.path).toBe('domains.0.environment');

    const unknownZone = valid().replace('config://cloudflare/example.com', 'config://cloudflare/other.com');
    const zoneIssue = findIssue(loadCatalog([{ path: 'catalog/apps/domains.yaml', content: unknownZone }], { zones: ['example.com'] }).issues, 'LP-DOMAIN-ZONE-UNKNOWN');
    expect(zoneIssue.path).toBe('domains.0.cloudflare.zoneRef');
    expect(loadCatalog([{ path: 'catalog/apps/domains.yaml', content: valid() }], { zones: ['example.com'] }).issues).toEqual([]);

    const redirectCycle = valid().replace(
      '    redirects: []',
      '    redirects: [loop.example.com]\n  - hostname: loop.example.com\n    environment: production\n    cloudflare: {zoneRef: config://cloudflare/example.com, mode: dns-only, ttl: auto}\n    redirects: [fixture.example.com]',
    );
    const cycleIssues = loadCatalog([{ path: 'catalog/apps/domains.yaml', content: redirectCycle }]).issues;
    expect(codes(cycleIssues)).toContain('LP-DOMAIN-REDIRECT-CYCLE');
    expect(cycleIssues.filter((issue) => issue.code === 'LP-DOMAIN-REDIRECT-CYCLE').length).toBeGreaterThan(0);

    const unbound = valid().replace('  production:\n    enabled: true\n    health:', '  production:\n    enabled: true\n    domain: prod.example.com\n    health:');
    const unboundIssue = findIssue(loadCatalog([{ path: 'catalog/apps/domains.yaml', content: unbound }]).issues, 'LP-CATALOG-ENV-DOMAIN-UNBOUND');
    expect(unboundIssue.path).toBe('environments.production.domain');
    const bound = unbound.replace('    domain: prod.example.com', '    domain: fixture.example.com');
    expect(loadCatalog([{ path: 'catalog/apps/domains.yaml', content: bound }]).issues).toEqual([]);
  });

  it('requires proxy acknowledgment for proxied mode', () => {
    const unacknowledged = valid().replace(cloudflareFlow, 'cloudflare:\n      zoneRef: config://cloudflare/example.com\n      mode: proxied\n      ttl: auto');
    const issue = findIssue(loadCatalog([{ path: 'catalog/apps/proxy.yaml', content: unacknowledged }]).issues, 'LP-DNS-PROXY-ACKNOWLEDGMENT');
    expect(issue.path).toBe('domains.0.cloudflare.proxy.acknowledgeDoubleCdn');
    const acknowledged = valid().replace(
      cloudflareFlow,
      'cloudflare:\n      zoneRef: config://cloudflare/example.com\n      mode: proxied\n      ttl: auto\n      proxy: {acknowledgeDoubleCdn: true, bypassWellKnownPaths: true, verifyConnectingIpHeader: true, cachePolicy: standard}',
    );
    expect(loadCatalog([{ path: 'catalog/apps/proxy.yaml', content: acknowledged }]).issues).toEqual([]);
  });

  it('blocks unsupported requested provider settings', () => {
    const shadowProduction = valid().replace('  production:\n    enabled: true', '  production:\n    enabled: true\n    strategy: native-preview');
    const issue = findIssue(loadCatalog([{ path: 'catalog/apps/unsupported.yaml', content: shadowProduction }]).issues, 'LP-CATALOG-UNSUPPORTED-SETTING');
    expect(issue.path).toBe('environments.production.strategy');
    expect(issue.line).toBe(at(shadowProduction, 'strategy: native-preview').line);
    const nativeStaging = valid().replace('  production:\n    enabled: true', '  staging:\n    enabled: true\n    strategy: shadow-project\n  production:\n    enabled: true');
    expect(codes(loadCatalog([{ path: 'catalog/apps/unsupported.yaml', content: nativeStaging }]).issues)).toContain('LP-CATALOG-UNSUPPORTED-SETTING');
  });

  it('blocks immutable ID changes and unprotected repository renames', () => {
    const renamedRepo = valid().replace('name: example/fixture', 'name: example/renamed');
    const unprotected = findIssue(loadCatalog([{ path: 'catalog/apps/rename.yaml', content: renamedRepo }], { previousRepositories: { 'fixture-app': { name: 'example/fixture' } } }).issues, 'LP-CATALOG-REPOSITORY-RENAME');
    expect(unprotected.path).toBe('repository.name');
    const protectedRename = loadCatalog([{ path: 'catalog/apps/rename.yaml', content: renamedRepo.replace('  deploymentRef: main', '  deploymentRef: main\n  expectedRepositoryId: 42') }], { previousRepositories: { 'fixture-app': { name: 'example/fixture', expectedRepositoryId: 42 } } });
    expect(protectedRename.issues).toEqual([]);
    const idChanged = findIssue(loadCatalog([{ path: 'catalog/apps/id.yaml', content: valid() }], { previousRepositories: { 'old-id': { name: 'example/fixture' } } }).issues, 'LP-CATALOG-ID-CHANGED');
    expect(idChanged.path).toBe('metadata.id');
    const teardown = loadCatalog([{ path: 'catalog/apps/id.yaml', content: valid() }], {
      previousLifecycle: { 'old-id': 'decommissioning' },
      previousRepositories: { 'old-id': { name: 'example/fixture' } },
    });
    expect(teardown.issues).toEqual([]);
  });

  it('rejects YAML aliases, merge keys, custom tags, multi-document files, and duplicate keys', () => {
    const alias = 'apiVersion: launchpad.dev/v1\nmetadata:\n  id: aliased-app\n  displayName: &name Aliased\n  owners: ["@platform"]\nrepository:\n  provider: github\n  name: example/aliased\n  productionBranch: main\n  deploymentRef: main\nvercel:\n  project: {name: aliased-app}\n  annotations: *name\n';
    const aliasIssue = findIssue(loadCatalog([{ path: 'catalog/apps/alias.yaml', content: alias }]).issues, 'LP-SCHEMA-ALIAS');
    expect(aliasIssue.path).toBe('$');
    expect(aliasIssue.line).toBe(at(alias, '*name').line);
    expect(aliasIssue.column).toBe(at(alias, '*name').column);

    const mergeKey = 'base: &base {owners: ["@platform"]}\napiVersion: launchpad.dev/v1\nmetadata:\n  id: merge-app\n  displayName: Merge\n  <<: *base\n';
    expect(codes(loadCatalog([{ path: 'catalog/apps/merge.yaml', content: mergeKey }]).issues)).toContain('LP-SCHEMA-ALIAS');

    const tagged = valid().replace('framework: nextjs', 'framework: !custom nextjs');
    const tagIssue = findIssue(loadCatalog([{ path: 'catalog/apps/tagged.yaml', content: tagged }]).issues, 'LP-SCHEMA-TAG');
    expect(tagIssue.path).toBe('$');

    const multiDocument = 'apiVersion: launchpad.dev/v1\n---\napiVersion: launchpad.dev/v1\n';
    const multiIssue = findIssue(loadCatalog([{ path: 'catalog/apps/multi.yaml', content: multiDocument }]).issues, 'LP-SCHEMA-YAML');
    expect(multiIssue.message).toContain('2 YAML documents');

    const duplicateKeys = valid().replace('  id: fixture-app', '  id: fixture-app\n  id: fixture-app-again');
    expect(codes(loadCatalog([{ path: 'catalog/apps/dupkeys.yaml', content: duplicateKeys }]).issues)).toContain('LP-SCHEMA-YAML');
  });

  it('reports YAML syntax errors with positions and rejects non-object roots', () => {
    const broken = 'metadata: id: x\n';
    const syntax = findIssue(loadCatalog([{ path: 'catalog/apps/broken.yaml', content: broken }]).issues, 'LP-SCHEMA-YAML');
    expect(syntax.line).toBe(1);
    expect(syntax.column).toBe(11);
    expect(codes(loadCatalog([{ path: 'catalog/apps/list.yaml', content: '- 1\n- 2\n' }]).issues)).toContain('LP-SCHEMA-ROOT');
  });

  it('rejects unsupported API versions and migrates legacy versions visibly', () => {
    const unsupported = valid().replace('apiVersion: launchpad.dev/v1', 'apiVersion: launchpad.dev/v99');
    const versionIssue = findIssue(loadCatalog([{ path: 'catalog/apps/version.yaml', content: unsupported }]).issues, 'LP-SCHEMA-VERSION');
    expect(versionIssue.path).toBe('apiVersion');
    expect(versionIssue.line).toBe(at(unsupported, 'launchpad.dev/v99').line);

    const legacy = `
apiVersion: launchpad.dev/v1alpha1
kind: Application
metadata:
  name: legacy-app
  owners: ["@platform"]
repository:
  provider: github
  name: example/legacy
  productionBranch: main
  deploymentRef: main
vercel:
  project:
    name: legacy-app
    installCommand: yarn install
    buildCommand: yarn build
lifecycle:
  status: active
`;
    const migrated = loadCatalog([{ path: 'catalog/apps/legacy.yaml', content: legacy }]);
    const migratedIssue = findIssue(migrated.issues, 'LP-CATALOG-MIGRATED');
    expect(migratedIssue.message).toContain('launchpad.dev/v1alpha1');
    expect(migratedIssue.message).toContain('not rewritten');
    expect(migrated.applications[0]?.metadata.id).toBe('legacy-app');
    expect('name' in (migrated.applications[0]?.metadata ?? {})).toBe(false);
    expect(migrated.applications[0]?.vercel.project.build.buildCommand).toBe('yarn build');
    expect(migrated.applications[0]?.vercel.project.build.installCommand).toBe('yarn install');
    expect(migrated.applications[0]?.lifecycle.state).toBe('active');
    expect(migrated.canonical).toContain('"id":"legacy-app"');
    expect(migrated.canonical).not.toContain('v1alpha1');

    const dispatch = migrateSchemaVersion({ apiVersion: 'launchpad.dev/v1alpha1', metadata: { name: 'x' } });
    expect(dispatch?.migratedFrom).toBe('launchpad.dev/v1alpha1');
    expect(dispatch?.value.apiVersion).toBe('launchpad.dev/v1');
    expect(migrateSchemaVersion({ apiVersion: 'launchpad.dev/v1' })).toBeNull();
  });

  it('normalizes defaults before semantics and never mutates input', () => {
    const minimal = `
apiVersion: launchpad.dev/v1
kind: Application
metadata:
  id: minimal-app
  owners: ["@platform"]
repository:
  provider: github
  name: example/minimal
  productionBranch: main
  deploymentRef: main
vercel:
  project:
    name: minimal-app
environments: {}
domains: []
secrets: []
dependencies: {}
policies: {}
lifecycle: {}
`;
    const result = loadCatalog([{ path: 'catalog/apps/minimal.yaml', content: minimal }]);
    expect(result.issues).toEqual([]);
    const application = result.applications[0];
    expect(application).toBeDefined();
    expect(application?.metadata.displayName).toBe('minimal-app');
    expect(application?.vercel.project.rootDirectory).toBe('.');
    expect(application?.lifecycle.deletionProtection).toBe(true);
    expect(application?.lifecycle.recoveryPolicy?.allowReactivateBeforeDeletionApproval).toBe(false);
    expect(application?.environments.preview?.strategy).toBe('native-preview');
    expect(application?.environments.production?.strategy).toBeUndefined();
    expect(application?.policies.drift.mode).toBe('open-pr');
    const again = loadCatalog([{ path: 'catalog/apps/minimal.yaml', content: minimal }]);
    expect(again.canonical).toBe(result.canonical);
    expect(again.applications).toEqual(result.applications);
  });

  it('produces identical canonical JSON for equivalent catalogs', async () => {
    const minimal = `
apiVersion: launchpad.dev/v1
kind: Application
metadata:
  id: minimal-app
  owners: ["@platform"]
repository:
  provider: github
  name: example/minimal
  productionBranch: main
  deploymentRef: main
vercel:
  project:
    name: minimal-app
environments: {}
domains: []
secrets: []
dependencies: {}
policies: {}
lifecycle: {}
`;
    const explicit = `
lifecycle:
  orphanPolicy: retain
  state: active
  deletionProtection: true
  decommission: {approvalToken: null, requestedAt: null, deleteAfter: null, preserveDeployments: true}
  recoveryPolicy: {allowReactivateBeforeDeletionApproval: false}
secrets: []
domains: []
policies:
  staging: {requiredForProduction: true}
  health: {requiredForPromotion: true}
  failures: {createIssueAfterFinalRetry: true, notifyOwners: true}
  drift: {mode: open-pr, checkIntervalMinutes: 30}
  preview: {requiredForMerge: true}
  destructiveChanges: {allowInNormalApply: false}
dependencies: {applications: [], external: []}
vercel:
  scope: {}
  project:
    settings: {}
    protection: {}
    regions: {functions: []}
    deployment: {autoAssignProductionDomains: false}
    git: {connected: true, productionBranch: main}
    build: {installCommand: null, buildCommand: null, outputDirectory: null, developmentCommand: null, ignoredBuildStep: null}
    nodeVersion: null
    rootDirectory: .
    framework: null
    name: minimal-app
repository:
  name: example/minimal
  productionBranch: main
  deploymentRef: main
  access: {requirePrivateAccessVerification: true, requireVercelGitAccess: true}
  provider: github
  onboarding: {managedWorkflow: false, workflowVersion: v1, openOnboardingPr: false}
environments:
  preview:
    health: {path: /api/health, method: GET, expectedStatus: [200], timeoutSeconds: 10, attempts: 10, intervalSeconds: 10}
    strategy: native-preview
    enabled: true
  production:
    health: {path: /api/health, method: GET, expectedStatus: [200], timeoutSeconds: 10, attempts: 10, intervalSeconds: 10}
    enabled: true
metadata:
  labels: {}
  annotations: {}
  owners: ["@platform"]
  id: minimal-app
  displayName: minimal-app
kind: Application
apiVersion: launchpad.dev/v1
`;
    const canonicalFromMinimal = loadCatalog([{ path: 'catalog/apps/minimal.yaml', content: minimal }]).canonical;
    const canonicalFromExplicit = loadCatalog([{ path: 'catalog/apps/explicit.yaml', content: explicit }]).canonical;
    expect(canonicalFromMinimal).toBe(canonicalFromExplicit);
    expect(await sha256Hex(canonicalFromMinimal)).toBe(await sha256Hex(canonicalFromExplicit));
    const canonicalApp = (JSON.parse(canonicalFromMinimal) as unknown[])[0] as Record<string, unknown>;
    const fromCanonical = loadCatalog([{ path: 'catalog/apps/fixpoint.yaml', content: JSON.stringify(canonicalApp) }]);
    expect(fromCanonical.issues).toEqual([]);
    expect(fromCanonical.canonical).toBe(canonicalFromMinimal);
  });

  it('loads files in lexical path order and is order-independent', () => {
    const first = valid().replace('fixture-app', 'first-app').replace('example/fixture', 'example/first').replace('fixture.example.com', 'first.example.com');
    const second = valid().replace('fixture-app', 'second-app').replace('example/fixture', 'example/second').replace('fixture.example.com', 'second.example.com');
    const forward = loadCatalog([
      { path: 'catalog/apps/a.yaml', content: first },
      { path: 'catalog/apps/b.yaml', content: second },
    ]);
    const reversed = loadCatalog([
      { path: 'catalog/apps/b.yaml', content: second },
      { path: 'catalog/apps/a.yaml', content: first },
    ]);
    expect(forward.applications.map((app) => app.metadata.id)).toEqual(['first-app', 'second-app']);
    expect(reversed.applications.map((app) => app.metadata.id)).toEqual(['first-app', 'second-app']);
    expect(reversed.canonical).toBe(forward.canonical);
    expect(reversed.issues).toEqual(forward.issues);
  });

  it('reports an empty catalog', () => {
    const result = loadCatalog([]);
    expect(codes(result.issues)).toEqual(['LP-CATALOG-EMPTY']);
    expect(result.canonical).toBe('[]');
  });
});

describe('zone registry parser', () => {
  const registry = (zones: string): string => `apiVersion: launchpad.dev/v1\nzones:\n${zones}`;

  it('parses a valid registry deterministically and rejects duplicate zones with file context', () => {
    const sorted = parseZoneRegistry(registry('  - b.example.com\n  - a.example.com\n'), 'catalog/zones.yaml');
    expect(sorted.issues).toEqual([]);
    expect(sorted.zones).toEqual(['a.example.com', 'b.example.com']);
    const content = registry('  - example.com\n  - example.com\n');
    const duplicate = parseZoneRegistry(content, 'catalog/zones.yaml');
    const issue = findIssue(duplicate.issues, 'LP-ZONE-REGISTRY-DUPLICATE');
    expect(issue.file).toBe('catalog/zones.yaml');
    expect(issue.path).toBe('zones.1');
    expect(issue.line).toBe(4);
    expect(duplicate.zones).toEqual([]);
  });

  it('fails closed on malformed YAML with the error position as file context', () => {
    const malformed = parseZoneRegistry('zones: [example.com\n', 'catalog/zones.yaml');
    const issue = findIssue(malformed.issues, 'LP-ZONE-REGISTRY-YAML');
    expect(issue.file).toBe('catalog/zones.yaml');
    expect(issue.line).toBeGreaterThan(0);
    expect(malformed.zones).toEqual([]);
  });

  it('fails closed when the registry shape is not an object with a zones list', () => {
    const missing = parseZoneRegistry('apiVersion: launchpad.dev/v1\n', 'catalog/zones.yaml');
    const missingIssue = findIssue(missing.issues, 'LP-ZONE-REGISTRY-SHAPE');
    expect(missingIssue.path).toBe('zones');
    const notList = parseZoneRegistry('apiVersion: launchpad.dev/v1\nzones: example.com\n', 'catalog/zones.yaml');
    expect(findIssue(notList.issues, 'LP-ZONE-REGISTRY-SHAPE').path).toBe('zones');
    const notString = parseZoneRegistry(registry('  - 123\n'), 'catalog/zones.yaml');
    const entryIssue = findIssue(notString.issues, 'LP-ZONE-REGISTRY-SHAPE');
    expect(entryIssue.path).toBe('zones.0');
    const empty = parseZoneRegistry('', 'catalog/zones.yaml');
    expect(findIssue(empty.issues, 'LP-ZONE-REGISTRY-SHAPE').path).toBe('$');
  });

  it('rejects an unsupported apiVersion', () => {
    const result = parseZoneRegistry(registry('  - example.com\n').replace('launchpad.dev/v1', 'launchpad.dev/v2'), 'catalog/zones.yaml');
    const issue = findIssue(result.issues, 'LP-ZONE-REGISTRY-VERSION');
    expect(issue.path).toBe('apiVersion');
    expect(result.zones).toEqual([]);
  });

  it('rejects YAML aliases and tags in the registry', () => {
    const alias = parseZoneRegistry('apiVersion: launchpad.dev/v1\nzones: &all\n  - example.com\nother: *all\n', 'catalog/zones.yaml');
    expect(codes(alias.issues)).toContain('LP-ZONE-REGISTRY-SHAPE');
    const tagged = parseZoneRegistry('apiVersion: launchpad.dev/v1\nzones: !tag [example.com]\n', 'catalog/zones.yaml');
    expect(codes(tagged.issues)).toContain('LP-ZONE-REGISTRY-SHAPE');
  });

  it('loads a catalog against a parsed registry: known zones pass, unknown zones block', () => {
    const parsed = parseZoneRegistry(registry('  - example.com\n'), 'catalog/zones.yaml');
    expect(loadCatalog([{ path: 'catalog/apps/domains.yaml', content: valid() }], { zones: parsed.zones }).issues).toEqual([]);
    const unknownZone = valid().replace('config://cloudflare/example.com', 'config://cloudflare/other.com');
    const result = loadCatalog([{ path: 'catalog/apps/domains.yaml', content: unknownZone }], { zones: parsed.zones });
    const issue = findIssue(result.issues, 'LP-DOMAIN-ZONE-UNKNOWN');
    expect(issue.file).toBe('catalog/apps/domains.yaml');
    expect(issue.path).toBe('domains.0.cloudflare.zoneRef');
    expect(result.applications).toHaveLength(1);
  });
});
