#!/usr/bin/env node
/**
 * Verifies the ACTIVE GitHub ruleset protecting `main` against the
 * machine-readable spec in .github/rulesets/main.json (ADR-0001).
 *
 * Fail-closed contract:
 *   exit 0  verified: the named ruleset exists, is active, covers
 *          refs/heads/main, has no bypass actors, contains every required
 *          rule with matching parameters, requires exactly the expected
 *          status check contexts, and repository settings match the spec.
 *   exit 1  mismatch: any of the above differs, or an extra active ruleset
 *          also targets main (shadow-ruleset drift hazard).
 *   exit 2  unavailable: missing token/repository, API/auth/network failure.
 *
 * Production releases treat both exit 1 and exit 2 as failure (fail closed
 * when the active ruleset cannot be proven).
 *
 * Environment:
 *   LAUNCHPAD_RULESET_TOKEN  fine-grained PAT, Administration: read on the
 *                            control repository. Overrides GITHUB_TOKEN.
 *   GITHUB_TOKEN             fallback (CI default token cannot read rulesets;
 *                            the deploy gate passes LAUNCHPAD_RULESET_TOKEN).
 *   GITHUB_REPOSITORY        owner/repo, e.g. CarterLaSalle/launchpad.
 *   GITHUB_API_URL           optional API base override (default api.github.com).
 *
 * Usage: node scripts/verify-ruleset.mjs [--spec .github/rulesets/main.json]
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const specFlag = process.argv.indexOf('--spec');
const specPath = specFlag >= 0 ? process.argv[specFlag + 1] : '.github/rulesets/main.json';
const spec = JSON.parse(readFileSync(resolve(root, specPath), 'utf8'));

const token = process.env.LAUNCHPAD_RULESET_TOKEN || process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const apiBase = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');

function exitUnavailable(message) {
  console.error(`Ruleset verification UNAVAILABLE: ${message}`);
  console.error('Treating as failure (fail closed): production release must not proceed without proof of the active ruleset.');
  process.exit(2);
}

if (!token) exitUnavailable('set GITHUB_TOKEN or LAUNCHPAD_RULESET_TOKEN (fine-grained, Administration: read on the control repository)');
if (!repository) exitUnavailable('GITHUB_REPOSITORY (owner/repo) is required');

async function api(path) {
  const response = await fetch(`${apiBase}/repos/${repository}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  });
  if (!response.ok) throw new Error(`GET ${path} -> ${response.status} ${response.statusText}`);
  return response.json();
}

const problems = [];
try {
  const rulesets = await api('/rulesets?per_page=100');
  const live = rulesets.find((entry) => entry.name === spec.name && entry.target === 'branch' && entry.enforcement === 'active');

  if (!live) {
    problems.push(`No active branch ruleset named '${spec.name}' was found (${rulesets.length} ruleset(s) returned).`);
  } else {
    // Extra active rulesets gating main are a shadow-ruleset drift hazard.
    const extra = rulesets.filter(
      (entry) => entry.name !== spec.name && entry.enforcement === 'active'
        && (entry.conditions?.ref_name?.include ?? []).includes('refs/heads/main'),
    );
    if (extra.length > 0) {
      problems.push(`Extra active ruleset(s) also target main and are not declared in the spec: ${extra.map((entry) => entry.name).join(', ')}.`);
    }

    const detail = await api(`/rulesets/${live.id}`);

    if (detail.enforcement !== spec.enforcement) {
      problems.push(`enforcement is '${detail.enforcement}', spec requires '${spec.enforcement}'`);
    }
    const liveBypass = detail.bypass_actors ?? [];
    const expectedBypass = spec.bypass_actors ?? [];
    if (liveBypass.length !== expectedBypass.length) {
      problems.push(`bypass_actors: live has ${liveBypass.length} (${liveBypass.map((actor) => actor.actor_type ?? actor.actor_id).join(', ') || 'none'}), spec requires ${expectedBypass.length} (no normal bypass)`);
    }
    const liveIncludes = detail.conditions?.ref_name?.include ?? [];
    for (const ref of spec.conditions?.ref_name?.include ?? []) {
      if (!liveIncludes.includes(ref)) problems.push(`ruleset conditions do not include '${ref}' (live: ${liveIncludes.join(', ') || 'none'})`);
    }

    for (const rule of spec.rules ?? []) {
      const found = (detail.rules ?? []).find((candidate) => candidate.type === rule.type);
      if (!found) {
        problems.push(`Missing rule '${rule.type}'`);
        continue;
      }
      if (rule.type === 'required_status_checks') {
        const expectedContexts = (rule.parameters?.required_status_checks ?? []).map((check) => check.context).sort();
        const liveContexts = (found.parameters?.required_status_checks ?? []).map((check) => check.context).sort();
        if (JSON.stringify(expectedContexts) !== JSON.stringify(liveContexts)) {
          problems.push(`required_status_checks contexts differ: spec [${expectedContexts.join(', ')}], live [${liveContexts.join(', ')}]`);
        }
        if (Boolean(found.parameters?.strict_required_status_checks_policy) !== Boolean(rule.parameters?.strict_required_status_checks_policy)) {
          problems.push(`required_status_checks strict policy: live=${found.parameters?.strict_required_status_checks_policy}, spec=${rule.parameters?.strict_required_status_checks_policy}`);
        }
      } else if (JSON.stringify(found.parameters ?? null) !== JSON.stringify(rule.parameters ?? null)) {
        problems.push(`Rule '${rule.type}' parameters differ: spec ${JSON.stringify(rule.parameters ?? null)}, live ${JSON.stringify(found.parameters ?? null)}`);
      }
    }

    if (spec.repository) {
      const repo = await api('');
      const expected = spec.repository;
      if (repo.default_branch !== expected.default_branch) {
        problems.push(`default_branch is '${repo.default_branch}', spec requires '${expected.default_branch}'`);
      }
      if (expected.squash_merge_only === true) {
        if (repo.allow_squash_merge !== true) problems.push('squash merge is not enabled');
        if (repo.allow_merge_commit !== false) problems.push('merge commits are allowed; spec requires squash-merge-only');
        if (repo.allow_rebase_merge !== false) problems.push('rebase merges are allowed; spec requires squash-merge-only');
      }
    }
  }
} catch (error) {
  exitUnavailable(`${error.message}`);
}

if (problems.length > 0) {
  console.error(`Ruleset verification FAILED for ${repository} (spec: ${specPath}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`Ruleset verified: '${spec.name}' is active on ${repository}, enforcement=${spec.enforcement}, ${(spec.rules ?? []).length} required rule(s), ${(spec.bypass_actors ?? []).length} bypass actors, required checks: ${(spec.rules ?? []).filter((rule) => rule.type === 'required_status_checks')[0]?.parameters?.required_status_checks?.map((check) => check.context).join(', ') ?? 'none'}.`);
