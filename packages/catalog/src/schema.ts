import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import schema from '../../../schema/app.schema.json' with { type: 'json' };
import type { CatalogIssue } from './source.js';

const validator: ValidateFunction = (() => {
  const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
  addFormats(ajv);
  return ajv.compile(schema);
})();

function issuePath(error: ErrorObject): string {
  const base = error.instancePath.replace(/^\//, '').replaceAll('/', '.');
  if (error.keyword === 'additionalProperties' && typeof error.params.additionalProperty === 'string') {
    return base ? `${base}.${error.params.additionalProperty}` : error.params.additionalProperty;
  }
  return base || '$';
}

export function validateDocument(value: unknown, file: string, lineForPath: (path: string) => { line: number; column: number }): CatalogIssue[] {
  if (validator(value)) return [];
  return (validator.errors ?? []).map((error) => {
    const path = issuePath(error);
    const position = lineForPath(path);
    return {
      code: error.keyword === 'additionalProperties' ? 'LP-SCHEMA-UNKNOWN-FIELD' : 'LP-SCHEMA-INVALID',
      file,
      line: position.line,
      column: position.column,
      path,
      message: error.message ?? 'Schema validation failed',
      remediation: error.keyword === 'additionalProperties' ? 'Remove the unknown field or update the versioned schema.' : 'Update the manifest to match launchpad.dev/v1.',
    };
  });
}
