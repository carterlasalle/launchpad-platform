import { renderPlanMarkdown, type PlatformPlan, type ResourceGraph } from '@launchpad/core';
import { redactText, redactValue } from '@launchpad/shared';

export type PreviewState = 'READY' | 'ERROR' | 'CANCELED' | 'TIMEOUT' | 'NOT_RUN';
export interface PreviewSummary { state: PreviewState; url: string | null; message: string; }
export type HealthState = 'PASSED' | 'FAILED' | 'ERROR' | 'NOT_RUN';
export interface HealthSummary { state: HealthState; message: string; }
export interface ProviderErrorSummary { code: string; message: string; operationId: string | null; retryable: boolean | null; }
export interface JobResult { name: string; result: string; }
export interface FailureReportingInput {
  jobs: readonly JobResult[];
  previews?: readonly PreviewSummary[] | null;
  healths?: readonly HealthSummary[] | null;
  providerError?: ProviderErrorSummary | null;
}
export interface ReportingInput {
  plans: readonly PlatformPlan[];
  previews?: readonly PreviewSummary[] | null;
  healths?: readonly HealthSummary[] | null;
  providerState?: unknown;
  resourceGraphs?: readonly ResourceGraph[] | null;
  providerError?: ProviderErrorSummary | null;
  logs?: readonly string[] | null;
}

const MAX_STRING_CHARS = 4096;
const MAX_ARTIFACT_BYTES = 262_144;
const MAX_LOG_BYTES = 16_384;
const MAX_LOG_LINES = 80;

/** Escapes HTML-significant characters so untrusted provider/repository text cannot inject markup into the comment. */
export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Escape for short inline fragments (never table cells): HTML characters plus table pipes. */
export function escapeMarkdown(value: string): string {
  return escapeHtml(value).replaceAll('|', '\\|');
}

function resultIcon(state: string): string {
  return state === 'READY' || state === 'PASSED' ? '✅' : state === 'CANCELED' ? '⚠️' : state === 'NOT_RUN' ? '—' : '❌';
}

function previewLines(preview: PreviewSummary): string[] {
  const url = preview.url && /^https?:\/\//i.test(preview.url) ? `[open preview](${escapeMarkdown(preview.url)})` : 'not available';
  return [`- State: ${resultIcon(preview.state)} \`${escapeMarkdown(preview.state)}\``, `- URL: ${url}`, `- Details: ${escapeMarkdown(redactText(preview.message))}`];
}

function healthLines(health: HealthSummary): string[] {
  return [`- State: ${resultIcon(health.state)} \`${escapeMarkdown(health.state)}\``, `- Details: ${escapeMarkdown(redactText(health.message))}`];
}

/**
 * Renders the single stable sticky PR comment. Every dynamic fragment is
 * escaped and redacted; preview/health sections are only emitted from real
 * evidence — never synthesized READY/PASSED placeholders.
 */
