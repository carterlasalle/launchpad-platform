import { boundStickyCommentBody, redactLogValue, redactText } from '@launchpad/shared';
import { escapeMarkdown, type ReportingInput } from './reporting.js';

/**
 * GitHub fan-out hooks for final failures: Actions summary markdown, the
 * sticky PR comment, and the commit status. Every hook is best-effort and
 * returns its delivery outcome instead of throwing — a delivery failure is
 * recorded on the incident row so a broken sink stays visible. All dynamic
 * text is escaped and redacted before it reaches GitHub.
 */

export interface DeliveryResult {
  delivered: boolean;
  error: string | null;
}

export interface FanOutResult {
  /** Markdown for the GitHub Actions step summary (job-level surface). */
  actionsSummary: string;
  /** Sticky PR comment delivery (only when pullRequestNumber is known). */
  comment: DeliveryResult | null;
  /** Commit status delivery (only when sourceCommit is known). */
  commitStatus: DeliveryResult | null;
}

export interface FanOutTargets {
  /** 'owner/repo' as carried in workflow payloads. */
  repository?: string | null;
  pullRequestNumber?: number | string | null;
  sourceCommit?: string | null;
}

export interface FanOutOptions {
  token?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface StickyCommentState {
  owner: string;
  repo: string;
  pullRequestNumber: number | string;
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const STICKY_MARKER = '<!-- launchpad:plan -->';
const MAX_SUMMARY_CHARS = 4096;

export function splitRepository(repository: string): { owner: string; repo: string } | null {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repository.trim());
  const owner = match?.[1];
  const repo = match?.[2];
  if (owner === undefined || repo === undefined) return null;
  return { owner, repo };
}

/**
 * Renders the compact failure/evidence summary for a GitHub Actions step
 * summary. Bounded and redacted; never contains raw provider bodies.
 */
export function renderActionsSummary(input: ReportingInput): string {
  const lines: string[] = ['## Launchpad result'];
  const plans = input.plans ?? [];
  const firstPlan = plans[0];
  if (firstPlan) lines.push(`- Plan: \`${escapeMarkdown(firstPlan.result)}\` (${plans.length} plan${plans.length === 1 ? '' : 's'}, fingerprint \`${escapeMarkdown(firstPlan.fingerprint)}\`)`);
  else lines.push('- Plan: not available');
  for (const preview of input.previews ?? []) {
    lines.push(`- Preview: ${escapeMarkdown(preview.state)}${preview.url ? ` — ${escapeMarkdown(preview.url)}` : ''}`);
  }
  for (const health of input.healths ?? []) {
    lines.push(`- Health: ${escapeMarkdown(health.state)} — ${escapeMarkdown(redactText(health.message))}`);
  }
  if (input.providerError) {
    const error = input.providerError;
    lines.push(`- Provider error: \`${escapeMarkdown(error.code)}\` — ${escapeMarkdown(redactText(error.message))}${error.retryable === null ? '' : error.retryable ? ' (retryable)' : ' (permanent)'}`);
  }
  return lines.join('\n').slice(0, MAX_SUMMARY_CHARS);
}

async function githubRequest(options: StickyCommentState, path: string, init: RequestInit): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/vnd.github+json');
  headers.set('authorization', `Bearer ${options.token}`);
  headers.set('user-agent', 'launchpad-control-plane/1');
  headers.set('x-github-api-version', '2022-11-28');
  return fetchImpl(`${options.baseUrl ?? 'https://api.github.com'}${path}`, { ...init, headers });
}

/**
 * Creates or updates the single stable sticky PR comment (marker
 * `<!-- launchpad:plan -->`). The latest comment carrying the marker is
 * updated; otherwise a new comment is created, so repeated runs never
 * accumulate a comment trail.
 */
export async function upsertStickyComment(options: StickyCommentState, body: string): Promise<DeliveryResult> {
  const { owner, repo, pullRequestNumber } = options;
  const boundedBody = boundStickyCommentBody(body);
  try {
    const listResponse = await githubRequest(options, `/repos/${owner}/${repo}/issues/${String(pullRequestNumber)}/comments?per_page=100`, { method: 'GET' });
    if (!listResponse.ok) return { delivered: false, error: `LP-GITHUB-COMMENT-LIST-${listResponse.status}` };
    const comments = await listResponse.json() as Array<{ id: number; body: string }>;
    const existing = comments.find((comment) => comment.body?.includes(STICKY_MARKER));
    let response: Response;
    if (existing) {
      response = await githubRequest(options, `/repos/${owner}/${repo}/issues/comments/${existing.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: boundedBody }) });
    } else {
      response = await githubRequest(options, `/repos/${owner}/${repo}/issues/${String(pullRequestNumber)}/comments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: boundedBody }) });
    }
    if (!response.ok) return { delivered: false, error: `LP-GITHUB-COMMENT-WRITE-${response.status}` };
    return { delivered: true, error: null };
  } catch (error) {
    return { delivered: false, error: 'LP-GITHUB-COMMENT-UNAVAILABLE' };
  }
}

