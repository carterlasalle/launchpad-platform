const secretPattern = /(token|secret|password|api[_-]?key|database[_-]?url)\s*[:=]\s*[^\s]+/gi;

export function redactedLogTail(lines: readonly string[], maxLines = 80, maxBytes = 16_000): string {
  const output: string[] = [];
  let bytes = 0;
  for (const line of lines.slice(-maxLines)) {
    const safe = line.replace(secretPattern, '$1=[REDACTED]');
    const nextBytes = bytes + new TextEncoder().encode(`${safe}\n`).length;
    if (nextBytes > maxBytes) break;
    output.push(safe);
    bytes = nextBytes;
  }
  return output.join('\n');
}
