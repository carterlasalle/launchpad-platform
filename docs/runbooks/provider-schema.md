# Provider schema incompatibility

Purpose: stop an adapter operation when a provider response is missing
required fields, reproduce it with a fixture, and fix only the adapter —
never the core domain.

## Detection

- An operation fails with a provider response class of `malformed` or a
  fail-closed error (missing required field), or a provider contract test
  fails.
- Provider errors are recorded with safe details (never raw bodies or
  secrets):
  `yarn wrangler d1 execute launchpad --remote --command "SELECT id, provider, code, class, safe_details_json, created_at FROM provider_errors ORDER BY created_at DESC LIMIT 20"`
- Preserve the redacted response shape, endpoint, provider version, and
  correlation ID in the incident.

## Containment

- Stop the affected adapter operation; do not degrade to permissive parsing.
- Keep core domain types provider-neutral; a provider change must not leak
  into `packages/core`.

## Recovery

1. Add a fixture reproducing the response and a failing provider contract
   test under the adapter package (`packages/provider-*`), asserting the
   fail-closed behavior on the malformed field.
2. Update only the provider adapter and its capability snapshot.
3. Run the provider contract, plan snapshot, and failure-path tests
   (`yarn test`), then `yarn typecheck`.
4. Deploy behind a reviewed controller release
   (`deploy-control-plane.yml`, gated on the static foundation checks) and
   re-run a disposable fixture operation:
   `yarn platform preflight --catalog catalog`
   `yarn platform reconcile --catalog catalog --dry-run`

## Validation

- The new fixture test passes and the old failure mode is now a typed,
   loud error with a safe detail record.
- `yarn platform preflight --catalog catalog` passes against live providers.

## Escalation

- If the malformed response affects production reads, follow the relevant
  provider outage runbook and open an incident with the fixture, endpoint,
  and provider version; do not merge adapter changes without the fixture.
