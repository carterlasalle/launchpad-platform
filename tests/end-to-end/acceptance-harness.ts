/**
 * Offline acceptance harness (tests/end-to-end).
 *
 * Deterministic, fully offline building blocks shared by every scenario in
 * acceptance.test.ts:
 *
 *  - `createD1Store` — a real D1-backed store: the actual migrations from
 *    migrations/d1/ are executed through a node:sqlite shim (D1 is SQLite),
 *    so constraints, triggers, and partial unique indexes are exercised with
 *    real SQL semantics. Never an in-memory fake.
 *
 *  - `RecordedSandboxTransport` — the recorded provider transport. Real
 *    adapter classes (GitHubAdapter, VercelAdapter, CloudflareAdapter) are
 *    pointed at this fetch implementation, which replays recorded sandbox
 *    API exchanges deterministically and fails closed on any unrecorded
 *    request (`LP-RECORDED-SANDBOX-UNMATCHED`). Fault injection models
 *    provider timeouts, network errors, and 5xx outages. Never FakeProvider.
 *
 *  - `CompositeProvider` — the same Vercel+Cloudflare composition the
 *    production controller wires in apps/controller/src/handlers.ts,
 *    including the capability union (each adapter advertises only the
 *    fields its own behavior implements).
 *
 *  - `acceptanceManifest` — the schema-complete application manifest whose
 *    surface is covered by the real adapter capability matrices.
 */

import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import { D1LaunchpadStore, type LaunchpadStore } from '@launchpad/database';
import type { DesiredApplication, DeploymentRecord, ObservedResource } from '@launchpad/core';
import { canonicalJson, sha256Hex } from '@launchpad/shared';
import type { DeploymentLogExcerpt, DeploymentLogRequest, DeploymentRequest, DeploymentWaitRequest, DnsProvider, DomainSpec, EnvironmentSpec, GitConnectionSpec, MutationResult, ProjectDomainObservation, ProjectIdentity, ProjectProvider, ProjectSpec, PromotionRequest, PromotionResult, ProviderCapabilities, ProviderContext, ProxyCompatibilityRequest, ProxyCompatibilityResult, RequiredDnsRecord, RollbackRequest, RollbackResult, TlsObservation, ZoneObservation } from '@launchpad/provider-contract';
import { CloudflareAdapter, type DnsResolver } from '@launchpad/provider-cloudflare';
import { VercelAdapter } from '@launchpad/provider-vercel';

// ---------------------------------------------------------------------------
// D1 store through real migrations (node:sqlite shim)
// ---------------------------------------------------------------------------

export interface D1StoreHarness {
  store: LaunchpadStore;
  raw: DatabaseSync;
  close(): void;
}

/**
 * Executes every migration in migrations/d1/ in order against a real SQLite
 * engine and returns a `D1LaunchpadStore` over the D1-shaped shim. The shim
 * mirrors only the D1 API surface the store uses (prepare/bind/run/all/first/
 * batch) with transactional batch semantics.
 */
