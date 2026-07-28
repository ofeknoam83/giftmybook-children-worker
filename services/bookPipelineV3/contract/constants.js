/**
 * Shared constants for the children book generation pipeline (v1 document
 * contract). Slimmed 2026-07-28: this module once carried the full v1/v2
 * product-default tables (per-line word budgets, rhyme policy, model
 * routing, repair budgets, per-band writer temperatures). All of those were
 * dead after the v3 cutover — nothing imported them, several were keyed by
 * the retired '0-1'/'0-3' band values instead of the live 'PB_INFANT'-style
 * keys, and the jobs they described moved to their real owners:
 *
 *   words/lines per spread → ageProfiles/*.json narrativeConstraints
 *                            (gate/checks/wordBudget.js, lineCount.js)
 *   form/rhyme choice      → the concept's form_choice (schema/document.js
 *                            FORM_CHOICES; gate identityRhyme)
 *   model routing          → llm/modelRouter.js (+ illustrator/config.js)
 *   repair budgets         → illustrator/config.js
 *
 * Only the three live exports remain.
 */

// AA-CW-6: bumped v1 → v2. The v1 → v2 cutover marks a stack of breaking
// pipeline changes shipped over AA-CW-1 through AA-CW-5b. Older books in
// storage still tagged v1 — layoutEngine and any back-fill workers should
// not assume v1 == v2.
const PIPELINE_VERSION = 'book-pipeline-v2';

const TOTAL_SPREADS = 13;

const VISUAL_STYLE = 'premium-3d-pixar';

module.exports = {
  PIPELINE_VERSION,
  TOTAL_SPREADS,
  VISUAL_STYLE,
};
