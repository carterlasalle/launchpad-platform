# Vercel API outage

Purpose: keep production deployments and domains untouched during a Vercel API
outage, and resume only through the normal review/apply path.

## Detection

- A preflight, preview, apply, or reconcile step fails with a Vercel error
  class (`rate limited`, `transient`, `forbidden`, `unavailable`) and the
  request correlation ID is visible in the workflow/step error.
- `yarn platform preflight --catalog catalog` fails against Vercel while
  GitHub/Cloudflare checks pass.
- Provider errors are recorded with `class` and `retryable` flags in D1:
  `yarn wrangler d1 execute launchpad --remote --command "SELECT id, code, class, retryable FROM provider_errors ORDER BY created_at DESC LIMIT 20"`
- Confirm Vercel dashboard availability independently of the API; an API
  outage can leave the dashboard (or not) affected.

## Containment

- Pause new promotions: disable the `launchpad-production` GitHub environment
  protection rule or the `Launchpad Apply` workflow. Do not mutate existing
  production domains or aliases.
- Leave in-progress durable operations visible; controller workflows retry
  bounded transient responses (`max_retries: 5`) and stop after the limit.
  Do not delete or recreate deployments to work around a timeout.

## Recovery

- After the API recovers, retry only the failed provider operation with its
  original idempotency key:
  `curl -sS -X POST "$LAUNCHPAD_CONTROLLER_URL/v1/applications/<id>/actions/retry" -H "Authorization: Bearer $LAUNCHPAD_OPERATOR_TOKEN" -H "Idempotency-Key: <original-key>"`
- Re-run the read-only path first:
  `yarn platform preflight --catalog catalog`
  `yarn platform plan --catalog catalog --format json`
  Verify the plan fingerprint is current for the merged SHA
  (`yarn platform apply --catalog catalog --sha <sha> --controller "$LAUNCHPAD_CONTROLLER_URL"` revalidates before writing).
- If a catalog change is mid-flight, push a corrected revision through a PR;
  do not apply a stale plan.

## Validation

- `yarn platform health --catalog catalog --environment production` passes
  against the production domain (HTTP status per the configured spec).
- Vercel domain verification and TLS are green for the intended domain:
  `curl -sS "https://api.vercel.com/v9/projects/<project>/domains" -H "Authorization: Bearer $LAUNCHPAD_VERCEL_TOKEN"`
- The apply/reconcile operation recorded a terminal result and the audit
  trail shows the recovery
  (`curl -sS "$LAUNCHPAD_CONTROLLER_URL/v1/applications/<id>/audit" -H "Authorization: Bearer $LAUNCHPAD_OPERATOR_TOKEN"`).

## Escalation

- If retry exhaustion lands events on the dead-letter queue, follow the
  dead-letter runbook and open an incident issue with the provider response
  class, retry count, correlation ID, and any failed candidate deployment.
