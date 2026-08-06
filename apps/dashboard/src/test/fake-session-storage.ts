// Shared session-storage fake for dashboard tests (vitest runs in the node
// environment, which has no sessionStorage). The fake is Map-backed so tests
// can assert the exact keys written — the session contract requires the
// namespaced key 'launchpad.dashboard.sessionToken' and never a bare key.

import { vi } from 'vitest';

/** The storage surface session.ts uses; throwing implementations model storage being unavailable. */
export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class FakeSessionStorage implements SessionStorageLike {
  private readonly store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }

  keys(): string[] {
    return [...this.store.keys()];
  }
}

/**
 * Swaps the global `sessionStorage` accessor for `storage` so session.ts
 * reads and writes the fake. Node has no sessionStorage, so a configurable
 * accessor is defined on first use; vi.spyOn replaces the getter and
 * `vi.restoreAllMocks()` in afterEach reverts it.
 */
export function installSessionStorage(storage: SessionStorageLike): void {
  const globalObject = globalThis as unknown as { sessionStorage: SessionStorageLike };
  if (!Object.getOwnPropertyDescriptor(globalObject, 'sessionStorage')) {
    Object.defineProperty(globalObject, 'sessionStorage', { configurable: true, enumerable: true, get: () => undefined });
  }
  vi.spyOn(globalObject, 'sessionStorage', 'get').mockReturnValue(storage);
}
