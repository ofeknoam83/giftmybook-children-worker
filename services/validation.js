/**
 * Input validation and prompt sanitization for API requests.
 */

const { CANONICAL_BOOK_ART_STYLE } = require('./illustrationGenerator');
const { resolveThemeAxes, LEGACY_THEME_FOR_OCCASION } = require('./shared/themes');

// v3-only cutover (W11): picture books are the only supported format. The
// retired formats are rejected 400 BEFORE the 202 — a silent default to
// picture_book would generate a different product than the one requested.
const RETIRED_FORMATS = ['early_reader', 'EARLY_READER', 'CHAPTER_BOOK', 'GRAPHIC_NOVEL'];
// Legacy/alternate keys clients may still send; sanitized `artStyle` is always canonical 3D Pixar.
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
// 2000, not 500: the main app forwards the parent's freeform text verbatim
// and a 500 cap silently amputated exactly the personalization the book is
// sold on. sanitizeForPrompt still injection-scrubs the whole string.
const MAX_CUSTOM_DETAILS_LENGTH = 2000;
const MAX_INTEREST_LENGTH = 50;
const MAX_INTERESTS = 10;
const MAX_ANSWERED_QUESTIONS = 30;
const MAX_QUESTION_LENGTH = 200;
const MAX_ANSWER_LENGTH = 500;
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
  // Love to mom
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

  // v3-only cutover: retired formats fail loudly. Missing/unknown values
  // still default to picture_book (the only product), but an EXPLICIT
  // retired format means the caller wants a product we no longer make.
  if (RETIRED_FORMATS.includes(body.bookFormat)) {
    errors.push(`bookFormat '${body.bookFormat}' is retired — only picture books are supported`);
  }

  if (!Array.isArray(body.childPhotoUrls) || body.childPhotoUrls.length === 0) {
    errors.push('childPhotoUrls is required and must be a non-empty array');
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

  // Theme axes (2026-07-29): the main app sends TWO distinct fields —
  // `occasion` (why the book exists) and `storyTheme` (the world it lives
  // in). Legacy payloads funneled both through `theme` (occasion shadowing
  // story theme), so resolveThemeAxes also classifies a lone `theme` value.
  // The single legacy `theme` keeps its old semantics for the machinery
  // keyed on it (emotional tiers, effective age, parent guards, beat
  // structures) — but the fallback is no longer a silent 'adventure':
  // occasion/storyTheme-derived values win before the default, and any
  // unrecognized value logs loudly.
  const { occasion, storyTheme } = resolveThemeAxes({
    occasion: body.occasion,
    storyTheme: body.storyTheme,
    theme: body.theme,
  });
  let theme;
  if (VALID_THEMES.includes(body.theme)) {
    theme = body.theme;
  } else {
    theme = (occasion && LEGACY_THEME_FOR_OCCASION[occasion]) || storyTheme || 'adventure';
    if (body.theme) {
      console.warn(
        `[validation] theme '${body.theme}' not in VALID_THEMES for bookId=${body.bookId} — `
        + `resolved to '${theme}' (occasion=${occasion || 'none'}, storyTheme=${storyTheme || 'none'})`
      );
    }
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
    bookFormat: 'picture_book',
    artStyle: CANONICAL_BOOK_ART_STYLE,
    theme,
    occasion,
    storyTheme,
    customDetails: sanitizeForPrompt(body.customDetails || '', MAX_CUSTOM_DETAILS_LENGTH),
    callbackUrl: isValidCallbackUrl(body.callbackUrl) ? body.callbackUrl : null,
    progressCallbackUrl: isValidCallbackUrl(body.progressCallbackUrl) ? body.progressCallbackUrl : null,
    childId: body.childId ? String(body.childId).slice(0, 100) : undefined,
    approvedTitle: typeof body.approvedTitle === 'string' ? body.approvedTitle.slice(0, 200) : undefined,
    approvedCoverUrl: isValidHttpsUrl(body.approvedCoverUrl) ? body.approvedCoverUrl : undefined,
    childAnecdotes: sanitizeAnecdotes(body.childAnecdotes),
    answeredQuestions: sanitizeAnsweredQuestions(body.answeredQuestions),
    emotionalCategory: body.emotionalCategory || null,
    emotionalSituation: sanitizeForPrompt(body.emotionalSituation || '', 2000),
    emotionalParentGoal: body.emotionalParentGoal || null,
    copingResourceHint: sanitizeForPrompt(body.copingResourceHint || '', 500),
    confirmedCharacters: Array.isArray(body.confirmedCharacters) ? body.confirmedCharacters : null,
    coverParentPresent: typeof body.coverParentPresent === 'boolean' ? body.coverParentPresent : undefined,
  };

  // Empty interests is legal but produces a visibly generic story — make it
  // loud so a payload-shape regression upstream can't silently degrade every
  // book (the exact failure mode: interests sent under the wrong key/type).
  if (sanitized.childInterests.length === 0) {
    console.warn(
      `[validation] childInterests EMPTY for bookId=${sanitized.bookId} ` +
      `(raw type: ${Array.isArray(body.childInterests) ? 'array' : typeof body.childInterests}) — personalization will be weak`
    );
  }

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

/**
 * Sanitize the childInterests input into a bounded string array.
 *
 * Accepts an array OR a delimited string ("space, dinosaurs") — a client
 * sending the raw comma-joined form used to be silently coerced to [],
 * which erased the personalization the product is sold on.
 *
 * @param {unknown} interests
 * @returns {string[]}
 */
function sanitizeInterests(interests) {
  const list = Array.isArray(interests)
    ? interests
    : (typeof interests === 'string' ? interests.split(/[,;]/) : []);
  return list
    .filter(i => typeof i === 'string' && i.trim().length > 0)
    .slice(0, MAX_INTERESTS)
    .map(i => sanitizeForPrompt(i.trim(), MAX_INTEREST_LENGTH))
    .filter(Boolean);
}

// answeredQuestions ids whose content already arrives structurally
// (childName/childGender/childAge/birth date fields) — repeating them as
// free text just burns prompt budget without adding personalization.
const IDENTITY_QUESTION_IDS = new Set(['child_name', 'child_gender', 'child_age', 'birth_date']);

/**
 * Sanitize the raw questionnaire Q/A triples forwarded by the main app.
 * Non-array input → []. Entries survive only with a non-empty string
 * answer; each field is injection-scrubbed and length-capped.
 *
 * @param {unknown} raw
 * @returns {Array<{id: string, question: string, answer: string}>}
 */
function sanitizeAnsweredQuestions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (out.length >= MAX_ANSWERED_QUESTIONS) break;
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.answer !== 'string' || entry.answer.trim().length === 0) continue;
    const id = typeof entry.id === 'string' ? entry.id.trim().slice(0, 60) : '';
    if (IDENTITY_QUESTION_IDS.has(id)) continue;
    const question = sanitizeForPrompt(typeof entry.question === 'string' ? entry.question : '', MAX_QUESTION_LENGTH);
    const answer = sanitizeForPrompt(entry.answer, MAX_ANSWER_LENGTH);
    if (!answer) continue;
    out.push({ id, question, answer });
  }
  return out;
}

module.exports = {
  validateGenerateBookRequest,
  validateGenerateSpreadRequest,
  validateFinalizeBookRequest,
  sanitizeForPrompt,
  sanitizeInterests,
  sanitizeAnsweredQuestions,
  isValidHttpsUrl,
  VALID_ART_STYLES,
  VALID_THEMES,
  VALID_GENDERS,
  normaliseGender,
};