export function renderStickyComment(input: ReportingInput): string {
  if (!Array.isArray(input.plans)) throw new TypeError('renderStickyComment requires a plans array.');
  const sections: string[] = ['<!-- launchpad:plan -->'];
  for (const plan of input.plans) sections.push(escapeHtml(renderPlanMarkdown(plan)));
  const previews = input.previews ?? [];
  sections.push('### Preview deployment');
  if (previews.length === 0) sections.push('- State: not available\n- URL: not available\n- Details: The preview workflow has not produced a result for this commit.');
  else sections.push(...previews.flatMap((preview) => previewLines(preview)));
  const healths = input.healths ?? [];
  sections.push('### Health');
  if (healths.length === 0) sections.push('- State: not available\n- Details: The health workflow has not produced a result for this commit.');
  else sections.push(...healths.flatMap((health) => healthLines(health)));
  if (input.providerError) {
    const error = input.providerError;
    sections.push('### Provider error', `- \`${escapeMarkdown(error.code)}\` — ${escapeMarkdown(redactText(error.message))}${error.operationId ? ` (operation \`${escapeMarkdown(error.operationId)}\`)` : ''}`);
  }
  return `${sections.join('\n\n')}\n`;
}

function jobIcon(result: string): string {
  if (result === 'success') return '✅';
  if (result === 'cancelled') return '⚠️';
  if (result === 'skipped' || result === 'pending') return '—';
  return '❌';
}

/**
 * Renders the bounded failure-only sticky comment for the validate-plan
 * summary workflow when plan artifacts are absent because an upstream
 * required job (schema/catalog/plan/...) failed or was cancelled. Rendered
 * strictly from explicit job results and safe error artifacts: every dynamic
 * fragment is escaped and redacted, and green preview/health states are never
 * synthesized — only failing/cancelled evidence is emitted.
 */
export function renderFailureStickyComment(input: FailureReportingInput): string {
  const sections: string[] = ['<!-- launchpad:plan -->', '### Launchpad validation failed', 'The Launchpad PR gate is red; the plan workflow did not produce plan artifacts for this commit.', 'Required job results:'];
  if (input.jobs.length === 0) sections.push('- No required job results recorded.');
  else sections.push(...input.jobs.map((job) => `- ${jobIcon(job.result)} \`${escapeMarkdown(job.name)}\` — ${escapeMarkdown(job.result)}`));
  const failedPreviews = (input.previews ?? []).filter((preview) => preview.state !== 'READY' && preview.state !== 'NOT_RUN');
  if (failedPreviews.length > 0) sections.push('### Preview failures', ...failedPreviews.flatMap((preview) => previewLines(preview)));
  const failedHealths = (input.healths ?? []).filter((health) => health.state !== 'PASSED' && health.state !== 'NOT_RUN');
  if (failedHealths.length > 0) sections.push('### Health failures', ...failedHealths.flatMap((health) => healthLines(health)));
  if (input.providerError) {
    const error = input.providerError;
    sections.push('### Provider error', `- \`${escapeMarkdown(error.code)}\` — ${escapeMarkdown(redactText(error.message))}${error.operationId ? ` (operation \`${escapeMarkdown(error.operationId)}\`)` : ''}`);
  }
  return `${sections.join('\n\n')}\n`;
}


/** Renders a real Graphviz dot digraph from the resource graph; used for bounded graph artifacts. */
export function renderDotGraph(graphs: readonly ResourceGraph[]): string {
  const lines = ['digraph launchpad {', '  rankdir="LR";'];
  for (const graph of graphs) {
    for (const node of graph.nodes) {
      const key = node.key.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
      lines.push(`  "${key}" [provider="${node.provider}" resource_type="${node.resourceType.replaceAll('"', '\\"')}"];`);
    }
    for (const node of graph.nodes) {
      const key = node.key.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
      for (const dependency of node.dependencies) lines.push(`  "${key}" -> "${dependency.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}";`);
    }
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function truncateString(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value;
}

/** Recursively bounds every string, scrubs credential-shaped text, and drops circular references; output stays JSON-safe and redaction-safe. */
function boundStrings(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return truncateString(redactText(value), MAX_STRING_CHARS);
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return value.map((item) => boundStrings(item, seen));
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, boundStrings(item, seen)]));
  }
  return value;
}

function boundedJson(value: unknown, fallback: unknown): string {
  const serialized = JSON.stringify(boundStrings(redactValue(value)), null, 2);
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_ARTIFACT_BYTES) return serialized;
  return JSON.stringify(boundStrings(redactValue(fallback)), null, 2);
}

/** Deterministic minimal plan projection used when a full plan exceeds the artifact bound. */
function minimalPlans(plans: readonly PlatformPlan[]): unknown {
  return plans.map((plan) => ({
    schemaVersion: plan.schemaVersion,
    applicationId: plan.applicationId,
    sourceCommit: plan.sourceCommit,
    desiredGeneration: plan.desiredGeneration,
    result: plan.result,
    fingerprint: plan.fingerprint,
    observedStateHash: plan.observedStateHash,
    capabilitySnapshotHash: plan.capabilitySnapshotHash,
    operationCount: plan.operations.length,
    truncated: true,
  }));
}

/**
 * Bounded, redacted machine-readable artifacts. Files are only produced for
 * evidence that was actually provided — no synthetic preview/health/pass
 * artifacts are ever emitted.
 */
export function artifactFiles(input: ReportingInput): Record<string, string> {
  if (!Array.isArray(input.plans)) throw new TypeError('artifactFiles requires a plans array.');
  const files: Record<string, string> = {
    'plans.json': boundedJson(input.plans, minimalPlans(input.plans)),
    'plan.md': truncateString(input.plans.map(renderPlanMarkdown).join('\n\n'), MAX_ARTIFACT_BYTES),
    'resource-graph.json': boundedJson(input.resourceGraphs ?? [], []),
    'resource-graph.dot': renderDotGraph(input.resourceGraphs ?? []),
    'provider-state-redacted.json': boundedJson(input.providerState ?? {}, {}),
  };
  if (input.previews && input.previews.length > 0) files['preview-summary.json'] = boundedJson(input.previews, []);
  if (input.healths && input.healths.length > 0) files['health-results.json'] = boundedJson(input.healths, []);
  if (input.providerError) files['provider-error-redacted.json'] = boundedJson(input.providerError, { code: input.providerError.code, message: '[REDACTED]', operationId: input.providerError.operationId });
  if (input.logs && input.logs.length > 0) {
    const tail = input.logs.slice(-MAX_LOG_LINES).join('\n');
    const marker = '…[truncated]\n';
    const markerBytes = Buffer.byteLength(marker, 'utf8');
    files['build-log-tail.txt'] = redactText(Buffer.byteLength(tail, 'utf8') + markerBytes > MAX_LOG_BYTES ? `${marker}${tail.slice(Math.max(0, tail.length - (MAX_LOG_BYTES - markerBytes)))}` : tail);
  }
  return files;
}
