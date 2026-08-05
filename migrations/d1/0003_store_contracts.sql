-- Launchpad 1.0 persistence contracts (section 23 of the master plan).
-- Forward-only. Safe to apply after 0001_initial.sql and 0002_constraints.sql.
-- Adds: desired-generation ledger, expiring application/domain locks, request
-- idempotency ledger, single-use deletion approvals, idempotent plan saves,
-- reconciliation timestamps, full health-check columns, provider-error
-- columns, owners for truthful dashboard queries, credential fingerprints,
-- immutable audit enforcement, and query indexes.

-- Desired generations: one row per application; generation only ever increases.
CREATE TABLE IF NOT EXISTS desired_generations (
  application_id TEXT PRIMARY KEY REFERENCES applications(id),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  desired_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Application and domain locks with expiry. One row per resource key, so at
-- most one active lock per application and per hostname at any time.
CREATE TABLE IF NOT EXISTS locks (
  resource_key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK (resource_key LIKE 'application:%' OR resource_key LIKE 'domain:%'),
  CHECK (expires_at > acquired_at)
);

-- General request idempotency ledger: an idempotency key maps to exactly one
-- operation and payload hash.
CREATE TABLE IF NOT EXISTS idempotent_requests (
  idempotency_key TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES workflow_runs(id),
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Single-use deletion approvals. Only keyed fingerprints are stored; the raw
-- approval token is never persisted.
CREATE TABLE IF NOT EXISTS deletion_approvals (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  token_hash TEXT NOT NULL,
  requested_by TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','USED','EXPIRED','REVOKED')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  UNIQUE (application_id, token_hash)
);

-- Plans are idempotent per (application, fingerprint): replaying the same
-- plan returns the stored row instead of duplicating it.
CREATE UNIQUE INDEX IF NOT EXISTS plans_application_fingerprint ON plans(application_id, fingerprint);

-- Reconciliation ledger timestamps (reopen-in-place semantics: at most one
-- row per (application, fingerprint), enforced by the 0001 UNIQUE constraint;
-- resolving updates the row and recurring drift reopens it).
ALTER TABLE reconciliation_requests ADD COLUMN opened_at TEXT;
ALTER TABLE reconciliation_requests ADD COLUMN resolved_at TEXT;

-- Full health-check record columns so dashboard history queries are truthful
-- without JSON parsing in SQL. Existing rows default to conservative values.
ALTER TABLE health_checks ADD COLUMN url TEXT;
ALTER TABLE health_checks ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE health_checks ADD COLUMN dns_resolved INTEGER NOT NULL DEFAULT 0 CHECK (dns_resolved IN (0,1));
ALTER TABLE health_checks ADD COLUMN tls_valid INTEGER NOT NULL DEFAULT 0 CHECK (tls_valid IN (0,1));
ALTER TABLE health_checks ADD COLUMN status_code INTEGER;
ALTER TABLE health_checks ADD COLUMN latency_ms INTEGER;
ALTER TABLE health_checks ADD COLUMN assertion_results_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE health_checks ADD COLUMN error_code TEXT;

-- Provider error ledger carries the safe message and cause fingerprint.
ALTER TABLE provider_errors ADD COLUMN message TEXT NOT NULL DEFAULT '';
ALTER TABLE provider_errors ADD COLUMN cause_fingerprint TEXT NOT NULL DEFAULT '';

-- Application owners (users/teams) for truthful dashboard ownership columns.
ALTER TABLE applications ADD COLUMN owners_json TEXT NOT NULL DEFAULT '[]';

-- Credential metadata may carry a keyed fingerprint of the underlying
-- credential so rotation is detectable; secret values are prohibited here.
ALTER TABLE credentials_metadata ADD COLUMN value_fingerprint TEXT;

-- Tombstone domain lookups back reuse blocking at application registration.
CREATE INDEX IF NOT EXISTS tombstones_domain ON tombstones(domain);

-- Query indexes for dashboard and listing paths.
CREATE INDEX IF NOT EXISTS deployments_application_created ON deployments(application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS observations_application_observed ON observations(application_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS plans_application_created ON plans(application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS health_checks_application_checked ON health_checks(application_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS cleanup_jobs_application_status ON cleanup_jobs(application_id, status);
CREATE INDEX IF NOT EXISTS deletion_approvals_application_status ON deletion_approvals(application_id, status);
CREATE INDEX IF NOT EXISTS webhook_events_received ON webhook_events(received_at);

-- Audit events are immutable after insertion: no updates, no deletes.
CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events are immutable');
END;
CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events are immutable');
END;

-- One known-good current production deployment per (application, environment).
-- Declared defensively; 0002 introduced the same partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS one_current_production_deployment
  ON deployments(application_id, environment)
  WHERE environment = 'production' AND state = 'CURRENT';
