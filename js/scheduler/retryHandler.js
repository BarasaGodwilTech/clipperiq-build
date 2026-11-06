const BASE_DELAY_MS = 60 * 1000;
const MAX_RETRIES = 3;

export const retryHandler = {
  shouldRetry(job) {
    return (job.retryCount || 0) < (job.maxRetries ?? MAX_RETRIES);
  },

  getNextRetryTime(retryCount) {
    const delayMs = BASE_DELAY_MS * Math.pow(2, retryCount);
    const jitter = Math.random() * 10000;
    return new Date(Date.now() + delayMs + jitter).toISOString();
  },

  isRetryableError(error) {
    const msg = error?.message?.toLowerCase() || '';
    const nonRetryable = [
      'not connected',
      'not configured',
      'unauthorized',
      'forbidden',
      'invalid token',
      'quota exceeded',
      'no instagram business',
    ];
    return !nonRetryable.some((phrase) => msg.includes(phrase));
  },

  getRetryDelay(attempt, error) {
    const msg = error?.message?.toLowerCase() || '';
    console.log('[RetryHandler] Checking error for special backoff:', msg);
    // Special-case TikTok spam risk: 10-minute backoff
    if (/too_many_pending_share|spam_risk/.test(msg)) {
      console.log('[RetryHandler] Applying 10-minute backoff for TikTok spam risk');
      return 10 * 60 * 1000; // 10 minutes
    }
    // Default exponential backoff with jitter
    const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 5000;
    console.log('[RetryHandler] Using default exponential backoff:', delay);
    return delay;
  },

  async withRetry(fn, jobId, onRetry = null) {
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (attempt >= MAX_RETRIES || !this.isRetryableError(err)) break;
        const delay = this.getRetryDelay(attempt, err);
        if (onRetry) onRetry(attempt + 1, delay, err);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError;
  },
};
