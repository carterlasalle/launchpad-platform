// Workflow detail page — a single operation record and its durable step
// history from GET /v1/applications/:id/operations/:operationId. Step
// errors are redacted by the control plane (bounded code/message only); the
// page renders exactly what the API returns and never invents step data.

import { append, el, internalLink, setText, shortId, statusBadge, timestamp } from '../dom.js';
import { operatorActionControls, type OperatorActionKind } from '../actions.js';
import type { ApiClient } from '../api.js';
import type { PageContext, PageView } from '../router.js';
import type { OperationDetailResponse, OperationRecord, WorkflowStepView } from '../types.js';
import { createPageHost, dataTable, handlePageError, pageHeading, row, subNav } from './common.js';

export async function renderWorkflowPage(context: PageContext, params: Record<string, string>): Promise<PageView> {
  const applicationId = params.id ?? '';
  const operationId = params.operationId ?? '';
  const host = createPageHost();
  host.show({ kind: 'loading', title: 'Reading workflow', message: `Loading workflow ${operationId}…` });
  try {
    const payload = await context.client.get<OperationDetailResponse>(`/v1/applications/${encodeURIComponent(applicationId)}/operations/${encodeURIComponent(operationId)}`);
    const operation = payload.operation ?? null;
    if (operation === null) {
      host.show({
        kind: 'unknown',
        title: 'Workflow not found',
        message: `The control plane has no record of operation "${operationId}" for application "${applicationId}".`,
        actions: [
          internalLink(`#/applications/${encodeURIComponent(applicationId)}`, 'BACK TO APPLICATION'),
          internalLink('#/operations', 'VIEW OPERATIONS'),
        ],
      });
      return { title: 'Workflow', element: host.root };
    }
    const steps = Array.isArray(payload.steps) ? (payload.steps as WorkflowStepView[]) : [];
    const content = el('div', 'page__content');
    append(content, pageHeading('OPERATIONS / WORKFLOW DETAIL', operation.action, operation.id));
    append(content, subNav(applicationId));
    append(content, workflowDetails(applicationId, operation));
    append(content, operatorActionsSection(applicationId, operation, context.client));
    append(content, stepsSection(operationId, steps));
    host.fill(content);
  } catch (error) {
    handlePageError(host, context, error);
  }
  return { title: 'Workflow', element: host.root };
}

function workflowDetails(applicationId: string, operation: OperationRecord): HTMLElement {
  const details = el('dl', 'def-list');
  const entries: Array<[string, string | HTMLElement]> = [
    ['APPLICATION', internalLink(`#/applications/${encodeURIComponent(applicationId)}`, applicationId)],
    ['ACTION', operation.action],
    ['STATUS', ''],
    ['WORKFLOW ID', operation.workflowId],
    ['IDEMPOTENCY KEY', operation.idempotencyKey],
    ['PAYLOAD HASH', operation.payloadHash],
    ['STARTED', timestamp(operation.startedAt)],
    ['COMPLETED', timestamp(operation.completedAt)],
    ['ERROR', operation.errorCode ?? '—'],
  ];
  for (const [label, value] of entries) {
    const dt = el('dt');
    setText(dt, label);
    const dd = el('dd');
    if (label === 'STATUS') append(dd, statusBadge('operation', operation.status));
    else if (typeof value === 'string') setText(dd, value);
    else append(dd, value);
    append(details, dt, dd);
  }
  return details;
}

/**
 * Operation-scoped recovery controls: RETRY for failed/blocked operations and
 * CANCEL for queued ones, each issuing the existing control-plane action
 * endpoint through the authenticated client.
 */
function operatorActionsSection(applicationId: string, operation: OperationRecord, client: ApiClient): HTMLElement {
  const section = el('section', 'page__section');
  const heading = el('h2');
  setText(heading, 'Operator actions');
  append(section, heading);
  const kinds: OperatorActionKind[] = [];
  if (operation.status === 'FAILED' || operation.status === 'BLOCKED') kinds.push('retry');
  if (operation.status === 'QUEUED') kinds.push('cancel');
  if (kinds.length === 0) {
    const empty = el('p', 'notice');
    setText(empty, `No operator actions are available for a ${operation.status} operation.`);
    append(section, empty);
    return section;
  }
  append(section, operatorActionControls({ client, applicationId, operationId: operation.id, kinds }));
  return section;
}

function stepsSection(operationId: string, steps: WorkflowStepView[]): HTMLElement {
  const section = el('section', 'page__section');
  const heading = el('h2');
  setText(heading, 'Workflow steps');
  append(section, heading);
  if (steps.length === 0) {
    const empty = el('p', 'notice');
    setText(empty, 'The control plane has not recorded durable steps for this operation yet.');
    append(section, empty);
    return section;
  }
  const rows = steps.map((step) => {
    const errorCell = el('div');
    if (step.error === null) {
      setText(errorCell, '—');
    } else {
      const codeLine = el('p', 'drift-line');
      setText(codeLine, step.error.code === null ? 'error' : step.error.code);
      append(errorCell, codeLine);
      if (step.error.message !== null && step.error.message !== '') {
        const messageLine = el('p', 'drift-line');
        setText(messageLine, step.error.message);
        append(errorCell, messageLine);
      }
    }
    const stepId = el('code', 'mono');
    setText(stepId, step.stepId);
    return row([stepId, statusBadge('operation', step.status), String(step.attempt), shortId(step.preconditionHash, 12), errorCell]);
  });
  append(section, dataTable(['STEP', 'STATUS', 'ATTEMPT', 'PRECONDITION', 'ERROR'], rows));
  return section;
}
