import { expect, it } from 'vitest';
import { artifactFiles, renderDotGraph, renderFailureStickyComment, renderStickyComment } from './index.js';
import type { PlatformPlan, PlannedOperation, ResourceGraph } from '@launchpad/core';

const plan: PlatformPlan = { schemaVersion: 'launchpad.plan/v1', applicationId: 'app', desiredGeneration: 2, sourceCommit: 'a'.repeat(40), createdAt: '2026-08-04T00:00:00.000Z', capabilitySnapshotHash: 'capabilities', observedStateHash: 'observed', operations: [{ id: '1', resourceKey: 'vercel.project', provider: 'vercel', resourceType: 'project', action: 'UPDATE_IN_PLACE', before: { rootDirectory: '.' }, after: { rootDirectory: 'apps/web' }, prerequisites: [], invalidates: [], idempotencyKey: 'key', destructive: false, retryClass: 'NONE' }], downstreamEffects: [{ resourceKey: 'production.candidate', action: 'REDEPLOY_REQUIRED', reason: 'root directory changed', severity: 'INFO' }], policyResults: [{ rule: 'policy', result: 'PASS', message: 'ok', remediation: null }], fingerprint: 'f'.repeat(64), result: 'READY' };

const graph: ResourceGraph = { nodes: [{ key: 'application.manifest', provider: 'platform', resourceType: 'manifest', dependencies: [], desired: { id: 'app' }, observed: null }, { key: 'github.repository', provider: 'github', resourceType: 'repository', dependencies: ['application.manifest'], desired: { name: 'example/app' }, observed: null }] };

/** Sound narrowing for noUncheckedIndexedAccess: the calling test asserts these artifacts exist, so absence is a test bug, not a runtime condition. */
function requireArtifact(files: Record<string, string>, name: string): string {
  const content = files[name];
  if (content === undefined) throw new Error(`Missing artifact '${name}'.`);
  return content;
}

it('renders one stable sticky comment with escaped provider text', () => {
  const body = renderStickyComment({ plans: [plan], previews: [{ state: 'ERROR', url: 'https://preview.example', message: '<script>alert(1)</script>' }], healths: [{ state: 'FAILED', message: 'body mismatch' }] });
  expect(body).toContain('<!-- launchpad:plan -->');
  expect(body).toContain('sha256:');
  expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(body).not.toContain('<script>');
});

it('never fabricates READY/PASSED preview or health evidence (false-green regression)', () => {
  const body = renderStickyComment({ plans: [plan] });
  expect(body).toContain('### Preview deployment');
  expect(body).toContain('- State: not available');
  expect(body).toContain('has not produced a result');
  expect(body).not.toContain('State: ✅');
  expect(body).not.toContain('State: \`READY\`');
  expect(body).not.toContain('[open preview]');
  const artifacts = artifactFiles({ plans: [plan] });
  expect(artifacts['preview-summary.json']).toBeUndefined();
  expect(artifacts['health-results.json']).toBeUndefined();
  expect(artifacts['provider-error-redacted.json']).toBeUndefined();
  const failed = renderStickyComment({ plans: [{ ...plan, result: 'BLOCKED', blockedReason: 'LP-POLICY-BLOCK' }] });
  expect(failed).toContain('❌ BLOCKED');
  expect(failed).toContain('LP-POLICY-BLOCK');
});

it('renders real dot graph nodes and edges', () => {
  const dot = renderDotGraph([graph]);
  expect(dot).toContain('digraph launchpad');
  expect(dot).toContain('"application.manifest"');
  expect(dot).toContain('"github.repository" -> "application.manifest"');
});

it('creates redacted machine-readable artifacts with bounded size', () => {
  const huge = `x`.repeat(100_000);
  const artifacts = artifactFiles({ plans: [plan], previews: [{ state: 'READY', url: 'https://preview.example', message: 'ok' }], healths: [{ state: 'PASSED', message: 'ok' }], providerState: { secret: 'api_key=super-secret-value' }, providerError: { code: 'LP-VERCEL-BUILD-FAILED', message: 'token=abc123 failed', operationId: 'op-1', retryable: false }, logs: ['ok'], resourceGraphs: [graph] });
  expect(Object.keys(artifacts)).toEqual(expect.arrayContaining(['plans.json', 'plan.md', 'resource-graph.json', 'resource-graph.dot', 'provider-state-redacted.json', 'preview-summary.json', 'health-results.json', 'provider-error-redacted.json', 'build-log-tail.txt']));
  expect(artifacts['plans.json']).toContain('"fingerprint"');
  expect(artifacts['provider-state-redacted.json']).not.toContain('super-secret-value');
  expect(artifacts['provider-error-redacted.json']).not.toContain('abc123');
  expect(artifacts['build-log-tail.txt']).toBe('ok');
  for (const [name, content] of Object.entries(artifacts)) {
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(262_144);
    expect(name.length).toBeGreaterThan(0);
  }
  const bounded = requireArtifact(artifactFiles({ plans: [plan], logs: [huge, 'ok'] }), 'build-log-tail.txt');
  expect(Buffer.byteLength(bounded, 'utf8')).toBeLessThanOrEqual(16_384);
  expect(bounded).toContain('…[truncated]');
  expect(bounded.endsWith('ok')).toBe(true);
});

