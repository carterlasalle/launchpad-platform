#!/usr/bin/env node
/**
 * Asserts that a named Wrangler environment declares the complete Launchpad
 * binding surface. Wrangler environments do NOT inherit d1_databases,
 * workflows, queues, vars, or secrets_store_secrets, so every environment
 * must re-declare them explicitly. Run in CI before `wrangler deploy`:
 *
 *   node scripts/assert-deploy-bindings.mjs --env production
 *   node scripts/assert-deploy-bindings.mjs --env test
 *
 * Pass `--config <path>` to assert against a rendered config instead of the
 * placeholder template (wrangler.jsonc). Pass `--concrete` to additionally
 * reject every remaining `replace-in-*` placeholder in the selected
 * environment and to require conservative identifier formats for the D1
 * database id, every secrets-store id, and VERCEL_TEAM_ID:
 *
 *   node scripts/assert-deploy-bindings.mjs --env production --config wrangler.deploy.json --concrete
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let envName;
let configPath = 'wrangler.jsonc';
let concrete = false;
const usage = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
  const flag = eq >= 0 ? arg.slice(0, eq) : arg;
  const inlineValue = eq >= 0 ? arg.slice(eq + 1) : undefined;
  if (flag === '--env' || flag === '--config') {
    const value = inlineValue !== undefined ? inlineValue : args[++i];
    if (value === undefined || value === '') {
      usage.push(`Expected a value for ${flag}.`);
    } else if (flag === '--env') {
      if (envName !== undefined) usage.push('--env was given more than once.');
      else envName = value;
    } else {
      if (configPath !== 'wrangler.jsonc') usage.push('--config was given more than once.');
      else configPath = value;
    }
  } else if (flag === '--concrete') {
    if (inlineValue !== undefined) usage.push('--concrete takes no value.');
    concrete = true;
  } else {
    usage.push(`Unknown option '${arg}'.`);
  }
}
if (usage.length > 0) {
  console.error(usage.join('\n'));
  console.error('Usage: node scripts/assert-deploy-bindings.mjs --env production|test [--config <path>] [--concrete]');
  process.exit(2);
}
if (envName !== 'production' && envName !== 'test') {
  console.error(`Expected --env production or --env test, got '${String(envName)}'.`);
  process.exit(2);
}

let config;
try {
  config = JSON.parse(readFileSync(join(root, configPath), 'utf8'));
} catch (error) {
  console.error(`Cannot read config '${configPath}': ${error.message}`);
  process.exit(2);
}
const environment = config.env?.[envName];
if (!environment) {
  console.error(`Missing environment '${envName}' in ${configPath}.`);
  process.exit(2);
}

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const has = (list, predicate) => Array.isArray(list) && list.some(predicate);

// Static dashboard assets (inherited by named environments)
check(config.assets?.binding === 'ASSETS' && config.assets?.directory === './apps/dashboard/dist' && config.assets?.run_worker_first === true, `[${envName}] assets must expose apps/dashboard/dist through the ASSETS binding with the controller running first.`);

// D1 (non-inherited)
check(has(environment.d1_databases, (binding) => binding.binding === 'DB' && typeof binding.database_id === 'string' && binding.database_id.length > 0), `[${envName}] d1_databases must declare the DB binding.`);

// Workflows (non-inherited)
for (const [binding, name, className] of [
  ['APPLY_WORKFLOW', 'apply-application', 'ApplyApplicationWorkflow'],
  ['PREVIEW_WORKFLOW', 'preview-application', 'PreviewApplicationWorkflow'],
  ['APP_PREVIEW_STATUS_WORKFLOW', 'app-preview-status-application', 'AppPreviewStatusWorkflow'],
  ['RECONCILE_WORKFLOW', 'reconcile-application', 'ReconcileApplicationWorkflow'],
  ['DECOMMISSION_WORKFLOW', 'decommission-application', 'DecommissionApplicationWorkflow'],
]) {
  check(has(environment.workflows, (workflow) => workflow.binding === binding && workflow.name === name && workflow.class_name === className), `[${envName}] workflows must declare ${binding} (${name} / ${className}).`);
}

// Queues: producers, consumers, and dead-letter routing (non-inherited)
check(has(environment.queues?.producers, (producer) => producer.binding === 'PROVIDER_EVENTS' && producer.queue === 'launchpad-provider-events'), `[${envName}] queues.producers must declare PROVIDER_EVENTS -> launchpad-provider-events.`);
check(has(environment.queues?.producers, (producer) => producer.binding === 'HEALTH_CHECKS' && producer.queue === 'launchpad-health-checks'), `[${envName}] queues.producers must declare HEALTH_CHECKS -> launchpad-health-checks.`);
check(has(environment.queues?.consumers, (consumer) => consumer.queue === 'launchpad-provider-events' && consumer.dead_letter_queue === 'launchpad-dead-letter' && Number.isInteger(consumer.max_retries) && consumer.max_retries >= 1), `[${envName}] queues.consumers must route launchpad-provider-events to the dead-letter queue with retries.`);
check(has(environment.queues?.consumers, (consumer) => consumer.queue === 'launchpad-health-checks' && consumer.dead_letter_queue === 'launchpad-dead-letter' && Number.isInteger(consumer.max_retries) && consumer.max_retries >= 1), `[${envName}] queues.consumers must route launchpad-health-checks to the dead-letter queue with retries.`);
check(has(environment.queues?.consumers, (consumer) => consumer.queue === 'launchpad-dead-letter' && Number.isInteger(consumer.max_retries) && consumer.max_retries >= 1), `[${envName}] queues.consumers must consume the dead-letter queue with retries so incident records are never silently dropped.`);
if (envName === 'production') check(has(environment.routes, (route) => route.pattern === 'launchpad.carterlasalle.com' && route.custom_domain === true), `[${envName}] routes must attach the Worker to launchpad.carterlasalle.com as a custom domain.`);

// Vars (non-inherited)
const vars = environment.vars ?? {};
for (const name of ['LAUNCHPAD_ENV', 'LAUNCHPAD_CONTROL_PLANE_ENABLED', 'CONTROLLER_INTERNAL_URL', 'CONTROL_REPOSITORY', 'CONTROL_CATALOG_ROOT', 'RECONCILIATION_SHARD_COUNT', 'PROVIDER_EVENT_FANOUT_LIMIT', 'PROVIDER_EVENT_SHARD_COUNT', 'VERCEL_TEAM_ID', 'LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL', 'OIDC_ISSUER', 'OIDC_AUDIENCE', 'OIDC_JWKS']) {
  check(typeof vars[name] === 'string' && vars[name].length > 0, `[${envName}] vars must declare ${name}.`);
}

// Typed secret bindings (non-inherited), never smuggled into vars
for (const name of ['OPERATOR_TOKEN', 'CONTROLLER_INTERNAL_TOKEN', 'VERCEL_TOKEN', 'CLOUDFLARE_TOKEN', 'GITHUB_TOKEN', 'VERCEL_WEBHOOK_SECRET']) {
  check(has(environment.secrets_store_secrets, (binding) => binding.binding === `SECRETS_${name}` && typeof binding.store_id === 'string' && binding.store_id.length > 0 && typeof binding.secret_name === 'string' && binding.secret_name.length > 0), `[${envName}] secrets_store_secrets must declare SECRETS_${name}.`);
  check(!(name in vars), `[${envName}] secret '${name}' must not be declared as a var.`);
}

// Cron triggers for scheduled reconciliation
check(Array.isArray(environment.triggers?.crons) && environment.triggers.crons.includes('*/30 * * * *'), `[${envName}] triggers must declare the */30 * * * * reconciliation cron.`);

