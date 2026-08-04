export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  jitter?: () => number;
  shouldRetry?: (error: unknown) => boolean;
}

export function isRetryableError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === true;
}

export async function retry<T>(operation: (attempt: number) => Promise<T>, policy: RetryPolicy): Promise<T> {
  const sleep = policy.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const jitter = policy.jitter ?? (() => 0);
  const shouldRetry = policy.shouldRetry ?? isRetryableError;
  const maxDelayMs = policy.maxDelayMs ?? 30_000;
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) throw new RangeError('maxAttempts must be at least 1');

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt === policy.maxAttempts || !shouldRetry(error)) throw error;
      const exponential = Math.min(maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
      await sleep(Math.max(0, Math.round(exponential + jitter())));
    }
  }
  throw new Error('Retry loop exhausted unexpectedly');
}
