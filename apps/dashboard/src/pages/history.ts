// Deployment, health and drift history pages. Each reads its dedicated
// control-plane endpoint and renders exactly the records it returns; empty
// results render an explicit empty state rather than plausible-looking data.

import { requireArrayField } from '../api.js';
import { append, el, setText, shortId, statusBadge, timestamp } from '../dom.js';
import type { PageContext, PageView } from '../router.js';
import type { StatusDimension } from '../status.js';
import type { DeploymentRecordView, DriftEntry, HealthCheckView } from '../types.js';
import { externalLink } from '../urls.js';
import { createPageHost, dataTable, handlePageError, pageHeading, row, subNav } from './common.js';

async function renderListPage(
  context: PageContext,
  params: Record<string, string>,
  options: {
    title: string;
    eyebrow: string;
    path: string;
    field: string;
    description: string;
    loadingMessage: string;
    emptyMessage: string;
    columns: string[];
    rowsOf: (entries: unknown[]) => HTMLElement[];
  },
): Promise<PageView> {
  const applicationId = params.id ?? '';
  const host = createPageHost();
  host.show({ kind: 'loading', title: `Reading ${options.title.toLowerCase()}`, message: options.loadingMessage });
  try {
    const payload = await context.client.get<Record<string, unknown>>(`/v1/applications/${encodeURIComponent(applicationId)}${options.path}`);
    const entries = requireArrayField(payload, options.field, options.description);
    const content = el('div', 'page__content');
    append(content, pageHeading(options.eyebrow, options.title, applicationId));
    append(content, subNav(applicationId));
    if (entries.length === 0) {
      const empty = el('p', 'notice');
      setText(empty, options.emptyMessage);
      append(content, empty);
    } else {
      append(content, dataTable(options.columns, options.rowsOf(entries)));
    }
    host.fill(content);
  } catch (error) {
    handlePageError(host, context, error);
  }
  return { title: options.title, element: host.root };
}

export function renderDeploymentsPage(context: PageContext, params: Record<string, string>): Promise<PageView> {
  return renderListPage(context, params, {
    title: 'Deployments',
    eyebrow: 'OPERATIONS / DEPLOYMENT HISTORY',
    path: '/deployments',
    field: 'deployments',
    description: 'deployment list',
    loadingMessage: 'Loading deployment history…',
    emptyMessage: 'The control plane has not recorded deployments for this application.',
    columns: ['DEPLOYMENT', 'ENVIRONMENT', 'STATE', 'COMMIT', 'URL', 'CREATED'],
    rowsOf: (entries) =>
      (entries as DeploymentRecordView[]).map((deployment) => {
        const id = el('code', 'mono');
        setText(id, shortId(deployment.id));
        const commit = el('code', 'mono');
        setText(commit, shortId(deployment.commitSha));
        const url = deployment.url === null || deployment.url === '' ? setText(el('span'), '—') : externalLink(deployment.url);
        return row([id, deployment.environment, statusBadge('deployment', deployment.state), commit, url, timestamp(deployment.createdAt)]);
      }),
  });
}

export function renderHealthPage(context: PageContext, params: Record<string, string>): Promise<PageView> {
  return renderListPage(context, params, {
    title: 'Health',
    eyebrow: 'OPERATIONS / HEALTH HISTORY',
    path: '/health',
    field: 'checks',
    description: 'health check list',
    loadingMessage: 'Loading health check history…',
    emptyMessage: 'The control plane has not recorded health checks for this application.',
    columns: ['ENVIRONMENT', 'URL', 'RESULT', 'STATUS CODE', 'LATENCY', 'ERROR', 'CHECKED'],
    rowsOf: (entries) =>
      (entries as HealthCheckView[]).map((check) => {
        const url = check.url === '' ? setText(el('span'), '—') : externalLink(check.url);
        return row([
          check.environment,
          url,
          checkResultBadge(check.result),
          check.statusCode === null || check.statusCode === undefined ? '—' : String(check.statusCode),
          check.latencyMs === null || check.latencyMs === undefined ? '—' : `${check.latencyMs} ms`,
          check.errorCode ?? '—',
          timestamp(check.checkedAt),
        ]);
      }),
  });
}

export function renderDriftPage(context: PageContext, params: Record<string, string>): Promise<PageView> {
  return renderListPage(context, params, {
    title: 'Drift',
    eyebrow: 'OPERATIONS / DRIFT & RECONCILIATION',
    path: '/drift',
    field: 'drift',
    description: 'drift entry list',
    loadingMessage: 'Loading drift records…',
    emptyMessage: 'The control plane has not reported drift for this application.',
    columns: ['DRIFT ENTRY'],
    rowsOf: (entries) =>
      (entries as DriftEntry[]).map((entry) => {
        const cell = el('div');
        for (const [key, value] of Object.entries(entry)) {
          const line = el('p', 'drift-line');
          const keyEl = el('strong');
          setText(keyEl, key);
          append(line, keyEl, typeof value === 'string' ? value : JSON.stringify(value));
          append(cell, line);
        }
        if (cell.children.length === 0) setText(cell, 'Empty drift entry');
        return row([cell]);
      }),
  });
}

function checkResultBadge(value: string | null | undefined): HTMLElement {
  const tone: 'ok' | 'bad' | 'neutral' = value === 'PASSED' ? 'ok' : value === 'FAILED' || value === 'ERROR' ? 'bad' : 'neutral';
  const label = value === 'PASSED' || value === 'FAILED' || value === 'ERROR' ? value : 'UNKNOWN';
  return statusBadgeForTone('health', tone, label);
}

// Small variant of statusBadge that accepts an explicit tone (health check
// results are not health statuses and must not flow through classifyStatus).
function statusBadgeForTone(dimension: StatusDimension, tone: 'ok' | 'bad' | 'neutral', label: string): HTMLElement {
  const badge = el('span', `status-badge status-badge--${dimension} status-badge--${tone}`);
  append(badge, el('i', 'status-badge__dot'), label);
  return badge;
}
