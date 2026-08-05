#!/usr/bin/env node
/**
 * Renders a deploy-ready Wrangler config from the reviewed placeholder
 * template (wrangler.jsonc) plus non-secret deployment identifiers.
 *
 * The template keeps every resource id as a placeholder
 * ("replace-in-environment", "replace-in-production", "replace-in-test") so
 * the reviewed file never commits real identifiers. This script fills only
 * the SELECTED environment's identifiers from environment variables and
 * writes a fresh JSON config at the repository root; every other field is
 * preserved verbatim. Wrangler environments do not inherit d1_databases,
 * vars, or secrets_store_secrets, so the substitution is scoped to
 * `env.<selected>` and never touches other environments.
 *
 * Variables (set from the `launchpad-control-plane` GitHub environment
 * `vars.*`, not secrets):
 *   LAUNCHPAD_D1_DATABASE_ID                  D1 database id (32 hex characters)
 *   LAUNCHPAD_SECRETS_STORE_ID                Workers Secrets Store id (32 hex characters)
 *   LAUNCHPAD_VERCEL_TEAM_ID                  Vercel team id ("team_..." id or lowercase slug)
 *   LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL  HTTPS authoritative DNS resolver endpoint
 *
 * Usage:
 *   LAUNCHPAD_D1_DATABASE_ID=... LAUNCHPAD_SECRETS_STORE_ID=... \
 *     LAUNCHPAD_VERCEL_TEAM_ID=... \
 *     LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL=... \
 *     node scripts/render-wrangler-config.mjs --env production --output wrangler.deploy.json
 *
 * The command is deterministic: the same template and variables yield
 * byte-identical output. It exits 1 before writing anything when a variable
 * is missing, malformed, or still a placeholder; usage errors exit 2. The
 * rendered file must stay git-ignored (see .gitignore) and is consumed by
 * `wrangler deploy --env <env> --config <output>` and
 * `scripts/assert-deploy-bindings.mjs --env <env> --config <output> --concrete`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = 'wrangler.jsonc';
const VALID_ENVS = new Set(['production', 'test']);
const PLACEHOLDER_RE = /replace-in-/i;
const HEX_ID_RE = /^[a-fA-F0-9]{32}$/;
const VERCEL_TEAM_ID_RE = /^(?:team_[A-Za-z0-9-]{1,64}|[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/;
const OUTPUT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FORBIDDEN_OUTPUTS = new Set(['wrangler.jsonc', 'wrangler.json']);
const USAGE = 'Usage: node scripts/render-wrangler-config.mjs --env production|test --output <root-relative file name>';

/** Conservative HTTPS endpoint check: absolute, https-only, no embedded credentials. */
function isHttpsUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && parsed.hostname.length > 0 && parsed.username === '' && parsed.password === '';
}

function parseArgs(argv) {
  const options = { env: undefined, output: undefined };
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    const inlineValue = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const key = flag === '--env' ? 'env' : flag === '--output' ? 'output' : undefined;
    if (key === undefined) {
      errors.push(`Unknown option '${arg}'.`);
      continue;
    }
    const value = inlineValue !== undefined ? inlineValue : argv[++i];
    if (value === undefined || value === '') {
      errors.push(`Expected a value for ${flag}.`);
    } else if (options[key] !== undefined) {
      errors.push(`${flag} was given more than once.`);
    } else {
      options[key] = value;
    }
  }
  if (options.env === undefined) errors.push('--env is required.');
  if (options.output === undefined) errors.push('--output is required.');
  return { options, errors };
}

function readIdentifier(name, formatCheck, formatDescription, normalize) {
  const raw = process.env[name];
  const value = raw === undefined ? '' : String(raw).trim();
  if (value === '') {
    return { ok: false, error: `${name} is required but was not set (or was empty).` };
  }
  if (PLACEHOLDER_RE.test(value)) {
    return { ok: false, error: `${name} must not be a placeholder ('${value}').` };
  }
  const valid = typeof formatCheck === 'function' ? formatCheck(value) : formatCheck.test(value);
  if (!valid) {
    return { ok: false, error: `${name} must be ${formatDescription}, got '${value}'.` };
  }
  return { ok: true, value: normalize(value) };
}

