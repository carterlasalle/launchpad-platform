# Managing applications

Application manifests are Launchpad's desired state. Normal production changes begin in Git, pass provider-aware pull-request gates, and are applied only after review and merge. Provider dashboards are observed state, not an alternate configuration path.

## Catalog layout

```text
catalog/
  defaults.yaml          Shared health and policy defaults
  environments.yaml      Named deployment strategies
  zones.yaml             Allowed Cloudflare zones
  apps/
    <application>.yaml   One desired application per file
```

The complete schema is [`schema/app.schema.json`](../../schema/app.schema.json). [`catalog/apps/fixture.yaml`](../../catalog/apps/fixture.yaml) demonstrates every required top-level section.

## Create an application

Copy the fixture to a file named for the application:

```bash
cp catalog/apps/fixture.yaml catalog/apps/my-app.yaml
```

Change every example value. At minimum, review:

- `metadata.id`, display name, owners, labels, and annotations;
- GitHub repository, production branch, deployment ref, and access policy;
- Vercel project name, framework, root directory, Node version, commands, output directory, Git connection, regions, and protection;
- preview and production environment strategies and health checks;
- domains and Cloudflare zone references;
- secret references and target environments;
- application/external dependencies;
- drift, preview, staging, health, and failure policies;
- lifecycle protection and decommission fields.

Validate before committing:

```bash
yarn platform validate --catalog catalog
yarn platform validate --catalog catalog --format json
```

Unknown fields, duplicate IDs/project names/hostnames, dependency cycles, invalid lifecycle transitions, unsupported provider settings, undeclared zones, plaintext secrets, and malformed source locations block validation.

## Stable identity and ownership

`metadata.id` is immutable after first apply. It is the primary key for plans, operations, locks, D1 records, reconciliation, audit history, and tombstones.

Use GitHub users or teams in `metadata.owners`:

```yaml
metadata:
  id: payments-web
  displayName: Payments Web
  owners:
    - "@payments-platform"
```

Keep the ID independent from a mutable display name. Do not reuse a tombstoned application ID or hostname without the reviewed retention override defined by platform policy.

## Repository declaration

```yaml
repository:
  provider: github
  name: acme/payments-web
  productionBranch: main
  deploymentRef: main
  access:
    requirePrivateAccessVerification: true
    requireVercelGitAccess: true
  onboarding:
    managedWorkflow: true
    workflowVersion: v1
    openOnboardingPr: false
```

Launchpad preflight proves repository access, archive state, branch/ref existence, root-directory existence, and Vercel Git access. A repository that cannot be observed is not treated as absent or healthy.

Use an exact branch or ref appropriate for the environment. Preview and apply plans are bound to an exact commit SHA at execution time.

## Vercel configuration

The project declaration controls the settings Launchpad can safely observe and reconcile:

```yaml
vercel:
  scope: {}
  project:
    name: payments-web
    framework: nextjs
    rootDirectory: apps/web
    nodeVersion: "24.x"
    build:
      installCommand: yarn install --immutable
      buildCommand: yarn build
      outputDirectory: .next
      developmentCommand: yarn dev
      ignoredBuildStep: null
    git:
      connected: true
      productionBranch: main
```

Changing framework, root directory, Node version, build commands, environment values, domain policy, or another redeploy-required setting must produce an explicit downstream redeployment in the plan. The pull-request shadow project uses the proposed settings, so a bad root or build command fails before merge.

Unsupported settings block the plan. Launchpad never silently drops a requested field merely because a provider API does not support it.

## Environments and health

A typical preview and production policy:

```yaml
environments:
  preview:
    enabled: true
    strategy: shadow-project
    source:
      ref: main
    cleanup:
      onPrClose: true
      retentionHours: 24
    health:
      path: /api/health
      method: GET
      expectedStatus: [200]
      timeoutSeconds: 10
      attempts: 3
      intervalSeconds: 1
  production:
    enabled: true
    health:
      path: /api/health
      method: GET
      expectedStatus: [200]
      timeoutSeconds: 10
      attempts: 3
      intervalSeconds: 1
    release:
      strategy: staged-production
      promoteExactBuild: true
      autoPromoteAfterChecks: true
    rollback:
      enabled: true
      onFailedHealthCheck: true
      previousKnownGood: true
```

A Vercel `READY` build is not application health. Launchpad independently checks the candidate URL before promotion and the production URL after promotion. The previous deployment becomes known-good only after its post-promotion health result passes.