export function createD1Store(now?: () => Date): D1StoreHarness {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  const migrationsDir = new URL('../../migrations/d1/', import.meta.url);
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    raw.exec(readFileSync(new URL(file, migrationsDir), 'utf8'));
  }
  const kinds = new WeakMap<D1PreparedStatement, 'query' | 'write'>();
  const prepare = (sql: string): D1PreparedStatement => {
    const statement = raw.prepare(sql);
    const kind: 'query' | 'write' = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)/i.test(sql) ? 'query' : 'write';
    let values: SQLInputValue[] = [];
    const bound = {
      bind(...args: unknown[]): D1PreparedStatement {
        values = args.map((value): SQLInputValue => {
          if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
            return value;
          }
          if (ArrayBuffer.isView(value)) {
            return value as unknown as SQLInputValue;
          }
          throw new TypeError(`Unsupported SQL bind value of type '${typeof value}'`);
        });
        return bound as unknown as D1PreparedStatement;
      },
      async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        const out = statement.run(...values) as { changes: number | bigint; lastInsertRowid: number | bigint };
        return { success: true, meta: { duration: 0, size_after: 0, rows_read: 0, rows_written: 0, last_row_id: Number(out.lastInsertRowid), changed_db: Number(out.changes) > 0, changes: Number(out.changes) }, results: [] as T[] };
      },
      async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        const rows = statement.all(...values) as T[];
        return { success: true, meta: { duration: 0, size_after: 0, rows_read: rows.length, rows_written: 0, last_row_id: 0, changed_db: false, changes: 0 }, results: rows };
      },
      async first<T = Record<string, unknown>>(): Promise<T | null> {
        const row = statement.get(...values) as T | undefined;
        return row ?? null;
      },
    };
    kinds.set(bound as unknown as D1PreparedStatement, kind);
    return bound as unknown as D1PreparedStatement;
  };
  const d1 = {
    prepare,
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const results: D1Result<T>[] = [];
      raw.exec('BEGIN');
      try {
        for (const statement of statements) {
          if (kinds.get(statement) === 'query') {
            results.push(await statement.all<T>());
          } else {
            results.push(await statement.run<T>());
          }
        }
        raw.exec('COMMIT');
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
      return results;
    },
  } as unknown as D1Database;
  return {
    store: new D1LaunchpadStore(d1, { now: now ?? (() => new Date()) }),
    raw,
    close: () => raw.close(),
  };
}

// ---------------------------------------------------------------------------
// Recorded sandbox transport
// ---------------------------------------------------------------------------

export interface RecordedExchange {
  /** Stable evidence id referenced by the acceptance report. */
  id: string;
  /** HTTP method; omitted matches any method. */
  method?: string;
  /** URL matcher: exact string or RegExp tested against the full URL. */
  url: string | RegExp;
  /** Response status; default 200. */
  status?: number;
  /** JSON response body. */
  json?: unknown;
  /** Raw text response body (health endpoints, malformed JSON cases). */
  text?: string;
  headers?: Record<string, string>;
  /** Number of consecutive matches this exchange serves before the next matching entry wins. */
  times?: number;
}

export type SandboxFault =
  | { kind: 'http'; status: number; body?: unknown }
  | { kind: 'timeout' }
  | { kind: 'network' };

export interface SandboxRequestLogEntry {
  /** Exchange id that served the request; null for faults and unmatched requests. */
  exchangeId: string | null;
  method: string;
  url: string;
  status: number | null;
  /** 1-based count of matches this exchange has served. */
  attempt: number;
  correlationId: string | null;
  idempotencyKey: string | null;
  /** Presence of the authorization header; the token value is never logged. */
  hasAuthorization: boolean;
  body: unknown;
}

function headerValue(headers: Headers | undefined, name: string): string | null {
  if (!headers) return null;
  try {
    return headers.get(name);
  } catch {
    return null;
  }
}

function parseBody(init: RequestInit | undefined): unknown {
  if (init?.body === undefined || init.body === null) return null;
  if (typeof init.body === 'string') {
    try {
      return JSON.parse(init.body) as unknown;
    } catch {
      return init.body;
    }
  }
  return '<non-json-body>';
}

export class SandboxUnmatchedError extends Error {
  constructor(method: string, url: string) {
    super(`LP-RECORDED-SANDBOX-UNMATCHED ${method} ${url}`);
    this.name = 'LP-RECORDED-SANDBOX-UNMATCHED';
  }
}

function matchesUrl(pattern: string | RegExp, url: string): boolean {
  return pattern instanceof RegExp ? pattern.test(url) : url.startsWith(pattern);
}

/**
 * Deterministic recorded transport for the GitHub/Vercel/Cloudflare sandbox
 * APIs. Entries are matched in order; each entry serves `times` consecutive
 * matches (default unlimited). Every request is appended to `log` for
 * evidence and ordering assertions. An unrecorded request throws
 * `SandboxUnmatchedError` — the suite fails loudly instead of fabricating a
 * provider response.
 */
export class RecordedSandboxTransport {
  readonly log: SandboxRequestLogEntry[] = [];
  private readonly entries: Array<{ exchange: RecordedExchange; used: number }>;
  private readonly faults: Array<{ method?: string; url: string | RegExp; fault: SandboxFault; times: number; used: number }> = [];

  constructor(entries: readonly RecordedExchange[]) {
    this.entries = entries.map((exchange) => ({ exchange, used: 0 }));
  }

