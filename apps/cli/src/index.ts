import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog, parseZoneRegistry, ZONE_REGISTRY_FILE, type CatalogIssue } from '@launchpad/catalog';
import { buildPlan, buildResourceGraph, desiredStateHash, renderPlanMarkdown, type DeploymentRecord, type DesiredApplication, type HealthCheckRecord, type ObservedApplication, type ObservedResource, type PlatformPlan, type ResourceGraph } from '@launchpad/core';
import { checkHealth } from '@launchpad/health';
import { artifactFiles, escapeHtml, renderDotGraph, renderFailureStickyComment, renderStickyComment, type HealthSummary, type JobResult, type PreviewSummary, type ProviderErrorSummary } from '@launchpad/github-reporting';
import { boundStickyCommentBody, redactText } from '@launchpad/shared';
import { GitHubAdapter } from '@launchpad/provider-github';
import { CloudflareAdapter } from '@launchpad/provider-cloudflare';
import { VercelAdapter } from '@launchpad/provider-vercel';
import type { ProviderContext } from '@launchpad/provider-contract';

export type CliCommand = 'validate' | 'preflight' | 'plan' | 'status' | 'graph' | 'health' | 'reconcile' | 'logs' | 'preview' | 'report-pr' | 'apply' | 'destroy' | 'app-preview' | 'controller-smoke';
export interface CliArgs { command: CliCommand; flags: Record<string, string | boolean>; }
const knownFlags = new Set(['catalog', 'format', 'output', 'app', 'application', 'sha', 'pr', 'controller', 'approval-token', 'environment', 'dry-run', 'artifacts', 'plans', 'url', 'preview-summary', 'timeout-minutes']);

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const command = argv[0] as CliCommand | undefined;
  const commands: CliCommand[] = ['validate', 'preflight', 'plan', 'status', 'graph', 'health', 'reconcile', 'logs', 'preview', 'report-pr', 'apply', 'destroy', 'app-preview', 'controller-smoke'];
  if (!command || !commands.includes(command)) throw new Error(`Unknown or missing command. Expected one of: ${commands.join(', ')}.`);
  const flags: Record<string, string | boolean> = {};
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith('--')) throw new Error(`Unexpected argument '${argument ?? ''}'.`);
    const key = argument.slice(2);
    if (!knownFlags.has(key)) throw new Error(`Unknown option '--${key}'.`);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) { flags[key] = next; index += 1; } else flags[key] = true;
  }
  return { command, flags };
}

export function formatIssues(issues: readonly CatalogIssue[]): string {
  return issues.map((issue) => `${issue.file}:${issue.line}:${issue.column} ${issue.code} ${issue.path}: ${issue.message}${issue.remediation ? `\n  Remediation: ${issue.remediation}` : ''}`).join('\n');
}

/** Fail-closed error carrying a stable Launchpad code; the code is part of the message so it survives process boundaries. */
class CliFailure extends Error {
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = code;
  }
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;

function exactCommitSha(flags: Record<string, string | boolean>): string {
  const sha = typeof flags.sha === 'string' ? flags.sha : process.env.GITHUB_SHA ?? null;
  if (!sha || !SHA_PATTERN.test(sha)) throw new CliFailure('LP-COMMIT-UNBOUND', 'An exact 40-character commit SHA is required via --sha (or GITHUB_SHA).');
  return sha;
}

function requireStringFlag(flags: Record<string, string | boolean>, key: string, code: string, message: string): string {
  const value = typeof flags[key] === 'string' ? flags[key] : null;
  if (!value) throw new CliFailure(code, message);
  return value;
}

function controllerUrl(flags: Record<string, string | boolean>): string | null {
  return typeof flags.controller === 'string' ? flags.controller : process.env.LAUNCHPAD_CONTROLLER_URL ?? null;
}

function requireController(flags: Record<string, string | boolean>): string {
  const controller = controllerUrl(flags);
  if (!controller) throw new CliFailure('LP-CONTROLLER-UNAVAILABLE', 'A controller URL is required via --controller or LAUNCHPAD_CONTROLLER_URL.');
  return controller;
}

function operationTimeoutMs(flags: Record<string, string | boolean>): number {
  const raw = typeof flags['timeout-minutes'] === 'string' ? flags['timeout-minutes'] : process.env.LAUNCHPAD_OPERATION_TIMEOUT_MINUTES ?? null;
  if (!raw) return 30 * 60_000;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) throw new CliFailure('LP-OPERATION-TIMEOUT-INVALID', '--timeout-minutes must be a positive integer.');
  return parsed * 60_000;
}

