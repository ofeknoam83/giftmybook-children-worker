/**
 * Version identifiers pinned on every catalog-engine request/response.
 *
 * The V1.3 runtime contract requires every generation to echo the exact
 * versions it ran with (writer engine, age engine, catalog, book definition,
 * personalization map, map schema, selector, prompt template, model) so a
 * stored book is fully reproducible and rollback never guesses.
 *
 * Bump rules:
 *  - WRITER_ENGINE_VERSION: any edit to data/writerEngine.system.md
 *  - PROMPT_TEMPLATE_VERSION: any edit to the user-prompt assembly in writer.js
 *  - SELECTOR_VERSION: any change to the fit-score formula or tie-breaking
 *  - CATALOG_VERSION comes from data/catalog.json itself
 *
 * versions.writer_tuning is NOT pinned here: it carries the Style Tuning
 * Layer tag (`<label>.<hash8>`) from the per-request writerTuning overlay the
 * main app sends, or 'none'. The base engine file stays locked either way.
 */

const WRITER_ENGINE_VERSION = '1.3.0';
const AGE_ENGINE_VERSION = '1.3.0';
const MAP_SCHEMA_VERSION = '1.3.0';
const BOOK_DEFINITION_VERSION = '1.1.0'; // the frozen V1.1 plots, per the handoff
const SELECTOR_VERSION = '1.0.0';
const PROMPT_TEMPLATE_VERSION = '1.2.0'; // 1.2.0: scope-subordinate tuning frame + end-of-prompt style checkpoint + polish pass; 1.1.0: HARD LIMITS caps line + per-book detail pre-selection

/** Illustration style version — bump to invalidate the render cache. */
// ce-2: embedded layout paints the story text INTO the art (Gemini embedText
// path + text-verify QA) — pre-ce-2 wide renders are text-free and must
// never replay as embedded spreads.
const STYLE_VERSION = 'ce-2';

module.exports = {
  WRITER_ENGINE_VERSION,
  AGE_ENGINE_VERSION,
  MAP_SCHEMA_VERSION,
  BOOK_DEFINITION_VERSION,
  SELECTOR_VERSION,
  PROMPT_TEMPLATE_VERSION,
  STYLE_VERSION,
};
