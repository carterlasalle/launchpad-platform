# Launchpad guides

These guides cover the normal path from a local checkout to a safely enabled GitOps control plane.

## Recommended sequence

1. [Getting started](getting-started.md)
   - Install the pinned Node.js and Yarn toolchain.
   - Validate the catalog and run deterministic checks.
   - Initialize local D1 and run the Worker/dashboard locally.
   - Understand which commands require provider credentials.

2. [Deploying Launchpad](deployment.md)
   - Provision D1, Queues, Worker Secrets Store, and the authoritative DNS resolver dependency.
   - Configure GitHub repository and environment variables/secrets.
   - Apply and verify the protected-branch ruleset.
   - Deploy, run live sandbox acceptance, and enable automatic workflows.

3. [Managing applications](managing-applications.md)
   - Author application manifests and the zone registry.
   - Interpret plan, preview, and health evidence.
   - Operate apply, reconciliation, rollback, decommission, and app-repository preview flows.

## Related references

- [Unified GitOps Master Plan](../Launchpad_Unified_GitOps_Master_Plan.md)
- [Architecture decisions](../adr/README.md)
- [Runbooks](../runbooks/README.md)
- [Release checklist](../release-checklist.md)
- [Contributing](../../CONTRIBUTING.md)