it('preserves shared references in plan artifacts (plan-review attestation parity)', () => {
  // The same health spec object is referenced by the candidate, health, and
  // post-health operations. A global dedupe pass would corrupt these shared
  // payloads with literal "[Circular]" strings; the artifact must stay
  // faithful so the plan-review attestation binds exactly what a fresh plan
  // computes.
  const health = { path: '/', method: 'GET', expectedStatus: [200] };
  const sharedPlan: PlatformPlan = {
    ...plan,
    operations: [
      { ...plan.operations[0]!, resourceKey: 'production.candidate', after: { enabled: true, health, release: { strategy: 'staged-production' }, rollback: { enabled: true } } },
      { ...plan.operations[0]!, resourceKey: 'production.health', after: { path: '/', method: 'GET', expectedStatus: [200] } },
      { ...plan.operations[0]!, resourceKey: 'production.post-health', after: health },
    ],
  };
  const content = requireArtifact(artifactFiles({ plans: [sharedPlan] }), 'plans.json');
  expect(content).not.toContain('[Circular]');
  const decoded = JSON.parse(content) as PlatformPlan[];
  expect(decoded[0]?.operations[0]?.after).toMatchObject({ enabled: true, health: { path: '/', method: 'GET', expectedStatus: [200] }, release: { strategy: 'staged-production' } });
  expect(decoded[0]?.operations[2]?.after).toEqual({ path: '/', method: 'GET', expectedStatus: [200] });
});

it('degrades oversized plans to a bounded minimal projection instead of failing', () => {
  const bloated = Array.from({ length: 400 }, (_, index): PlannedOperation => ({ id: `op-${index}`, resourceKey: `resource.${index}`, provider: 'vercel', resourceType: 'project', action: 'UPDATE_IN_PLACE', before: { payload: 'b'.repeat(2000) }, after: { payload: 'c'.repeat(2000) }, prerequisites: [], invalidates: [], idempotencyKey: `key-${index}`, destructive: false, retryClass: 'NONE' }));
  const oversized: PlatformPlan = { ...plan, operations: bloated, downstreamEffects: [], policyResults: [] };
  const content = requireArtifact(artifactFiles({ plans: [oversized] }), 'plans.json');
  expect(content).toContain('"truncated": true');
  expect(content).toContain('"operationCount": 400');
  expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(262_144);
});

it('escapes repository and provider text in the sticky comment', () => {
  const body = renderStickyComment({ plans: [{ ...plan, applicationId: 'app|<script>', operations: [{ ...plan.operations[0]!, resourceKey: 'vercel.project|"injected"' }] }], previews: [{ state: 'ERROR', url: 'https://example.test', message: 'provider token=abc123' }] });
  expect(body).not.toContain('<script>');
  expect(body).toContain('&lt;script&gt;');
  expect(body).not.toContain('token=abc123');
  expect(body).toContain('token=[REDACTED]');
});

it('renders a failure-only sticky comment from explicit job results with escaped and redacted text', () => {
  const body = renderFailureStickyComment({
    jobs: [{ name: 'schema', result: 'failure' }, { name: 'catalog', result: 'failure' }, { name: 'plan', result: 'skipped' }],
    providerError: { code: 'LP-SCHEMA-INVALID', message: '<script>token=secret-value</script>', operationId: 'op-1', retryable: false },
  });
  expect(body).toContain('<!-- launchpad:plan -->');
  expect(body).toContain('### Launchpad validation failed');
  expect(body).toContain('`schema` — failure');
  expect(body).toContain('`plan` — skipped');
  expect(body).toContain('&lt;script&gt;');
  expect(body).not.toContain('<script>');
  expect(body).not.toContain('token=secret-value');
  expect(body).toContain('token=[REDACTED]');
  expect(body).not.toContain('READY');
  expect(body).not.toContain('PASSED');
});

it('emits only failing preview/health evidence in the failure comment, never green states', () => {
  const body = renderFailureStickyComment({
    jobs: [{ name: 'preview', result: 'failure' }],
    previews: [{ state: 'ERROR', url: 'https://preview.example', message: 'build failed' }, { state: 'READY', url: 'https://preview.example', message: 'ready' }],
    healths: [{ state: 'FAILED', message: 'degraded' }, { state: 'PASSED', message: 'healthy' }],
  });
  expect(body).toContain('### Preview failures');
  expect(body).toContain('### Health failures');
  expect(body).toContain('build failed');
  expect(body).toContain('degraded');
  expect(body).not.toContain('State: ✅');
  expect(body).not.toContain('ready');
  expect(body).not.toContain('healthy');
});