  /** Injects a deterministic provider fault (timeout, network, or HTTP status) for matching requests. */
  failNext(options: { method?: string; url: string | RegExp; fault: SandboxFault; times?: number }): void {
    this.faults.push({ method: options.method, url: options.url, fault: options.fault, times: options.times ?? 1, used: 0 });
  }

  calls(predicate?: (entry: SandboxRequestLogEntry) => boolean): SandboxRequestLogEntry[] {
    return predicate === undefined ? [...this.log] : this.log.filter(predicate);
  }

  writes(): SandboxRequestLogEntry[] {
    return this.log.filter((entry) => !['GET', 'HEAD', 'OPTIONS'].includes(entry.method));
  }

  clearLog(): void {
    this.log.length = 0;
  }

  readonly fetchImpl: typeof fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
    const correlationId = headerValue(headers, 'x-launchpad-correlation-id');
    const idempotencyKey = headerValue(headers, 'idempotency-key');
    const hasAuthorization = headerValue(headers, 'authorization') !== null;
    const body = parseBody(init);

    const fault = this.faults.find((candidate) => candidate.used < candidate.times
      && (candidate.method === undefined || candidate.method.toUpperCase() === method)
      && matchesUrl(candidate.url, url));
    if (fault) {
      fault.used += 1;
      this.log.push({ exchangeId: null, method, url, status: null, attempt: fault.used, correlationId, idempotencyKey, hasAuthorization, body });
      if (fault.fault.kind === 'timeout') {
        return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
      }
      if (fault.fault.kind === 'network') {
        return Promise.reject(new TypeError('fetch failed'));
      }
      return Promise.resolve(new Response(JSON.stringify(fault.fault.body ?? { error: { message: 'recorded sandbox fault' } }), {
        status: fault.fault.status,
        headers: { 'content-type': 'application/json' },
      }));
    }

    const entry = this.entries.find((candidate) => candidate.used < (candidate.exchange.times ?? Number.POSITIVE_INFINITY)
      && (candidate.exchange.method === undefined || candidate.exchange.method.toUpperCase() === method)
      && matchesUrl(candidate.exchange.url, url));
    if (!entry) {
      this.log.push({ exchangeId: null, method, url, status: null, attempt: 1, correlationId, idempotencyKey, hasAuthorization, body });
      return Promise.reject(new SandboxUnmatchedError(method, url));
    }
    entry.used += 1;
    const status = entry.exchange.status ?? 200;
    this.log.push({ exchangeId: entry.exchange.id, method, url, status, attempt: entry.used, correlationId, idempotencyKey, hasAuthorization, body });
    const text = entry.exchange.text ?? JSON.stringify(entry.exchange.json ?? null);
    return Promise.resolve(new Response(text, { status, headers: { 'content-type': 'application/json', ...entry.exchange.headers } }));
  };
}

/** Deterministic health-check server used for candidate/production/preview health gates. */
export function healthServer(records: ReadonlyArray<{ url?: string | RegExp; status: number; body?: string; headers?: Record<string, string> }>): typeof fetch {
  return async (input) => {
    const url = String(input);
    const match = records.find((record) => record.url === undefined || (record.url instanceof RegExp ? record.url.test(url) : url.startsWith(record.url)));
    const status = match?.status ?? 500;
    return new Response(match?.body ?? '', { status, headers: { 'content-type': 'application/json', ...match?.headers } });
  };
}

// ---------------------------------------------------------------------------
// Composite provider (mirrors apps/controller/src/handlers.ts wiring)
// ---------------------------------------------------------------------------

/** Test-only composition of the two real adapters, matching production wiring exactly. */
export class CompositeProvider implements ProjectProvider, DnsProvider {
  readonly projects: VercelAdapter;
  readonly dns: CloudflareAdapter;

  constructor(projects: VercelAdapter, dns: CloudflareAdapter) {
    this.projects = projects;
    this.dns = dns;
  }

