/**
 * Illustrator — Configuration
 *
 * One source of truth for the new picture-book pipeline:
 * models, timeouts, retry budgets, sliding-window size, text rules,
 * and the FROZEN 3D Premium Pixar style descriptor (no per-book style switching).
 */

// ── Gemini models ──
const GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image';
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
// The OpenAI Images 2.0 API is stateless — each call re-sends reference
// images along with the prompt.
const OPENAI_IMAGE_MODEL = 'gpt-image-2';
/**
 * Reference-image-conditioned generation for `gpt-image-2` lives on the EDIT
 * endpoint (multipart). `gpt-image-2` is identity-preserving across calls
 * when references are attached as `image[]` parts. Up to 16 references per
 * request, each PNG/WebP/JPEG, < 50 MB, with a proper multipart filename.
 *
 * Earlier comments in this file claimed `/v1/images/edits` returned 400 for
 * `gpt-image-2`. That was an incorrect diagnosis of a multipart-formatting
 * bug (raw fetch + Blob without filename) — see `openai-node#1844`. The
 * adapter now sends a filename + Content-Type per part, which is what
 * production needs.
 */
const OPENAI_IMAGES_EDIT_URL = 'https://api.openai.com/v1/images/edits';
/** Text-to-image only (JSON body); does NOT accept reference images on this endpoint for any image model. */
const OPENAI_IMAGES_GENERATIONS_URL = 'https://api.openai.com/v1/images/generations';
// 1:1 square — the picture-book interior page is 8.5×8.5", so a square
// illustration maps cleanly onto one page of the spread. The opposite page
// carries the manuscript caption as PDF text (see services/layoutEngine.js
// → buildSpreadPagesPair). 1024×1024 is the standard supported size for
// gpt-image-2; bump to 2048×2048 if validated.
const OPENAI_IMAGE_SIZE = '1024x1024';
// Production quality tier for gpt-image-2 on /v1/images/generations. Sent as
// the `quality` form field by services/illustrator/openaiImagesHttp.js.
const OPENAI_IMAGE_QUALITY = 'high';

// ── Timeouts ──
// Gemini Flash Image typically completes in 15-40s; OpenAI gpt-image-2 at
// `quality: high` with reference images often takes 45-90s. The same
// timeout covers both — we size it for the slower path to keep the OpenAI
// default path from tripping flaky timeouts under load.
const TURN_TIMEOUT_MS = 300000;          // 5 minutes per image generation turn
const QA_TIMEOUT_MS = 45000;             // 45s per vision QA call
const ESTABLISHMENT_TIMEOUT_MS = 180000; // first turn generates the reference sheet — same budget as a spread turn

