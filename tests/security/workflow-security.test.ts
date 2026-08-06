import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const workflowDirectory = join(process.cwd(), '.github/workflows');
const workflowFiles = ['ci.yml', 'dependency-review.yml', 'validate-plan.yml', 'apply.yml', 'reconcile.yml', 'destroy.yml', 'deploy-control-plane.yml', 'reusable-app-preview.yml'];

it('pins third-party actions and uses least-privilege workflow defaults', () => {
  for (const file of workflowFiles) {
    const source = readFileSync(join(workflowDirectory, file), 'utf8');
    expect(source).toContain('permissions: {}');
    for (const line of source.split('\n').filter((candidate) => candidate.includes('uses: actions/'))) expect(line).toMatch(/@[0-9a-f]{40}/);
    expect(source).not.toMatch(/npm install|pnpm install|bun install/);
    expect(source).not.toMatch(/\bcache:\s*yarn\b/);
  }
});

it('does not persist repository credentials in workflows that execute pull-request code', () => {
  for (const file of ['ci.yml', 'dependency-review.yml', 'validate-plan.yml']) {
    const workflow = parse(readFileSync(join(workflowDirectory, file), 'utf8')) as {
      jobs: Record<string, { steps?: Array<{ uses?: string; with?: Record<string, unknown> }> }>;
    };
    const checkouts = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []).filter((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkouts.length, file).toBeGreaterThan(0);
    for (const checkout of checkouts) expect(checkout.with?.['persist-credentials'], file).toBe(false);
  }
});

it('executes credentialed and report-writing PR steps only from the trusted base commit', () => {
  type Step = {
    name?: string;
    uses?: string;
    run?: string;
    if?: string;
    env?: Record<string, string>;
    with?: Record<string, unknown>;
    'working-directory'?: string;
  };
  const workflow = parse(readFileSync(join(workflowDirectory, 'validate-plan.yml'), 'utf8')) as {
    jobs: Record<string, { steps?: Step[] }>;
  };
  const privilegedJobs = ['provider-preflight', 'plan', 'preview', 'health', 'summary'];

  for (const jobName of privilegedJobs) {
    const steps = workflow.jobs[jobName]?.steps ?? [];
    const trustedCheckout = steps.find((step) => step.name === 'Checkout trusted platform implementation');
    expect(trustedCheckout?.with, jobName).toMatchObject({
      ref: '${{ github.event.pull_request.base.sha }}',
      path: 'trusted',
      'persist-credentials': false,
    });
    const proposedCheckout = steps.find((step) => step.name === 'Checkout proposed catalog');
    expect(proposedCheckout?.with, jobName).toMatchObject({
      ref: '${{ env.HEAD_SHA }}',
      path: 'proposed',
      'sparse-checkout': 'catalog',
      'persist-credentials': false,
    });
    expect(steps.some((step) => step.uses === './.github/actions/assert-pr-head'), jobName).toBe(false);
    expect(steps.some((step) => step.uses === './.github/actions/setup-launchpad'), jobName).toBe(false);
    expect(steps.find((step) => step.uses === './trusted/.github/actions/assert-pr-head'), jobName).toBeDefined();
    const setup = steps.find((step) => step.name === 'Install trusted platform dependencies');
    expect(setup?.['working-directory'], jobName).toBe('trusted');
    expect(setup?.run, jobName).toContain('yarn install --immutable');
    for (const step of steps.filter((candidate) => candidate.run?.includes('yarn platform'))) {
      expect(step['working-directory'], `${jobName}: ${step.name ?? step.run}`).toBe('trusted');
      expect(step.run, jobName).toContain('$GITHUB_WORKSPACE/proposed/catalog');
    }
  }

  const allSteps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
  expect(allSteps.some((step) => step.uses === './.github/actions/assert-pr-head')).toBe(false);
  for (const step of allSteps.filter((candidate) => Object.keys(candidate.env ?? {}).some((name) => /^LAUNCHPAD_(?:GITHUB|VERCEL|CLOUDFLARE)_TOKEN$/.test(name)))) {
    expect(step['working-directory'], step.name ?? step.run).toBe('trusted');
  }
  const report = workflow.jobs.summary?.steps?.find((step) => step.run?.includes('platform report-pr'));
  expect(report?.env?.GITHUB_TOKEN).toBe('${{ github.token }}');
});

