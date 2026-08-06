import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const script = join(root, 'scripts/apply-ruleset.mjs');

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
}

describe('repository ruleset application', () => {
  it('renders an API-compatible payload without repository-only metadata', () => {
    const result = run(['--dry-run']);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('$comment');
    expect(payload).not.toHaveProperty('repository');
    expect(payload).toMatchObject({ name: 'launchpad-main', target: 'branch', enforcement: 'active', bypass_actors: [] });

    const rules = payload.rules as Array<{ type: string; parameters?: Record<string, unknown> }>;
    expect(rules.find((rule) => rule.type === 'creation')).toEqual({ type: 'creation' });
    // The spec documents the review policy on the rule; the API payload must
    // never carry repository-only metadata (including the $comment).
    expect(rules.find((rule) => rule.type === 'pull_request')).not.toHaveProperty('$comment');
    // Full pull_request contract: SOLO-OWNER MODE is the explicit, tested policy
    // (required_approving_review_count=0, require_code_owner_review=false,
    // require_last_push_approval=false) because the control repository has a
    // single maintainer; the $comment in main.json documents the compensating
    // controls (no bypass actors, direct-push bans, stale-review dismissal,
    // thread resolution, strict required checks, squash-only). Any drift in
    // either direction fails CI.
    expect(rules.find((rule) => rule.type === 'pull_request')?.parameters).toEqual({
      required_approving_review_count: 0,
      dismiss_stale_reviews_on_push: true,
      require_code_owner_review: false,
      require_last_push_approval: false,
      required_review_thread_resolution: true,
      allowed_merge_methods: ['squash'],
    });
    expect(rules.find((rule) => rule.type === 'required_status_checks')?.parameters).toEqual({
      strict_required_status_checks_policy: true,
      required_status_checks: [
        { context: 'static / toolchain' },
        { context: 'static / quality' },
        { context: 'acceptance / offline' },
        { context: 'platform / summary' },
        { context: 'dependency / review' },
      ],
    });
  });

  it('fails closed before network access when mutation credentials are missing', () => {
    const result = run([], { GITHUB_TOKEN: '', LAUNCHPAD_RULESET_TOKEN: '', GITHUB_REPOSITORY: '' });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('LAUNCHPAD_RULESET_TOKEN');
    expect(result.stderr).toContain('GITHUB_REPOSITORY');
  });
});
