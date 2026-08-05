// Application list page — reads GET /v1/applications and renders only what
// the control plane reports. Empty, error, unknown and unauthenticated states
// are all rendered explicitly; no status is ever invented.

import { requireArrayField } from '../api.js';
import { append, el, internalLink, setText, statusBadge, timestamp } from '../dom.js';
import type { PageContext, PageView } from '../router.js';
import type { DashboardApplication } from '../types.js';
import { externalLink } from '../urls.js';
import { createPageHost, dataTable, handlePageError, pageHeading, row } from './common.js';

export async function renderApplicationsPage(context: PageContext): Promise<PageView> {
  const host = createPageHost();
  host.show({ kind: 'loading', title: 'Reading application catalog', message: 'Loading application state from the control plane…' });
  try {
    const payload = await context.client.get<Record<string, unknown>>('/v1/applications');
    const applications = requireArrayField(payload, 'applications', 'application list') as unknown as DashboardApplication[];
    if (applications.length === 0) {
      host.show({
        kind: 'empty',
        title: 'No applications registered',
        message: 'The control plane reports an empty application catalog. Add an application manifest to the catalog to see it here.',
      });
      return { title: 'Applications', element: host.root };
    }
    const content = el('div', 'page__content');
    append(content, pageHeading('OPERATIONS / APPLICATION CATALOG', 'Applications', `${applications.length} application${applications.length === 1 ? '' : 's'} tracked`));
    append(content, applicationsTable(applications));
    host.fill(content);
  } catch (error) {
    handlePageError(host, context, error);
  }
  return { title: 'Applications', element: host.root };
}

export function applicationsTable(applications: DashboardApplication[]): HTMLElement {
  const rows = applications.map((application) => {
    const name = internalLink(`#/applications/${encodeURIComponent(application.application)}`, application.displayName || application.application || 'Unnamed application');
    const idLine = el('small');
    setText(idLine, [application.application, application.owner].filter((value) => value !== '' && value !== null).join(' · '));
    const identity = el('div');
    append(identity, name, idLine);
    const production = application.productionUrl === null || application.productionUrl === '' ? setText(el('span'), '—') : externalLink(application.productionUrl);
    return row([identity, application.owner, statusBadge('sync', application.sync), statusBadge('health', application.health), statusBadge('deployment', application.deployment), production, timestamp(application.updatedAt)]);
  });
  return dataTable(['APPLICATION', 'OWNER', 'SYNC', 'HEALTH', 'DEPLOYMENT', 'PRODUCTION', 'UPDATED'], rows);
}