/** Posts a commit status for the exact source commit (`launchpad/<workflow>` context). */
export async function postCommitStatus(options: { owner: string; repo: string; sourceCommit: string; workflow: string; token: string; baseUrl?: string; fetchImpl?: typeof fetch }, state: 'error' | 'failure' | 'pending' | 'success', description: string): Promise<DeliveryResult> {
  try {
    const boundedDescription = redactText(description.slice(0, 140));
    const response = await githubRequest({ ...options, pullRequestNumber: 0 }, `/repos/${options.owner}/${options.repo}/statuses/${options.sourceCommit}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state, context: `launchpad/${options.workflow}`, description: boundedDescription }),
    });
    if (!response.ok) return { delivered: false, error: `LP-GITHUB-STATUS-${response.status}` };
    return { delivered: true, error: null };
  } catch {
    return { delivered: false, error: 'LP-GITHUB-STATUS-UNAVAILABLE' };
  }
}

/**
 * Fan-out for a permanent failure: Actions summary (always produced), sticky
 * PR comment (when repository + pullRequestNumber are known), and commit
 * status (when repository + sourceCommit are known). Never throws; every
 * sink's outcome is returned so the caller can record delivery failures on
 * the incident row.
 */
export async function fanOutFailure(input: { targets: FanOutTargets; report: ReportingInput; options: FanOutOptions; workflow?: string }): Promise<FanOutResult> {
  const actionsSummary = renderActionsSummary(input.report);
  const { targets, options } = input;
  const parts = targets.repository ? splitRepository(targets.repository) : null;
  const pullRequestNumber = targets.pullRequestNumber;
  const token = options.token;
  if (!parts || pullRequestNumber === undefined || pullRequestNumber === null || token === undefined || token.length === 0) {
    return { actionsSummary, comment: null, commitStatus: null };
  }
  const commentBody = input.report.plans.length > 0 ? renderCommentFromReport(input.report) : renderIncidentComment(input.report);
  const comment = await upsertStickyComment({ owner: parts.owner, repo: parts.repo, pullRequestNumber, token, ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}), ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) }, commentBody);
  const commitStatus = targets.sourceCommit
    ? await postCommitStatus({ owner: parts.owner, repo: parts.repo, sourceCommit: targets.sourceCommit, workflow: input.workflow ?? 'apply', token, ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}), ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) }, 'failure', input.report.providerError?.message ?? 'Launchpad operation failed.')
    : null;
  return { actionsSummary, comment, commitStatus };
}

function renderCommentFromReport(input: ReportingInput): string {
  const sections: string[] = [STICKY_MARKER];
  for (const plan of input.plans) sections.push(`Plan: \`${escapeMarkdown(plan.result)}\` (fingerprint \`${escapeMarkdown(plan.fingerprint)}\`)`);
  if (input.providerError) sections.push(`**Failure** — \`${escapeMarkdown(input.providerError.code)}\`: ${escapeMarkdown(redactText(input.providerError.message))}`);
  return sections.join('\n\n');
}

function renderIncidentComment(input: ReportingInput): string {
  const error = input.providerError;
  return `${STICKY_MARKER}\n\n**Launchpad operation failed.**\n\n${error ? `- Error: \`${escapeMarkdown(error.code)}\` — ${escapeMarkdown(redactText(error.message))}${error.operationId ? ` (operation \`${escapeMarkdown(error.operationId)}\`)` : ''}` : '- Error: see the controller incidents dashboard.'}`;
}

export function incidentDelivery(result: FanOutResult): Record<string, unknown> {
  return redactLogValue({
    actionsSummary: result.actionsSummary.length > 0,
    comment: result.comment ? { delivered: result.comment.delivered, error: result.comment.error } : null,
    commitStatus: result.commitStatus ? { delivered: result.commitStatus.delivered, error: result.commitStatus.error } : null,
  }) as Record<string, unknown>;
}
