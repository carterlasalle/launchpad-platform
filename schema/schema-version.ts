export const supportedSchemaVersions = ['launchpad.dev/v1'] as const;
export type SchemaVersion = (typeof supportedSchemaVersions)[number];

export function isSupportedSchemaVersion(value: unknown): value is SchemaVersion {
  return typeof value === 'string' && (supportedSchemaVersions as readonly string[]).includes(value);
}
