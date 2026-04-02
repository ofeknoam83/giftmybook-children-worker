/**
 * Retry utility with exponential backoff.
 */

/**
 * Execute an async function with retries and exponential backoff.
 *
 * @param {Function} fn - Async function to execute
 * @param {object} [opts]
 * @param {number} [opts.maxRetries=3] - Maximum number of retry attempts
 * @param {number} [opts.baseDelayMs=1000] - Base delay in ms (doubled each retry)
 * @param {string} [opts.label=''] - Label for log messages
 * @param {Function} [opts.shouldRetry] - Optional predicate; return false to skip retrying
 * @returns {Promise<*>} Result of fn
 */
async function withRetry(fn, opts = {}) {
  const { maxRetries = 3, baseDelayMs = 1000, label = '', shouldRetry } = opts;

  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (shouldRetry && !shouldRetry(err)) {
        throw err;
      }

      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        if (label) {
          console.warn(`[retry] ${label}: attempt ${attempt}/${maxRetries} failed (${err.message}), retrying in ${delay}ms...`);
        }
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

module.exports = { withRetry };
