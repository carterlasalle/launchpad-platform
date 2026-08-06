import { afterEach, describe, expect, it, vi } from 'vitest';

const nodeDns = vi.hoisted(() => ({
  lookup: vi.fn(),
  setServers: vi.fn(),
  resolve: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({
  lookup: nodeDns.lookup,
  Resolver: class {
    setServers = nodeDns.setServers;
    resolve = nodeDns.resolve;
    cancel = nodeDns.cancel;
  },
}));

import { createNodeDnsDependencies } from './node-dns.js';

const endpoint = { hostname: 'ada.ns.cloudflare.com', address: '192.0.2.53' };

describe('createNodeDnsDependencies', () => {
  afterEach(() => vi.clearAllMocks());

  it('cancels an in-flight authoritative query when its deadline expires', async () => {
    nodeDns.resolve.mockImplementation(() => new Promise<string[]>(() => undefined));
    const dependencies = createNodeDnsDependencies({ queryTimeoutMs: 1 });

    await expect(dependencies.query(endpoint, 'www.carterlasalle.com', 'A')).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(nodeDns.cancel).toHaveBeenCalledTimes(1);
  });

  it('flattens authoritative TXT chunks into contract answer strings', async () => {
    nodeDns.resolve.mockResolvedValue([['first', 'segment'], ['second']]);
    const dependencies = createNodeDnsDependencies({ queryTimeoutMs: 1_000 });

    await expect(dependencies.query(endpoint, 'verification.carterlasalle.com', 'TXT' as never)).resolves.toEqual(['firstsegment', 'second']);
  });

  it('cancels the underlying resolver when the core aborts the query', async () => {
    nodeDns.resolve.mockImplementation(() => new Promise<string[]>(() => undefined));
    const dependencies = createNodeDnsDependencies({ queryTimeoutMs: 1_000 });
    const controller = new AbortController();

    const pending = dependencies.query(endpoint, 'www.carterlasalle.com', 'A', controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(nodeDns.cancel).toHaveBeenCalledTimes(1);
  });

  it('does not cancel a resolver whose query completed before any deadline', async () => {
    nodeDns.resolve.mockResolvedValue(['192.0.2.10']);
    const dependencies = createNodeDnsDependencies({ queryTimeoutMs: 1_000 });
    const controller = new AbortController();

    await expect(dependencies.query(endpoint, 'www.carterlasalle.com', 'A', controller.signal)).resolves.toEqual(['192.0.2.10']);
    // A late abort must not reach the finished resolver (listener removed).
    controller.abort();
    expect(nodeDns.cancel).not.toHaveBeenCalled();
  });

  it('cancels exactly once when the abort arrives after the query deadline', async () => {
    nodeDns.resolve.mockImplementation(() => new Promise<string[]>(() => undefined));
    const dependencies = createNodeDnsDependencies({ queryTimeoutMs: 1 });
    const controller = new AbortController();

    await expect(dependencies.query(endpoint, 'www.carterlasalle.com', 'A', controller.signal)).rejects.toMatchObject({ code: 'TIMEOUT' });
    controller.abort();
    expect(nodeDns.cancel).toHaveBeenCalledTimes(1);
  });
});
