# GitHub API outage

1. Treat repository and review state as unknown; do not report `SYNCED` or approve an apply from cached data.
2. Leave merged-main apply and reconciliation operations queued until repository identity and commit state can be revalidated.
3. Preserve existing Vercel production state. Do not use direct provider mutation as a bypass.
4. When GitHub recovers, rerun schema, preflight, plan fingerprint, and OIDC provenance checks.
5. Reconcile any missed webhook receipts from the persisted event IDs and document the outage window.
