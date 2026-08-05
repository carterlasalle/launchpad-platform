import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import { D1LaunchpadStore } from '@launchpad/database';

/**
 * D1 shim shared by integration tests: a real SQLite engine (`node:sqlite`)
 * executing the actual migrations from migrations/d1/. D1 is SQLite-based, so
 * this validates the migrations, constraints, triggers, and partial unique
 * indexes with real SQL semantics. The store only uses the subset of the D1
 * API (`prepare`/`bind`/`run`/`all`/`first`/`batch`) that the shim mirrors.
 */
export interface D1TestShim {
  d1: D1Database;
  raw: DatabaseSync;
  store: D1LaunchpadStore;
}

export function createD1Shim(options: { now?: () => Date } = {}): D1TestShim {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  const migrationsDir = new URL('../../migrations/d1/', import.meta.url);
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
  return { d1, raw, store: new D1LaunchpadStore(d1, options) };
}
