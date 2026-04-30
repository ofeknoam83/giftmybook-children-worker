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

/**
 * Per-request thresholds for the image model. BLOCK_ONLY_HIGH reduces false
 * PROHIBITED_CONTENT / OTHER on wholesome child scenes; core child-safety
 * policies remain (cannot be disabled via API).
 *
 * @type {Array<{ category: string, threshold: string }>}
 */
const GEMINI_IMAGE_SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
];

// ── OpenAI image model (gpt-image-2) ──
// The OpenAI Images 2.0 API is stateless — each call re-sends the cover +
// last N accepted spreads as reference images along with the per-spread
// prompt. The adapter (services/illustrator/openaiImageSession.js) emulates
// the Gemini chat-session interface so the orchestrator can swap providers
// by flipping `MODELS.SPREAD_RENDER` in bookPipeline/constants.js.
const OPENAI_IMAGE_MODEL = 'gpt-image-2';
/** DALL·E 2–only in many accounts; do not use for `gpt-image-2` (see `OPENAI_IMAGES_GENERATIONS_URL`). */
const OPENAI_IMAGES_EDIT_URL = 'https://api.openai.com/v1/images/edits';
/** Reference-image + `gpt-image-2` jobs: production API returns 400 on `/v1/images/edits` for this model — use generations. */
const OPENAI_IMAGES_GENERATIONS_URL = 'https://api.openai.com/v1/images/generations';
// 16:9 landscape, both edges multiples of 16, ratio 1.78 ≈ 16:9, total
// pixels ≈ 1.8M (inside gpt-image-2's 655k-8.3M window).
const OPENAI_IMAGE_SIZE = '1792x1008';
/** 4:1 ultra-wide for dual-spread batches (OpenAI generations). Falls back documented in CLAUDE.md if the API rejects. */
const OPENAI_QUAD_IMAGE_SIZE = '1792x448';
// Spreads + cover harmonize use `images/generations` (with `image[]` refs) for
// gpt-image-2. The `quality` form field applies to that endpoint, not to legacy
// DALL·E `images/edits`.
// Kept for documentation / a future switch to the generations endpoint.
const OPENAI_IMAGE_QUALITY = 'medium';

// ── Timeouts ──
const TURN_TIMEOUT_MS = 180000;          // 3 minutes per image generation turn
/** 4:1 dual-spread turns are heavier; give the API longer before client abort. */
const TURN_TIMEOUT_QUAD_MS = 300000;   // 5 minutes
const QA_TIMEOUT_MS = 45000;             // 45s per vision QA call
const ESTABLISHMENT_TIMEOUT_MS = 180000; // first turn generates the reference sheet — same budget as a spread turn

// ── Retry budgets ──
// Higher values improve pass rates on difficult spreads but increase latency and
// API cost roughly linearly (each correction is another image + QA). Tune down if
// cost or time becomes an issue after observing production pass rates.
const MAX_SPREAD_CORRECTIONS = 6;   // per-spread in-session corrections → 1 initial + 6 = 7 attempts per session before rebuild
const MAX_SESSION_REBUILDS = 2;     // full session rebuilds per spread (safety + QA exhaustion); worst case ≈ 7 × 3 = 21 attempts
const QA_HTTP_ATTEMPTS = 3;         // retries per vision QA HTTP call before fail-open (infra)

/** Consecutive model safety blocks on the same spread before appending a stricter "no in-world text" scene clause. */
const SAFETY_STRIKES_BEFORE_SCENE_DEESCAL = 2;

// ── Sliding window ──
const SLIDING_WINDOW_ACCEPTED_SPREADS = 3; // pinned ref + last N accepted spreads travel in history
const GEMINI_IMAGE_MAX_OUTPUT_TOKENS = 8192;

// ── Book structure ──
const TOTAL_SPREADS = 13;

