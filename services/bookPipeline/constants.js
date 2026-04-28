/**
 * Shared constants for the new children book generation pipeline.
 *
 * These values encode the product defaults locked into the rewrite plan:
 * 13 spreads for both formats, two age bands for picture books plus an
 * older early-reader band, premium 3D Pixar style, text-in-image layout,
 * OpenAI-first model strategy, and bounded repair budgets.
 */

const PIPELINE_VERSION = 'book-pipeline-v1';

const FORMATS = {
  PICTURE_BOOK: 'picture_book',
  EARLY_READER: 'early_reader',
};

const AGE_BANDS = {
  PB_TODDLER: '0-3',
  PB_PRESCHOOL: '3-6',
  ER_EARLY: '6-8',
};

const TOTAL_SPREADS = 13;

const TEXT_LINE_TARGET = {
  // Picture books (ages 0-6) are locked at exactly 4 lines per spread,
  // in AABB rhyming couplets — musical, read-aloud cadence, consistent
  // page shape. Early readers stay at 3-4 prose lines.
  [AGE_BANDS.PB_TODDLER]: { min: 4, max: 4 },
  [AGE_BANDS.PB_PRESCHOOL]: { min: 4, max: 4 },
  [AGE_BANDS.ER_EARLY]: { min: 3, max: 4 },
};

// Words-per-line budgets. Picture-book toddler band (0-3) reads much more
// musically with very short lines (bedtime/board-book cadence), so we hold
// each of the 4 AABB lines to ~3-7 words. Preschool band (3-6) can carry
// the slightly longer ~6-12 word phrasing that works for parent-read-aloud.
// Early readers can run longer but remain sentence-length.
const WORDS_PER_LINE_TARGET = {
  [AGE_BANDS.PB_TODDLER]: { min: 3, max: 7, hardMax: 8 },
  [AGE_BANDS.PB_PRESCHOOL]: { min: 6, max: 12, hardMax: 14 },
  [AGE_BANDS.ER_EARLY]: { min: 6, max: 14, hardMax: 18 },
};

const VISUAL_STYLE = 'premium-3d-pixar';

const RHYME_POLICY = {
  [FORMATS.PICTURE_BOOK]: 'default_rhyme',
  [FORMATS.EARLY_READER]: 'prose',
};

const TEXT_PLACEMENT = {
  DEFAULT_SIDE_POLICY: 'usually_one_side',
  NEVER_CROSS_CENTER: true,
};

// Model routing — we deliberately split by creativity level. The big model
// (gpt-5.4) is reserved for stages that MAKE story — the creative story
// bible and the actual manuscript text. Everything else (visual bible
// extraction, spread-beat distribution, illustration-spec composition, QA)
// is structural transformation of already-creative inputs and runs on a
// fast / cheap model. Cost: gpt-5.4-mini is ~17× cheaper than gpt-5.4.
const MODELS = {
  // --- Creative stages (expensive, high-reasoning) ---
  STORY_BIBLE: 'gpt-5.4',
  WRITER: 'gpt-5.4',

  // --- Structural stages (fast / cheap) ---
  VISUAL_BIBLE: 'gpt-5.4-mini',
  SPREAD_SPECS: 'gpt-5.4-mini',
  ILLUSTRATION_SPEC: 'gpt-5.4-mini',

  // --- QA models ---
  WRITER_QA: 'gemini-2.5-flash',
  BOOK_WIDE_QA: 'gemini-2.5-flash',
  SPREAD_QA_VISION: 'gemini-2.5-flash',

  // --- Image rendering ---
  // Switchable via services/illustrator/sessionDispatch.js:
  //   - 'gemini-3.1-flash-image-preview'  → Nano Banana 2 (Gemini chat session, stateful) — default
  //   - 'gpt-image-2'                     → OpenAI Images 2.0 (stateless)
  SPREAD_RENDER: 'gemini-3.1-flash-image-preview',

  // Deprecated alias — keep until callers are fully migrated.
  PLANNER: 'gpt-5.4',
};

const REPAIR_BUDGETS = {
  writerRewriteWaves: 3,
  perSpreadInSessionCorrections: 3,
  perSpreadPromptRepairs: 2,
  /** Session rebuilds allowed when illustration hits Gemini safety — extra headroom after re-anchor fallback. */
  perSpreadEscalations: 3,
  /** After all in-session attempts fail, rebuild the illustrator session and retry that many full cycles (each cycle = same per-spread attempt budget). */
  perSpreadExtraSessionRounds: 2,
  bookWideRepairWaves: 2,
};

const FAILURE_CODES = {
  COVER_MISSING: 'cover_missing',
  PLAN_UNRESOLVABLE: 'plan_unresolvable',
  WRITER_UNRESOLVABLE: 'writer_unresolvable',
  SPREAD_UNRESOLVABLE: 'spread_unresolvable',
  BOOK_WIDE_UNRESOLVABLE: 'book_wide_unresolvable',
  SAFETY_BLOCK: 'safety_block',
  UPSTREAM_UNAVAILABLE: 'upstream_unavailable',
};

module.exports = {
  PIPELINE_VERSION,
  FORMATS,
  AGE_BANDS,
  TOTAL_SPREADS,
  TEXT_LINE_TARGET,
  WORDS_PER_LINE_TARGET,
  VISUAL_STYLE,
  RHYME_POLICY,
  TEXT_PLACEMENT,
  MODELS,
  REPAIR_BUDGETS,
  FAILURE_CODES,
};
