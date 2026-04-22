/**
 * Illustrator — Configuration
 *
 * One source of truth for the new picture-book pipeline:
 * models, timeouts, retry budgets, sliding-window size, text rules,
 * and the FROZEN 3D Premium Pixar style descriptor (no per-book style switching).
 */

// ── Gemini models ──
const GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image-preview';
const GEMINI_QA_MODEL = 'gemini-2.5-flash';
const CHAT_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// ── Timeouts ──
const TURN_TIMEOUT_MS = 180000;          // 3 minutes per image generation turn
const QA_TIMEOUT_MS = 45000;             // 45s per vision QA call
const ESTABLISHMENT_TIMEOUT_MS = 180000; // first turn generates the reference sheet — same budget as a spread turn

// ── Retry budgets ──
const MAX_SPREAD_CORRECTIONS = 2;   // per-spread in-session correction retries before giving up
const MAX_SESSION_REBUILDS = 1;     // safety-block recovery: rebuild once, no cascades
const QA_HTTP_ATTEMPTS = 3;         // retries per vision QA HTTP call before fail-open (infra)

// ── Sliding window ──
const SLIDING_WINDOW_ACCEPTED_SPREADS = 3; // pinned ref + last N accepted spreads travel in history
const GEMINI_IMAGE_MAX_OUTPUT_TOKENS = 8192;

// ── Book structure ──
const TOTAL_SPREADS = 13;

// ── Text rules (identical for every spread — one hard lock, no per-book variation) ──
const TEXT_RULES = {
  maxWordsPerLine: 6,
  edgePaddingPercent: 10,
  topPaddingPercent: 22,
  bottomPaddingPercent: 15,
  centerExclusionPercent: 17, // each side of the midline — 34% total no-text band
  fontStyle: 'A plain, traditional book serif resembling Georgia or Book Antiqua, regular weight. Upright (never italic), round and even letterforms, moderate x-height, consistent stroke contrast. STRICTLY FORBIDDEN: handwritten, script, cursive, calligraphic, italic, bold display, bubble, rounded sans-serif, Comic Sans, Papyrus, Chalkboard, Impact, Marker, decorative, thin modern sans, condensed, stenciled. If in doubt, render as plain Georgia regular.',
  fontColor: 'white/cream with a subtle soft drop shadow',
  fontSize: 'small — like movie subtitles, NOT a headline or title. The illustration is the star.',
};

// ── Frozen 3D Premium Pixar style — CANNOT be overridden from outside the module ──
// Copied from services/illustrationGenerator.js ART_STYLE_CONFIG.pixar_premium and pinned here
// so the picture-book pipeline has no style switch and every spread matches every other spread.
const PIXAR_STYLE = {
  prefix: "Cinematic 3D Pixar-like soft render children's book illustration,",
  suffix: 'photorealistic 3D CGI render, soft volumetric cinematic lighting, subsurface skin scattering, warm saturated color palette, emotionally expressive face and posture, rich fabric textures, dreamy depth-of-field bokeh background, Disney-Pixar production quality, magical storybook atmosphere',
};

// Themes where the parent is implied (hands/back-of-head) when they are not on the cover.
const PARENT_THEMES = new Set(['mothers_day', 'fathers_day']);

module.exports = {
  GEMINI_IMAGE_MODEL,
  GEMINI_QA_MODEL,
  CHAT_API_BASE,
  TURN_TIMEOUT_MS,
  QA_TIMEOUT_MS,
  ESTABLISHMENT_TIMEOUT_MS,
  MAX_SPREAD_CORRECTIONS,
  MAX_SESSION_REBUILDS,
  QA_HTTP_ATTEMPTS,
  SLIDING_WINDOW_ACCEPTED_SPREADS,
  GEMINI_IMAGE_MAX_OUTPUT_TOKENS,
  TOTAL_SPREADS,
  TEXT_RULES,
  PIXAR_STYLE,
  PARENT_THEMES,
};
