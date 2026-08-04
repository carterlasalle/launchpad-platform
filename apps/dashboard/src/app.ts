interface ApplicationState { application?: string; displayName?: string; owner?: string; sync?: string; health?: string; deployment?: string; productionUrl?: string | null; updatedAt?: string; }

const state = { applications: [] as ApplicationState[] };
const byId = (id: string): HTMLElement => { const element = document.getElementById(id); if (!element) throw new Error(`Missing dashboard element ${id}`); return element; };

function badge(value: string | undefined, kind: 'sync' | 'health' | 'deployment'): string {
  const safe = value ?? 'UNKNOWN';
  const normalized = safe.toLowerCase().replaceAll('_', '-');
  return `<span class="badge ${kind} ${normalized}"><i></i>${safe.replaceAll('_', ' ')}</span>`;
}

function render(): void {
  const apps = state.applications;
  const synced = apps.filter((app) => app.sync === 'SYNCED').length;
  const active = apps.filter((app) => app.deployment && !['CURRENT', 'UNKNOWN'].includes(app.deployment)).length;
  const incidents = apps.filter((app) => ['UNHEALTHY', 'DEGRADED', 'BLOCKED'].includes(app.health ?? '')).length;
  byId('metric-apps').textContent = String(apps.length).padStart(2, '0');
  byId('metric-sync').textContent = apps.length === 0 ? '—' : `${Math.round((synced / apps.length) * 100)}%`;
  byId('metric-releases').textContent = String(active).padStart(2, '0');
  byId('metric-incidents').textContent = String(incidents).padStart(2, '0');
  byId('sync-count').textContent = String(apps.length).padStart(2, '0');
  const body = byId('applications');
  body.innerHTML = apps.length === 0 ? '<tr><td colspan="6" class="empty">No applications are registered in the current desired state.</td></tr>' : apps.map((app) => `<tr><td><strong>${app.displayName ?? app.application ?? 'Unnamed application'}</strong><small>${app.application ?? ''} · ${app.owner ?? 'unowned'}</small></td><td>${badge(app.sync, 'sync')}</td><td>${badge(app.health, 'health')}</td><td>${badge(app.deployment, 'deployment')}</td><td>${app.productionUrl ? `<a href="https://${app.productionUrl}" target="_blank" rel="noreferrer">${app.productionUrl} ↗</a>` : '—'}</td><td>${app.updatedAt ? new Date(app.updatedAt).toLocaleString() : '—'}</td></tr>`).join('');
  byId('table-state').textContent = apps.length === 0 ? 'Catalog loaded · no applications found' : `${apps.length} application${apps.length === 1 ? '' : 's'} · live status`; 
}

async function refresh(): Promise<void> {
  byId('table-state').textContent = 'Reading control-plane state…';
  try {
    const response = await fetch('/v1/applications', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json() as { applications?: ApplicationState[] };
    state.applications = body.applications ?? [];
  } catch (error) {
    state.applications = [];
    byId('table-state').textContent = `Control-plane read failed · ${error instanceof Error ? error.message : 'unknown error'}`;
  }
  render();
}

byId('current-time').textContent = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();
byId('refresh').addEventListener('click', () => void refresh());
void refresh();
