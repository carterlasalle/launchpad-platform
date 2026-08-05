# D1 migration failure

Purpose: recover a failed D1 migration without editing an applied migration
and without deploying a Worker whose code is incompatible with the schema.

## Detection

- The deploy workflow (`deploy-control-plane.yml`) fails at `yarn wrangler
  deploy --env production` with a D1 migration error, or a dashboard/API read
  fails with a schema error.
- Export the migration name and error from the deployment log.
- Confirm which migrations are applied:
  `yarn wrangler d1 migrations list launchpad --env production`

## Containment

- Stop controller deployment promotion; existing Worker versions remain the
  rollback target. Do not edit an applied migration file.
- If a schema error is visible in production reads, the running Worker may be
  incompatible with the new schema — do not promote more code until verified.

## Recovery

1. Reproduce the migration against a disposable database:
   `yarn wrangler d1 migrations apply launchpad --local`
   (for the remote state: `yarn wrangler d1 execute launchpad --remote --command "SELECT name FROM d1_migrations"`)
2. Add a forward-only corrective migration under `migrations/d1/` (a new
   numbered file; never alter an applied one), run schema and repository
   tests, and verify indexes and uniqueness constraints.
3. Apply to staging D1 and run dashboard/API smoke checks:
   `yarn wrangler d1 migrations apply launchpad --remote --env staging` (or
   the configured staging environment), then
   `yarn platform controller-smoke --controller "$LAUNCHPAD_CONTROLLER_URL"`
4. Apply to production under the release environment, then re-run smoke
   checks.
5. If schema and code versions are incompatible, roll back the Worker to the
   previous version (`yarn wrangler rollback <version-id> --env production`)
   and keep the database migration forward-only.

## Validation

- `yarn wrangler d1 migrations list launchpad --env production` shows a
  linear, forward-only history with no edits.
- Controller reads succeed:
  `curl -sS "$LAUNCHPAD_CONTROLLER_URL/v1/applications" -H "Authorization: Bearer $LAUNCHPAD_OPERATOR_TOKEN"`
- The dashboard renders and the deployed version matches the release
  artifact (SBOM/attestation from the deploy run).

## Escalation

- If the migration cannot be made forward-only or production reads stay
  broken, freeze deploys, restore the previous Worker version, and open an
  incident with the migration name, error, and reproduction steps.
