import type { D1Database } from '@cloudflare/workers-types';

export interface DashboardApplicationRow { application: string; displayName: string; owner: string; sync: string; health: string; deployment: string; productionUrl: string | null; updatedAt: string; }

export class D1LaunchpadStore {
  readonly db: D1Database;
  constructor(db: D1Database) { this.db = db; }

  async listApplications(): Promise<DashboardApplicationRow[]> {
    const result = await this.db.prepare('SELECT id, display_name, sync_status, health_status, updated_at FROM applications ORDER BY id').all<{ id: string; display_name: string; sync_status: string; health_status: string; updated_at: string }>();
    return result.results.map((row) => ({ application: row.id, displayName: row.display_name, owner: 'catalog-owner', sync: row.sync_status, health: row.health_status, deployment: 'UNKNOWN', productionUrl: null, updatedAt: row.updated_at }));
  }

  async recordAudit(input: { id: string; actor: string; action: string; applicationId: string; detailsJson: string; createdAt: string }): Promise<void> {
    await this.db.prepare('INSERT INTO audit_events (id, actor, action, application_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(input.id, input.actor, input.action, input.applicationId, input.detailsJson, input.createdAt).run();
  }
}