/** Explicit operator credential; never derived from ambient workflow OIDC identity. */
function operatorToken(): string | null {
  const token = process.env.LAUNCHPAD_OPERATOR_TOKEN;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * Fetches a GitHub Actions OIDC token and extracts the JWT. The token
 * endpoint returns JSON ({ value, header, expires_at }); a JSON body
 * without a non-empty string `value` fails closed (null) — raw response
 * text is never sent as the Bearer credential. A non-JSON body is only
 * returned verbatim when non-empty and not JSON-shaped, for request-token
 * endpoints that hand back the bare JWT.
 */
async function workflowToken(): Promise<string | null> {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !requestToken) return null;
  const audience = encodeURIComponent(process.env.LAUNCHPAD_OIDC_AUDIENCE ?? 'launchpad');
  const response = await fetch(`${url}${url.includes('?') ? '&' : '?'}audience=${audience}`, { headers: { authorization: `Bearer ${requestToken}` } });
  if (!response.ok) return null;
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { value?: unknown };
    if (typeof body.value === 'string' && body.value.length > 0) return body.value;
    return null;
  } catch {
    // Malformed JSON-looking bodies fail closed; a bare token may already be the raw JWT.
    if (/^[{[]/.test(text.trimStart())) return null;
    return text.length > 0 ? text : null;
  }
}

/** OIDC-authenticated controller calls (preview, apply, app-preview) require a workflow OIDC token. */
async function requireWorkflowToken(): Promise<string> {
  const token = await workflowToken();
  if (!token) throw new CliFailure('LP-CONTROLLER-TOKEN-MISSING', 'A GitHub OIDC token (id-token: write) is required for controller calls.');
  return token;
}

/**
 * Operator-only controller calls (status, logs, reconcile, destroy) are
 * authenticated against the operator middleware, so the explicit
 * LAUNCHPAD_OPERATOR_TOKEN always wins when set — never a workflow OIDC
 * token minted for another identity. Fails closed when absent.
 */
async function requireOperatorToken(): Promise<string> {
  const token = operatorToken();
  if (!token) throw new CliFailure('LP-CONTROLLER-TOKEN-MISSING', 'LAUNCHPAD_OPERATOR_TOKEN is required for operator-only controller calls.');
  return token;
}

/** Unverified claim mirror for request payloads; the controller verifies signature and claim-binding server-side. */
function oidcClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (!payload) return {};
  try {
    const padded = payload.replaceAll('-', '+').replaceAll('_', '/');
    const json = new TextDecoder().decode(Uint8Array.from(atob(`${padded}${'='.repeat((4 - (padded.length % 4)) % 4)}`), (character) => character.charCodeAt(0)));
    const claims = JSON.parse(json) as unknown;
    return claims !== null && typeof claims === 'object' && !Array.isArray(claims) ? claims as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

interface ControllerIdentity { repository: string | null; repositoryId: number | null; ownerId: number | null; workflowRef: string | null; event: string | null; prNumber: number | null; ref: string | null; actor: string | null; }

function controllerIdentity(token: string, flags: Record<string, string | boolean> = {}): ControllerIdentity {
  const claims = oidcClaims(token);
  const integer = (value: unknown): number | null => typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : null;
  const flagPr = typeof flags.pr === 'string' && /^\d+$/.test(flags.pr) ? Number(flags.pr) : null;
  const prNumber = integer(claims.pull_request_number) ?? (process.env.GITHUB_PR_NUMBER && /^\d+$/.test(process.env.GITHUB_PR_NUMBER) ? Number(process.env.GITHUB_PR_NUMBER) : null) ?? flagPr;
  return {
    repository: typeof claims.repository === 'string' ? claims.repository : process.env.GITHUB_REPOSITORY ?? null,
    repositoryId: integer(claims.repository_id),
    ownerId: integer(claims.repository_owner_id),
    workflowRef: typeof claims.workflow_ref === 'string' ? claims.workflow_ref : null,
    event: typeof claims.event_name === 'string' ? claims.event_name : process.env.GITHUB_EVENT_NAME ?? null,
    prNumber: Number.isInteger(prNumber) && (prNumber ?? 0) > 0 ? prNumber : null,
    ref: typeof claims.ref === 'string' ? claims.ref : null,
    actor: typeof claims.actor === 'string' ? claims.actor : null,
  };
}

/**
 * Versioned controller workflow payload per the ingress contract: version,
 * applicationId, sourceCommit (exact PR head SHA), desiredGeneration,
 * planFingerprint, idempotencyKey, plus claim-mirrored repository/PR identity.
 */
function workflowPayload(flags: Record<string, string | boolean>, token: string, applicationId: string, sha: string, plan: PlatformPlan, idempotencyKey: string): Record<string, unknown> {
  const identity = controllerIdentity(token, flags);
  return {
    version: 1,
    applicationId,
    sourceCommit: sha,
    desiredGeneration: plan.desiredGeneration,
    planFingerprint: plan.fingerprint,
    idempotencyKey,
    repository: identity.repository,
    repositoryId: identity.repositoryId,
    ownerId: identity.ownerId,
    workflowRef: identity.workflowRef,
    event: identity.event,
    prNumber: identity.prNumber,
    ref: identity.ref,
    actor: identity.actor,
  };
}

function errorEnvelope(text: string): { code: string; message: string; retryable: boolean } | null {
  try {
    const body = JSON.parse(text) as { error?: { code?: unknown; message?: unknown; retryable?: unknown } };
    if (body?.error && typeof body.error.code === 'string') {
      return { code: body.error.code, message: typeof body.error.message === 'string' ? body.error.message : body.error.code, retryable: body.error.retryable === true };
    }
  } catch {
    // Non-JSON error bodies are reported verbatim by the caller.
  }
  return null;
}

async function controllerRequest(controller: string, path: string, token: string | null, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; text: string }> {
  const response = await fetch(`${controller.replace(/\/$/, '')}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { ok: response.ok, status: response.status, text: await response.text() };
}

async function controllerGet(controller: string, path: string, token: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await fetch(`${controller.replace(/\/$/, '')}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try { body = JSON.parse(text); } catch { body = null; }
  }
  return { ok: response.ok, status: response.status, body };
}

const TERMINAL_OPERATION_STATUSES: Record<string, true> = { SUCCEEDED: true, FAILED: true, BLOCKED: true, ROLLED_BACK: true, CANCELED: true, CLEANED: true, SYNCED: true, READY: true };
const SUCCESS_OPERATION_STATUSES: Record<string, true> = { SUCCEEDED: true, READY: true, CLEANED: true, SYNCED: true };

interface OperationStatus { operationId: string; workflowId: string | null; applicationId: string | null; kind: string | null; status: string; errorCode: string | null; sourceCommit: string | null; result: Record<string, unknown> | null; }

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function fetchOperationStatus(controller: string, operationId: string, token: string): Promise<OperationStatus> {
  const response = await fetch(`${controller.replace(/\/$/, '')}/v1/operations/${encodeURIComponent(operationId)}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await response.text();
  if (!response.ok) {
    const envelope = errorEnvelope(text);
    throw new CliFailure('LP-OPERATION-READ-FAILED', `GET /v1/operations/${operationId} failed with HTTP ${response.status}${envelope ? ` (${envelope.code}: ${escapeHtml(envelope.message)})` : `: ${redactText(text.slice(0, 500))}`}.`);
  }
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    throw new CliFailure('LP-OPERATION-RESPONSE-INVALID', `GET /v1/operations/${operationId} returned a non-JSON response.`);
  }
  const status = stringOrNull(body.status);
  const returnedOperationId = stringOrNull(body.operationId);
  if (!status || !returnedOperationId) throw new CliFailure('LP-OPERATION-RESPONSE-INVALID', `GET /v1/operations/${operationId} is missing operationId or status.`);
  const result = body.result !== null && typeof body.result === 'object' && !Array.isArray(body.result) ? body.result as Record<string, unknown> : null;
  return { operationId: returnedOperationId, workflowId: stringOrNull(body.workflowId), applicationId: stringOrNull(body.applicationId), kind: stringOrNull(body.kind), status, errorCode: stringOrNull(body.errorCode), sourceCommit: stringOrNull(body.sourceCommit), result };
}

/** Polls the claim-scoped operation status route until a terminal state; fails closed on timeout or malformed responses. */
async function pollOperation(controller: string, operationId: string, token: string, timeoutMs: number): Promise<OperationStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: OperationStatus | null = null;
  while (Date.now() < deadline) {
    last = await fetchOperationStatus(controller, operationId, token);
    if (TERMINAL_OPERATION_STATUSES[last.status] === true) return last;
    await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
  }
  throw new CliFailure('LP-OPERATION-TIMEOUT', `Operation ${operationId} did not reach a terminal state within ${Math.round(timeoutMs / 60_000)} minute(s); last status was '${last?.status ?? 'unknown'}'.`);
}

function readCatalogFiles(root: string): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  const workspaceRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) files.push({ path: relative(workspaceRoot, fullPath), content: readFileSync(fullPath, 'utf8') });
    }
  };
  visit(resolve(workspaceRoot, root));
  return files.filter((file) => file.path.includes('/apps/') || file.path.includes('apps/'));
}

/**
 * Reads catalog/zones.yaml from the catalog root and parses it
 * deterministically. The zone registry is required for every production
 * catalog load: a missing or malformed registry fails closed with the
 * registry path as file context.
 */
function readZoneRegistry(root: string): string[] {
  const workspaceRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  const fullPath = resolve(workspaceRoot, root, ZONE_REGISTRY_FILE);
  const registryPath = relative(workspaceRoot, fullPath);
  let content: string;
  try {
    content = readFileSync(fullPath, 'utf8');
  } catch (error) {
    throw new CliFailure('LP-ZONE-REGISTRY-MISSING', `The zone registry ${registryPath} could not be read: ${error instanceof Error ? error.message : 'unreadable file'}.`);
  }
  const parsed = parseZoneRegistry(content, registryPath);
  if (parsed.issues.length > 0) throw new CliFailure('LP-ZONE-REGISTRY-INVALID', formatIssues(parsed.issues));
  return parsed.zones;
}

function emptyObserved(applicationId: string): ObservedApplication {
  return { applicationId, observedAt: new Date().toISOString(), desiredGeneration: 0, desiredHash: '', observedHash: '', resources: [], deployments: [], health: { status: 'UNKNOWN', latest: null } };
}

/** Real observed state assembled from live provider responses; absence of a project/deployment is a genuine observation, never fabricated. */
function observedFrom(application: DesiredApplication, project: ObservedResource | null, deployment: DeploymentRecord | null): ObservedApplication {
  return {
    applicationId: application.metadata.id,
    observedAt: new Date().toISOString(),
    desiredGeneration: 0,
    desiredHash: '',
    observedHash: '',
    resources: project ? [project] : [],
    deployments: deployment ? [deployment] : [],
    health: { status: 'UNKNOWN', latest: null },
  };
}

interface PlanAdapters { github: GitHubAdapter; vercel: VercelAdapter; }

function providerPlanAdapters(): PlanAdapters {
  const githubToken = process.env.LAUNCHPAD_GITHUB_TOKEN;
  const vercelToken = process.env.LAUNCHPAD_VERCEL_TOKEN;
  if (!githubToken || !vercelToken) throw new CliFailure('LP-PROVIDER-STATE-UNAVAILABLE', 'Planning requires live provider state: set LAUNCHPAD_GITHUB_TOKEN and LAUNCHPAD_VERCEL_TOKEN (read-only credentials).');
  return { github: new GitHubAdapter({ token: githubToken }), vercel: new VercelAdapter({ token: vercelToken, ...(process.env.LAUNCHPAD_VERCEL_TEAM_ID ? { teamId: process.env.LAUNCHPAD_VERCEL_TEAM_ID } : {}) }) };
}

function providerContext(applicationId: string, flags: Record<string, string | boolean>): ProviderContext {
  return { correlationId: `cli-${Date.now()}`, applicationId, workflowId: 'cli', actor: { kind: 'operator', id: 'cli' }, dryRun: flags['dry-run'] === true };
}

function readPlansFile(path: string): PlatformPlan[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new CliFailure('LP-PLANS-FILE-INVALID', `Could not parse plans file '${path}': ${error instanceof Error ? error.message : 'invalid JSON'}.`);
  }
  const plans = Array.isArray(parsed) ? parsed : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { plans?: unknown }).plans) ? (parsed as { plans: unknown[] }).plans : null;
  if (!plans) throw new CliFailure('LP-PLANS-FILE-INVALID', `Plans file '${path}' must be a plan array or { plans: [...] }.`);
  return plans.map((plan, index) => {
    const record = plan !== null && typeof plan === 'object' ? plan as Record<string, unknown> : {};
    if (typeof record.applicationId !== 'string' || typeof record.sourceCommit !== 'string' || typeof record.fingerprint !== 'string') {
      throw new CliFailure('LP-PLANS-FILE-INVALID', `Plans file '${path}' entry ${index} is missing applicationId, sourceCommit, or fingerprint.`);
    }
    return record as unknown as PlatformPlan;
  });
}

/** Recursive first match for a basename under an artifact directory (download-artifact nests by artifact name). */
function findArtifact(root: string, basename: string): string | null {
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findArtifact(fullPath, basename);
      if (found) return found;
    } else if (entry.isFile() && entry.name === basename) {
      return fullPath;
    }
  }
  return null;
}

function readOptionalJson(path: string | null): Record<string, unknown> | null {
  if (!path) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Extracts the safe provider-error summary; anything missing or malformed degrades to null (never a fabricated error). */
function providerErrorSummary(error: Record<string, unknown> | null): ProviderErrorSummary | null {
  if (!error || typeof error.code !== 'string' || error.code.length === 0) return null;
  return { code: error.code, message: typeof error.message === 'string' ? error.message : error.code, operationId: stringOrNull(error.operationId), retryable: error.retryable === true };
}

function previewSummaries(summary: Record<string, unknown> | null): PreviewSummary[] {
  const previews: PreviewSummary[] = [];
  if (!summary) return previews;
  const entries = Array.isArray(summary.applications) ? summary.applications : [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.applicationId !== 'string' || typeof record.state !== 'string') continue;
    previews.push({ state: record.state as PreviewSummary['state'], url: stringOrNull(record.url), message: typeof record.message === 'string' ? record.message : '' });
  }
  return previews;
}

function healthSummaries(results: Record<string, unknown> | null): HealthSummary[] {
  const healths: HealthSummary[] = [];
  if (!results) return healths;
  const entries = Array.isArray(results.applications) ? results.applications : [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const health = record.result !== null && typeof record.result === 'object' ? record.result as Record<string, unknown> : null;
    if (!health || typeof health.result !== 'string') continue;
    healths.push({ state: health.result as HealthSummary['state'], message: health.errorCode ? `errorCode ${health.errorCode}` : health.result === 'PASSED' ? 'Health check passed.' : 'Health check failed.' });
  }
  return healths;
}

/**
 * Strictly parses the explicit upstream job results written by the
 * validate-plan summary workflow. Absent file degrades to null; a present
 * but malformed file fails closed so a broken workflow can never masquerade
 * as green.
 */
function readJobResults(path: string | null): JobResult[] | null {
  if (!path) return null;
  const parsed = readOptionalJson(path);
  if (parsed === null) throw new CliFailure('LP-JOB-RESULTS-INVALID', `Could not parse job results '${path}'.`);
  const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : null;
  if (jobs === null || jobs.length === 0) throw new CliFailure('LP-JOB-RESULTS-INVALID', `Job results '${path}' must contain a non-empty 'jobs' array.`);
  const results: JobResult[] = [];
  for (const job of jobs) {
    if (job === null || typeof job !== 'object' || Array.isArray(job)) throw new CliFailure('LP-JOB-RESULTS-INVALID', `Job results '${path}' contain a malformed job entry.`);
    const entry = job as Record<string, unknown>;
    if (typeof entry.name !== 'string' || entry.name.length === 0 || typeof entry.result !== 'string' || entry.result.length === 0) {
      throw new CliFailure('LP-JOB-RESULTS-INVALID', `Job results '${path}' contain a job without a name and result.`);
    }
    results.push({ name: entry.name, result: entry.result });
  }
  return results;
}

/** Stable link to the workflow run that produced the report, when running in GitHub Actions. */
function reportRunUrl(repository: string): string | null {
  const serverUrl = process.env.GITHUB_SERVER_URL;
  const runId = process.env.GITHUB_RUN_ID;
  if (!serverUrl || !runId || !/^https:\/\//i.test(serverUrl)) return null;
  return `${serverUrl.replace(/\/+$/, '')}/${repository}/actions/runs/${runId}`;
}

function writePreviewSummary(output: string | null, sha: string, applications: readonly PreviewSummary[]): void {
  if (!output) return;
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'preview-summary.json'), JSON.stringify({ sourceCommit: sha, applications }, null, 2));
}

async function buildPlans(applications: readonly DesiredApplication[], sha: string, flags: Record<string, string | boolean>): Promise<{ plans: PlatformPlan[]; graphs: ResourceGraph[]; providerState: Record<string, unknown> }> {
  const adapters = providerPlanAdapters();
  const plans: PlatformPlan[] = [];
  const graphs: ResourceGraph[] = [];
  const providerState: Record<string, unknown> = {};
  for (const application of applications) {
    const context = providerContext(application.metadata.id, flags);
    const repository = await adapters.github.observeRepository(application.repository.name, context);
    if (repository.archived || !repository.access) throw new CliFailure('LP-GITHUB-REPO-INACCESSIBLE', `Repository ${application.repository.name} is archived or not accessible.`);
    const root = await adapters.github.hasPath(application.repository.name, application.repository.deploymentRef, application.vercel.project.rootDirectory, context);
    if (root === 'missing') throw new CliFailure('LP-GITHUB-ROOT-MISSING', `Root directory '${application.vercel.project.rootDirectory}' does not exist in ${application.repository.name}@${application.repository.deploymentRef}.`);
    const capabilities = await adapters.vercel.capabilities();
    const project = await adapters.vercel.observeProject({ projectId: application.metadata.id }, context);
    const deployment = project === null ? null : await adapters.vercel.findDeploymentByCommit(application.metadata.id, sha, context);
    const observed = observedFrom(application, project, deployment);
    plans.push(await buildPlan({ desired: application, observed, capabilities, sourceCommit: sha, desiredGeneration: 1 }));
    graphs.push(buildResourceGraph(application, observed));
    providerState[application.metadata.id] = { repository: { id: repository.repositoryId, archived: repository.archived, defaultBranch: repository.defaultBranch }, root, project: project?.configuration ?? null, deployment: deployment ?? null };
  }
  return { plans, graphs, providerState };
}

async function writePlanArtifacts(output: string | null, plans: PlatformPlan[], graphs: ResourceGraph[], providerState: Record<string, unknown>): Promise<void> {
  if (!output) return;
  mkdirSync(output, { recursive: true });
  const artifacts = artifactFiles({ plans, resourceGraphs: graphs, providerState });
  for (const [name, content] of Object.entries(artifacts)) writeFileSync(join(output, name), content);
}

export async function runCli(argv: readonly string[], output: { write(value: string): void } = process.stdout): Promise<number> {
  const args = parseCliArgs(argv);

  if (args.command === 'app-preview') {
    const applicationId = requireStringFlag(args.flags, 'application', 'LP-APPLICATION-MISSING', '--application is required for app-preview.');
    const sha = exactCommitSha(args.flags);
    const controller = requireController(args.flags);
    const token = await requireWorkflowToken();
    const identity = controllerIdentity(token, args.flags);
    const response = await controllerRequest(controller, `/v1/applications/${encodeURIComponent(applicationId)}/preview/verify`, token, {
      version: 1,
      applicationId,
      sourceCommit: sha,
      idempotencyKey: `app-preview:${applicationId}:${sha}`,
      repository: identity.repository,
      repositoryId: identity.repositoryId,
      ownerId: identity.ownerId,
      workflowRef: identity.workflowRef,
      event: identity.event,
      prNumber: identity.prNumber,
      ref: identity.ref,
      actor: identity.actor,
    });
    if (response.status !== 202) throw new CliFailure('LP-PREVIEW-START-REJECTED', `Preview start was rejected with HTTP ${response.status}: ${redactText(response.text)}`);
    let accepted: { workflowId?: unknown; operationId?: unknown; status?: unknown };
    try { accepted = JSON.parse(response.text) as typeof accepted; } catch { throw new CliFailure('LP-PREVIEW-START-INVALID', `Preview start returned non-JSON: ${redactText(response.text)}`); }
    const operationId = stringOrNull(accepted.operationId);
    if (!operationId) throw new CliFailure('LP-PREVIEW-START-INVALID', 'Preview start response is missing operationId.');
    const operation = await pollOperation(controller, operationId, token, operationTimeoutMs(args.flags));
    if (!SUCCESS_OPERATION_STATUSES[operation.status]) throw new CliFailure('LP-PREVIEW-FAILED', `Preview workflow ended in ${operation.status}${operation.errorCode ? ` (${operation.errorCode})` : ''}.`);
    const result = operation.result ?? {};
    const previewUrl = stringOrNull(result.previewUrl);
    if (!previewUrl || !/^https?:\/\//i.test(previewUrl)) throw new CliFailure('LP-PREVIEW-RESULT-INCOMPLETE', `Preview operation ${operationId} succeeded without a previewUrl.`);
    if (operation.sourceCommit !== sha) throw new CliFailure('LP-PREVIEW-RESULT-INCOMPLETE', `Preview operation ${operationId} is bound to commit ${operation.sourceCommit ?? '(none)'}; expected ${sha}.`);
    const summary = { workflowId: operation.workflowId, operationId, status: operation.status, sourceCommit: operation.sourceCommit, previewUrl, buildState: result.buildState ?? null, healthState: result.healthState ?? null };
    const printable = { ...summary, buildState: stringOrNull(result.buildState), healthState: stringOrNull(result.healthState) };
    output.write(`${JSON.stringify(printable, null, 2)}\n`);
    if (typeof args.flags.output === 'string') {
      mkdirSync(args.flags.output, { recursive: true });
      writeFileSync(join(args.flags.output, 'preview-result.json'), JSON.stringify(summary, null, 2));
    }
    return 0;
  }

  const catalogPath = typeof args.flags.catalog === 'string' ? args.flags.catalog : 'catalog';
  const result = loadCatalog(readCatalogFiles(catalogPath), { zones: readZoneRegistry(catalogPath) });

  if (args.command === 'validate') {
    if (args.flags.format === 'json') output.write(`${JSON.stringify({ valid: result.issues.length === 0, applications: result.applications.map((application) => application.metadata.id), issues: result.issues }, null, 2)}\n`);
    else output.write(result.issues.length === 0 ? `Catalog valid: ${result.applications.length} application(s).\n` : `${formatIssues(result.issues)}\n`);
    return result.issues.length === 0 ? 0 : 1;
  }

  if (args.command === 'status') {
    const controller = requireController(args.flags);
    const token = await requireOperatorToken();
    const list = await controllerGet(controller, '/v1/applications', token);
    if (!list.ok) throw new CliFailure('LP-CONTROLLER-RESPONSE-INVALID', `GET /v1/applications failed with HTTP ${list.status}.`);
    const applications = Array.isArray((list.body as { applications?: unknown } | null)?.applications) ? (list.body as { applications: Array<Record<string, unknown>> }).applications : [];
    const rows = [];
    for (const entry of applications) {
      const applicationId = stringOrNull(entry.id) ?? stringOrNull(entry.applicationId);
      if (!applicationId) continue;
      const detail = await controllerGet(controller, `/v1/applications/${encodeURIComponent(applicationId)}`, token);
      if (!detail.ok) throw new CliFailure('LP-CONTROLLER-RESPONSE-INVALID', `GET /v1/applications/${applicationId} failed with HTTP ${detail.status}.`);
      const operations = Array.isArray((detail.body as { operations?: unknown } | null)?.operations) ? (detail.body as { operations: Array<Record<string, unknown>> }).operations : [];
      const active = operations.find((operation) => typeof operation.status === 'string' && !TERMINAL_OPERATION_STATUSES[operation.status]);
      const latest = operations.find((operation) => typeof operation.status === 'string' && TERMINAL_OPERATION_STATUSES[operation.status] === true);
      const health = await controllerGet(controller, `/v1/applications/${encodeURIComponent(applicationId)}/health`, token);
      if (!health.ok) throw new CliFailure('LP-CONTROLLER-RESPONSE-INVALID', `GET /v1/applications/${applicationId}/health failed with HTTP ${health.status}.`);
      const deployments = await controllerGet(controller, `/v1/applications/${encodeURIComponent(applicationId)}/deployments`, token);
      if (!deployments.ok) throw new CliFailure('LP-CONTROLLER-RESPONSE-INVALID', `GET /v1/applications/${applicationId}/deployments failed with HTTP ${deployments.status}.`);
      const deploymentList = Array.isArray((deployments.body as { deployments?: unknown } | null)?.deployments) ? (deployments.body as { deployments: Array<Record<string, unknown>> }).deployments : [];
      const current = deploymentList.find((deployment) => deployment.state === 'CURRENT' || deployment.state === 'READY');
      rows.push({
        application: applicationId,
        owner: typeof entry.owner === 'string' ? entry.owner : null,
        sync: active ? 'IN_PROGRESS' : latest ? (latest.status === 'SUCCEEDED' || latest.status === 'SYNCED' || latest.status === 'READY' ? 'SYNCED' : 'OUT_OF_SYNC') : 'UNKNOWN',
        health: typeof (health.body as { checks?: unknown } | null)?.checks !== 'undefined' ? (((health.body as { checks: Array<Record<string, unknown>> }).checks[0]?.result) as string | null) ?? 'UNKNOWN' : 'UNKNOWN',
        deployment: stringOrNull(current?.url),
        productionUrl: stringOrNull(entry.productionUrl) ?? stringOrNull(current?.url),
      });
    }
    output.write(`${JSON.stringify({ applications: rows }, null, 2)}\n`);
    return 0;
  }

  if (args.command === 'report-pr') {
    const repository = process.env.GITHUB_REPOSITORY;
    const token = process.env.GITHUB_TOKEN;
    const pullRequestNumber = Number(process.env.GITHUB_PR_NUMBER ?? args.flags.pr ?? 0);
    const artifactsDir = requireStringFlag(args.flags, 'artifacts', 'LP-ARTIFACT-MISSING', '--artifacts <dir> with the plan/preview/health job outputs is required for report-pr.');
    if (!repository || !token || !Number.isInteger(pullRequestNumber) || pullRequestNumber <= 0) throw new CliFailure('LP-PR-CONTEXT-MISSING', 'GITHUB_REPOSITORY, GITHUB_TOKEN, and a PR number are required for report-pr.');
    const reportApplicationId = (typeof args.flags.app === 'string' ? result.applications.find((candidate) => candidate.metadata.id === args.flags.app) : null)?.metadata.id ?? result.applications[0]?.metadata.id ?? 'report';
    const previews = previewSummaries(readOptionalJson(findArtifact(artifactsDir, 'preview-summary.json')));
    const healths = healthSummaries(readOptionalJson(findArtifact(artifactsDir, 'health-results.json')));
    const providerError = providerErrorSummary(readOptionalJson(findArtifact(artifactsDir, 'provider-error-redacted.json')));
    const plansFile = findArtifact(artifactsDir, 'plans.json');
    let body: string;
    let failed = false;
    if (plansFile) {
      const plans = readPlansFile(plansFile);
      body = renderStickyComment({ plans, previews, healths, providerError });
    } else {
      const jobs = readJobResults(findArtifact(artifactsDir, 'job-results.json'));
      if (jobs === null) throw new CliFailure('LP-ARTIFACT-MISSING', `No plans.json found under '${artifactsDir}'; the plan job must publish its artifacts (or the summary job its job-results.json) first.`);
      body = renderFailureStickyComment({ jobs, previews, healths, providerError });
      failed = true;
    }
    body = boundStickyCommentBody(body, reportRunUrl(repository));
    const github = new GitHubAdapter({ token });
    const reported = await github.upsertPullRequestComment({ repository, pullRequestNumber, marker: '<!-- launchpad:plan -->', body }, providerContext(reportApplicationId, args.flags));
    if (typeof args.flags.output === 'string') {
      mkdirSync(args.flags.output, { recursive: true });
      writeFileSync(join(args.flags.output, 'launchpad-comment.md'), body);
    }
    output.write(`Launchpad PR comment: ${reported.url}\n`);
    return failed ? 1 : 0;
  }

  if (result.issues.length > 0) { output.write(`${formatIssues(result.issues)}\n`); return 1; }

  const selected = typeof args.flags.app === 'string' ? result.applications.filter((application) => application.metadata.id === args.flags.app) : result.applications;
  if (selected.length === 0) { output.write('No matching applications.\n'); return 1; }
  const application = selected[0];
  if (!application) { output.write('No matching applications.\n'); return 1; }

  if (args.command === 'preflight') {
    const githubToken = process.env.LAUNCHPAD_GITHUB_TOKEN;
    const vercelToken = process.env.LAUNCHPAD_VERCEL_TOKEN;
    const cloudflareToken = process.env.LAUNCHPAD_CLOUDFLARE_TOKEN;
    if (!githubToken || !vercelToken || !cloudflareToken) throw new CliFailure('LP-PROVIDER-STATE-UNAVAILABLE', 'Provider preflight requires GitHub, Vercel, and Cloudflare runtime credentials.');
    const github = new GitHubAdapter({ token: githubToken });
    const vercel = new VercelAdapter({ token: vercelToken, ...(process.env.LAUNCHPAD_VERCEL_TEAM_ID ? { teamId: process.env.LAUNCHPAD_VERCEL_TEAM_ID } : {}) });
    const cloudflare = new CloudflareAdapter({ token: cloudflareToken });
    const evidence: Array<Record<string, unknown>> = [];
    for (const preflightApplication of selected) {
      const context = providerContext(preflightApplication.metadata.id, args.flags);
      const repository = await github.observeRepository(preflightApplication.repository.name, context);
      if (repository.archived || !repository.access) throw new CliFailure('LP-GITHUB-REPO-INACCESSIBLE', `${preflightApplication.repository.name}`);
      const root = await github.hasPath(preflightApplication.repository.name, preflightApplication.repository.deploymentRef, preflightApplication.vercel.project.rootDirectory, context);
      if (root === 'missing') throw new CliFailure('LP-GITHUB-ROOT-MISSING', `${preflightApplication.vercel.project.rootDirectory}`);
      const project = await vercel.observeProject({ projectId: preflightApplication.metadata.id }, context);
      const zones: Array<{ zoneId: string; name: string; status: string }> = [];
      for (const domain of preflightApplication.domains) {
        const zone = await cloudflare.observeZone(domain.cloudflare.zoneRef, context);
        zones.push({ zoneId: zone.zoneId, name: zone.name, status: zone.status });
      }
      evidence.push({ applicationId: preflightApplication.metadata.id, repository: { id: repository.repositoryId, archived: repository.archived, defaultBranch: repository.defaultBranch }, root, projectExists: project !== null, zones });
    }
    if (args.flags.format === 'json') output.write(`${JSON.stringify({ applications: evidence }, null, 2)}\n`);
    else output.write(`Provider preflight passed for ${selected.length} application(s).\n`);
    return 0;
  }

  if (args.command === 'plan') {
    const sha = exactCommitSha(args.flags);
    const { plans, graphs, providerState } = await buildPlans(selected, sha, args.flags);
    await writePlanArtifacts(typeof args.flags.output === 'string' ? args.flags.output : null, plans, graphs, providerState);
    const content = args.flags.format === 'json' ? JSON.stringify(plans, null, 2) : plans.map(renderPlanMarkdown).join('\n');
    output.write(`${content}\n`);
    return plans.some((plan) => plan.result !== 'READY') ? 1 : 0;
  }

  if (args.command === 'graph') {
    const graphs = selected.map((selectedApplication) => buildResourceGraph(selectedApplication, emptyObserved(selectedApplication.metadata.id)));
    const content = JSON.stringify(graphs, null, 2);
    if (typeof args.flags.output === 'string') {
      mkdirSync(args.flags.output, { recursive: true });
      writeFileSync(join(args.flags.output, 'resource-graph.json'), content);
      writeFileSync(join(args.flags.output, 'resource-graph.dot'), renderDotGraph(graphs));
    } else output.write(`${content}\n`);
    return 0;
  }

  if (args.command === 'preview') {
    const sha = exactCommitSha(args.flags);
    const controller = requireController(args.flags);
    const token = await requireWorkflowToken();
    const plansFile = requireStringFlag(args.flags, 'plans', 'LP-PLANS-FILE-MISSING', '--plans <file> with the plan job output is required for preview.');
    const plans = readPlansFile(plansFile);
    const timeoutMs = operationTimeoutMs(args.flags);
    const previews: PreviewSummary[] = [];
    const providerErrors: ProviderErrorSummary[] = [];
    for (const previewApplication of selected) {
      const plan = plans.find((candidate) => candidate.applicationId === previewApplication.metadata.id);
      if (!plan) throw new CliFailure('LP-PLAN-MISMATCH', `No plan for application '${previewApplication.metadata.id}' in ${plansFile}.`);
      if (plan.sourceCommit !== sha) throw new CliFailure('LP-PLAN-COMMIT-MISMATCH', `Plan for '${previewApplication.metadata.id}' is bound to ${plan.sourceCommit}; expected ${sha}.`);
      if (plan.result !== 'READY') throw new CliFailure('LP-PLAN-NOT-READY', `Plan for '${previewApplication.metadata.id}' is ${plan.result}; previews require a READY plan.`);
      // Plan-approval gate: record the reviewed-plan attestation at the exact
      // PR head with the real plan and desired-state binding before any
      // preview is provisioned. The controller recomputes the review
      // fingerprint from the submitted plan (never trusting a client value),
      // verifies the PR head server-side, and persists idempotently.
      const identity = controllerIdentity(token, args.flags);
      const review = await controllerRequest(controller, '/v1/plans/verify', token, {
        version: 1,
        applicationId: previewApplication.metadata.id,
        sourceCommit: sha,
        desiredGeneration: plan.desiredGeneration,
        planFingerprint: plan.fingerprint,
        desiredHash: await desiredStateHash(previewApplication),
        plan,
        repository: identity.repository,
        repositoryId: identity.repositoryId,
        ownerId: identity.ownerId,
        workflowRef: identity.workflowRef,
        event: identity.event,
        prNumber: identity.prNumber,
        ref: identity.ref,
        actor: identity.actor,
      });
      if (review.status !== 200) {
        const envelope = errorEnvelope(review.text);
        throw new CliFailure('LP-PLAN-REVIEW-REJECTED', `Plan review for '${previewApplication.metadata.id}' was rejected with HTTP ${review.status}${envelope ? ` (${envelope.code}: ${escapeHtml(envelope.message)})` : `: ${redactText(review.text)}`}.`);
      }
      if (previewApplication.environments.preview?.enabled === false) {
        previews.push({ state: 'NOT_RUN', url: null, message: 'Preview is disabled for this application.' });
        continue;
      }
      const idempotencyKey = `preview:${previewApplication.metadata.id}:${sha}:${plan.desiredGeneration}`;
      // The catalog preview carries the loaded DesiredApplication so the
      // controller dispatches the shadow-preview machine (kind `preview`)
      // with the full proposed configuration, not the app-repository
      // status gate.
      const body = { ...workflowPayload(args.flags, token, previewApplication.metadata.id, sha, plan, idempotencyKey), desired: previewApplication };
      const start = await controllerRequest(controller, `/v1/applications/${encodeURIComponent(previewApplication.metadata.id)}/preview/verify`, token, body);
      if (start.status !== 202) {
        const envelope = errorEnvelope(start.text);
        throw new CliFailure('LP-PREVIEW-START-REJECTED', `Preview start for '${previewApplication.metadata.id}' was rejected with HTTP ${start.status}${envelope ? ` (${envelope.code}: ${escapeHtml(envelope.message)})` : `: ${redactText(start.text)}`}.`);
      }
      let accepted: { workflowId?: unknown; operationId?: unknown; status?: unknown };
      try { accepted = JSON.parse(start.text) as typeof accepted; } catch { throw new CliFailure('LP-PREVIEW-START-INVALID', `Preview start for '${previewApplication.metadata.id}' returned non-JSON: ${redactText(start.text)}`); }
      if (accepted.status !== 'QUEUED') throw new CliFailure('LP-PREVIEW-START-INVALID', `Preview start for '${previewApplication.metadata.id}' did not report status QUEUED.`);
      const operationId = stringOrNull(accepted.operationId);
      if (!operationId) throw new CliFailure('LP-PREVIEW-START-INVALID', `Preview start for '${previewApplication.metadata.id}' is missing operationId.`);
      const operation = await pollOperation(controller, operationId, token, timeoutMs);
      if (!SUCCESS_OPERATION_STATUSES[operation.status]) {
        const message = `Preview workflow ended in ${operation.status}${operation.errorCode ? ` (${operation.errorCode})` : ''}.`;
        providerErrors.push({ code: operation.errorCode ?? `LP-PREVIEW-${operation.status}`, message, operationId: operation.operationId, retryable: null });
        previews.push({ state: operation.status === 'CANCELED' ? 'CANCELED' : 'ERROR', url: null, message });
        continue;
      }
      const result = operation.result ?? {};
      const previewUrl = stringOrNull(result.previewUrl);
      if (!previewUrl || !/^https?:\/\//i.test(previewUrl)) throw new CliFailure('LP-PREVIEW-RESULT-INCOMPLETE', `Preview operation ${operationId} for '${previewApplication.metadata.id}' succeeded without a previewUrl.`);
      if (operation.sourceCommit !== sha) throw new CliFailure('LP-PREVIEW-RESULT-INCOMPLETE', `Preview operation ${operationId} for '${previewApplication.metadata.id}' is bound to commit ${operation.sourceCommit ?? '(none)'}; expected ${sha}.`);
      const buildState = stringOrNull(result.buildState);
      const healthState = stringOrNull(result.healthState);
      if (!buildState || !healthState) throw new CliFailure('LP-PREVIEW-RESULT-INCOMPLETE', `Preview operation ${operationId} for '${previewApplication.metadata.id}' is missing buildState or healthState.`);
      const passed = buildState === 'READY' && healthState === 'PASSED';
      previews.push({ state: passed ? 'READY' : 'ERROR', url: previewUrl, message: `Build ${buildState}; health ${healthState}.` });
    }
    const outputDir = typeof args.flags.output === 'string' ? args.flags.output : null;
    writePreviewSummary(outputDir, sha, previews);
    if (providerErrors.length > 0 && outputDir) {
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(join(outputDir, 'provider-error-redacted.json'), JSON.stringify(providerErrors.map((error) => ({ code: error.code, message: redactText(error.message), operationId: error.operationId, retryable: error.retryable })), null, 2));
    }
    output.write(`${JSON.stringify({ sourceCommit: sha, applications: previews }, null, 2)}\n`);
    return previews.every((preview) => preview.state === 'READY' || preview.state === 'NOT_RUN') ? 0 : 1;
  }

  if (args.command === 'health') {
    const sha = exactCommitSha(args.flags);
    const url = typeof args.flags.url === 'string' ? args.flags.url : null;
    const previewSummaryFile = typeof args.flags['preview-summary'] === 'string' ? args.flags['preview-summary'] : null;
    const requestedEnvironment = typeof args.flags.environment === 'string' ? args.flags.environment : 'preview';
    if (!['preview', 'staging', 'production'].includes(requestedEnvironment)) {
      throw new CliFailure('LP-ENVIRONMENT-INVALID', `Health environment '${requestedEnvironment}' must be preview, staging, or production.`);
    }
    const environment = requestedEnvironment as 'preview' | 'staging' | 'production';
    if (previewSummaryFile && environment !== 'preview') {
      throw new CliFailure('LP-ENVIRONMENT-INVALID', '--preview-summary can only be used with the preview environment.');
    }
    if (!url && !previewSummaryFile) throw new CliFailure('LP-PREVIEW-URL-MISSING', 'Health requires --url <deployment-url> or --preview-summary <file> with the preview deployment URL(s).');
    const targets: Array<{ applicationId: string; url: string }> = [];
    if (url) {
      if (!/^https?:\/\//i.test(url)) throw new CliFailure('LP-PREVIEW-URL-MISSING', `Health URL '${url}' is not an http(s) URL.`);
      targets.push({ applicationId: application.metadata.id, url });
    } else if (previewSummaryFile) {
      const summary = readOptionalJson(previewSummaryFile);
      if (!summary) throw new CliFailure('LP-PREVIEW-URL-MISSING', `Could not read preview summary '${previewSummaryFile}'.`);
      const entries = Array.isArray((summary as { applications?: unknown }).applications) ? (summary as { applications: Array<Record<string, unknown>> }).applications : [];
      for (const entry of entries) {
        const entryUrl = stringOrNull(entry.url);
        if (!entryUrl || !/^https?:\/\//i.test(entryUrl)) {
          if (entry.state === 'NOT_RUN') continue;
          throw new CliFailure('LP-PREVIEW-URL-MISSING', `Preview summary entry '${String(entry.applicationId ?? 'unknown')}' has no deployment URL; health cannot run.`);
        }
        targets.push({ applicationId: typeof entry.applicationId === 'string' ? entry.applicationId : application.metadata.id, url: entryUrl });
      }
      if (targets.length === 0) throw new CliFailure('LP-PREVIEW-URL-MISSING', `Preview summary '${previewSummaryFile}' contains no deployment URLs.`);
    }
    const records: Array<{ applicationId: string; url: string; result: HealthCheckRecord }> = [];
    for (const target of targets) {
      const targetApplication = result.applications.find((candidate) => candidate.metadata.id === target.applicationId) ?? application;
      const targetEnvironment = targetApplication.environments[environment];
      if (!targetEnvironment?.enabled) {
        throw new CliFailure('LP-ENVIRONMENT-NOT-CONFIGURED', `Application '${target.applicationId}' does not enable the '${environment}' environment.`);
      }
      const spec = targetEnvironment.health ?? { path: '/api/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 10, attempts: 1, intervalSeconds: 0 };
      const record = await checkHealth({ applicationId: target.applicationId, environment, deploymentId: null, baseUrl: target.url, spec });
      records.push({ applicationId: target.applicationId, url: target.url, result: record });
    }
    if (typeof args.flags.output === 'string') {
      mkdirSync(args.flags.output, { recursive: true });
      writeFileSync(join(args.flags.output, 'health-results.json'), JSON.stringify({ sourceCommit: sha, applications: records }, null, 2));
    }
    output.write(`${JSON.stringify({ sourceCommit: sha, applications: records }, null, 2)}\n`);
    return records.every((entry) => entry.result.result === 'PASSED') ? 0 : 1;
  }

  if (args.command === 'reconcile' && args.flags['dry-run'] === true) {
    const sha = exactCommitSha(args.flags);
    const { plans } = await buildPlans(selected, sha, args.flags);
    output.write(`${JSON.stringify(plans, null, 2)}\n`);
    return 0;
  }

  if (args.command === 'logs') {
    const controller = requireController(args.flags);
    const token = await requireOperatorToken();
    const response = await controllerGet(controller, `/v1/applications/${encodeURIComponent(application.metadata.id)}/operations`, token);
    if (!response.ok) throw new CliFailure('LP-CONTROLLER-RESPONSE-INVALID', `GET /v1/applications/${application.metadata.id}/operations failed with HTTP ${response.status}.`);
    output.write(`${JSON.stringify(response.body, null, 2)}\n`);
    return 0;
  }

  const controller = requireController(args.flags);

  if (args.command === 'controller-smoke') {
    const response = await fetch(`${controller.replace(/\/$/, '')}/healthz`);
    output.write(`${await response.text()}\n`);
    return response.ok ? 0 : 1;
  }

  const token = await (args.command === 'reconcile' || args.command === 'destroy' ? requireOperatorToken() : requireWorkflowToken());

  if (args.command === 'apply') {
    const sha = exactCommitSha(args.flags);
    const plans = typeof args.flags.plans === 'string' ? readPlansFile(args.flags.plans) : (await buildPlans(selected, sha, args.flags)).plans;
    const timeoutMs = operationTimeoutMs(args.flags);
    let success = true;
    for (const applyApplication of selected) {
      const applyPlan = plans.find((candidate) => candidate.applicationId === applyApplication.metadata.id);
      if (!applyPlan) throw new CliFailure('LP-PLAN-MISMATCH', `No plan for application '${applyApplication.metadata.id}' was produced; planning failed for this application.`);
      if (applyPlan.sourceCommit !== sha) throw new CliFailure('LP-PLAN-COMMIT-MISMATCH', `Plan for '${applyApplication.metadata.id}' is bound to ${applyPlan.sourceCommit}; expected ${sha}.`);
      if (applyPlan.result !== 'READY') throw new CliFailure('LP-PLAN-NOT-READY', `Plan for '${applyApplication.metadata.id}' is ${applyPlan.result}; apply requires a READY plan.`);
      if (applyPlan.sourceCommit !== sha) throw new CliFailure('LP-PLAN-COMMIT-MISMATCH', `Plan for '${applyApplication.metadata.id}' is bound to ${applyPlan.sourceCommit}; expected ${sha}.`);
      const idempotencyKey = `apply:${applyApplication.metadata.id}:${sha}:${applyPlan.desiredGeneration}`;
      const body = { ...workflowPayload(args.flags, token, applyApplication.metadata.id, sha, applyPlan, idempotencyKey), plan: applyPlan, desired: applyApplication };
      const response = await controllerRequest(controller, `/v1/applications/${encodeURIComponent(applyApplication.metadata.id)}/apply`, token, body);
      if (response.status !== 202) throw new CliFailure('LP-APPLY-START-REJECTED', `Apply start for '${applyApplication.metadata.id}' was rejected with HTTP ${response.status}: ${redactText(response.text)}`);
      let accepted: { workflowId?: unknown; operationId?: unknown; status?: unknown };
      try { accepted = JSON.parse(response.text) as typeof accepted; } catch { throw new CliFailure('LP-APPLY-START-INVALID', `Apply start for '${applyApplication.metadata.id}' returned non-JSON: ${redactText(response.text)}`); }
      const operationId = stringOrNull(accepted.operationId);
      if (!operationId) throw new CliFailure('LP-APPLY-START-INVALID', `Apply start for '${applyApplication.metadata.id}' is missing operationId.`);
      const operation = await pollOperation(controller, operationId, token, timeoutMs);
      const applied = SUCCESS_OPERATION_STATUSES[operation.status] === true;
      output.write(`${JSON.stringify({ applicationId: applyApplication.metadata.id, status: operation.status, operationId: operation.operationId, errorCode: operation.errorCode, result: operation.result }, null, 2)}\n`);
      success = success && applied;
    }
    return success ? 0 : 1;
  }

  if (args.command === 'destroy') {
    const response = await controllerRequest(controller, '/v1/cli/destroy', token, { applicationId: application.metadata.id, approvalToken: args.flags['approval-token'] ?? null });
    output.write(`${response.text}\n`);
    return response.ok ? 0 : 1;
  }

  if (args.command === 'reconcile') {
    const response = await controllerRequest(controller, '/v1/cli/reconcile', token, {
      applicationIds: selected.map((selectedApplication) => selectedApplication.metadata.id),
      sourceCommit: typeof args.flags.sha === 'string' ? args.flags.sha : null,
      automatic: process.env.LAUNCHPAD_AUTOMATED_RECONCILIATION === 'true',
    });
    output.write(`${response.text}\n`);
    return response.ok ? 0 : 1;
  }

  return 1;
}
