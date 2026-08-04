# Failed rollback

1. Mark the release `FAILED` and the rollback result `FAILED`; do not report success.
2. Verify whether the previous known-good deployment still exists and belongs to the same project/environment.
3. Run the health check against the current production domain and capture DNS/TLS/status/body evidence.
4. If a second known-good deployment exists, require explicit operator approval before targeting it.
5. Freeze further promotions, open an incident, and keep production configuration changes in Git.
6. After recovery, record the restored deployment and re-run reconciliation from protected main.
