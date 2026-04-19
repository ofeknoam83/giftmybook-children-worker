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
const MAX_HISTORY_IMAGES = 14;  // Start trimming above this

// ── Retry budgets ──
const MAX_SPREAD_RETRIES = 6;       // Per-spread QA retry limit (within session)
const MAX_FRESH_SESSION_RETRIES = 2; // Fresh-session fallbacks when in-session retries exhausted
const MAX_REGEN_SPREADS = 3;        // Max spreads to regenerate after cross-spread QA

// ── Book structure ──
const TOTAL_SPREADS = 13;

// ── Text rules ──
const TEXT_RULES = {
  maxWordsPerLine: 6,
  edgePaddingPercent: 10,
  bottomPaddingPercent: 15, // Extra bottom padding — vertical crop during PDF assembly removes bottom content
  centerExclusionPercent: 15, // 15% on each side of center = middle 30% no-text zone
  fontStyle: 'Georgia serif font — plain, clean, traditional serif with round letterforms and moderate x-height. NO decorative fonts, NO swashes, NO italic, NO condensed, NO handwritten, NO display fonts',
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
  MAX_SPREAD_RETRIES,
  MAX_FRESH_SESSION_RETRIES,
  MAX_REGEN_SPREADS,
  TOTAL_SPREADS,
  TEXT_RULES,
  ART_STYLE_CONFIG,
  PARENT_THEMES,
  getEmotionalBeat,
  BEAT_CAMERA,
};
