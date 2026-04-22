/**
 * Illustrator V2 — Configuration
 *
 * Models, timeouts, sliding window settings, and text rules.
 * Art style configs are imported from illustrationGenerator.js (single source of truth).
 */

const { ART_STYLE_CONFIG, PARENT_THEMES } = require('../illustrationGenerator');

// ── Gemini models ──
const GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image-preview';
const GEMINI_QA_MODEL = 'gemini-2.5-flash';
const CHAT_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// ── Timeouts ──
const TURN_TIMEOUT_MS = 180000;       // 3 minutes per generation turn
const QA_TIMEOUT_MS = 60000;          // 1 minute per QA call
const ESTABLISHMENT_TIMEOUT_MS = 60000; // 1 minute for character establishment

// ── Sliding window ──
const SLIDING_WINDOW_SIZE = 4;  // Keep last 4 generated spread images for better style continuity
const MAX_HISTORY_IMAGES = 8;  // Start trimming above this (keeps token budget safe)
/** Approximate max total inline image payload in chat history before trimming (bytes, base64 decoded). */
const MAX_HISTORY_IMAGE_BYTES = 6 * 1024 * 1024;

// ── Retry budgets ──
const MAX_SPREAD_RETRIES = 6;           // Per-spread QA retry limit (within session)
const MAX_FRESH_SESSION_RETRIES = 5;    // Fresh-session fallbacks when in-session retries exhausted
const MAX_REGEN_SPREADS = 5;           // Regen worst offenders first (sorted by batch hits); limits oscillation vs full-book regen
const MAX_CONSISTENCY_ROUNDS = 5;      // Book-wide consistency regen rounds before accepting anyway
/** Max decoded bytes for reference thumbnails in one consistency-regen multimodal turn (payload + token safety). */
const CONSISTENCY_REGEN_MAX_THUMB_BYTES = 3 * 1024 * 1024;
/** Hard cap on number of reference thumbnails. Regen is stateless, so the only token cost
 * is these thumbnails + child photo + cover + prompt — ~25k tokens at 10 thumbs (well under 131k). */
const CONSISTENCY_REGEN_MAX_THUMBS = 10;
const QA_HTTP_ATTEMPTS = 3;            // Retries per vision QA HTTP call before fail-closed
const MAX_GENERATION_RETRIES = 5;      // Raw image generation attempts before aborting a spread (6 total: attempt 0..5)
const GENERATION_RETRY_BASE_DELAY_MS = 3000;  // Base delay for exponential backoff between generation attempts

// ── Image generation token budget ──
const GEMINI_IMAGE_MAX_OUTPUT_TOKENS = 8192; // maxOutputTokens for spread image turns (TEXT+IMAGE)

// ── Book structure ──
const TOTAL_SPREADS = 13;

// ── Text rules ──
const TEXT_RULES = {
  maxWordsPerLine: 6,
  edgePaddingPercent: 10,
  topPaddingPercent: 22, // Extra top padding — PDF assembly crops the 16:9 image vertically and the top can lose several percent; 22% leaves safe room after crop
  bottomPaddingPercent: 15, // Extra bottom padding — vertical crop during PDF assembly removes bottom content
  centerExclusionPercent: 15, // 15% on each side of center = middle 30% no-text zone
  fontStyle: 'A plain, traditional book serif resembling Georgia or Book Antiqua, regular weight. Upright (never italic), round and even letterforms, moderate x-height, consistent stroke contrast. STRICTLY FORBIDDEN: handwritten, script, cursive, calligraphic, italic, bold display, bubble, rounded sans-serif, Comic Sans, Papyrus, Chalkboard, Impact, Marker, decorative, thin modern sans, condensed, or stenciled fonts. If in doubt, render it as plain Georgia regular.',
  fontColor: 'white/cream with subtle drop shadow',
  fontSize: 'very small, like movie subtitles — MUCH smaller than a headline or title. If in doubt, make the text smaller.',
};

// ── Emotional beat mapping (spread position -> beat) ──
function getEmotionalBeat(spreadIndex, totalSpreads) {
  const ratio = spreadIndex / (totalSpreads - 1);
  if (ratio <= 0.15) return 'opening';
  if (ratio <= 0.4) return 'building';
  if (ratio <= 0.6) return 'rising';
  if (ratio <= 0.8) return 'climax';
  if (ratio <= 0.92) return 'resolution';
  return 'closing';
}

// ── Camera angle suggestions per beat ──
const BEAT_CAMERA = {
  opening: 'wide establishing shot — show the setting and character',
  building: 'medium shot — character engaged in activity',
  rising: 'medium-close — growing emotion visible',
  climax: 'close-up or dynamic angle — peak emotion',
  resolution: 'medium shot — calm, warm moment',
  closing: 'wide or medium — sense of completion',
};

module.exports = {
  GEMINI_IMAGE_MODEL,
  GEMINI_QA_MODEL,
  CHAT_API_BASE,
  TURN_TIMEOUT_MS,
  QA_TIMEOUT_MS,
  ESTABLISHMENT_TIMEOUT_MS,
  SLIDING_WINDOW_SIZE,
  MAX_HISTORY_IMAGES,
  MAX_HISTORY_IMAGE_BYTES,
  MAX_SPREAD_RETRIES,
  MAX_FRESH_SESSION_RETRIES,
  MAX_REGEN_SPREADS,
  MAX_CONSISTENCY_ROUNDS,
  CONSISTENCY_REGEN_MAX_THUMB_BYTES,
  CONSISTENCY_REGEN_MAX_THUMBS,
  QA_HTTP_ATTEMPTS,
  MAX_GENERATION_RETRIES,
  GENERATION_RETRY_BASE_DELAY_MS,
  GEMINI_IMAGE_MAX_OUTPUT_TOKENS,
  TOTAL_SPREADS,
  TEXT_RULES,
  ART_STYLE_CONFIG,
  PARENT_THEMES,
  getEmotionalBeat,
  BEAT_CAMERA,
};
