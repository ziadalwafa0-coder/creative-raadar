/**
 * Utilities for bounded exponential backoff with jitter and strict quota detection for Gemini API calls.
 */

export class QuotaExhaustedError extends Error {
  public readonly code = 'QUOTA_EXHAUSTED';
  constructor(message = 'تم تجاوز حصة استخدام الذكاء الاصطناعي مؤقتاً (429 RESOURCE_EXHAUSTED). يرجى المحاولة لاحقاً أو إضافة الروابط يدوياً.') {
    super(message);
    this.name = 'QuotaExhaustedError';
  }
}

export class GeminiUnavailableError extends Error {
  public readonly code = 'SERVICE_UNAVAILABLE';
  constructor(message = 'خدمة التحليل البصري غير متاحة حالياً (503 UNAVAILABLE). يمكنك متابعة البحث بالاسم أو إضافة الروابط.') {
    super(message);
    this.name = 'GeminiUnavailableError';
  }
}

/**
 * Checks whether an error is a 429 Quota Exhausted / Rate Limit error.
 */
export function isQuotaExhaustedError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof QuotaExhaustedError) return true;

  const errorString = String(err).toLowerCase();
  const msg = typeof err === 'object' && err !== null && 'message' in err ? String((err as any).message).toLowerCase() : '';
  const status = typeof err === 'object' && err !== null && 'status' in err ? Number((err as any).status) : 0;
  const statusCode = typeof err === 'object' && err !== null && 'statusCode' in err ? Number((err as any).statusCode) : 0;

  if (status === 429 || statusCode === 429) return true;

  const quotaPatterns = [
    'resource_exhausted',
    'quota_exceeded',
    'quota exceeded',
    'rate limit',
    'ratelimit',
    'too many requests',
    '429',
  ];

  return quotaPatterns.some((pattern) => errorString.includes(pattern) || msg.includes(pattern));
}

/**
 * Checks whether an error is a transient 503 / Network failure eligible for retry.
 */
export function isTransientUnavailableError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof GeminiUnavailableError) return true;

  // Quota exhaustion is NEVER transient for immediate retries
  if (isQuotaExhaustedError(err)) return false;

  const errorString = String(err).toLowerCase();
  const msg = typeof err === 'object' && err !== null && 'message' in err ? String((err as any).message).toLowerCase() : '';
  const status = typeof err === 'object' && err !== null && 'status' in err ? Number((err as any).status) : 0;
  const statusCode = typeof err === 'object' && err !== null && 'statusCode' in err ? Number((err as any).statusCode) : 0;

  if (status === 503 || statusCode === 503 || status === 502 || statusCode === 502 || status === 504 || statusCode === 504) {
    return true;
  }

  const transientPatterns = [
    'unavailable',
    '503',
    '502',
    '504',
    'fetch failed',
    'network error',
    'econnreset',
    'etimedout',
    'socket hang up',
    'timeout',
    'overloaded',
  ];

  return transientPatterns.some((pattern) => errorString.includes(pattern) || msg.includes(pattern));
}

/**
 * Calculates bounded exponential backoff with random jitter.
 * @param attempt 0-indexed attempt count (0 is first retry)
 * @param baseMs base delay in ms (default 400ms)
 * @param maxMs maximum ceiling in ms (default 2500ms)
 * @param randomFn optional RNG function for deterministic testing
 */
export function calculateBackoffMs(
  attempt: number,
  baseMs = 400,
  maxMs = 2500,
  randomFn = Math.random
): number {
  const boundedAttempt = Math.min(Math.max(0, attempt), 6);
  const exponential = Math.min(maxMs, baseMs * Math.pow(2, boundedAttempt));
  // Add 10-30% jitter to prevent thundering herd
  const jitterRange = exponential * 0.3;
  const jitter = Math.floor(randomFn() * jitterRange);
  return Math.min(maxMs, exponential + jitter);
}

/**
 * Wraps an async operation with bounded exponential backoff for transient 503 errors.
 * If a 429 quota exhaustion is detected, it ABORTS IMMEDIATELY without retrying.
 */
export async function executeWithGeminiRetry<T>(
  action: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseMs?: number;
    maxMs?: number;
    onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
  } = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 2;
  const baseMs = options.baseMs ?? 400;
  const maxMs = options.maxMs ?? 2500;

  let attempt = 0;

  while (true) {
    try {
      return await action();
    } catch (err: unknown) {
      // 1. Quota exhaustion: Immediately STOP repeated requests
      if (isQuotaExhaustedError(err)) {
        throw new QuotaExhaustedError();
      }

      // 2. Transient 503 / Network error: Retry up to maxRetries
      if (isTransientUnavailableError(err) && attempt < maxRetries) {
        const delayMs = calculateBackoffMs(attempt, baseMs, maxMs);
        if (options.onRetry) {
          options.onRetry(attempt + 1, delayMs, err);
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        attempt++;
        continue;
      }

      // 3. Exhausted retries for 503: Throw informative Arabic error
      if (isTransientUnavailableError(err)) {
        throw new GeminiUnavailableError();
      }

      // 4. Other fatal errors: rethrow directly
      throw err;
    }
  }
}
