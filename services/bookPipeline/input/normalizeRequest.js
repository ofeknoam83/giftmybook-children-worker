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
 * Map a numeric age to one of the three supported age bands.
 *
 * @param {number|string} age
 * @param {string} format
 * @returns {string}
 */
function normalizeAgeBand(age, format) {
  const n = Number.parseInt(age, 10);
  if (!Number.isFinite(n)) {
    return format === FORMATS.EARLY_READER ? AGE_BANDS.ER_EARLY : AGE_BANDS.PB_PRESCHOOL;
  }
  if (format === FORMATS.EARLY_READER) return AGE_BANDS.ER_EARLY;
  if (n <= 3) return AGE_BANDS.PB_TODDLER;
  return AGE_BANDS.PB_PRESCHOOL;
}

/**
 * @param {object} raw
 * @returns {object}
 */
function extractChild(raw) {
  const src = raw.child || raw;
  const name = src.name || src.childName || raw.childName || '';
  const age = src.age || src.childAge || raw.childAge || null;
  const gender = src.gender || raw.gender || 'unspecified';
  const pronouns = src.pronouns || raw.pronouns || null;
  const anecdotes = src.anecdotes || raw.anecdotes || {};
  return { name, age, gender, pronouns, anecdotes };
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
  };

  return { request, brief, cover };
}

module.exports = {
  normalizeRequest,
  InputError,
};