// ── Text rules (identical for every spread — one hard lock, no per-book variation) ──
//
// Single-side text rule:
//   All of a spread's text lives on ONE side only (LEFT or RIGHT), never both.
//   The side alternates deterministically by spread index (even→LEFT, odd→RIGHT)
//   unless the caller overrides via entry.textSide. The opposite side is left
//   text-free so the illustration breathes. The center band is a hard no-text zone.
const TEXT_RULES = {
  maxWordsPerLine: 6,
  // Minimum distance from the outer-side edge so the caption never risks
  // being clipped by the printer trim.
  edgePaddingPercent: 7,
  // Minimum distance of the caption block from the top edge of the frame.
  // Picture-book PDFs are full-bleed; Lulu trim/bleed plus `layoutEngine`
  // vertical center-crop on 16:9→square spreads can shave the top and bottom
  // of the art. Keep type well inside so ascenders never clip.
  cornerVerticalPaddingPercent: 26,
  // Explicit top/bottom inset (bottom larger — print crop + descenders; models hug bottom).
  topPaddingPercent: 26,
  bottomPaddingPercent: 36,
  // Horizontal bounds for the text block on the active side (fractions of width):
  //   LEFT  side: text block fully inside x ∈ [edge/100, activeSideMaxPercent/100]
  //   RIGHT side: text block fully inside x ∈ [1 - activeSideMaxPercent/100, 1 - edge/100]
  // activeSideMaxPercent 35 → center no-text band x ∈ [0.35, 0.65] (30% of width) for OCR QA
  activeSideMaxPercent: 35,
  fontStyle: 'A plain, traditional book serif resembling Georgia or Book Antiqua, regular weight. Upright (never italic), round and even letterforms, moderate x-height, consistent stroke contrast. STRICTLY FORBIDDEN: handwritten, script, cursive, calligraphic, italic, bold display, bubble, rounded sans-serif, Comic Sans, Papyrus, Chalkboard, Impact, Marker, decorative, thin modern sans, condensed, stenciled. If in doubt, render as plain Georgia regular.',
  // One art-director spec for the whole book — models drift if each spread re-invents type.
  typographyConsistency: 'BOOK-WIDE LOCK (all 13 spreads + session history): The caption must use the **identical** font family, weight, and general character of stroke as every other spread in this book — one continuous series, one subtitle spec. **Do not** use a different face, weight, or a noticeably larger/smaller point size on later spreads. Match the **apparent** cap height and line spacing you used on earlier interior frames in this same chat (if any) so parents see one calm, consistent caption treatment through the book. You may only vary how light falls on the letters (color temperature, soft shadow) to match each scene’s blend — not the underlying type scale or family.',
  // Type must read as in-world, lit by the same environment as the characters — not
  // a generic subtitle overlay. Per-spread, vary warmth/cool and shadow to match.
  fontColor: 'Match the scene’s light. Warm ivory, honey, or desaturated warm white in tungsten, sunset, or golden-hour air; cool blue-gray, silver, or desaturated near-white in moonlight; soft green-tinged or neutral off-white in forest shade. Never the same flat pure-white on every spread — tune fill color to the local background. Edge/shadow: a whisper-soft contact shadow and/or haze, with direction and softness consistent with the frame’s key light and depth fog — not a one-size-fits-all hard black drop shadow.',
  fontSize: 'Modest, **very readable** on print — the comfortable middle: clearly legible (never miniature or faint), but **not** large and never “cover title” scale. Think restrained film subtitle: **small** on the art, but sharp and easy to read at arm’s length. That same legible modest size on **every** spread; do not grow or shrink the type dramatically versus prior spreads in this book.',
  // Extra guidance for prompt builders and system instruction (not always concatenated in old paths).
  textIntegration: 'The caption is part of the same cinematic 3D frame: same color grade, same atmospheric haze, same exposure logic. No floating UI bar, no sharp rectangular panel behind lines, no sticker-like cutout with mismatched brightening, no highlighter blocks. If the rest of the frame is backlit, let the type pick up a slight rim/edge that matches. If there is depth fog, letters soften very slightly at the micro-edges. Readability is mandatory, but the text must "live in" the light of the world, not sit on top as a separate layer of flat graphic design. **Typography** stays stable book-wide; only local light/color on the glyphs may shift for blend.',
};

/**
 * Picture-book caption margins by age (years):
 * - **Under 3:** baby/toddler gift books (incl. orders “for” a 6-month-old where
 *   API age may clamp to 2). Extra bottom lift + top-only caption corners via
 *   `resolveSideAndCorner(..., childAge)`.
 * - **3–8:** longer read-aloud lines — compact type tier + widened horizontal pad.
 *
 * @param {number|string|null|undefined} childAge
 * @returns {typeof TEXT_RULES}
 */
