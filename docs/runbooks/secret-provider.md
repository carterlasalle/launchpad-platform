# Secret-provider outage

Purpose: keep running deployments serving, gate new deployments and
promotions, and never substitute an empty or stale secret value.

## Detection

- Operations fail with a secret-reference error (`invalid secret reference`,
  provider unreachable), or fingerprint comparisons fail.
- Confirm the provider reference and environment without logging the
  resolved value; values are wrapped in `SensitiveValue` and logs carry
  fingerprints or `[REDACTED]` only.
- Secret reference state is checked through the catalog validation and
  preflight paths:
  `yarn platform validate --catalog catalog`
  `yarn platform preflight --catalog catalog`

## Containment

- Mark affected operations `BLOCKED` or `UNKNOWN`; never substitute an empty
  or stale value.
- Keep existing deployments running; new deployments and promotions remain
  gated (disable the `launchpad-production` environment protection rule
  while the outage lasts).

## Recovery

1. Restore provider access (see the credentials runbook for rotation if the
   cause is a credential).
2. Run a read-only reference existence check and fingerprint comparison:
   `yarn platform preflight --catalog catalog`
   `yarn platform reconcile --catalog catalog --dry-run --sha "$(git rev-parse HEAD)"`
3. Stage a new candidate: Vercel environment values are deployment-scoped,
   so a fixed secret requires a fresh staged build, not re-promoting the
   old candidate.
4. Run candidate and production health checks before promotion:
   - Candidate: `yarn platform health --catalog catalog --app <application-id> --environment staging --sha <merged-commit-sha> --url 'https://<candidate-hostname>'`.
   - Production: `yarn platform health --catalog catalog --app <application-id> --environment production --sha <merged-commit-sha> --url 'https://<production-hostname>'`.
5. Scan all release artifacts for the canary secret before declaring
   success (automated leak checks in the release gates).

## Validation

- Fingerprints match the expected values without revealing them; no secret
  value appears in logs, comments, artifacts, or D1 rows.
- The staged candidate passes health and is promoted through the normal
  apply path.

## Escalation

- If the provider stays down beyond the gating window, open an incident and
  keep promotions frozen; never fall back to plaintext storage in Git, logs,
  comments, or D1.
