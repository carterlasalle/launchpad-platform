export interface CatalogFile {
  path: string;
  content: string;
}

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
  path: string;
}

export interface CatalogIssue {
  code: string;
  file: string;
  line: number;
  column: number;
  path: string;
  message: string;
  remediation: string | null;
}

/** Repository identity of an application in a previously validated catalog, keyed by application ID. */
export interface PreviousRepository {
  name: string;
  expectedRepositoryId?: number | null;
}

export interface CatalogLoadOptions {
  /** Lifecycle state of each application in the previously applied catalog, keyed by application ID. */
  previousLifecycle?: Record<string, string>;
  /** Repository identity of each application in the previously applied catalog, keyed by application ID. */
  previousRepositories?: Record<string, PreviousRepository>;
  /** Registered Cloudflare zone names (e.g. from catalog config). When provided, every zone reference must resolve. */
  zones?: readonly string[];
}
