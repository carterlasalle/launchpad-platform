/**
 * Deterministic offline acceptance suite (tests/end-to-end).
 *
 * Proves the full master-plan acceptance matrix (sections 11, 33, 47, and
 * the release checklist) through real production boundaries:
 *
 *  - real adapters (GitHubAdapter / VercelAdapter / CloudflareAdapter) over a
 *    recorded sandbox transport (never FakeProvider);
 *  - real D1 migrations through the node:sqlite shim (never an in-memory
 *    store);
 *  - the durable workflow machines (preview, apply, reconcile, decommission,
 *    app-preview gate) and controller observability boundaries (DLQ,
 *    provider-error/incident recording, metric snapshots);
 *  - the real catalog loader/semantic validation and health checker.
 *
 * Every scenario records an entry in the runtime acceptance report
 * (artifacts/acceptance-report.json, written in `afterAll`). The report
 * gate fails when any required scenario is missing, failed, or skipped.
 *
 * Run: yarn acceptance:offline  (see scripts/acceptance-offline.mjs)
 */

import { afterAll, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stringify } from 'yaml';
import { loadCatalog } from '@launchpad/catalog';
import { buildPlan, desiredStateHash, planReviewFingerprint, type DesiredApplication, type ObservedApplication } from '@launchpad/core';
import { checkHealth } from '@launchpad/health';
import { idempotencyKey, MetricsRegistry, SensitiveValue, scanCanary, redactValue, LaunchpadLogger } from '@launchpad/shared';
import { GitHubAdapter } from '@launchpad/provider-github';
import { VercelAdapter } from '@launchpad/provider-vercel';
import { CloudflareAdapter } from '@launchpad/provider-cloudflare';
import { artifactFiles, renderStickyComment } from '@launchpad/github-reporting';
import {
  applyLoadDesired, applyNoDestroyGate, applyObserveLiveState, assertTombstoneReuseAllowed, consumeDeletionApproval, issueDeletionApproval,
  makeApplyBase, promoteProduction, redactBuildLog, runAppPreviewStatusWorkflow, runApplyWorkflow,
  runDecommissionWorkflow, runPreviewWorkflow, runReconcileWorkflow, shadowProjectName,
} from '@launchpad/workflows';
import { DEAD_LETTER_QUEUE, createQueueEnvelope, handleQueue, type QueuePersistence } from '../../apps/controller/src/queues.js';
import { recordPermanentFailure, snapshotMetricsToStore } from '../../apps/controller/src/observability.js';
import {
  ACCEPTANCE_APP_ID, ACCEPTANCE_CONTROL_REPOSITORY, ACCEPTANCE_DOMAIN, ACCEPTANCE_MANIFEST_PATH, ACCEPTANCE_PROJECT_ID,
  ACCEPTANCE_REPOSITORY, ACCEPTANCE_REPOSITORY_ID, ACCEPTANCE_ZONE_ID, ACCEPTANCE_ZONE_REF,
  CompositeProvider, NOOP_SLEEP, RecordedSandboxTransport, acceptanceContext, acceptanceManifest,
  cfEnvelope, commitSha, createD1Store, githubFileContent, healthServer, NEVER_RESOLVER,
  recordedDnsRecord, recordedProject, recordedZone, redactResourceIds,
} from './acceptance-harness.js';
import { REQUIRED_SCENARIO_IDS, REQUIRED_SCENARIOS, writeAcceptanceReport, writeEvidence, resolveSourceCommit, runningToolchain, type ScenarioReportEntry } from './acceptance-matrix.js';

// ---------------------------------------------------------------------------
// Fixed clock and identifiers
// ---------------------------------------------------------------------------

const NOW = '2026-08-04T00:00:00.000Z';
const COMMIT_A = commitSha('a');
const COMMIT_B = commitSha('b');
// `commitSha` seeds must stay hex; the reconcile payload gate rejects
// non-hex sourceCommits (LP-RECONCILE-PAYLOAD-INVALID).
const MAIN_SHA = commitSha('d');
const DNS_TARGET = 'acceptance-app.vercel-dns.sandbox.test';
const DNS_OWNERSHIP = idempotencyKey('ownership', ACCEPTANCE_APP_ID, ACCEPTANCE_DOMAIN);

function fixedNow(): Date {
  return new Date(NOW);
}

// ---------------------------------------------------------------------------
// Report collection
// ---------------------------------------------------------------------------

const results = new Map<string, ScenarioReportEntry>();
const canaries: string[] = [];
const suiteStartedAt = performance.now();

interface ScenarioOutcome {
  observed: string;
  resourceIds?: Record<string, string>;
  evidence?: unknown;
}