it('grants read-only pull-request metadata access to stale-head guards', () => {
  const workflow = parse(readFileSync(join(workflowDirectory, 'validate-plan.yml'), 'utf8')) as {
    jobs: Record<string, { permissions?: Record<string, string> }>;
  };
  for (const job of ['changes', 'schema', 'catalog', 'provider-preflight', 'plan', 'preview', 'health']) {
    expect(workflow.jobs[job]?.permissions?.['pull-requests'], job).toBe('read');
  }
  expect(workflow.jobs.summary?.permissions?.['pull-requests']).toBe('write');
});

it('uses valid gh API jq syntax for stale-head guards', () => {
  const workflow = readFileSync(join(workflowDirectory, 'validate-plan.yml'), 'utf8');
  const action = readFileSync(join(process.cwd(), '.github/actions/assert-pr-head/action.yml'), 'utf8');
  expect(workflow).toContain("--jq '.head.sha'");
  expect(action).toContain("--jq '.head.sha'");
  expect(workflow).not.toContain("--jq -r '.head.sha'");
  expect(action).not.toContain("--jq -r '.head.sha'");
});

it('keeps automatic production workflows dormant until explicitly enabled', () => {
  const automaticWorkflows = [
    { file: 'apply.yml', job: 'apply' },
    { file: 'reconcile.yml', job: 'reconcile' },
    { file: 'deploy-control-plane.yml', job: 'verify-static-foundation' },
  ];

  for (const { file, job } of automaticWorkflows) {
    const workflow = parse(readFileSync(join(workflowDirectory, file), 'utf8')) as {
      jobs: Record<string, {
        needs?: string;
        if?: string;
        outputs?: Record<string, string>;
        steps?: Array<{ id?: string; env?: Record<string, string> }>;
      }>;
    };
    const mode = workflow.jobs['control-plane-mode'];
    expect(mode, file).toBeDefined();
    expect(mode.outputs?.enabled, file).toBe('${{ steps.mode.outputs.enabled }}');
    expect(mode.steps?.find((step) => step.id === 'mode')?.env?.ENABLED, file).toBe('${{ vars.LAUNCHPAD_CONTROL_PLANE_ENABLED }}');
    expect(workflow.jobs[job]?.needs, file).toBe('control-plane-mode');
    expect(workflow.jobs[job]?.if, file).toBe("needs.control-plane-mode.outputs.enabled == 'true'");
  }
});

it('rejects ambiguous control-plane mode values instead of silently treating them as disabled', () => {
  for (const file of ['apply.yml', 'reconcile.yml', 'deploy-control-plane.yml']) {
    const workflow = parse(readFileSync(join(workflowDirectory, file), 'utf8')) as {
      jobs: Record<string, { steps?: Array<{ id?: string; run?: string }> }>;
    };
    const mode = workflow.jobs['control-plane-mode']?.steps?.find((step) => step.id === 'mode');
    expect(mode?.run, file).toContain('LP-CONTROL-PLANE-MODE-INVALID');
    expect(mode?.run, file).toContain('case "$ENABLED" in');
  }
});

it('marks the GitHub-scheduled reconciliation request as automatic', () => {
  const workflow = parse(readFileSync(join(workflowDirectory, 'reconcile.yml'), 'utf8')) as {
    jobs: Record<string, { steps?: Array<{ run?: string; env?: Record<string, string> }> }>;
  };
  const reconcile = workflow.jobs.reconcile?.steps?.find((step) => step.run === 'yarn platform reconcile --catalog catalog');
  expect(reconcile?.env?.LAUNCHPAD_AUTOMATED_RECONCILIATION).toBe('true');
});

it('renders the runtime reconciliation gate from the repository enablement variable', () => {
  const workflow = parse(readFileSync(join(workflowDirectory, 'deploy-control-plane.yml'), 'utf8')) as {
    jobs: Record<string, { steps?: Array<{ name?: string; env?: Record<string, string> }> }>;
  };
  const render = workflow.jobs.deploy?.steps?.find((step) => step.name === 'Render production Wrangler config from environment variables');
  expect(render?.env?.LAUNCHPAD_CONTROL_PLANE_ENABLED).toBe('${{ vars.LAUNCHPAD_CONTROL_PLANE_ENABLED }}');
});

it('applies production D1 migrations before deploying the controller', () => {
  const workflow = parse(readFileSync(join(workflowDirectory, 'deploy-control-plane.yml'), 'utf8')) as {
    jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
  };
  const steps = workflow.jobs.deploy?.steps ?? [];
  const migration = steps.findIndex((step) => step.run?.includes('wrangler d1 migrations apply DB'));
  const deploy = steps.findIndex((step) => step.run?.trim() === 'yarn wrangler deploy --env production --config wrangler.deploy.json');

  expect(migration).toBeGreaterThanOrEqual(0);
  expect(deploy).toBeGreaterThan(migration);
  expect(steps[migration]?.run).toContain('--config wrangler.deploy.json');
  expect(steps[migration]?.run).toContain('--remote');
});

