import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface WranglerConfig {
  name?: string;
  main?: string;
  assets?: { directory?: string; binding?: string; run_worker_first?: boolean };
  d1_databases?: Array<{ database_id?: string; migrations_dir?: string }>;
  vars?: Record<string, unknown>;
  env?: Record<string, EnvironmentConfig>;
}

interface EnvironmentConfig {
  vars?: Record<string, unknown>;
  d1_databases?: Array<{ database_id?: string; migrations_dir?: string }>;
  secrets_store_secrets?: Array<{ store_id?: string; secret_name?: string }>;
  workflows?: unknown;
  routes?: unknown;
  triggers?: unknown;
}

const root = process.cwd();
const assertScript = join(root, 'scripts/assert-deploy-bindings.mjs');
const renderScript = join(root, 'scripts/render-wrangler-config.mjs');
const config = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')) as WranglerConfig;
const readRendered = () => JSON.parse(readFileSync(RENDERED_PATH, 'utf8')) as WranglerConfig;

const secretNames = ['OPERATOR_TOKEN', 'CONTROLLER_INTERNAL_TOKEN', 'VERCEL_TOKEN', 'CLOUDFLARE_TOKEN', 'GITHUB_TOKEN', 'VERCEL_WEBHOOK_SECRET'];

const D1_ID = 'dcf86e42-6afe-4179-87c5-77c7dd003f4c';
const STORE_ID = 'd32d57347ebf4f378598d3f6bb9e6945';
const TEAM_ID = 'team_launchpad-production';
const RESOLVER_URL = 'https://dns-resolver.launchpad.internal/v1/dns';
const CONTROLLER_URL = 'https://launchpad-control-plane.example.workers.dev';
const OIDC_AUDIENCE = 'https://launchpad.example.internal';
const RENDERED_OUTPUT = 'wrangler.deploy.test.json';
const RENDERED_PATH = join(root, RENDERED_OUTPUT);

const run = (script: string, args: string[], overrides: Record<string, string> = {}) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: {
      LAUNCHPAD_D1_DATABASE_ID: D1_ID,
      LAUNCHPAD_SECRETS_STORE_ID: STORE_ID,
      LAUNCHPAD_VERCEL_TEAM_ID: TEAM_ID,
      LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL: RESOLVER_URL,
      LAUNCHPAD_CONTROLLER_URL: CONTROLLER_URL,
      LAUNCHPAD_OIDC_AUDIENCE: OIDC_AUDIENCE,
      ...process.env,
      ...overrides,
    },
  });

afterEach(() => {
  if (existsSync(RENDERED_PATH)) unlinkSync(RENDERED_PATH);
});