function resolvePictureBookTextRules(childAge) {
  const n = Number(childAge);
  if (!Number.isFinite(n)) {
    return { ...TEXT_RULES };
  }

  if (n < 3) {
    return {
      ...TEXT_RULES,
      edgePaddingPercent: 8,
      topPaddingPercent: 28,
      cornerVerticalPaddingPercent: 28,
      // Maximum lift from PDF bottom crop — parents often hold book low; models hug bottom.
      bottomPaddingPercent: 48,
      fontSize:
        `${TEXT_RULES.fontSize} **Baby/toddler book (under 3):** Treat bottom margin as **sacred** — captions must never crowd the lower edge (descenders, multi-line stacks). The layout may map your spread to a **top** corner only; if you still render a lower caption, bias it **well upward** with obvious empty space below.`,
      typographyConsistency:
        `${TEXT_RULES.typographyConsistency} This book is for a **very young** child — err on the side of **extra** vertical clearance on every spread.`,
    };
  }

  if (n > 8) {
    return { ...TEXT_RULES };
  }

  return {
    ...TEXT_RULES,
    maxWordsPerLine: 7,
    edgePaddingPercent: 8,
    // Taller multi-line stacks need more lift from the bottom crop zone.
    bottomPaddingPercent: 42,
    fontSize:
      '**Compact read-aloud tier (ages 3–8, longer lines):** Use a **slightly smaller** on-image caption than a typical toddler picture book — still crisp, sharp, and easy to read at arm’s length, but stepped down one clear notch so a multi-line block never crowds the vertical safe zone. Modest film subtitle, not miniature; never poster or title scale. Hold this **same** compact size on every spread.',
    typographyConsistency:
      `${TEXT_RULES.typographyConsistency} This book uses the **compact read-aloud** size tier — match that slightly smaller baseline on every spread; do not drift back to a larger "little kid" caption scale.`,
  };
}

/**
 * Bottom caption corners risk PDF crop + model drift; parents reading to infants
 * often hold the book low. For age &lt; 3 (years), map bottom → top on same side.
 *
 * @param {'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'} corner
 * @param {number|string|null|undefined} childAge
 * @returns {'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'}
 */
function preferTopCornersOnlyUnderThree(corner, childAge) {
  const n = Number(childAge);
  if (!Number.isFinite(n) || n >= 3) return corner;
  if (corner === 'bottom-left') return 'top-left';
  if (corner === 'bottom-right') return 'top-right';
  return corner;
}

// ── Frozen 3D Premium Pixar style — CANNOT be overridden from outside the module ──
// Every word here skews toward **3D CGI feature-film render**. Words that pull
// the model toward 2D (flat illustration, painted, soft illustration, hand-drawn,
// storybook illustration, watercolor, etc.) are intentionally EXCLUDED from the
// positive prompt and listed in `antiStyle` so we can re-inject them as a
// NOT-THIS block in prompts. Observed empirically: Gemini averages mixed cues
// so mixing "soft render" + "children's book illustration" with "3D CGI" gave
// us a 2D illustrated look — we had to separate positive (3D) from negative
// (2D) instead of blending them in one sentence.
const PIXAR_STYLE = {
  prefix: 'Cinematic 3D Pixar feature-film CGI still,',
  suffix: [
    'photorealistic 3D CGI render (NOT a 2D illustration, NOT a flat painting, NOT a storybook illustration)',
    'Disney-Pixar feature-film production quality — reads like a high-resolution frame from a modern Pixar movie',
    'physically based 3D modeling — real three-dimensional character geometry with volume, weight, and rim-lit silhouettes',
    'photoreal subsurface skin scattering on faces, ears, and hands (warm backlit translucency)',
    'individually rendered hair strands with light passing through, not painted hair shapes',
    'physically based materials — real fabric weave, real wood grain, real foliage geometry',
    'ray-traced volumetric cinematic lighting with soft shadows, ambient occlusion, and studio key-fill-rim setup',
    'true optical lens depth-of-field with genuine bokeh (circular highlights from physical lenses), not a painterly blur',
    'warm saturated color palette, emotionally expressive face and body acting',
    'magical, cinematic atmosphere',
  ].join(', '),
  antiStyle: [
    'NOT a 2D flat illustration',
    'NOT a painterly children\'s book illustration',
    'NOT watercolor, gouache, pencil, pen-and-ink, cel-shaded anime, paper cutout, pixel art, or vector style',
    'NOT a hand-drawn soft storybook look',
    'NOT a digital painting or concept painting',
    'NOT a flat graphic illustration with a blurred background',
    'the characters must read as real 3D models, not as drawings with soft shading',
  ].join('; '),
};

