export const supportedSchemaVersions = ['launchpad.dev/v1'] as const;
export type SchemaVersion = (typeof supportedSchemaVersions)[number];

export function isSupportedSchemaVersion(value: unknown): value is SchemaVersion {
  return typeof value === 'string' && (supportedSchemaVersions as readonly string[]).includes(value);
}

export type SchemaMigrationFrom = 'launchpad.dev/v1alpha1';

export interface SchemaMigration {
  from: SchemaMigrationFrom;
  to: SchemaVersion;
  /** Human-readable description of the legacy shape and what the migration rewrites. */
  description: string;
  migrate(value: Record<string, unknown>): Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const flatBuildCommands = ['installCommand', 'buildCommand', 'outputDirectory', 'developmentCommand', 'ignoredBuildStep'] as const;

/**
 * Migrations from legacy schema versions to the current `launchpad.dev/v1`.
 * Each migration is a pure, deterministic rewrite; it never writes back to
 * the source file. Loaders MUST surface a visible migration notice so a
 * migrated manifest is never silently rewritten.
 */
export const schemaMigrations: readonly SchemaMigration[] = [
  {
    from: 'launchpad.dev/v1alpha1',
    to: 'launchpad.dev/v1',
    description: 'Rewrites metadata.name to metadata.id, nests flat project build commands under vercel.project.build, and renames lifecycle.status to lifecycle.state.',
    migrate(value) {
      const next: Record<string, unknown> = { ...value, apiVersion: 'launchpad.dev/v1' };
      const metadata = asRecord(value.metadata);
      if (metadata.name !== undefined || metadata.id === undefined) {
        const migratedMetadata = { ...metadata };
        if (migratedMetadata.id === undefined && typeof metadata.name === 'string') migratedMetadata.id = metadata.name;
        delete migratedMetadata.name;
        next.metadata = migratedMetadata;
      }
      const vercel = asRecord(value.vercel);
      const project = asRecord(vercel.project);
      if (flatBuildCommands.some((key) => key in project)) {
        const migratedProject = { ...project };
        const build = asRecord(project.build);
        for (const key of flatBuildCommands) {
          if (key in migratedProject) {
            build[key] = migratedProject[key] ?? null;
            delete migratedProject[key];
          }
        }
        next.vercel = { ...vercel, project: { ...migratedProject, build } };
      }
      const lifecycle = asRecord(value.lifecycle);
      if (lifecycle.status !== undefined) {
        const migratedLifecycle = { ...lifecycle };
        migratedLifecycle.state = lifecycle.status;
        delete migratedLifecycle.status;
        next.lifecycle = migratedLifecycle;
      }
      return next;
    },
  },
];

export interface SchemaMigrationResult {
  value: Record<string, unknown>;
  migratedFrom: SchemaMigrationFrom;
  to: SchemaVersion;
}

/**
 * Dispatch an unsupported apiVersion to its registered migration.
 * Returns null when the version is unsupported and unmigratable, or when the
 * version is already supported (no migration needed).
 */
export function migrateSchemaVersion(value: Record<string, unknown>): SchemaMigrationResult | null {
  const from = typeof value.apiVersion === 'string' ? value.apiVersion : null;
  if (from === null || isSupportedSchemaVersion(from)) return null;
  const migration = schemaMigrations.find((entry) => entry.from === from);
  return migration ? { value: migration.migrate(value), migratedFrom: migration.from, to: migration.to } : null;
}
