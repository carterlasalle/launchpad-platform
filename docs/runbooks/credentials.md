# Credential expiration, revocation, and rotation

Purpose: rotate a provider credential for one purpose without leaking the
secret and without giving any single token more scope than its purpose.

## Detection

- Preflight or reconcile fails with `401`/`403` for a specific provider, or
  the provider error class is `forbidden`/`authentication failure`:
  `yarn platform preflight --catalog catalog`
- Credential metadata shows an expiring or failed entry:
  `yarn wrangler d1 execute launchpad --remote --command "SELECT provider, purpose, expires_at, status FROM credentials_metadata ORDER BY last_checked_at DESC"`
- The scheduled controller run checks credential metadata every 30 minutes
  (metadata only — secret values are never read), marks entries
  `EXPIRING_SOON` (within `LAUNCHPAD_ALERT_CREDENTIAL_EXPIRY_WINDOW_DAYS`,
  default 14 days) or `EXPIRED`, and fires deduped `CREDENTIAL_EXPIRY`
  incidents:
  `yarn wrangler d1 execute launchpad --remote --command "SELECT id, type, severity, message, last_fired_at FROM incidents WHERE type = 'CREDENTIAL_EXPIRY' ORDER BY last_fired_at DESC LIMIT 10"`
- Operator dashboard surface:
  `curl -sS "$LAUNCHPAD_CONTROLLER_URL/v1/credentials" -H "Authorization: Bearer $LAUNCHPAD_OPERATOR_TOKEN"`
- Never copy a secret value into an issue, chat, log, or D1 query.

## Containment

- Identify provider and purpose from the failing environment variable
  (purpose-separated tokens: `LAUNCHPAD_GITHUB_TOKEN`, `LAUNCHPAD_VERCEL_TOKEN`,
  `LAUNCHPAD_CLOUDFLARE_TOKEN`, `LAUNCHPAD_RULESET_TOKEN`, `LAUNCHPAD_OPERATOR_TOKEN`,
  `CLOUDFLARE_API_TOKEN`, `VERCEL_WEBHOOK_SECRET`).
- Keep the old token active until the replacement is verified; a single
  provider outage is contained to its purpose.

## Recovery

1. Create a replacement token with the minimum required scope for the
   purpose (fine-grained GitHub token with only the selected repositories;
   Vercel token scoped to the required projects/team; Cloudflare token
   scoped to the required zones and DNS edit permissions).
2. Update every consumer of that credential before revoking the old value:
   - GitHub, Vercel, and Cloudflare provider tokens are used by both PR/apply
     workflows and the Worker, so update the matching protected GitHub secret
     **and** the named Worker Secrets Store entry.
   - Operator, controller-internal, and webhook credentials that are consumed
     only by the Worker need only their named Secrets Store entry updated.
   Update a Secrets Store entry interactively (omit `--value`):
   `yarn wrangler secrets-store secret update '<STORE_ID>' --secret-id '<SECRET_ID>' --scopes workers --remote`
   Use `yarn wrangler secrets-store secret list '<STORE_ID>' --remote` to
   locate metadata; see the [deployment guide](../guides/deployment.md).
   The Worker resolves bindings on every event, so a stored value takes effect
   after provider propagation without a Worker redeploy.
3. Run read-only checks against a disposable fixture, then the catalog:
   `yarn platform preflight --catalog catalog`
   `yarn platform reconcile --catalog catalog --dry-run --sha "$(git rev-parse HEAD)"`
4. Revoke the old token only after the replacement read and write checks
   succeed.
5. Record owner, purpose, expiration metadata, rotation time, and
   verification results in the audit trail.

## Validation

- `yarn platform preflight --catalog catalog` passes with the replacement.
- A controller smoke check passes: `yarn platform controller-smoke --controller "$LAUNCHPAD_CONTROLLER_URL"`.
- D1 `credentials_metadata` reflects the new expiration and status; the
  `CREDENTIAL_EXPIRY` incident row is resolved via
  `POST /v1/incidents/<id>/resolve` (operator token) after rotation
  verification.

## Escalation

- If rotation cannot be verified within the expiration window, block new
  applies/promotions (disable the production environment protection rule),
  open an incident, and surface the expiration in the operations dashboard.
- `CREDENTIAL_EXPIRY` alerting respects `LAUNCHPAD_ALERT_COOLDOWN_SECONDS`
  (default 3600) so repeated scheduled checks do not page every cycle.