// ── Retry budgets ──
const QA_HTTP_ATTEMPTS = 3;         // retries per vision QA HTTP call before fail-open (infra)
// Explicit ceiling for QA model output. The consistencyQa schema has ~25 fields
// with prose `Notes` companions; without an explicit cap the gemini-2.5-flash
// implicit budget at thinkingBudget=0 was clipping responses mid-JSON, which
// the parser couldn't recover (greedy {…} regex needs a closing brace). 4096
// is comfortably above the largest observed legitimate response (~1.9k) while
// staying within the per-request token budget.
const QA_MAX_OUTPUT_TOKENS = 4096;

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
  // Lines must read as professionally typeset — the single most visible
  // "AI-painted" tell is wavy baselines and a drifting left edge.
  textAlignment: 'Every line of text PERFECTLY horizontal and level — never tilted, arched, wavy, curved, or stair-stepped. All lines LEFT-ALIGNED to one shared, perfectly straight left margin (a ragged right edge is correct); the line spacing between every pair of adjacent lines is identical. The block must look like professionally typeset book text, not hand-placed lettering.',
  // One art-director spec for the whole book — models drift if each spread
  // re-invents type. Each render is a STATELESS call: this pinned spec (not
  // any earlier frame) is the anchor, and it is identical on every spread.
  typographyConsistency: 'BOOK-WIDE LOCK: every spread of this book renders its text with the IDENTICAL font family, weight, size, and color — one continuous series, one subtitle spec for the whole book. This exact spec is pinned on every page, so follow it to the letter: never introduce a different face, a different weight, a noticeably larger or smaller point size, or a different text color on any spread. Within the block itself, every line uses the same single font, size, and color — never mix typefaces, sizes, weights, or colors between lines or words.',
  // ONE fixed fill color for the whole book — per-scene retinting is exactly
  // the cross-spread drift parents notice. Readability on any background
  // comes from the mandatory soft dark shadow/outline, never from recoloring.
  fontColor: 'ONE fixed text color for the ENTIRE book: soft warm ivory (a slightly warm off-white), with a whisper-soft dark contact shadow or thin dark outline for readability. The SAME fill color and the SAME shadow treatment on every spread — never retint, recolor, or restyle the text to match an individual scene’s palette or lighting.',
  fontSize: 'Modest, **very readable** on print — the comfortable middle: clearly legible (never miniature or faint), but **not** large and never “cover title” scale. Think restrained film subtitle: **small** on the art, but sharp and easy to read at arm’s length. That same legible modest size on **every** spread; do not grow or shrink the type dramatically versus prior spreads in this book.',
  // Extra guidance for prompt builders and system instruction (not always concatenated in old paths).
  textIntegration: 'The caption is part of the same cinematic 3D frame: same color grade, same atmospheric haze, same exposure logic. No floating UI bar, no sharp rectangular panel behind lines, no sticker-like cutout with mismatched brightening, no highlighter blocks. If there is depth fog, letters soften very slightly at the micro-edges. Readability is mandatory, but the text must "live in" the light of the world, not sit on top as a separate layer of flat graphic design. **Typography and fill color** stay stable book-wide; only the soft shadow/haze around the glyphs may blend with the scene — never the font, size, or fill color.',
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
    // "stylized 3D" (not "photorealistic 3D"): production book 497c8b68 drifted
    // between candidates — some spreads rendered as realistic 3D CGI while the
    // parent-approved cover was stylized illustrative 3D, and the spread judge
    // flagged the mismatch. Pin the STYLIZED animated-film look on every render.
    'stylized 3D CGI render in a modern animated-feature look (NOT a 2D illustration, NOT a flat painting, NOT a storybook illustration, NOT a photorealistic live-action render)',
    'Disney-Pixar feature-film production quality — reads like a high-resolution frame from a modern Pixar movie',
    'physically based 3D modeling — real three-dimensional character geometry with volume, weight, and rim-lit silhouettes',
    'soft subsurface skin scattering on faces, ears, and hands (warm backlit translucency), stylized — not real human skin',
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
    // P3 explicit anchors (2026-07-23 audit: intra-interior drift — some spreads
    // rendered as flat 2D with hard outlines, one as a photoreal-bokeh frame).
    'NOT a flat vector illustration with hard cel outlines or uniform flat color fills',
    'NOT a photorealistic live-action render (real-skin, real-camera photography) — the cinematic depth-of-field must stay inside the stylized 3D animated-film look and never tip into live-action realism',
    'NOT a photorealistic live-action photograph or a realistic-human CGI render',
    'the characters must read as stylized 3D animated-film models, not as drawings with soft shading and not as real people',
  ].join('; '),
  // Single source of truth for the cross-page/cover consistency pin. Appended to
  // BOTH the native-illustrator interior prompts (via styleBible) and the cover
  // harmonize / cover-generation prompts (via renderStyleBlock), so every page
  // and the cover speak one identical 3D language — the drift that shipped a 2D
  // cover on a 3D interior book (497c8b68) can no longer open up between the two
  // prompt sites.
  consistency: 'STYLE CONSISTENCY LOCK (applies to EVERY interior page AND the cover): one uniform stylized 3D Pixar look across the whole book — the SAME consistent line weight / soft outlines, the SAME color saturation, and the SAME lighting language on every spread and on the cover. Stylized animated-film 3D, NOT photorealistic and NOT a real photograph. No page or the cover may drift toward flat 2D, painterly, watercolor, or realistic live-action rendering.',
};

// Themes where the parent is implied (hands/back-of-head) when they are not on the cover.
const PARENT_THEMES = new Set(['mothers_day', 'fathers_day', 'grandparents_day']);

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
  OPENAI_IMAGE_QUALITY,
  TURN_TIMEOUT_MS,
  QA_TIMEOUT_MS,
  QA_MAX_OUTPUT_TOKENS,
  ESTABLISHMENT_TIMEOUT_MS,
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