  async capabilities(_ctx?: ProviderContext): Promise<ProviderCapabilities> {
    const [projects, dns] = await Promise.all([this.projects.capabilities(), this.dns.capabilities()]);
    const fields = { ...projects.fields, ...dns.fields };
    return {
      provider: 'vercel',
      adapterVersion: 'composite-v1',
      snapshotHash: await sha256Hex(canonicalJson(fields)),
      features: { ...projects.features, ...dns.features },
      fields,
    };
  }

  observeProject(identity: ProjectIdentity, ctx: ProviderContext): Promise<ObservedResource | null> { return this.projects.observeProject(identity, ctx); }
  ensureProject(spec: ProjectSpec, ctx: ProviderContext): Promise<MutationResult<ObservedResource>> { return this.projects.ensureProject(spec, ctx); }
  ensureGitConnection(spec: GitConnectionSpec, ctx: ProviderContext): Promise<MutationResult<ObservedResource>> { return this.projects.ensureGitConnection(spec, ctx); }
  ensureEnvironment(spec: EnvironmentSpec, ctx: ProviderContext): Promise<MutationResult<ObservedResource>> { return this.projects.ensureEnvironment(spec, ctx); }
  ensureDomain(spec: DomainSpec, ctx: ProviderContext): Promise<MutationResult<ObservedResource>> { return this.projects.ensureDomain(spec, ctx); }
  requiredDnsRecords(domain: DomainSpec, ctx: ProviderContext): Promise<RequiredDnsRecord[]> { return this.projects.requiredDnsRecords(domain, ctx); }
  createDeployment(request: DeploymentRequest, ctx: ProviderContext): Promise<DeploymentRecord> { return this.projects.createDeployment(request, ctx); }
  waitForDeployment(request: DeploymentWaitRequest, ctx: ProviderContext): Promise<DeploymentRecord> { return this.projects.waitForDeployment(request, ctx); }
  promote(request: PromotionRequest, ctx: ProviderContext): Promise<PromotionResult> { return this.projects.promote(request, ctx); }
  rollback(request: RollbackRequest, ctx: ProviderContext): Promise<RollbackResult> { return this.projects.rollback(request, ctx); }
  listOwnedShadowProjects(ctx: ProviderContext): Promise<ObservedResource[]> { return this.projects.listOwnedShadowProjects(ctx); }
  deleteProject(projectId: string, ctx: ProviderContext): Promise<void> { return this.projects.deleteProject(projectId, ctx); }
  findDeploymentByCommit(projectId: string, commitSha: string, ctx: ProviderContext, options?: { expectedRepository?: string | null }): Promise<DeploymentRecord | null> { return this.projects.findDeploymentByCommit(projectId, commitSha, ctx, options); }
  fetchDeploymentLogs(request: DeploymentLogRequest, ctx: ProviderContext): Promise<DeploymentLogExcerpt> { return this.projects.fetchDeploymentLogs(request, ctx); }
  getDomain(projectId: string, hostname: string, ctx: ProviderContext): Promise<ProjectDomainObservation | null> { return this.projects.getDomain(projectId, hostname, ctx); }
  verifyDomain(projectId: string, hostname: string, ctx: ProviderContext): Promise<ProjectDomainObservation> { return this.projects.verifyDomain(projectId, hostname, ctx); }
  getDomainTls(hostname: string, ctx: ProviderContext): Promise<TlsObservation> { return this.projects.getDomainTls(hostname, ctx); }
  removeDomain(projectId: string, hostname: string, ctx: ProviderContext): Promise<void> { return this.projects.removeDomain(projectId, hostname, ctx); }
  deleteDeployment(deploymentId: string, ctx: ProviderContext): Promise<void> { return this.projects.deleteDeployment(deploymentId, ctx); }
  observeZone(zoneRef: string, ctx: ProviderContext) { return this.dns.observeZone(zoneRef, ctx); }
  observeRecord(zoneId: string, hostname: string, ctx: ProviderContext, type?: string) { return this.dns.observeRecord(zoneId, hostname, ctx, type); }
  ensureRecord(zoneId: string, record: RequiredDnsRecord, ownershipFingerprint: string, ctx: ProviderContext) { return this.dns.ensureRecord(zoneId, record, ownershipFingerprint, ctx); }
  verifyAuthoritative(hostname: string, record: RequiredDnsRecord, ctx: ProviderContext, zone?: ZoneObservation) { return this.dns.verifyAuthoritative(hostname, record, ctx, zone); }
  deleteRecord(zoneId: string, recordId: string, ctx: ProviderContext, ownershipFingerprint?: string) { return this.dns.deleteRecord(zoneId, recordId, ctx, ownershipFingerprint); }
  checkProxyCompatibility(request: ProxyCompatibilityRequest, ctx: ProviderContext): Promise<ProxyCompatibilityResult> { return this.dns.checkProxyCompatibility(request, ctx); }
}

