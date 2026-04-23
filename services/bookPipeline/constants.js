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
  [AGE_BANDS.PB_TODDLER]: { min: 2, max: 3 },
  [AGE_BANDS.PB_PRESCHOOL]: { min: 2, max: 4 },
  [AGE_BANDS.ER_EARLY]: { min: 3, max: 4 },
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

const MODELS = {
  PLANNER: 'gpt-5.4',
  WRITER: 'gpt-5.4',
  ILLUSTRATION_SPEC: 'gpt-5.4',
  WRITER_QA: 'gemini-2.5-flash',
  BOOK_WIDE_QA: 'gemini-2.5-flash',
  SPREAD_QA_VISION: 'gemini-2.5-flash',
  SPREAD_RENDER: 'gemini-3-flash-image-preview',
};

const REPAIR_BUDGETS = {
  writerRewriteWaves: 3,
  perSpreadInSessionCorrections: 3,
  perSpreadPromptRepairs: 2,
  perSpreadEscalations: 1,
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
  VISUAL_STYLE,
  RHYME_POLICY,
  TEXT_PLACEMENT,
  MODELS,
  REPAIR_BUDGETS,
  FAILURE_CODES,
};
