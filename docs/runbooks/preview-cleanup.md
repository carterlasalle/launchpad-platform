# Preview cleanup backlog

Purpose: remove expired shadow preview projects without touching production,
and keep cleanup failures visible instead of silently accumulating.

## Detection

- Shadow preview projects are named `lp-pr-<pr>-<app>-<revision>` (≤63
  chars) and carry ownership settings (`launchpadShadow: true`,
  `launchpadPullRequest`, `launchpadRevision`, `launchpadExpiresAt`, set to
  24 h after creation).
- List cleanup backlog state:
  `yarn wrangler d1 execute launchpad --remote --command "SELECT id, application_id, provider_resource_id, expires_at, status, attempts, last_error FROM cleanup_jobs WHERE status = 'CLEANUP_PENDING' ORDER BY expires_at"`
- Backlog size and failures are persisted per scheduled window as
  `preview_cleanup_backlog` (gauge) and `preview_cleanup_failures`
  (counter):
  `yarn wrangler d1 execute launchpad --remote --command "SELECT metric, total, captured_at FROM metric_snapshots WHERE metric IN ('preview_cleanup_backlog','preview_cleanup_failures') ORDER BY captured_at DESC LIMIT 10"`
- List owned shadow projects in Vercel:
  `curl -sS "https://api.vercel.com/v9/projects?search=lp-pr-" -H "Authorization: Bearer $LAUNCHPAD_VERCEL_TOKEN"`

## Containment

- Confirm ownership metadata matches the Launchpad application, pull
  request, and revision before deleting anything; unowned resources are
  blocked and escalated, never force-deleted.

## Recovery

- Delete only owned, expired shadow projects. The cleanup sweep lives in the
  preview workflow (`cleanupShadowProject`/`cleanupExpiredShadowProjects`);
  a new PR revision supersedes and cleans up the prior revision's project.
- For a backlog left by repeated failures, re-run the sweep after the
  provider recovers; retry transient provider errors with bounded backoff and
  keep permanent failures visible:
  `curl -sS -X DELETE "https://api.vercel.com/v9/projects/<project-id>" -H "Authorization: Bearer $LAUNCHPAD_VERCEL_TOKEN"`
  (manual deletion is a last resort after ownership is confirmed; record it
  in the audit trail.)
- If the delete returns a permanent error, leave the job `CLEANUP_PENDING`
  with `last_error` populated; do not mark it cleaned.

## Validation

- The shadow project returns 404 on a follow-up GET, and the cleanup backlog
  decreases:
  `yarn wrangler d1 execute launchpad --remote --command "SELECT status, COUNT(*) FROM cleanup_jobs GROUP BY status"`
- Production projects/domains are untouched; `yarn platform status --catalog catalog` shows no production drift.

## Escalation

- Report cost/clutter impact and link the cleanup operation to the
  originating PR; open an incident if unowned resources or repeated
  `LP-PREVIEW-CLEANUP-FAILED` errors appear.
