import { isSensitiveValue } from './sensitive.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/**
 * Structured log context. The fixed fields are the cross-cutting correlation
 * and classification dimensions every controller log line carries:
 * correlationId, applicationId, workflowId, operationId, provider, step,
 * errorCode, and retryable. Extra keys are allowed but MUST NOT carry raw
 * request/provider bodies or secrets — the serializer redacts
 * `SensitiveValue` structurally and bounds every string.
 */
export interface LogContext {
  correlationId?: string | null;
  applicationId?: string | null;
  workflowId?: string | null;
  operationId?: string | null;
  provider?: string | null;
  step?: string | null;
  errorCode?: string | null;
  retryable?: boolean | null;
  [key: string]: unknown;
}

export interface LogEntry extends LogContext {
  timestamp: string;
  level: LogLevel;
  message: string;
}

export interface LoggerOptions {
  /** Output sink; defaults to console.log. */
  sink?: (line: string) => void;
  /** Minimum level to emit. Defaults to 'info'. */
  level?: LogLevel;
  now?: () => Date;
  /** Maximum characters per string field before truncation. Defaults to 4096. */
  maxStringChars?: number;
  /** Maximum object depth before truncation. Defaults to 12. */
  maxDepth?: number;
}

/** Credential-shaped key names whose values are never safe to log verbatim. */
const CREDENTIAL_KEY = /(token|secret|password|api[_-]?key|database[_-]?url)/i;

/**
 * Redacts a value for log/alert embedding: `SensitiveValue` instances become
 * '[REDACTED]' structurally (never regex-serialized), strings are bounded and
 * credential-shaped text is scrubbed, cycles are cut. Plain, non-serializable
 * values (functions, symbols, bigint) are dropped.
 */
export function redactLogValue(value: unknown, options: { maxStringChars?: number; maxDepth?: number } = {}): unknown {
  const maxStringChars = options.maxStringChars ?? 4096;
  const maxDepth = options.maxDepth ?? 12;
  const seen = new WeakSet<object>();

  const boundString = (text: string): string => {
    const bounded = text.length > maxStringChars ? `${text.slice(0, maxStringChars)}…[truncated]` : text;
    return redactText(bounded);
  };

  const redact = (current: unknown, depth: number): unknown => {
    if (typeof current === 'string') return boundString(current);
    if (typeof current === 'number') return Number.isFinite(current) ? current : null;
    if (typeof current === 'boolean') return current;
    if (current === null || current === undefined) return current;
    if (isSensitiveValue(current)) return '[REDACTED]';
    if (typeof current !== 'object') return null; // function, symbol, bigint
    if (seen.has(current)) return '[Circular]';
    if (depth >= maxDepth) return '[DepthLimit]';
    seen.add(current);
    if (Array.isArray(current)) {
      return current.map((item) => redact(item, depth + 1));
    }
    const record = current as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      out[boundString(key)] = CREDENTIAL_KEY.test(key) ? '[REDACTED]' : redact(record[key], depth + 1);
    }
    return out;
  };

  return redact(value, 0);
}

/** Best-effort scrub of credential-shaped text before embedding in logs. */
export function redactText(value: string): string {
  return value.replace(/(token|secret|password|api[_-]?key|database[_-]?url)\s*[:=]\s*[^\s]+/gi, '$1=[REDACTED]');
}

/**
 * Structured JSON logger for the control plane. Every entry is one JSON line
 * with the fixed correlation/classification fields; values are redacted
 * structurally (`SensitiveValue` -> '[REDACTED]') and bounded before
 * serialization. Serialization never throws: a failing entry degrades to a
 * minimal safe line instead of crashing the request path.
 */
export class LaunchpadLogger {
  readonly #sink: (line: string) => void;
  readonly #minLevel: LogLevel;
  readonly #now: () => Date;
  readonly #context: LogContext;
  readonly #maxStringChars: number;
  readonly #maxDepth: number;

  constructor(options: LoggerOptions = {}) {
    this.#sink = options.sink ?? ((line: string) => console.log(line));
    this.#minLevel = options.level ?? 'info';
    this.#now = options.now ?? (() => new Date());
    this.#context = {};
    this.#maxStringChars = options.maxStringChars ?? 4096;
    this.#maxDepth = options.maxDepth ?? 12;
  }

  /** Returns a logger that merges `context` into every subsequent entry. */
  child(context: LogContext): LaunchpadLogger {
    const child = new LaunchpadLogger({
      sink: this.#sink,
      level: this.#minLevel,
      now: this.#now,
      maxStringChars: this.#maxStringChars,
      maxDepth: this.#maxDepth,
    });
    Object.assign(child.#context, this.#context, redactLogValue(context, { maxStringChars: this.#maxStringChars, maxDepth: this.#maxDepth }) as LogContext);
    return child;
  }

  debug(message: string, context: LogContext = {}): void {
    this.#emit('debug', message, context);
  }

  info(message: string, context: LogContext = {}): void {
    this.#emit('info', message, context);
  }

  warn(message: string, context: LogContext = {}): void {
    this.#emit('warn', message, context);
  }

  error(message: string, context: LogContext = {}): void {
    this.#emit('error', message, context);
  }

  #emit(level: LogLevel, message: string, context: LogContext): void {
    if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(this.#minLevel)) return;
    const entry: LogEntry = {
      timestamp: this.#now().toISOString(),
      level,
      message: redactText(message.length > 1024 ? `${message.slice(0, 1024)}…[truncated]` : message),
      ...this.#context,
      ...(redactLogValue(context, { maxStringChars: this.#maxStringChars, maxDepth: this.#maxDepth }) as LogContext),
    };
    let line: string;
    try {
      line = JSON.stringify(entry);
    } catch {
      line = JSON.stringify({ timestamp: entry.timestamp, level, message: entry.message, errorCode: entry.errorCode ?? null, serializeError: 'fallback' });
    }
    this.#sink(line);
  }
}
