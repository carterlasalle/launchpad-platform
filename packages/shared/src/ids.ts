export function stableId(namespace: string, ...parts: string[]): string {
  const input = `${namespace}:${parts.join(':')}`;
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

export function idempotencyKey(operation: string, ...parts: string[]): string {
  return stableId(`idempotency:${operation}`, ...parts);
}
