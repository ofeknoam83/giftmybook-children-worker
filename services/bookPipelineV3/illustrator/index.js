/**
 * Native V3 illustrator — entry point ("Art Studio", milestone 2).
 *
 * Stages (docs/ILLUSTRATOR_V3_MILESTONE2_PLAN.md §2-3):
 *   identityKit/    A0 — likeness brief + character model sheet (W4)
 *   artDirection/   A1 — shot budget, text zones, plates, bounce-back (W7/W8)
 *   render/         A2 — parallel per-spread 2-candidate renders (W5)
 *   qa/             A3 — deterministic checks → vision judges → selection (W6)
 *   bookPass/       A4 — contact-sheet review (W9)
 *
 * Phase 0 (this file's stub): the workflow branches here when the resolved
 * illustrator is 'native'. Until the rendering + QA phases land, a native
 * run fails loudly and immediately — never silently falling back to the
 * legacy adapter, so A/B comparisons stay trustworthy.
 */

const IMPLEMENTED_PHASES = [];
const PENDING_PHASES = ['identityKit (W4)', 'render (W5)', 'qa (W6)', 'artDirection (W7/W8)', 'bookPass+typesetting (W9)', 'reviewQueue wiring (W10)'];

/**
 * Run the native illustrator over a written manuscript.
 * Contract mirrors the legacy adapter activity: consumes V3 artifacts,
 * returns a rendered v1-shape document (spreads with illustration slots
 * filled) so toLegacyStoryPlan and layout stay untouched.
 *
 * @param {object} input - { rawRequest, brief, ageProfile, concept, manuscript, coverImageUrl, coverTitle, operationalContext }
 * @param {object} ctx - workflow context ({ log, bookId, reportProgress, execute })
 * @returns {Promise<object>} rendered document
 */
async function runNativeIllustrator(input, ctx) {
  const err = new Error(
    'native V3 illustrator selected but not yet implemented on this worker '
    + `(implemented: [${IMPLEMENTED_PHASES.join(', ') || 'none'}]; pending: [${PENDING_PHASES.join(', ')}]). `
    + "Use illustratorVersion 'legacy' or deploy the milestone-2 phases.",
  );
  err.code = 'ILLUSTRATOR_NATIVE_NOT_READY';
  if (ctx?.log) ctx.log('error', `[v3-illustrator] ${err.message}`);
  throw err;
}

module.exports = {
  runNativeIllustrator,
  IMPLEMENTED_PHASES,
  PENDING_PHASES,
};
