# Cloudflare API outage

Purpose: keep DNS and proxying stable during a Cloudflare API outage; never
rewrite records as a workaround.

## Detection

- A preflight or apply DNS step fails with a Cloudflare error class, or
  authoritative verification reports unknown state.
- `yarn platform preflight --catalog catalog` fails on the Cloudflare zone
  check while other providers pass.
- Provider errors are visible in D1:
  `yarn wrangler d1 execute launchpad --remote --command "SELECT id, code, class, safe_details_json FROM provider_errors ORDER BY created_at DESC LIMIT 20"`
- Confirm whether the outage affects DNS reads, DNS writes, or authoritative
  resolution only; DNS-only records already in place keep serving.

## Containment

- Keep production aliases unchanged and block new domain mutations
  (disable `launchpad-production` environment protection or the apply
  workflow).
- Do not delete or recreate records to work around a provider timeout.
- Treat zone state as `UNKNOWN`/`BLOCKED`; never report `SYNCED` from cached
  data.

## Recovery

- Inspect the latest durable step and retry only the failed provider
  operation after the API recovers, with its original idempotency key:
  `curl -sS -X POST "$LAUNCHPAD_CONTROLLER_URL/v1/applications/<id>/actions/retry" -H "Authorization: Bearer $LAUNCHPAD_OPERATOR_TOKEN" -H "Idempotency-Key: <original-key>"`
- Re-run read-only validation before any write:
  `yarn platform preflight --catalog catalog`
  `yarn platform reconcile --catalog catalog --dry-run --sha "$(git rev-parse HEAD)"`
- Resume applies only through merged PRs on protected `main`.

## Validation

- Authoritative DNS matches the desired record at the zone nameservers, e.g.
  `dig +short <hostname> CNAME @<zone-nameserver>` (or `dig +trace <hostname>`).
- Vercel domain verification and TLS are ready for the domain, and
  `yarn platform health --catalog catalog --app <application-id> --environment production --sha <merged-commit-sha> --url 'https://<production-hostname>'` passes
  (run it separately against the origin and, where proxy mode is configured,
  the public route).
- The operation recorded terminal state and the audit trail shows the
  recovery.

## Escalation

- If the outage blocks a promotion that already changed aliases, follow the
  rollback runbook.
- Open an incident issue with the provider response class, correlation ID,
  and the affected zone/record.
