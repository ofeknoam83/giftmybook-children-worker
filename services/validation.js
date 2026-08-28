/**
 * Input validation and prompt sanitization for API requests.
 *
 * Slimmed in the catalog-engine cutover: /generate-book request validation
 * moved into services/catalogEngine (profile normalization IS the
 * validation); this module keeps the finalize-book validator and the shared
 * sanitize/gender helpers.
 */

const VALID_GENDERS = ['male', 'female', 'neutral'];

/**
 * Normalise an incoming gender string to the internal vocabulary
 * ('male' | 'female' | 'neutral'). Accepts any casing plus the common
 * synonyms: boy, girl, male, female, man, woman. Anything else returns
 * 'neutral'.
 *
 * @param {unknown} raw
 * @returns {'male' | 'female' | 'neutral'}
 */
function normaliseGender(raw) {
  if (typeof raw !== 'string') return 'neutral';
  const g = raw.trim().toLowerCase();
  if (g === 'male' || g === 'boy' || g === 'm' || g === 'man') return 'male';
  if (g === 'female' || g === 'girl' || g === 'f' || g === 'woman') return 'female';
  return 'neutral';
}

/**
 * Patterns that could be used for prompt injection in LLM inputs.
 */
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/gi,
  /ignore\s+(all\s+)?above/gi,
  /disregard\s+(all\s+)?previous/gi,
  /system\s*:\s*/gi,
  /\bassistant\s*:\s*/gi,
  /\buser\s*:\s*/gi,
  /```\s*(system|assistant|user)/gi,
  /<\/?(?:system|prompt|instruction|role)[^>]*>/gi,
];

/**
 * Sanitize a string for safe interpolation into LLM prompts.
 * Strips control characters, injection patterns, and excessive whitespace.
 *
 * @param {string} str - Input string
 * @param {number} [maxLen] - Maximum length
 * @returns {string} Sanitized string
 */
function sanitizeForPrompt(str, maxLen) {
  if (!str || typeof str !== 'string') return '';

  // eslint-disable-next-line no-control-regex
  let cleaned = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  for (const pattern of INJECTION_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }

  cleaned = cleaned.replace(/\s{3,}/g, '  ').trim();

  if (maxLen && cleaned.length > maxLen) {
    cleaned = cleaned.slice(0, maxLen).trim();
  }

  return cleaned;
}

/**
 * Check if a string looks like a valid HTTPS URL.
 * @param {string} str
 * @returns {boolean}
 */
function isValidHttpsUrl(str) {
  if (typeof str !== 'string') return false;
  try {
    const url = new URL(str);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate a /finalize-book request body (legacy books re-entering layout).
 * @param {object} body
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateFinalizeBookRequest(body) {
  const errors = [];
  if (!body || typeof body !== 'object') {
    return { valid: false, errors: ['Request body must be a JSON object'] };
  }
  if (!body.bookId || typeof body.bookId !== 'string') {
    errors.push('bookId is required');
  }
  if (body.bookFormat === 'GRAPHIC_NOVEL') {
    if (!Array.isArray(body.pages) || body.pages.length === 0) {
      errors.push('pages is required and must be a non-empty array for graphic novels');
    }
  } else {
    if (!Array.isArray(body.spreads) || body.spreads.length === 0) {
      errors.push('spreads is required and must be a non-empty array');
    }
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  validateFinalizeBookRequest,
  sanitizeForPrompt,
  isValidHttpsUrl,
  VALID_GENDERS,
  normaliseGender,
};
