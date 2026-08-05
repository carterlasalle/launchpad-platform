# Stuck application or domain lock

Purpose: release a lock only when its owner is provably dead, never while the
owning workflow is still running.

## Detection

- An apply, promote, or decommission operation stays `QUEUED`/`RUNNING`
  without progress:
  `curl -sS "$LAUNCHPAD_CONTROLLER_URL/v1/applications/<id>/operations" -H "Authorization: Bearer $LAUNCHPAD_OPERATOR_TOKEN"`
- Inspect the owning workflow run and its lease:
  `yarn wrangler d1 execute launchpad --remote --command "SELECT id, workflow_type, status, idempotency_key, started_at, error_code FROM workflow_runs WHERE application_id = '<id>' ORDER BY started_at DESC LIMIT 10"`
- Lock state is lease-based and lives with the owning workflow; there is no
  force-release endpoint, by design.

## Containment

- Confirm the owning workflow is not still running before touching anything
  (Cloudflare dashboard → Workflows → the owning instance, or
  `workflow_runs` status). Never overwrite an active lock.

## Recovery

- If the owner is dead and the lease expired: the lock is released by the
  lease/controller lifecycle; wait for expiry or, when the owner cannot
  resume, restart the controller Worker (in-memory lock state is cleared on
  restart) — only after confirming the owning workflow is not executing.
- If the lease has not expired: wait for it, or terminate the owning workflow
  instance in the Cloudflare dashboard first; never bypass an active lease.
- Re-run the failed step with the same idempotency key:
  `curl -sS -X POST "$LAUNCHPAD_CONTROLLER_URL/v1/applications/<id>/actions/retry" -H "Authorization: Bearer $LAUNCHPAD_OPERATOR_TOKEN" -H "Idempotency-Key: <original-key>"`

## Validation

- The operation reaches a terminal result; provider postconditions are
  re-observed and verified before success is declared.
- The audit trail records the operator, evidence, and recovery outcome:
  `curl -sS "$LAUNCHPAD_CONTROLLER_URL/v1/applications/<id>/audit" -H "Authorization: Bearer $LAUNCHPAD_OPERATOR_TOKEN"`

## Escalation

- If the owning workflow is alive but wedged, or a lock cannot be released
  after lease expiry, open an incident with the workflow ID, lease evidence,
  and the recovery attempt; do not force multiple controllers to race the
  same resource.
