import { LineCounter, isAlias, isNode, isPair, parseAllDocuments, type Node } from 'yaml';
import type { CatalogIssue } from './source.js';

/** File name of the zone registry inside the catalog root (catalog/zones.yaml). */
export const ZONE_REGISTRY_FILE = 'zones.yaml';
/** API version every zone registry must declare. */
export const ZONE_REGISTRY_API_VERSION = 'launchpad.dev/v1';

export interface ZoneRegistryResult {
  zones: string[];
  issues: CatalogIssue[];
}

interface Construct { kind: 'alias' | 'tag'; node: Node }

function collectConstructs(node: Node | null, out: Construct[]): void {
  if (!node) return;
  if (isAlias(node)) {
    out.push({ kind: 'alias', node });
    return;
  }
  if (typeof node.tag === 'string' && !node.tag.startsWith('tag:yaml.org,2002:')) out.push({ kind: 'tag', node });
  if (isPair(node)) {
    collectConstructs(node.key as Node | null, out);
    collectConstructs(node.value as Node | null, out);
    return;
  }
  if ('items' in node) {
    for (const item of node.items) {
      if (isPair(item)) {
        collectConstructs(item.key as Node | null, out);
        collectConstructs(item.value as Node | null, out);
      } else if (isNode(item)) {
        collectConstructs(item, out);
      }
    }
  }
}

/**
 * Parses the catalog zone registry (catalog/zones.yaml) deterministically.
 * Fails closed: any syntax, shape, version, or duplicate problem returns a
 * single issue carrying the registry path and exact source position, and no
 * usable zone set. Zone names are returned sorted so validation output is
 * stable regardless of the order they are declared in.
 */
export function parseZoneRegistry(content: string, path: string): ZoneRegistryResult {
  const counter = new LineCounter();
  const documents = parseAllDocuments(content, { uniqueKeys: true, lineCounter: counter });

  const fail = (issuePath: string, code: string, message: string, remediation: string, position: { line: number; column: number }): ZoneRegistryResult => {
    const issue: CatalogIssue = { code, file: path, line: position.line, column: position.column, path: issuePath, message, remediation };
    return { zones: [], issues: [issue] };
  };

  if (documents.length > 1) {
    const second = documents[1];
    const offset = second?.range?.[0] ?? second?.contents?.range?.[0] ?? 0;
    const position = counter.linePos(offset);
    return fail('$', 'LP-ZONE-REGISTRY-YAML', `Zone registry contains ${documents.length} YAML documents; exactly one is allowed.`, 'Remove the document separator.', { line: position.line, column: position.col });
  }
  const document = documents[0];
  if (!document || document.contents === null) {
    return fail('$', 'LP-ZONE-REGISTRY-SHAPE', 'Zone registry must be a YAML object with a zones list.', 'Declare zones as a list of zone names.', { line: 1, column: 1 });
  }
  const [error] = document.errors;
  if (error !== undefined) {
    return fail('$', 'LP-ZONE-REGISTRY-YAML', error.message, 'Fix YAML syntax and duplicate keys.', { line: error.linePos?.[0]?.line ?? 1, column: error.linePos?.[0]?.col ?? 1 });
  }
  const constructs: Construct[] = [];
  collectConstructs(document.contents, constructs);
  const [construct] = constructs;
  if (construct !== undefined) {
    const offset = construct.node.range?.[0] ?? 0;
    const position = counter.linePos(offset);
    const what = construct.kind === 'alias' ? 'YAML aliases and merge keys' : `Explicit YAML tag '${construct.node.tag}'`;
    return fail('$', 'LP-ZONE-REGISTRY-SHAPE', `${what} are not allowed in the zone registry; they create ambiguous output.`, 'Inline the referenced value instead of using an anchor or alias.', { line: position.line, column: position.col });
  }
  const raw = document.toJS({ mapAsMap: false }) as unknown;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('$', 'LP-ZONE-REGISTRY-SHAPE', 'Zone registry must be a YAML object with a zones list.', 'Declare zones as a list of zone names.', { line: 1, column: 1 });
  }
  const value = raw as Record<string, unknown>;
  const positionAt = (segments: Array<string | number>): { line: number; column: number } => {
    const node = (segments.length === 0 ? document.contents : document.getIn(segments, true)) as Node | null;
    const offset = node?.range?.[0] ?? document.contents?.range?.[0];
    if (typeof offset === 'number') {
      const linePos = counter.linePos(offset);
      return { line: linePos.line, column: linePos.col };
    }
    return { line: 1, column: 1 };
  };

  if (value.apiVersion !== ZONE_REGISTRY_API_VERSION) {
    return fail('apiVersion', 'LP-ZONE-REGISTRY-VERSION', `Unsupported zone registry apiVersion '${String(value.apiVersion)}'; expected '${ZONE_REGISTRY_API_VERSION}'.`, `Set apiVersion: ${ZONE_REGISTRY_API_VERSION}.`, positionAt(['apiVersion']));
  }
  if (!Array.isArray(value.zones)) {
    return fail('zones', 'LP-ZONE-REGISTRY-SHAPE', 'Zone registry must declare a zones list.', 'Declare zones as a list of zone names.', positionAt(['zones']));
  }
  const zones: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.zones.length; index += 1) {
    const zone = value.zones[index];
    if (typeof zone !== 'string' || zone.length === 0) {
      return fail(`zones.${index}`, 'LP-ZONE-REGISTRY-SHAPE', `Zone entry ${index} must be a non-empty string.`, 'Declare each zone as a plain string name.', positionAt(['zones', index]));
    }
    if (seen.has(zone)) {
      return fail(`zones.${index}`, 'LP-ZONE-REGISTRY-DUPLICATE', `Zone '${zone}' is declared more than once.`, 'Keep one entry per zone.', positionAt(['zones', index]));
    }
    seen.add(zone);
    zones.push(zone);
  }
  zones.sort();
  return { zones, issues: [] };
}
