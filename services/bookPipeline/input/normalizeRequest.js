/**
 * Input normalization for the new pipeline.
 *
 * Converts the raw /generate-book payload (or legacy flat body) into the
 * three canonical objects the rest of the pipeline consumes:
 *   - request:  bookId, format, theme, ageBand, callback plumbing
 *   - brief:    child, customDetails, constraints, creativeGoals
 *   - cover:    title, imageUrl, locks (hero/outfit/cast)
 *
 * The approved cover is REQUIRED. If it is missing the pipeline rejects
 * immediately with a machine-readable failure code.
 */

const { FORMATS, AGE_BANDS, FAILURE_CODES } = require('../constants');

class InputError extends Error {
  constructor(message, failureCode) {
    super(message);
    this.name = 'InputError';
    this.failureCode = failureCode || FAILURE_CODES.UPSTREAM_UNAVAILABLE;
  }
}

/**
 * Map whatever format string the caller sent onto the new pipeline's
 * supported set. Unsupported formats throw.
 *
 * @param {string} raw
 * @returns {string}
 */
function normalizeFormat(raw) {
  const s = String(raw || '').toLowerCase();
  if (['picture_book', 'picturebook', 'picture-book'].includes(s)) return FORMATS.PICTURE_BOOK;
  if (['early_reader', 'earlyreader', 'early-reader'].includes(s)) return FORMATS.EARLY_READER;
  throw new InputError(`unsupported format: ${raw}`);
}

/**
 * Map a numeric age to one of the supported age bands.
 *
 * Accepts fractional ages (e.g. 0.58 for a 7-month-old). Uses Number, not
 * parseInt, so a 7-month-old does not silently truncate to 0 and route as a
 * 2-year-old. Infant band (PB_INFANT) covers under ~18 months — the lap-baby
 * tier where the book is read TO the baby and the hero cannot stand,
 * walk, run, climb, or grab moving objects.
 *
 * @param {number|string} age
 * @param {string} format
 * @returns {string}
 */
function normalizeAgeBand(age, format) {
  const n = Number(age);
  if (!Number.isFinite(n) || n < 0) {
    return format === FORMATS.EARLY_READER ? AGE_BANDS.ER_EARLY : AGE_BANDS.PB_PRESCHOOL;
  }
  // Early-reader format always routes to the early-reader band, even if the
  // numeric age would otherwise pick a younger picture-book band.
  if (format === FORMATS.EARLY_READER) return AGE_BANDS.ER_EARLY;
  if (n < 1.5) return AGE_BANDS.PB_INFANT;
  if (n <= 3) return AGE_BANDS.PB_TODDLER;
  return AGE_BANDS.PB_PRESCHOOL;
}

function extractInterestsArray(src, raw) {
  const fromChild = src.interests || src.childInterests;
  const fromTop = raw.childInterests || raw.child_interests;
  let arr = fromChild || fromTop;
  if (typeof arr === 'string' && arr.trim()) return [arr.trim()];
  if (!Array.isArray(arr)) {
    const fav = src.favorite_activities || raw.favorite_activities;
    if (typeof fav === 'string' && fav.trim()) return fav.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
    return [];
  }
  return arr.map(s => String(s).trim()).filter(Boolean);
}

/**
 * @param {object} raw
 * @returns {object}
 */
function extractChild(raw) {
  const src = raw.child || raw;
  const name = src.name || src.childName || raw.childName || '';
  // PR L — age must NOT use `||` here. Lap babies legitimately resolve to
  // `age = 0` (full integer years for an under-1.5 child), and `0 || x`
  // silently falls through to the next operand. That trap was discarding
  // PR K's birth-date-derived age=0 for an 8-month-old and falling back to
  // the stale `raw.childAge` (e.g. 2) the client had sent, routing the book
  // to PB_TODDLER instead of PB_INFANT and bypassing every infant-band PR
  // (H/I/J.1/J.4). Use `??` so only null/undefined fall through; a real 0
  // is preserved end-to-end.
  const age = src.age ?? src.childAge ?? raw.childAge ?? null;
  const gender = src.gender || raw.gender || 'unspecified';
  const pronouns = src.pronouns || raw.pronouns || null;
  const anecdotes = src.anecdotes || raw.anecdotes || {};
  const interests = extractInterestsArray(src, raw);
  const appearanceRaw = src.appearance || src.childAppearance || raw.childAppearance || raw.appearance || '';
  const appearance = typeof appearanceRaw === 'string' && appearanceRaw.trim() ? appearanceRaw.trim() : undefined;
  const child = { name, age, gender, pronouns, anecdotes };
  if (interests.length > 0) child.interests = interests;
  if (appearance) child.appearance = appearance;
  return child;
}

/**
 * @param {object} raw
 * @returns {object}
 */
function extractCustomDetails(raw) {
  const src = raw.book?.customDetails || raw.customDetails || {};
  if (typeof src === 'string') return { freeText: src };
  if (src && typeof src === 'object') return { ...src };
  return {};
}

