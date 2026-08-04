CREATE INDEX IF NOT EXISTS resources_application_status ON resources(application_id, status);
CREATE INDEX IF NOT EXISTS workflow_runs_application_status ON workflow_runs(application_id, status);
CREATE INDEX IF NOT EXISTS deployments_application_environment_state ON deployments(application_id, environment, state);
CREATE INDEX IF NOT EXISTS drift_events_application_fingerprint ON drift_events(application_id, fingerprint, resolved_at);
CREATE INDEX IF NOT EXISTS audit_events_application_created ON audit_events(application_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS one_current_production_deployment
  ON deployments(application_id, environment)
  WHERE environment = 'production' AND state = 'CURRENT';
