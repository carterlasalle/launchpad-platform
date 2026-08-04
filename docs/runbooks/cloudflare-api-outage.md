# Cloudflare API outage

1. Confirm whether the outage affects DNS reads, DNS writes, or authoritative resolution.
2. Keep production aliases unchanged and block new domain mutations; DNS-only records already in place continue serving.
3. Do not delete or recreate records to work around a provider timeout.
4. Inspect the latest durable step and retry only the failed provider operation after the API recovers.
5. Verify authoritative DNS, Vercel domain verification, TLS, and the health endpoint before promotion.
6. Attach the incident URL and provider correlation IDs to the operation record.
