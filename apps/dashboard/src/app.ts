// Dashboard entry: builds the shell chrome, wires the session panel and
// starts the hash router. All data-driven rendering happens in pages through
// the safe DOM helpers — this module only wires events.

import { ApiClient } from './api.js';
import { setText } from './dom.js';
import { renderApplicationsPage } from './pages/applications.js';
import { renderApplicationDetailPage } from './pages/application.js';
import { renderAuditPage } from './pages/audit.js';
import { renderCredentialsPage } from './pages/credentials.js';
import { renderDriftPage, renderDeploymentsPage, renderHealthPage } from './pages/history.js';
import { renderOperationsPage } from './pages/operations.js';
import { renderPlanPage } from './pages/plan.js';
import { renderResourcesPage } from './pages/resources.js';
import { renderWorkflowPage } from './pages/workflow.js';
import { HashRouter, defineRoute, type RouteDefinition } from './router.js';
import { readSessionToken, writeSessionToken } from './session.js';

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing dashboard element #${id}`);
  return element;
}

const view = byId('view');
const authState = byId('auth-state');
const sessionPanel = byId('session-panel');
const sessionTokenInput = byId('session-token') as HTMLInputElement;
const sessionHint = byId('session-hint');
const sessionToggle = byId('session-toggle');
const sessionSave = byId('session-save');
const sessionClear = byId('session-clear');

const client = new ApiClient({
  token: readSessionToken(),
  onUnauthorized: () => setText(authState, 'SESSION REJECTED'),
});

const routes: RouteDefinition[] = [
  defineRoute('/', 'applications', renderApplicationsPage),
  defineRoute('/applications/:id', 'application', renderApplicationDetailPage),
  defineRoute('/applications/:id/resources', 'resources', renderResourcesPage),
  defineRoute('/applications/:id/plan', 'plan', renderPlanPage),
  defineRoute('/applications/:id/workflows/:operationId', 'workflow', renderWorkflowPage),
  defineRoute('/applications/:id/deployments', 'deployments', renderDeploymentsPage),
  defineRoute('/applications/:id/health', 'health', renderHealthPage),
  defineRoute('/applications/:id/drift', 'drift', renderDriftPage),
  defineRoute('/applications/:id/audit', 'audit', renderAuditPage),
  defineRoute('/operations', 'operations', renderOperationsPage),
  defineRoute('/audit', 'audit', renderAuditPage),
  defineRoute('/credentials', 'credentials', renderCredentialsPage),
];

const router = new HashRouter({
  routes,
  container: view,
  client,
  openSession: () => {
    sessionPanel.classList.add('is-open');
    sessionTokenInput.focus();
  },
});

function refreshSessionUi(): void {
  const token = client.token;
  setText(authState, token === null ? 'NO SESSION' : 'SESSION ACTIVE');
  sessionTokenInput.value = token ?? '';
  setText(
    sessionHint,
    token === null
      ? 'No operator session token. Protected control-plane reads fail closed until a token is saved.'
      : 'Operator session token stored for this browser tab and sent as a Bearer credential.',
  );
}

sessionToggle.addEventListener('click', () => {
  sessionPanel.classList.toggle('is-open');
});

sessionSave.addEventListener('click', () => {
  const token = sessionTokenInput.value.trim();
  if (token === '') {
    setText(sessionHint, 'A session token cannot be empty.');
    return;
  }
  writeSessionToken(token);
  client.setToken(token);
  refreshSessionUi();
  sessionPanel.classList.remove('is-open');
  void router.render();
});

sessionClear.addEventListener('click', () => {
  writeSessionToken(null);
  client.setToken(null);
  refreshSessionUi();
  sessionPanel.classList.remove('is-open');
  void router.render();
});

refreshSessionUi();
setText(
  byId('current-time'),
  new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase(),
);
router.start();