/**
 * Extract the approved cover. The new pipeline requires an existing,
 * user-approved cover before interior work begins.
 *
 * @param {object} raw
 * @returns {{ title: string, imageUrl: string, imageBase64: string|null, imageStorageKey?: string, characterLocks: object, outfitLocks: object }}
 */
function extractCover(raw) {
  const src = raw.cover || raw.approvedCover || {};
  const title = src.title || raw.title || raw.approvedTitle || '';
  const imageUrl = src.imageUrl || src.url || raw.coverImageUrl || '';
  const imageBase64 = src.imageBase64 || raw.coverImageBase64 || null;
  const imageStorageKey = src.imageStorageKey || src.gcsPath || raw.coverImageGcsPath || raw.coverGcsPath || '';

  if (!imageUrl && !imageBase64 && !imageStorageKey) {
    throw new InputError('approved cover is required', FAILURE_CODES.COVER_MISSING);
  }
  if (!title) {
    throw new InputError('approved cover title is required', FAILURE_CODES.COVER_MISSING);
  }

  return {
    title,
    imageUrl,
    imageBase64,
    ...(imageStorageKey ? { imageStorageKey } : {}),
    characterLocks: src.characterLocks || {},
    outfitLocks: src.outfitLocks || {},
  };
}

/**
 * Extract a small set of creative goals/constraints that downstream stages
 * can consult. The rest of the creative direction is hardcoded into the
 * pipeline prompts so behavior stays opinionated.
 *
 * @param {object} raw
 * @returns {object}
 */
function extractCreativeGoals(raw) {
  const book = raw.book || {};
  return {
    tonePreference: book.tone || raw.tone || null,
    humorStrength: book.humor || raw.humor || 'character_based',
    rhymeOverride: book.rhyme ?? null,
    narrationOverride: book.narration ?? null,
  };
}

/**
 * Main entry: takes the raw request and returns `{ request, brief, cover }`.
 *
 * @param {object} raw
 * @param {{ operationalContext?: object }} [_opts] - unused here; reserved for symmetry
 * @returns {Promise<{ request: object, brief: object, cover: object }>}
 */
async function normalizeRequest(raw, _opts = {}) {
  if (!raw || typeof raw !== 'object') throw new InputError('request payload missing');

  const format = normalizeFormat(raw.format || raw.book?.format);
  const theme = String(raw.theme || raw.book?.theme || 'adventure').toLowerCase();
  const child = extractChild(raw);
  const ageBand = normalizeAgeBand(child.age, format);
  const customDetails = extractCustomDetails(raw);
  const cover = extractCover(raw);
  const creativeGoals = extractCreativeGoals(raw);

  const request = {
    bookId: raw.bookId || raw.id || null,
    format,
    theme,
    ageBand,
    callbackUrl: raw.callbackUrl || null,
    ...(typeof raw.useQuadSpreadIllustrator === 'boolean'
      ? { useQuadSpreadIllustrator: raw.useQuadSpreadIllustrator }
      : {}),
  };

  const brief = {
    child,
    customDetails,
    creativeGoals,
    constraints: {
      language: raw.language || 'en',
      locale: raw.locale || 'en-US',
    },
    // Whether the themed parent (mom on Mother's Day, dad on Father's Day)
    // is present on the approved cover. Set here ONLY if the caller passed
    // an explicit boolean — otherwise left undefined and resolved later by
    // the bookPipeline detectCoverComposition stage, which runs Vision on
    // the actual cover image to determine the truth.
    //
    // We deliberately do NOT apply a theme default here. The previous
    // `mothers_day → true` default was unsafe: when the customer's chosen
    // primary cover doesn't include Mom (a child-only Love-to-mom cover),
    // the wrong default cascaded through systemInstruction.js → consistencyQa
    // → illustrator and produced books with full-body Mom appearing
    // inconsistently across spreads. Authoritative detection happens in
    // detectCoverComposition.js.
    //
    // Reading order downstream:
    //   1. Explicit caller value (this field, set when caller passed boolean).
    //   2. Vision detection result (set by detectCoverComposition).
    //   3. Safe fallback: false.
    ...(typeof resolveExplicitCoverParentPresent(raw) === 'boolean'
      ? { coverParentPresent: resolveExplicitCoverParentPresent(raw) }
      : {}),
  };

  return { request, brief, cover };
}

/**
 * Read an explicit caller-supplied coverParentPresent value, supporting
 * camelCase and the snake_case legacy field. Returns null if neither is
 * present so the caller can distinguish "explicitly false" from "absent".
 *
 * @param {object} raw - the inbound /generate-book payload
 * @returns {boolean|null}
 */
function resolveExplicitCoverParentPresent(raw) {
  if (typeof raw?.coverParentPresent === 'boolean') return raw.coverParentPresent;
  if (typeof raw?.cover_parent_present === 'boolean') return raw.cover_parent_present;
  return null;
}

module.exports = {
  normalizeRequest,
  InputError,
  extractChild,
  extractCustomDetails,
  // Exported for unit tests — the public entry point is normalizeRequest.
  normalizeAgeBand,
  normalizeFormat,
};
