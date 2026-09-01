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
 *  - AGE_ENGINE_VERSION: any edit to data/ageEngines.json — ALSO add a
 *    matching bounds table to ageBounds.js BOUNDS_BY_ENGINE and keep the
 *    old tables (stored stories re-validate under their pinned version)
 *  - PROMPT_TEMPLATE_VERSION: any edit to the user-prompt assembly in writer.js
 *  - SELECTOR_VERSION: any change to the fit-score formula or tie-breaking
 *  - CATALOG_VERSION comes from data/catalog.json itself
 *
 * versions.writer_tuning is NOT pinned here: it carries the Style Tuning
 * Layer tag (`<label>.<hash8>`) from the per-request writerTuning overlay the
 * main app sends, or 'none'. The base engine file stays locked either way.
 */

const WRITER_ENGINE_VERSION = '1.3.0';
const AGE_ENGINE_VERSION = '1.4.0'; // 1.4.0: tightened word budgets (1-3: 8-30/spread, 4-5: 30-40, 6-7: 40-50, 8-10: 50-60; totals = 12 spreads)
const MAP_SCHEMA_VERSION = '1.3.0';
const BOOK_DEFINITION_VERSION = '1.1.0'; // the frozen V1.1 plots, per the handoff
const SELECTOR_VERSION = '1.0.0';
const PROMPT_TEMPLATE_VERSION = '1.2.0'; // 1.2.0: scope-subordinate tuning frame + end-of-prompt style checkpoint + polish pass; 1.1.0: HARD LIMITS caps line + per-book detail pre-selection

/** Illustration style version — bump to invalidate the render cache. */
// ce-2: embedded layout paints the story text INTO the art (Gemini embedText
// path + text-verify QA) — pre-ce-2 wide renders are text-free and must
// never replay as embedded spreads.
// ce-3: embedded text placement hardened — ONE block on ONE side (left or
// right 35%), painted over continuous artwork, never split across both
// sides or letterboxed onto a blank band; QA gates placement. ce-2 embedded
// renders may carry band/split text and must never replay.
// ce-4: embedded typography locked — straight, level, LEFT-ALIGNED text
// lines with even spacing, and ONE book-wide font/size/color (the pinned
// TEXT_RULES spec rides every stateless render; per-scene color retinting
// removed); QA gates alignment (text_lines_misaligned) and intra-block
// consistency (text_style_inconsistent). ce-3 embedded renders may carry
// wavy lines or per-spread type drift and must never replay.
// ce-5: world consistency — every scene prompt carries the theme's fixed
// WORLD-LAW card (worldCards.json: palette, era, physical/magical laws) and
// renders anchor on a fixed per-theme world plate (worldPlate.js, a second
// reference image identical on every spread; its hash also rides the cache
// key). Editing worldCards.json changes pixels — bump this version again.
// ce-4 renders were specified against no world card and must never replay.
// ce-6: continuity props — the child's comfort object (visual_required
// object_presence evidence) persists visually on every spread AFTER its
// introduction (scenes.js CONTINUITY PROP line; kill-switch
// CATALOG_PROP_CONTINUITY). Scene prompts changed for every story carrying
// object evidence — ce-5 renders must never replay as ce-6.
const STYLE_VERSION = 'ce-6';

module.exports = {
  WRITER_ENGINE_VERSION,
  AGE_ENGINE_VERSION,
  MAP_SCHEMA_VERSION,
  BOOK_DEFINITION_VERSION,
  SELECTOR_VERSION,
  PROMPT_TEMPLATE_VERSION,
  STYLE_VERSION,
};
