# Deploying Launchpad

This guide bootstraps the Launchpad control plane on Cloudflare, configures GitHub and Vercel integration, proves the live release gates, and only then enables automatic apply and reconciliation.

Commands in this guide create or change external resources. Review the target account, repository, zone, project, environment, and value immediately before each command. Keep `LAUNCHPAD_CONTROL_PLANE_ENABLED` false until the final enablement step.

## Deployment model

The production Worker contains:

- the controller HTTP API;
- Cloudflare Workflows for apply, catalog preview, app preview status, reconciliation, and decommission;
- Queue producers/consumers and dead-letter handling;
- a D1 binding for durable state;
- typed Worker Secrets Store bindings;
- compiled dashboard assets.

GitHub Actions renders the reviewed [`wrangler.jsonc`](../../wrangler.jsonc) template with non-secret environment identifiers and the exact runtime control-plane gate, verifies every binding, applies forward-only D1 migrations, deploys the Worker, and checks `/healthz`.

Three automatic workflows remain dormant unless the repository variable `LAUNCHPAD_CONTROL_PLANE_ENABLED` is exactly `true`; an invalid nonempty value fails the mode job rather than silently becoming disabled:

- `Launchpad Apply`
- `Launchpad Reconcile`
- push-triggered `Deploy Launchpad Control Plane`

An explicit manual `bootstrap=true` dispatch may deploy the controller while automatic apply and reconciliation remain disabled. The rendered Worker receives `LAUNCHPAD_CONTROL_PLANE_ENABLED=false`, so its cron still performs non-mutating observability but provider-event and scheduled reconciliation dispatches remain dormant.

## 1. Prerequisites

Prepare:

- a Cloudflare account with Workers, Workflows, D1, Queues, Workers Secrets Store, and the managed DNS zones;
- a Vercel team and scoped token;
- GitHub administrator access to the control repository;
- GitHub CLI authenticated as the target administrator;
- Wrangler authenticated to the target Cloudflare account;
- a separately deployed authoritative-DNS resolver that implements the contract below;
- a dedicated sandbox GitHub repository, Vercel project, Cloudflare zone/hostname, and credentials for live acceptance.

Install and verify the repository first:

```bash
corepack enable
yarn install --immutable
yarn typecheck
yarn lint
yarn test
yarn build
yarn acceptance:offline
```

## 2. Review the tokentest pilot catalog

[`catalog/apps/fixture.yaml`](../../catalog/apps/fixture.yaml) is the first
managed application declaration. It targets `carterlasalle/tokentest`, the
Vercel project `tokentest`, the `tokentest.carterlasalle.com` hostname, and the
`carterlasalle.com` Cloudflare zone. Review the repository, team, hostname, and
DNS mode before any provider-backed operation.

Do not enable the controller until the tokentest repository is accessible, the
Vercel project can be created in the selected team, and the DNS hostname is
available. Provider preflight must fail closed when any target is missing.

Validate the resulting catalog:

```bash
yarn platform validate --catalog catalog
```

## 3. Authenticate Wrangler

For an interactive administrator bootstrap:

```bash
yarn wrangler login
yarn wrangler whoami
```

