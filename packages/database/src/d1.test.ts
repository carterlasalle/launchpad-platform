import { describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import { runStoreContractSuite, T0 } from './contract.test.js';
import { D1LaunchpadStore } from './d1.js';

/**
 * D1-backed store tests run against a real SQLite engine (`node:sqlite`)
 * executing the actual migrations from migrations/d1/. D1 is SQLite-based, so
 * this validates the migrations, constraints, triggers, and partial unique
 * indexes with real SQL semantics. The store only uses the subset of the D1
 * API (`prepare`/`bind`/`run`/`all`/`first`/`batch`) that the shim mirrors.
 */

interface D1TestShim {
  d1: D1Database;
  raw: DatabaseSync;
}

function createShim(): D1TestShim {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  const migrationsDir = new URL('../../../migrations/d1/', import.meta.url);
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    raw.exec(readFileSync(new URL(file, migrationsDir), 'utf8'));
  }
  const kinds = new WeakMap<D1PreparedStatement, 'query' | 'write'>();
  const prepare = (sql: string): D1PreparedStatement => {
    const statement = raw.prepare(sql);
    const kind: 'query' | 'write' = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)/i.test(sql) ? 'query' : 'write';
    let values: SQLInputValue[] = [];
    const bound = {
      bind(...args: unknown[]): D1PreparedStatement {
        // node:sqlite accepts null, numbers, bigints, strings, and binary
        // views; reject anything else here instead of passing it through to
        // the SQLite binding layer.
        values = args.map((value): SQLInputValue => {
          if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
            return value;
          }
          if (ArrayBuffer.isView(value)) {
            return value as unknown as SQLInputValue;
          }
          throw new TypeError(`Unsupported SQL bind value of type '${typeof value}'`);
        });
        return bound as unknown as D1PreparedStatement;
      },
      async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        const out = statement.run(...values) as { changes: number | bigint; lastInsertRowid: number | bigint };
        return { success: true, meta: { duration: 0, size_after: 0, rows_read: 0, rows_written: 0, last_row_id: Number(out.lastInsertRowid), changed_db: Number(out.changes) > 0, changes: Number(out.changes) }, results: [] as T[] };
      },
      async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        const rows = statement.all(...values) as T[];
        return { success: true, meta: { duration: 0, size_after: 0, rows_read: rows.length, rows_written: 0, last_row_id: 0, changed_db: false, changes: 0 }, results: rows };
      },
      async first<T = Record<string, unknown>>(): Promise<T | null> {
        const row = statement.get(...values) as T | undefined;
        return row ?? null;
      },
    };
    kinds.set(bound as unknown as D1PreparedStatement, kind);
    return bound as unknown as D1PreparedStatement;
  };
  const d1 = {
    prepare,
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const results: D1Result<T>[] = [];
      raw.exec('BEGIN');
      try {
        for (const statement of statements) {
          if (kinds.get(statement) === 'query') {
            results.push(await statement.all<T>());
          } else {
            results.push(await statement.run<T>());
          }
        }
        raw.exec('COMMIT');
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
      return results;
    },
  } as unknown as D1Database;
  return { d1, raw };
}

describe('D1LaunchpadStore', () => {
  let current = new Date(T0);
  const harness = {
    create: () => new D1LaunchpadStore(createShim().d1, { now: () => current }),
    now: () => current,
    advance: (milliseconds: number) => {
      current = new Date(current.getTime() + milliseconds);
    },
  };
  runStoreContractSuite('d1 (sqlite)', harness);
});

