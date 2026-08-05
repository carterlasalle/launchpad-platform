# Dead-letter queue processing

Purpose: process messages that exhausted their retries without repeating a
destructive action and without losing the failure.

## Detection

- Queues `launchpad-provider-events` and `launchpad-health-checks` retry up
  to `max_retries: 5` before routing to `launchpad-dead-letter`
  (`wrangler.jsonc`); the DLQ has `max_retries: 0`.
- List DLQ messages:
  `yarn wrangler queues message list launchpad-dead-letter --env production`
- Correlate with the operation that exhausted retries:
  `yarn wrangler d1 execute launchpad --remote --command "SELECT id, application_id, workflow_type, status, error_code FROM workflow_runs WHERE status = 'FAILED' ORDER BY started_at DESC LIMIT 20"`
- Every dead-lettered message creates an incident row BEFORE the message is
  acknowledged (`incidents` with `type = 'DLQ'`, one row per
  queue:messageId, reopened on refire):
  `yarn wrangler d1 execute launchpad --remote --command "SELECT id, type, severity, application_id, message, first_seen_at, last_fired_at, resolved_at FROM incidents WHERE type = 'DLQ' ORDER BY last_fired_at DESC LIMIT 20"`
- DLQ alerting is configured with `LAUNCHPAD_ALERT_COOLDOWN_SECONDS`
  (default 3600) and `LAUNCHPAD_ALERTS_ENABLED`; delivery failures for the
  GitHub comment/status sinks are recorded in `incidents.delivery_json` and
  are visible, never silent.

## Containment

- Classify each message as transient, permanent, or malformed input before
  replaying it. Never replay a message whose operation would repeat a
  destructive action.

## Recovery

- Fix the source condition or code path first; do not replay messages as a
  substitute for the fix.
- Re-drive the failed operation through the controller with its original
  idempotency key so the durable workflow resumes at step boundaries:
  `curl -sS -X POST "$LAUNCHPAD_CONTROLLER_URL/v1/applications/<id>/actions/retry" -H "Authorization: Bearer $LAUNCHPAD_OPERATOR_TOKEN" -H "Idempotency-Key: <original-key>"`
- Acknowledge/clear DLQ messages only after the durable workflow records a
  terminal result; leave the incident row open until the root cause is
  fixed, then resolve it from the dashboard
  (`POST /v1/incidents/<id>/resolve` with the operator token).

## Validation

- The workflow run reaches `COMPLETED` (or a deliberate terminal failure
  with `error_code`), and the DLQ count decreases:
  `yarn wrangler queues message list launchpad-dead-letter --env production`
- The `incidents` row for the message exists with `type = 'DLQ'`, the DLQ
  count metric was persisted
  (`SELECT metric, total, captured_at FROM metric_snapshots WHERE metric = 'dlq_count' ORDER BY captured_at DESC LIMIT 5`),
  and the audit trail shows `DLQ_INCIDENT` and the replay.

## Escalation

- Open an incident issue after retry exhaustion, per the release checklist
  ("Retry exhaustion reaches the DLQ and creates visible failure state").
  Do not silently acknowledge: the controller refuses to acknowledge a
  failed message when incident persistence is unavailable.
