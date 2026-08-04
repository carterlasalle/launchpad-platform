# Provider schema incompatibility

1. Stop the affected adapter operation when required response fields are missing or malformed.
2. Preserve the redacted response shape, endpoint, provider version, and correlation ID.
3. Add a fixture reproducing the response and a failing provider contract test.
4. Update only the provider adapter and capability snapshot; keep core domain types provider-neutral.
5. Run all provider contract, plan snapshot, and failure-path tests before deployment.
6. Deploy behind a reviewed controller release and re-run a disposable fixture operation.
