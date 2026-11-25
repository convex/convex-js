const WRITE_CONFLICT_ERROR_TEXT = "OptimisticConcurrencyControlFailure";
const WRITE_CONFLICT_PUBLIC_ERROR_TEXT = "Documents read from or written to";
const WRITE_CONFLICT_PUBLIC_RETRY_TEXT =
  "changed while this mutation was being run and on every subsequent retry";
const WRITE_CONFLICT_SYSTEM_ERROR_TEXT =
  "Data read or written in this mutation changed while it was being run.";

const DEFAULT_MAX_WRITE_CONFLICT_RETRIES = 1;
const DEFAULT_WRITE_CONFLICT_RETRY_DELAY_MS = 2000;

export interface WriteConflictRetryOptions {
  /**
   * The number of additional attempts to make after Convex reports a final
   * write conflict for a mutation.
   *
   * Defaults to 1. Set to 0 to disable client-side or action-side write
   * conflict retries.
   */
  maxWriteConflictRetries?: number | undefined;
  /**
   * The delay before each additional write conflict retry, in milliseconds.
   *
   * Defaults to 2000.
   */
  writeConflictRetryDelayMs?: number | undefined;
}

export type ValidatedWriteConflictRetryOptions = {
  maxWriteConflictRetries: number;
  writeConflictRetryDelayMs: number;
};

export function validateWriteConflictRetryOptions(
  options: WriteConflictRetryOptions | undefined,
): ValidatedWriteConflictRetryOptions {
  return {
    maxWriteConflictRetries: validateMaxWriteConflictRetries(options),
    writeConflictRetryDelayMs: validateWriteConflictRetryDelayMs(options),
  };
}

export function validateMaxWriteConflictRetries(
  options: WriteConflictRetryOptions | undefined,
): number {
  const maxWriteConflictRetries =
    options?.maxWriteConflictRetries ?? DEFAULT_MAX_WRITE_CONFLICT_RETRIES;
  if (
    !Number.isInteger(maxWriteConflictRetries) ||
    maxWriteConflictRetries < 0
  ) {
    throw new Error("maxWriteConflictRetries must be a nonnegative integer.");
  }
  return maxWriteConflictRetries;
}

export function validateWriteConflictRetryDelayMs(
  options: WriteConflictRetryOptions | undefined,
): number {
  const writeConflictRetryDelayMs =
    options?.writeConflictRetryDelayMs ?? DEFAULT_WRITE_CONFLICT_RETRY_DELAY_MS;
  if (
    !Number.isFinite(writeConflictRetryDelayMs) ||
    writeConflictRetryDelayMs < 0
  ) {
    throw new Error("writeConflictRetryDelayMs must be a nonnegative number.");
  }
  return writeConflictRetryDelayMs;
}

export function isWriteConflictRetryableMessage(message: string): boolean {
  return (
    message.includes(WRITE_CONFLICT_ERROR_TEXT) ||
    message.includes(WRITE_CONFLICT_SYSTEM_ERROR_TEXT) ||
    (message.includes(WRITE_CONFLICT_PUBLIC_ERROR_TEXT) &&
      message.includes(WRITE_CONFLICT_PUBLIC_RETRY_TEXT))
  );
}

export function isWriteConflictRetryableError(error: unknown): boolean {
  return (
    error instanceof Error && isWriteConflictRetryableMessage(error.message)
  );
}

export function isWriteConflictRetryableResult(result: {
  success: boolean;
  errorMessage?: string;
}): boolean {
  return (
    !result.success &&
    result.errorMessage !== undefined &&
    isWriteConflictRetryableMessage(result.errorMessage)
  );
}

export async function sleepForWriteConflictRetry(
  delayMs: number,
): Promise<void> {
  return await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export async function retryOnWriteConflict<T>(
  operation: () => Promise<T>,
  options: ValidatedWriteConflictRetryOptions,
): Promise<T> {
  let attemptsRemaining = options.maxWriteConflictRetries;
  while (true) {
    try {
      return await operation();
    } catch (error: unknown) {
      if (attemptsRemaining <= 0 || !isWriteConflictRetryableError(error)) {
        throw error;
      }
      attemptsRemaining -= 1;
      await sleepForWriteConflictRetry(options.writeConflictRetryDelayMs);
    }
  }
}
