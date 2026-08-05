import { LaunchpadError, createPlatformError } from '@launchpad/core';

export type SecretReferenceScheme = 'infisical' | 'onepassword' | 'encrypted-file' | 'env';

export interface SecretReference {
  scheme: SecretReferenceScheme;
  /** The original reference string; also the key for keyed fingerprints. */
  reference: string;
  /** Scheme-specific path parts, for example `['project', 'environment', 'path']`. */
  parts: readonly string[];
  /** The secret key or field name within the target. */
  key: string;
}

function invalidReference(reference: string): LaunchpadError {
  return new LaunchpadError(createPlatformError({ code: 'LP-SECRET-REFERENCE-INVALID', class: 'VALIDATION', message: `Invalid secret reference '${reference}'.`, retryable: false }));
}

/**
 * Parses and validates a supported secret reference:
 * - `infisical://project/environment/path#key`
 * - `onepassword://vault/item/field`
 * - `encrypted-file://catalog/secrets.enc.yaml#tokentest.production.DATABASE_URL`
 * - `env://NAME`
 *
 * Throws a `LaunchpadError` (code `LP-SECRET-REFERENCE-INVALID`) when the reference
 * does not match a supported format. A reference is a pointer, never a value.
 */
export function parseSecretReference(reference: string): SecretReference {
  if (typeof reference !== 'string' || reference.length === 0) throw invalidReference(reference);

  const env = /^env:\/\/([A-Za-z_][A-Za-z0-9_]*)$/.exec(reference);
  if (env) {
    const name = env[1]!;
    return { scheme: 'env', reference, parts: [name], key: name };
  }

  const infisical = /^infisical:\/\/([^/#]+)\/([^/#]+)\/([^#]+)#(.+)$/.exec(reference);
  if (infisical) {
    const parts = [infisical[1]!, infisical[2]!, ...infisical[3]!.split('/').filter(Boolean)];
    if (parts.length < 3) throw invalidReference(reference);
    return { scheme: 'infisical', reference, parts, key: infisical[4]! };
  }

  const onepassword = /^onepassword:\/\/([^/#]+)\/([^/#]+)\/([^#]+)$/.exec(reference);
  if (onepassword) return { scheme: 'onepassword', reference, parts: [onepassword[1]!, onepassword[2]!, onepassword[3]!], key: onepassword[3]! };

  const encryptedFile = /^encrypted-file:\/\/([^#]+\.ya?ml)#(.+)$/.exec(reference);
  if (encryptedFile) {
    const parts = encryptedFile[1]!.split('/').filter(Boolean);
    if (parts.length === 0) throw invalidReference(reference);
    return { scheme: 'encrypted-file', reference, parts, key: encryptedFile[2]! };
  }

  throw invalidReference(reference);
}

export function isSecretReference(reference: unknown): reference is string {
  if (typeof reference !== 'string') return false;
  try {
    parseSecretReference(reference);
    return true;
  } catch {
    return false;
  }
}
