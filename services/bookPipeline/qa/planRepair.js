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
  if (
    tags.includes('hero_mismatch')
    || tags.includes('hero_identity_drift')
    || tags.includes('hero_face_mismatch')
    || tags.includes('outfit_mismatch')
  ) {
    lines.push('Match the approved cover for hero face, hair, and outfit. Do not restyle the hero.');
  }
  if (tags.includes('disembodied_limb')) {
    lines.push(
      'Remove any floating or disembodied limbs. If a partial-presence character is implied, the visible hand/arm MUST enter from a clear frame edge (or from behind a foreground object) with at least wrist + forearm + the start of the elbow or sleeve continuing off-screen, and the off-frame body must be physically plausible for the staging (seated beside the child, kneeling above, leaning over a railing). If you cannot stage that naturally, replace the limb with the character\'s signature object (cup, scarf, glasses, ring) instead.',
    );
  }
  if (tags.includes('implied_parent_skin_mismatch')) {
    lines.push('Any visible adult skin on partial-presence limbs must plausibly match the hero\'s family skin tone from the cover.');
  }
  if (tags.includes('parent_turned_away')) {
    lines.push(
      'Re-stage the parent so their body language is visibly engaged with the hero child: oriented toward the child, eyes on the child, leaning in, holding the child, walking alongside, or sharing the child\'s focus on a shared object. Never the parent\'s back to the child with no narrative reason. For partial presence, the implied hand/arm must reach TOWARD the child, not away.',
    );
  }
  if (tags.includes('style_drift')) {
    lines.push(
      'Re-render in a 3D CGI Pixar feature-film style — a frame from a modern Pixar movie (photoreal subsurface skin scattering, individually rendered hair strands, physically based materials, volumetric ray-traced lighting, real optical depth-of-field). NOT a 2D illustration, NOT a soft painted children\'s book illustration, NOT watercolor/gouache/pencil/ink/anime/paper-cutout. Characters must read as real 3D models, backgrounds as real 3D environments — not as painted images with blur. Match the BOOK COVER\'s art style exactly.',
    );
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
