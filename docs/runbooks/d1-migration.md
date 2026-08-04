# D1 migration failure

1. Stop controller deployment promotion; existing Worker versions remain the rollback target.
2. Export the migration name and D1 error from the deployment log. Do not edit an applied migration.
3. Reproduce the migration against a disposable D1 database with `wrangler d1 migrations apply launchpad --local`.
4. Add a forward-only corrective migration, run schema and repository tests, and verify indexes and uniqueness constraints.
5. Apply to staging D1, run dashboard/API smoke checks, then apply to production under the release environment.
6. Restore the previous Worker version if the schema and code versions are incompatible; keep the database migration forward-only.
