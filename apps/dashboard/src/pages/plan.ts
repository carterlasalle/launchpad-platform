// Plan detail page — reads the control plane's persisted plan records
// (GET /v1/applications/:id/plan). Plans are bounded D1 rows: fingerprint,
// source commit, result, and a per-plan operation summary. Nothing here is
// ever interpolated into HTML; all rendering flows through the safe DOM
// helpers.

import { requireArrayField } from '../api.js';
import { append, el, setText, shortId, statusBadge, timestamp } from '../dom.js';
import type { PageContext, PageView } from '../router.js';
import type { PlanView } from '../types.js';
import { createPageHost, dataTable, handlePageError, pageHeading, row, subNav } from './common.js';

export async function renderPlanPage(context: PageContext, params: Record<string, string>): Promise<PageView> {
  const applicationId = params.id ?? '';
  const host = createPageHost();
  host.show({ kind: 'loading', title: 'Reading plan records', message: `Loading persisted plans for ${applicationId}…` });
  try {
    const payload = await context.client.get<Record<string, unknown>>(`/v1/applications/${encodeURIComponent(applicationId)}/plan`);
    const plans = requireArrayField(payload, 'plans', 'plan list') as unknown as PlanView[];
    const content = el('div', 'page__content');
    append(content, pageHeading('OPERATIONS / PLAN DETAIL', 'Plan activity', applicationId));
    append(content, subNav(applicationId));
    if (plans.length === 0) {
      const empty = el('p', 'notice');
      setText(empty, 'The control plane has not recorded plans for this application.');
      append(content, empty);
    } else {
      const rows = plans.map((plan) => {
        const fingerprint = el('code', 'mono');
        setText(fingerprint, shortId(plan.fingerprint, 16));
        const operations = plan.operationCount > 0 ? `${plan.operationCount} operation${plan.operationCount === 1 ? '' : 's'}` : 'none';
        return row([fingerprint, statusBadge('plan', plan.result), operations, plan.sourceCommit === '' ? '—' : shortId(plan.sourceCommit, 12), timestamp(plan.createdAt)]);
      });
      append(content, dataTable(['FINGERPRINT', 'RESULT', 'OPERATIONS', 'SOURCE COMMIT', 'CREATED'], rows));
    }
    host.fill(content);
  } catch (error) {
    handlePageError(host, context, error);
  }
  return { title: 'Plan', element: host.root };
}