it('redeploys the controller when root runtime inputs change', () => {
  const workflow = parse(readFileSync(join(workflowDirectory, 'deploy-control-plane.yml'), 'utf8')) as {
    on: { push?: { paths?: string[] } };
  };

  expect(workflow.on.push?.paths).toEqual(expect.arrayContaining([
    'package.json',
    'yarn.lock',
    '.node-version',
    '.yarnrc.yml',
    'tsconfig*.json',
  ]));
});

it('requires an explicit manual bootstrap while automatic control-plane changes are disabled', () => {
  const workflow = parse(readFileSync(join(workflowDirectory, 'deploy-control-plane.yml'), 'utf8')) as {
    on: { workflow_dispatch?: { inputs?: Record<string, { type?: string; default?: boolean }> } };
    jobs: Record<string, { steps?: Array<{ id?: string; env?: Record<string, string>; run?: string }> }>;
  };
  const bootstrap = workflow.on.workflow_dispatch?.inputs?.bootstrap;
  const mode = workflow.jobs['control-plane-mode']?.steps?.find((step) => step.id === 'mode');

  expect(bootstrap).toMatchObject({ type: 'boolean', default: false });
  expect(mode?.env?.BOOTSTRAP).toBe('${{ inputs.bootstrap }}');
  expect(mode?.run).toContain('\"$BOOTSTRAP\" == \"true\"');
});

it('binds provider reads to the configured Vercel team', () => {
  const validate = parse(readFileSync(join(workflowDirectory, 'validate-plan.yml'), 'utf8')) as {
    jobs: Record<string, { steps?: Array<{ run?: string; env?: Record<string, string> }> }>;
  };
  const apply = parse(readFileSync(join(workflowDirectory, 'apply.yml'), 'utf8')) as {
    jobs: Record<string, { steps?: Array<{ name?: string; env?: Record<string, string> }> }>;
  };

  for (const job of ['provider-preflight', 'plan']) {
    const step = validate.jobs[job]?.steps?.find((candidate) => candidate.run?.includes(`platform ${job === 'provider-preflight' ? 'preflight' : 'plan'}`));
    expect(step?.env?.LAUNCHPAD_VERCEL_TEAM_ID, job).toBe('${{ vars.LAUNCHPAD_VERCEL_TEAM_ID }}');
  }
  const applyStep = apply.jobs.apply?.steps?.find((step) => step.name === 'Revalidate and apply');
  expect(applyStep?.env?.LAUNCHPAD_VERCEL_TEAM_ID).toBe('${{ vars.LAUNCHPAD_VERCEL_TEAM_ID }}');
});

it('publishes required checks for every pull request and scopes provider work to relevant changes', () => {
  for (const file of ['ci.yml', 'dependency-review.yml', 'validate-plan.yml']) {
    const workflow = parse(readFileSync(join(workflowDirectory, file), 'utf8')) as {
      on: { pull_request?: { paths?: string[] } };
    };
    expect(workflow.on.pull_request, file).toBeDefined();
    expect(workflow.on.pull_request?.paths, file).toBeUndefined();
  }

  const workflow = parse(readFileSync(join(workflowDirectory, 'validate-plan.yml'), 'utf8')) as {
    jobs: Record<string, {
      needs?: string | string[];
      if?: string;
      outputs?: Record<string, string>;
      steps?: Array<{ id?: string; name?: string; uses?: string; if?: string; run?: string }>;
    }>;
  };
  expect(workflow.jobs.changes?.outputs?.relevant).toBe('${{ steps.scope.outputs.relevant }}');
  expect(workflow.jobs.schema?.needs).toBe('changes');
  expect(workflow.jobs.schema?.if).toContain("needs.changes.outputs.relevant == 'true'");
  expect(workflow.jobs.summary?.needs).toContain('changes');
  expect(workflow.jobs.summary?.if).toBe('${{ always() }}');
  const report = workflow.jobs.summary?.steps?.find((step) => step.name === 'Publish aggregated Launchpad report comment');
  expect(report?.if).toContain("needs.changes.outputs.relevant == 'true'");
  const aggregate = workflow.jobs.summary?.steps?.find((step) => step.name === 'Aggregate required job results');
  expect(aggregate?.run).toContain("relevant='${{ needs.changes.outputs.relevant }}'");
  expect(aggregate?.run).toContain("changes_result='${{ needs.changes.result }}'");
  expect(aggregate?.run).toContain('Change classification ended with');
  expect(aggregate?.run).toContain('[[ \"$result\" != \"success\" ]]');

  const summarySetup = workflow.jobs.summary?.steps?.find((step) => step.name === 'Install trusted platform dependencies');
  expect(summarySetup?.if).toContain("needs.changes.outputs.relevant == 'true'");
  const dependency = parse(readFileSync(join(workflowDirectory, 'dependency-review.yml'), 'utf8')) as {
    jobs: Record<string, { steps?: Array<{ id?: string; uses?: string; if?: string; run?: string }> }>;
  };
  const dependencySteps = dependency.jobs['dependency-review']?.steps ?? [];
  const dependencyScope = dependencySteps.find((step) => step.id === 'scope');
  const dependencyAudit = dependencySteps.find((step) => step.run === 'yarn npm audit --all --recursive --severity high');
  expect(dependencyScope?.run).toContain('git diff --quiet');
  expect(dependencyScope?.run).toContain('**/package.json');
  expect(dependencyAudit?.if).toBe("steps.scope.outputs.relevant == 'true'");
  expect(dependencySteps.some((step) => step.uses?.startsWith('actions/dependency-review-action@'))).toBe(false);
  const dependencyCorepack = dependencySteps.find((step) => step.run === 'corepack enable');
  expect(dependencyCorepack?.if).toBe("steps.scope.outputs.relevant == 'true'");
  expect(dependencySteps.indexOf(dependencyCorepack!)).toBeLessThan(dependencySteps.indexOf(dependencyAudit!));
  expect(dependencySteps.some((step) => step.uses === './.github/actions/setup-launchpad')).toBe(false);
});

