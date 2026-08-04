# Secret-provider outage

1. Mark affected operations `BLOCKED` or `UNKNOWN`; never substitute an empty or stale value.
2. Confirm the provider reference and environment without logging the resolved value.
3. Keep existing deployments running; new deployments and promotions remain gated.
4. Restore provider access, then run a read-only reference existence check and fingerprint comparison.
5. Stage a new candidate because Vercel environment values are deployment-scoped.
6. Run candidate and production health checks before promotion; scan artifacts for the canary secret.
