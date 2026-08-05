/**
 * Executable `direct-push-rejected` live probe (tests/end-to-end).
 *
 * Proves that the dedicated sandbox repository's default branch rejects
 * direct pushes with an explicit branch-protection/ruleset refusal, using
 * the prefix-guarded `LP_LIVE_GITHUB_REPOSITORY` and `LP_LIVE_GITHUB_TOKEN`:
 *
 *   1. Reads the repository and requires effective push permission — a
 *      read-only token can never "prove" a ruleset rejection.
 *   2. Creates an UNATTACHED child commit whose tree and parents are the
 *      current default-branch head (no ref ever points at it).
 *   3. Attempts a non-force fast-forward PATCH of `refs/heads/<default>` to
 *      that probe commit.
 *   4. Passes ONLY when the update is refused with an explicit
 *      ruleset/branch-protection rejection (HTTP 403/422 plus a
 *      rule/protection/GH006/GH013/pull-request reason) AND a readback
 *      confirms the ref is still the original head. A generic authorization
 *      or not-found failure fails the probe.
 *   5. If the update unexpectedly succeeds, a forced PATCH immediately
 *      restores the original ref in a `finally` path and the probe fails
 *      loudly — including the restore outcome.
 *
 * Security: raw response bodies and the token never enter evidence or error
 * text; only status codes, SHAs, and a derived rejection reason are exposed.
 *
 * The probe runs through the client's injected `fetchImpl` (the real network
 * in live acceptance; a recorded/fake transport in the offline unit tests),
 * so this module never opens a connection of its own.
 */

const REJECTION_REASON_PATTERN = /rule|protect|GH006|GH013|pull request/i;
const PROBE_COMMIT_MESSAGE = 'launchpad live acceptance: direct-push probe child commit (unattached; never intended to land)';

export type DirectPushRejectionReason = 'ruleset' | 'branch-protection' | 'pull-request-required' | 'rule-or-protection';

/** Minimal client surface; `GitHubClient` (GitHubAdapter#client) satisfies it structurally. */
export interface DirectPushClientLike {
  baseUrl: string;
  token: string | undefined;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
}

export interface DirectPushProbeOptions {
  /** GitHub client-like surface carrying baseUrl/token/fetchImpl/timeout. */
  client: DirectPushClientLike;
  /** owner/name of the prefix-guarded dedicated sandbox repository. */
  repository: string;
  correlationId?: string;
}

export interface DirectPushRejectionEvidence {
  defaultBranch: string;
  /** Original default-branch head (unchanged after the rejected update). */
  headSha: string;
  /** Unattached probe commit; the attempted update was refused. */
  probeSha: string;
  /** HTTP status of the ref update attempt. */
  attemptStatus: number;
  rejectionReason: DirectPushRejectionReason;
}

export class DirectPushProbeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DirectPushProbeError';
    this.code = code;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function objectField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  return asRecord(record[key]);
}

