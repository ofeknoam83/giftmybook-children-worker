/**
 * Input validation and prompt sanitization for API requests.
 */

const VALID_FORMATS = ['picture_book', 'early_reader', 'PICTURE_BOOK', 'EARLY_READER', 'CHAPTER_BOOK', 'GRAPHIC_NOVEL'];
const FORMAT_NORMALIZE = { PICTURE_BOOK: 'picture_book', EARLY_READER: 'early_reader' };
const VALID_ART_STYLES = ['pixar_premium', 'watercolor', 'digital_painting', 'gouache', 'pencil_sketch', 'paper_cutout', 'storybook_classic', 'anime', 'pixel_art', 'storybook', 'cinematic_3d'];
const VALID_THEMES = ['adventure', 'friendship', 'bedtime', 'birthday', 'birthday_magic', 'holiday', 'school', 'nature', 'space', 'underwater', 'fantasy',
  // Occasion themes
  'mothers_day', 'fathers_day',
  // Emotional development themes
  'anxiety', 'anger', 'fear', 'grief', 'loneliness', 'new_beginnings', 'self_worth', 'family_change'
];
const VALID_GENDERS = ['male', 'female', 'neutral'];

/**
 * Normalise an incoming gender string to the internal vocabulary
 * ('male' | 'female' | 'neutral').
 *
 * The standalone client stores gender as 'boy' / 'girl' / 'other' (see
 * ChildrenCreate.jsx), but every downstream prompt and helper in this
 * worker checks `gender === 'male'` / `'female'`. Without this mapping,
 * a raw whitelist check silently coerced every 'boy'/'girl' payload to
 * 'neutral', which in turn broke upsell cover gender, pronoun selection,
 * face descriptions, and story text.
 *
 * Accepts any casing, plus the common synonyms: boy, girl, male, female,
 * man, woman, other. Anything else returns 'neutral'.
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

const MAX_BOOK_ID_LENGTH = 100;
const MAX_NAME_LENGTH = 50;
const MAX_PHOTO_URLS = 5;
const MAX_CUSTOM_DETAILS_LENGTH = 500;
const MAX_INTEREST_LENGTH = 50;
const MAX_INTERESTS = 10;
const MIN_AGE = 2;
const MAX_AGE = 12;

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

  // Strip control characters (except spaces and basic punctuation)
  let cleaned = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Strip injection patterns
  for (const pattern of INJECTION_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }

  // Collapse excessive whitespace
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
 * Check if a string is a valid callback URL (HTTPS in production, HTTP allowed otherwise).
 * @param {string} str
 * @returns {boolean}
 */
