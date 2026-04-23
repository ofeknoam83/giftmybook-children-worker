/**
 * Repair planner.
 *
 * Turns a QA verdict into (a) a structured retry-memory entry and (b) a
 * short `correctionNote` the session can feed back into the image model.
 *
 * Layered response order the illustrator orchestrator should follow:
 *   1. in-session correction (this module's correctionNote)
 *   2. stronger prompt/spec adjustment (caller regenerates the illustration spec)
 *   3. escalation (caller rebuilds the session or fails fast)
 */

const { buildRetryEntry } = require('../retryMemory');

/**
 * Human-facing correction note, one line per issue. Short and declarative
 * so the image model treats it as direct instructions, not a discussion.
 *
 * @param {string[]} issues
 * @param {string[]} tags
 * @returns {string}
 */
function renderCorrectionNote(issues, tags) {
  const lines = [];
  if (issues.length) {
    lines.push('Fix all of the following in the next attempt:');
    for (const i of issues) lines.push(`- ${i}`);
  }
  if (tags.includes('extra_word') || tags.includes('unexpected_text')) {
    lines.push('Do not paint any extra words, signage, or environmental text. Only the provided caption.');
  }
  if (tags.includes('text_on_both_sides') || tags.includes('text_crosses_midline') || tags.includes('text_in_center_band')) {
    lines.push('Place ALL caption text on the chosen side only. No letters in the center band.');
  }
  if (tags.includes('hero_identity_drift') || tags.includes('hero_face_mismatch') || tags.includes('outfit_mismatch')) {
    lines.push('Match the approved cover for hero face, hair, and outfit. Do not restyle the hero.');
  }
  return lines.join('\n');
}

/**
 * Build a repair plan for a single failed spread attempt.
 *
 * @param {object} params
 * @param {number} params.spreadNumber
 * @param {number} params.attemptNumber - 1-based
 * @param {string[]} params.issues
 * @param {string[]} params.tags
 * @returns {{ retryEntry: object, correctionNote: string }}
 */
function planSpreadRepair(params) {
  const { spreadNumber, attemptNumber, issues, tags } = params;

  const retryEntry = buildRetryEntry({
    stage: 'spreadRender',
    spreadNumber,
    failedAttemptNumber: attemptNumber,
    failureTags: tags,
    mustChange: issues.slice(0, 12),
    mustPreserve: [
      'hero identity and outfit from the approved cover',
      'overall visual style (premium 3D Pixar-like)',
      'caption wording — do not rewrite the text',
    ],
    bannedRepeats: tags,
  });

  const correctionNote = renderCorrectionNote(issues, tags);
  return { retryEntry, correctionNote };
}

module.exports = { planSpreadRepair, renderCorrectionNote };