it('runs required static checks only for their relevant change classes', () => {
  const workflow = parse(readFileSync(join(workflowDirectory, 'ci.yml'), 'utf8')) as {
    jobs: Record<string, {
      needs?: string | string[];
      if?: string;
      outputs?: Record<string, string>;
      steps?: Array<{ name?: string; run?: string; if?: string }>;
    }>;
  };

  expect(workflow.jobs.changes?.outputs).toMatchObject({
    code: '${{ steps.scope.outputs.code }}',
    docs: '${{ steps.scope.outputs.docs }}',
  });
  expect(workflow.jobs.toolchain?.needs).toBe('changes');
  expect(workflow.jobs.toolchain?.if).toBe('${{ always() }}');
  const toolchainGuard = workflow.jobs.toolchain?.steps?.find((step) => step.name === 'Fail when change classification failed');
  expect(toolchainGuard?.if).toContain("needs.changes.result != 'success'");
  expect(workflow.jobs.quality?.needs).toEqual(['changes', 'toolchain']);
  expect(workflow.jobs.quality?.if).toBe('${{ always() }}');
  const qualitySteps = workflow.jobs.quality?.steps ?? [];
  const qualityGuard = qualitySteps.find((step) => step.name === 'Fail when a static prerequisite failed');
  expect(qualityGuard?.if).toContain("needs.toolchain.result != 'success'");
  expect(qualitySteps.find((step) => step.run === 'yarn typecheck')?.if).toContain("needs.changes.outputs.code == 'true'");
  expect(qualitySteps.find((step) => step.name === 'Verify documentation')?.if).toContain("needs.changes.outputs.docs == 'true'");
});

it('classifies a toolchain decision-record update as a code change', () => {
  const source = readFileSync(join(workflowDirectory, 'ci.yml'), 'utf8');
  expect(source).toContain('docs/adr/0007-toolchain-node-yarn.md) code=true; docs=true ;;');
});


it('passes GitHub repository identity to OIDC-authenticated controller jobs', () => {
  const validate = parse(readFileSync(join(workflowDirectory, 'validate-plan.yml'), 'utf8')) as {
    jobs: Record<string, { env?: Record<string, string> }>;
  };
  const apply = parse(readFileSync(join(workflowDirectory, 'apply.yml'), 'utf8')) as {
    jobs: Record<string, { steps?: Array<{ name?: string; env?: Record<string, string> }> }>;
  };

  expect(validate.jobs.preview?.env).toMatchObject({
    GITHUB_REPOSITORY_ID: '${{ github.repository_id }}',
    GITHUB_REPOSITORY_OWNER_ID: '${{ github.repository_owner_id }}',
  });
  const applyStep = apply.jobs.apply?.steps?.find((step) => step.name === 'Revalidate and apply');
  expect(applyStep?.env).toMatchObject({
    GITHUB_REPOSITORY_ID: '${{ github.repository_id }}',
    GITHUB_REPOSITORY_OWNER_ID: '${{ github.repository_owner_id }}',
  });
});