// ---------------------------------------------------------------------------
// Acceptance application manifest
// ---------------------------------------------------------------------------

export const ACCEPTANCE_APP_ID = 'acceptance-app';
export const ACCEPTANCE_DOMAIN = 'acceptance.example.com';
export const ACCEPTANCE_ZONE_REF = 'config://cloudflare/acceptance.test';
export const ACCEPTANCE_ZONE_ID = 'zone_acceptance_1';
export const ACCEPTANCE_PROJECT_ID = 'prj_acceptance';
export const ACCEPTANCE_REPOSITORY = 'acme/acceptance-app';
export const ACCEPTANCE_CONTROL_REPOSITORY = 'acme/control';
export const ACCEPTANCE_MANIFEST_PATH = 'catalog/apps/acceptance-app.yaml';
export const ACCEPTANCE_REPOSITORY_ID = 424242;

export function acceptanceManifest(overrides: { domainMode?: 'dns-only' | 'proxied'; rootDirectory?: string } = {}): DesiredApplication {
  const proxied = overrides.domainMode === 'proxied';
  return {
    apiVersion: 'launchpad.dev/v1',
    kind: 'Application',
    metadata: { id: ACCEPTANCE_APP_ID, displayName: 'Acceptance App', owners: ['@platform'], labels: {}, annotations: {} },
    sourcePath: ACCEPTANCE_MANIFEST_PATH,
    repository: {
      provider: 'github',
      name: ACCEPTANCE_REPOSITORY,
      productionBranch: 'main',
      deploymentRef: 'main',
      access: { requirePrivateAccessVerification: true, requireVercelGitAccess: true },
      onboarding: { managedWorkflow: false, workflowVersion: 'v1', openOnboardingPr: false },
    },
    vercel: {
      scope: {},
      project: {
        name: ACCEPTANCE_APP_ID,
        framework: 'nextjs',
        rootDirectory: overrides.rootDirectory ?? '.',
        nodeVersion: '24.x',
        build: { installCommand: 'yarn install', buildCommand: 'yarn build', outputDirectory: null, developmentCommand: null, ignoredBuildStep: null },
        git: { connected: true, productionBranch: 'main' },
        deployment: { autoAssignProductionDomains: false, prioritizeProductionBuilds: true, rollingRelease: null, skewProtection: false },
        regions: { functions: [] },
        protection: {},
        settings: { autoAssignProductionDomains: false },
      },
    },
    environments: {
      preview: {
        enabled: true,
        strategy: 'shadow-project',
        source: { ref: 'main' },
        cleanup: { onPrClose: true, retentionHours: 24 },
        health: { path: '/api/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 2, attempts: 1, intervalSeconds: 0 },
      },
      production: {
        enabled: true,
        health: { path: '/api/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 2, attempts: 1, intervalSeconds: 0 },
        release: { strategy: 'staged-production', promoteExactBuild: true, autoPromoteAfterChecks: true },
        rollback: { enabled: true, onFailedHealthCheck: true, previousKnownGood: true },
      },
    },
    domains: [{
      hostname: ACCEPTANCE_DOMAIN,
      environment: 'production',
      canonical: true,
      cloudflare: {
        zoneRef: ACCEPTANCE_ZONE_REF,
        mode: proxied ? 'proxied' : 'dns-only',
        ttl: 'auto',
        ...(proxied ? { proxy: { acknowledgeDoubleCdn: true, bypassWellKnownPaths: false, verifyConnectingIpHeader: true, cachePolicy: 'standard' } } : {}),
      },
      redirects: [],
    }],
    secrets: [],
    dependencies: { applications: [], external: [] },
    policies: {
      drift: { mode: 'open-pr', checkIntervalMinutes: 30 },
      destructiveChanges: { allowInNormalApply: false },
      preview: { requiredForMerge: true },
      staging: { requiredForProduction: false },
      health: { requiredForPromotion: true },
      failures: { createIssueAfterFinalRetry: true, notifyOwners: true },
    },
    lifecycle: {
      state: 'active',
      deletionProtection: true,
      orphanPolicy: 'retain',
      decommission: { requestedAt: null, deleteAfter: null, approvalToken: null, preserveDeployments: true },
      recoveryPolicy: { allowReactivateBeforeDeletionApproval: false },
    },
  };
}

// ---------------------------------------------------------------------------
// Shared recorded sandbox state (per-scenario recordings)
// ---------------------------------------------------------------------------

/** Recorded Vercel project configuration exactly as the apply machine expects after convergence. */
export function recordedProject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ACCEPTANCE_PROJECT_ID,
    name: ACCEPTANCE_APP_ID,
    framework: 'nextjs',
    rootDirectory: '.',
    nodeVersion: '24.x',
    installCommand: 'yarn install',
    buildCommand: 'yarn build',
    outputDirectory: null,
    developmentCommand: null,
    ignoredBuildStep: null,
    autoAssignProductionDomains: false,
    functions: [],
    settings: { autoAssignProductionDomains: false },
    link: { repo: ACCEPTANCE_REPOSITORY, productionBranch: 'main' },
    domains: [],
    ...overrides,
  };
}