describe('D1 schema contracts', () => {
  const { d1, raw } = createShim();
  const store = new D1LaunchpadStore(d1, { now: () => new Date(T0) });

  it('applies every section-23 core table in forward-only migrations', () => {
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    const names = new Set(tables.map((row) => row.name));
    for (const expected of ['applications', 'resources', 'observations', 'plans', 'plan_operations', 'workflow_runs', 'workflow_steps', 'deployments', 'deployment_promotions', 'health_checks', 'drift_events', 'reconciliation_requests', 'provider_errors', 'webhook_events', 'cleanup_jobs', 'tombstones', 'audit_events', 'credentials_metadata', 'desired_generations', 'locks', 'idempotent_requests', 'deletion_approvals']) {
      expect(names.has(expected), `table ${expected}`).toBe(true);
    }
  });

  it('prohibits secret-bearing columns in every table', () => {
    const tables = raw.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string; sql: string | null }>;
    const forbidden = /(^|_)(secret|password|apikey|api_key|access_token|private_key|token|value)$/i;
    let checked = 0;
    for (const table of tables) {
      const columns = [...(table.sql ?? '').matchAll(/(\w+)\s+(TEXT|INTEGER|REAL|BLOB|NUMERIC)/g)].map((match) => match[1]);
      for (const column of columns) {
        checked += 1;
        expect(column, `${table.name}.${column}`).not.toMatch(forbidden);
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('enforces one current production deployment at the schema level', async () => {
    await store.upsertApplication({ id: 'app-schema', displayName: 'Schema App', sourcePath: 'catalog/apps/schema', desiredGeneration: 1, desiredHash: 'h', syncStatus: 'SYNCED', healthStatus: 'HEALTHY', lifecycleState: 'active' });
    await store.recordDeployment({ id: 'dep-a', applicationId: 'app-schema', projectId: 'prj', environment: 'production', repository: 'owner/repo', commitSha: 'a', desiredGeneration: 1, state: 'READY', createdAt: T0 });
    await store.recordDeployment({ id: 'dep-b', applicationId: 'app-schema', projectId: 'prj', environment: 'production', repository: 'owner/repo', commitSha: 'b', desiredGeneration: 1, state: 'READY', createdAt: T0 });
    await store.recordKnownGoodDeployment('app-schema', 'production', 'dep-a');
    await expect(store.recordKnownGoodDeployment('app-schema', 'production', 'dep-b')).resolves.toBeDefined();
    const current = raw.prepare("SELECT COUNT(*) AS count FROM deployments WHERE environment = 'production' AND state = 'CURRENT'").get() as { count: number };
    expect(current.count).toBe(1);
    expect(() => raw.prepare("INSERT INTO deployments (id, application_id, project_id, environment, repository, commit_sha, desired_generation, state, url, created_at) VALUES ('dep-c', 'app-schema', 'prj', 'production', 'owner/repo', 'c', 1, 'CURRENT', NULL, '2026-08-04T00:00:00.000Z')").run()).toThrow();
  });

  it('enforces one ownership row per provider resource id', async () => {
    await store.upsertApplication({ id: 'app-own', displayName: 'Ownership App', sourcePath: 'catalog/apps/own', desiredGeneration: 1, desiredHash: 'h', syncStatus: 'SYNCED', healthStatus: 'HEALTHY', lifecycleState: 'active' });
    expect(() => raw.prepare("INSERT INTO resources (id, application_id, provider, resource_type, resource_key, provider_resource_id, desired_generation, observed_hash, ownership_fingerprint, status, first_seen_at, last_seen_at) VALUES ('r-1', 'app-own', 'vercel', 'project', 'project', 'prj-1', 1, 'oh', 'fp', 'ACTIVE', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z')").run()).not.toThrow();
    expect(() => raw.prepare("INSERT INTO resources (id, application_id, provider, resource_type, resource_key, provider_resource_id, desired_generation, observed_hash, ownership_fingerprint, status, first_seen_at, last_seen_at) VALUES ('r-2', 'app-own', 'vercel', 'project', 'project', 'prj-1', 1, 'oh', 'fp', 'ACTIVE', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z')").run()).toThrow();
  });

  it('constrains locks to application and domain keys with valid expiry', () => {
    expect(() => raw.prepare("INSERT INTO locks (resource_key, owner_id, acquired_at, expires_at) VALUES ('project:demo', 'wf', '2026-08-04T00:00:00.000Z', '2026-08-04T00:01:00.000Z')").run()).toThrow();
    expect(() => raw.prepare("INSERT INTO locks (resource_key, owner_id, acquired_at, expires_at) VALUES ('application:app-x', 'wf', '2026-08-04T00:01:00.000Z', '2026-08-04T00:00:00.000Z')").run()).toThrow();
    expect(() => raw.prepare("INSERT INTO locks (resource_key, owner_id, acquired_at, expires_at) VALUES ('domain:example.com', 'wf', '2026-08-04T00:00:00.000Z', '2026-08-04T00:01:00.000Z')").run()).not.toThrow();
  });

  it('keeps audit events immutable at the schema level', async () => {
    await store.appendAudit({ actor: 'operator:schema', action: 'TEST_EVENT', applicationId: 'app-schema', createdAt: T0 });
    expect(() => raw.prepare("UPDATE audit_events SET actor = 'operator:evil'").run()).toThrow();
    expect(() => raw.prepare('DELETE FROM audit_events').run()).toThrow();
    const count = raw.prepare('SELECT COUNT(*) AS count FROM audit_events').get() as { count: number };
    expect(count.count).toBe(1);
  });

  it('enforces foreign keys on referencing rows', async () => {
    await store.upsertApplication({ id: 'app-fk', displayName: 'FK App', sourcePath: 'catalog/apps/fk', desiredGeneration: 1, desiredHash: 'h', syncStatus: 'SYNCED', healthStatus: 'HEALTHY', lifecycleState: 'active' });
    expect(() => raw.prepare("INSERT INTO observations (id, application_id, observed_hash, payload_json, observed_at) VALUES ('o-1', 'missing-app', 'h', '{}', '2026-08-04T00:00:00.000Z')").run()).toThrow();
    const result = await store.startWorkflowRun({ applicationId: 'app-fk', workflowType: 'apply', idempotencyKey: 'ik-fk', payloadHash: 'p' });
    expect(() => raw.prepare("INSERT INTO workflow_steps (workflow_id, step_id, status, attempt, precondition_hash, result_json, error_json) VALUES ('missing-run', 's', 'RUNNING', 1, 'p', NULL, NULL)").run()).toThrow();
    expect(() => raw.prepare("INSERT INTO idempotent_requests (idempotency_key, operation_id, payload_hash, created_at) VALUES ('ik-2', 'missing-run', 'p', '2026-08-04T00:00:00.000Z')").run()).toThrow();
    expect(result.id).toBeDefined();
  });

  it('deduplicates webhook receipts with insert-or-ignore', async () => {
    const first = await store.persistWebhookReceipt({ provider: 'vercel', eventId: 'evt-schema', payload: { id: 'first' }, receivedAt: T0 });
    const second = await store.persistWebhookReceipt({ provider: 'vercel', eventId: 'evt-schema', payload: { id: 'second' }, receivedAt: T0 });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.receipt.payload).toEqual({ id: 'first' });
  });

  it('persists the dispatch marker exactly once on the receipt row', async () => {
    await store.persistWebhookReceipt({ provider: 'vercel', eventId: 'evt-dispatch', payload: { eventId: 'evt-dispatch' }, receivedAt: T0 });
    const marked = await store.markWebhookReceiptDispatched('vercel', 'evt-dispatch', '2026-08-04T00:01:00.000Z');
    expect(marked?.dispatchedAt).toBe('2026-08-04T00:01:00.000Z');
    const again = await store.markWebhookReceiptDispatched('vercel', 'evt-dispatch', '2026-08-04T00:02:00.000Z');
    expect(again?.dispatchedAt).toBe('2026-08-04T00:01:00.000Z');
    const row = raw.prepare("SELECT dispatched_at FROM webhook_events WHERE provider = 'vercel' AND event_id = 'evt-dispatch'").get() as { dispatched_at: string | null };
    expect(row.dispatched_at).toBe('2026-08-04T00:01:00.000Z');
    expect(await store.markWebhookReceiptDispatched('vercel', 'missing')).toBeNull();
  });
});

describe('D1 audit id collision resistance', () => {
  const { d1, raw } = createShim();
  const now = () => new Date(T0);
  const identicalAppend = (store: D1LaunchpadStore) => store.appendAudit({ actor: 'operator:alice', action: 'DEPLOY_REQUESTED', applicationId: 'app-demo', details: { note: 'same' }, createdAt: T0 });

  it('retains every concurrent identical append across store instances over one database', async () => {
    const first = new D1LaunchpadStore(d1, { now });
    const second = new D1LaunchpadStore(d1, { now });
    const events = await Promise.all([
      identicalAppend(first), identicalAppend(first), identicalAppend(first), identicalAppend(first),
      identicalAppend(second), identicalAppend(second), identicalAppend(second), identicalAppend(second),
    ]);
    expect(new Set(events.map((event) => event.id)).size).toBe(8);
    const rows = raw.prepare('SELECT id FROM audit_events ORDER BY rowid').all() as Array<{ id: string }>;
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((row) => row.id)).size).toBe(8);
  });

  it('does not reuse default ids across store restarts over the same database', async () => {
    const { d1: restartD1, raw: restartRaw } = createShim();
    const first = new D1LaunchpadStore(restartD1, { now });
    await identicalAppend(first);
    const restarted = new D1LaunchpadStore(restartD1, { now });
    await identicalAppend(restarted);
    const rows = restartRaw.prepare('SELECT id FROM audit_events ORDER BY rowid').all() as Array<{ id: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).not.toBe(rows[1]?.id);
  });

  it('keeps explicit audit id replay behavior (duplicate id rejected)', async () => {
    const { d1: replayD1, raw: replayRaw } = createShim();
    const store = new D1LaunchpadStore(replayD1, { now });
    await store.appendAudit({ id: 'audit-explicit-replay', actor: 'operator:alice', action: 'DEPLOY_REQUESTED', applicationId: 'app-demo', details: {}, createdAt: T0 });
    await expect(store.appendAudit({ id: 'audit-explicit-replay', actor: 'operator:alice', action: 'DEPLOY_REQUESTED', applicationId: 'app-demo', details: {}, createdAt: T0 })).rejects.toThrow();
    const count = replayRaw.prepare('SELECT COUNT(*) AS count FROM audit_events').get() as { count: number };
    expect(count.count).toBe(1);
  });
});