const { options, errors } = parseArgs(process.argv.slice(2));
if (errors.length > 0) {
  console.error(errors.join('\n'));
  console.error(USAGE);
  process.exit(2);
}
if (!VALID_ENVS.has(options.env)) {
  console.error(`Expected --env production or --env test, got '${options.env}'.`);
  process.exit(2);
}
if (!OUTPUT_RE.test(options.output)) {
  console.error(`--output must be a root-relative file name at the repository root, got '${options.output}'.`);
  process.exit(2);
}
if (FORBIDDEN_OUTPUTS.has(options.output)) {
  console.error(`--output must not overwrite the reviewed template ('${options.output}').`);
  process.exit(2);
}

const identifiers = [
  readIdentifier('LAUNCHPAD_D1_DATABASE_ID', HEX_ID_RE, 'a 32-hex-character id', (value) => value.toLowerCase()),
  readIdentifier('LAUNCHPAD_SECRETS_STORE_ID', HEX_ID_RE, 'a 32-hex-character id', (value) => value.toLowerCase()),
  readIdentifier('LAUNCHPAD_VERCEL_TEAM_ID', VERCEL_TEAM_ID_RE, 'a "team_..." id or lowercase slug', (value) => value),
  readIdentifier('LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL', isHttpsUrl, 'an absolute, credential-free https:// URL', (value) => value),
];
const failures = identifiers.filter((identifier) => !identifier.ok);
if (failures.length > 0) {
  console.error('Cannot render Wrangler config:');
  for (const { error } of failures) console.error(`  - ${error}`);
  process.exit(1);
}
const [d1Id, storeId, teamId, resolverUrl] = identifiers.map((identifier) => identifier.value);

let template;
try {
  template = JSON.parse(readFileSync(join(root, TEMPLATE), 'utf8'));
} catch (error) {
  console.error(`Cannot read or parse ${TEMPLATE}: ${error.message}`);
  process.exit(1);
}

const environment = template.env?.[options.env];
if (!environment || !Array.isArray(environment.d1_databases) || environment.d1_databases.length === 0) {
  console.error(`${TEMPLATE} must declare a non-empty d1_databases list for '${options.env}'.`);
  process.exit(1);
}
if (!Array.isArray(environment.secrets_store_secrets) || environment.secrets_store_secrets.length === 0) {
  console.error(`${TEMPLATE} must declare secrets_store_secrets for '${options.env}'.`);
  process.exit(1);
}
if (typeof environment.vars?.VERCEL_TEAM_ID !== 'string') {
  console.error(`${TEMPLATE} must declare vars.VERCEL_TEAM_ID for '${options.env}'.`);
  process.exit(1);
}
if (typeof environment.vars?.LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL !== 'string') {
  console.error(`${TEMPLATE} must declare vars.LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL for '${options.env}'.`);
  process.exit(1);
}

const rendered = JSON.parse(JSON.stringify(template));
const selected = rendered.env[options.env];
for (const database of selected.d1_databases) database.database_id = d1Id;
for (const binding of selected.secrets_store_secrets) binding.store_id = storeId;
selected.vars.VERCEL_TEAM_ID = teamId;
selected.vars.LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL = resolverUrl;

const outputPath = join(root, options.output);
try {
  writeFileSync(outputPath, `${JSON.stringify(rendered, null, 2)}\n`);
} catch (error) {
  console.error(`Cannot write ${outputPath}: ${error.message}`);
  process.exit(1);
}
console.log(
  `Rendered ${options.output} for environment '${options.env}': ${selected.d1_databases.length} D1 database id, ${selected.secrets_store_secrets.length} secrets store ids, VERCEL_TEAM_ID, and LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL substituted; all other fields preserved.`
);
