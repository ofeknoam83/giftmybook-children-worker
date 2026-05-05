/**
 * Classify Gemini / transport failures that should burn an infra retry
 * (backoff + same logical attempt) rather than immediately failing the spread.
 */

/**
 * @param {Error & { isTransientInfrastructure?: boolean, httpStatus?: number }} err
 * @returns {boolean}
 */
function isTransientIllustrationInfraError(err) {
  if (!err) return false;
  if (err.isTransientInfrastructure === true) return true;
  const msg = String(err.message || '');
  if (/Gemini image API timed out after/i.test(msg)) return true;
  // 5xx (incl. 500 "Internal error encountered") and 429 are transient. The
  // pipeline previously omitted 500 — that single omission killed full runs
  // mid-illustration when the upstream had a brief blip on a single spread.
  if (/Session API error (500|502|503|504|429)\b/.test(msg)) return true;
  // Generic 5xx + INTERNAL surface from gemini also counts as transient.
  if (/"code":\s*500\b|"status":\s*"INTERNAL"|\bINTERNAL\b/i.test(msg)) return true;
  if (/Deadline expired|RESOURCE_EXHAUSTED|"UNAVAILABLE"|\bUNAVAILABLE\b/i.test(msg)) return true;
  return false;
}

module.exports = { isTransientIllustrationInfraError };
