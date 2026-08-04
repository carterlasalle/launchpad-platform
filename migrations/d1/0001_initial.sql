PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  source_path TEXT NOT NULL,
  desired_generation INTEGER NOT NULL,
  desired_hash TEXT NOT NULL,
  sync_status TEXT NOT NULL CHECK (sync_status IN ('SYNCED','OUT_OF_SYNC','RECONCILING','BLOCKED','UNKNOWN','DECOMMISSIONING')),
  health_status TEXT NOT NULL CHECK (health_status IN ('HEALTHY','DEGRADED','UNHEALTHY','CHECKING','UNKNOWN')),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active','decommissioning','approved-for-deletion','deleted')),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  provider TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  provider_resource_id TEXT NOT NULL,
  desired_generation INTEGER NOT NULL,
  observed_hash TEXT NOT NULL,
  ownership_fingerprint TEXT,
  status TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(provider, provider_resource_id)
);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  observed_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  observed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  fingerprint TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  result TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_operations (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  resource_key TEXT NOT NULL,
  action TEXT NOT NULL,
  destructive INTEGER NOT NULL CHECK (destructive IN (0,1)),
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  workflow_type TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_code TEXT
);

CREATE TABLE IF NOT EXISTS workflow_steps (
  workflow_id TEXT NOT NULL REFERENCES workflow_runs(id),
  step_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  precondition_hash TEXT NOT NULL,
  result_json TEXT,
  error_json TEXT,
  PRIMARY KEY (workflow_id, step_id)
);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  project_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  repository TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  desired_generation INTEGER NOT NULL,
  state TEXT NOT NULL,
  url TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deployment_promotions (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  deployment_id TEXT NOT NULL REFERENCES deployments(id),
  previous_deployment_id TEXT,
  result TEXT NOT NULL,
  promoted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS health_checks (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  environment TEXT NOT NULL,
  deployment_id TEXT,
  result TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  checked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drift_events (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  fingerprint TEXT NOT NULL,
  category TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS reconciliation_requests (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  fingerprint TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('restore-desired-state','adopt-observed-state')),
  pull_request_number INTEGER,
  pull_request_url TEXT,
  status TEXT NOT NULL,
  UNIQUE(application_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS provider_errors (
  id TEXT PRIMARY KEY,
  application_id TEXT,
  operation_id TEXT,
  provider TEXT,
  code TEXT NOT NULL,
  class TEXT NOT NULL,
  retryable INTEGER NOT NULL CHECK (retryable IN (0,1)),
  safe_details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY(provider, event_id)
);

CREATE TABLE IF NOT EXISTS cleanup_jobs (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  provider_resource_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS tombstones (
  application_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  retain_until TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  application_id TEXT,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials_metadata (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  purpose TEXT NOT NULL,
  expires_at TEXT,
  last_checked_at TEXT NOT NULL,
  status TEXT NOT NULL
);
