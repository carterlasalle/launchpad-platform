import { renderPlanMarkdown, type PlatformPlan } from '@launchpad/core';
import { redactValue } from '@launchpad/shared';

export interface PreviewSummary { state: 'READY' | 'ERROR' | 'CANCELED' | 'TIMEOUT'; url: string | null; message: string; }
export interface HealthSummary { state: 'PASSED' | 'FAILED' | 'ERROR'; message: string; }
export interface ReportingInput { plan: PlatformPlan; preview: PreviewSummary; health: HealthSummary; providerState?: unknown; resourceGraph?: unknown; logs?: readonly string[]; }

function escapeMarkdown(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '\\|');
}

function redactText(value: string): string {
  return value.replace(/(token|secret|password|api[_-]?key|database[_-]?url)\s*[:=]\s*[^\s]+/gi, '$1=[REDACTED]');
}

function resultIcon(state: string): string {
  return state === 'READY' || state === 'PASSED' ? '✅' : state === 'CANCELED' ? '⚠️' : '❌';
}

export function renderStickyComment(input: ReportingInput): string {
  const previewMessage = escapeMarkdown(redactText(input.preview.message));
  const healthMessage = escapeMarkdown(redactText(input.health.message));
  return `<!-- launchpad:plan -->\n${renderPlanMarkdown(input.plan)}\n### Preview deployment\n\n- State: ${resultIcon(input.preview.state)} \`${input.preview.state}\`\n- URL: ${input.preview.url ? `[open preview](${input.preview.url})` : 'not available'}\n- Details: ${previewMessage}\n\n### Health\n\n- State: ${resultIcon(input.health.state)} \`${input.health.state}\`\n- Details: ${healthMessage}\n`;
}

export function artifactFiles(input: ReportingInput): Record<string, string> {
  const safePlan = redactValue(input.plan);
  const safeProviderState = redactValue(input.providerState ?? {});
  const logs = (input.logs ?? []).slice(-80).join('\n').slice(0, 16_000);
  return {
    'plan.json': JSON.stringify(safePlan, null, 2),
    'plan.md': renderPlanMarkdown(input.plan),
    'resource-graph.json': JSON.stringify(redactValue(input.resourceGraph ?? {}), null, 2),
    'resource-graph.dot': 'digraph launchpad { }\n',
    'provider-state-redacted.json': JSON.stringify(safeProviderState, null, 2),
    'preview-summary.json': JSON.stringify(redactValue(input.preview), null, 2),
    'health-results.json': JSON.stringify(redactValue(input.health), null, 2),
    'build-log-tail.txt': redactText(logs),
  };
}
