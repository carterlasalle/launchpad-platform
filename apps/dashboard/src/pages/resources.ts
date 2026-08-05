// Resource graph page — renders the resources reported by
// GET /v1/applications/:id/resources as a provider resource list.

import { requireArrayField } from '../api.js';
import { append, el, setText, timestamp } from '../dom.js';
import type { PageContext, PageView } from '../router.js';
import type { ResourceEntry } from '../types.js';
import { createPageHost, handlePageError, pageHeading, subNav } from './common.js';

export async function renderResourcesPage(context: PageContext, params: Record<string, string>): Promise<PageView> {
  const applicationId = params.id ?? '';
  const host = createPageHost();
  host.show({ kind: 'loading', title: 'Reading resources', message: `Loading provider resources for ${applicationId}…` });
  try {
    const payload = await context.client.get<Record<string, unknown>>(`/v1/applications/${encodeURIComponent(applicationId)}/resources`);
    const resources = requireArrayField(payload, 'resources', 'resource list') as unknown as ResourceEntry[];
    const content = el('div', 'page__content');
    append(content, pageHeading('OPERATIONS / RESOURCE GRAPH', 'Resources', applicationId));
    append(content, subNav(applicationId));
    if (resources.length === 0) {
      const empty = el('p', 'notice');
      setText(empty, 'The control plane has not reported provider resources for this application.');
      append(content, empty);
    } else {
      const grid = el('div', 'card-grid');
      for (const resource of resources) append(grid, resourceCard(resource));
      append(content, grid);
    }
    host.fill(content);
  } catch (error) {
    handlePageError(host, context, error);
  }
  return { title: 'Resources', element: host.root };
}

function resourceCard(resource: ResourceEntry): HTMLElement {
  const card = el('article', 'card');
  const head = el('div', 'card__head');
  const title = el('h3', 'card__title');
  setText(title, resource.resourceKey || 'Unnamed resource');
  const type = el('span', 'card__meta');
  setText(type, `${resource.provider} · ${resource.resourceType}`);
  append(head, title, type);
  const details = el('dl', 'def-list');
  const idDt = el('dt');
  setText(idDt, 'PROVIDER ID');
  const idDd = el('dd');
  setText(idDd, resource.providerResourceId);
  const observedDt = el('dt');
  setText(observedDt, 'OBSERVED');
  const observedDd = el('dd');
  setText(observedDd, timestamp(resource.observedAt));
  append(details, idDt, idDd, observedDt, observedDd);
  append(card, head, details);
  const configuration = resource.configuration;
  if (typeof configuration === 'object' && configuration !== null) {
    const configList = el('dl', 'def-list def-list--config');
    for (const [key, value] of Object.entries(configuration)) {
      const dt = el('dt');
      setText(dt, key);
      const dd = el('dd');
      setText(dd, typeof value === 'string' ? value : JSON.stringify(value));
      append(configList, dt, dd);
    }
    append(card, configList);
  }
  return card;
}
