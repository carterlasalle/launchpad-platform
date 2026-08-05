// Audit history page. With an application id it reads the application's
// audit trail (GET /v1/applications/:id/audit); without one it fans out over
// the application catalog and merges every application's trail. Per-app read
// failures are surfaced as an explicit note — partial results are never
// presented as complete.

import { requireArrayField } from '../api.js';
import { append, el, internalLink, setText, timestamp } from '../dom.js';
import type { PageContext, PageView } from '../router.js';
import type { AuditEvent, DashboardApplication } from '../types.js';
import { codeText, createPageHost, dataTable, handlePageError, pageHeading, row, subNav } from './common.js';

export async function renderAuditPage(context: PageContext, params: Record<string, string>): Promise<PageView> {
  const applicationId = params.id ?? null;
  const host = createPageHost();
  host.show({ kind: 'loading', title: 'Reading audit trail', message: applicationId === null ? 'Loading audit history across the catalog…' : `Loading audit history for ${applicationId}…` });
  try {
    const content = el('div', 'page__content');
    append(content, pageHeading('OPERATIONS / AUDIT HISTORY', 'Audit', applicationId ?? 'all applications'));
    if (applicationId !== null) append(content, subNav(applicationId));
    const outcome = applicationId === null ? await loadGlobalAudit(context) : await loadApplicationAudit(context, applicationId);
    if (outcome.failures > 0) {
      const note = el('p', 'notice notice--warn');
      setText(note, `${outcome.failures} application${outcome.failures === 1 ? '' : 's'} could not be read; showing ${outcome.events.length} recorded event${outcome.events.length === 1 ? '' : 's'} from the rest.`);
      append(content, note);
    }
    if (outcome.events.length === 0 && outcome.failures === 0) {
      const empty = el('p', 'notice');
      setText(empty, applicationId === null ? 'The control plane has not recorded any audit events.' : `The control plane has not recorded audit events for ${applicationId}.`);
      append(content, empty);
    } else {
      append(content, auditTable(outcome.events, applicationId));
    }
    host.fill(content);
  } catch (error) {
    handlePageError(host, context, error);
  }
  return { title: 'Audit', element: host.root };
}

interface AuditOutcome {
  events: AuditEvent[];
  failures: number;
}

async function loadApplicationAudit(context: PageContext, applicationId: string): Promise<AuditOutcome> {
  const payload = await context.client.get<Record<string, unknown>>(`/v1/applications/${encodeURIComponent(applicationId)}/audit`);
  const events = requireArrayField(payload, 'events', 'audit event list') as unknown as AuditEvent[];
  return { events: events.slice().sort(byNewest), failures: 0 };
}

async function loadGlobalAudit(context: PageContext): Promise<AuditOutcome> {
  const payload = await context.client.get<Record<string, unknown>>('/v1/applications');
  const applications = requireArrayField(payload, 'applications', 'application list') as unknown as DashboardApplication[];
  if (applications.length === 0) return { events: [], failures: 0 };
  const results = await Promise.allSettled(applications.map((application) => loadApplicationAudit(context, application.application)));
  const events: AuditEvent[] = [];
  let failures = 0;
  for (const result of results) {
    if (result.status === 'fulfilled') events.push(...result.value.events);
    else failures += 1;
  }
  events.sort(byNewest);
  return { events, failures };
}

function byNewest(left: AuditEvent, right: AuditEvent): number {
  return right.createdAt.localeCompare(left.createdAt);
}

function auditTable(events: AuditEvent[], applicationId: string | null): HTMLElement {
  const rows = events.map((event) => {
    const application = applicationId === null ? internalLink(`#/applications/${encodeURIComponent(event.applicationId)}/audit`, event.applicationId) : event.applicationId;
    return row([timestamp(event.createdAt), application, event.actor, event.action, codeText(event.details)]);
  });
  return dataTable(['CREATED', 'APPLICATION', 'ACTOR', 'ACTION', 'DETAILS'], rows);
}