async function scenario(id: string, run: () => Promise<ScenarioOutcome>): Promise<void> {
  const required = REQUIRED_SCENARIOS.find((entry) => entry.id === id);
  if (!required) throw new Error(`Unknown scenario id '${id}'`);
  const started = performance.now();
  try {
    const outcome = await run();
    const evidencePath = writeEvidence(id, outcome.evidence ?? null);
    results.set(id, {
      id,
      sections: required.sections,
      checklist: required.checklist,
      description: required.description,
      status: 'passed',
      durationMs: Math.round(performance.now() - started),
      observed: outcome.observed,
      resourceIds: outcome.resourceIds ?? {},
      evidence: [evidencePath],
    });
  } catch (error) {
    results.set(id, {
      id,
      sections: required.sections,
      checklist: required.checklist,
      description: required.description,
      status: 'failed',
      durationMs: Math.round(performance.now() - started),
      observed: 'failed',
      resourceIds: {},
      evidence: [],
      failure: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/** Transport log evidence, redacted of resource ids and any token values. */
function logEvidence(transport: RecordedSandboxTransport, extra?: unknown): unknown {
  return {
    transportLog: transport.calls().map((entry) => ({
      exchangeId: entry.exchangeId,
      method: entry.method,
      url: redactResourceIds(entry.url),
      status: entry.status,
      attempt: entry.attempt,
      correlationId: entry.correlationId,
      idempotencyKey: entry.idempotencyKey,
      hasAuthorization: entry.hasAuthorization,
    })),
    ...(extra !== undefined ? { ...(extra as Record<string, unknown>) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Scenario building blocks
// ---------------------------------------------------------------------------

const VERIFIED_RESOLVER = async (): Promise<string[]> => [DNS_TARGET];

interface ApplyTransportOptions {
  project?: Record<string, unknown>;
  project404Times?: number;
  dnsAbsentTimes?: number;
  dnsPresentTimes?: number;
  dnsRecord?: Record<string, unknown>;
  deploymentId?: string;
  deploymentState?: string;
  promoteDeploymentId?: string;
  includeRollback?: boolean;
  rollbackToDeploymentId?: string;
  commit?: string;
  generation?: number;
  /** When set, records origin/public proxy-compatibility probe exchanges for the proxied apply flow. */
  proxyProbe?: 'compatible' | 'incompatible';
}

/**
 * Recorded sandbox transport for one full apply run (plan + machine).
 * Call order for a fresh apply: pre-plan observe, machine observe, ensure
 * project (404 twice more + POST + readbacks), git, settings, environments,
 * domains (attach + unverified readback, DNS), authoritative verification,
 * Vercel domain verification (unverified readback x2 → verify POST →
 * verified readback), TLS readiness (certs), candidate create/wait, promote.
 *
 * The Vercel domain/cert exchanges are recorded BEFORE the project routes:
 * the recorded transport matches by URL prefix, so the broad project get
 * (`/v9/projects/acceptance-app`) would otherwise swallow the domain gets
 * (`/v9/projects/acceptance-app/domains/...`) and the real gate calls would
 * fail closed on the project-shaped response instead of being exercised.
 */
function applyTransport(options: ApplyTransportOptions = {}): RecordedSandboxTransport {
  const project = options.project ?? recordedProject();
  const deploymentId = options.deploymentId ?? 'dpl_candidate_1';
  const commit = options.commit ?? COMMIT_A;
  const generation = options.generation ?? 1;
  const record = options.dnsRecord ?? recordedDnsRecord({ comment: `launchpad:${DNS_OWNERSHIP}` });
  const entries = [
    // Domain verification gate (applyVerifyVercelDomain): the ensure-domains
    // readback and the pre-verify read serve the unverified domain; the
    // verify POST then flips it to verified and the post-verify read serves
    // the verified observation (LP-VERCEL-DOMAIN-VERIFICATION-PENDING would
    // fire without the real verify round-trip).
    { id: 'vercel.domain.get.unverified', method: 'GET', url: `https://vercel.sandbox.test/v9/projects/${ACCEPTANCE_APP_ID}/domains/${ACCEPTANCE_DOMAIN}`, json: { name: ACCEPTANCE_DOMAIN, projectId: ACCEPTANCE_APP_ID, verified: false, verification: [{ type: 'cname', domain: `_vercel.${ACCEPTANCE_DOMAIN}`, value: DNS_TARGET }] }, times: 2 },
    { id: 'vercel.domain.verify', method: 'POST', url: `https://vercel.sandbox.test/v9/projects/${ACCEPTANCE_APP_ID}/domains/${ACCEPTANCE_DOMAIN}/verify`, json: { name: ACCEPTANCE_DOMAIN, projectId: ACCEPTANCE_APP_ID, verified: true, verification: [] } },
    { id: 'vercel.domain.get.verified', method: 'GET', url: `https://vercel.sandbox.test/v9/projects/${ACCEPTANCE_APP_ID}/domains/${ACCEPTANCE_DOMAIN}`, json: { name: ACCEPTANCE_DOMAIN, projectId: ACCEPTANCE_APP_ID, verified: true, verification: [] }, times: 1 },
    // TLS readiness gate (applyVerifyTls): an issued certificate covering the
    // domain with a far-future expiry yields READY; without this exchange the
    // gate would fail with LP-TLS-READINESS-PENDING.
    { id: 'vercel.certs.get', method: 'GET', url: 'https://vercel.sandbox.test/v8/certs', json: { certs: [{ id: 'cert_acceptance_1', createdAt: 1754265600000, expiresAt: 1798761600000, autoRenew: true, cns: [ACCEPTANCE_DOMAIN] }] } },
    { id: 'vercel.project.get.404', method: 'GET', url: `https://vercel.sandbox.test/v9/projects/${ACCEPTANCE_APP_ID}`, status: 404, json: { error: { code: 'not_found' } }, times: options.project404Times ?? 3 },
    { id: 'vercel.project.get', method: 'GET', url: `https://vercel.sandbox.test/v9/projects/${ACCEPTANCE_APP_ID}`, json: project },
    { id: 'vercel.project.patch', method: 'PATCH', url: `https://vercel.sandbox.test/v9/projects/${ACCEPTANCE_PROJECT_ID}`, json: project },
    { id: 'vercel.project.git.patch', method: 'PATCH', url: `https://vercel.sandbox.test/v9/projects/${ACCEPTANCE_APP_ID}`, json: project },
    // Prefix matching: the bare project-create route below would shadow every
    // project-scoped POST (env/domains/promote), so the more specific routes
    // are recorded first.
    { id: 'vercel.env.create', method: 'POST', url: `https://vercel.sandbox.test/v10/projects/${ACCEPTANCE_APP_ID}/env`, json: { key: 'LAUNCHPAD_ENV', id: 'env_acceptance_1' } },
    { id: 'vercel.domain.attach', method: 'POST', url: `https://vercel.sandbox.test/v10/projects/${ACCEPTANCE_APP_ID}/domains`, json: { id: 'dom_acceptance_1', name: ACCEPTANCE_DOMAIN } },
    {
      id: 'vercel.promote', method: 'POST', url: `https://vercel.sandbox.test/v10/projects/${ACCEPTANCE_APP_ID}/promote`,
      json: {
        desiredGeneration: generation,
        deployment: { id: options.promoteDeploymentId ?? deploymentId, state: 'CURRENT', url: 'acceptance-app.vercel.sandbox.test' },
        previousDeploymentId: null,
      },
    },
    { id: 'vercel.project.create', method: 'POST', url: 'https://vercel.sandbox.test/v10/projects', json: { ...project, id: ACCEPTANCE_PROJECT_ID } },
    { id: 'vercel.domain.config', method: 'GET', url: 'https://vercel.sandbox.test/v6/domains/acceptance.example.com/config', json: { recommendedCNAME: [{ rank: 1, value: [DNS_TARGET] }] } },
    { id: 'cf.zone.get', method: 'GET', url: 'https://cloudflare.sandbox.test/zones?name=acceptance.test', json: cfEnvelope([recordedZone()]) },
    {
      id: 'cf.record.list.absent', method: 'GET',
      url: /\/zones\/zone_acceptance_1\/dns_records\?name=acceptance\.example\.com(?:&type=CNAME)?$/,
      json: cfEnvelope([]), times: options.dnsAbsentTimes ?? 4,
    },
    {
      id: 'cf.record.list.present', method: 'GET',
      url: /\/zones\/zone_acceptance_1\/dns_records\?name=acceptance\.example\.com(?:&type=CNAME)?$/,
      json: cfEnvelope([record]), times: options.dnsPresentTimes ?? 2,
    },
    { id: 'cf.record.create', method: 'POST', url: 'https://cloudflare.sandbox.test/zones/zone_acceptance_1/dns_records', json: cfEnvelope(record) },
    { id: 'vercel.deployment.create', method: 'POST', url: 'https://vercel.sandbox.test/v13/deployments', json: { id: deploymentId, name: ACCEPTANCE_APP_ID, url: 'acceptance-app.vercel.sandbox.test', state: 'QUEUED' } },
    {
      id: 'vercel.deployment.wait', method: 'GET', url: `https://vercel.sandbox.test/v13/deployments/${deploymentId}`,
      json: {
        id: deploymentId, projectId: ACCEPTANCE_APP_ID, url: 'acceptance-app.vercel.sandbox.test',
        state: options.deploymentState ?? 'STAGED', target: 'production',
        meta: { gitCommitSha: commit, desiredGeneration: generation, repo: ACCEPTANCE_REPOSITORY },
      },
    },
    ...(options.includeRollback === true
      ? [{ id: 'vercel.rollback', method: 'POST', url: `https://vercel.sandbox.test/v1/projects/${ACCEPTANCE_APP_ID}/rollback/${options.rollbackToDeploymentId ?? 'dpl_candidate_1'}`, json: {} }]
      : []),
    // Proxy compatibility probes (apply/proxy-compatibility): the origin probe
    // hits the candidate URL directly, the public probe hits the proxied
    // hostname. Compatible = origin echoes cf-connecting-ip; incompatible =
    // origin serves 200 without the passthrough header.
    ...(options.proxyProbe !== undefined
      ? [
        { id: 'cf.probe.origin', method: 'GET', url: 'https://acceptance-app.vercel.sandbox.test/api/health', json: { status: 'ok' }, ...(options.proxyProbe === 'compatible' ? { headers: { 'cf-connecting-ip': '203.0.113.10' } } : {}) },
        { id: 'cf.probe.public', method: 'GET', url: `https://${ACCEPTANCE_DOMAIN}/api/health`, json: { status: 'ok' } },
      ]
      : []),
  ];
  return new RecordedSandboxTransport(entries);
}

function compositeFor(transport: RecordedSandboxTransport, resolver: (hostname: string, type: string, nameservers: string[]) => Promise<string[]> = VERIFIED_RESOLVER): CompositeProvider {
  const vercel = new VercelAdapter({ token: 'lp-sandbox-token', teamId: 'team_acceptance', baseUrl: 'https://vercel.sandbox.test', fetchImpl: transport.fetchImpl });
  const cloudflare = new CloudflareAdapter({
    token: 'lp-sandbox-token',
    baseUrl: 'https://cloudflare.sandbox.test',
    fetchImpl: transport.fetchImpl,
    resolveDns: resolver,
    verification: { maxAttempts: 3, baseDelayMs: 1, timeoutMs: 1_000, sleep: NOOP_SLEEP, jitter: () => 0 },
  });
  return new CompositeProvider(vercel, cloudflare);
}

async function seedApplication(store: Awaited<ReturnType<typeof createD1Store>>['store'], applicationId = ACCEPTANCE_APP_ID, desiredGeneration = 1): Promise<void> {
  await store.upsertApplication({
    id: applicationId,
    displayName: 'Acceptance App',
    sourcePath: `catalog/apps/${applicationId}.yaml`,
    desiredGeneration,
    desiredHash: 'pending',
    syncStatus: 'UNKNOWN',
    healthStatus: 'UNKNOWN',
    lifecycleState: 'active',
    owners: ['@platform'],
  });
}

async function ownershipFromStore(store: Awaited<ReturnType<typeof createD1Store>>['store'], applicationId = ACCEPTANCE_APP_ID): Promise<Record<string, string>> {
  const ownership: Record<string, string> = {};
  for (const resource of await store.listResources(applicationId)) {
    ownership[resource.resourceKey] = resource.ownershipFingerprint ?? '';
  }
  return ownership;
}

async function planFor(
  store: Awaited<ReturnType<typeof createD1Store>>['store'],
  provider: CompositeProvider,
  desired: DesiredApplication,
  sourceCommit: string,
  generation: number,
  now: string,
  options: { attest?: boolean } = {},
): Promise<{ plan: Awaited<ReturnType<typeof buildPlan>>; observed: ObservedApplication }> {
  const base = await makeApplyBase({
    applicationId: desired.metadata.id,
    sourceCommit,
    planFingerprint: 'pending',
    desiredGeneration: generation,
    idempotencyKey: idempotencyKey('apply', desired.metadata.id, sourceCommit, String(generation)),
    workflowId: 'acceptance-plan',
  });
  const live = await applyObserveLiveState({ base, store, provider, desired, context: acceptanceContext('acceptance-plan', desired.metadata.id) });
  const plan = await buildPlan({
    desired,
    observed: live.observed,
    capabilities: live.capabilities,
    sourceCommit,
    desiredGeneration: generation,
    ownership: await ownershipFromStore(store, desired.metadata.id),
    mode: 'apply',
    now,
  });
  if (options.attest !== false) {
    // Record the reviewed-plan attestation exactly as the PR-head plan
    // workflow would (the apply approval gate requires it).
    const [reviewFingerprint, desiredHash] = await Promise.all([planReviewFingerprint(plan), desiredStateHash(desired)]);
    await store.savePlanReviewAttestation({
      applicationId: desired.metadata.id,
      prHeadSourceCommit: sourceCommit,
      desiredHash,
      generation: plan.desiredGeneration,
      planFingerprint: plan.fingerprint,
      reviewFingerprint,
      repository: ACCEPTANCE_REPOSITORY,
      actor: 'acceptance-workflow',
      workflowRef: `${ACCEPTANCE_CONTROL_REPOSITORY}/.github/workflows/validate-plan.yml@refs/heads/main`,
    });
  }
  return { plan, observed: live.observed };
}

function runApply(
  store: Awaited<ReturnType<typeof createD1Store>>['store'],
  provider: CompositeProvider,
  desired: DesiredApplication,
  plan: Awaited<ReturnType<typeof buildPlan>>,
  observed: ObservedApplication,
  options: { sourceCommit?: string; fetchImpl?: typeof fetch; workflowId?: string } = {},
): ReturnType<typeof runApplyWorkflow> {
  return runApplyWorkflow({
    store,
    provider,
    desired,
    observed,
    plan,
    sourceCommit: options.sourceCommit ?? plan.sourceCommit,
    context: acceptanceContext(options.workflowId ?? 'apply-wf', desired.metadata.id),
    fetchImpl: options.fetchImpl ?? healthServer([{ status: 200, body: '{"status":"ok"}' }]),
    sleep: NOOP_SLEEP,
  });
}

/**
 * Records the ownership ledger rows the apply machine's controller ingress
 * persists after a successful apply (the machine itself does not write
 * ownership rows; the established pattern in tests/end-to-end/lifecycle.test.ts
 * and workflows decommission tests records them explicitly).
 */
async function recordOwnership(store: Awaited<ReturnType<typeof createD1Store>>['store']): Promise<void> {
  await store.upsertResource({
    applicationId: ACCEPTANCE_APP_ID,
    provider: 'vercel',
    resourceType: 'vercel.project',
    resourceKey: 'vercel.project',
    providerResourceId: ACCEPTANCE_PROJECT_ID,
    desiredGeneration: 1,
    observedHash: 'h',
    ownershipFingerprint: ACCEPTANCE_PROJECT_ID,
  });
  await store.upsertResource({
    applicationId: ACCEPTANCE_APP_ID,
    provider: 'cloudflare',
    resourceType: 'dns-record',
    resourceKey: `cloudflare.dns.${ACCEPTANCE_DOMAIN}`,
    providerResourceId: 'dns_acceptance_1',
    desiredGeneration: 1,
    observedHash: 'h',
    ownershipFingerprint: DNS_OWNERSHIP,
  });
}

/** Applies the acceptance manifest once and returns the artifacts the later scenarios consume. */
async function appliedState(overrides: { domainMode?: 'dns-only' | 'proxied' } = {}): Promise<{
  store: Awaited<ReturnType<typeof createD1Store>>['store'];
  close: () => void;
  transport: RecordedSandboxTransport;
  provider: CompositeProvider;
  desired: DesiredApplication;
}> {
  const harness = createD1Store(fixedNow);
  await seedApplication(harness.store);
  const desired = acceptanceManifest({ domainMode: overrides.domainMode ?? 'dns-only' });
  const transport = applyTransport();
  const provider = compositeFor(transport);
  const { plan, observed } = await planFor(harness.store, provider, desired, COMMIT_A, 1, NOW);
  const result = await runApply(harness.store, provider, desired, plan, observed, { sourceCommit: COMMIT_A, workflowId: 'apply-base' });
  expect(result.status, `base apply failed: ${result.errorCode ?? 'unknown'}`).toBe('SUCCEEDED');
  await harness.store.advanceDesiredGeneration({ applicationId: ACCEPTANCE_APP_ID, generation: 1, desiredHash: plan.fingerprint });
  await recordOwnership(harness.store);
  return { store: harness.store, close: harness.close, transport, provider, desired };
}

function manifestYaml(manifest: DesiredApplication): string {
  const { sourcePath: _sourcePath, ...body } = manifest;
  return stringify(body as unknown as Record<string, unknown>, { aliasDuplicateObjects: false, lineWidth: 0 });
}

// ---------------------------------------------------------------------------
// Catalog and schema scenarios (plan sections 32/33/47)
// ---------------------------------------------------------------------------

it('CAT-VALID: a valid manifest loads cleanly with a deterministic canonical document', async () => {
  await scenario('CAT-VALID', async () => {
    const content = readFileSync('catalog/apps/fixture.yaml', 'utf8');
    const first = loadCatalog([{ path: 'catalog/apps/fixture.yaml', content }]);
    const second = loadCatalog([{ path: 'catalog/apps/fixture.yaml', content }]);
    expect(first.issues).toEqual([]);
    expect(first.applications).toHaveLength(1);
    expect(first.applications[0]?.metadata.id).toBe('tokentest');
    expect(first.canonical).toBe(second.canonical);
    return { observed: `loaded ${first.applications.length} application(s), canonical deterministic`, evidence: { canonical: first.canonical.slice(0, 16) } };
  });
});

it('CAT-INVALID-SYNTAX: malformed YAML root fails with file and position context', async () => {
  await scenario('CAT-INVALID-SYNTAX', async () => {
    const malformed = 'metadata: [unclosed\n';
    const result = loadCatalog([{ path: 'catalog/apps/broken.yaml', content: malformed }]);
    expect(result.applications).toEqual([]);
    const issue = result.issues[0];
    expect(issue?.code).toBe('LP-SCHEMA-YAML');
    expect(issue?.file).toBe('catalog/apps/broken.yaml');
    expect(issue?.line).toBeGreaterThanOrEqual(1);
    expect(issue?.column).toBeGreaterThanOrEqual(1);
    return { observed: `LP-SCHEMA-YAML at ${issue?.file}:${issue?.line}:${issue?.column}`, evidence: { issues: result.issues } };
  });
});

it('CAT-UNKNOWN-FIELD: an unknown manifest field is rejected, never ignored', async () => {
  await scenario('CAT-UNKNOWN-FIELD', async () => {
    const content = readFileSync('catalog/apps/fixture.yaml', 'utf8');
    const result = loadCatalog([{ path: 'catalog/apps/unknown.yaml', content: `${content}bogusSetting: true\n` }]);
    expect(result.issues.some((issue) => issue.code === 'LP-SCHEMA-UNKNOWN-FIELD')).toBe(true);
    expect(result.applications).toEqual([]);
    return { observed: 'LP-SCHEMA-UNKNOWN-FIELD blocks the manifest', evidence: { issues: result.issues.map((issue) => issue.code) } };
  });
});

it('CAT-DUP-ID: duplicate application IDs block the PR', async () => {
  await scenario('CAT-DUP-ID', async () => {
    const content = readFileSync('catalog/apps/fixture.yaml', 'utf8');
    const first = loadCatalog([{ path: 'catalog/apps/fixture.yaml', content }]);
    const original = first.applications[0];
    if (!original) throw new Error('fixture app missing');
    const duplicate = { ...original, vercel: { ...original.vercel, project: { ...original.vercel.project, name: 'fixture-app-other' } }, domains: [] };
    const result = loadCatalog([
      { path: 'catalog/apps/fixture.yaml', content },
      // The loader sorts manifest paths deterministically; `zz-` sorts after
      // fixture.yaml so the fixture stays the first declaration and the
      // duplicate (flagged) declaration is the second, `zz-duplicate.yaml`.
      { path: 'catalog/apps/zz-duplicate.yaml', content: manifestYaml(duplicate) },
    ]);
    const issue = result.issues.find((candidate) => candidate.code === 'LP-CATALOG-DUPLICATE-ID');
    expect(issue).toBeDefined();
    expect(issue?.file).toBe('catalog/apps/zz-duplicate.yaml');
    expect(issue?.path).toBe('metadata.id');
    expect(issue?.line).toBeGreaterThanOrEqual(1);
    return { observed: `LP-CATALOG-DUPLICATE-ID at ${issue?.file}:${issue?.line}`, evidence: { issues: result.issues.map((candidate) => candidate.code) } };
  });
});

it('CAT-DUP-DOMAIN: duplicate subdomains block the PR', async () => {
  await scenario('CAT-DUP-DOMAIN', async () => {
    const content = readFileSync('catalog/apps/fixture.yaml', 'utf8');
    const first = loadCatalog([{ path: 'catalog/apps/fixture.yaml', content }]);
    const original = first.applications[0];
    if (!original) throw new Error('fixture app missing');
    const duplicate = { ...original, metadata: { ...original.metadata, id: 'other-app' }, vercel: { ...original.vercel, project: { ...original.vercel.project, name: 'other-app' } } };
    const result = loadCatalog([
      { path: 'catalog/apps/fixture.yaml', content },
      { path: 'catalog/apps/other.yaml', content: manifestYaml(duplicate) },
    ]);
    const issue = result.issues.find((candidate) => candidate.code === 'LP-CATALOG-DUPLICATE-DOMAIN');
    expect(issue).toBeDefined();
    expect(issue?.file).toBe('catalog/apps/other.yaml');
    return { observed: `LP-CATALOG-DUPLICATE-DOMAIN for '${original.domains[0]?.hostname}'`, evidence: { issues: result.issues.map((candidate) => candidate.code) } };
  });
});

it('CAT-PLAINTEXT-SECRET: plaintext sensitive secret values are rejected', async () => {
  await scenario('CAT-PLAINTEXT-SECRET', async () => {
    const app = acceptanceManifest();
    const leaky = { ...app, secrets: [{ name: 'DB_PASSWORD', value: 'hunter2', sensitive: true, environments: ['production' as const] }] };
    const result = loadCatalog([{ path: 'catalog/apps/leaky.yaml', content: manifestYaml(leaky) }]);
    const issue = result.issues.find((candidate) => candidate.code === 'LP-SECRET-PLAINTEXT');
    expect(issue).toBeDefined();
    expect(issue?.path).toBe('secrets.0.value');
    return { observed: 'LP-SECRET-PLAINTEXT blocks the manifest', evidence: { issues: result.issues.map((candidate) => candidate.code) } };
  });
});

it('CAT-LIFECYCLE-TRANSITION: invalid lifecycle transitions fail with manifest context', async () => {
  await scenario('CAT-LIFECYCLE-TRANSITION', async () => {
    const content = readFileSync('catalog/apps/fixture.yaml', 'utf8');
    const result = loadCatalog([{ path: 'catalog/apps/fixture.yaml', content }], { previousLifecycle: { tokentest: 'decommissioning' } });
    const issue = result.issues.find((candidate) => candidate.code === 'LP-LIFECYCLE-RECOVERY');
    expect(issue).toBeDefined();
    expect(issue?.path).toBe('lifecycle.state');
    return { observed: 'LP-LIFECYCLE-RECOVERY blocks reactivation without a recovery policy', evidence: { issues: result.issues.map((candidate) => candidate.code) } };
  });
});

it('CAT-DEPENDENCY-CYCLE: dependency cycles between applications are rejected', async () => {
  await scenario('CAT-DEPENDENCY-CYCLE', async () => {
    const app = acceptanceManifest();
    const a = { ...app, metadata: { ...app.metadata, id: 'cycle-a' }, vercel: { ...app.vercel, project: { ...app.vercel.project, name: 'cycle-a' } }, domains: [], dependencies: { applications: ['cycle-b'], external: [] } };
    const b = { ...app, metadata: { ...app.metadata, id: 'cycle-b' }, vercel: { ...app.vercel, project: { ...app.vercel.project, name: 'cycle-b' } }, domains: [], dependencies: { applications: ['cycle-a'], external: [] } };
    const result = loadCatalog([
      { path: 'catalog/apps/cycle-a.yaml', content: manifestYaml(a) },
      { path: 'catalog/apps/cycle-b.yaml', content: manifestYaml(b) },
    ]);
    const issue = result.issues.find((candidate) => candidate.code === 'LP-CATALOG-DEPENDENCY-CYCLE');
    expect(issue).toBeDefined();
    return { observed: 'LP-CATALOG-DEPENDENCY-CYCLE detected', evidence: { issues: result.issues.map((candidate) => candidate.code) } };
  });
});

it('CAT-UNSUPPORTED-SETTING: real matrices plan a from-scratch domain app READY; a truly unsupported field still blocks', async () => {
  await scenario('CAT-UNSUPPORTED-SETTING', async () => {
    const harness = createD1Store(fixedNow);
    try {
      await seedApplication(harness.store);
      const desired = acceptanceManifest();
      const transport = applyTransport();
      const provider = compositeFor(transport);
      const { plan, observed } = await planFor(harness.store, provider, desired, COMMIT_A, 1, NOW);
      // Regression: a valid from-scratch domain plan must not be blocked on
      // capability coverage (LP-UNSUPPORTED-FIELD) with the real matrices.
      expect(plan.result, `from-scratch domain plan blocked: ${plan.blockedReason ?? 'unknown'}`).toBe('READY');
      expect(plan.operations.some((operation) => operation.action === 'CREATE')).toBe(true);

      const unsupported = { ...desired, vercel: { ...desired.vercel, project: { ...desired.vercel.project, settings: { autoAssignProductionDomains: false, webAnalytics: true } } } };
      const capabilities = await provider.capabilities();
      const blocked = await buildPlan({
        desired: unsupported, observed, capabilities,
        sourceCommit: COMMIT_A, desiredGeneration: 1, ownership: {}, mode: 'apply', now: NOW,
      });
      expect(blocked.result).toBe('BLOCKED');
      expect(blocked.blockedReason).toBe('LP-UNSUPPORTED-FIELD');
      return {
        observed: `plan READY with real matrices; unsupported 'webAnalytics' blocks with ${blocked.blockedReason}`,
        resourceIds: { vercelProject: ACCEPTANCE_PROJECT_ID },
        evidence: logEvidence(transport, { readyResult: plan.result, blockedResult: blocked.result }),
      };
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Repository access scenarios
// ---------------------------------------------------------------------------

function githubTransport(entries: Parameters<RecordedSandboxTransport['constructor']>[0]): RecordedSandboxTransport {
  return new RecordedSandboxTransport(entries);
}

it('GH-PRIVATE-ACCESS: an accessible private repository is observed with identity and access', async () => {
  await scenario('GH-PRIVATE-ACCESS', async () => {
    const transport = githubTransport([
      { id: 'github.repo.get', method: 'GET', url: 'https://github.sandbox.test/repos/acme/private-app', json: { id: 424243, archived: false, private: true, default_branch: 'main' } },
    ]);
    const adapter = new GitHubAdapter({ token: 'lp-sandbox-token', baseUrl: 'https://github.sandbox.test', fetchImpl: transport.fetchImpl });
    const observed = await adapter.observeRepository('acme/private-app', acceptanceContext('gh-access'));
    expect(observed).toMatchObject({ provider: 'github', repository: 'acme/private-app', repositoryId: 424243, private: true, access: true, defaultBranch: 'main' });
    return { observed: `private repository ${observed.repository} observed with access`, resourceIds: { githubRepositoryId: '424243' }, evidence: logEvidence(transport) };
  });
});

it('GH-PRIVATE-DENIED: an inaccessible repository surfaces a typed authorization error', async () => {
  await scenario('GH-PRIVATE-DENIED', async () => {
    const transport = githubTransport([
      { id: 'github.repo.forbidden', method: 'GET', url: 'https://github.sandbox.test/repos/acme/private-app', status: 403, json: { error: { message: 'Resource not accessible by integration' } } },
    ]);
    const adapter = new GitHubAdapter({ token: 'lp-sandbox-token', baseUrl: 'https://github.sandbox.test', fetchImpl: transport.fetchImpl });
    await expect(adapter.observeRepository('acme/private-app', acceptanceContext('gh-deny'))).rejects.toMatchObject({
      code: 'LP-GITHUB-HTTP-403',
      class: 'AUTHORIZATION',
      retryable: false,
    });
    return { observed: 'LP-GITHUB-HTTP-403 (AUTHORIZATION) blocks private-repo access', evidence: logEvidence(transport) };
  });
});

it('GH-ARCHIVED: archived repositories are surfaced as archived for the access gate', async () => {
  await scenario('GH-ARCHIVED', async () => {
    const transport = githubTransport([
      { id: 'github.repo.archived', method: 'GET', url: 'https://github.sandbox.test/repos/acme/archived-app', json: { id: 7, archived: true, private: false, default_branch: 'main' } },
    ]);
    const adapter = new GitHubAdapter({ token: 'lp-sandbox-token', baseUrl: 'https://github.sandbox.test', fetchImpl: transport.fetchImpl });
    const observed = await adapter.observeRepository('acme/archived-app', acceptanceContext('gh-archived'));
    expect(observed.archived).toBe(true);
    expect(observed.access).toBe(true);
    return { observed: `archived repository observed (archived=${observed.archived})`, evidence: logEvidence(transport) };
  });
});

// ---------------------------------------------------------------------------
// Shadow preview scenarios (plan sections 13.4/36/47, 33)
// ---------------------------------------------------------------------------

function previewTransport(projectName: string, deployment: { id: string; state: string; url: string; logLines?: string[] }, commit = COMMIT_A): RecordedSandboxTransport {
  const entries: Array<Record<string, unknown> & { id: string }> = [
    { id: 'preview.project.get.404', method: 'GET', url: `https://vercel.sandbox.test/v9/projects/${projectName}`, status: 404, json: { error: { code: 'not_found' } }, times: 1 },
    { id: 'preview.project.get', method: 'GET', url: `https://vercel.sandbox.test/v9/projects/${projectName}`, json: { id: 'prj_shadow', name: projectName, settings: { launchpadApplicationId: ACCEPTANCE_APP_ID } } },
    { id: 'preview.project.create', method: 'POST', url: 'https://vercel.sandbox.test/v10/projects', json: { id: 'prj_shadow', name: projectName, settings: { launchpadApplicationId: ACCEPTANCE_APP_ID, launchpadPullRequest: 7, launchpadRevision: 1 } } },
    { id: 'preview.git.patch', method: 'PATCH', url: `https://vercel.sandbox.test/v9/projects/${projectName}`, json: {} },
    { id: 'preview.env.create', method: 'POST', url: `https://vercel.sandbox.test/v10/projects/${projectName}/env`, json: { key: 'LAUNCHPAD_ENV', id: 'env_preview_1' } },
    { id: 'preview.deployment.create', method: 'POST', url: 'https://vercel.sandbox.test/v13/deployments', json: { id: deployment.id, url: deployment.url, state: 'QUEUED' } },
    { id: 'preview.deployment.wait', method: 'GET', url: `https://vercel.sandbox.test/v13/deployments/${deployment.id}`, json: { id: deployment.id, projectId: projectName, url: deployment.url, state: deployment.state, target: null, meta: { gitCommitSha: commit } } },
  ];
  if (deployment.logLines) {
    entries.push({ id: 'preview.deployment.logs', method: 'GET', url: `https://vercel.sandbox.test/v3/deployments/${deployment.id}/events?limit=100&direction=forward`, json: { events: deployment.logLines.map((line) => ({ type: 'stdout', payload: { text: line } })) } });
  }
  return new RecordedSandboxTransport(entries as never);
}

function previewRun(store: Awaited<ReturnType<typeof createD1Store>>['store'], provider: CompositeProvider, desired: DesiredApplication, revision: number, sourceCommit: string, key: string, options: { fetchImpl?: typeof fetch; projectName?: string } = {}): ReturnType<typeof runPreviewWorkflow> {
  return runPreviewWorkflow({
    store,
    provider,
    desired,
    pullRequestNumber: 7,
    repositoryId: ACCEPTANCE_REPOSITORY_ID,
    revision,
    sourceCommit,
    planFingerprint: `preview-${revision}`,
    idempotencyKey: key,
    context: acceptanceContext(`preview-${revision}`),
    fetchImpl: options.fetchImpl ?? healthServer([{ status: 200, body: '{"status":"ok"}' }]),
    sleep: NOOP_SLEEP,
    now: fixedNow,
  });
}

it('PRV-READY: a valid proposed configuration receives a working shadow preview', async () => {
  await scenario('PRV-READY', async () => {
    const harness = createD1Store(fixedNow);
    try {
      const desired = acceptanceManifest();
      const projectName = shadowProjectName({ applicationId: ACCEPTANCE_APP_ID, pullRequestNumber: 7, repositoryId: ACCEPTANCE_REPOSITORY_ID, revision: 1, commitSha: COMMIT_A });
      const transport = previewTransport(projectName, { id: 'dpl_preview_1', state: 'READY', url: `${projectName}.vercel.sandbox.test` });
      const provider = compositeFor(transport);
      const result = await previewRun(harness.store, provider, desired, 1, COMMIT_A, `preview-${ACCEPTANCE_APP_ID}-rev1`);
      expect(result.status, `preview failed: ${result.errorCode ?? 'unknown'}`).toBe('READY');
      expect(result.deployment?.state).toBe('READY');
      expect(result.health?.result).toBe('PASSED');
      expect(result.projectName).toBe(projectName);
      expect(result.cleanupJobId).not.toBeNull();
      const resources = await harness.store.listResources(ACCEPTANCE_APP_ID);
      const shadow = resources.find((resource) => resource.resourceType === 'vercel.shadow-project');
      expect(shadow).toBeDefined();
      expect(shadow?.status).toBe('ACTIVE');
      expect(shadow?.ownershipFingerprint).toBe('prj_shadow');
      const run = (await harness.store.listWorkflowRuns(ACCEPTANCE_APP_ID))[0];
      expect(run?.status).toBe('READY');
      return {
        observed: `preview READY (${result.projectName}), health PASSED, cleanup scheduled`,
        resourceIds: { vercelProject: 'prj_shadow', deployment: 'dpl_preview_1' },
        evidence: logEvidence(transport, { cleanupJobId: result.cleanupJobId, shadowResource: shadow?.resourceKey }),
      };
    } finally {
      harness.close();
    }
  });
});

it('PRV-BUILD-ERROR: a failing build fails the preview loudly with a bounded log excerpt', async () => {
  await scenario('PRV-BUILD-ERROR', async () => {
    const harness = createD1Store(fixedNow);
    try {
      const desired = acceptanceManifest();
      const projectName = shadowProjectName({ applicationId: ACCEPTANCE_APP_ID, pullRequestNumber: 7, repositoryId: ACCEPTANCE_REPOSITORY_ID, revision: 1, commitSha: COMMIT_A });
      const transport = previewTransport(projectName, {
        id: 'dpl_preview_err', state: 'ERROR', url: `${projectName}.vercel.sandbox.test`,
        logLines: ['Error: Command "yarn build" exited with 1', '> launchpad fixture build failed'],
      });
      const provider = compositeFor(transport);
      const result = await previewRun(harness.store, provider, desired, 1, COMMIT_A, `preview-err-${ACCEPTANCE_APP_ID}`);
      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('LP-VERCEL-BUILD-FAILED');
      expect(result.buildLogExcerpt).toContain('yarn build');
      expect(result.buildLogExcerpt?.length ?? 0).toBeLessThanOrEqual(4096);
      expect(result.health).toBeNull();
      return {
        observed: 'LP-VERCEL-BUILD-FAILED with bounded log excerpt',
        resourceIds: { deployment: 'dpl_preview_err' },
        evidence: logEvidence(transport, { excerptLength: result.buildLogExcerpt?.length ?? 0 }),
      };
    } finally {
      harness.close();
    }
  });
});

it('PRV-INVALID-ROOT: an incorrect root directory fails the preview with the Vercel build error', async () => {
  await scenario('PRV-INVALID-ROOT', async () => {
    const harness = createD1Store(fixedNow);
    try {
      const content = readFileSync('tests/fixtures/catalog/invalid-root.yaml', 'utf8');
      const catalog = loadCatalog([{ path: 'catalog/apps/invalid-root.yaml', content }]);
      expect(catalog.issues).toEqual([]);
      const desired = catalog.applications[0];
      if (!desired) throw new Error('invalid-root fixture did not load');
      const projectName = shadowProjectName({ applicationId: desired.metadata.id, pullRequestNumber: 7, repositoryId: ACCEPTANCE_REPOSITORY_ID, revision: 1, commitSha: COMMIT_A });
      const transport = previewTransport(projectName, {
        id: 'dpl_invalid_root', state: 'ERROR', url: `${projectName}.vercel.sandbox.test`,
        logLines: ['Error: Could not find "apps/missing/package.json"'],
      });
      const provider = compositeFor(transport);
      const result = await runPreviewWorkflow({
        store: harness.store,
        provider,
        desired,
        pullRequestNumber: 7,
        repositoryId: ACCEPTANCE_REPOSITORY_ID,
        revision: 1,
        sourceCommit: COMMIT_A,
        planFingerprint: 'preview-invalid-root',
        idempotencyKey: `preview-invalid-root-${desired.metadata.id}`,
        context: acceptanceContext('preview-invalid-root', desired.metadata.id),
        fetchImpl: healthServer([{ status: 500 }]),
        sleep: NOOP_SLEEP,
        now: fixedNow,
      });
      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('LP-VERCEL-BUILD-FAILED');
      expect(result.buildLogExcerpt).toContain('apps/missing');
      return {
        observed: `invalid root '${desired.vercel.project.rootDirectory}' fails the preview with the Vercel build error`,
        evidence: logEvidence(transport, { rootDirectory: desired.vercel.project.rootDirectory }),
      };
    } finally {
      harness.close();
    }
  });
});

it('PRV-SUPERSEDE: a new revision supersedes the prior shadow preview and cleans it up', async () => {
  await scenario('PRV-SUPERSEDE', async () => {
    const harness = createD1Store(fixedNow);
    try {
      const desired = acceptanceManifest();
      const name1 = shadowProjectName({ applicationId: ACCEPTANCE_APP_ID, pullRequestNumber: 7, repositoryId: ACCEPTANCE_REPOSITORY_ID, revision: 1, commitSha: COMMIT_A });
      const name2 = shadowProjectName({ applicationId: ACCEPTANCE_APP_ID, pullRequestNumber: 7, repositoryId: ACCEPTANCE_REPOSITORY_ID, revision: 2, commitSha: COMMIT_B });
      const transport = new RecordedSandboxTransport([
        { id: 'supersede.project1.get.404', method: 'GET', url: `https://vercel.sandbox.test/v9/projects/${name1}`, status: 404, json: { error: { code: 'not_found' } }, times: 1 },
        { id: 'supersede.project1.create', method: 'POST', url: 'https://vercel.sandbox.test/v10/projects', json: { id: 'prj_shadow_1', name: name1, settings: { launchpadApplicationId: ACCEPTANCE_APP_ID, launchpadPullRequest: 7, launchpadRevision: 1 } } },
        { id: 'supersede.project1.git', method: 'PATCH', url: `https://vercel.sandbox.test/v9/projects/${name1}`, json: {} },
        { id: 'supersede.project1.env', method: 'POST', url: `https://vercel.sandbox.test/v10/projects/${name1}/env`, json: { key: 'LAUNCHPAD_ENV', id: 'env_preview_1' } },
        { id: 'supersede.deployment1.create', method: 'POST', url: 'https://vercel.sandbox.test/v13/deployments', json: { id: 'dpl_preview_1', url: `${name1}.vercel.sandbox.test`, state: 'QUEUED' } },
        { id: 'supersede.deployment1.wait', method: 'GET', url: 'https://vercel.sandbox.test/v13/deployments/dpl_preview_1', json: { id: 'dpl_preview_1', projectId: name1, url: `${name1}.vercel.sandbox.test`, state: 'READY', target: null, meta: { gitCommitSha: COMMIT_A } } },
        // Revision 2 supersedes revision 1: cleanup re-observes the prior
        // shadow project (ownership check) before deleting it.
        { id: 'supersede.project1.get', method: 'GET', url: `https://vercel.sandbox.test/v9/projects/${name1}`, json: { id: 'prj_shadow_1', name: name1, settings: { launchpadApplicationId: ACCEPTANCE_APP_ID, launchpadPullRequest: 7, launchpadRevision: 1 } } },
        { id: 'supersede.project1.delete', method: 'DELETE', url: 'https://vercel.sandbox.test/v9/projects/prj_shadow_1', json: {} },
        { id: 'supersede.project2.get.404', method: 'GET', url: `https://vercel.sandbox.test/v9/projects/${name2}`, status: 404, json: { error: { code: 'not_found' } }, times: 1 },
        { id: 'supersede.project2.get', method: 'GET', url: `https://vercel.sandbox.test/v9/projects/${name2}`, json: { id: 'prj_shadow_2', name: name2, settings: { launchpadApplicationId: ACCEPTANCE_APP_ID } } },
        { id: 'supersede.project2.create', method: 'POST', url: 'https://vercel.sandbox.test/v10/projects', json: { id: 'prj_shadow_2', name: name2, settings: { launchpadApplicationId: ACCEPTANCE_APP_ID, launchpadPullRequest: 7, launchpadRevision: 2 } } },
        { id: 'supersede.project2.git', method: 'PATCH', url: `https://vercel.sandbox.test/v9/projects/${name2}`, json: {} },
        { id: 'supersede.project2.env', method: 'POST', url: `https://vercel.sandbox.test/v10/projects/${name2}/env`, json: { key: 'LAUNCHPAD_ENV', id: 'env_preview_2' } },
        { id: 'supersede.deployment.create', method: 'POST', url: 'https://vercel.sandbox.test/v13/deployments', json: { id: 'dpl_preview_2', url: `${name2}.vercel.sandbox.test`, state: 'QUEUED' } },
        { id: 'supersede.deployment.wait', method: 'GET', url: 'https://vercel.sandbox.test/v13/deployments/dpl_preview_2', json: { id: 'dpl_preview_2', projectId: name2, url: `${name2}.vercel.sandbox.test`, state: 'READY', target: null, meta: { gitCommitSha: COMMIT_B } } },
      ]);
      const provider = compositeFor(transport);

      const first = await previewRun(harness.store, provider, desired, 1, COMMIT_A, `preview-supersede-rev1`, { projectName: name1 });
      expect(first.status, `first preview failed: ${first.errorCode ?? 'unknown'}`).toBe('READY');

      const second = await previewRun(harness.store, provider, desired, 2, COMMIT_B, `preview-supersede-rev2`, { projectName: name2 });
      expect(second.status, `second preview failed: ${second.errorCode ?? 'unknown'}`).toBe('READY');
      expect(second.projectName).toBe(name2);

      // Prior shadow project deleted on the provider; exactly one ACTIVE shadow resource remains.
      expect(transport.calls((entry) => entry.exchangeId === 'supersede.project1.delete')).toHaveLength(1);
      const resources = await harness.store.listResources(ACCEPTANCE_APP_ID);
      const active = resources.filter((resource) => resource.resourceType === 'vercel.shadow-project' && resource.status === 'ACTIVE');
      expect(active.map((resource) => resource.resourceKey)).toEqual([name2]);
      const cleanupJobs = await harness.store.listCleanupJobs(ACCEPTANCE_APP_ID);
      expect(cleanupJobs.filter((job) => job.status === 'SUCCEEDED').length).toBeGreaterThanOrEqual(1);
      const runs = await harness.store.listWorkflowRuns(ACCEPTANCE_APP_ID);
      expect(runs.find((run) => run.idempotencyKey === 'preview-supersede-rev1')?.status).toBe('READY');
      return {
        observed: `revision 2 superseded revision 1: ${name1} cleaned, ${name2} active`,
        resourceIds: { vercelProject1: 'prj_shadow_1', vercelProject2: 'prj_shadow_2' },
        evidence: logEvidence(transport, { activeShadowResources: active.map((resource) => resource.resourceKey) }),
      };
    } finally {
      harness.close();
    }
  });
});

it('PRV-PRODUCTION-SECRET: production-only secret targets are rejected before any provider write', async () => {
  await scenario('PRV-PRODUCTION-SECRET', async () => {
    const harness = createD1Store(fixedNow);
    try {
      const desired = acceptanceManifest();
      const leaky: DesiredApplication = {
        ...desired,
        secrets: [{ name: 'PROD_ONLY', source: 'env://PROD_ONLY', environments: ['production'] }],
        environments: {
          ...desired.environments,
          preview: { ...desired.environments.preview!, variables: { PROD_ONLY: { secretRef: 'PROD_ONLY', sensitive: true } } },
        },
      };
      const transport = new RecordedSandboxTransport([]);
      const provider = compositeFor(transport);
      const result = await previewRun(harness.store, provider, leaky, 1, COMMIT_A, 'preview-prod-secret');
      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('LP-PREVIEW-PRODUCTION-SECRET-REJECTED');
      expect(transport.calls()).toHaveLength(0);
      return { observed: 'LP-PREVIEW-PRODUCTION-SECRET-REJECTED before any provider write', evidence: { transportLog: [] } };
    } finally {
      harness.close();
    }
  });
});

it('PRV-GATE: the application preview gate passes on READY+healthy and fails loudly on build ERROR', async () => {
  await scenario('PRV-GATE', async () => {
    const harness = createD1Store(fixedNow);
    try {
      const desired = acceptanceManifest();
      await seedApplication(harness.store);

      // Passing case: READY build + PASSED health.
      const passTransport = new RecordedSandboxTransport([
        { id: 'gate.deployments.list', method: 'GET', url: `https://vercel.sandbox.test/v7/deployments?projectId=${ACCEPTANCE_APP_ID}&limit=100`, json: { deployments: [{ uid: 'dpl_gate_1', name: ACCEPTANCE_APP_ID, url: 'acceptance-app-preview.vercel.sandbox.test', state: 'BUILDING', target: null, meta: { githubCommitSha: COMMIT_A, gitRepo: ACCEPTANCE_REPOSITORY } }] } },
        { id: 'gate.deployment.wait', method: 'GET', url: 'https://vercel.sandbox.test/v13/deployments/dpl_gate_1', json: { id: 'dpl_gate_1', projectId: ACCEPTANCE_APP_ID, url: 'acceptance-app-preview.vercel.sandbox.test', state: 'READY', target: null, meta: { gitCommitSha: COMMIT_A } } },
        { id: 'gate.deployment.logs', method: 'GET', url: 'https://vercel.sandbox.test/v3/deployments/dpl_gate_1/events?limit=100&direction=forward', json: { events: [] } },
      ]);
      const passProvider = compositeFor(passTransport);
      const passed = await runAppPreviewStatusWorkflow({
        store: harness.store,
        provider: passProvider,
        desired,
        sourceCommit: COMMIT_A,
        context: acceptanceContext('app-gate-pass'),
        waitTimeoutMs: 10_000,
        waitPollMs: 100,
        fetchImpl: healthServer([{ status: 200, body: '{"status":"ok"}' }]),
        sleep: NOOP_SLEEP,
      });
      expect(passed.status).toBe('SUCCEEDED');
      expect(passed.gateState).toBe('PASSED');
      expect(passed.buildState).toBe('READY');
      expect(passed.health?.result).toBe('PASSED');
      expect(passed.deploymentStatus.state).toBe('success');

      // Failing case: build ERROR with a log excerpt.
      const failTransport = new RecordedSandboxTransport([
        { id: 'gate.deployments.list.fail', method: 'GET', url: `https://vercel.sandbox.test/v7/deployments?projectId=${ACCEPTANCE_APP_ID}&limit=100`, json: { deployments: [{ uid: 'dpl_gate_2', name: ACCEPTANCE_APP_ID, url: 'acceptance-app-preview.vercel.sandbox.test', state: 'BUILDING', target: null, meta: { githubCommitSha: COMMIT_B, gitRepo: ACCEPTANCE_REPOSITORY } }] } },
        { id: 'gate.deployment.wait.fail', method: 'GET', url: 'https://vercel.sandbox.test/v13/deployments/dpl_gate_2', json: { id: 'dpl_gate_2', projectId: ACCEPTANCE_APP_ID, url: 'acceptance-app-preview.vercel.sandbox.test', state: 'ERROR', target: null, meta: { gitCommitSha: COMMIT_B } } },
        { id: 'gate.deployment.logs.fail', method: 'GET', url: 'https://vercel.sandbox.test/v3/deployments/dpl_gate_2/events?limit=100&direction=forward', json: { events: [{ type: 'stdout', payload: { text: 'Error: Command "yarn build" exited with 1' } }] } },
      ]);
      const failProvider = compositeFor(failTransport);
      const failed = await runAppPreviewStatusWorkflow({
        store: harness.store,
        provider: failProvider,
        desired,
        sourceCommit: COMMIT_B,
        context: acceptanceContext('app-gate-fail'),
        waitTimeoutMs: 10_000,
        waitPollMs: 100,
        fetchImpl: healthServer([{ status: 500 }]),
        sleep: NOOP_SLEEP,
      });
      expect(failed.status).toBe('FAILED');
      expect(failed.gateState).toBe('FAILED');
      expect(failed.buildState).toBe('ERROR');
      expect(failed.failure?.code).toBe('LP-VERCEL-BUILD-FAILED');
      expect(failed.commentBody).toContain('yarn build');
      expect(failed.deploymentStatus.state).toBe('error');
      return {
        observed: 'gate PASSED on READY+healthy; gate FAILED (LP-VERCEL-BUILD-FAILED) on ERROR with log excerpt',
        resourceIds: { deployment1: 'dpl_gate_1', deployment2: 'dpl_gate_2' },
        evidence: logEvidence(failTransport, { passedGate: passed.gateState, failedGate: failed.gateState, commentLength: failed.commentBody.length }),
      };
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// DNS scenarios (plan sections 13.7/47, 33)
// ---------------------------------------------------------------------------

it('DNS-CREATE-VERIFY: the correct CNAME is created with ownership and verifies authoritatively', async () => {
  await scenario('DNS-CREATE-VERIFY', async () => {
    const transport = new RecordedSandboxTransport([
      { id: 'dns.zone.get', method: 'GET', url: 'https://cloudflare.sandbox.test/zones?name=acceptance.test', json: cfEnvelope([recordedZone()]) },
      // ensureRecord observes before the mutation (absent) and again as a
      // postcondition (present) — the absent entry serves exactly the first.
      { id: 'dns.record.list.absent', method: 'GET', url: /dns_records\?name=acceptance\.example\.com(?:&type=CNAME)?$/, json: cfEnvelope([]), times: 1 },
      { id: 'dns.record.create', method: 'POST', url: 'https://cloudflare.sandbox.test/zones/zone_acceptance_1/dns_records', json: cfEnvelope(recordedDnsRecord({ comment: `launchpad:${DNS_OWNERSHIP}` })) },
      { id: 'dns.record.list.present', method: 'GET', url: /dns_records\?name=acceptance\.example\.com(?:&type=CNAME)?$/, json: cfEnvelope([recordedDnsRecord({ comment: `launchpad:${DNS_OWNERSHIP}` })]), times: 2 },
    ]);
    const adapter = new CloudflareAdapter({ token: 'lp-sandbox-token', baseUrl: 'https://cloudflare.sandbox.test', fetchImpl: transport.fetchImpl, resolveDns: VERIFIED_RESOLVER });
    const ctx = acceptanceContext('dns-create');
    const zone = await adapter.observeZone(ACCEPTANCE_ZONE_REF, ctx);
    expect(zone.zoneId).toBe(ACCEPTANCE_ZONE_ID);
    const required = { hostname: ACCEPTANCE_DOMAIN, type: 'CNAME' as const, value: DNS_TARGET, ttl: 'auto' as const };
    const created = await adapter.ensureRecord(zone.zoneId, required, DNS_OWNERSHIP, ctx);
    expect(created.changed).toBe(true);
    expect(created.resource.id).toBe('dns_acceptance_1');
    expect(created.resource.ownershipFingerprint).toBe(DNS_OWNERSHIP);
    const verified = await adapter.verifyAuthoritative(ACCEPTANCE_DOMAIN, required, ctx, zone);
    expect(verified).toBe(true);
    return {
      observed: `record ${created.resource.id} created with ownership and authoritative verification passed`,
      resourceIds: { cloudflareZone: ACCEPTANCE_ZONE_ID, dnsRecord: 'dns_acceptance_1' },
      evidence: logEvidence(transport, { changed: created.changed, verified }),
    };
  });
});

it('DNS-UNOWNED-CONFLICT: a conflicting unowned record blocks apply', async () => {
  await scenario('DNS-UNOWNED-CONFLICT', async () => {
    const harness = createD1Store(fixedNow);
    try {
      await seedApplication(harness.store);
      const desired = acceptanceManifest();
      const transport = applyTransport({
        // The existing record carries another Launchpad application's
        // ownership fingerprint (non-null, wrong app): the apply machine and
        // the adapter both refuse to overwrite it (LP-DNS-CONFLICT-UNOWNED).
        dnsRecord: recordedDnsRecord({ comment: `launchpad:${idempotencyKey('ownership', 'other-app', ACCEPTANCE_DOMAIN)}` }),
        dnsAbsentTimes: 0,
        dnsPresentTimes: 100,
      });
      const provider = compositeFor(transport);
      const { plan, observed } = await planFor(harness.store, provider, desired, COMMIT_A, 1, NOW);
      const result = await runApply(harness.store, provider, desired, plan, observed, { sourceCommit: COMMIT_A, workflowId: 'apply-dns-conflict' });
      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('LP-DNS-CONFLICT-UNOWNED');
      expect(transport.calls((entry) => entry.exchangeId === 'cf.record.create')).toHaveLength(0);
      return {
        observed: 'LP-DNS-CONFLICT-UNOWNED blocks apply; the unowned record is never overwritten',
        resourceIds: { dnsRecord: 'dns_acceptance_1' },
        evidence: logEvidence(transport, { providerWrites: transport.writes().map((entry) => entry.exchangeId) }),
      };
    } finally {
      harness.close();
    }
  });
});

it('DNS-PROPAGATION-DELAY: authoritative verification retries with bounded backoff until the record converges', async () => {
  await scenario('DNS-PROPAGATION-DELAY', async () => {
    let resolverCalls = 0;
    const resolver = async (): Promise<string[]> => {
      resolverCalls += 1;
      return resolverCalls >= 3 ? [DNS_TARGET] : [];
    };
    const adapter = new CloudflareAdapter({
      token: 'lp-sandbox-token',
      baseUrl: 'https://cloudflare.sandbox.test',
      fetchImpl: healthServer([{ status: 200 }]),
      resolveDns: resolver,
      verification: { maxAttempts: 5, baseDelayMs: 1, timeoutMs: 1_000, sleep: NOOP_SLEEP, jitter: () => 0 },
    });
    const zone = { provider: 'cloudflare' as const, zoneId: ACCEPTANCE_ZONE_ID, name: 'acceptance.test', nameservers: ['ns1.acceptance.test', 'ns2.acceptance.test'], status: 'active' };
    const required = { hostname: ACCEPTANCE_DOMAIN, type: 'CNAME' as const, value: DNS_TARGET, ttl: 'auto' as const };
    const verified = await adapter.verifyAuthoritative(ACCEPTANCE_DOMAIN, required, acceptanceContext('dns-delay'), zone);
    expect(verified).toBe(true);
    expect(resolverCalls).toBe(3);
    return { observed: `verification converged after ${resolverCalls} resolver attempts`, evidence: { resolverCalls } };
  });
});

it('DNS-PERMANENT-FAILURE: permanently invalid DNS fails loudly after the bounded window', async () => {
  await scenario('DNS-PERMANENT-FAILURE', async () => {
    const adapter = new CloudflareAdapter({
      token: 'lp-sandbox-token',
      baseUrl: 'https://cloudflare.sandbox.test',
      fetchImpl: healthServer([{ status: 200 }]),
      resolveDns: NEVER_RESOLVER,
      verification: { maxAttempts: 4, baseDelayMs: 1, timeoutMs: 1_000, sleep: NOOP_SLEEP, jitter: () => 0 },
    });
    const zone = { provider: 'cloudflare' as const, zoneId: ACCEPTANCE_ZONE_ID, name: 'acceptance.test', nameservers: ['ns1.acceptance.test', 'ns2.acceptance.test'], status: 'active' };
    const required = { hostname: ACCEPTANCE_DOMAIN, type: 'CNAME' as const, value: DNS_TARGET, ttl: 'auto' as const };
    await expect(adapter.verifyAuthoritative(ACCEPTANCE_DOMAIN, required, acceptanceContext('dns-invalid'), zone)).rejects.toMatchObject({
      code: 'LP-DNS-VERIFICATION-TIMEOUT',
      class: 'TIMEOUT',
      retryable: true,
    });
    return { observed: 'LP-DNS-VERIFICATION-TIMEOUT after 4 bounded attempts', evidence: { maxAttempts: 4 } };
  });
});

it('DNS-AUTH-NS-MISSING: missing authoritative nameservers fail closed', async () => {
  await scenario('DNS-AUTH-NS-MISSING', async () => {
    const adapter = new CloudflareAdapter({ token: 'lp-sandbox-token', baseUrl: 'https://cloudflare.sandbox.test', fetchImpl: healthServer([{ status: 200 }]), resolveDns: VERIFIED_RESOLVER });
    const zone = { provider: 'cloudflare' as const, zoneId: ACCEPTANCE_ZONE_ID, name: 'acceptance.test', nameservers: [], status: 'active' };
    const required = { hostname: ACCEPTANCE_DOMAIN, type: 'CNAME' as const, value: DNS_TARGET, ttl: 'auto' as const };
    await expect(adapter.verifyAuthoritative(ACCEPTANCE_DOMAIN, required, acceptanceContext('dns-ns'), zone)).rejects.toMatchObject({
      code: 'LP-DNS-AUTHORITATIVE-NAMESERVERS-MISSING',
      retryable: false,
    });
    return { observed: 'LP-DNS-AUTHORITATIVE-NAMESERVERS-MISSING fails closed' };
  });
});

it('DNS-PROXY-WRITE-GATE: acknowledged proxied mode writes proxied:true and promotes after compatible origin/public probes', async () => {
  await scenario('DNS-PROXY-WRITE-GATE', async () => {
    const harness = createD1Store(fixedNow);
    try {
      await seedApplication(harness.store);
      const desired = acceptanceManifest({ domainMode: 'proxied' });
      const transport = applyTransport({ dnsRecord: recordedDnsRecord({ proxied: true, comment: `launchpad:${DNS_OWNERSHIP}` }), proxyProbe: 'compatible' });
      const provider = compositeFor(transport);
      const { plan, observed } = await planFor(harness.store, provider, desired, COMMIT_A, 1, NOW);
      const result = await runApply(harness.store, provider, desired, plan, observed, { sourceCommit: COMMIT_A, workflowId: 'proxy-gate' });
      expect(result.status, `proxy apply failed: ${result.errorCode ?? 'unknown'}`).toBe('SUCCEEDED');
      const create = transport.calls().find((entry) => entry.method === 'POST' && entry.url.endsWith('/dns_records'));
      expect(create?.body).toMatchObject({ proxied: true, ttl: 1 });
      expect(transport.calls().some((entry) => entry.exchangeId === 'cf.probe.origin' && entry.url === 'https://acceptance-app.vercel.sandbox.test/api/health')).toBe(true);
      expect(transport.calls().some((entry) => entry.exchangeId === 'cf.probe.public' && entry.url === `https://${ACCEPTANCE_DOMAIN}/api/health`)).toBe(true);
      expect(transport.calls().some((entry) => entry.method === 'POST' && entry.url.includes('/promote'))).toBe(true);
      return {
        observed: 'proxied CNAME written (proxied:true), origin/public probes compatible, promotion proceeded',
        evidence: { createBody: create?.body, probeOrder: transport.calls().filter((entry) => entry.exchangeId === 'cf.probe.origin' || entry.exchangeId === 'cf.probe.public').map((entry) => ({ exchangeId: entry.exchangeId, url: entry.url, status: entry.status })) },
      };
    } finally {
      harness.close();
    }
  });
});

it('DNS-PROXY-INCOMPATIBLE: incompatible origin/public probes block promotion', async () => {
  await scenario('DNS-PROXY-INCOMPATIBLE', async () => {
    const harness = createD1Store(fixedNow);
    try {
      await seedApplication(harness.store);
      const desired = acceptanceManifest({ domainMode: 'proxied' });
      const transport = applyTransport({ dnsRecord: recordedDnsRecord({ proxied: true, comment: `launchpad:${DNS_OWNERSHIP}` }), proxyProbe: 'incompatible' });
      const provider = compositeFor(transport);
      const { plan, observed } = await planFor(harness.store, provider, desired, COMMIT_A, 1, NOW);
      const result = await runApply(harness.store, provider, desired, plan, observed, { sourceCommit: COMMIT_A, workflowId: 'proxy-block' });
      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('LP-DNS-PROXY-COMPATIBILITY-FAILED');
      expect(transport.calls().some((entry) => entry.method === 'POST' && entry.url.includes('/promote'))).toBe(false);
      expect(transport.calls().some((entry) => entry.exchangeId === 'cf.probe.origin')).toBe(true);
      return { observed: 'LP-DNS-PROXY-COMPATIBILITY-FAILED: origin probe lacked cf-connecting-ip passthrough; promotion never ran' };
    } finally {
      harness.close();
    }
  });
});

it('DNS-PROXY-UNACKNOWLEDGED: unacknowledged proxied mode blocks before any DNS write', async () => {
  await scenario('DNS-PROXY-UNACKNOWLEDGED', async () => {
    const harness = createD1Store(fixedNow);
    try {
      await seedApplication(harness.store);
      const desired = acceptanceManifest({ domainMode: 'proxied' });
      delete desired.domains[0]?.cloudflare.proxy;
      const transport = applyTransport();
      const provider = compositeFor(transport);
      const { plan, observed } = await planFor(harness.store, provider, desired, COMMIT_A, 1, NOW);
      expect(plan.result).toBe('BLOCKED');
      expect(plan.policyResults.some((entry) => entry.rule === 'dns.proxyAcknowledgment' && entry.result === 'BLOCK')).toBe(true);
      const result = await runApply(harness.store, provider, desired, plan, observed, { sourceCommit: COMMIT_A, workflowId: 'proxy-unack' });
      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('LP-PLAN-BLOCKED');
      expect(transport.calls().some((entry) => entry.method === 'POST' && entry.url.endsWith('/dns_records'))).toBe(false);
      return { observed: 'plan BLOCKED (dns.proxyAcknowledgment); apply stopped before any DNS write' };
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Health scenarios (plan sections 13.6/47, 33)
// ---------------------------------------------------------------------------

it('HEALTH-EXPECTED: expected status and body pass the health check', async () => {
  await scenario('HEALTH-EXPECTED', async () => {
    const record = await checkHealth({
      applicationId: ACCEPTANCE_APP_ID,
      environment: 'production',
      deploymentId: 'dpl_candidate_1',
      baseUrl: 'https://acceptance.example.com',
      spec: { path: '/api/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 2, attempts: 1, intervalSeconds: 0, body: { contains: 'ok' } },
      fetchImpl: healthServer([{ url: 'https://acceptance.example.com', status: 200, body: '{"status":"ok"}' }]),
      dnsResolve: async () => undefined,
      sleep: NOOP_SLEEP,
    });
    expect(record.result).toBe('PASSED');
    expect(record.statusCode).toBe(200);
    expect(record.assertionResults.every((assertion) => assertion.passed)).toBe(true);
    return { observed: `health PASSED (HTTP ${record.statusCode}, body assertion passed)` };
  });
});

it('HEALTH-WRONG: wrong status or body fails the health check with typed assertions', async () => {
  await scenario('HEALTH-WRONG', async () => {
    const spec = { path: '/api/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 2, attempts: 1, intervalSeconds: 0, body: { contains: 'ok' } };
    const wrongStatus = await checkHealth({
      applicationId: ACCEPTANCE_APP_ID,
      environment: 'production',
      deploymentId: 'dpl_candidate_1',
      baseUrl: 'https://acceptance.example.com',
      spec,
      fetchImpl: healthServer([{ url: 'https://acceptance.example.com', status: 503, body: 'unavailable' }]),
      dnsResolve: async () => undefined,
      sleep: NOOP_SLEEP,
    });
    expect(wrongStatus.result).toBe('FAILED');
    expect(wrongStatus.statusCode).toBe(503);
    expect(wrongStatus.assertionResults.find((assertion) => assertion.name === 'status')?.passed).toBe(false);
    expect(wrongStatus.assertionResults.find((assertion) => assertion.name === 'body-contains')?.passed).toBe(false);

    const wrongBody = await checkHealth({
      applicationId: ACCEPTANCE_APP_ID,
      environment: 'production',
      deploymentId: 'dpl_candidate_1',
      baseUrl: 'https://acceptance.example.com',
      spec,
      fetchImpl: healthServer([{ url: 'https://acceptance.example.com', status: 200, body: '{"status":"degraded"}' }]),
      dnsResolve: async () => undefined,
      sleep: NOOP_SLEEP,
    });
    expect(wrongBody.result).toBe('FAILED');
    expect(wrongBody.statusCode).toBe(200);
    expect(wrongBody.assertionResults.find((assertion) => assertion.name === 'body-contains')?.passed).toBe(false);
    return { observed: 'wrong status (503) and wrong body both fail with typed assertion results' };
  });
});

it('HEALTH-CANDIDATE-BLOCKS-PROMOTION: an unhealthy staged candidate is never promoted', async () => {
  await scenario('HEALTH-CANDIDATE-BLOCKS-PROMOTION', async () => {
    const harness = createD1Store(fixedNow);
    try {
      await seedApplication(harness.store);
      const desired = acceptanceManifest();
      const transport = applyTransport();
      const provider = compositeFor(transport);
      const { plan, observed } = await planFor(harness.store, provider, desired, COMMIT_A, 1, NOW);
      const result = await runApply(harness.store, provider, desired, plan, observed, {
        sourceCommit: COMMIT_A,
        workflowId: 'apply-unhealthy-candidate',
        fetchImpl: healthServer([{ url: 'https://acceptance-app.vercel.sandbox.test', status: 500, body: 'boom' }]),
      });
      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('LP-HEALTH-CANDIDATE-FAILED');
      expect(transport.calls((entry) => entry.exchangeId === 'vercel.promote')).toHaveLength(0);
      const promotions = await harness.store.listPromotions(ACCEPTANCE_APP_ID);
      expect(promotions).toHaveLength(0);
      return {
        observed: 'LP-HEALTH-CANDIDATE-FAILED stops apply before promotion; no promote call, no promotion row',
        resourceIds: { deployment: 'dpl_candidate_1' },
        evidence: logEvidence(transport, { promotions: promotions.length }),
      };
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Promotion scenarios (plan sections 13.6/47, 33)
// ---------------------------------------------------------------------------

it('PROMO-EXACT: the exact candidate is promoted, recorded known-good, and locks are released', async () => {
  await scenario('PROMO-EXACT', async () => {
    const state = await appliedState();
    try {
      const { store, transport } = state;
      const deployments = await store.listDeployments(ACCEPTANCE_APP_ID);
      const candidate = deployments.find((deployment) => deployment.state === 'CURRENT');
      expect(candidate).toBeDefined();
      expect(candidate?.commitSha).toBe(COMMIT_A);
      expect(candidate?.id).toBe('dpl_candidate_1');
      const knownGood = await store.getKnownGoodDeployment(ACCEPTANCE_APP_ID, 'production');
      expect(knownGood?.id).toBe('dpl_candidate_1');
      const promotions = await store.listPromotions(ACCEPTANCE_APP_ID);
      expect(promotions[0]?.result).toBe('PROMOTED');
      expect(await store.getLock(`application:${ACCEPTANCE_APP_ID}`)).toBeNull();
      expect(await store.getLock(`domain:${ACCEPTANCE_DOMAIN}`)).toBeNull();
      const application = await store.getApplication(ACCEPTANCE_APP_ID);
      expect(application?.syncStatus).toBe('SYNCED');
      expect(application?.healthStatus).toBe('HEALTHY');
      expect(transport.calls((entry) => entry.exchangeId === 'vercel.promote')).toHaveLength(1);

      // The Vercel domain-verification and TLS-readiness gates ran (never
      // skipped): the domain attach is followed by an unverified readback,
      // the verify POST flips it verified, the post-verify readback observes
      // VERIFIED, the certs read proves READY, and only then is the candidate
      // created and promoted.
      expect(transport.calls((entry) => entry.exchangeId === 'vercel.domain.get.unverified')).toHaveLength(2);
      expect(transport.calls((entry) => entry.exchangeId === 'vercel.domain.verify')).toHaveLength(1);
      expect(transport.calls((entry) => entry.exchangeId === 'vercel.domain.get.verified')).toHaveLength(1);
      expect(transport.calls((entry) => entry.exchangeId === 'vercel.certs.get')).toHaveLength(1);
      const applyOrder = transport.calls().filter((entry) => entry.exchangeId !== null).map((entry) => entry.exchangeId);
      const verifyIndex = applyOrder.indexOf('vercel.domain.verify');
      expect(applyOrder.indexOf('vercel.domain.get.unverified')).toBeLessThan(verifyIndex);
      expect(applyOrder.indexOf('vercel.domain.get.verified')).toBeGreaterThan(verifyIndex);
      expect(applyOrder.indexOf('vercel.certs.get')).toBeGreaterThan(applyOrder.indexOf('vercel.domain.get.verified'));
      expect(applyOrder.indexOf('vercel.deployment.create')).toBeGreaterThan(applyOrder.indexOf('vercel.certs.get'));
      expect(applyOrder.indexOf('vercel.promote')).toBeGreaterThan(applyOrder.indexOf('vercel.deployment.create'));
      return {
        observed: `candidate ${candidate?.id} promoted exactly (commit ${candidate?.commitSha}) after verify-vercel-domain (${verifyIndex >= 0 ? 'verify POST ran' : 'verify POST MISSING'}) and verify-tls (certs READY); known-good recorded, locks released`,
        resourceIds: { deployment: 'dpl_candidate_1' },
        evidence: logEvidence(transport, {
          promoted: promotions[0]?.result,
          domainVerifyCalls: transport.calls((entry) => entry.exchangeId === 'vercel.domain.verify').length,
          tlsCalls: transport.calls((entry) => entry.exchangeId === 'vercel.certs.get').length,
          applyOrder,
        }),
      };
    } finally {
      state.close();
    }
  });
});

it('PROMO-STALE-PLAN: provider state changed after approval stops apply before any write', async () => {
  await scenario('PROMO-STALE-PLAN', async () => {
    const harness = createD1Store(fixedNow);
    try {
      await seedApplication(harness.store);
      const desired = acceptanceManifest();
      const freshTransport = applyTransport();
      const freshProvider = compositeFor(freshTransport);
      const { plan, observed } = await planFor(harness.store, freshProvider, desired, COMMIT_A, 1, NOW);

      // Provider state changed after the plan was approved: the project now exists drifted.
      const driftedTransport = applyTransport({ project: recordedProject({ rootDirectory: 'apps/changed' }), project404Times: 0 });
      const driftedProvider = compositeFor(driftedTransport);
      const result = await runApply(harness.store, driftedProvider, desired, plan, observed, { sourceCommit: COMMIT_A, workflowId: 'apply-stale' });
      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('LP-PLAN-STALE');
      expect(driftedTransport.writes()).toHaveLength(0);
      return {
        observed: 'LP-PLAN-STALE stops apply; zero provider writes on the drifted transport',
        evidence: logEvidence(driftedTransport, { writes: driftedTransport.writes().length }),
      };
    } finally {
      harness.close();
    }
  });
});

it('PROMO-COMMIT-MISMATCH: a candidate whose commit differs from the approved commit is rejected', async () => {
  await scenario('PROMO-COMMIT-MISMATCH', async () => {
    const transport = new RecordedSandboxTransport([]);
    const adapter = new VercelAdapter({ token: 'lp-sandbox-token', teamId: 'team_acceptance', baseUrl: 'https://vercel.sandbox.test', fetchImpl: transport.fetchImpl });
    // The candidate targets a different commit than the approved plan commit.
    // Exact-commit promotion is enforced in the caller (promoteProduction)
    // against the candidate it health-gated: refused before any provider write.
    const candidate = {
      id: 'dpl_evil', projectId: ACCEPTANCE_APP_ID, environment: 'production' as const, repository: ACCEPTANCE_REPOSITORY,
      commitSha: commitSha('f'), desiredGeneration: 1, state: 'READY' as const, url: 'https://acceptance-app.vercel.sandbox.test', createdAt: NOW,
    };
    await expect(promoteProduction({ provider: adapter, projectId: ACCEPTANCE_APP_ID, candidate, expectedCommitSha: COMMIT_A, context: acceptanceContext('promo-mismatch') })).rejects.toMatchObject({
      message: 'LP-PROMOTION-COMMIT-MISMATCH',
    });
    expect(transport.calls()).toHaveLength(0);
    return { observed: 'LP-PROMOTION-COMMIT-MISMATCH rejects the mismatched candidate before any provider write', evidence: logEvidence(transport) };
  });
});

// ---------------------------------------------------------------------------
// Rollback scenarios (plan sections 13.6/47, 33, 11)
// ---------------------------------------------------------------------------

it('RB-KNOWN-GOOD: post-promotion health failure restores the previous known-good deployment', async () => {
  await scenario('RB-KNOWN-GOOD', async () => {
    const harness = createD1Store(fixedNow);
    try {
      await seedApplication(harness.store);
      const desired = acceptanceManifest();

      // First apply succeeds and records the known-good deployment.
      const firstTransport = applyTransport();
      const firstProvider = compositeFor(firstTransport);
      const firstPlan = await planFor(harness.store, firstProvider, desired, COMMIT_A, 1, NOW);
      const first = await runApply(harness.store, firstProvider, desired, firstPlan.plan, firstPlan.observed, { sourceCommit: COMMIT_A, workflowId: 'apply-rollback-1' });
      expect(first.status, `first apply failed: ${first.errorCode ?? 'unknown'}`).toBe('SUCCEEDED');
      await harness.store.advanceDesiredGeneration({ applicationId: ACCEPTANCE_APP_ID, generation: 2, desiredHash: firstPlan.plan.fingerprint });

      // Second apply: promotion succeeds, production health fails → rollback to known-good.
      const secondTransport = applyTransport({ deploymentId: 'dpl_candidate_2', promoteDeploymentId: 'dpl_candidate_2', includeRollback: true, project404Times: 0, dnsAbsentTimes: 0, dnsPresentTimes: 5, commit: COMMIT_B, generation: 2 });
      const secondProvider = compositeFor(secondTransport);
      const secondPlan = await planFor(harness.store, secondProvider, desired, COMMIT_B, 2, NOW);
      const second = await runApply(harness.store, secondProvider, desired, secondPlan.plan, secondPlan.observed, {
        sourceCommit: COMMIT_B,
        workflowId: 'apply-rollback-2',
        fetchImpl: healthServer([
          { url: 'https://acceptance-app.vercel.sandbox.test', status: 200, body: '{"status":"ok"}' },
          { url: 'https://acceptance.example.com', status: 500, body: 'degraded' },
        ]),
      });
      expect(second.status).toBe('FAILED');
      expect(second.errorCode).toBe('LP-HEALTH-PRODUCTION-FAILED');
      expect(second.rollback).toMatchObject({ deploymentId: 'dpl_candidate_1', restored: true });
      const knownGood = await harness.store.getKnownGoodDeployment(ACCEPTANCE_APP_ID, 'production');
      expect(knownGood?.id).toBe('dpl_candidate_1');
      const promotions = await harness.store.listPromotions(ACCEPTANCE_APP_ID);
      expect(promotions.some((promotion) => promotion.result === 'ROLLED_BACK' && promotion.previousDeploymentId === 'dpl_candidate_2')).toBe(true);
      const application = await harness.store.getApplication(ACCEPTANCE_APP_ID);
      expect(application?.syncStatus).toBe('RECONCILING');
      expect(application?.healthStatus).toBe('DEGRADED');
      const rollbackCalls = secondTransport.calls((entry) => entry.exchangeId === 'vercel.rollback' && entry.url.includes('/rollback/dpl_candidate_1'));
      expect(rollbackCalls).toHaveLength(1);
      return {
        observed: 'production health failure rolled back to known-good dpl_candidate_1; release left red (RECONCILING/DEGRADED)',
        resourceIds: { knownGood: 'dpl_candidate_1', failedCandidate: 'dpl_candidate_2' },
        evidence: logEvidence(secondTransport, { promotions: promotions.map((promotion) => promotion.result) }),
      };
    } finally {
      harness.close();
    }
  });
});

it('RB-NO-KNOWN-GOOD: without a known-good deployment, rollback is refused and the failure is visible', async () => {
  await scenario('RB-NO-KNOWN-GOOD', async () => {
    const harness = createD1Store(fixedNow);
    try {
      await seedApplication(harness.store);
      const desired = acceptanceManifest();
      const transport = applyTransport();
      const provider = compositeFor(transport);
      const { plan, observed } = await planFor(harness.store, provider, desired, COMMIT_A, 1, NOW);
      const result = await runApply(harness.store, provider, desired, plan, observed, {
        sourceCommit: COMMIT_A,
        workflowId: 'apply-no-known-good',
        fetchImpl: healthServer([
          { url: 'https://acceptance-app.vercel.sandbox.test', status: 200, body: '{"status":"ok"}' },
          { url: 'https://acceptance.example.com', status: 500, body: 'degraded' },
        ]),
      });
      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('LP-HEALTH-PRODUCTION-FAILED');
      expect(result.rollback).toBeNull();
      expect(await harness.store.getKnownGoodDeployment(ACCEPTANCE_APP_ID, 'production')).toBeNull();
      expect(transport.calls((entry) => entry.body !== null && typeof entry.body === 'object' && 'rollbackFrom' in (entry.body as Record<string, unknown>))).toHaveLength(0);
      const audits = await harness.store.listAudit(ACCEPTANCE_APP_ID);
      const failedAudit = audits.find((event) => event.action === 'APPLY_FAILED');
      expect(failedAudit).toBeDefined();
      expect((failedAudit?.details as Record<string, unknown> | null)?.rollback).toBeNull();
      return {
        observed: 'no known-good → rollback refused, APPLY_FAILED audit visible, no rollbackFrom call',
        evidence: logEvidence(transport, { auditAction: failedAudit?.action }),
      };
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Drift and reconciliation scenarios (plan sections 13.8/47, 33, 11)
// ---------------------------------------------------------------------------

function controlRepositoryTransport(manifestContent: string): RecordedSandboxTransport {
  return new RecordedSandboxTransport([
    // Prefix matching: the bare repo route would shadow every more specific
    // GET on /repos/acme/control/* (contents, refs, pulls), so the specific
    // routes are recorded first and the bare repo route last.
    { id: 'control.ref.main', method: 'GET', url: 'https://github.sandbox.test/repos/acme/control/git/ref/heads/main', json: { object: { sha: MAIN_SHA } } },
    { id: 'control.manifest.read', method: 'GET', url: /\/repos\/acme\/control\/contents\/catalog%2Fapps%2Facceptance-app\.yaml\?ref=[0-9a-f]{40}$/, json: githubFileContent(manifestContent) },
    { id: 'control.branch.file.404', method: 'GET', url: /\/contents\/[^?]+\?ref=reconcile/, status: 404, json: { error: { message: 'Not Found' } }, times: 1 },
    { id: 'control.branch.file', method: 'GET', url: /\/contents\/[^?]+\?ref=reconcile/, json: { type: 'file', sha: 'branch_sha', encoding: 'base64', content: Buffer.from(manifestContent).toString('base64') } },
    { id: 'control.pulls.empty', method: 'GET', url: /\/repos\/acme\/control\/pulls\?state=open/, json: [], times: 1 },
    { id: 'control.pulls.open', method: 'GET', url: /\/repos\/acme\/control\/pulls\?state=open/, json: [{ number: 7, html_url: 'https://github.sandbox.test/acme/control/pull/7' }] },
    { id: 'control.repo.get', method: 'GET', url: 'https://github.sandbox.test/repos/acme/control', json: { id: 1, archived: false, private: true, default_branch: 'main' } },
    { id: 'control.branch.create', method: 'POST', url: 'https://github.sandbox.test/repos/acme/control/git/refs', json: {}, times: 1 },
    { id: 'control.branch.exists', method: 'POST', url: 'https://github.sandbox.test/repos/acme/control/git/refs', status: 409, json: { error: { message: 'Reference already exists' } } },
    { id: 'control.manifest.put', method: 'PUT', url: /\/repos\/acme\/control\/contents\/catalog%2Fapps%2Facceptance-app\.yaml$/, json: { content: {} } },
    { id: 'control.request.put', method: 'PUT', url: /\/repos\/acme\/control\/contents\/reconciliation%2Facceptance-app\.yaml$/, json: { content: {} } },
    { id: 'control.pull.create', method: 'POST', url: 'https://github.sandbox.test/repos/acme/control/pulls', json: { number: 7, html_url: 'https://github.sandbox.test/acme/control/pull/7' }, times: 1 },
    { id: 'control.pull.update', method: 'PATCH', url: 'https://github.sandbox.test/repos/acme/control/pulls/7', json: { number: 7, html_url: 'https://github.sandbox.test/acme/control/pull/7' } },
  ]);
}

function reconcileRun(
  store: Awaited<ReturnType<typeof createD1Store>>['store'],
  provider: CompositeProvider,
  github: GitHubAdapter,
  sourceCommit: string | null,
  triggeredAt: string,
): ReturnType<typeof runReconcileWorkflow> {
  return runReconcileWorkflow({
    store,
    provider,
    source: github,
    controlRepository: ACCEPTANCE_CONTROL_REPOSITORY,
    manifestPath: ACCEPTANCE_MANIFEST_PATH,
    applicationId: ACCEPTANCE_APP_ID,
    sourceCommit,
    mode: 'open-pr',
    triggeredAt,
    context: acceptanceContext('reconcile-run'),
    now: NOW,
  });
}

it('REC-DRIFT-PR: manual drift opens exactly one reviewable reconciliation PR per fingerprint', async () => {
  await scenario('REC-DRIFT-PR', async () => {
    const state = await appliedState();
    try {
      const { store } = state;
      const manifest = manifestYaml(acceptanceManifest());
      const githubTransport = controlRepositoryTransport(manifest);
      const github = new GitHubAdapter({ token: 'lp-sandbox-token', baseUrl: 'https://github.sandbox.test', fetchImpl: githubTransport.fetchImpl });

      const driftedTransport = applyTransport({ project: recordedProject({ rootDirectory: 'apps/drifted' }), project404Times: 0, dnsAbsentTimes: 0 });
      const driftedProvider = compositeFor(driftedTransport);

      const first = await reconcileRun(store, driftedProvider, github, MAIN_SHA, '2026-08-04T00:30:00.000Z');
      expect(first.status, `reconcile failed: ${first.errorCode ?? 'unknown'} at ${first.failedStep ?? '?'}`).toBe('SUCCEEDED');
      expect(first.result?.status).toBe('OUT_OF_SYNC');
      expect(first.result?.drift.some((record) => record.resourceKey === 'vercel.project')).toBe(true);
      expect(first.result?.driftFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(first.result?.pullRequest).toMatchObject({ number: 7 });
      expect(first.result?.operation).toBe('restore-desired-state');
      const fingerprint = first.result?.driftFingerprint;
      expect(fingerprint).not.toBeNull();

      // Second scheduled check with the same drift: same fingerprint, PR updated, not duplicated.
      const second = await reconcileRun(store, driftedProvider, github, MAIN_SHA, '2026-08-04T01:00:00.000Z');
      expect(second.status, `second reconcile failed: ${second.errorCode ?? 'unknown'}`).toBe('SUCCEEDED');
      expect(second.result?.status).toBe('OUT_OF_SYNC');
      expect(second.result?.driftFingerprint).toBe(fingerprint);
      expect(githubTransport.calls((entry) => entry.exchangeId === 'control.pull.create')).toHaveLength(1);
      expect(githubTransport.calls((entry) => entry.exchangeId === 'control.pull.update')).toHaveLength(1);
      const requests = await store.listReconciliationRequests(ACCEPTANCE_APP_ID);
      expect(requests.filter((request) => request.status === 'OPEN')).toHaveLength(1);
      const events = await store.listDriftEvents(ACCEPTANCE_APP_ID, { includeResolved: false });
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events.every((event) => event.category === 'OUT_OF_SYNC' && event.fingerprint === fingerprint)).toBe(true);
      const application = await store.getApplication(ACCEPTANCE_APP_ID);
      expect(application?.syncStatus).toBe('OUT_OF_SYNC');
      return {
        observed: `OUT_OF_SYNC with stable fingerprint ${fingerprint?.slice(0, 12)}…; one PR (#7), one open request, one open drift event`,
        resourceIds: { pullRequest: '7' },
        evidence: logEvidence(githubTransport, { driftFingerprint: fingerprint, pullRequestsCreated: 1, pullRequestsUpdated: 1 }),
      };
    } finally {
      state.close();
    }
  });
});

it('REC-SYNCED-RESTORE: restoring drift returns SYNCED and resolves the drift event and request', async () => {
  await scenario('REC-SYNCED-RESTORE', async () => {
    const state = await appliedState();
    try {
      const { store } = state;
      const manifest = manifestYaml(acceptanceManifest());

      // Introduce drift first so there is something to restore.
      const driftedTransport = applyTransport({ project: recordedProject({ rootDirectory: 'apps/drifted' }), project404Times: 0, dnsAbsentTimes: 0 });
      const githubTransport = controlRepositoryTransport(manifest);
      const github = new GitHubAdapter({ token: 'lp-sandbox-token', baseUrl: 'https://github.sandbox.test', fetchImpl: githubTransport.fetchImpl });
      const drift = await reconcileRun(store, compositeFor(driftedTransport), github, MAIN_SHA, '2026-08-04T00:30:00.000Z');
      expect(drift.result?.status).toBe('OUT_OF_SYNC');

      // The provider state converges back to the manifest (drift restored).
      const restoredTransport = applyTransport({ project404Times: 0, dnsAbsentTimes: 0 });
      const restored = await reconcileRun(store, compositeFor(restoredTransport), github, MAIN_SHA, '2026-08-04T02:00:00.000Z');
      expect(restored.status, `restore reconcile failed: ${restored.errorCode ?? 'unknown'}`).toBe('SUCCEEDED');
      expect(restored.result?.status).toBe('SYNCED');
      expect(restored.result?.pullRequest).toBeNull();
      expect(await store.listDriftEvents(ACCEPTANCE_APP_ID, { includeResolved: false })).toHaveLength(0);
      const requests = await store.listReconciliationRequests(ACCEPTANCE_APP_ID);
      expect(requests.every((request) => request.status === 'SUPERSEDED')).toBe(true);
      const application = await store.getApplication(ACCEPTANCE_APP_ID);
      expect(application?.syncStatus).toBe('SYNCED');
      return {
        observed: 'drift restored → SYNCED; drift events resolved; reconciliation requests superseded',
        evidence: logEvidence(restoredTransport, { requests: requests.map((request) => request.status) }),
      };
    } finally {
      state.close();
    }
  });
});

it('REC-UNKNOWN-OUTAGE: provider read failure reports UNKNOWN, never SYNCED', async () => {
  await scenario('REC-UNKNOWN-OUTAGE', async () => {
    const state = await appliedState();
    try {
      const { store } = state;
      const manifest = manifestYaml(acceptanceManifest());
      const githubTransport = new RecordedSandboxTransport([
        { id: 'control.manifest.read', method: 'GET', url: /\/repos\/acme\/control\/contents\/catalog%2Fapps%2Facceptance-app\.yaml\?ref=[0-9a-f]{40}$/, json: githubFileContent(manifest) },
      ]);
      const github = new GitHubAdapter({ token: 'lp-sandbox-token', baseUrl: 'https://github.sandbox.test', fetchImpl: githubTransport.fetchImpl });
      const outageTransport = new RecordedSandboxTransport([
        { id: 'outage.project.get', method: 'GET', url: `https://vercel.sandbox.test/v9/projects/${ACCEPTANCE_APP_ID}`, status: 500, json: { error: { message: 'upstream outage' } } },
        { id: 'outage.zone.get', method: 'GET', url: 'https://cloudflare.sandbox.test/zones?name=acceptance.test', json: cfEnvelope([recordedZone()]) },
        { id: 'outage.record.list', method: 'GET', url: /dns_records\?name=acceptance\.example\.com(?:&type=CNAME)?$/, json: cfEnvelope([]) },
      ]);
      const result = await reconcileRun(store, compositeFor(outageTransport), github, MAIN_SHA, '2026-08-04T00:30:00.000Z');
      expect(result.status, `reconcile failed: ${result.errorCode ?? 'unknown'}`).toBe('SUCCEEDED');
      expect(result.result?.status).toBe('UNKNOWN');
      expect(result.result?.accessErrors.some((error) => error.provider === 'vercel')).toBe(true);
      const application = await store.getApplication(ACCEPTANCE_APP_ID);
      expect(application?.syncStatus).toBe('UNKNOWN');
      const events = await store.listDriftEvents(ACCEPTANCE_APP_ID, { includeResolved: false });
      expect(events[0]?.category).toBe('UNKNOWN');
      return {
        observed: `provider outage → UNKNOWN (${result.result?.accessErrors[0]?.code ?? 'access error'}), never SYNCED`,
        evidence: logEvidence(outageTransport, { accessErrors: result.result?.accessErrors }),
      };
    } finally {
      state.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Deletion scenarios (plan sections 13.10/47, 33, 11)
// ---------------------------------------------------------------------------

it('DEL-MISSING-MANIFEST: manifest removal produces BLOCKED_MISSING_MANIFEST and deletes nothing', async () => {
  await scenario('DEL-MISSING-MANIFEST', async () => {
    const transport = new RecordedSandboxTransport([
      { id: 'control.manifest.missing', method: 'GET', url: /\/repos\/acme\/control\/contents\/catalog%2Fapps%2Facceptance-app\.yaml\?ref=[0-9a-f]{40}$/, status: 404, json: { error: { message: 'Not Found' } } },
    ]);
    const github = new GitHubAdapter({ token: 'lp-sandbox-token', baseUrl: 'https://github.sandbox.test', fetchImpl: transport.fetchImpl });
    const base = await makeApplyBase({
      applicationId: ACCEPTANCE_APP_ID,
      sourceCommit: COMMIT_A,
      planFingerprint: 'fp',
      desiredGeneration: 1,
      idempotencyKey: 'apply-missing-manifest',
      workflowId: 'apply-missing-manifest',
    });
    await expect(applyLoadDesired({ base, source: github, controlRepository: ACCEPTANCE_CONTROL_REPOSITORY, manifestPath: ACCEPTANCE_MANIFEST_PATH, context: acceptanceContext('missing-manifest') })).rejects.toMatchObject({ name: 'BLOCKED_MISSING_MANIFEST' });
    expect(transport.writes()).toHaveLength(0);
    return { observed: 'BLOCKED_MISSING_MANIFEST before any provider write', evidence: logEvidence(transport) };
  });
});

it('DEL-NORMAL-APPLY-BLOCKS-DESTROY: normal apply refuses a DESTROY plan before the first provider write', async () => {
  await scenario('DEL-NORMAL-APPLY-BLOCKS-DESTROY', async () => {
    const harness = createD1Store(fixedNow);
    try {
      await seedApplication(harness.store);
      const desired = acceptanceManifest();
      const transport = applyTransport({ project404Times: 0, dnsAbsentTimes: 0, dnsRecord: recordedDnsRecord({ comment: `launchpad:${DNS_OWNERSHIP}` }) });
      const provider = compositeFor(transport);
      const live = await applyObserveLiveState({
        base: await makeApplyBase({ applicationId: ACCEPTANCE_APP_ID, sourceCommit: COMMIT_A, planFingerprint: 'pending', desiredGeneration: 1, idempotencyKey: 'apply-destroy', workflowId: 'apply-destroy' }),
        store: harness.store,
        provider,
        desired,
        context: acceptanceContext('apply-destroy'),
      });
      const approved: DesiredApplication = {
        ...desired,
        lifecycle: {
          state: 'approved-for-deletion',
          deletionProtection: false,
          orphanPolicy: 'retain',
          decommission: { requestedAt: '2026-07-01T00:00:00.000Z', deleteAfter: '2026-07-02T00:00:00.000Z', approvalToken: 'approved', preserveDeployments: false },
          recoveryPolicy: { allowReactivateBeforeDeletionApproval: false },
        },
      };
      const destructive = await buildPlan({
        desired: approved,
        observed: live.observed,
        capabilities: live.capabilities,
        sourceCommit: COMMIT_A,
        desiredGeneration: 1,
        ownership: await ownershipFromStore(harness.store),
        mode: 'apply',
        now: NOW,
      });
      expect(destructive.result).toBe('DESTRUCTIVE');
      // The dedicated boundary refuses the destructive plan outright.
      await expect(applyNoDestroyGate({ plan: destructive })).rejects.toMatchObject({ name: 'LP-DESTROY-NORMAL-APPLY-BLOCKED' });
      const result = await runApply(harness.store, provider, approved, destructive, live.observed, { sourceCommit: COMMIT_A, workflowId: 'apply-destroy' });
      expect(result.status).toBe('FAILED');
      // The composed machine refuses the DESTRUCTIVE plan at its earliest
      // gate (validate-request: LP-PLAN-BLOCKED) before any provider write;
      // a DESTRUCTIVE plan is never executed by normal apply.
      expect(['LP-PLAN-BLOCKED', 'LP-DESTROY-NORMAL-APPLY-BLOCKED']).toContain(result.errorCode);
      expect(transport.writes()).toHaveLength(0);
      return {
        observed: 'DESTRUCTIVE plan is refused by normal apply (LP-DESTROY-NORMAL-APPLY-BLOCKED) with zero provider writes',
        evidence: logEvidence(transport, { planResult: destructive.result }),
      };
    } finally {
      harness.close();
    }
  });
});

it('DEL-APPROVAL-TOKEN: approvals are random, single-use, and only SHA-256 fingerprints are persisted', async () => {
  await scenario('DEL-APPROVAL-TOKEN', async () => {
    const harness = createD1Store(fixedNow);
    try {
      await seedApplication(harness.store);
      const issued = await issueDeletionApproval({
        store: harness.store,
        binding: { applicationId: ACCEPTANCE_APP_ID, domain: ACCEPTANCE_DOMAIN, sourceCommit: COMMIT_A, actor: 'e2e-operator', expiresAt: '2026-08-10T00:00:00.000Z' },
        now: NOW,
      });
      expect(issued.token).toMatch(/^[0-9a-f]{64}$/);
      const approvals = await harness.store.listDeletionApprovals(ACCEPTANCE_APP_ID);
      expect(approvals).toHaveLength(1);
      const stored = approvals[0];
      expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored?.tokenHash).not.toBe(issued.token);
      expect(JSON.stringify(await harness.store.listAudit(ACCEPTANCE_APP_ID))).not.toContain(issued.token);
      // Wrong token never consumes the approval.
      await expect(consumeDeletionApproval({ store: harness.store, approvalId: issued.approvalId, binding: { applicationId: ACCEPTANCE_APP_ID, domain: ACCEPTANCE_DOMAIN, sourceCommit: COMMIT_A, actor: 'e2e-operator' }, token: 'f'.repeat(64), now: NOW })).rejects.toThrow();
      expect((await harness.store.listDeletionApprovals(ACCEPTANCE_APP_ID))[0]?.status).toBe('PENDING');
      // Single use: consuming twice fails.
      const consumed = await consumeDeletionApproval({ store: harness.store, approvalId: issued.approvalId, binding: { applicationId: ACCEPTANCE_APP_ID, domain: ACCEPTANCE_DOMAIN, sourceCommit: COMMIT_A, actor: 'e2e-operator' }, token: issued.token, now: NOW });
      expect(consumed.approvalId).toBe(issued.approvalId);
      expect((await harness.store.listDeletionApprovals(ACCEPTANCE_APP_ID))[0]?.status).toBe('USED');
      await expect(consumeDeletionApproval({ store: harness.store, approvalId: issued.approvalId, binding: { applicationId: ACCEPTANCE_APP_ID, domain: ACCEPTANCE_DOMAIN, sourceCommit: COMMIT_A, actor: 'e2e-operator' }, token: issued.token, now: NOW })).rejects.toMatchObject({ name: 'LP-DESTROY-APPROVAL-USED' });
      return {
        observed: 'approval issued as 64-hex single-use token; only the SHA-256 fingerprint persisted; reuse refused',
        resourceIds: { approval: issued.approvalId },
        evidence: { tokenLength: issued.token.length, statusAfterFirstConsume: stored?.status },
      };
    } finally {
      harness.close();
    }
  });
});

function approvedManifestYaml(): string {
  const approved: DesiredApplication = {
    ...acceptanceManifest({ domainMode: 'proxied' }),
    lifecycle: {
      state: 'approved-for-deletion',
      deletionProtection: false,
      orphanPolicy: 'retain',
      decommission: { requestedAt: '2026-07-01T00:00:00.000Z', deleteAfter: '2026-07-02T00:00:00.000Z', approvalToken: null, preserveDeployments: false },
      recoveryPolicy: { allowReactivateBeforeDeletionApproval: false },
    },
  };
  return manifestYaml(approved);
}

/**
 * Decommission transport: approved manifest reads, proxied record teardown,
 * Vercel domain unassign (removeDomain), owned DNS delete, deployment delete
 * (deleteDeployment), project delete, inactive statuses. The first project
 * observation carries the production domain so the unassign step actually
 * detaches it (removeDomain); every later observation serves the detached
 * project so the readback never reports the domain as still assigned.
 */
function decommissionTransport(approvedYaml: string, options: { dnsOnlyTimes?: number; byidTimes?: number } = {}): { transport: RecordedSandboxTransport; github: RecordedSandboxTransport } {
  const transport = new RecordedSandboxTransport([
    { id: 'decom.zone.get', method: 'GET', url: 'https://cloudflare.sandbox.test/zones?name=acceptance.test', json: cfEnvelope([recordedZone()]) },
    {
      // Proxy-off observes the proxied record twice (step read + ensureRecord's
      // pre-mutation read); every later list observation (ensureRecord
      // postcondition, proxy-off readback, delete-owned observe) serves the
      // dns-only record.
      id: 'decom.record.proxied', method: 'GET', url: /dns_records\?name=acceptance\.example\.com(?:&type=CNAME)?$/,
      json: cfEnvelope([recordedDnsRecord({ proxied: true, comment: `launchpad:${DNS_OWNERSHIP}` })]), times: 2,
    },
    { id: 'decom.domain.config', method: 'GET', url: 'https://vercel.sandbox.test/v6/domains/acceptance.example.com/config', json: { recommendedCNAME: [{ rank: 1, value: [DNS_TARGET] }] } },
    { id: 'decom.record.proxyoff', method: 'PUT', url: 'https://cloudflare.sandbox.test/zones/zone_acceptance_1/dns_records/dns_acceptance_1', json: cfEnvelope(recordedDnsRecord({ proxied: false, comment: `launchpad:${DNS_OWNERSHIP}` })) },
    {
      id: 'decom.record.dns-only', method: 'GET', url: /dns_records\?name=acceptance\.example\.com(?:&type=CNAME)?$/,
      json: cfEnvelope([recordedDnsRecord({ proxied: false, comment: `launchpad:${DNS_OWNERSHIP}` })]), times: options.dnsOnlyTimes ?? 5,
    },
    {
      // deleteRecord verifies ownership by id before the DELETE; the second
      // by-id observation (postcondition) serves 404 from the entry below.
      id: 'decom.record.byid', method: 'GET', url: 'https://cloudflare.sandbox.test/zones/zone_acceptance_1/dns_records/dns_acceptance_1',
      json: cfEnvelope(recordedDnsRecord({ proxied: false, comment: `launchpad:${DNS_OWNERSHIP}` })), times: options.byidTimes ?? 2,
    },
    { id: 'decom.record.delete', method: 'DELETE', url: 'https://cloudflare.sandbox.test/zones/zone_acceptance_1/dns_records/dns_acceptance_1', json: cfEnvelope({ id: 'dns_acceptance_1' }) },
    { id: 'decom.record.byid.404', method: 'GET', url: 'https://cloudflare.sandbox.test/zones/zone_acceptance_1/dns_records/dns_acceptance_1', status: 404, json: { success: false, errors: [{ code: 9109 }], messages: [], result: null } },
    { id: 'decom.record.list.empty', method: 'GET', url: /dns_records\?name=acceptance\.example\.com(?:&type=CNAME)?$/, json: cfEnvelope([]) },
    // The unassign step's first observation must still list the production
    // domain (assigned) or removeDomain would be skipped as 'not assigned';
    // the readback after the DELETE serves the detached project.
    { id: 'decom.project.get.assigned', method: 'GET', url: `https://vercel.sandbox.test/v9/projects/${ACCEPTANCE_APP_ID}`, json: recordedProject({ domains: [ACCEPTANCE_DOMAIN] }), times: 1 },
    { id: 'decom.domain.remove', method: 'DELETE', url: `https://vercel.sandbox.test/v9/projects/${ACCEPTANCE_APP_ID}/domains/${ACCEPTANCE_DOMAIN}`, json: {} },
    { id: 'decom.project.get', method: 'GET', url: `https://vercel.sandbox.test/v9/projects/${ACCEPTANCE_APP_ID}`, json: recordedProject(), times: 2 },
    { id: 'decom.project.delete', method: 'DELETE', url: 'https://vercel.sandbox.test/v9/projects/prj_acceptance', json: {} },
    { id: 'decom.deployment.delete', method: 'DELETE', url: 'https://vercel.sandbox.test/v13/deployments/dpl_candidate_1', json: {} },
    { id: 'decom.project.get.404', method: 'GET', url: `https://vercel.sandbox.test/v9/projects/${ACCEPTANCE_APP_ID}`, status: 404, json: { error: { code: 'not_found' } } },
  ]);
  const github = new RecordedSandboxTransport([
    { id: 'decom.manifest.approved', method: 'GET', url: /\/repos\/acme\/control\/contents\/catalog%2Fapps%2Facceptance-app\.yaml\?ref=[0-9a-f]{40}$/, json: githubFileContent(approvedYaml) },
    { id: 'decom.manifest.main', method: 'GET', url: /\/repos\/acme\/control\/contents\/catalog%2Fapps%2Facceptance-app\.yaml\?ref=main$/, json: githubFileContent(approvedYaml) },
    { id: 'decom.deployments.list', method: 'GET', url: /\/repos\/acme\/acceptance-app\/deployments\?ref=[0-9a-f]{40}&environment=production/, json: [{ id: 1001, environment: 'production', url: 'https://github.sandbox.test/deployments/1001' }] },
    { id: 'decom.deployment.status', method: 'POST', url: 'https://github.sandbox.test/repos/acme/acceptance-app/deployments/1001/statuses', json: { id: 2001, url: 'https://github.sandbox.test/deployments/1001/statuses/2001' } },
  ]);
  return { transport, github };
}

function decommissionRun(
  store: Awaited<ReturnType<typeof createD1Store>>['store'],
  provider: CompositeProvider,
  github: GitHubAdapter,
  input: { approvalId: string; approvalToken: string; workflowId: string; idempotencyKey: string },
): ReturnType<typeof runDecommissionWorkflow> {
  return runDecommissionWorkflow({
    applicationId: ACCEPTANCE_APP_ID,
    approvalId: input.approvalId,
    approvalToken: input.approvalToken,
    sourceCommit: COMMIT_A,
    domain: ACCEPTANCE_DOMAIN,
    actor: 'e2e-operator',
    now: NOW,
    idempotencyKey: input.idempotencyKey,
    workflowId: input.workflowId,
    controlRepository: ACCEPTANCE_CONTROL_REPOSITORY,
    manifestPath: ACCEPTANCE_MANIFEST_PATH,
    dependentCatalog: [],
    provider,
    source: github,
    store,
    context: acceptanceContext(input.workflowId),
    sleep: NOOP_SLEEP,
  });
}

it('DEL-ORDERED-TEARDOWN: the approved decommission runs the ordered teardown and tombstones the application', async () => {
  await scenario('DEL-ORDERED-TEARDOWN', async () => {
    const harness = createD1Store(fixedNow);
    try {
      await seedApplication(harness.store);
      const desired = acceptanceManifest();
      const applyTransportInstance = applyTransport();
      const applyProvider = compositeFor(applyTransportInstance);
      const { plan, observed } = await planFor(harness.store, applyProvider, desired, COMMIT_A, 1, NOW);
      const applied = await runApply(harness.store, applyProvider, desired, plan, observed, { sourceCommit: COMMIT_A, workflowId: 'apply-teardown' });
      expect(applied.status, `base apply failed: ${applied.errorCode ?? 'unknown'}`).toBe('SUCCEEDED');
      await recordOwnership(harness.store);

      // Simulate the adopted proxied state (owned fingerprint, proxied record) that proxy-off must remove.
      const proxyTransport = new RecordedSandboxTransport([
        { id: 'proxy.zone.get', method: 'GET', url: 'https://cloudflare.sandbox.test/zones?name=acceptance.test', json: cfEnvelope([recordedZone()]) },
        // ensureRecord observes before the mutation (absent) and after (present).
        { id: 'proxy.record.list.absent', method: 'GET', url: /dns_records\?name=acceptance\.example\.com(?:&type=CNAME)?$/, json: cfEnvelope([]), times: 1 },
        { id: 'proxy.record.create', method: 'POST', url: 'https://cloudflare.sandbox.test/zones/zone_acceptance_1/dns_records', json: cfEnvelope(recordedDnsRecord({ proxied: true, comment: `launchpad:${DNS_OWNERSHIP}` })) },
        { id: 'proxy.record.list.present', method: 'GET', url: /dns_records\?name=acceptance\.example\.com(?:&type=CNAME)?$/, json: cfEnvelope([recordedDnsRecord({ proxied: true, comment: `launchpad:${DNS_OWNERSHIP}` })]), times: 2 },
      ]);
      const cloudflare = new CloudflareAdapter({
        token: 'lp-sandbox-token',
        baseUrl: 'https://cloudflare.sandbox.test',
        fetchImpl: proxyTransport.fetchImpl,
        resolveDns: VERIFIED_RESOLVER,
        verification: { maxAttempts: 2, baseDelayMs: 1, timeoutMs: 1_000, sleep: NOOP_SLEEP, jitter: () => 0 },
      });
      const proxied = await cloudflare.ensureRecord(ACCEPTANCE_ZONE_ID, { hostname: ACCEPTANCE_DOMAIN, type: 'CNAME', value: DNS_TARGET, ttl: 'auto', proxied: true, proxyAcknowledgment: true }, DNS_OWNERSHIP, acceptanceContext('proxy-adopt'));
      expect(proxied.changed).toBe(true);
      expect(proxied.resource.proxied).toBe(true);

      const approvedYaml = approvedManifestYaml();
      const { transport, github: githubTransport } = decommissionTransport(approvedYaml, { dnsOnlyTimes: 3, byidTimes: 1 });
      const provider = compositeFor(transport);
      const github = new GitHubAdapter({ token: 'lp-sandbox-token', baseUrl: 'https://github.sandbox.test', fetchImpl: githubTransport.fetchImpl });
      const issued = await issueDeletionApproval({
        store: harness.store,
        binding: { applicationId: ACCEPTANCE_APP_ID, domain: ACCEPTANCE_DOMAIN, sourceCommit: COMMIT_A, actor: 'e2e-operator', expiresAt: '2026-08-10T00:00:00.000Z' },
        now: NOW,
      });
      const removed = await decommissionRun(harness.store, provider, github, {
        approvalId: issued.approvalId,
        approvalToken: issued.token,
        workflowId: 'decom-1',
        idempotencyKey: 'decom-1',
      });
      expect(removed.status, `destroy failed: ${removed.errorCode ?? 'unknown'} at ${removed.failedStep ?? '?'}`).toBe('DELETED');
      expect(removed.exportJson).toContain('exportVersion');
      expect(removed.tombstone).toMatchObject({ applicationId: ACCEPTANCE_APP_ID, domain: ACCEPTANCE_DOMAIN });
      expect(await harness.store.isTombstoned(ACCEPTANCE_APP_ID)).toBe(true);
      expect(await harness.store.isDomainTombstoned(ACCEPTANCE_DOMAIN)).toBe(true);
      expect((await harness.store.getApplication(ACCEPTANCE_APP_ID))?.lifecycleState).toBe('deleted');

      // Ordered teardown with delegated Vercel deletes: proxy-off PUT before
      // the Vercel domain unassign (removeDomain) before owned-DNS DELETE
      // before deployment delete (deleteDeployment) before project DELETE
      // before inactive statuses. Each delegated delete ran exactly once —
      // the composite now exposes removeDomain/deleteDeployment, so none of
      // these steps may be skipped as 'provider lacks capability'.
      const order = transport.calls().filter((entry) => entry.exchangeId !== null).map((entry) => entry.exchangeId);
      const proxyOff = order.indexOf('decom.record.proxyoff');
      const domainRemove = order.indexOf('decom.domain.remove');
      const dnsDelete = order.indexOf('decom.record.delete');
      const deploymentDelete = order.indexOf('decom.deployment.delete');
      const projectDelete = order.indexOf('decom.project.delete');
      const statusCreate = githubTransport.calls().findIndex((entry) => entry.exchangeId === 'decom.deployment.status');
      expect(proxyOff).toBeGreaterThanOrEqual(0);
      expect(domainRemove).toBeGreaterThan(proxyOff);
      expect(dnsDelete).toBeGreaterThan(domainRemove);
      expect(deploymentDelete).toBeGreaterThan(dnsDelete);
      expect(projectDelete).toBeGreaterThan(deploymentDelete);
      expect(statusCreate).toBeGreaterThanOrEqual(0);
      expect(transport.calls((entry) => entry.exchangeId === 'decom.domain.remove')).toHaveLength(1);
      expect(transport.calls((entry) => entry.exchangeId === 'decom.deployment.delete')).toHaveLength(1);
      expect(transport.calls((entry) => entry.exchangeId === 'decom.project.delete')).toHaveLength(1);
      const audits = await harness.store.listAudit(ACCEPTANCE_APP_ID);
      expect(audits.some((event) => event.action === 'DELETED')).toBe(true);
      expect(audits.some((event) => event.action === 'DESTROY_EXPORT')).toBe(true);

      // Tombstone blocks reuse until retention elapses.
      const reuse = await assertTombstoneReuseAllowed({
        store: harness.store,
        applicationId: ACCEPTANCE_APP_ID,
        domain: ACCEPTANCE_DOMAIN,
        now: '2026-08-04T00:00:00.000Z',
      });
      expect(reuse.allowed).toBe(false);
      return {
        observed: `ordered teardown executed (proxy-off → Vercel domain unassign → owned DNS → deployment delete → project → inactive statuses); each delegated delete ran exactly once; tombstone blocks reuse (${reuse.code})`,
        resourceIds: { dnsRecord: 'dns_acceptance_1', vercelProject: ACCEPTANCE_PROJECT_ID, githubDeployment: '1001' },
        evidence: logEvidence(transport, {
          order,
          delegatedDeletes: {
            domainRemove: transport.calls((entry) => entry.exchangeId === 'decom.domain.remove').length,
            deploymentDelete: transport.calls((entry) => entry.exchangeId === 'decom.deployment.delete').length,
            projectDelete: transport.calls((entry) => entry.exchangeId === 'decom.project.delete').length,
          },
          githubCalls: githubTransport.calls().length,
        }),
      };
    } finally {
      harness.close();
    }
  });
});

it('DEL-PARTIAL-RESUME: an interrupted destroy resumes from the last durable boundary', async () => {
  await scenario('DEL-PARTIAL-RESUME', async () => {
    const harness = createD1Store(fixedNow);
    try {
      await seedApplication(harness.store);
      const desired = acceptanceManifest();
      const applyTransportInstance = applyTransport();
      const applyProvider = compositeFor(applyTransportInstance);
      const { plan, observed } = await planFor(harness.store, applyProvider, desired, COMMIT_A, 1, NOW);
      const applied = await runApply(harness.store, applyProvider, desired, plan, observed, { sourceCommit: COMMIT_A, workflowId: 'apply-partial' });
      expect(applied.status).toBe('SUCCEEDED');
      await recordOwnership(harness.store);

      const approvedYaml = approvedManifestYaml();
      // The faulted delete step re-runs its whole body on each bounded retry
      // (3 attempts) plus the resumed run, so the recorded list/by-id routes
      // must cover every re-observation of the still-present record.
      const { transport, github: githubTransport } = decommissionTransport(approvedYaml, { dnsOnlyTimes: 6, byidTimes: 4 });
      const provider = compositeFor(transport);
      const github = new GitHubAdapter({ token: 'lp-sandbox-token', baseUrl: 'https://github.sandbox.test', fetchImpl: githubTransport.fetchImpl });
      const issued = await issueDeletionApproval({
        store: harness.store,
        binding: { applicationId: ACCEPTANCE_APP_ID, domain: ACCEPTANCE_DOMAIN, sourceCommit: COMMIT_A, actor: 'e2e-operator', expiresAt: '2026-08-10T00:00:00.000Z' },
        now: NOW,
      });

      // Provider outage during the owned-DNS delete: retries exhaust and the run fails.
      transport.failNext({ method: 'DELETE', url: 'https://cloudflare.sandbox.test/zones/zone_acceptance_1/dns_records/dns_acceptance_1', fault: { kind: 'http', status: 500 }, times: 3 });
      const first = await decommissionRun(harness.store, provider, github, {
        approvalId: issued.approvalId,
        approvalToken: issued.token,
        workflowId: 'decom-resume',
        idempotencyKey: 'decom-resume',
      });
      expect(first.status).toBe('FAILED');
      expect(first.errorCode).toBe('LP-CLOUDFLARE-HTTP-500');

      // Resume with the same idempotency key: completed steps are not repeated; the destroy completes.
      const second = await decommissionRun(harness.store, provider, github, {
        approvalId: issued.approvalId,
        approvalToken: issued.token,
        workflowId: 'decom-resume',
        idempotencyKey: 'decom-resume',
      });
      expect(second.status, `resumed destroy failed: ${second.errorCode ?? 'unknown'} at ${second.failedStep ?? '?'}`).toBe('DELETED');
      expect(transport.calls((entry) => entry.exchangeId === 'decom.project.delete')).toHaveLength(1);
      expect(transport.calls((entry) => entry.exchangeId === 'decom.record.delete')).toHaveLength(1);
      // The delegated Vercel deletes (domain unassign + deployment delete)
      // completed before the faulted step and are never repeated on resume.
      expect(transport.calls((entry) => entry.exchangeId === 'decom.domain.remove')).toHaveLength(1);
      expect(transport.calls((entry) => entry.exchangeId === 'decom.deployment.delete')).toHaveLength(1);
      expect(githubTransport.calls((entry) => entry.exchangeId === 'decom.deployment.status')).toHaveLength(1);
      expect(await harness.store.isTombstoned(ACCEPTANCE_APP_ID)).toBe(true);
      expect((await harness.store.listDeletionApprovals(ACCEPTANCE_APP_ID))[0]?.status).toBe('USED');
      return {
        observed: 'destroy interrupted at owned-DNS delete, resumed from the durable boundary, completed DELETED with single-use approval',
        resourceIds: { dnsRecord: 'dns_acceptance_1', vercelProject: ACCEPTANCE_PROJECT_ID },
        evidence: logEvidence(transport, { failedRunError: first.errorCode, approvalStatus: (await harness.store.listDeletionApprovals(ACCEPTANCE_APP_ID))[0]?.status }),
      };
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Durability scenarios (plan sections 14.1/37/47, 33, 11)
// ---------------------------------------------------------------------------

it('DUR-INTERRUPT-RESUME: a forced provider timeout exhausts durable retries, then resumes without duplicate writes', async () => {
  await scenario('DUR-INTERRUPT-RESUME', async () => {
    const harness = createD1Store(fixedNow);
    try {
      await seedApplication(harness.store);
      const desired = acceptanceManifest();
      const transport = applyTransport();
      const provider = compositeFor(transport);
      const { plan, observed } = await planFor(harness.store, provider, desired, COMMIT_A, 1, NOW);

      // Forced provider timeout on the candidate wait: bounded retries exhaust.
      transport.failNext({ method: 'GET', url: 'https://vercel.sandbox.test/v13/deployments/dpl_candidate_1', fault: { kind: 'timeout' }, times: 3 });
      const first = await runApply(harness.store, provider, desired, plan, observed, { sourceCommit: COMMIT_A, workflowId: 'apply-interrupt' });
      expect(first.status).toBe('FAILED');
      expect(first.errorCode).toBe('LP-VERCEL-TIMEOUT');

      // "Worker restart": same store, same idempotency key; completed steps never repeat.
      const second = await runApply(harness.store, provider, desired, plan, observed, { sourceCommit: COMMIT_A, workflowId: 'apply-interrupt' });
      expect(second.status, `resume failed: ${second.errorCode ?? 'unknown'}`).toBe('SUCCEEDED');
      expect(second.operationId).toBe(first.operationId);
      expect(transport.calls((entry) => entry.exchangeId === 'vercel.deployment.create')).toHaveLength(1);
      expect(transport.calls((entry) => entry.exchangeId === 'vercel.project.create')).toHaveLength(1);
      expect(transport.calls((entry) => entry.exchangeId === 'vercel.promote')).toHaveLength(1);
      const timeoutCalls = transport.calls((entry) => entry.status === null && entry.method === 'GET' && entry.url.includes('dpl_candidate_1'));
      expect(timeoutCalls).toHaveLength(3);
      return {
        observed: 'LP-VERCEL-TIMEOUT after 3 bounded attempts; resume completed with exactly one of each provider write',
        resourceIds: { deployment: 'dpl_candidate_1' },
        evidence: logEvidence(transport, { operationId: first.operationId }),
      };
    } finally {
      harness.close();
    }
  });
});

it('DUR-IDEMPOTENT-DELIVERY: duplicate delivery with one idempotency key does not duplicate operations', async () => {
  await scenario('DUR-IDEMPOTENT-DELIVERY', async () => {
    const harness = createD1Store(fixedNow);
    try {
      await seedApplication(harness.store);
      const desired = acceptanceManifest();
      const transport = applyTransport();
      const provider = compositeFor(transport);
      const { plan, observed } = await planFor(harness.store, provider, desired, COMMIT_A, 1, NOW);
      const first = await runApply(harness.store, provider, desired, plan, observed, { sourceCommit: COMMIT_A, workflowId: 'apply-idem' });
      expect(first.status).toBe('SUCCEEDED');
      const callsAfterFirst = transport.calls().length;
      const second = await runApply(harness.store, provider, desired, plan, observed, { sourceCommit: COMMIT_A, workflowId: 'apply-idem' });
      expect(second.status).toBe('SUCCEEDED');
      expect(second.operationId).toBe(first.operationId);
      expect(transport.calls().length).toBe(callsAfterFirst);
      const runs = await harness.store.listWorkflowRuns(ACCEPTANCE_APP_ID);
      expect(runs.filter((run) => run.workflowType === 'APPLY')).toHaveLength(1);
      return { observed: 'duplicate delivery reused the same operation; zero additional provider calls', evidence: logEvidence(transport, { callsAfterFirst }) };
    } finally {
      harness.close();
    }
  });
});

it('DUR-LOCK-RECOVERY: a lock conflict blocks apply before writes; releasing the lock lets it succeed', async () => {
  await scenario('DUR-LOCK-RECOVERY', async () => {
    const harness = createD1Store(fixedNow);
    try {
      await seedApplication(harness.store);
      const desired = acceptanceManifest();
      const transport = applyTransport();
      const provider = compositeFor(transport);
      const { plan, observed } = await planFor(harness.store, provider, desired, COMMIT_A, 1, NOW);

      expect(await harness.store.acquireLock(`application:${ACCEPTANCE_APP_ID}`, 'other-owner', 900, NOW)).toBe(true);
      const blocked = await runApply(harness.store, provider, desired, plan, observed, { sourceCommit: COMMIT_A, workflowId: 'apply-lock' });
      expect(blocked.status).toBe('FAILED');
      expect(blocked.errorCode).toBe('LP-LOCK-CONFLICT');
      expect(transport.writes()).toHaveLength(0);

      await harness.store.releaseLock(`application:${ACCEPTANCE_APP_ID}`, 'other-owner');
      const recovered = await runApply(harness.store, provider, desired, plan, observed, { sourceCommit: COMMIT_A, workflowId: 'apply-lock' });
      expect(recovered.status, `recovered apply failed: ${recovered.errorCode ?? 'unknown'}`).toBe('SUCCEEDED');
      expect(transport.writes().length).toBeGreaterThan(0);
      expect(await harness.store.getLock(`application:${ACCEPTANCE_APP_ID}`)).toBeNull();
      expect(await harness.store.getLock(`domain:${ACCEPTANCE_DOMAIN}`)).toBeNull();
      return { observed: 'LP-LOCK-CONFLICT blocked apply with zero writes; after release the apply succeeded and released both locks', evidence: logEvidence(transport, { writes: transport.writes().length }) };
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Observability scenarios (plan sections 49/33, 11; release checklist)
// ---------------------------------------------------------------------------

it('OBS-DLQ: retry exhaustion reaches the DLQ and creates a visible incident before acknowledgment', async () => {
  await scenario('OBS-DLQ', async () => {
    const harness = createD1Store(fixedNow);
    try {
      await seedApplication(harness.store, 'obs-app');
      const metrics = new MetricsRegistry({ now: fixedNow });
      const persistence: QueuePersistence = {
        async recordIncident(request) {
          await harness.store.recordIncident({
            type: 'DLQ',
            fingerprint: `${request.queue}:${request.messageId}`,
            severity: 'critical',
            applicationId: request.applicationId,
            message: String(request.details?.cause ?? 'dropped'),
            details: { queue: request.queue, messageId: request.messageId, attempts: request.attempts, code: request.code, errorClass: request.errorClass },
            firedAt: request.createdAt,
          });
          await harness.store.appendAudit({ actor: 'queue:dead-letter', action: 'DLQ_INCIDENT', applicationId: request.applicationId ?? 'platform', details: { ...request } });
        },
      };
      const message = {
        id: 'dlq-acceptance-1',
        body: createQueueEnvelope({ kind: 'provider-event', id: 'evt-acceptance-1', payload: { applicationId: 'obs-app' }, now: fixedNow() }),
        attempts: 6,
      };
      const acked: string[] = [];
      const outcome = await handleQueue({ queue: DEAD_LETTER_QUEUE, messages: [message], ack: (entry) => acked.push(entry.id), retry: () => undefined }, {
        persist: persistence,
        now: fixedNow,
        metrics,
      });
      expect(outcome).toEqual({ acknowledged: 1, retried: 0, incidents: 1 });
      expect(acked).toEqual(['dlq-acceptance-1']);
      const incident = await harness.store.getIncident('DLQ', 'launchpad-dead-letter:dlq-acceptance-1');
      expect(incident).toMatchObject({ type: 'DLQ', severity: 'critical', applicationId: 'obs-app' });
      expect((await harness.store.listAudit('obs-app')).some((event) => event.action === 'DLQ_INCIDENT')).toBe(true);

      const snapshots = await snapshotMetricsToStore({ store: harness.store, metrics, logger: new LaunchpadLogger({ level: 'info', sink: () => undefined }), alertConfigs: [], now: fixedNow });
      expect(snapshots.some((snapshot) => snapshot.metric === 'dlq_count' && snapshot.total === 1)).toBe(true);
      const persisted = await harness.store.listMetricSnapshots({ metric: 'dlq_count' });
      expect(persisted[0]?.total).toBe(1);
      return {
        observed: 'retry exhaustion → DLQ incident row before ack, DLQ_INCIDENT audit, dlq_count metric snapshot',
        evidence: { incidentFingerprint: incident?.fingerprint, metricTotal: persisted[0]?.total },
      };
    } finally {
      harness.close();
    }
  });
});

it('OBS-PROVIDER-ERROR: a forced provider timeout yields a typed durable record and deduped, reopenable incident', async () => {
  await scenario('OBS-PROVIDER-ERROR', async () => {
    const harness = createD1Store(fixedNow);
    try {
      await seedApplication(harness.store);
      let current = new Date(NOW);
      // Real adapter over a timeout fault: the error is a typed ProviderRequestError.
      const transport = new RecordedSandboxTransport([]);
      transport.failNext({ method: 'GET', url: 'https://vercel.sandbox.test/v13/deployments/dpl_x', fault: { kind: 'timeout' } });
      const adapter = new VercelAdapter({ token: 'lp-sandbox-token', teamId: 'team_acceptance', baseUrl: 'https://vercel.sandbox.test', fetchImpl: transport.fetchImpl });
      let timeoutError: unknown = null;
      try {
        await adapter.waitForDeployment({ projectId: ACCEPTANCE_APP_ID, deploymentId: 'dpl_x', timeoutMs: 1_000, pollMs: 100 }, acceptanceContext('obs-timeout'));
      } catch (error) {
        timeoutError = error;
      }
      expect(timeoutError).toMatchObject({ code: 'LP-VERCEL-TIMEOUT', class: 'TIMEOUT', retryable: true });
      const observability = {
        store: harness.store,
        logger: new LaunchpadLogger({ level: 'info', sink: () => undefined }),
        metrics: new MetricsRegistry({ now: () => current }),
        alertConfigs: [{ type: 'CONTROLLER_ERROR_RATE' as const, enabled: true, cooldownSeconds: 3600, threshold: null }],
        now: () => current,
      };
      const first = await recordPermanentFailure(observability, {
        error: timeoutError,
        kind: 'apply',
        applicationId: ACCEPTANCE_APP_ID,
        operationId: 'op-timeout',
        step: 'wait-candidate',
        provider: 'vercel',
      });
      expect(first.providerError).toMatchObject({ code: 'LP-VERCEL-TIMEOUT', class: 'TIMEOUT', retryable: true, applicationId: ACCEPTANCE_APP_ID });
      expect(first.providerError?.remediation.length ?? 0).toBeGreaterThan(0);
      expect(first.incident).toMatchObject({ type: 'CONTROLLER_ERROR_RATE', severity: 'warning' });
      const fingerprint = first.incident?.fingerprint;
      expect(fingerprint).toBeDefined();
      const firstFiredAt = first.incident?.lastFiredAt;

      // Same failure within the cooldown: deduped (no refire, no new audit event).
      await recordPermanentFailure(observability, { error: timeoutError, kind: 'apply', applicationId: ACCEPTANCE_APP_ID, operationId: 'op-timeout', step: 'wait-candidate', provider: 'vercel' });
      const deduped = await harness.store.getIncident('CONTROLLER_ERROR_RATE', fingerprint!);
      expect(deduped?.lastFiredAt).toBe(firstFiredAt);
      expect((await harness.store.listAudit(ACCEPTANCE_APP_ID)).filter((event) => event.action === 'INCIDENT_FIRED')).toHaveLength(1);

      // After the cooldown elapses the same row reopens.
      current = new Date(current.getTime() + 2 * 60 * 60 * 1000);
      await recordPermanentFailure(observability, { error: timeoutError, kind: 'apply', applicationId: ACCEPTANCE_APP_ID, operationId: 'op-timeout', step: 'wait-candidate', provider: 'vercel' });
      const refired = await harness.store.getIncident('CONTROLLER_ERROR_RATE', fingerprint!);
      expect(refired?.lastFiredAt).toBe(current.toISOString());
      expect(refired?.firstSeenAt).toBe(firstFiredAt);
      expect(refired?.resolvedAt).toBeNull();
      expect((await harness.store.listAudit(ACCEPTANCE_APP_ID)).filter((event) => event.action === 'INCIDENT_FIRED')).toHaveLength(2);
      return {
        observed: 'LP-VERCEL-TIMEOUT persisted (code/class/retryable/remediation), incident deduped in cooldown and reopened after',
        resourceIds: { deployment: 'dpl_x' },
        evidence: { providerErrorCode: first.providerError?.code, incidentType: first.incident?.type },
      };
    } finally {
      harness.close();
    }
  });
});

it('OBS-METRICS-SNAPSHOT: metric snapshots persist per window with bounded labels', async () => {
  await scenario('OBS-METRICS-SNAPSHOT', async () => {
    const harness = createD1Store(fixedNow);
    try {
      await seedApplication(harness.store, 'obs-app');
      const metrics = new MetricsRegistry({ now: fixedNow });
      metrics.increment('successes', { provider: 'vercel', workflow: 'apply' });
      metrics.increment('failures', { provider: 'vercel', workflow: 'apply' });
      metrics.increment('failures', { provider: 'vercel', workflow: 'apply' });
      metrics.increment('dlq_count');
      await snapshotMetricsToStore({ store: harness.store, metrics, logger: new LaunchpadLogger({ level: 'info', sink: () => undefined }), alertConfigs: [], now: fixedNow });
      const persisted = await harness.store.listMetricSnapshots({ limit: 20 });
      expect(persisted.some((snapshot) => snapshot.metric === 'dlq_count' && snapshot.total === 1)).toBe(true);
      const errorRate = persisted.find((snapshot) => snapshot.metric === 'provider_error_rate');
      expect(errorRate?.rate).toBe(2 / 3);
      const failures = persisted.find((snapshot) => snapshot.metric === 'failures');
      expect(failures?.labels).toMatchObject({ provider: 'vercel', workflow: 'apply' });
      expect(() => metrics.increment('failures', { provider: 'not-a-provider' as never })).toThrow(/LP-METRIC-LABEL-INVALID/);
      return { observed: 'snapshots persisted with bounded labels; provider_error_rate = 2/3; unbounded labels rejected', evidence: { persisted: persisted.length, errorRate: errorRate?.rate } };
    } finally {
      harness.close();
    }
  });
});

it('OBS-WEBHOOK-DEDUPE: webhook replay deduplicates against the durable receipt', async () => {
  await scenario('OBS-WEBHOOK-DEDUPE', async () => {
    const harness = createD1Store(fixedNow);
    try {
      await seedApplication(harness.store, 'obs-app');
      const first = await harness.store.persistWebhookReceipt({ provider: 'vercel', eventId: 'evt-webhook-1', payload: { type: 'deployment.created' }, receivedAt: NOW });
      const replay = await harness.store.persistWebhookReceipt({ provider: 'vercel', eventId: 'evt-webhook-1', payload: { type: 'deployment.created' }, receivedAt: NOW });
      expect(first.inserted).toBe(true);
      expect(replay.inserted).toBe(false);
      const receipt = await harness.store.getWebhookReceipt('vercel', 'evt-webhook-1');
      expect(receipt).not.toBeNull();
      return { observed: 'replayed webhook deduplicated against the durable receipt (inserted=false)', evidence: { inserted: first.inserted, replayed: replay.inserted } };
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Security gates (plan sections 11/33/49; release checklist)
// ---------------------------------------------------------------------------

it('SEC-RULESET-CONFIG: the main ruleset config protects main and is wired as a deploy gate', async () => {
  await scenario('SEC-RULESET-CONFIG', async () => {
    const ruleset = JSON.parse(readFileSync('.github/rulesets/main.json', 'utf8')) as {
      name: string; target: string; enforcement: string; bypass_actors: unknown[];
      conditions: { ref_name: { include: string[] } };
      repository: { default_branch: string; squash_merge_only: boolean };
      rules: Array<{ type: string; parameters?: Record<string, unknown> }>;
    };
    expect(ruleset.name).toBe('launchpad-main');
    expect(ruleset.target).toBe('branch');
    expect(ruleset.enforcement).toBe('active');
    expect(ruleset.conditions.ref_name.include).toContain('refs/heads/main');
    expect(ruleset.bypass_actors).toEqual([]);
    const types = ruleset.rules.map((rule) => rule.type);
    expect(types).toContain('creation');
    expect(types).toContain('deletion'); // direct pushes can never delete main
    expect(types).toContain('non_fast_forward'); // direct pushes are rejected (no force push / fast-forward)
    const review = ruleset.rules.find((rule) => rule.type === 'pull_request')?.parameters as Record<string, unknown> | undefined;
    expect(review?.required_approving_review_count).toBe(0); // solo-owner policy; pull requests and required checks still gate main
    expect(review?.require_code_owner_review).toBe(false);
    expect(review?.require_last_push_approval).toBe(false);
    expect(review?.required_review_thread_resolution).toBe(true);
    expect(review?.dismiss_stale_reviews_on_push).toBe(true);
    expect(review?.allowed_merge_methods).toEqual(['squash']);
    const checks = ruleset.rules.find((rule) => rule.type === 'required_status_checks')?.parameters as Record<string, unknown> | undefined;
    const contexts = ((checks?.required_status_checks as Array<{ context: string }> | undefined) ?? []).map((check) => check.context);
    expect(checks?.strict_required_status_checks_policy).toBe(true);
    expect(contexts).toEqual(['static / toolchain', 'static / quality', 'platform / summary', 'dependency / review']);
    expect(ruleset.repository.squash_merge_only).toBe(true);
    expect(ruleset.repository.default_branch).toBe('main');

    // The production deploy gate verifies the live ruleset before deploying.
    const deployWorkflow = readFileSync('.github/workflows/deploy-control-plane.yml', 'utf8');
    expect(deployWorkflow).toContain('node scripts/verify-ruleset.mjs');

    // CODEOWNERS protects catalog, schema, workflows, controller, migrations, toolchain, and rulesets.
    const codeowners = readFileSync('.github/CODEOWNERS', 'utf8');
    for (const path of ['/catalog/', '/schema/', '/workflows/', '/apps/controller/', '/migrations/', '/package.json', '/scripts/', '/.github/rulesets/', '/docs/release-checklist.md', '/.github/CODEOWNERS']) {
      expect(codeowners, `CODEOWNERS must cover ${path}`).toContain(path);
    }
    return { observed: 'ruleset config active on main with review/CODEOWNERS/status checks and no bypass actors; deploy gate and CODEOWNERS wired' };
  });
});

it('SEC-SECRET-REDACTION: the secret canary scan is clean across every visibility surface', async () => {
  await scenario('SEC-SECRET-REDACTION', async () => {
    const canary = 'lp-canary-9f2d';
    canaries.push(canary);
    const plan = {
      schemaVersion: 'launchpad.plan/v1', applicationId: 'app', desiredGeneration: 1, sourceCommit: 'a'.repeat(40),
      createdAt: NOW, capabilitySnapshotHash: 'cap', observedStateHash: 'obs', operations: [], downstreamEffects: [], policyResults: [],
      fingerprint: 'f'.repeat(64), result: 'READY',
    };
    const sensitive = new SensitiveValue(canary);

    // Provider observation redaction.
    expect(JSON.stringify(redactValue({ database: sensitive, safe: 'ok' }))).not.toContain(canary);

    // Sticky PR comments and plan/preview/health artifacts.
    const comment = renderStickyComment({ plans: [plan as never], previews: [{ state: 'READY', url: null, message: `token=${canary}` }], healths: [{ state: 'PASSED', message: `secret=${canary}` }] });
    expect(comment).not.toContain(canary);
    const artifacts = artifactFiles({
      plans: [plan as never],
      previews: [{ state: 'READY', url: null, message: `token=${canary}` }],
      healths: [{ state: 'PASSED', message: `secret=${canary}` }],
      providerState: redactValue({ database: sensitive }),
      logs: [`deploying with token=${canary}`],
    });
    for (const artifact of Object.values(artifacts)) {
      expect(String(artifact)).not.toContain(canary);
    }

    // Build log excerpts through the real preview redaction path.
    const desiredWithCanary = { ...acceptanceManifest(), environments: { ...acceptanceManifest().environments, preview: { ...acceptanceManifest().environments.preview!, variables: { CANARY: canary } } } };
    const redacted = redactBuildLog({ deploymentId: 'dpl_preview_1', excerpt: `building with CANARY=${canary}`, truncated: false }, desiredWithCanary);
    expect(redacted).not.toContain(canary);
    expect(redacted).toContain('[REDACTED]');

    // Health records never carry secret-backed header values.
    const health = await checkHealth({
      applicationId: ACCEPTANCE_APP_ID,
      environment: 'production',
      deploymentId: 'dpl_candidate_1',
      baseUrl: 'https://acceptance.example.com',
      spec: { path: '/api/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 2, attempts: 1, intervalSeconds: 0, headers: { 'X-Health-Key': { secretRef: 'env://KEY' } } },
      fetchImpl: healthServer([{ status: 200, body: 'ok' }]),
      resolveSecret: async () => canary,
      dnsResolve: async () => undefined,
      sleep: NOOP_SLEEP,
    });
    expect(JSON.stringify(health)).not.toContain(canary);
    expect((await scanCanary(health, [canary])).leaked).toBe(false);

    // D1 rows reject SensitiveValue (provider-error and incident payloads).
    const harness = createD1Store(fixedNow);
    try {
      await seedApplication(harness.store);
      await expect(harness.store.recordProviderError({ applicationId: ACCEPTANCE_APP_ID, code: 'LP-SECRET-LEAK', class: 'INTERNAL', message: 'boom', retryable: false, safeDetails: { token: sensitive } })).rejects.toMatchObject({ name: 'LP-DB-SERIALIZATION-BLOCKED' });
      await expect(harness.store.recordIncident({ type: 'DLQ', fingerprint: 'q:1', severity: 'critical', message: 'dropped', details: { token: sensitive }, firedAt: NOW })).rejects.toMatchObject({ name: 'LP-DB-SERIALIZATION-BLOCKED' });
      expect(await harness.store.listProviderErrors(ACCEPTANCE_APP_ID)).toHaveLength(0);
    } finally {
      harness.close();
    }

    // Whole-surface canary scan. The `logs` surface carries the redacted
    // build-log artifact (the exact value the pipeline persists), never the
    // raw provider output.
    const scan = await scanCanary({ artifacts, comment, logs: [redacted], observedState: redactValue({ x: sensitive }), health }, [canary]);
    expect(scan.leaked).toBe(false);
    // Positive control: an unredacted surface must be detected.
    expect((await scanCanary({ artifacts: { leak: `token=${canary}` }, comment: '', logs: [] }, [canary])).leaked).toBe(true);
    return { observed: 'canary absent from plans, comments, artifacts, build logs, health records, and D1 rows; unredacted surfaces are detected' };
  });
});

// ---------------------------------------------------------------------------
// Reviewed-plan approval gate (squash-merge neutral plan approval)
// ---------------------------------------------------------------------------

it('PLAN-REVIEW-SQUASH-PASS: a squash-merged equivalent plan passes the approval gate with the source-commit-neutral review fingerprint', async () => {
  await scenario('PLAN-REVIEW-SQUASH-PASS', async () => {
    const harness = createD1Store(fixedNow);
    try {
      await seedApplication(harness.store);
      const desired = acceptanceManifest();
      // The merged apply creates and promotes its candidate at COMMIT_B, so
      // the recorded transport serves the COMMIT_B deployment.
      const transport = applyTransport({ commit: COMMIT_B });
      const provider = compositeFor(transport);
      // The review happened at the PR head (COMMIT_A); the apply runs at the
      // merged commit (COMMIT_B). The plan content is identical, so only the
      // source commit differs between the reviewed plan and the merged replan.
      const { plan, observed } = await planFor(harness.store, provider, desired, COMMIT_A, 1, NOW);
      const merged = await buildPlan({ desired, observed, capabilities: await provider.capabilities(), sourceCommit: COMMIT_B, desiredGeneration: 1, ownership: await ownershipFromStore(harness.store), mode: 'apply', now: NOW });
      expect(merged.fingerprint).not.toBe(plan.fingerprint);
      expect(await planReviewFingerprint(merged)).toBe(await planReviewFingerprint(plan));
      const result = await runApply(harness.store, provider, desired, merged, observed, { sourceCommit: COMMIT_B, workflowId: 'apply-review-squash' });
      expect(result.status, `apply failed: ${result.errorCode ?? 'unknown'}`).toBe('SUCCEEDED');
      return {
        observed: 'squash-merged apply passed: identical review fingerprint across PR-head and merged commits',
        evidence: logEvidence(transport, { reviewed: plan.fingerprint.slice(0, 12), merged: merged.fingerprint.slice(0, 12), review: (await planReviewFingerprint(plan)).slice(0, 12) }),
      };
    } finally {
      harness.close();
    }
  });
});

it('PLAN-REVIEW-DRIFT-BLOCKS: provider drift after review blocks apply with no attestation for the drifted review fingerprint', async () => {
  await scenario('PLAN-REVIEW-DRIFT-BLOCKS', async () => {
    const harness = createD1Store(fixedNow);
    try {
      await seedApplication(harness.store);
      const desired = acceptanceManifest();
      const reviewedTransport = applyTransport();
      const reviewedProvider = compositeFor(reviewedTransport);
      const reviewed = await planFor(harness.store, reviewedProvider, desired, COMMIT_A, 1, NOW);

      // Provider state drifts after the review: the project now exists with a
      // different root directory. A fresh merged-SHA replan against the
      // drifted state is internally fresh but was never reviewed for it.
      const driftedTransport = applyTransport({ project: recordedProject({ rootDirectory: 'apps/changed' }), project404Times: 0 });
      const driftedProvider = compositeFor(driftedTransport);
      const drifted = await planFor(harness.store, driftedProvider, desired, COMMIT_B, 1, NOW, { attest: false });
      expect(await planReviewFingerprint(drifted.plan)).not.toBe(await planReviewFingerprint(reviewed.plan));
      const result = await runApply(harness.store, driftedProvider, desired, drifted.plan, drifted.observed, { sourceCommit: COMMIT_B, workflowId: 'apply-review-drift' });
      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('LP-PLAN-REVIEW-ATTESTATION-MISSING');
      expect(driftedTransport.writes()).toHaveLength(0);
      expect(await harness.store.getLock(`application:${ACCEPTANCE_APP_ID}`)).toBeNull();
      return {
        observed: 'LP-PLAN-REVIEW-ATTESTATION-MISSING blocks the drifted apply; zero provider writes after the failed approval gate',
        evidence: logEvidence(driftedTransport, { writes: driftedTransport.writes().length, reviewed: (await planReviewFingerprint(reviewed.plan)).slice(0, 12), drifted: (await planReviewFingerprint(drifted.plan)).slice(0, 12) }),
      };
    } finally {
      harness.close();
    }
  });
});

it('PLAN-REVIEW-DESIRED-DRIFT-BLOCKS: changed desired state or generation after review blocks apply', async () => {
  await scenario('PLAN-REVIEW-DESIRED-DRIFT-BLOCKS', async () => {
    const harness = createD1Store(fixedNow);
    try {
      await seedApplication(harness.store);
      const desired = acceptanceManifest();
      const transport = applyTransport();
      const provider = compositeFor(transport);
      const { plan } = await planFor(harness.store, provider, desired, COMMIT_A, 1, NOW);
      // The merged manifest changed after review (a second commit landed
      // before merge): the root directory now differs.
      const changedDesired = { ...desired, vercel: { ...desired.vercel, project: { ...desired.vercel.project, rootDirectory: 'apps/changed' } } } as DesiredApplication;
      const changedBase = await makeApplyBase({ applicationId: ACCEPTANCE_APP_ID, sourceCommit: COMMIT_B, planFingerprint: 'pending', desiredGeneration: 2, idempotencyKey: idempotencyKey('apply', ACCEPTANCE_APP_ID, COMMIT_B, '2'), workflowId: 'apply-review-desired' });
      const changedLive = await applyObserveLiveState({ base: changedBase, store: harness.store, provider, desired: changedDesired, context: acceptanceContext('apply-review-desired') });
      const changed = await buildPlan({ desired: changedDesired, observed: changedLive.observed, capabilities: changedLive.capabilities, sourceCommit: COMMIT_B, desiredGeneration: 2, ownership: await ownershipFromStore(harness.store), mode: 'apply', now: NOW });
      expect(await planReviewFingerprint(changed)).not.toBe(await planReviewFingerprint(plan));
      const result = await runApply(harness.store, provider, changedDesired, changed, changedLive.observed, { sourceCommit: COMMIT_B, workflowId: 'apply-review-desired' });
      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('LP-PLAN-REVIEW-ATTESTATION-MISSING');
      expect(transport.writes()).toHaveLength(0);
      return {
        observed: 'changed desired state/generation yields no attestation for the new review fingerprint; apply blocks before any provider write',
        evidence: logEvidence(transport, { writes: transport.writes().length }),
      };
    } finally {
      harness.close();
    }
  });
});

it('PLAN-REVIEW-MISSING-BLOCKS: apply without any reviewed-plan attestation blocks before provider writes; replays stay idempotent', async () => {
  await scenario('PLAN-REVIEW-MISSING-BLOCKS', async () => {
    const harness = createD1Store(fixedNow);
    try {
      await seedApplication(harness.store);
      const desired = acceptanceManifest();
      const transport = applyTransport();
      const provider = compositeFor(transport);
      const { plan, observed } = await planFor(harness.store, provider, desired, COMMIT_A, 1, NOW, { attest: false });
      const result = await runApply(harness.store, provider, desired, plan, observed, { sourceCommit: COMMIT_A, workflowId: 'apply-review-missing' });
      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('LP-PLAN-REVIEW-ATTESTATION-MISSING');
      expect(transport.writes()).toHaveLength(0);
      expect(await harness.store.getLock(`application:${ACCEPTANCE_APP_ID}`)).toBeNull();

      // Replay idempotency: the same reviewed plan can be attested repeatedly
      // without duplicating rows, and an attestation for a different
      // desired-state binding is refused.
      const [reviewFingerprint, desiredHash] = await Promise.all([planReviewFingerprint(plan), desiredStateHash(desired)]);
      const first = await harness.store.savePlanReviewAttestation({ applicationId: ACCEPTANCE_APP_ID, prHeadSourceCommit: COMMIT_A, desiredHash, generation: 1, planFingerprint: plan.fingerprint, reviewFingerprint, repository: ACCEPTANCE_REPOSITORY, actor: 'acceptance-workflow', workflowRef: `${ACCEPTANCE_CONTROL_REPOSITORY}/.github/workflows/validate-plan.yml@refs/heads/main`, createdAt: NOW });
      const replay = await harness.store.savePlanReviewAttestation({ applicationId: ACCEPTANCE_APP_ID, prHeadSourceCommit: COMMIT_A, desiredHash, generation: 1, planFingerprint: plan.fingerprint, reviewFingerprint, repository: ACCEPTANCE_REPOSITORY, actor: 'acceptance-workflow', workflowRef: `${ACCEPTANCE_CONTROL_REPOSITORY}/.github/workflows/validate-plan.yml@refs/heads/main` });
      expect(replay.inserted).toBe(false);
      expect(replay.attestation.id).toBe(first.attestation.id);
      expect((await harness.store.listPlanReviewAttestations(ACCEPTANCE_APP_ID))).toHaveLength(1);
      await expect(harness.store.savePlanReviewAttestation({ applicationId: ACCEPTANCE_APP_ID, prHeadSourceCommit: COMMIT_A, desiredHash: 'e'.repeat(64), generation: 1, planFingerprint: plan.fingerprint, reviewFingerprint, repository: ACCEPTANCE_REPOSITORY, actor: 'acceptance-workflow', workflowRef: `${ACCEPTANCE_CONTROL_REPOSITORY}/.github/workflows/validate-plan.yml@refs/heads/main` })).rejects.toThrow();

      // With the attestation recorded, the identical apply now passes.
      const passing = await runApply(harness.store, provider, desired, plan, observed, { sourceCommit: COMMIT_A, workflowId: 'apply-review-passing' });
      expect(passing.status, `apply failed: ${passing.errorCode ?? 'unknown'}`).toBe('SUCCEEDED');
      return {
        observed: 'LP-PLAN-REVIEW-ATTESTATION-MISSING blocks with zero provider writes; replay is idempotent; recording the attestation unblocks the identical apply',
        evidence: logEvidence(transport, { writes: transport.writes().length }),
      };
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Report integrity gate
// ---------------------------------------------------------------------------

it('acceptance matrix is complete: every required scenario passed, none skipped, none missing', () => {
  for (const id of REQUIRED_SCENARIO_IDS) {
    const entry = results.get(id);
    expect(entry, `scenario '${id}' is missing from the acceptance mapping`).toBeDefined();
    expect(entry!.status, `scenario '${id}' was skipped`).not.toBe('skipped');
    expect(entry!.status, `scenario '${id}' failed`).toBe('passed');
  }
});

afterAll(() => {
  const report = writeAcceptanceReport({
    schemaVersion: 'launchpad.acceptance/v1',
    mode: 'offline',
    command: 'yarn acceptance:offline',
    generatedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - suiteStartedAt),
    environment: {
      node: process.versions.node,
      yarn: runningToolchain().yarn,
      commit: resolveSourceCommit(resolve(process.cwd())),
      repoRoot: resolve(process.cwd()),
      offline: true,
    },
    matrix: [...results.values()].sort((left, right) => left.id.localeCompare(right.id)),
    summary: {
      total: results.size,
      passed: [...results.values()].filter((entry) => entry.status === 'passed').length,
      failed: [...results.values()].filter((entry) => entry.status === 'failed').length,
      skipped: [...results.values()].filter((entry) => entry.status === 'skipped').length,
    },
  });
  // The report itself must never leak the canary values used by the suite.
  const serialized = readFileSync(resolve(process.cwd(), 'artifacts/acceptance-report.json'), 'utf8');
  for (const canary of canaries) {
    expect(serialized, `acceptance report leaked canary '${canary}'`).not.toContain(canary);
  }
});
