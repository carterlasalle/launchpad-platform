import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('keeps required documentation present, linked, and reachable', () => {
  const result = spawnSync(process.execPath, [join(process.cwd(), 'scripts/check-docs.mjs')], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/Documentation verified:/);
});