export function recordedZone(): Record<string, unknown> {
  return { id: ACCEPTANCE_ZONE_ID, name: 'acceptance.test', name_servers: ['ns1.acceptance.test', 'ns2.acceptance.test'], status: 'active' };
}

export interface RecordedDnsRecordOptions {
  id?: string;
  name?: string;
  content?: string;
  ttl?: number;
  proxied?: boolean;
  comment?: string | null;
}

export function recordedDnsRecord(options: RecordedDnsRecordOptions = {}): Record<string, unknown> {
  return {
    id: options.id ?? 'dns_acceptance_1',
    name: options.name ?? ACCEPTANCE_DOMAIN,
    type: 'CNAME',
    content: options.content ?? 'acceptance-app.vercel-dns.sandbox.test',
    ttl: options.ttl ?? 1,
    proxied: options.proxied ?? false,
    comment: options.comment ?? null,
  };
}

/** Cloudflare API envelope wrapper. */
export function cfEnvelope(result: unknown): Record<string, unknown> {
  return { success: true, errors: [], messages: [], result };
}

/** Recorded GitHub content response (base64-encoded file). */
export function githubFileContent(content: string): Record<string, unknown> {
  return { type: 'file', encoding: 'base64', content: Buffer.from(content, 'utf8').toString('base64'), sha: 'file_sha_1' };
}

export function commitSha(seed: string): string {
  return seed.repeat(40).slice(0, 40);
}

// ---------------------------------------------------------------------------
// Report redaction helpers
// ---------------------------------------------------------------------------

const RESOURCE_ID_PATTERN = /\b(?:prj|dpl|dns|zone|env|dom)_[A-Za-z0-9_-]+/g;

/** Redacts sandbox resource ids so the report never carries raw provider resource ids. */
export function redactResourceIds(value: string): string {
  return value.replace(RESOURCE_ID_PATTERN, (match) => `${match.split('_')[0]}_<redacted>`);
}

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

export function acceptanceContext(workflowId: string, applicationId = ACCEPTANCE_APP_ID): ProviderContext {
  return {
    correlationId: `acceptance-${workflowId}`,
    applicationId,
    workflowId,
    actor: { kind: 'system', id: 'acceptance' },
    dryRun: false,
  };
}

export const NOOP_SLEEP = async (): Promise<void> => undefined;

/** Bounded DNS resolver with a deterministic propagation delay (empty until `convergesAfter` calls). */
export function delayedResolver(requiredValue: string, convergesAfter: number): DnsResolver {
  let calls = 0;
  return async () => {
    calls += 1;
    return calls >= convergesAfter ? [requiredValue] : [];
  };
}

export const NEVER_RESOLVER: DnsResolver = async () => [];
