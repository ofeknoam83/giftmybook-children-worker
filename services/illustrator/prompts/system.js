/**
 * Illustrator V2 — System Instruction Builder
 *
 * Builds the system instruction for the Gemini chat session.
 * Rules-only — NO character text descriptions. Character consistency
 * is achieved purely through image references (cover + photo).
 */

const { PARENT_THEMES } = require('../config');
const {
  buildPrecedenceBlock,
  buildArtStyleLines,
  buildCharacterConsistencyLines,
  buildAnatomyLines,
  buildCompositionSystemLines,
  buildContentRulesLines,
  buildParentLexiconLines,
  buildSecondaryOnCoverLines,
  buildHiddenParentSystemLines,
  buildNoFamilyLines,
  buildTextRenderingSystemLines,
  buildDuplicatePreventionLines,
} = require('./ruleBlocks');

/**
 * Build the system instruction text.
 *
 * @param {object} opts
 * @param {string} opts.style - Art style key
 * @param {boolean} opts.hasParentOnCover - Whether the themed parent (a woman
 *   for mother's day, a man for father's day) appears on the approved cover.
 *   A sibling/grandparent/friend on the cover does NOT count as the parent.
 * @param {boolean} [opts.hasSecondaryOnCover] - Whether ANY non-child person
 *   appears on the cover (independent of hasParentOnCover).
 * @param {string} [opts.theme] - Book theme (mothers_day, fathers_day, etc.)
 * @returns {string}
 */
function buildSystemInstruction(opts) {
  const parts = [];

  parts.push(buildPrecedenceBlock());

  parts.push('You are creating illustrations for a personalized children\'s book.');
  parts.push('You will receive reference images of the child (real photo + approved cover) in the first turn.');
  parts.push('Use those images as your ONLY source of truth for character appearance.');
  parts.push('');

  parts.push(buildArtStyleLines(opts).join('\n'));
  parts.push('');

  parts.push(buildCharacterConsistencyLines().join('\n'));
  parts.push('');

  parts.push(buildAnatomyLines().join('\n'));
  parts.push('');

  parts.push(buildCompositionSystemLines().join('\n'));
  parts.push('');

  parts.push(buildContentRulesLines().join('\n'));
  parts.push('');

  const isParentTheme = opts.theme && PARENT_THEMES.has(opts.theme);
  const hasSecondaryOnCover = (typeof opts.hasSecondaryOnCover === 'boolean')
    ? opts.hasSecondaryOnCover
    : !!opts.hasParentOnCover;

  if (isParentTheme) {
    parts.push(buildParentLexiconLines(opts.theme).join('\n'));
    parts.push('');
  }

  if (hasSecondaryOnCover) {
    parts.push(buildSecondaryOnCoverLines({
      hasSecondaryOnCover,
      hasParentOnCover: opts.hasParentOnCover,
      theme: opts.theme,
    }).join('\n'));
    parts.push('');
  }

  if (!opts.hasParentOnCover && isParentTheme) {
    parts.push(buildHiddenParentSystemLines({
      hasSecondaryOnCover,
      parentOutfit: opts.parentOutfit || null,
      theme: opts.theme,
    }).join('\n'));
    parts.push('');
  } else if (!opts.hasParentOnCover && !hasSecondaryOnCover && !isParentTheme) {
    parts.push(buildNoFamilyLines().join('\n'));
    parts.push('');
  }

  parts.push(buildTextRenderingSystemLines().join('\n'));
  parts.push('');

  parts.push(buildDuplicatePreventionLines().join('\n'));
  parts.push('');

  return parts.join('\n');
}

module.exports = { buildSystemInstruction };
