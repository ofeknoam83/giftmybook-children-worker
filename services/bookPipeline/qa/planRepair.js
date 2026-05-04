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
 *
 * Tiered corrections (attempt 1): when both text QA and *soft* identity
 * (hero face / identity drift only — not outfit) fail together, prioritize caption/text
 * instructions and ask the model to preserve the current hero look — avoids
 * piling “restyle the hero” on top of text fixes and reducing false retry churn.
 * Outfit mismatches and interior continuity drifts are **hard**: they force full correction with attempt 1.
 */

const { buildRetryEntry } = require('../retryMemory');

/** Tags from {@link verifySpreadText} / text QA path. */
const TEXT_QA_TAGS = new Set([
  'unexpected_text',
  'text_in_center_band',
  'text_crosses_midline',
  'text_on_both_sides',
  'wrong_font',
  'spelling_mismatch',
  'missing_word',
  'duplicated_word',
  'text_duplicated_caption',
  'extra_word',
]);

/**
 * Identity tags where deferring full “match cover” instructions to attempt 2+
 * is safe when text also failed on attempt 1. Any other non-text tag forces full correction.
 */
const SOFT_IDENTITY_TAGS = new Set([
  'hero_mismatch',
  'hero_identity_drift',
  'hero_face_mismatch',
]);

/**
 * @param {string[]} tags
 * @param {number} attemptNumber - 1-based
 * @returns {'full' | 'text_priority' | 'text_only'}
 */
function classifyCorrectionMode(tags, attemptNumber) {
  if (attemptNumber !== 1) return 'full';
  const arr = Array.isArray(tags) ? tags : [];
  const hasText = arr.some(t => TEXT_QA_TAGS.has(t));
  if (!hasText) return 'full';

  const hasHard = arr.some(t => !TEXT_QA_TAGS.has(t) && !SOFT_IDENTITY_TAGS.has(t));
  if (hasHard) return 'full';

  if (arr.some(t => SOFT_IDENTITY_TAGS.has(t))) return 'text_priority';
  return 'text_only';
}

const TEXT_PRIORITY_PRESERVE = [
  'hero face, hair, skin tone, and outfit exactly as in this frame — change only caption text and placement',
  'overall visual style (premium 3D Pixar-like)',
  'caption wording — manuscript text character-for-character',
];

const DEFAULT_MUST_PRESERVE = [
  'hero identity and outfit from the approved cover',
  'overall visual style (premium 3D Pixar-like)',
  'caption wording — do not rewrite the text',
];

/**
 * Human-facing correction note, one line per issue. Short and declarative
 * so the image model treats it as direct instructions, not a discussion.
 *
 * @param {string[]} issues
 * @param {string[]} tags
 * @param {object} [options]
 * @param {'full' | 'text_priority' | 'text_only'} [options.mode]
 * @returns {string}
 */
