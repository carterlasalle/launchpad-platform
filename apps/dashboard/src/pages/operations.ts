// Operations page — every application's operation history, fanned out over
// the catalog. Rows link to workflow detail pages. Per-app read failures are
// surfaced as a note rather than silently dropped.

import { requireArrayField } from '../api.js';
import { operatorActionControls, type OperatorActionKind } from '../actions.js';
import { append, el, internalLink, setText, shortId, statusBadge, timestamp } from '../dom.js';
import type { PageContext, PageView } from '../router.js';
import type { DashboardApplication, OperationRecord } from '../types.js';
import { createPageHost, dataTable, handlePageError, pageHeading, row } from './common.js';

export async function renderOperationsPage(context: PageContext): Promise<PageView> {
  const host = createPageHost();
  host.show({ kind: 'loading', title: 'Reading operations', message: 'Loading operation history across the catalog…' });
  try {
    const payload = await context.client.get<Record<string, unknown>>('/v1/applications');
    const applications = requireArrayField(payload, 'applications', 'application list') as unknown as DashboardApplication[];
    const content = el('div', 'page__content');
    append(content, pageHeading('OPERATIONS / PLATFORM OPERATIONS', 'Operations', `${applications.length} application${applications.length === 1 ? '' : 's'} tracked`));
    if (applications.length === 0) {
      const empty = el('p', 'notice');
      setText(empty, 'The control plane has not recorded any operations.');
      append(content, empty);
      host.fill(content);
      return { title: 'Operations', element: host.root };
    }
    const results = await Promise.allSettled(applications.map((application) => context.client.get<Record<string, unknown>>(`/v1/applications/${encodeURIComponent(application.application)}/operations`)));
    const rows: HTMLElement[] = [];
    let failures = 0;
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const application = applications[index];
      if (!application || !result) continue;
      if (result.status === 'rejected') {
        failures += 1;
        continue;
      }
      const operations = requireArrayField(result.value, 'operations', 'operation list') as unknown as OperationRecord[];
      for (const operation of operations) {
        const applicationLink = internalLink(`#/applications/${encodeURIComponent(application.application)}`, application.application);
        const workflow = internalLink(`#/applications/${encodeURIComponent(application.application)}/workflows/${encodeURIComponent(operation.id)}`, shortId(operation.id));
        const actionsCell = el('td');
        const kinds: OperatorActionKind[] = [];
        if (operation.status === 'FAILED' || operation.status === 'BLOCKED') kinds.push('retry');
        if (operation.status === 'QUEUED') kinds.push('cancel');
        if (kinds.length > 0) append(actionsCell, operatorActionControls({ client: context.client, applicationId: application.application, operationId: operation.id, kinds }));
        rows.push(row([applicationLink, workflow, operation.action, statusBadge('operation', operation.status), timestamp(operation.startedAt), timestamp(operation.completedAt), operation.errorCode ?? '—', actionsCell]));
      }
    }
    if (failures > 0) {
      const note = el('p', 'notice notice--warn');
      setText(note, `${failures} application${failures === 1 ? '' : 's'} could not be read; operations from the rest are shown below.`);
      append(content, note);
    }
    if (rows.length === 0 && failures === 0) {
      const empty = el('p', 'notice');
      setText(empty, 'The control plane has not recorded any operations.');
      append(content, empty);
    } else if (rows.length > 0) {
      append(content, dataTable(['APPLICATION', 'OPERATION', 'ACTION', 'STATUS', 'STARTED', 'COMPLETED', 'ERROR', 'ACTIONS'], rows));
    }
    host.fill(content);
  } catch (error) {
    handlePageError(host, context, error);
  }
  return { title: 'Operations', element: host.root };
}
