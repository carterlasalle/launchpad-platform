#!/usr/bin/env node
/**
 * Creates or updates the control repository's main-branch ruleset from the
 * reviewed desired state in .github/rulesets/main.json. Repository merge
 * settings are reconciled in the same run. No provider credentials or live
 * identifiers are written to disk.
 *
 * Environment:
 *   LAUNCHPAD_RULESET_TOKEN  fine-grained PAT with Administration: read/write
 *   GITHUB_TOKEN             fallback token
 *   GITHUB_REPOSITORY        owner/repository
 *   GITHUB_API_URL           optional API base (default: api.github.com)
 *
 * Usage:
 *   node scripts/apply-ruleset.mjs [--spec .github/rulesets/main.json]
 *   node scripts/apply-ruleset.mjs --dry-run
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let specPath = '.github/rulesets/main.json';
let dryRun = false;
const usageErrors = [];

for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === '--dry-run') {
    dryRun = true;
  } else if (argument === '--spec') {
    const value = args[++index];
    if (!value) usageErrors.push('--spec requires a path.');
    else specPath = value;
  } else {
    usageErrors.push(`Unknown option '${argument}'.`);
  }
}

if (usageErrors.length > 0) {
  console.error(usageErrors.join('\n'));
  console.error('Usage: node scripts/apply-ruleset.mjs [--spec <path>] [--dry-run]');
  process.exit(2);
}

let spec;
try {
  spec = JSON.parse(readFileSync(resolve(root, specPath), 'utf8'));
} catch (error) {
  console.error(`Cannot read ruleset spec '${specPath}': ${error.message}`);
  process.exit(1);
}

function configurationError(message) {
  console.error(`Ruleset configuration is invalid: ${message}`);
  process.exit(1);
}

if (!spec || typeof spec !== 'object' || Array.isArray(spec)) configurationError('the root must be an object.');
if (typeof spec.name !== 'string' || spec.name.length === 0) configurationError('name is required.');
if (spec.target !== 'branch') configurationError("target must be 'branch'.");
if (!['active', 'evaluate', 'disabled'].includes(spec.enforcement)) configurationError('enforcement is invalid.');
if (!Array.isArray(spec.bypass_actors) || !Array.isArray(spec.rules)) configurationError('bypass_actors and rules must be arrays.');
if (!spec.conditions || typeof spec.conditions !== 'object') configurationError('conditions are required.');

const payload = {
  name: spec.name,
  target: spec.target,
  enforcement: spec.enforcement,
  bypass_actors: spec.bypass_actors,
  conditions: spec.conditions,
  rules: spec.rules.map((rule) => rule.parameters === undefined ? { type: rule.type } : { type: rule.type, parameters: rule.parameters }),
};

if (dryRun) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const token = process.env.LAUNCHPAD_RULESET_TOKEN || process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const missing = [];
if (!token) missing.push('LAUNCHPAD_RULESET_TOKEN (or GITHUB_TOKEN) with Administration: read/write');
if (!repository) missing.push('GITHUB_REPOSITORY in owner/repository form');
if (missing.length > 0) {
  console.error(`Ruleset application unavailable: set ${missing.join(' and ')}.`);
  process.exit(2);
}
if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
  console.error(`Ruleset application unavailable: GITHUB_REPOSITORY must use owner/repository form, got '${repository}'.`);
  process.exit(2);
}

const apiBase = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');

async function api(method, path, body) {
  let response;
  try {
    response = await fetch(`${apiBase}/repos/${repository}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    console.error(`Ruleset application unavailable: ${method} ${path} could not reach GitHub (${error.message}).`);
    process.exit(2);
  }

  const text = await response.text();
  if (!response.ok) {
    const classification = response.status === 422 ? 'rejected' : 'unavailable';
    console.error(`Ruleset application ${classification}: ${method} ${path} -> ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 1000)}` : ''}`);
    process.exit(response.status === 422 ? 1 : 2);
  }
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    console.error(`Ruleset application unavailable: ${method} ${path} returned non-JSON.`);
    process.exit(2);
  }
}

const listed = await api('GET', '/rulesets?per_page=100');
if (!Array.isArray(listed)) {
  console.error('Ruleset application unavailable: GitHub returned a non-array ruleset list.');
  process.exit(2);
}
const matching = listed.filter((entry) => entry?.name === spec.name);
if (matching.length > 1) configurationError(`multiple rulesets named '${spec.name}' exist; remove the duplicate before applying.`);
if (matching[0] && matching[0].target !== spec.target) configurationError(`ruleset '${spec.name}' targets '${matching[0].target}', expected '${spec.target}'.`);

if (matching[0]) await api('PUT', `/rulesets/${matching[0].id}`, payload);
else await api('POST', '/rulesets', payload);

const repositorySettings = spec.repository ?? {};
await api('PATCH', '', {
  ...(typeof repositorySettings.default_branch === 'string' ? { default_branch: repositorySettings.default_branch } : {}),
  ...(repositorySettings.squash_merge_only === true
    ? { allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false }
    : {}),
});

console.log(`${matching[0] ? 'Updated' : 'Created'} ruleset '${spec.name}' on ${repository}; repository merge settings reconciled. Run scripts/verify-ruleset.mjs to verify the live result.`);
