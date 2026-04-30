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
  if (/Session API error (503|504|429)\b/.test(msg)) return true;
  if (/Deadline expired|RESOURCE_EXHAUSTED|"UNAVAILABLE"|\bUNAVAILABLE\b/i.test(msg)) return true;
  return false;
}

module.exports = { isTransientIllustrationInfraError };
