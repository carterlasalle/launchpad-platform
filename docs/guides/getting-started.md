# Getting started

This guide installs Launchpad, validates the repository, initializes a local D1 database, and runs the control plane and dashboard locally. It does not create or mutate live GitHub, Vercel, or Cloudflare resources.

## 1. Install the pinned toolchain

Launchpad requires the exact versions recorded by the repository:

- Node.js `24.18.0` from [`.node-version`](../../.node-version)
- Yarn `4.10.3` from `packageManager` in [`package.json`](../../package.json)

Install Node with your preferred version manager, then enable Corepack:

```bash
node --version
corepack enable
yarn --version
```

Expected versions:

```text
v24.18.0
4.10.3
```

The repository's executable toolchain check fails when Node, Yarn, the decision record, or pin files disagree:

```bash
node scripts/check-toolchain.mjs
```

## 2. Clone and install

```bash
git clone https://github.com/carterlasalle/launchpad-platform.git
cd launchpad-platform
yarn install --immutable
```

`--immutable` is mandatory: it fails rather than changing `yarn.lock`. Do not install with npm, pnpm, or Bun.

## 3. Verify the checkout

Start with the fast static and catalog checks:

```bash
yarn typecheck
yarn lint
yarn platform validate --catalog catalog
yarn docs:check
```

Run the complete test and build pipeline:

```bash
yarn test
yarn build
```

Run the deterministic release acceptance matrix:

```bash
yarn acceptance:offline
```

The offline matrix uses controlled adapters and fixtures. It verifies the full behavior contract without provider credentials, but it does not prove live provider access or live resource behavior.

## 4. Inspect the catalog

The repository includes one comprehensive fixture application at [`catalog/apps/fixture.yaml`](../../catalog/apps/fixture.yaml), shared defaults, environment strategies, and a zone registry.

Validate human-readable output:

```bash
yarn platform validate --catalog catalog
```

Validate machine-readable output:

```bash
yarn platform validate --catalog catalog --format json
```

Render the provider-neutral resource graph without making provider calls:

```bash
yarn platform graph --catalog catalog --app fixture-app --output artifacts/graph
```

This writes JSON and Graphviz DOT artifacts under the git-ignored `artifacts/` directory.

The fixture deliberately uses example repository and domain values. Replace them with disposable resources before any credential-backed preflight or plan.

## 5. Initialize local D1

Build all workspaces first because the Worker serves the compiled dashboard assets:

```bash
yarn build
```

Apply the forward-only migrations to Wrangler's local D1 state:

```bash
yarn wrangler d1 migrations apply DB --local
```

Wrangler stores local state under the git-ignored `.wrangler/` directory. Re-running the command applies only unapplied migrations.

## 6. Configure local Worker secrets

The health endpoint and static dashboard do not require provider credentials. To exercise authenticated operator routes locally, copy the ignored Worker variable file and replace the two local-only tokens:

```bash
cp .dev.vars.example .dev.vars
```

Set random development-only values for:

```text
OPERATOR_TOKEN
CONTROLLER_INTERNAL_TOKEN
```

Provider-backed flows additionally need scoped disposable credentials in `.dev.vars`:

```text
GITHUB_TOKEN
VERCEL_TOKEN
VERCEL_TEAM_ID
CLOUDFLARE_TOKEN
VERCEL_WEBHOOK_SECRET
LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL
```

Never reuse production credentials for local development. Never commit `.dev.vars`; it is ignored by Git.

## 7. Run the control plane

```bash
yarn wrangler dev --local
```

Wrangler starts the controller, workflows, queues, D1, and dashboard assets on `http://localhost:8787` by default.

In another terminal, verify the Worker process itself:

```bash
yarn platform controller-smoke --controller http://127.0.0.1:8787
```

Expected response:

```json
{"status":"ok","service":"launchpad-control-plane"}
```

Open `http://localhost:8787` to load the dashboard. Enter the same local `OPERATOR_TOKEN` when the dashboard requests an operator token. A healthy Worker does not imply provider-backed operations are configured; those fail closed when a required credential or resolver is absent.

## 8. Run provider preflight

Preflight is read-only but credential-dependent. Export scoped credentials for disposable resources in your shell or secret manager:

```bash
export LAUNCHPAD_GITHUB_TOKEN='<fine-grained token>'
export LAUNCHPAD_VERCEL_TOKEN='<team-scoped token>'
export LAUNCHPAD_VERCEL_TEAM_ID='<team id or slug>'
export LAUNCHPAD_CLOUDFLARE_TOKEN='<zone-scoped token>'
```

Then run:

```bash
yarn platform preflight --catalog catalog --format json
```

Preflight checks repository access, archive state, deployment ref/root existence, Vercel project visibility, and Cloudflare zone access. It must fail when a provider is unreachable or a required resource is inaccessible.

Generate a live provider-aware plan for an exact commit only after preflight succeeds:

```bash
yarn platform plan --catalog catalog --sha "$(git rev-parse HEAD)" --format json --output artifacts/plan
```

Planning reads providers but does not mutate them. Preview, apply, app-preview, status, logs, reconciliation, rollback, and destroy routes require a configured controller and the appropriate OIDC or operator identity; use the GitHub workflows for normal operation.

## 9. Choose the next path

- To provision the real control plane, continue with [Deploying Launchpad](deployment.md).
- To author application desired state, continue with [Managing applications](managing-applications.md).
- To understand architecture and requirements, read the [documentation index](../README.md).
- For a failure, use the [runbook index](../runbooks/README.md).

## Common setup failures

| Symptom | Cause and action |
|---|---|
| `node scripts/check-toolchain.mjs` fails | Install Node `24.18.0`, enable Corepack, and use Yarn `4.10.3`; do not change pins to match the workstation. |
| Immutable install changes or rejects the lockfile | Restore the reviewed `yarn.lock` or intentionally update dependencies through a dedicated PR. |
| Local Worker returns a D1 table error | Run `yarn wrangler d1 migrations apply DB --local`, then retry. |
| Provider preflight reports `LP-PROVIDER-STATE-UNAVAILABLE` | Export all three read credentials; preflight never treats a missing provider as success. |
| Planning reports `LP-COMMIT-UNBOUND` | Pass an exact lowercase 40-character SHA through `--sha`. |
| Controller operation reports a missing token | Workflow operations require GitHub Actions OIDC; operator routes require `LAUNCHPAD_OPERATOR_TOKEN`. |
| DNS verification reports resolver configuration errors | Configure an absolute credential-free HTTPS authoritative resolver endpoint; recursive DNS is not accepted as proof. |

Provider outage procedures are indexed under [operations](../runbooks/README.md).
