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
  // Lap-baby band. Under ~18 months. The book is read TO the baby by the
  // parent, so we write FOR the parent reading aloud — short sensory
  // observation pairs, no plot, no dialogue, no locomotion verbs. The hero
  // can sit (supported), be held, reach, smile, look — but cannot stand
  // unsupported, walk, run, climb, or grab moving objects.
  PB_INFANT: '0-1',
  PB_TODDLER: '0-3',
  PB_PRESCHOOL: '3-6',
  ER_EARLY: '6-8',
};

const TOTAL_SPREADS = 13;

const TEXT_LINE_TARGET = {
  // Picture books (ages 0-6) are locked at exactly 4 lines per spread,
  // in AABB rhyming couplets — musical, read-aloud cadence, consistent
  // page shape. Infants (0-1) get 2 lines per spread (one rhyming couplet)
  // for board-book brevity. Early readers stay at 3-4 prose lines.
  [AGE_BANDS.PB_INFANT]: { min: 2, max: 2 },
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
  // Infants (0-1) get the tightest budget — 2-4 words per line, hardMax 5.
  // Designed for the parent reading aloud to a baby who is listening for
  // sound and rhythm rather than meaning.
  [AGE_BANDS.PB_INFANT]: { min: 2, max: 4, hardMax: 5 },
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
  perSpreadExtraSessionRounds: 3,
  bookWideRepairWaves: 2,
  /**
   * Early-abort threshold for the quad illustrator: if a spread pair is
   * rejected this many times in a row with `age_action_impossible` in the
   * tags, give up immediately. The illustrator cannot fix age violations
   * caused by the manuscript text (the writer asked for an action the
   * hero cannot physically perform), so further attempts only burn GPU
   * time. The pair fails with `infant_action_text_unrenderable` so the
   * operator knows the writer is the culprit.
   */
  ageActionImpossibleConsecutiveAbort: 3,
};

/** Max recent accepted interior images passed into spread consistency QA (plus cover + candidate). */
const QA_RECENT_INTERIOR_REFERENCES = 3;

const FAILURE_CODES = {
  COVER_MISSING: 'cover_missing',
  PLAN_UNRESOLVABLE: 'plan_unresolvable',
  WRITER_UNRESOLVABLE: 'writer_unresolvable',
  SPREAD_UNRESOLVABLE: 'spread_unresolvable',
  BOOK_WIDE_UNRESOLVABLE: 'book_wide_unresolvable',
  SAFETY_BLOCK: 'safety_block',
  UPSTREAM_UNAVAILABLE: 'upstream_unavailable',
};

/**
 * When no env or request override applies, use quad (4:1 dual-spread) interiors.
 * Set to `false` to default back to legacy 16:9 one-spread-per-image.
 */
const USE_QUAD_SPREAD_ILLUSTRATOR_DEFAULT = true;

/**
 * @returns {boolean|null} true = force quad, false = force legacy, null = unset / ignore
 */
function _parseEnvQuadSpreadFlag() {
  const v = process.env.GIFTMYBOOK_QUAD_SPREAD_ILLUSTRATOR;
  if (v === undefined || v === '') return null;
  const s = String(v).toLowerCase().trim();
  if (['1', 'true', 'yes', 'on', 'quad'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'legacy'].includes(s)) return false;
  return null;
}

/**
 * Illustration pipeline variant. Precedence: env (if recognized) → request boolean → code default.
 *
 * @param {object} [doc] - Book document (`doc.request.useQuadSpreadIllustrator`)
 * @returns {{ renderer: 'legacy' | 'quad', source: 'default' | 'env' | 'request' }}
 */
function getIllustrationRenderer(doc) {
  const env = _parseEnvQuadSpreadFlag();
  if (env === true) return { renderer: 'quad', source: 'env' };
  if (env === false) return { renderer: 'legacy', source: 'env' };
  if (doc?.request?.useQuadSpreadIllustrator === false) {
    return { renderer: 'legacy', source: 'request' };
  }
  if (doc?.request?.useQuadSpreadIllustrator === true) {
    return { renderer: 'quad', source: 'request' };
  }
  if (USE_QUAD_SPREAD_ILLUSTRATOR_DEFAULT) {
    return { renderer: 'quad', source: 'default' };
  }
  return { renderer: 'legacy', source: 'default' };
}

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
  QA_RECENT_INTERIOR_REFERENCES,
  FAILURE_CODES,
  USE_QUAD_SPREAD_ILLUSTRATOR_DEFAULT,
  getIllustrationRenderer,
};