Confirm the displayed account before creating resources. CI does not use the interactive session; it uses `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the protected `launchpad-control-plane` GitHub environment.

## 4. Create Cloudflare state and queues

Create the production D1 database:

```bash
yarn wrangler d1 create launchpad
```

Record the returned 32-character `database_id` as `LAUNCHPAD_D1_DATABASE_ID`. Do not commit it into `wrangler.jsonc`.

Create the three queues named by the reviewed Worker config:

```bash
yarn wrangler queues create launchpad-provider-events
yarn wrangler queues create launchpad-health-checks
yarn wrangler queues create launchpad-dead-letter
```

The deployed Worker config attaches both active consumers to `launchpad-dead-letter` with bounded retries and consumes the dead-letter queue to persist visible incidents.

D1 migrations are applied by the deployment workflow immediately before Worker deployment:

```text
yarn wrangler d1 migrations apply DB --env production --config wrangler.deploy.json --remote
```

For a manual recovery, use the [D1 migration runbook](../runbooks/d1-migration.md); never rewrite an applied migration.

## 5. Create the Worker Secrets Store

Create one production store and record its 32-character ID as `LAUNCHPAD_SECRETS_STORE_ID`:

```bash
yarn wrangler secrets-store store create launchpad-production --remote
```

Create each secret interactively. Omitting `--value` prevents secret values from entering shell history:

```bash
yarn wrangler secrets-store secret create '<STORE_ID>' --name launchpad-operator-token --scopes workers --remote
yarn wrangler secrets-store secret create '<STORE_ID>' --name launchpad-controller-internal-token --scopes workers --remote
yarn wrangler secrets-store secret create '<STORE_ID>' --name launchpad-vercel-token --scopes workers --remote
yarn wrangler secrets-store secret create '<STORE_ID>' --name launchpad-cloudflare-token --scopes workers --remote
yarn wrangler secrets-store secret create '<STORE_ID>' --name launchpad-github-token --scopes workers --remote
yarn wrangler secrets-store secret create '<STORE_ID>' --name launchpad-vercel-webhook-secret --scopes workers --remote
```

| Secret name | Purpose |
|---|---|
| `launchpad-operator-token` | Authenticates dashboard and direct operator actions. Generate a high-entropy random value. |
| `launchpad-controller-internal-token` | Authenticates controller-internal calls. Generate a separate high-entropy random value. |
| `launchpad-vercel-token` | Vercel project, settings, environment, domain, deployment, promotion, and rollback operations for the target team. |
| `launchpad-cloudflare-token` | Zone read and DNS record write access only for managed zones. |
| `launchpad-github-token` | Selected-repository reads plus reconciliation/onboarding branch, content, and pull-request writes. Add workflow write only if onboarding modifies workflow files. |
| `launchpad-vercel-webhook-secret` | Verifies `x-vercel-signature` on `POST /webhooks/vercel`. |

List metadata without reading secret values:

```bash
yarn wrangler secrets-store secret list '<STORE_ID>' --remote
```

The exact names are part of the typed bindings in `wrangler.jsonc`. A missing entry is a deployment/runtime failure; Launchpad never substitutes plaintext or an empty value.

## 6. Provide the authoritative DNS resolver

Production DNS verification requires an external HTTPS endpoint. Launchpad posts:

```json
{
  "hostname": "app.example.com",
  "type": "CNAME",
  "nameservers": ["ns1.example.net.", "ns2.example.net."]
}
```

The resolver must query only the supplied authoritative nameservers and return:

```json
{
  "answers": ["cname.vercel-dns.com."],
  "nameservers": ["ns1.example.net.", "ns2.example.net."]
}
```

Requirements:

- absolute credential-free HTTPS URL;
- no recursive-resolver substitution;
- exact nameserver echo after querying every supplied server;
- bounded response time and bounded response body;
- no secret input or authorization header requirement;
- rate limiting and observability appropriate for a public service;
- stable behavior for `A`, `AAAA`, `CNAME`, and provider-required record types.

The controller validates this contract in [`apps/controller/src/dns-resolver.ts`](../../apps/controller/src/dns-resolver.ts) and fails closed on timeout, malformed output, HTTP error, or nameserver mismatch. Record the endpoint as `LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL`. A generic recursive DNS-over-HTTPS endpoint does not satisfy this contract.

## 7. Define controller identity values

Choose the expected public Worker URL before deployment. For a Workers.dev deployment it is normally based on the environment-qualified Worker name and the account's Workers.dev subdomain. A custom domain is also valid.

Set:

- `LAUNCHPAD_CONTROLLER_URL` — absolute public HTTPS URL used by GitHub workflows, internal callbacks, dashboard links, and the post-deploy smoke test;
- `LAUNCHPAD_OIDC_AUDIENCE` — absolute HTTPS URI identifying this Launchpad controller to GitHub Actions OIDC;
- `LAUNCHPAD_VERCEL_TEAM_ID` — Vercel `team_...` ID or lowercase team slug.

`LAUNCHPAD_CONTROLLER_URL` must already resolve to the URL where the newly deployed Worker will be reachable; otherwise the final smoke step correctly fails.

## 8. Configure GitHub environments

Create the protected environments:

```bash
gh api --method PUT repos/carterlasalle/launchpad-platform/environments/launchpad-control-plane
gh api --method PUT repos/carterlasalle/launchpad-platform/environments/launchpad-production
```

Configure required reviewers and deployment-branch restrictions in repository settings for both environments. `launchpad-control-plane` guards Worker deployment. `launchpad-production` guards merged catalog apply.

### Repository variables

Set values available to all workflows:

```bash
gh variable set LAUNCHPAD_CONTROL_PLANE_ENABLED --body false
gh variable set LAUNCHPAD_CONTROLLER_URL --body 'https://<controller-host>'
gh variable set LAUNCHPAD_OIDC_AUDIENCE --body 'https://<oidc-audience>'
gh variable set LAUNCHPAD_VERCEL_TEAM_ID --body '<team-id-or-slug>'
```

Keep `LAUNCHPAD_CONTROL_PLANE_ENABLED=false` through bootstrap and live acceptance.

Only `true`, `false`, or an absent value are valid. Any other nonempty value fails every control-plane mode job and the rendered deployment before provider writes.

### `launchpad-control-plane` environment variables

```bash
gh variable set LAUNCHPAD_D1_DATABASE_ID --env launchpad-control-plane --body '<32-hex-d1-id>'
gh variable set LAUNCHPAD_SECRETS_STORE_ID --env launchpad-control-plane --body '<32-hex-store-id>'
gh variable set LAUNCHPAD_VERCEL_TEAM_ID --env launchpad-control-plane --body '<team-id-or-slug>'
gh variable set LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL --env launchpad-control-plane --body 'https://<resolver-host>/v1/dns'
gh variable set LAUNCHPAD_CONTROLLER_URL --env launchpad-control-plane --body 'https://<controller-host>'
gh variable set LAUNCHPAD_OIDC_AUDIENCE --env launchpad-control-plane --body 'https://<oidc-audience>'
```

### Repository secrets

Set these through the interactive prompt or piped secret-manager output; do not use plaintext command-line arguments:

```bash
gh secret set LAUNCHPAD_GITHUB_TOKEN
gh secret set LAUNCHPAD_VERCEL_TOKEN
gh secret set LAUNCHPAD_CLOUDFLARE_TOKEN
gh secret set LAUNCHPAD_OPERATOR_TOKEN
gh secret set LAUNCHPAD_RULESET_TOKEN
```

Use read-only selected-resource tokens for PR preflight/planning. `LAUNCHPAD_OPERATOR_TOKEN` must match the operator value in Worker Secrets Store because scheduled reconciliation calls an operator-authenticated controller route. `LAUNCHPAD_RULESET_TOKEN` must be a separate fine-grained token with Administration read access for every deployment gate; bootstrap application of the ruleset temporarily requires Administration write.

### `launchpad-control-plane` environment secrets

```bash
gh secret set CLOUDFLARE_API_TOKEN --env launchpad-control-plane
gh secret set CLOUDFLARE_ACCOUNT_ID --env launchpad-control-plane
```

The deployment token needs only the target account's Worker, Workflow, D1 migration, Queue binding, asset, and Secrets Store deployment permissions. It is separate from the zone-scoped DNS token used by the running controller.

Review configured names without exposing values:

```bash
gh variable list
gh secret list
gh variable list --env launchpad-control-plane
gh secret list --env launchpad-control-plane
```

## 9. Apply the protected-branch ruleset

Dry-run the reviewed GitHub API payload locally:

```bash
node scripts/apply-ruleset.mjs --dry-run
```

This repository is configured for solo-owner mode. The ruleset still requires
pull requests, current required checks, resolved review threads, squash merges,
and blocks direct, force, deletion, and creation changes to `main`. It does not
require a second reviewer or CODEOWNER approval because GitHub would otherwise
make the sole maintainer unable to merge. A future team can raise
`required_approving_review_count` and enable CODEOWNER review in the reviewed
ruleset before adding automatic production operations.

The next command changes repository permissions and merge policy. Confirm the exact repository and token immediately before running it:

```bash
export GITHUB_REPOSITORY='carterlasalle/launchpad-platform'
export LAUNCHPAD_RULESET_TOKEN='<administration-read-write-token>'
node scripts/apply-ruleset.mjs
```

The script idempotently creates or updates `launchpad-main`, enables squash-only repository merge settings, and leaves unrelated rulesets untouched. It intentionally fails when duplicate named rulesets exist.

Verify the live result with a read token:

```bash
node scripts/verify-ruleset.mjs
```

The active ruleset must protect `refs/heads/main`, have no bypass actors, require pull requests/resolved threads, prevent creation/deletion/force-push bypass, and require these checks on every pull request:

```text
static / toolchain
static / quality
platform / summary
dependency / review
```

The release checklist additionally proves that a direct update to `main` is rejected. Do not weaken the ruleset to make a red deployment pass.

After application, replace the write-capable ruleset token stored in GitHub with an Administration read-only token for the normal deploy gate.

## 10. Verify the rendered deployment locally

Export only non-secret identifiers and URLs, then render and assert the selected environment:

```bash
export LAUNCHPAD_D1_DATABASE_ID='<32-hex-d1-id>'
export LAUNCHPAD_SECRETS_STORE_ID='<32-hex-store-id>'
export LAUNCHPAD_VERCEL_TEAM_ID='<team-id-or-slug>'
export LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL='https://<resolver-host>/v1/dns'
export LAUNCHPAD_CONTROLLER_URL='https://<controller-host>'
export LAUNCHPAD_OIDC_AUDIENCE='https://<oidc-audience>'
node scripts/render-wrangler-config.mjs --env production --output wrangler.deploy.json
node scripts/assert-deploy-bindings.mjs --env production --config wrangler.deploy.json --concrete
yarn wrangler deploy --env production --config wrangler.deploy.json --dry-run --outdir artifacts/wrangler-dry-run
```

`wrangler.deploy.json` and `artifacts/` are git-ignored. The renderer refuses missing, malformed, non-HTTPS, or placeholder values and never receives secret values.

## 11. Bootstrap the controller while automation is disabled

Dispatch the deployment explicitly from protected `main`:

```bash
gh workflow run deploy-control-plane.yml --ref main -f bootstrap=true
```

Approve the `launchpad-control-plane` environment only after confirming the SHA and configured values. The workflow then:

1. verifies the active ruleset and protected-commit provenance;
2. installs immutably and runs typecheck, tests, and build;
3. renders and validates every non-inherited binding;
4. performs a Wrangler dry run;
5. generates and attests the controller SBOM;
6. applies pending production D1 migrations;
7. deploys the Worker;
8. calls the configured controller `/healthz` endpoint.

Watch the exact run in GitHub Actions. Verify independently:

```bash
yarn platform controller-smoke --controller 'https://<controller-host>'
```

Expected JSON:

```json
{"status":"ok","service":"launchpad-control-plane"}
```

The controller is now deployed, but automatic apply and reconciliation are still disabled: the repository variable and the rendered Worker runtime gate are both false.

## 12. Configure the Vercel webhook

Configure the Vercel team webhook destination:

```text
https://<controller-host>/webhooks/vercel
```

Use the exact secret stored as `launchpad-vercel-webhook-secret`. Send a provider test event and confirm an accepted `202`, a durable webhook receipt, Queue dispatch, and no duplicate dispatch when the same event ID is replayed. Invalid signatures must return `401`.

## 13. Run live acceptance against dedicated sandbox resources

Fill the `LP_LIVE_*` variables described in [`.env.example`](../../.env.example). Every sandbox resource ID/name must contain the configured `LP_LIVE_SANDBOX_PREFIX`; the harness refuses ambiguous or production-looking targets.

Required categories:

```text
LP_LIVE_GITHUB_TOKEN and dedicated repository/id
LP_LIVE_VERCEL_TOKEN, team, and project
LP_LIVE_CLOUDFLARE_TOKEN, zone, and hostname
LAUNCHPAD_RULESET_TOKEN
LAUNCHPAD_CONTROLLER_URL
```

Run only after confirming every target is disposable:

```bash
LAUNCHPAD_LIVE_ACCEPTANCE=1 yarn acceptance:live
```

The live gate must prove:

- active ruleset parity and direct-push rejection;
- real GitHub/Vercel/Cloudflare access;
- create/update/preview/health/drift-restore/cleanup against sandbox resources;
- no leaked or orphaned resource after cleanup.

A skipped or unclaimed live gate is not release evidence.

## 14. Enable automatic operation

Complete every item in the [release checklist](../release-checklist.md). Activation has two reviewed steps because GitHub workflow variables and deployed Worker bindings are separate control planes. Do not merge catalog changes or run manual reconciliation between them.

1. Set the repository gate:

   ```bash
   gh variable set LAUNCHPAD_CONTROL_PLANE_ENABLED --body true
   ```

2. Immediately deploy `main` so the rendered Worker receives the same exact value, then wait for the protected deployment and `/healthz` smoke check:

   ```bash
   gh workflow run deploy-control-plane.yml --ref main
   ```

Only a successful deployment completes production enablement. It authorizes future merged catalog pushes, GitHub-scheduled reconciliation, and the Worker's cron/provider-event reconciliation dispatches. Confirm the repository and values immediately before running each command.

If the GitHub scheduler fires in the short handoff between steps 1 and 2, the controller rejects automatic apply/reconciliation with `LP-CONTROL-PLANE-DISABLED` before it starts a workflow or calls a provider. Wait for the deployment smoke result, then rerun any such scheduled job rather than treating its red result as a partial apply.

After enablement:

1. manually dispatch `Launchpad Reconcile` and observe a terminal result;
2. open a harmless catalog PR and confirm schema, catalog, preflight, plan, preview, health, sticky report, and summary behavior;
3. merge only after CODEOWNER approval and all required checks;
4. observe apply through DNS/domain/TLS/candidate health/promotion;
5. confirm dashboard state, D1 operation history, deployment record, health record, and audit event.

## Disable and recover

To freeze new automatic changes without taking the currently serving applications down:

1. Set `LAUNCHPAD_CONTROL_PLANE_ENABLED` to `false` at repository scope, which immediately stops the GitHub apply/reconcile workflow gates.
2. Manually dispatch the protected deployment with `bootstrap=true` so it renders `false` into the Worker, then wait for its smoke check:

   ```bash
   gh workflow run deploy-control-plane.yml --ref main -f bootstrap=true
   ```

Disabling does not roll back or delete deployed resources. Use the appropriate procedure:

- [Controller rollback](../runbooks/controller-rollback.md)
- [Promotion failure](../runbooks/promotion.md)
- [Application rollback](../runbooks/rollback.md)
- [D1 migration failure](../runbooks/d1-migration.md)
- [Credential rotation](../runbooks/credentials.md)
- [GitHub API outage](../runbooks/github-api-outage.md)
- [Vercel API outage](../runbooks/vercel-api-outage.md)
- [Cloudflare API outage](../runbooks/cloudflare-api-outage.md)

Never bypass a failing ruleset, binding assertion, migration, provider preflight, health gate, or live acceptance result merely to obtain a green deployment.
