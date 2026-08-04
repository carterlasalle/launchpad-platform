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

export interface CatalogLoadOptions {
  previousLifecycle?: Record<string, string>;
}
