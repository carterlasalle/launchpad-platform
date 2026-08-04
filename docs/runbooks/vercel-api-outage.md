# Vercel API outage

1. Confirm the provider error code, request correlation ID, and affected applications in the dashboard.
2. Pause new promotions by disabling the Launchpad production environment or the apply workflow; do not mutate existing production domains.
3. Leave in-progress durable operations visible. Workflows retry bounded transient responses and stop after the configured limit.
4. Confirm Vercel dashboard availability independently of the API.
5. After recovery, run `yarn platform reconcile --catalog catalog --app <id> --dry-run`, then resume only after the plan fingerprint is current.
6. Record the incident, provider response class, retry count, and any failed candidate in the audit history.
