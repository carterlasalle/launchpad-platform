import { expect, it } from 'vitest';
import { canonicalJson } from '@launchpad/shared';

it('resolves workspace package exports during tests', () => {
  expect(canonicalJson({ launchpad: true })).toBe('{"launchpad":true}');
});