async function request(client: DirectPushClientLike, path: string, init: RequestInit & { correlationId?: string | undefined }): Promise<Response> {
  if (client.token === undefined || client.token === '') {
    throw new DirectPushProbeError('LP_LIVE_DIRECT_PUSH_AUTH_MISSING', 'GitHub token is not configured; cannot probe the sandbox repository');
  }
  const timeoutMs = client.timeoutMs ?? 20_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${client.token}`);
  headers.set('accept', 'application/json');
  headers.set('x-github-api-version', '2022-11-28');
  headers.set('user-agent', 'launchpad-control-plane/1');
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  if (init.correlationId !== undefined) headers.set('x-launchpad-correlation-id', init.correlationId);
  try {
    return await client.fetchImpl(`${client.baseUrl.replace(/\/$/, '')}${path}`, { ...init, headers, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new DirectPushProbeError('LP_LIVE_DIRECT_PUSH_TIMEOUT', `GitHub request timed out after ${timeoutMs}ms: ${init.method ?? 'GET'} ${path}`);
    }
    throw new DirectPushProbeError('LP_LIVE_DIRECT_PUSH_NETWORK', `GitHub request failed before a response: ${init.method ?? 'GET'} ${path} (${error instanceof Error ? error.message : String(error)})`);
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson(client: DirectPushClientLike, path: string, init: RequestInit & { correlationId?: string | undefined }): Promise<unknown> {
  const response = await request(client, path, init);
  if (!response.ok) {
    throw new DirectPushProbeError('LP_LIVE_DIRECT_PUSH_READ', `${init.method ?? 'GET'} ${path} returned HTTP ${response.status}`);
  }
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DirectPushProbeError('LP_LIVE_DIRECT_PUSH_MALFORMED', `${init.method ?? 'GET'} ${path} returned non-JSON (HTTP ${response.status})`);
  }
}

async function readRecord(client: DirectPushClientLike, path: string, init: RequestInit & { correlationId?: string | undefined }): Promise<Record<string, unknown>> {
  const body = await readJson(client, path, init);
  const record = asRecord(body);
  if (record === null) {
    throw new DirectPushProbeError('LP_LIVE_DIRECT_PUSH_MALFORMED', `${init.method ?? 'GET'} ${path} returned a non-object body`);
  }
  return record;
}

function classifyRejection(status: number, text: string, evidence: { defaultBranch: string; headSha: string; probeSha: string }): DirectPushRejectionEvidence {
  if (status !== 403 && status !== 422) {
    throw new DirectPushProbeError('LP_LIVE_DIRECT_PUSH_GENERIC_FAILURE', `ref update attempt returned HTTP ${status}; expected an explicit 403/422 branch-protection/ruleset rejection`);
  }
  let serialized = text;
  try {
    serialized = JSON.stringify(JSON.parse(text) as unknown);
  } catch {
    // Non-JSON body: keep the raw text for the explicit-reason match; an
    // unparseable body cannot prove a ruleset rejection and must not pass.
  }
  if (!REJECTION_REASON_PATTERN.test(serialized)) {
    throw new DirectPushProbeError('LP_LIVE_DIRECT_PUSH_GENERIC_REJECTION', `HTTP ${status} rejection without an explicit rule/protection/GH006/GH013/pull-request reason; a generic authorization or not-found failure must not pass`);
  }
  let rejectionReason: DirectPushRejectionReason = 'rule-or-protection';
  if (/GH013|ruleset/i.test(serialized)) rejectionReason = 'ruleset';
  else if (/GH006|protected branch/i.test(serialized)) rejectionReason = 'branch-protection';
  else if (/pull request/i.test(serialized)) rejectionReason = 'pull-request-required';
  return { ...evidence, attemptStatus: status, rejectionReason };
}

/**
 * Runs the direct-push rejection probe. Resolves with evidence when the
 * non-force fast-forward update of the default-branch ref is explicitly
 * rejected by a rule/protection and the ref is confirmed unchanged; throws
 * `DirectPushProbeError` otherwise (generic failures fail closed, and an
 * unexpected success restores the original ref in a `finally` path before
 * failing loudly).
 */
export async function probeDirectPushRejected(options: DirectPushProbeOptions): Promise<DirectPushRejectionEvidence> {
  const { client, repository } = options;
  const [owner, name, ...rest] = repository.split('/');
  if (!owner || !name || rest.length > 0) {
    throw new DirectPushProbeError('LP_LIVE_DIRECT_PUSH_INVALID_REPOSITORY', `Invalid GitHub repository '${repository}'.`);
  }
  const repositoryBase = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

  // 1. Read the repository; require effective push permission so a rejection
  //    is attributable to the ruleset, not to a read-only token.
  const repositoryData = await readRecord(client, repositoryBase, { method: 'GET', correlationId: options.correlationId });
  const permissions = objectField(repositoryData, 'permissions');
  if (permissions === null || permissions.push !== true) {
    throw new DirectPushProbeError('LP_LIVE_DIRECT_PUSH_PREREQ', `token has no effective push permission on '${repository}'; the probe cannot prove a ruleset rejection`);
  }
  const defaultBranch = asString(repositoryData.default_branch);
  if (defaultBranch === null) {
    throw new DirectPushProbeError('LP_LIVE_DIRECT_PUSH_PREREQ', `repository '${repository}' has no readable default branch`);
  }

  // 2. Current default-branch head and its tree.
  const branchRefPath = `${repositoryBase}/git/ref/heads/${encodeURIComponent(defaultBranch)}`;
  const headRef = await readRecord(client, branchRefPath, { method: 'GET', correlationId: options.correlationId });
  const headObject = objectField(headRef, 'object');
  const headSha = headObject !== null ? asString(headObject.sha) : null;
  if (headSha === null) {
    throw new DirectPushProbeError('LP_LIVE_DIRECT_PUSH_PREREQ', `default branch '${defaultBranch}' has no readable head commit`);
  }
  const headCommit = await readRecord(client, `${repositoryBase}/git/commits/${headSha}`, { method: 'GET', correlationId: options.correlationId });
  const tree = objectField(headCommit, 'tree');
  const treeSha = tree !== null ? asString(tree.sha) : null;
  if (treeSha === null) {
    throw new DirectPushProbeError('LP_LIVE_DIRECT_PUSH_PREREQ', `head commit '${headSha}' has no readable tree`);
  }

  // 3. Unattached child commit: tree and parents are the current head's.
  const probeCommit = await readRecord(client, `${repositoryBase}/git/commits`, {
    method: 'POST',
    correlationId: options.correlationId,
    body: JSON.stringify({ message: PROBE_COMMIT_MESSAGE, tree: treeSha, parents: [headSha] }),
  });
  const probeSha = asString(probeCommit.sha);
  if (probeSha === null) {
    throw new DirectPushProbeError('LP_LIVE_DIRECT_PUSH_PREREQ', 'GitHub did not return a sha for the probe commit');
  }

  // 4. Non-force fast-forward update of the default-branch ref to the probe
  //    commit. Pass only for an explicit ruleset/protection rejection; on
  //    unexpected success restore the original ref (finally) and fail loudly.
  const refPath = `${repositoryBase}/git/refs/heads/${encodeURIComponent(defaultBranch)}`;
  let unexpectedSuccess: number | null = null;
  let restoreOutcome: string | null = null;
  try {
    const attempt = await request(client, refPath, { method: 'PATCH', correlationId: options.correlationId, body: JSON.stringify({ sha: probeSha, force: false }) });
    if (attempt.ok) {
      unexpectedSuccess = attempt.status;
    } else {
      const evidence = classifyRejection(attempt.status, await attempt.text(), { defaultBranch, headSha, probeSha });
      // The rejected update must leave the ref untouched; a moved ref means
      // the sandbox changed under the probe and no claim may be made.
      const readback = await readRecord(client, refPath, { method: 'GET', correlationId: options.correlationId });
      const readbackObject = objectField(readback, 'object');
      if (readbackObject === null || asString(readbackObject.sha) !== headSha) {
        throw new DirectPushProbeError('LP_LIVE_DIRECT_PUSH_REF_MOVED', `refs/heads/${defaultBranch} is no longer at the probed head after the rejected update; refusing to claim the ref is unchanged`);
      }
      return evidence;
    }
  } finally {
    if (unexpectedSuccess !== null) {
      try {
        const restored = await request(client, refPath, { method: 'PATCH', correlationId: options.correlationId, body: JSON.stringify({ sha: headSha, force: true }) });
        restoreOutcome = restored.ok ? `force-restored original ref ${headSha}` : `restore PATCH returned HTTP ${restored.status}`;
      } catch (error) {
        restoreOutcome = `restore failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  throw new DirectPushProbeError(
    'LP_LIVE_DIRECT_PUSH_UNEXPECTED_SUCCESS',
    `direct push to refs/heads/${defaultBranch} unexpectedly succeeded (HTTP ${unexpectedSuccess ?? 'unknown'}); the sandbox default-branch update must be explicitly rejected by a rule/protection. Original ref: ${restoreOutcome ?? 'restore not attempted'}.`,
  );
}
