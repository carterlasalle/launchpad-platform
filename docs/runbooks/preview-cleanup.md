# Preview cleanup backlog

1. Query cleanup jobs by `CLEANUP_PENDING`, expiry, attempts, and last error.
2. Confirm ownership metadata matches the Launchpad application, pull request, and revision.
3. Delete only owned shadow projects; unowned resources are blocked and escalated.
4. Retry transient provider errors with bounded backoff. Keep permanent failures visible.
5. Run the orphan sweep after provider recovery and verify the cleanup backlog decreases.
6. Report cost/clutter impact and link the cleanup operation to the originating PR.
