# Failed rollback

Purpose: restore the previous known-good deployment, and report failure
loudly when no known-good target exists or the rollback itself fails.

## Detection

- Post-promotion health failed and the automatic rollback step failed, or
  the rollback action reported failure. The release stays `FAILED` — a
  successful rollback/cleanup never turns the original failed operation
  green (the run keeps its `error_code` and terminal `FAILED` status).
- Check the known-good record and rollback result:
  `yarn wrangler d1 execute launchpad --remote --command "SELECT deployment_id, previous_deployment_id, result, promoted_at FROM deployment_promotions WHERE application_id = '<id>' ORDER BY promoted_at DESC LIMIT 5"`
  `yarn wrangler d1 execute launchpad --remote --command "SELECT id, result, payload_json FROM health_checks WHERE application_id = '<id>' ORDER BY checked_at DESC LIMIT 5"`
- Rollbacks are counted per window and persisted:
  `yarn wrangler d1 execute launchpad --remote --command "SELECT metric, total, captured_at FROM metric_snapshots WHERE metric = 'rollback_count' ORDER BY captured_at DESC LIMIT 5"`
- The failure is visible as a provider-error row and an incident
  (`type = 'CONTROLLER_ERROR_RATE'` for apply failures; GitHub commit
  status `launchpad/apply` shows `failure` when context exists):
  `yarn wrangler d1 execute launchpad --remote --command "SELECT id, code, class, retryable, remediation, created_at FROM provider_errors WHERE application_id = '<id>' ORDER BY created_at DESC LIMIT 10"`

## Containment

- Mark the release `FAILED` and the rollback result `FAILED`; do not report
  success.
- Freeze further promotions: disable the `launchpad-production` environment
  protection rule or the apply workflow. Keep production configuration
  changes in Git.

## Recovery

- Verify the previous known-good deployment still exists and belongs to the
  same project and environment (a known-good is recorded only after
  post-promotion health succeeded):
  `curl -sS "https://api.vercel.com/v6/deployments/<deployment-id>" -H "Authorization: Bearer $LAUNCHPAD_VERCEL_TOKEN"`
- Trigger the rollback action through the controller:
  `curl -sS -X POST "$LAUNCHPAD_CONTROLLER_URL/v1/applications/<id>/actions/rollback" -H "Authorization: Bearer $LAUNCHPAD_OPERATOR_TOKEN" -H "Idempotency-Key: rollback:<id>:<failed-deployment-id>"`
- If a second known-good deployment exists, require explicit operator
  approval before targeting it; never guess.
- If no known-good deployment exists, do not invent a target: block and
  escalate.

## Validation

- Health check against the current production domain passes, with DNS/TLS/
  status/body evidence captured:
  `yarn platform health --catalog catalog --environment production`
- The production alias points at the restored deployment (Vercel API or
  `dig` for the production hostname).
- After recovery, record the restored deployment and re-run reconciliation
  from protected `main`:
  `yarn platform reconcile --catalog catalog --dry-run`
- The original workflow run is still `FAILED` with its `error_code`
  (`SELECT id, status, error_code FROM workflow_runs WHERE application_id = '<id>' ORDER BY started_at DESC LIMIT 5`).

## Escalation

- Open an incident with the failed deployment, the rollback evidence, and
  health snapshots; keep the release red and promotions frozen until the
  incident is resolved (`incidents` row, resolved via
  `POST /v1/incidents/<id>/resolve`).
