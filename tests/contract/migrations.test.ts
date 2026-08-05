import { describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * D1 migration-forward contracts (master plan section 23). These run against
 * a real SQLite engine (`node:sqlite`) executing the actual migration files
 * from migrations/d1/ — never an in-memory substitute — and prove the
 * forward chain 0001 → latest preserves representative prior data, enforces
 * constraints and triggers, prohibits rollback, and produces the exact
 * schema copy the store depends on.
 */

const MIGRATIONS_DIR = new URL('../../migrations/d1/', import.meta.url);
const T0 = '2026-08-04T00:00:00.000Z';

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort();
}

function migrate(raw: DatabaseSync, files: string[]): void {
  raw.exec('PRAGMA foreign_keys = ON');
  for (const file of files) {
    raw.exec(readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8'));
  }
}

function freshDb(upTo: string | null = null): DatabaseSync {
  const raw = new DatabaseSync(':memory:');
  const files = upTo === null ? migrationFiles() : migrationFiles().filter((name) => name <= upTo);
  migrate(raw, files);
  return raw;
}

function insert(raw: DatabaseSync, sql: string, ...values: SQLInputValue[]): void {
  raw.prepare(sql).run(...values);
}

function count(raw: DatabaseSync, sql: string): number {
  return Number((raw.prepare(sql).get() as { count: number }).count);
}

/** Representative 0001-era data: one row per core table with valid invariants. */
function seedPriorData(raw: DatabaseSync): void {
  insert(raw, "INSERT INTO applications (id, display_name, source_path, desired_generation, desired_hash, sync_status, health_status, lifecycle_state, updated_at) VALUES ('app-prior', 'Prior App', 'catalog/apps/prior', 3, 'hash-3', 'SYNCED', 'HEALTHY', 'active', ?)", T0);
  insert(raw, "INSERT INTO resources (id, application_id, provider, resource_type, resource_key, provider_resource_id, desired_generation, observed_hash, ownership_fingerprint, status, first_seen_at, last_seen_at) VALUES ('res-1', 'app-prior', 'vercel', 'project', 'vercel.project', 'prj_prior', 3, 'observed-1', 'fp-1', 'ACTIVE', ?, ?)", T0, T0);
  insert(raw, "INSERT INTO observations (id, application_id, observed_hash, payload_json, observed_at) VALUES ('obs-1', 'app-prior', 'observed-1', '{\"name\":\"prior\"}', ?)", T0);
  insert(raw, "INSERT INTO plans (id, application_id, fingerprint, source_commit, result, payload_json, created_at) VALUES ('plan-1', 'app-prior', 'fp-plan', ?, 'READY', '{}', ?)", 'a'.repeat(40), T0);
  insert(raw, "INSERT INTO plan_operations (id, plan_id, resource_key, action, destructive, payload_json) VALUES ('op-1', 'plan-1', 'vercel.project', 'CREATE', 0, '{}')");
  insert(raw, "INSERT INTO workflow_runs (id, application_id, workflow_type, status, idempotency_key, payload_hash, started_at, completed_at, error_code) VALUES ('wf-1', 'app-prior', 'APPLY', 'SUCCEEDED', 'ik-wf-1', 'payload-1', ?, ?, NULL)", T0, T0);
  insert(raw, "INSERT INTO workflow_steps (workflow_id, step_id, status, attempt, precondition_hash, result_json, error_json) VALUES ('wf-1', 'step-1', 'SUCCEEDED', 1, 'pre-1', '{}', NULL)");
  insert(raw, "INSERT INTO deployments (id, application_id, project_id, environment, repository, commit_sha, desired_generation, state, url, created_at) VALUES ('dep-1', 'app-prior', 'prj_prior', 'production', 'acme/prior', ?, 3, 'READY', 'https://prior.example.com', ?)", 'a'.repeat(40), T0);
  insert(raw, "INSERT INTO deployment_promotions (id, application_id, deployment_id, previous_deployment_id, result, promoted_at) VALUES ('promo-1', 'app-prior', 'dep-1', NULL, 'PROMOTED', ?)", T0);
  insert(raw, "INSERT INTO health_checks (id, application_id, environment, deployment_id, result, payload_json, checked_at) VALUES ('hc-1', 'app-prior', 'production', 'dep-1', 'PASSED', '{}', ?)", T0);
  insert(raw, "INSERT INTO drift_events (id, application_id, fingerprint, category, payload_json, observed_at, resolved_at) VALUES ('drift-1', 'app-prior', 'fp-drift', 'changed', '{}', ?, NULL)", T0);
  insert(raw, "INSERT INTO reconciliation_requests (id, application_id, fingerprint, mode, pull_request_number, pull_request_url, status) VALUES ('recon-1', 'app-prior', 'fp-recon', 'restore-desired-state', 12, 'https://github.com/acme/control/pull/12', 'OPEN')");
  insert(raw, "INSERT INTO provider_errors (id, application_id, operation_id, provider, code, class, retryable, safe_details_json, created_at) VALUES ('perr-1', 'app-prior', 'op-1', 'vercel', 'LP-VERCEL-HTTP-429', 'RATE_LIMITED', 1, '{\"status\":429}', ?)", T0);
  insert(raw, "INSERT INTO webhook_events (provider, event_id, payload_json, received_at) VALUES ('vercel', 'evt-prior', '{}', ?)", T0);
  insert(raw, "INSERT INTO cleanup_jobs (id, application_id, provider_resource_id, expires_at, status, attempts, last_error) VALUES ('cleanup-1', 'app-prior', 'prj_prior', ?, 'PENDING', 0, NULL)", T0);
  insert(raw, "INSERT INTO tombstones (application_id, domain, deleted_at, retain_until) VALUES ('app-gone', 'gone.example.com', ?, ?)", T0, T0);
  insert(raw, "INSERT INTO audit_events (id, actor, action, application_id, details_json, created_at) VALUES ('audit-1', 'operator:prior', 'APPLY_SUCCEEDED', 'app-prior', '{}', ?)", T0);
  insert(raw, "INSERT INTO credentials_metadata (id, provider, purpose, expires_at, last_checked_at, status) VALUES ('cred-1', 'vercel', 'deploy', NULL, ?, 'VALID')", T0);
}

describe('D1 migration forward chain', () => {
  it('migrates 0001 → latest while preserving every prior row and adding safe defaults', () => {
    const raw = freshDb('0001_initial.sql');
    seedPriorData(raw);
    expect(count(raw, "SELECT COUNT(*) AS count FROM applications")).toBe(1);
    expect(count(raw, "SELECT COUNT(*) AS count FROM health_checks")).toBe(1);

    migrate(raw, migrationFiles().filter((name) => name > '0001_initial.sql'));

    // Prior rows survive with their original values.
    expect(count(raw, "SELECT COUNT(*) AS count FROM applications")).toBe(1);
    expect((raw.prepare("SELECT display_name, desired_generation, desired_hash FROM applications WHERE id = 'app-prior'").get() as { display_name: string; desired_generation: number; desired_hash: string })).toEqual({ display_name: 'Prior App', desired_generation: 3, desired_hash: 'hash-3' });
    expect((raw.prepare("SELECT state, commit_sha FROM deployments WHERE id = 'dep-1'").get() as { state: string; commit_sha: string })).toEqual({ state: 'READY', commit_sha: 'a'.repeat(40) });
    expect(count(raw, "SELECT COUNT(*) AS count FROM resources")).toBe(1);
    expect(count(raw, "SELECT COUNT(*) AS count FROM workflow_runs")).toBe(1);
    expect(count(raw, "SELECT COUNT(*) AS count FROM webhook_events")).toBe(1);
    expect(count(raw, "SELECT COUNT(*) AS count FROM audit_events")).toBe(1);
    expect(count(raw, "SELECT COUNT(*) AS count FROM tombstones")).toBe(1);

    // 0003 columns arrive with conservative defaults on prior rows.
    const health = raw.prepare("SELECT url, attempt, dns_resolved, tls_valid, status_code, latency_ms, assertion_results_json, error_code FROM health_checks WHERE id = 'hc-1'").get() as Record<string, unknown>;
    expect(health).toEqual({ url: null, attempt: 1, dns_resolved: 0, tls_valid: 0, status_code: null, latency_ms: null, assertion_results_json: '[]', error_code: null });
    const providerError = raw.prepare("SELECT message, cause_fingerprint, remediation FROM provider_errors WHERE id = 'perr-1'").get() as Record<string, unknown>;
    expect(providerError).toEqual({ message: '', cause_fingerprint: '', remediation: '' });
    expect((raw.prepare("SELECT owners_json FROM applications WHERE id = 'app-prior'").get() as { owners_json: string }).owners_json).toBe('[]');
    const reconciliation = raw.prepare("SELECT opened_at, resolved_at FROM reconciliation_requests WHERE id = 'recon-1'").get() as Record<string, unknown>;
    expect(reconciliation).toEqual({ opened_at: null, resolved_at: null });
    expect((raw.prepare("SELECT value_fingerprint FROM credentials_metadata WHERE id = 'cred-1'").get() as { value_fingerprint: string | null }).value_fingerprint).toBeNull();

    // 0003/0004 tables exist and accept rows.
    insert(raw, "INSERT INTO desired_generations (application_id, generation, desired_hash, updated_at) VALUES ('app-prior', 3, 'hash-3', ?)", T0);
    insert(raw, "INSERT INTO locks (resource_key, owner_id, acquired_at, expires_at) VALUES ('application:app-prior', 'wf', ?, ?)", T0, '2026-08-04T00:01:00.000Z');
    insert(raw, "INSERT INTO idempotent_requests (idempotency_key, operation_id, payload_hash, created_at) VALUES ('ik-2', 'wf-1', 'p', ?)", T0);
    insert(raw, "INSERT INTO deletion_approvals (id, application_id, token_hash, requested_by, status, expires_at, created_at) VALUES ('da-1', 'app-prior', 'th', NULL, 'PENDING', ?, ?)", T0, T0);
    insert(raw, "INSERT INTO incidents (id, type, fingerprint, severity, message, details_json, first_seen_at, last_fired_at) VALUES ('inc-1', 'CONTROLLER_ERROR_RATE', 'fp-inc', 'warning', 'x', '{}', ?, ?)", T0, T0);
    insert(raw, "INSERT INTO metric_snapshots (id, metric, total, rate, window_seconds, labels_json, captured_at) VALUES ('m-1', 'apply.failures', 1, 0.5, 60, '{}', ?)", T0);

    // 0005 reviewed-plan attestations exist, enforce the (application,
    // review fingerprint) idempotency key, and require a real application.
    insert(raw, "INSERT INTO plan_review_attestations (id, application_id, pr_head_source_commit, desired_hash, generation, plan_fingerprint, review_fingerprint, repository, actor, workflow_ref, created_at) VALUES ('pra-1', 'app-prior', ?, ?, 3, 'fp-plan', 'fp-review', 'acme/prior', 'alice', 'acme/prior/.github/workflows/validate-plan.yml@refs/heads/main', ?)", 'a'.repeat(40), 'd'.repeat(64), T0);
    expect(() => insert(raw, "INSERT INTO plan_review_attestations (id, application_id, pr_head_source_commit, desired_hash, generation, plan_fingerprint, review_fingerprint, repository, actor, workflow_ref, created_at) VALUES ('pra-2', 'app-prior', ?, ?, 3, 'fp-plan', 'fp-review', 'acme/prior', 'alice', 'acme/prior/.github/workflows/validate-plan.yml@refs/heads/main', ?)", 'a'.repeat(40), 'd'.repeat(64), T0)).toThrow();
    expect(() => insert(raw, "INSERT INTO plan_review_attestations (id, application_id, pr_head_source_commit, desired_hash, generation, plan_fingerprint, review_fingerprint, repository, actor, workflow_ref, created_at) VALUES ('pra-3', 'missing-app', ?, ?, 3, 'fp-plan', 'fp-review-2', 'acme/prior', 'alice', 'acme/prior/.github/workflows/validate-plan.yml@refs/heads/main', ?)", 'a'.repeat(40), 'd'.repeat(64), T0)).toThrow();
    expect(() => insert(raw, "INSERT INTO plan_review_attestations (id, application_id, pr_head_source_commit, desired_hash, generation, plan_fingerprint, review_fingerprint, repository, actor, workflow_ref, created_at) VALUES ('pra-4', 'app-prior', ?, ?, 0, 'fp-plan', 'fp-review-3', 'acme/prior', 'alice', 'acme/prior/.github/workflows/validate-plan.yml@refs/heads/main', ?)", 'a'.repeat(40), 'd'.repeat(64), T0)).toThrow();
  });

  it('enforces the full-chain constraints and triggers on the migrated schema', () => {
    const raw = freshDb();
    insert(raw, "INSERT INTO applications (id, display_name, source_path, desired_generation, desired_hash, sync_status, health_status, lifecycle_state, updated_at) VALUES ('app-constraints', 'C', 'catalog/apps/c', 1, 'h', 'SYNCED', 'HEALTHY', 'active', ?)", T0);

    // Partial unique index: one CURRENT production deployment per application.
    insert(raw, "INSERT INTO deployments (id, application_id, project_id, environment, repository, commit_sha, desired_generation, state, url, created_at) VALUES ('dep-a', 'app-constraints', 'prj', 'production', 'acme/c', ?, 1, 'CURRENT', NULL, ?)", 'a'.repeat(40), T0);
    expect(() => insert(raw, "INSERT INTO deployments (id, application_id, project_id, environment, repository, commit_sha, desired_generation, state, url, created_at) VALUES ('dep-b', 'app-constraints', 'prj', 'production', 'acme/c', ?, 1, 'CURRENT', NULL, ?)", 'b'.repeat(40), T0)).toThrow();

    // Audit events are immutable.
    insert(raw, "INSERT INTO audit_events (id, actor, action, application_id, details_json, created_at) VALUES ('audit-c', 'x', 'E', 'app-constraints', '{}', ?)", T0);
    expect(() => raw.prepare("UPDATE audit_events SET actor = 'evil'").run()).toThrow();
    expect(() => raw.prepare('DELETE FROM audit_events').run()).toThrow();

    // Locks are application/domain-scoped with valid expiry.
    expect(() => insert(raw, "INSERT INTO locks (resource_key, owner_id, acquired_at, expires_at) VALUES ('project:app-constraints', 'wf', ?, ?)", T0, '2026-08-04T00:01:00.000Z')).toThrow();
    expect(() => insert(raw, "INSERT INTO locks (resource_key, owner_id, acquired_at, expires_at) VALUES ('application:app-constraints', 'wf', ?, ?)", '2026-08-04T00:01:00.000Z', T0)).toThrow();

    // The idempotency ledger references real workflow runs.
    expect(() => insert(raw, "INSERT INTO idempotent_requests (idempotency_key, operation_id, payload_hash, created_at) VALUES ('ik-bad', 'missing-run', 'p', ?)", T0)).toThrow();

    // Deletion approvals are unique per application/token with a status CHECK.
    insert(raw, "INSERT INTO deletion_approvals (id, application_id, token_hash, status, expires_at, created_at) VALUES ('da-1', 'app-constraints', 'th-1', 'PENDING', ?, ?)", T0, T0);
    expect(() => insert(raw, "INSERT INTO deletion_approvals (id, application_id, token_hash, status, expires_at, created_at) VALUES ('da-2', 'app-constraints', 'th-1', 'PENDING', ?, ?)", T0, T0)).toThrow();
    expect(() => insert(raw, "INSERT INTO deletion_approvals (id, application_id, token_hash, status, expires_at, created_at) VALUES ('da-3', 'app-constraints', 'th-3', 'NOPE', ?, ?)", T0, T0)).toThrow();

    // Incidents carry typed CHECKs.
    expect(() => insert(raw, "INSERT INTO incidents (id, type, fingerprint, severity, message, details_json, first_seen_at, last_fired_at) VALUES ('inc-bad', 'NOPE', 'f', 'warning', 'x', '{}', ?, ?)", T0, T0)).toThrow();
    expect(() => insert(raw, "INSERT INTO incidents (id, type, fingerprint, severity, message, details_json, first_seen_at, last_fired_at) VALUES ('inc-bad2', 'DLQ', 'f', 'NOPE', 'x', '{}', ?, ?)", T0, T0)).toThrow();

    // Desired generations only increase from 1.
    expect(() => insert(raw, "INSERT INTO desired_generations (application_id, generation, desired_hash, updated_at) VALUES ('app-constraints', 0, 'h', ?)", T0)).toThrow();

    // One ownership row per provider resource id.
    insert(raw, "INSERT INTO resources (id, application_id, provider, resource_type, resource_key, provider_resource_id, desired_generation, observed_hash, ownership_fingerprint, status, first_seen_at, last_seen_at) VALUES ('r-1', 'app-constraints', 'vercel', 'project', 'vercel.project', 'prj-1', 1, 'oh', 'fp', 'ACTIVE', ?, ?)", T0, T0);
    expect(() => insert(raw, "INSERT INTO resources (id, application_id, provider, resource_type, resource_key, provider_resource_id, desired_generation, observed_hash, ownership_fingerprint, status, first_seen_at, last_seen_at) VALUES ('r-2', 'app-constraints', 'vercel', 'project', 'vercel.project', 'prj-1', 1, 'oh', 'fp', 'ACTIVE', ?, ?)", T0, T0)).toThrow();
  });

  it('prohibits rollback: forward-only files, no destructive statements, apply-once chain', () => {
    const files = migrationFiles();
    expect(files).toEqual(['0001_initial.sql', '0002_constraints.sql', '0003_store_contracts.sql', '0004_observability.sql', '0005_webhook_dispatch.sql', '0006_plan_review_attestations.sql']);
    for (const file of files) {
      expect(file, file).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
      const sql = readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8');
      expect(sql, `migration ${file} must not destroy forward state`).not.toMatch(/\bDROP\s+(TABLE|INDEX|TRIGGER|VIEW|COLUMN)\b/i);
      expect(sql, `migration ${file} must not contain a down script`).not.toMatch(/\bDOWN\b/i);
    }

    // The chain is apply-once: replaying it over a migrated database fails
    // loudly (0003/0004 ALTERs are not idempotent) instead of silently
    // reverting or re-applying — there is no path backwards.
    const raw = freshDb();
    seedPriorData(raw);
    expect(() => migrate(raw, files)).toThrow();
    // The failed replay changed nothing: data and 0003 columns survive.
    expect(count(raw, "SELECT COUNT(*) AS count FROM applications")).toBe(1);
    expect((raw.prepare("SELECT owners_json FROM applications WHERE id = 'app-prior'").get() as { owners_json: string }).owners_json).toBe('[]');
    expect((raw.prepare("SELECT attempt FROM health_checks WHERE id = 'hc-1'").get() as { attempt: number }).attempt).toBe(1);

    // The idempotent head (0001/0002, all IF NOT EXISTS) is replay-safe.
    const fresh = freshDb('0002_constraints.sql');
    seedPriorData(fresh);
    expect(() => migrate(fresh, ['0001_initial.sql', '0002_constraints.sql'])).not.toThrow();
    expect(count(fresh, "SELECT COUNT(*) AS count FROM applications")).toBe(1);
  });

  it('exposes the latest schema only after the full chain (no skipped migrations)', () => {
    const partial = freshDb('0002_constraints.sql');
    seedPriorData(partial);
    const tables = partial.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    const names = new Set(tables.map((row) => row.name));
    expect(names.has('desired_generations')).toBe(false);
    expect(names.has('incidents')).toBe(false);
    expect(names.has('plan_review_attestations')).toBe(false);
    expect(() => partial.prepare("SELECT url FROM health_checks").get()).toThrow();
    expect(() => partial.prepare("SELECT message FROM provider_errors").get()).toThrow();
    expect(() => insert(partial, "INSERT INTO desired_generations (application_id, generation, desired_hash, updated_at) VALUES ('app-prior', 1, 'h', ?)", T0)).toThrow();
    expect(() => insert(partial, "INSERT INTO plan_review_attestations (id, application_id, pr_head_source_commit, desired_hash, generation, plan_fingerprint, review_fingerprint, repository, actor, workflow_ref, created_at) VALUES ('pra-p', 'app-prior', ?, ?, 1, 'fp', 'fp-r', 'acme/prior', 'a', 'w', ?)", 'a'.repeat(40), 'd'.repeat(64), T0)).toThrow();

    const full = freshDb();
    seedPriorData(full);
    expect(() => insert(full, "INSERT INTO desired_generations (application_id, generation, desired_hash, updated_at) VALUES ('app-prior', 1, 'h', ?)", T0)).not.toThrow();
    expect(() => insert(full, "INSERT INTO plan_review_attestations (id, application_id, pr_head_source_commit, desired_hash, generation, plan_fingerprint, review_fingerprint, repository, actor, workflow_ref, created_at) VALUES ('pra-f', 'app-prior', ?, ?, 1, 'fp', 'fp-r', 'acme/prior', 'a', 'w', ?)", 'a'.repeat(40), 'd'.repeat(64), T0)).not.toThrow();
  });

  it('produces the exact schema copy the store relies on', () => {
    const raw = freshDb();
    const tables = new Set((raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
    for (const expected of ['applications', 'resources', 'observations', 'plans', 'plan_operations', 'workflow_runs', 'workflow_steps', 'deployments', 'deployment_promotions', 'health_checks', 'drift_events', 'reconciliation_requests', 'provider_errors', 'webhook_events', 'cleanup_jobs', 'tombstones', 'audit_events', 'credentials_metadata', 'desired_generations', 'locks', 'idempotent_requests', 'deletion_approvals', 'incidents', 'metric_snapshots', 'plan_review_attestations']) {
      expect(tables.has(expected), `table ${expected}`).toBe(true);
    }
    const indexes = new Set((raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((row) => row.name));
    for (const expected of ['one_current_production_deployment', 'plans_application_fingerprint', 'tombstones_domain', 'incidents_open_created', 'metric_snapshots_metric_captured', 'plan_review_attestations_application_review']) {
      expect(indexes.has(expected), `index ${expected}`).toBe(true);
    }
    const triggers = new Set((raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).map((row) => row.name));
    expect(triggers.has('audit_events_no_update')).toBe(true);
    expect(triggers.has('audit_events_no_delete')).toBe(true);

    const partialIndex = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'one_current_production_deployment'").get() as { sql: string };
    expect(partialIndex.sql).toContain("WHERE environment = 'production' AND state = 'CURRENT'");
    const locks = raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'locks'").get() as { sql: string };
    expect(locks.sql).toContain("resource_key LIKE 'application:%'");
    expect(locks.sql).toContain('expires_at > acquired_at');
    const resources = raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'resources'").get() as { sql: string };
    expect(resources.sql).toContain('UNIQUE(provider, provider_resource_id)');
    const approvals = raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'deletion_approvals'").get() as { sql: string };
    expect(approvals.sql).toContain('UNIQUE (application_id, token_hash)');
    const desired = raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'desired_generations'").get() as { sql: string };
    expect(desired.sql).toContain('generation >= 1');
  });
});