it('asserts the full non-inherited binding surface for production and test environments', () => {
  for (const env of ['production', 'test']) {
    const result = run(assertScript, ['--env', env]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK');
  }
});

it('binds the built dashboard assets while keeping the controller first', () => {
  expect(config.assets).toEqual({
    directory: './apps/dashboard/dist',
    binding: 'ASSETS',
    run_worker_first: true,
  });
});

it('keeps secrets out of vars in every environment', () => {
  for (const env of ['production', 'test']) {
    const vars = config.env?.[env]?.vars ?? {};
    for (const name of secretNames) expect(vars[name]).toBeUndefined();
  }
});

it('renders a deployable config for the selected environment and nothing else', () => {
  const result = run(renderScript, ['--env', 'production', '--output', RENDERED_OUTPUT]);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toContain(RENDERED_OUTPUT);

  const rendered = readRendered();
  const production = rendered.env?.production;

  // Selected environment is substituted.
  expect(production?.d1_databases?.[0]?.database_id).toBe(D1_ID);
  for (const binding of production?.secrets_store_secrets ?? []) expect(binding.store_id).toBe(STORE_ID);
  expect(production?.vars?.VERCEL_TEAM_ID).toBe(TEAM_ID);
  expect(production?.vars?.LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL).toBe(RESOLVER_URL);
  expect(production?.vars?.CONTROLLER_INTERNAL_URL).toBe(CONTROLLER_URL);
  expect(production?.vars?.OIDC_AUDIENCE).toBe(OIDC_AUDIENCE);

  // Every other environment keeps its reviewed placeholders.
  expect(rendered.env?.test?.d1_databases?.[0]?.database_id).toBe('replace-in-test');
  for (const binding of rendered.env?.test?.secrets_store_secrets ?? []) expect(binding.store_id).toBe('replace-in-test');
  expect(rendered.env?.test?.vars?.VERCEL_TEAM_ID).toBe('replace-in-test');
  expect(rendered.env?.test?.vars?.LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL).toBe('replace-in-test');
  expect(rendered.env?.test?.vars?.CONTROLLER_INTERNAL_URL).toBe('replace-in-test');
  expect(rendered.env?.test?.vars?.OIDC_AUDIENCE).toBe('replace-in-test');
  expect(rendered.d1_databases?.[0]?.database_id).toBe('replace-in-environment');
  expect(rendered.vars?.VERCEL_TEAM_ID).toBeUndefined();
  expect(rendered.vars?.LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL).toBeUndefined();
});

it('renders the runtime control-plane gate as disabled by default and only accepts exact boolean activation', () => {
  const disabled = run(renderScript, ['--env', 'production', '--output', RENDERED_OUTPUT], { LAUNCHPAD_CONTROL_PLANE_ENABLED: '' });
  expect(disabled.status).toBe(0);
  expect(readRendered().env?.production?.vars?.LAUNCHPAD_CONTROL_PLANE_ENABLED).toBe('false');

  const enabled = run(renderScript, ['--env', 'production', '--output', RENDERED_OUTPUT], { LAUNCHPAD_CONTROL_PLANE_ENABLED: 'true' });
  expect(enabled.status).toBe(0);
  expect(readRendered().env?.production?.vars?.LAUNCHPAD_CONTROL_PLANE_ENABLED).toBe('true');

  const invalid = run(renderScript, ['--env', 'production', '--output', RENDERED_OUTPUT], { LAUNCHPAD_CONTROL_PLANE_ENABLED: 'yes' });
  expect(invalid.status).not.toBe(0);
  expect(invalid.stderr).toContain('LAUNCHPAD_CONTROL_PLANE_ENABLED');
});

it('renders test without touching the production placeholders', () => {
  const result = run(renderScript, [`--env=test`, `--output=${RENDERED_OUTPUT}`]);
  expect(result.status).toBe(0);

  const rendered = readRendered();
  expect(rendered.env?.test?.d1_databases?.[0]?.database_id).toBe(D1_ID);
  for (const binding of rendered.env?.test?.secrets_store_secrets ?? []) expect(binding.store_id).toBe(STORE_ID);
  expect(rendered.env?.test?.vars?.VERCEL_TEAM_ID).toBe(TEAM_ID);
  expect(rendered.env?.test?.vars?.LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL).toBe(RESOLVER_URL);
  expect(rendered.env?.test?.vars?.CONTROLLER_INTERNAL_URL).toBe(CONTROLLER_URL);
  expect(rendered.env?.test?.vars?.OIDC_AUDIENCE).toBe(OIDC_AUDIENCE);
  expect(rendered.env?.production?.d1_databases?.[0]?.database_id).toBe('replace-in-production');
  expect(rendered.env?.production?.vars?.VERCEL_TEAM_ID).toBe('replace-in-production');
  expect(rendered.env?.production?.vars?.LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL).toBe('replace-in-production');
  expect(rendered.env?.production?.vars?.CONTROLLER_INTERNAL_URL).toBe('replace-in-production');
  expect(rendered.env?.production?.vars?.OIDC_AUDIENCE).toBe('replace-in-production');
});

it('preserves every other field and keeps deploy paths root-relative', () => {
  const result = run(renderScript, ['--env', 'production', '--output', RENDERED_OUTPUT]);
  expect(result.status).toBe(0);

  const rendered = readRendered();
  expect(rendered.name).toBe('launchpad-control-plane');
  expect(rendered.main).toBe('apps/controller/src/worker.ts');
  expect(rendered.main?.startsWith('/')).toBe(false);
  expect(rendered.assets).toEqual(config.assets);
  expect(rendered.d1_databases?.[0]?.migrations_dir).toBe('migrations/d1');
  expect(rendered.env?.production?.workflows).toEqual(config.env?.production?.workflows);
  expect(rendered.env?.production?.routes).toEqual(config.env?.production?.routes);
  expect(rendered.env?.production?.queues).toEqual(config.env?.production?.queues);
  expect(rendered.env?.production?.triggers).toEqual(config.env?.production?.triggers);
  expect(rendered.env?.production?.d1_databases?.[0]?.migrations_dir).toBe('migrations/d1');
});

it('fails before writing when deployment variables are missing or empty', () => {
  const missing = run(renderScript, ['--env', 'production', '--output', RENDERED_OUTPUT], {
    LAUNCHPAD_D1_DATABASE_ID: '',
    LAUNCHPAD_SECRETS_STORE_ID: '',
    LAUNCHPAD_VERCEL_TEAM_ID: '',
    LAUNCHPAD_CONTROLLER_URL: '',
    LAUNCHPAD_OIDC_AUDIENCE: '',
  });
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toContain('LAUNCHPAD_D1_DATABASE_ID');
  expect(missing.stderr).toContain('LAUNCHPAD_SECRETS_STORE_ID');
  expect(missing.stderr).toContain('LAUNCHPAD_VERCEL_TEAM_ID');
  expect(missing.stderr).toContain('LAUNCHPAD_CONTROLLER_URL');
  expect(missing.stderr).toContain('LAUNCHPAD_OIDC_AUDIENCE');
  expect(existsSync(RENDERED_PATH)).toBe(false);

  const singleMissing = run(renderScript, ['--env', 'production', '--output', RENDERED_OUTPUT], { LAUNCHPAD_VERCEL_TEAM_ID: '' });
  expect(singleMissing.status).not.toBe(0);
  expect(singleMissing.stderr).toContain('LAUNCHPAD_VERCEL_TEAM_ID');
  expect(existsSync(RENDERED_PATH)).toBe(false);
});

it('rejects malformed identifiers and writes nothing', () => {
  const result = run(renderScript, ['--env', 'production', '--output', RENDERED_OUTPUT], {
    LAUNCHPAD_D1_DATABASE_ID: 'not-a-hex-id',
    LAUNCHPAD_SECRETS_STORE_ID: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
    LAUNCHPAD_VERCEL_TEAM_ID: 'team_',
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('LAUNCHPAD_D1_DATABASE_ID');
  expect(result.stderr).toContain('LAUNCHPAD_SECRETS_STORE_ID');
  expect(result.stderr).toContain('LAUNCHPAD_VERCEL_TEAM_ID');
  expect(existsSync(RENDERED_PATH)).toBe(false);
});

it('rejects placeholder values even when they match an identifier shape', () => {
  const result = run(renderScript, ['--env', 'production', '--output', RENDERED_OUTPUT], {
    LAUNCHPAD_D1_DATABASE_ID: 'replace-in-production',
    LAUNCHPAD_SECRETS_STORE_ID: 'replace-in-production',
    LAUNCHPAD_VERCEL_TEAM_ID: 'replace-in-production',
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('placeholder');
  expect(existsSync(RENDERED_PATH)).toBe(false);

  // A slug-shaped placeholder passes the Vercel format regex but must still be rejected.
  const slugPlaceholder = run(renderScript, ['--env', 'production', '--output', RENDERED_OUTPUT], {
    LAUNCHPAD_VERCEL_TEAM_ID: 'replace-in-test',
  });
  expect(slugPlaceholder.status).not.toBe(0);
  expect(slugPlaceholder.stderr).toContain('placeholder');
});

it('never embeds secret values into the rendered config', () => {
  const result = run(renderScript, ['--env', 'production', '--output', RENDERED_OUTPUT], {
    LAUNCHPAD_OPERATOR_TOKEN: 'super-secret-token-value',
  });
  expect(result.status).toBe(0);
  const contents = readFileSync(RENDERED_PATH, 'utf8');
  expect(contents).not.toContain('super-secret-token-value');
  expect(contents).not.toContain('replace-in-production');

  for (const binding of readRendered().env?.production?.secrets_store_secrets ?? []) {
    expect(binding.store_id).toBe(STORE_ID);
    expect(typeof binding.secret_name).toBe('string');
    expect((binding.secret_name ?? '').length).toBeGreaterThan(0);
  }
});

it('rejects invalid CLI usage with exit code 2 and no output', () => {
  const cases: Array<string[]> = [
    [],
    ['--env', 'staging', '--output', RENDERED_OUTPUT],
    ['--env', 'production'],
    ['--output', RENDERED_OUTPUT],
    ['--env', 'production', '--output', '../escape.json'],
    ['--env', 'production', '--output', '/absolute/path.json'],
    ['--env', 'production', '--output', 'wrangler.jsonc'],
    ['--env', 'production', '--output', RENDERED_OUTPUT, '--bogus'],
  ];
  for (const args of cases) {
    const result = run(renderScript, args);
    expect(result.status).toBe(2);
    expect(existsSync(RENDERED_PATH)).toBe(false);
  }
});

it('concrete assertion passes on the rendered config and rejects the placeholder template', () => {
  // The reviewed template must fail concrete mode for production.
  const template = run(assertScript, ['--env', 'production', '--concrete']);
  expect(template.status).not.toBe(0);
  expect(template.stderr).toContain('replace-in-production');

  const render = run(renderScript, ['--env', 'production', '--output', RENDERED_OUTPUT]);
  expect(render.status).toBe(0);

  // Structural plus concrete checks pass for the rendered environment.
  const ok = run(assertScript, ['--env', 'production', '--config', RENDERED_OUTPUT, '--concrete']);
  expect(ok.status).toBe(0);
  expect(ok.stdout).toContain('OK');
  expect(ok.stdout).toContain('concrete');

  // Concrete mode rejects the unrendered test environment inside the same file.
  const otherEnv = run(assertScript, ['--env', 'test', '--config', RENDERED_OUTPUT, '--concrete']);
  expect(otherEnv.status).not.toBe(0);
  expect(otherEnv.stderr).toContain('replace-in-test');

  // A missing config file is an input error, not a pass.
  const missing = run(assertScript, ['--env', 'production', '--config', 'no-such-file.json']);
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toContain('no-such-file.json');
});

it('rejects absent, placeholder, and non-HTTPS resolver URLs before writing', () => {
  const absent = run(renderScript, ['--env', 'production', '--output', RENDERED_OUTPUT], { LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL: '' });
  expect(absent.status).not.toBe(0);
  expect(absent.stderr).toContain('LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL');
  expect(existsSync(RENDERED_PATH)).toBe(false);

  const http = run(renderScript, ['--env', 'production', '--output', RENDERED_OUTPUT], { LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL: 'http://dns-resolver.launchpad.internal/v1/dns' });
  expect(http.status).not.toBe(0);
  expect(http.stderr).toContain('https');
  expect(existsSync(RENDERED_PATH)).toBe(false);

  const placeholder = run(renderScript, ['--env', 'production', '--output', RENDERED_OUTPUT], { LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL: 'https://replace-in-production/v1/dns' });
  expect(placeholder.status).not.toBe(0);
  expect(placeholder.stderr).toContain('placeholder');
  expect(existsSync(RENDERED_PATH)).toBe(false);
});

it('rejects absent or non-HTTPS controller and OIDC audience URLs before writing', () => {
  for (const [name, value] of [
    ['LAUNCHPAD_CONTROLLER_URL', ''],
    ['LAUNCHPAD_CONTROLLER_URL', 'http://launchpad.example.internal'],
    ['LAUNCHPAD_OIDC_AUDIENCE', ''],
    ['LAUNCHPAD_OIDC_AUDIENCE', 'http://launchpad.example.internal'],
  ] as const) {
    const result = run(renderScript, ['--env', 'production', '--output', RENDERED_OUTPUT], { [name]: value });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(name);
    expect(existsSync(RENDERED_PATH)).toBe(false);
  }
});

it('asserts a concrete HTTPS resolver URL in concrete mode and rejects non-HTTPS values', () => {
  // The reviewed template declares the resolver URL as a placeholder var.
  expect(typeof config.env?.production?.vars?.LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL).toBe('string');

  const render = run(renderScript, ['--env', 'production', '--output', RENDERED_OUTPUT]);
  expect(render.status).toBe(0);
  const ok = run(assertScript, ['--env', 'production', '--config', RENDERED_OUTPUT, '--concrete']);
  expect(ok.status).toBe(0);
  expect(ok.stdout).toContain('OK');

  // A rendered config whose resolver URL regressed to http:// must fail concrete mode.
  const rendered = readRendered();
  if (rendered.env?.production?.vars) rendered.env.production.vars.LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL = 'http://dns-resolver.launchpad.internal/v1/dns';
  writeFileSync(RENDERED_PATH, `${JSON.stringify(rendered, null, 2)}\n`);
  const regressed = run(assertScript, ['--env', 'production', '--config', RENDERED_OUTPUT, '--concrete']);
  expect(regressed.status).not.toBe(0);
  expect(regressed.stderr).toContain('https');

  // The non-concrete assertion still passes for the template, which only requires the var to be declared.
  const template = run(assertScript, ['--env', 'production']);
  expect(template.status).toBe(0);
});

it('concrete assertion accepts a rendered test config', () => {
  const render = run(renderScript, ['--env', 'test', '--output', RENDERED_OUTPUT]);
  expect(render.status).toBe(0);
  const ok = run(assertScript, ['--env', 'test', '--config', RENDERED_OUTPUT, '--concrete']);
  expect(ok.status).toBe(0);
  expect(ok.stdout).toContain('OK');
});