// Themes where the parent is implied (hands/back-of-head) when they are not on the cover.
const PARENT_THEMES = new Set(['mothers_day', 'fathers_day']);

/**
 * Deterministic side selector — even spread index → LEFT, odd → RIGHT.
 * Deterministic + alternating keeps visual variety across the book while
 * guaranteeing the exact same composition decisions on a regen of any spread.
 *
 * @param {number} spreadIndex - 0-based
 * @returns {'left' | 'right'}
 */
function defaultTextSide(spreadIndex) {
  return (Number(spreadIndex) % 2 === 0) ? 'left' : 'right';
}

/**
 * Deterministic corner selector. Pairs with `defaultTextSide` and rotates
 * across all four corners over every 4 spreads so a 13-spread book gets
 * real top/bottom + left/right variety (not every caption in the same
 * corner of the frame). Given `side` is a function of index parity, the
 * corner rotation just adds a top/bottom alternation per side.
 *
 *   index % 4 === 0 → top-left    (side=left)
 *   index % 4 === 1 → bottom-right (side=right)
 *   index % 4 === 2 → bottom-left  (side=left)
 *   index % 4 === 3 → top-right    (side=right)
 *
 * @param {number} spreadIndex - 0-based
 * @returns {'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'}
 */
function defaultTextCorner(spreadIndex) {
  const mod = ((Number(spreadIndex) % 4) + 4) % 4;
  switch (mod) {
    case 0: return 'top-left';
    case 1: return 'bottom-right';
    case 2: return 'bottom-left';
    case 3: return 'top-right';
    default: return 'top-left';
  }
}

/**
 * Resolve a {side, corner} pair. If a caller overrides `side` but not
 * `corner`, pick the corner that sits on the chosen side — preferring the
 * default index-derived corner when it already matches, otherwise the
 * top-of-side fallback.
 *
 * @param {number} spreadIndex
 * @param {'left' | 'right'} [side]
 * @param {string} [corner]
 * @param {number|string|null|undefined} [childAge] - Under 3: bottom corners → top (same side).
 * @returns {{ side: 'left' | 'right', corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' }}
 */
function resolveSideAndCorner(spreadIndex, side, corner, childAge) {
  const validCorners = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const resolvedSide = (side === 'left' || side === 'right') ? side : defaultTextSide(spreadIndex);
  const defaultCorner = defaultTextCorner(spreadIndex);
  let resolvedCorner = validCorners.includes(corner) ? corner : defaultCorner;
  // If the explicit side disagrees with the corner, fall back to a corner
  // on the right side of the frame (top-of-side keeps it natural for captions).
  if (!resolvedCorner.endsWith(resolvedSide)) {
    resolvedCorner = defaultCorner.endsWith(resolvedSide) ? defaultCorner : `top-${resolvedSide}`;
  }
  resolvedCorner = preferTopCornersOnlyUnderThree(resolvedCorner, childAge);
  return { side: resolvedSide, corner: resolvedCorner };
}

module.exports = {
  GEMINI_IMAGE_MODEL,
  GEMINI_QA_MODEL,
  CHAT_API_BASE,
  GEMINI_IMAGE_SAFETY_SETTINGS,
  OPENAI_IMAGE_MODEL,
  OPENAI_IMAGES_EDIT_URL,
  OPENAI_IMAGES_GENERATIONS_URL,
  OPENAI_IMAGE_SIZE,
  OPENAI_QUAD_IMAGE_SIZE,
  OPENAI_IMAGE_QUALITY,
  TURN_TIMEOUT_MS,
  TURN_TIMEOUT_QUAD_MS,
  QA_TIMEOUT_MS,
  ESTABLISHMENT_TIMEOUT_MS,
  MAX_SPREAD_CORRECTIONS,
  MAX_SESSION_REBUILDS,
  QA_HTTP_ATTEMPTS,
  SAFETY_STRIKES_BEFORE_SCENE_DEESCAL,
  SLIDING_WINDOW_ACCEPTED_SPREADS,
  GEMINI_IMAGE_MAX_OUTPUT_TOKENS,
  TOTAL_SPREADS,
  TEXT_RULES,
  resolvePictureBookTextRules,
  preferTopCornersOnlyUnderThree,
  PIXAR_STYLE,
  PARENT_THEMES,
  defaultTextSide,
  defaultTextCorner,
  resolveSideAndCorner,
};
