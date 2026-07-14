/**
 * Shared helpers for the legacy-illustrator adapter seam.
 *
 * Extracted from bookPipelineV2's illustrationDirector so V3 (and, until
 * its deletion, V2) can build v1-shaped spreads without a cross-pipeline
 * require into a module scheduled for removal. Both functions are pure.
 */

/**
 * Map a free-text caregiver hint from a beat sheet / scene contract to a
 * v1 parentVisibility enum value. The illustrator-side guard in
 * services/illustrator/prompt.js#buildParentVisibilityReminder will
 * silently demote any visible-fragment value (full/hand/shoulder-back/
 * cropped-torso/shadow) to 'object' when the parent is NOT on the
 * approved cover — see the off-cover policy. So callers don't have to
 * know cover state here; they just supply the planner's intent.
 *
 * @param {string|null} implied - free-text caregiver presence hint
 * @param {string} ageBand - PB_* age band
 * @returns {string} v1 parentVisibility enum value
 */
function deriveParentVisibility(implied, ageBand) {
  if (!implied) return ageBand === 'PB_INFANT' || ageBand === 'PB_TODDLER' ? 'cropped-torso' : 'object';
  const s = String(implied).toLowerCase();
  if (s.includes('full')) return 'full';
  if (s.includes('arm') || s.includes('hand')) return 'hand';
  if (s.includes('shoulder') || s.includes('back')) return 'shoulder-back';
  if (s.includes('torso') || s.includes('crop')) return 'cropped-torso';
  if (s.includes('shadow')) return 'shadow';
  if (s.includes('object') || s.includes('mug') || s.includes('chair') || s.includes('coat')) return 'object';
  if (s.includes('voice') || s.includes('off')) return 'absent';
  return 'object';
}

/**
 * Combine spread specs + accepted drafts into the spread array the v1
 * illustrator expects. Each spread MUST carry
 * `qa.{writerChecks,spreadChecks,repairHistory}` because the legacy
 * renderer mutates those arrays as it runs — missing the block crashes
 * with `Cannot read properties of undefined (reading 'spreadChecks')`.
 *
 * Before the manuscript-level refactor (PR #179) the qa block came in via
 * `createBookDocument`'s default spread skeleton; this path overwrites that
 * skeleton, so the qa block must be re-seeded here.
 *
 * @param {{spreadSpecs: object[], draftBySpread: Map<number, object>}} args
 * @returns {object[]} v1-shaped spreads
 */
function buildSpreadsForLegacyIllustrator({ spreadSpecs, draftBySpread }) {
  return spreadSpecs.map((spec) => {
    const draft = draftBySpread.get(spec.spreadNumber);
    const text = draft?.text || (Array.isArray(draft?.lines) ? draft.lines.join('\n') : '');
    return {
      spreadNumber: spec.spreadNumber,
      spec,
      manuscript: { text, lines: draft?.lines || [] },
      illustration: null,
      qa: {
        writerChecks: [],
        spreadChecks: [],
        repairHistory: [],
      },
    };
  });
}

module.exports = {
  deriveParentVisibility,
  buildSpreadsForLegacyIllustrator,
};