function isValidCallbackUrl(str) {
  if (typeof str !== 'string') return false;
  try {
    const url = new URL(str);
    if (process.env.NODE_ENV === 'production') return url.protocol === 'https:';
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

// Full set of questionnaire-driven anecdote keys the writer consumes. If a
// field is missing here it gets silently dropped at the API boundary, which
// means the anecdote-driven planner + quality gate never see it and the story
// ends up generic. Keep this in sync with services/writer/engine.js
// buildChildFromLegacy() and the questionnaire schema on the client.
const ANECDOTE_FIELDS = [
  // Generic
  'favorite_activities',
  'funny_thing',
  'favorite_food',
  'favorite_toys',
  'other_detail',
  'anything_else',
  'meaningful_moment',
  // Mother's Day
  'calls_mom',
  'mom_name',
  'moms_favorite_moment',
  // Father's Day
  'calls_dad',
  'dad_name',
  'dads_favorite_moment',
  // Birthday
  'favorite_cake_flavor',
  'birth_date',
];
const MAX_ANECDOTE_LENGTH = 500;

/**
 * Sanitize the childAnecdotes object. Only keys in ANECDOTE_FIELDS survive,
 * each trimmed/injection-scrubbed and capped at MAX_ANECDOTE_LENGTH.
 *
 * @param {object} raw
 * @returns {Record<string, string>}
 */
function sanitizeAnecdotes(raw) {
  const out = {};
  for (const key of ANECDOTE_FIELDS) {
    const val = raw && typeof raw[key] === 'string' ? raw[key] : '';
    out[key] = sanitizeForPrompt(val, MAX_ANECDOTE_LENGTH);
  }
  return out;
}

/**
 * Validate and sanitize a /generate-book request body.
 *
 * @param {object} body - Request body
 * @returns {{ valid: boolean, errors: string[], sanitized: object }}
 */
function validateGenerateBookRequest(body) {
  const errors = [];

  if (!body || typeof body !== 'object') {
    return { valid: false, errors: ['Request body must be a JSON object'], sanitized: null };
  }

  // Required fields
  if (!body.bookId || typeof body.bookId !== 'string') {
    errors.push('bookId is required and must be a string');
  } else if (body.bookId.length > MAX_BOOK_ID_LENGTH || !/^[\w-]+$/.test(body.bookId)) {
    errors.push(`bookId must be alphanumeric/hyphens/underscores, max ${MAX_BOOK_ID_LENGTH} chars`);
  }

  if (!body.childName || typeof body.childName !== 'string') {
    errors.push('childName is required and must be a string');
  } else if (body.childName.trim().length === 0 || body.childName.length > MAX_NAME_LENGTH) {
    errors.push(`childName must be 1-${MAX_NAME_LENGTH} characters`);
  }

  const photoOptionalFormats = ['CHAPTER_BOOK', 'GRAPHIC_NOVEL'];
  const isPhotoOptional = photoOptionalFormats.includes(body.bookFormat);

  if (!Array.isArray(body.childPhotoUrls) || body.childPhotoUrls.length === 0) {
    if (isPhotoOptional) {
      // Normalize missing/empty to [] for formats that don't require photos
      body.childPhotoUrls = [];
    } else {
      errors.push('childPhotoUrls is required and must be a non-empty array');
    }
  } else if (body.childPhotoUrls.length > MAX_PHOTO_URLS) {
    errors.push(`childPhotoUrls must have at most ${MAX_PHOTO_URLS} items`);
  } else {
    const invalidUrls = body.childPhotoUrls.filter(u => !isValidHttpsUrl(u));
    if (invalidUrls.length > 0) {
      errors.push(`All childPhotoUrls must be valid HTTPS URLs (${invalidUrls.length} invalid)`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, sanitized: null };
  }

  // Build sanitized object with defaults
  const sanitized = {
    bookId: body.bookId.trim(),
    childName: sanitizeForPrompt(body.childName.trim(), MAX_NAME_LENGTH),
    childPhotoUrls: body.childPhotoUrls,
    childAge: clampAge(body.childAge),
    childGender: normaliseGender(body.childGender),
    childAppearance: sanitizeForPrompt(body.childAppearance || '', 300),
    childInterests: sanitizeInterests(body.childInterests),
    bookFormat: VALID_FORMATS.includes(body.bookFormat) ? (FORMAT_NORMALIZE[body.bookFormat] || body.bookFormat) : 'picture_book',
    artStyle: VALID_ART_STYLES.includes(body.artStyle) ? body.artStyle : 'pixar_premium',
    theme: VALID_THEMES.includes(body.theme) ? body.theme : 'adventure',
    customDetails: sanitizeForPrompt(body.customDetails || '', MAX_CUSTOM_DETAILS_LENGTH),
    callbackUrl: isValidCallbackUrl(body.callbackUrl) ? body.callbackUrl : null,
    progressCallbackUrl: isValidCallbackUrl(body.progressCallbackUrl) ? body.progressCallbackUrl : null,
    childId: body.childId ? String(body.childId).slice(0, 100) : undefined,
    approvedTitle: typeof body.approvedTitle === 'string' ? body.approvedTitle.slice(0, 200) : undefined,
    approvedCoverUrl: isValidHttpsUrl(body.approvedCoverUrl) ? body.approvedCoverUrl : undefined,
    childAnecdotes: sanitizeAnecdotes(body.childAnecdotes),
    emotionalCategory: body.emotionalCategory || null,
    emotionalSituation: sanitizeForPrompt(body.emotionalSituation || '', 2000),
    emotionalParentGoal: body.emotionalParentGoal || null,
    copingResourceHint: sanitizeForPrompt(body.copingResourceHint || '', 500),
    confirmedCharacters: Array.isArray(body.confirmedCharacters) ? body.confirmedCharacters : null,
  };

  return { valid: true, errors: [], sanitized };
}

/**
 * Validate a /generate-spread request body.
 * @param {object} body
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateGenerateSpreadRequest(body) {
  const errors = [];
  if (!body || typeof body !== 'object') {
    return { valid: false, errors: ['Request body must be a JSON object'] };
  }
  if (!body.bookId || typeof body.bookId !== 'string') {
    errors.push('bookId is required');
  }
  if (!body.spreadPlan || typeof body.spreadPlan !== 'object') {
    errors.push('spreadPlan is required');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a /finalize-book request body.
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

function clampAge(age) {
  const n = Number(age);
  if (isNaN(n)) return 5;
  return Math.max(MIN_AGE, Math.min(MAX_AGE, Math.round(n)));
}

function sanitizeInterests(interests) {
  if (!Array.isArray(interests)) return [];
  return interests
    .filter(i => typeof i === 'string' && i.trim().length > 0)
    .slice(0, MAX_INTERESTS)
    .map(i => sanitizeForPrompt(i.trim(), MAX_INTEREST_LENGTH));
}

module.exports = {
  validateGenerateBookRequest,
  validateGenerateSpreadRequest,
  validateFinalizeBookRequest,
  sanitizeForPrompt,
  isValidHttpsUrl,
  VALID_FORMATS,
  VALID_ART_STYLES,
  VALID_THEMES,
  VALID_GENDERS,
  normaliseGender,
};