function renderCorrectionNote(issues, tags, options = {}) {
  const mode = options.mode || 'full';
  const tagArr = Array.isArray(tags) ? tags : [];
  const lines = [];
  if (issues.length) {
    lines.push('Fix all of the following in the next attempt:');
    for (const i of issues) lines.push(`- ${i}`);
  }
  if (tagArr.includes('extra_word') || tagArr.includes('unexpected_text')) {
    lines.push('Do not paint any extra words, signage, or environmental text. Only the provided caption.');
  }
  if (tagArr.includes('text_on_both_sides') || tagArr.includes('text_crosses_midline') || tagArr.includes('text_in_center_band')) {
    lines.push('Place ALL caption text on the chosen side only. No letters in the center band.');
  }

  const showHeroOutfitParagraph = mode !== 'text_priority'
    && (
      tagArr.includes('hero_mismatch')
      || tagArr.includes('hero_identity_drift')
      || tagArr.includes('hero_face_mismatch')
      || tagArr.includes('outfit_mismatch')
    );
  if (showHeroOutfitParagraph) {
    lines.push('Match the approved cover for hero face, hair, and outfit. Do not restyle the hero.');
  }
  if (tagArr.includes('body_disconnected') || tagArr.includes('duplicated_hero')) {
    lines.push(
      'Render the hero as ONE single connected body — one silhouette from head to feet, in one pose, at one scale. Head, neck, torso, hips, legs, and feet must all be attached on the same body. The upper-body garment (shirt/dress top) must visibly connect to the lower-body garment (pants/shorts/skirt) on the SAME torso. Do NOT render a second pair of legs, a ghost torso, or disconnected lower-body shorts standing beside the child. If the child is reaching or on tiptoe, the legs and feet must stay attached to the hips that support the torso. Exactly ONE child figure, ONE outfit, ONE set of limbs.',
    );
  }
  if (tagArr.includes('disembodied_limb')) {
    lines.push(
      'Remove any floating or disembodied limbs. If a partial-presence character is implied, the visible hand/arm MUST enter from a clear frame edge (or from behind a foreground object) with at least wrist + forearm + the start of the elbow or sleeve continuing off-screen, and the off-frame body must be physically plausible for the staging (seated beside the child, kneeling above, leaning over a railing). If you cannot stage that naturally, replace the limb with the character\'s signature object (cup, scarf, glasses, ring) instead.',
    );
  }
  if (tagArr.includes('implied_parent_skin_mismatch')) {
    lines.push('Any visible adult skin on partial-presence limbs must plausibly match the hero\'s family skin tone from the cover.');
  }
  if (tagArr.includes('full_body_parent_skin_mismatch')) {
    lines.push('Any visible adult sharing the frame with the hero must read as the same family — match the hero\'s skin tone and undertone from the BOOK COVER exactly. If the spread shows a fully-rendered adult face/body whose skin clearly differs from the cover child, either re-render that adult with the correct skin tone OR (if the parent is not on the cover per the off-cover policy) replace the full adult figure with implied presence (hand / shoulder / cropped torso / shadow / object).');
  }
  if (tagArr.includes('parent_turned_away')) {
    lines.push(
      'Re-stage the parent so their body language is visibly engaged with the hero child: oriented toward the child, eyes on the child, leaning in, holding the child, walking alongside, or sharing the child\'s focus on a shared object. Never the parent\'s back to the child with no narrative reason. For partial presence, the implied hand/arm must reach TOWARD the child, not away.',
    );
  }
  if (tagArr.includes('style_drift')) {
    lines.push(
      'Re-render in a 3D CGI Pixar feature-film style — a frame from a modern Pixar movie (photoreal subsurface skin scattering, individually rendered hair strands, physically based materials, volumetric ray-traced lighting, real optical depth-of-field). NOT a 2D illustration, NOT a soft painted children\'s book illustration, NOT watercolor/gouache/pencil/ink/anime/paper-cutout. Characters must read as real 3D models, backgrounds as real 3D environments — not as painted images with blur. Match the BOOK COVER\'s art style exactly.',
    );
  }
  if (tagArr.includes('hair_continuity_drift')) {
    lines.push(
      'Align the hero\'s hair with the approved cover and the most recent approved interior spreads — same color family, length, and style; no silent restyle mid-book.',
    );
  }
  if (tagArr.includes('outfit_continuity_drift')) {
    lines.push(
      'Align the hero\'s outfit with the approved cover and recent interior spreads — continue the same clothing story unless the scene clearly calls for a situational change (pajamas, swim, coat).',
    );
  }
  if (tagArr.includes('split_panel')) {
    lines.push(
      'ONE continuous wide 16:9 panorama — a single cinematic frame with NO diptych, NO vertical seam, NO visible split down the middle, NO two panels stitched side-by-side. Lighting, perspective, and ground plane must read as one unified 3D shot.',
    );
  }
  if (
    tagArr.includes('duplicated_word')
    || tagArr.includes('text_duplicated_caption')
    || tagArr.includes('spelling_mismatch')
    || tagArr.includes('missing_word')
  ) {
    lines.push(
      'Render the caption exactly once as a single block. Match the provided TEXT line WORD-FOR-WORD (same words, same order, no doubled words like “a a”, no repeated stanza, no copy on both halves of the frame).',
    );
  }
  if (mode === 'text_priority') {
    lines.push(
      'PRESERVE: keep the hero child\'s face, hair, skin tone, and outfit exactly as in this render — fix only the caption/text problems listed above (wording, placement, center band, no stray words).',
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
 * @returns {{ retryEntry: object, correctionNote: string, correctionMode: string }}
 */
function planSpreadRepair(params) {
  const { spreadNumber, attemptNumber, issues, tags } = params;
  const correctionMode = classifyCorrectionMode(tags, attemptNumber);

  const mustPreserve = correctionMode === 'text_priority' ? TEXT_PRIORITY_PRESERVE : DEFAULT_MUST_PRESERVE;

  const retryEntry = buildRetryEntry({
    stage: 'spreadRender',
    spreadNumber,
    failedAttemptNumber: attemptNumber,
    failureTags: tags,
    mustChange: issues.slice(0, 12),
    mustPreserve,
    bannedRepeats: tags,
  });

  const correctionNote = renderCorrectionNote(issues, tags, { mode: correctionMode });
  return { retryEntry, correctionNote, correctionMode };
}

module.exports = {
  planSpreadRepair,
  renderCorrectionNote,
  classifyCorrectionMode,
  TEXT_QA_TAGS,
  SOFT_IDENTITY_TAGS,
};
