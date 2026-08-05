/**
 * Focused script tests for the acceptance-runner evidence contract
 * (scripts/acceptance-offline.mjs + scripts/acceptance-evidence.mjs).
 *
 * These prove the report gate's provenance rules without running the
 * acceptance suite:
 *   - exact pinned Node/Yarn and the exact source commit pass;
 *   - wrong Node, wrong Yarn, missing commit, malformed commit, and stale
 *     commit all fail;
 *   - repoRoot and generatedAt are never treated as commit evidence;
 *   - GITHUB_SHA wins over git HEAD, and a report from another commit fails.
 *
 * Run: yarn vitest run tests/unit/acceptance-offline.test.ts
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReport } from '../../scripts/acceptance-offline.mjs';
import { readToolchainPins, resolveSourceCommit } from '../../scripts/acceptance-evidence.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pins = readToolchainPins(root);
/** Deterministic expected commit, immune to any GITHUB_SHA in the test env. */
const HEAD = resolveSourceCommit(root, {});
/** A different, still well-formed 40-hex commit ("stale" evidence). */
const OTHER_SHA = HEAD === 'a'.repeat(40) ? 'b'.repeat(40) : 'a'.repeat(40);

function validReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'launchpad.acceptance/v1',
    mode: 'offline',
    generatedAt: '2026-08-04T00:00:00.000Z',
    matrix: [
      {
        id: 'CAT-VALID',
        sections: ['33'],
        checklist: ['Safety'],
        description: 'valid manifest',
        status: 'passed',
        durationMs: 1,
        observed: 'ok',
        resourceIds: {},
        evidence: [],
      },
    ],
    summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
    environment: { node: pins.node, yarn: pins.yarn, commit: HEAD, repoRoot: '/unrelated/path', offline: true },
    ...overrides,
  };
}

describe('acceptance report metadata gate (validateReport)', () => {
  it('passes exact pinned Node/Yarn and the exact source commit', () => {
    expect(validateReport(validReport(), { root, env: {} })).toEqual([]);
  });

  it('rejects a report from a wrong Node version', () => {
    const failures = validateReport(
      validReport({ environment: { node: '26.18.0', yarn: pins.yarn, commit: HEAD } }),
      { root, env: {} },
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('environment.node');
    expect(failures[0]).toContain(`does not match the repository pin ${pins.node}`);
  });

  it('rejects a report whose node format deviates from the pin (leading v)', () => {
    const failures = validateReport(
      validReport({ environment: { node: `v${pins.node}`, yarn: pins.yarn, commit: HEAD } }),
      { root, env: {} },
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('environment.node');
  });

  it('rejects a report from a wrong Yarn version', () => {
    const failures = validateReport(
      validReport({ environment: { node: pins.node, yarn: '4.9.0', commit: HEAD } }),
      { root, env: {} },
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('environment.yarn');
    expect(failures[0]).toContain(`does not match the repository pin ${pins.yarn}`);
  });

  it('rejects a report with no node or yarn metadata', () => {
    const failures = validateReport(
      validReport({ environment: { node: pins.node, commit: HEAD } }),
      { root, env: {} },
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('missing environment.yarn');
  });

  it('rejects a report with no commit metadata', () => {
    const failures = validateReport(
      validReport({ environment: { node: pins.node, yarn: pins.yarn } }),
      { root, env: {} },
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('missing environment.commit');
  });

  it('rejects an empty commit as malformed, not as evidence', () => {
    const failures = validateReport(
      validReport({ environment: { node: pins.node, yarn: pins.yarn, commit: '' } }),
      { root, env: {} },
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('missing environment.commit');
  });

  it('rejects a malformed commit (truncated sha)', () => {
    const failures = validateReport(
      validReport({ environment: { node: pins.node, yarn: pins.yarn, commit: HEAD.slice(0, 7) } }),
      { root, env: {} },
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('not exactly 40 lowercase hex characters');
  });

  it('rejects a malformed commit (uppercase hex)', () => {
    const failures = validateReport(
      validReport({ environment: { node: pins.node, yarn: pins.yarn, commit: HEAD.toUpperCase() } }),
      { root, env: {} },
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('not exactly 40 lowercase hex characters');
  });

  it('rejects a stale commit (valid sha that is not the source commit)', () => {
    const failures = validateReport(
      validReport({ environment: { node: pins.node, yarn: pins.yarn, commit: OTHER_SHA } }),
      { root, env: {} },
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('environment.commit');
    expect(failures[0]).toContain(`does not match the source commit '${HEAD}'`);
  });

  it('accepts GITHUB_SHA as the source commit even when HEAD differs', () => {
    expect(
      validateReport(
        validReport({ environment: { node: pins.node, yarn: pins.yarn, commit: OTHER_SHA } }),
        { root, env: { GITHUB_SHA: OTHER_SHA } },
      ),
    ).toEqual([]);
  });

  it('rejects a report from another commit when GITHUB_SHA pins a different one', () => {
    const failures = validateReport(validReport(), { root, env: { GITHUB_SHA: OTHER_SHA } });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`does not match the source commit '${OTHER_SHA}'`);
  });

  it('never treats repoRoot or generatedAt as commit evidence', () => {
    const failures = validateReport(
      validReport({
        environment: { node: pins.node, yarn: pins.yarn, commit: HEAD, repoRoot: '/tmp/elsewhere', offline: true },
        generatedAt: '1999-01-01T00:00:00.000Z',
      }),
      { root, env: {} },
    );
    expect(failures).toEqual([]);
  });

  it('fails closed when the whole environment block is absent', () => {
    const failures = validateReport(validReport({ environment: undefined }), { root, env: {} });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('missing environment metadata');
  });
});

describe('resolveSourceCommit', () => {
  it('uses GITHUB_SHA verbatim when present', () => {
    expect(resolveSourceCommit(root, { GITHUB_SHA: OTHER_SHA })).toBe(OTHER_SHA);
  });

  it('falls back to the current git HEAD when GITHUB_SHA is absent', () => {
    expect(resolveSourceCommit(root, {})).toBe(HEAD);
    expect(resolveSourceCommit(root, { GITHUB_SHA: '' })).toBe(HEAD);
  });

  it('fails closed on a non-hex GITHUB_SHA', () => {
    expect(() => resolveSourceCommit(root, { GITHUB_SHA: 'not-a-commit-sha' })).toThrow(/40 lowercase hex/);
    expect(() => resolveSourceCommit(root, { GITHUB_SHA: HEAD.slice(0, 7) })).toThrow(/40 lowercase hex/);
    expect(() => resolveSourceCommit(root, { GITHUB_SHA: HEAD.toUpperCase() })).toThrow(/40 lowercase hex/);
  });
});

describe('readToolchainPins', () => {
  it('agrees with the repository pin files check-toolchain.mjs enforces', () => {
    expect(readFileSync(resolve(root, '.node-version'), 'utf8').trim()).toBe(pins.node);
    expect(readFileSync(resolve(root, '.nvmrc'), 'utf8').trim()).toBe(pins.node);
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    expect(pkg.packageManager).toBe(`yarn@${pins.yarn}`);
  });
});