Use bounded methods, status ranges, headers, body assertions, latency, timeout, attempts, interval, and backoff supported by the schema. Secret-bearing health headers use a reference rather than a value:

```yaml
headers:
  X-Health-Key:
    secretRef: infisical://payments/health/KEY
```

## Domains and zone registry

Every Cloudflare zone reference must be declared once in [`catalog/zones.yaml`](../../catalog/zones.yaml):

```yaml
apiVersion: launchpad.dev/v1
zones:
  - example.com
```

Then reference the canonical configuration URI in the application:

```yaml
domains:
  - hostname: payments.example.com
    environment: production
    canonical: true
    cloudflare:
      zoneRef: config://cloudflare/example.com
      mode: dns-only
      ttl: auto
    redirects: []
```

`dns-only` is the default safe mode. Proxied mode requires an explicit compatibility acknowledgement in the manifest and successful origin/public route probes before promotion. Launchpad derives ownership from provider IDs and stored fingerprints, not hostname alone. A conflicting record without Launchpad ownership evidence blocks apply.

The controller waits independently for authoritative DNS propagation, Vercel domain verification, certificate readiness, candidate health, promotion, and post-promotion health.

## Secret references

Declare only references:

```yaml
secrets:
  - name: DATABASE_URL
    source: infisical://payments/production/DATABASE_URL
    sensitive: true
    environments:
      - production
```

Never place a secret value in `value`, an environment variable literal, a health header, an annotation, a label, a commit message, or a pull-request description. Catalog validation rejects plaintext sensitive values. Resolved values must pass through the configured secret provider and Vercel's encrypted environment-variable API; only reference metadata and fingerprints are persisted.

Production-only secret targets are statically prohibited from shadow previews. Use a separate preview-safe reference when preview builds need credentials.

## Dependencies

Application dependencies are stable Launchpad application IDs:

```yaml
dependencies:
  applications:
    - accounts-api
  external:
    - id: primary-database
      type: postgres
      url: https://status.example.com/database
      requiredBefore:
        - production
```

Cycles block the catalog. Dependency readiness is included in the resource graph and downstream effects. Destruction is blocked while dependents remain unless the dedicated reviewed lifecycle policy explicitly resolves them.

## Pull-request evidence

A catalog-impacting pull request runs:

1. `platform / schema`
2. `platform / catalog`
3. `platform / provider-preflight`
4. `platform / plan`
5. `platform / preview`
6. `platform / health`
7. `platform / summary`

The final summary is a required repository check. Launchpad also updates one bounded sticky comment containing the exact plan, downstream effects, preview/build/health state, and redacted provider failure details. Each revision supersedes the prior workflow and shadow preview.

Credentialed jobs do not execute the pull request's platform source. They check
out the current base commit into `trusted/`, sparse-checkout only the proposed
`catalog/` into `proposed/`, and run the trusted CLI and dependencies against
that catalog data. Provider tokens are scoped to those trusted command steps;
the report-writing GitHub token is likewise exposed only to the trusted
`report-pr` command. Schema, type, build, and test jobs may execute proposed
source, but retain no checkout credential and receive no provider secrets.
Forks run only those unprivileged checks.

When a platform change introduces manifest syntax the current base release
cannot parse, land the reviewed platform/schema change first and add the new
catalog field in a second pull request. This deliberate two-step cutover keeps
provider credentials out of the implementation-changing pull request.

Reviewers should verify:

- application and owner identity;
- source commit and deterministic fingerprint;
- create/update/redeploy/promote/reconcile/decommission/block classifications;
- every downstream effect;
- ownership evidence and ambiguity blocks;
- absence of destructive normal-apply operations;
- preview URL, terminal build state, and independent health result;
- proposed DNS mode and proxy acknowledgement;
- secret targets and environment separation;
- CODEOWNER coverage and latest-push approval.

A stale or provider-drifted plan must be replanned and reviewed. Do not merge around a red summary.

## After merge

`Launchpad Apply` reloads the merged manifest, recomputes provider state and the reviewed-plan binding, and submits an OIDC-authenticated request to the controller. The durable workflow:

1. acquires application/domain locks;
2. ensures the Vercel project and Git connection;
3. reconciles settings, environments, and secret references;
4. attaches Vercel domains;
5. writes owned Cloudflare DNS records;
6. waits for authoritative DNS, domain verification, and TLS;
7. builds an exact-commit production candidate without moving production domains;
8. runs candidate health checks;
9. promotes the exact candidate;
10. runs post-promotion health;
11. records known-good state only after success;
12. reports deployment and audit state.

