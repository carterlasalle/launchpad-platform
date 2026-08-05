// Application detail page — reads GET /v1/applications/:id and keeps the
// four status dimensions (sync, health, deployment, latest operation) in
// separate panels (NFR-UX-003). Also links to the per-application views.

import { requireArrayField } from '../api.js';
import { configChangeControls, operatorActionControls, type OperatorActionKind } from '../actions.js';
import type { ApiClient } from '../api.js';
import { append, el, internalLink, setText, shortId, statusBadge, timestamp } from '../dom.js';
import type { PageContext, PageView } from '../router.js';
import type { DashboardApplication, OperationRecord } from '../types.js';
import { externalLink } from '../urls.js';
import { createPageHost, dataTable, handlePageError, pageHeading, row, subNav } from './common.js';

export async function renderApplicationDetailPage(context: PageContext, params: Record<string, string>): Promise<PageView> {
  const applicationId = params.id ?? '';
  const host = createPageHost();
  host.show({ kind: 'loading', title: 'Reading application', message: `Loading application ${applicationId} from the control plane…` });
  try {
    const payload = await context.client.get<Record<string, unknown>>(`/v1/applications/${encodeURIComponent(applicationId)}`);
    const application = isApplication(payload.application) ? payload.application : null;
    if (application === null) {
      host.show({
        kind: 'unknown',
        title: 'Application not found',
        message: `The control plane has no record of application "${applicationId}".`,
        actions: [internalLink('#/', 'BACK TO APPLICATIONS')],
      });
      return { title: 'Application', element: host.root };
    }
    const operations = requireArrayField(payload, 'operations', 'operation list') as unknown as OperationRecord[];
    const content = el('div', 'page__content');
    append(content, pageHeading('OPERATIONS / APPLICATION DETAIL', application.displayName || application.application, application.application));
    append(content, subNav(applicationId));
    append(content, statusGrid(application, operations));
    append(content, metaRow(application));
    append(content, operationsSection(applicationId, operations));
    append(content, recoveryActionsSection(applicationId, context.client));
    append(content, configChangesSection(applicationId, context.client));
    host.fill(content);
  } catch (error) {
    handlePageError(host, context, error);
  }
  return { title: 'Application', element: host.root };
}

function isApplication(value: unknown): value is DashboardApplication {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function statusCard(label: string, badge: HTMLElement, detail: string): HTMLElement {
  const card = el('article', 'status-card');
  const labelEl = el('p', 'status-card__label');
  setText(labelEl, label);
  const detailEl = el('p', 'status-card__detail');
  setText(detailEl, detail);
  append(card, labelEl, badge, detailEl);
  return card;
}

export function statusGrid(application: DashboardApplication, operations: OperationRecord[]): HTMLElement {
  const grid = el('section', 'status-grid');
  const latest = operations.at(-1) ?? null;
  const operationDetail = latest === null ? 'No operation recorded' : `${latest.action} · started ${timestamp(latest.startedAt)}${latest.errorCode ? ` · ${latest.errorCode}` : ''}`;
  append(
    grid,
    statusCard('SYNC STATUS', statusBadge('sync', application.sync), 'Desired state vs observed provider state'),
    statusCard('HEALTH STATUS', statusBadge('health', application.health), 'Latest production health check'),
    statusCard('DEPLOYMENT', statusBadge('deployment', application.deployment), 'Current production deployment'),
    statusCard('LATEST OPERATION', statusBadge('operation', latest?.status), operationDetail),
  );
  return grid;
}

function metaRow(application: DashboardApplication): HTMLElement {
  const meta = el('dl', 'def-list');
  const ownerDt = el('dt');
  setText(ownerDt, 'OWNER');
  const ownerDd = el('dd');
  setText(ownerDd, application.owner || '—');
  const urlDt = el('dt');
  setText(urlDt, 'PRODUCTION URL');
  const urlDd = el('dd');
  append(urlDd, application.productionUrl === null || application.productionUrl === '' ? setText(el('span'), '—') : externalLink(application.productionUrl));
  const updatedDt = el('dt');
  setText(updatedDt, 'LAST UPDATED');
  const updatedDd = el('dd');
  setText(updatedDd, timestamp(application.updatedAt));
  append(meta, ownerDt, ownerDd, urlDt, urlDd, updatedDt, updatedDd);
  return meta;
}

export function operationsSection(applicationId: string, operations: OperationRecord[]): HTMLElement {
  const section = el('section', 'page__section');
  const heading = el('h2');
  setText(heading, 'Operation history');
  append(section, heading);
  if (operations.length === 0) {
    const empty = el('p', 'notice');
    setText(empty, 'The control plane has not recorded operations for this application.');
    append(section, empty);
    return section;
  }
  const rows = operations.map((operation) => {
    const workflow = internalLink(`#/applications/${encodeURIComponent(applicationId)}/workflows/${encodeURIComponent(operation.id)}`, shortId(operation.id));
    return row([workflow, operation.action, statusBadge('operation', operation.status), timestamp(operation.startedAt), timestamp(operation.completedAt), operation.errorCode ?? '—']);
  });
  append(section, dataTable(['OPERATION', 'ACTION', 'STATUS', 'STARTED', 'COMPLETED', 'ERROR'], rows));
  return section;
}

/**
 * Application-level recovery actions: RECHECK HEALTH re-runs the production
 * health check; ROLLBACK restores the recorded known-good deployment (the
 * only provider mutation a dashboard request may trigger, so it requires
 * confirmation). Both POST to the existing action endpoints.
 */
function recoveryActionsSection(applicationId: string, client: ApiClient): HTMLElement {
  const section = el('section', 'page__section');
  const heading = el('h2');
  setText(heading, 'Recovery actions');
  append(section, heading);
  const kinds: OperatorActionKind[] = ['recheck', 'rollback'];
  append(section, operatorActionControls({ client, applicationId, kinds }));
  return section;
}

/** PR-only config changes: every control opens (or reuses) a control-repository pull request. */
function configChangesSection(applicationId: string, client: ApiClient): HTMLElement {
  const section = el('section', 'page__section');
  const heading = el('h2');
  setText(heading, 'Config changes (pull request)');
  const note = el('p', 'notice');
  setText(note, 'Each change opens a pull request against the control repository. No provider is mutated from the dashboard; the change applies when the pull request is reviewed, merged, and reconciled.');
  append(section, heading, note, configChangeControls({ client, applicationId }));
  return section;
}
