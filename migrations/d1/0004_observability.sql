-- Launchpad 1.0 failure observability contracts (section 27 of the master plan).
-- Forward-only. Safe to apply after 0003_store_contracts.sql.
-- Adds: durable incident rows (dedupe by type+fingerprint), bounded metric
-- snapshots, and provider-error remediation guidance.

-- Incidents are the durable alert/visibility record. One row per
-- (type, fingerprint): refiring the same condition updates the row in place
-- (reopening it) instead of growing unbounded rows. Delivery failures are
-- recorded in delivery_json so a broken sink stays visible.
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('DLQ','RECONCILIATION_FAILURE','CREDENTIAL_EXPIRY','CONTROLLER_ERROR_RATE')),
  fingerprint TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warning','critical')),
  application_id TEXT,
  operation_id TEXT,
  message TEXT NOT NULL,
  details_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_fired_at TEXT NOT NULL,
  resolved_at TEXT,
  delivery_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (type, fingerprint)
);

CREATE INDEX IF NOT EXISTS incidents_open_created ON incidents(resolved_at, last_fired_at DESC);
CREATE INDEX IF NOT EXISTS incidents_application ON incidents(application_id);

-- Bounded metric snapshots: one row per metric per capture window. Labels
-- are a fixed bounded set (provider, workflow); never per-request series.
CREATE TABLE IF NOT EXISTS metric_snapshots (
  id TEXT PRIMARY KEY,
  metric TEXT NOT NULL,
  total INTEGER NOT NULL,
  rate REAL,
  window_seconds INTEGER NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '{}',
  captured_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS metric_snapshots_metric_captured ON metric_snapshots(metric, captured_at DESC);

-- Provider errors carry remediation guidance alongside the stable
-- class/code/retryable classification.
ALTER TABLE provider_errors ADD COLUMN remediation TEXT NOT NULL DEFAULT '';
