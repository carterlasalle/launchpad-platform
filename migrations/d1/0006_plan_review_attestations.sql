-- Launchpad reviewed-plan attestations (plan-approval gate).
-- Forward-only. Safe to apply after 0005_webhook_dispatch.sql.
--
-- Persists automated reviewed-plan attestations captured at the exact PR
-- head: application, PR/head source commit, desired-state hash and
-- generation, exact plan fingerprint, source-commit-neutral review
-- fingerprint, actor/repository/workflow identity, and timestamp.
--
-- The review fingerprint is stable across a squash merge (it covers the
-- plan's canonical semantics, never the source commit), so a merged apply
-- can require the attestation for the exact desired hash/generation without
-- depending on the merge commit SHA. Only hashes and fingerprints are ever
-- stored here — never raw environment/secret values or plan payloads.

CREATE TABLE IF NOT EXISTS plan_review_attestations (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  -- Exact PR head commit the reviewed plan was computed at.
  pr_head_source_commit TEXT NOT NULL,
  -- Desired-state binding: hash of the redacted desired manifest plus the
  -- desired generation the reviewed plan targets.
  desired_hash TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  -- Exact plan fingerprint at the PR head (includes the PR head source
  -- commit), plus the source-commit-neutral review fingerprint.
  plan_fingerprint TEXT NOT NULL,
  review_fingerprint TEXT NOT NULL,
  -- Automated reviewer identity: OIDC claim-bound repository, actor, and
  -- workflow ref.
  repository TEXT NOT NULL,
  actor TEXT NOT NULL,
  workflow_ref TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Idempotency: at most one attestation per (application, review fingerprint).
-- Replaying the same reviewed plan returns the stored row; a replay that
-- disagrees with the stored desired-state binding fails closed.
CREATE UNIQUE INDEX IF NOT EXISTS plan_review_attestations_application_review
  ON plan_review_attestations(application_id, review_fingerprint);

CREATE INDEX IF NOT EXISTS plan_review_attestations_application_created
  ON plan_review_attestations(application_id, created_at DESC);
