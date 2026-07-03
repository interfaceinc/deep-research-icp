/**
 * Research Rate Limiter Service
 * Handles rate limiting for the search API and Gemini APIs
 */

const DEFAULT_DELAY_MS = 300;

export class ResearchRateLimiter {
  private lastCallTime: number = 0;
  private callCount: number = 0;

  /**
   * Wait for rate limit before making a call
   */
  async waitForRateLimit(delayMs: number = DEFAULT_DELAY_MS): Promise<void> {
    const now = Date.now();
    const timeSinceLastCall = now - this.lastCallTime;

    if (timeSinceLastCall < delayMs) {
      await this.sleep(delayMs - timeSinceLastCall);
    }

    this.lastCallTime = Date.now();
    this.callCount++;
  }

  /**
   * Calculate exponential backoff delay
   */
  calculateBackoff(attempt: number, baseMs: number = 1000): number {
    return Math.pow(2, attempt) * baseMs;
  }

  /**
   * Get current call count in window
   */
  getCallCount(): number {
    return this.callCount;
  }

  /**
   * Reset rate limiter state
   */
  reset(): void {
    this.lastCallTime = 0;
    this.callCount = 0;
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Retry wrapper with exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    context?: string;
    isRetryableError?: (error: unknown) => boolean;
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    context = 'request',
    isRetryableError = defaultIsRetryableError,
  } = options;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      const isLastAttempt = attempt === maxRetries - 1;

      if (!isRetryableError(error) || isLastAttempt) {
        throw error;
      }

      const delay = Math.pow(2, attempt) * baseDelayMs;
      console.log(
        `[Retry] Attempt ${attempt + 1}/${maxRetries} for ${context} failed, retrying in ${delay}ms`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error('Retry logic failed unexpectedly');
}

/**
 * Default retryable error checker
 */
function defaultIsRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('429') ||
      message.includes('503') ||
      message.includes('rate limit') ||
      message.includes('timeout') ||
      message.includes('econnreset') ||
      message.includes('etimedout') ||
      message.includes('socket hang up')
    );
  }
  return false;
}
