/**
 * Database retry utility with exponential backoff.
 * Handles SQLite SQLITE_BUSY and SQLITE_LOCKED errors.
 */

import { DatabaseLockedError } from "../core/errors.js";

/**
 * Configuration for retry behavior.
 */
export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;
  /** Initial delay in milliseconds (default: 100) */
  initialDelayMs?: number;
  /** Maximum delay in milliseconds (default: 2000) */
  maxDelayMs?: number;
  /** Exponential backoff multiplier (default: 2) */
  backoffMultiplier?: number;
}

/**
 * Default retry configuration.
 */
const DEFAULT_CONFIG: Required<RetryConfig> = {
  maxAttempts: 3,
  initialDelayMs: 100,
  maxDelayMs: 2000,
  backoffMultiplier: 2,
};

/**
 * Check if an error is a SQLite locked/busy error.
 * @param error - The error to check
 * @returns true if this is a retryable database lock error
 */
export function isDatabaseLockedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();

  // SQLite error codes for locked/busy conditions
  return (
    message.includes("sqlite_busy") ||
    message.includes("sqlite_locked") ||
    message.includes("database is locked") ||
    message.includes("database is busy") ||
    message.includes("cannot start a transaction within a transaction")
  );
}

/**
 * Sleep for a specified number of milliseconds.
 * @param ms - Number of milliseconds to sleep
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate delay with exponential backoff and jitter.
 * @param attempt - Current attempt number (0-indexed)
 * @param config - Retry configuration
 * @returns Delay in milliseconds
 */
function calculateDelay(attempt: number, config: Required<RetryConfig>): number {
  const baseDelay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt);
  // Add jitter (±10%) to prevent thundering herd
  const jitter = baseDelay * 0.1 * (Math.random() * 2 - 1);
  const delay = Math.min(baseDelay + jitter, config.maxDelayMs);
  return Math.max(0, Math.round(delay));
}

/**
 * Execute a synchronous database operation with retry on lock errors.
 * Uses exponential backoff between retries.
 *
 * @param operation - The synchronous operation to execute
 * @param config - Optional retry configuration
 * @returns The result of the operation
 * @throws DatabaseLockedError if all retries are exhausted
 * @throws The original error if it's not a lock error
 */
export function withRetrySync<T>(
  operation: () => T,
  config?: RetryConfig
): T {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < mergedConfig.maxAttempts; attempt++) {
    try {
      return operation();
    } catch (error) {
      if (!isDatabaseLockedError(error)) {
        throw error; // Non-lock errors should not be retried
      }

      lastError = error as Error;

      // Don't sleep after the last attempt
      if (attempt < mergedConfig.maxAttempts - 1) {
        // For sync operations, we can't actually sleep, so we'll spin-wait briefly
        // This is not ideal but necessary for synchronous better-sqlite3 operations
        const delay = calculateDelay(attempt, mergedConfig);
        const end = Date.now() + delay;
        while (Date.now() < end) {
          // Spin wait - not ideal but necessary for sync operations
        }
      }
    }
  }

  throw new DatabaseLockedError(
    mergedConfig.maxAttempts,
    lastError?.message
  );
}

/**
 * Execute an async database operation with retry on lock errors.
 * Uses exponential backoff between retries.
 *
 * @param operation - The async operation to execute
 * @param config - Optional retry configuration
 * @returns Promise resolving to the result of the operation
 * @throws DatabaseLockedError if all retries are exhausted
 * @throws The original error if it's not a lock error
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  config?: RetryConfig
): Promise<T> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < mergedConfig.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isDatabaseLockedError(error)) {
        throw error; // Non-lock errors should not be retried
      }

      lastError = error as Error;

      // Don't sleep after the last attempt
      if (attempt < mergedConfig.maxAttempts - 1) {
        const delay = calculateDelay(attempt, mergedConfig);
        await sleep(delay);
      }
    }
  }

  throw new DatabaseLockedError(
    mergedConfig.maxAttempts,
    lastError?.message
  );
}

/**
 * Create a wrapped function that automatically retries on database lock errors.
 *
 * @param fn - The function to wrap
 * @param config - Optional retry configuration
 * @returns Wrapped function with automatic retry
 */
export function withRetryWrapper<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => TResult,
  config?: RetryConfig
): (...args: TArgs) => TResult {
  return (...args: TArgs): TResult => {
    return withRetrySync(() => fn(...args), config);
  };
}

/**
 * Create an async wrapped function that automatically retries on database lock errors.
 *
 * @param fn - The async function to wrap
 * @param config - Optional retry configuration
 * @returns Wrapped async function with automatic retry
 */
export function withRetryWrapperAsync<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  config?: RetryConfig
): (...args: TArgs) => Promise<TResult> {
  return (...args: TArgs): Promise<TResult> => {
    return withRetry(() => fn(...args), config);
  };
}
