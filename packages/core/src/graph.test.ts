import { describe, expect, it } from 'vitest';
import { buildResourceGraph, topologicalLayers, validateResourceGraph, type DesiredApplication, type ResourceGraph } from './index.js';
import { desired, minimalObserved } from './fixtures.js';

describe('resource graph and topological layers', () => {
  it('covers every manifest dimension with provider and release nodes', () => {
    const graph = buildResourceGraph(desired, minimalObserved());
    const keys = graph.nodes.map((node) => node.key);
    expect(keys).toEqual(expect.arrayContaining([
      'application.manifest',
      'github.repository',
      'github.repository-access',
      'vercel.project',
      'vercel.git',
      'vercel.settings',
      'vercel.environment.preview',
      'vercel.environment.production',
      'vercel.domain.app.example.com',
      'cloudflare.dns.app.example.com',
      'domain.verification.app.example.com',
      'production.candidate',
      'production.health',
      'production.promotion',
      'production.post-health',
      'application.lifecycle',
    ]));
    expect(graph.nodes.find((node) => node.key === 'production.promotion')?.dependencies).toContain('production.health');
    expect(graph.nodes.find((node) => node.key === 'production.candidate')?.dependencies).toContain('domain.verification.app.example.com');
    expect(graph.nodes.find((node) => node.key === 'cloudflare.dns.app.example.com')?.dependencies).toContain('vercel.domain.app.example.com');
    expect(graph.nodes.find((node) => node.key === 'application.lifecycle')?.provider).toBe('platform');
  });

  it('adds keyed variable fingerprint nodes per environment and secret binding', () => {
    const withVariables: DesiredApplication = {
      ...desired,
      environments: {
        ...desired.environments,
        preview: { ...desired.environments.preview!, variables: { API_KEY: { secretRef: 'infisical://project/preview#API_KEY', sensitive: true } } },
      },
    };
    const graph = buildResourceGraph(withVariables, minimalObserved());
    const variableNode = graph.nodes.find((node) => node.key === 'vercel.variable.preview.API_KEY');
    expect(variableNode).toBeDefined();
    expect(variableNode?.dependencies).toContain('vercel.environment.preview');
    const configuration = variableNode?.desired as { fingerprint: string };
    expect(configuration.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(graph)).not.toContain('infisical://');
  });

  it('is valid for the canonical manifest', () => {
    const validation = validateResourceGraph(buildResourceGraph(desired, minimalObserved()));
    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([]);
  });

  it('rejects duplicate nodes from duplicate domains', () => {
    const duplicated: DesiredApplication = { ...desired, domains: [...desired.domains, { ...desired.domains[0]! }] };
    const validation = validateResourceGraph(buildResourceGraph(duplicated, minimalObserved()));
    expect(validation.valid).toBe(false);
    expect(validation.issues.some((issue) => issue.code === 'DUPLICATE_KEY' && issue.message.includes('vercel.domain.app.example.com'))).toBe(true);
  });

  it('rejects duplicate nodes from colliding variable and secret bindings', () => {
    const colliding: DesiredApplication = {
      ...desired,
      environments: {
        ...desired.environments,
        preview: { ...desired.environments.preview!, variables: { TOKEN: 'plain' } },
      },
      secrets: [{ name: 'TOKEN', source: 'infisical://project/preview#TOKEN', environments: ['preview'] }],
    };
    const validation = validateResourceGraph(buildResourceGraph(colliding, minimalObserved()));
    expect(validation.valid).toBe(false);
    expect(validation.issues.some((issue) => issue.code === 'DUPLICATE_KEY' && issue.message.includes('vercel.variable.preview.TOKEN'))).toBe(true);
  });

  it('rejects unknown dependencies and cycles in hand-built graphs', () => {
    const unknownDependency: ResourceGraph = {
      nodes: [{ key: 'a', provider: 'vercel', resourceType: 'project', dependencies: ['missing'], desired: null, observed: null }],
    };
    expect(validateResourceGraph(unknownDependency).issues.some((issue) => issue.code === 'UNKNOWN_DEPENDENCY')).toBe(true);

    const cyclic: ResourceGraph = {
      nodes: [
        { key: 'a', provider: 'vercel', resourceType: 'project', dependencies: ['b'], desired: null, observed: null },
        { key: 'b', provider: 'vercel', resourceType: 'deployment', dependencies: ['a'], desired: null, observed: null },
      ],
    };
    expect(validateResourceGraph(cyclic).issues.some((issue) => issue.code === 'CYCLE')).toBe(true);
    expect(topologicalLayers(cyclic)).toBeNull();
  });

  it('produces deterministic topological layers independent of node order', () => {
    const graph = buildResourceGraph(desired, minimalObserved());
    const layers = topologicalLayers(graph);
    expect(layers).not.toBeNull();
    const flattened = (layers as string[][]).flat();
    expect(new Set(flattened).size).toBe(flattened.length);
    const candidateIndex = flattened.indexOf('production.candidate');
    expect(flattened.indexOf('vercel.project')).toBeLessThan(candidateIndex);
    expect(flattened.indexOf('vercel.git')).toBeLessThan(candidateIndex);
    expect(flattened.indexOf('cloudflare.dns.app.example.com')).toBeGreaterThan(flattened.indexOf('vercel.domain.app.example.com'));
    const reversed = buildResourceGraph(desired, { ...minimalObserved(), resources: [...minimalObserved().resources].reverse() });
    expect(topologicalLayers(reversed)).toEqual(layers);
    expect(topologicalLayers(graph)).toEqual(layers);
  });
});