Failures remain resumable and visible. A rollback that restores availability does not convert the original failed operation into success.

## Application-repository preview gate

Application repositories can call Launchpad without checking this repository out:

```yaml
name: Launchpad Preview

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions: {}

jobs:
  preview:
    permissions:
      contents: read
      id-token: write
      pull-requests: write
      deployments: write
    uses: carterlasalle/launchpad-platform/.github/workflows/reusable-app-preview.yml@<reviewed-release-tag>
    with:
      application_id: payments-web
      controller_url: ${{ vars.LAUNCHPAD_CONTROLLER_URL }}
      oidc_audience: ${{ vars.LAUNCHPAD_OIDC_AUDIENCE }}
```

Pin the reusable workflow to a reviewed immutable release tag or commit. The caller needs no Launchpad provider secret: GitHub OIDC authenticates repository, owner, workflow, event, PR, ref, actor, audience, and expiration. Fork pull requests receive no controller access.

The gate locates the Vercel deployment for the exact commit, waits for a terminal state, checks health, creates or reuses the exact-commit GitHub deployment, and updates one sticky comment. Missing or partial evidence fails.

## Observe and operate

Set the controller URL and explicit operator token in a trusted shell:

```bash
export LAUNCHPAD_CONTROLLER_URL='https://<controller-host>'
export LAUNCHPAD_OPERATOR_TOKEN='<operator-token>'
```

Read all application status:

```bash
yarn platform status --catalog catalog --controller "$LAUNCHPAD_CONTROLLER_URL"
```

Read operation history for one application:

```bash
yarn platform logs --catalog catalog --app payments-web --controller "$LAUNCHPAD_CONTROLLER_URL"
```

Use the authenticated dashboard for retry, recheck, rollback, cancel, restore-drift, adopt-drift, and configuration-change pull-request actions. Every direct action calls an existing controller endpoint, requires confirmation where consequential, and appends an audit event.

## Drift

The scheduled controller observes protected `main` desired state and live providers. A mismatch changes dashboard sync state immediately and opens or updates one reconciliation pull request per application/fingerprint.

- **Restore desired state** keeps Git authoritative and proposes reapplying it.
- **Adopt observed state** proposes a manifest change matching the intentional provider state.

Both modes pass through normal validation, plan, preview, review, and apply gates. Loss of provider access is `UNKNOWN` or `BLOCKED`, never `SYNCED`.

## Decommission and delete

Never delete a manifest to request deletion. Missing desired state produces `BLOCKED_MISSING_MANIFEST` and leaves resources intact.

The normal lifecycle is:

```text
active -> decommissioning -> approved-for-deletion -> deleted
```

Decommissioning requires a reviewed first PR, impact/dependency report, promotion freeze, configured cooling-off period, and a second reviewed PR containing the exact single-use approval token. The dedicated destroy workflow performs ordered teardown and writes a final export, tombstone, and audit record.

Follow the [safe deletion runbook](../runbooks/deletion.md) for the exact operational procedure. A partial teardown must resume from durable state; never improvise provider deletions from dashboards.

## Troubleshooting

| Failure | Meaning |
|---|---|
| `LP-GITHUB-REPO-INACCESSIBLE` | The scoped token cannot prove repository access or the repository is archived. |
| `LP-GITHUB-ROOT-MISSING` | The proposed Vercel root does not exist at the deployment ref. |
| `LP-PROVIDER-STATE-UNAVAILABLE` | Planning/preflight lacks a required provider read; no plan can be trusted. |
| `LP-PLAN-NOT-READY` | Validation, capability, ownership, lifecycle, or policy blocked the plan. |
| `LP-PLAN-COMMIT-MISMATCH` | The artifact is not bound to the exact current commit. |
| `LP-PREVIEW-FAILED` | The shadow build, polling, or health workflow reached a terminal failure. |
| `LP-DNS-*` | DNS ownership, mutation, authoritative propagation, or resolver verification failed. |
| `LP-HEALTH-*` | Application health failed independently of deployment build state. |
| `LP-DESTROY-NORMAL-APPLY-BLOCKED` | A destructive operation reached ordinary apply and was refused before writes. |

Use the [runbook index](../runbooks/README.md) for provider outages, failed promotion, rollback, locks, dead-letter events, preview cleanup, credentials, D1, and deletion.
