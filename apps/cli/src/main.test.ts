import { expect, it } from 'vitest';
import { parseCliArgs, formatIssues } from './index.js';

it('parses commands and flags without accepting unknown options', () => {
  expect(parseCliArgs(['plan', '--catalog', 'catalog', '--format', 'json'])).toEqual({ command: 'plan', flags: { catalog: 'catalog', format: 'json' } });
  expect(() => parseCliArgs(['validate', '--unknown', 'value'])).toThrow(/unknown/i);
});

it('formats validation issues with source location and remediation', () => {
  const output = formatIssues([{ code: 'LP-SCHEMA-INVALID', file: 'catalog/apps/app.yaml', line: 4, column: 3, path: 'metadata.id', message: 'bad id', remediation: 'Use a stable id.' }]);
  expect(output).toContain('catalog/apps/app.yaml:4:3');
  expect(output).toContain('Use a stable id.');
});