// Concrete-values mode: the selected environment must be placeholder-free and
// every substituted identifier must match its conservative format. This is
// what makes a rendered config (scripts/render-wrangler-config.mjs) safe to
// deploy and the raw template unsafe.
if (concrete) {
  const placeholder = /replace-in-/i;
  const resourceId = /^(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})$/;
  const teamId = /^(?:team_[A-Za-z0-9-]{1,64}|[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/;

  const walk = (value, path) => {
    if (typeof value === 'string') {
      if (placeholder.test(value)) {
        check(false, `[${envName}] ${path} is still a placeholder ('${value}'); deploy would ship it.`);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) walk(value[key], `${path}.${key}`);
    }
  };
  walk(environment, `env.${envName}`);

  for (const database of environment.d1_databases ?? []) {
    if (!placeholder.test(database.database_id)) {
      check(resourceId.test(database.database_id), `[${envName}] d1_databases ${database.binding} database_id must be a 32-hex-character or UUID id, got '${database.database_id}'.`);
    }
  }
  for (const binding of environment.secrets_store_secrets ?? []) {
    if (!placeholder.test(binding.store_id)) {
    check(resourceId.test(binding.store_id), `[${envName}] secrets_store_secrets ${binding.binding} store_id must be a 32-hex-character or UUID id, got '${binding.store_id}'.`);
    }
  }
  if (!placeholder.test(vars.VERCEL_TEAM_ID)) {
    check(teamId.test(vars.VERCEL_TEAM_ID), `[${envName}] vars.VERCEL_TEAM_ID must be a 'team_...' id or lowercase slug, got '${vars.VERCEL_TEAM_ID}'.`);
  }
  check(vars.LAUNCHPAD_CONTROL_PLANE_ENABLED === 'true' || vars.LAUNCHPAD_CONTROL_PLANE_ENABLED === 'false', `[${envName}] vars.LAUNCHPAD_CONTROL_PLANE_ENABLED must be exactly 'true' or 'false', got '${String(vars.LAUNCHPAD_CONTROL_PLANE_ENABLED)}'.`);
  if (typeof vars.LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL === 'string' && !placeholder.test(vars.LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL)) {
    let httpsUrl = false;
    try {
      const parsed = new URL(vars.LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL);
      httpsUrl = parsed.protocol === 'https:' && parsed.hostname.length > 0 && parsed.username === '' && parsed.password === '';
    } catch {
      httpsUrl = false;
    }
    check(httpsUrl, `[${envName}] vars.LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL must be an absolute, credential-free https:// URL, got '${vars.LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL}'.`);
  }
  for (const name of ['CONTROLLER_INTERNAL_URL', 'OIDC_AUDIENCE']) {
    const value = vars[name];
    if (typeof value === 'string' && !placeholder.test(value)) {
      let httpsUrl = false;
      try {
        const parsed = new URL(value);
        httpsUrl = parsed.protocol === 'https:' && parsed.hostname.length > 0 && parsed.username === '' && parsed.password === '';
      } catch {
        httpsUrl = false;
      }
      check(httpsUrl, `[${envName}] vars.${name} must be an absolute, credential-free https:// URL, got '${value}'.`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`OK: ${configPath} '${envName}' declares the full non-inherited binding surface${concrete ? ' with concrete, placeholder-free identifiers' : ''}.`);
