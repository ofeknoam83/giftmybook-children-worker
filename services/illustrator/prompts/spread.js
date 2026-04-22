/**
 * Illustrator V2 — Per-Spread Prompt Builder
 *
 * Builds the prompt for each spread. Purely image-based character consistency —
 * NO text descriptions of character appearance. The model sees the cover and
 * recent spreads as visual references.
 */

const { getEmotionalBeat, BEAT_CAMERA, PARENT_THEMES, ART_STYLE_CONFIG } = require('../config');
const { buildTextInstruction } = require('./text');

/** Scenes that must stay outdoors — used for LOCATION LOCK in prompts and corrections. */
const OUTDOOR_WORDS = /\b(beach|shore|boardwalk|seaside|ocean|sea|waves?|sand|park|forest|woods|garden|yard|street|sidewalk|field|meadow|hill|mountain|trail|river|pond|lake|playground|outdoors?|outside)\b/i;

/**
 * Extra lines for the agent when action/setting QA needs an outdoor lock (same as prompt SCENE).
 * @param {string} scenePrompt
 * @returns {string} Empty or paragraph(s) to append to a correction prompt.
 */
function outdoorLocationLockForCorrection(scenePrompt) {
  if (!OUTDOOR_WORDS.test(String(scenePrompt || ''))) return '';
  return `

### LOCATION LOCK (CRITICAL)
- The scene above is OUTDOORS. Draw it outdoors. Do NOT relocate it to a kitchen, bathroom, bedroom, living room, or any indoor setting — even if the tone or action feels domestic.`;
}
const { selectBibleEntriesForSpread, renderBibleSection } = require('../storyBible');
const {
  buildPrecedenceBlock,
  buildSpreadCriticalRules,
  buildSpreadCharacterBaselineLines,
  buildSpreadParentLexiconBullet,
  buildSpreadSecondaryLockedBullet,
  buildHiddenParentSpreadLines,
} = require('./ruleBlocks');

/**
 * Build the per-spread generation prompt.
 *
 * @param {object} opts
 * @param {number} opts.spreadIndex - 0-based spread index
 * @param {number} opts.totalSpreads - Total number of spreads
 * @param {string} opts.scenePrompt - The spread_image_prompt from the writer
 * @param {string} [opts.leftText] - Text for the left page
 * @param {string} [opts.rightText] - Text for the right page
 * @param {boolean} opts.hasParentOnCover - Whether the themed parent (woman for
 *   mother's day, man for father's day) is actually on the cover. A sibling or
 *   grandparent on a parent-themed cover does NOT count as the parent.
 * @param {boolean} [opts.hasSecondaryOnCover] - Whether ANY non-child person is
 *   on the cover (parent, sibling, grandparent, etc.). Independent of
 *   hasParentOnCover — for a mother's-day cover with just a sibling,
 *   hasSecondaryOnCover=true but hasParentOnCover=false.
 * @param {string} [opts.additionalCoverCharacters] - Description of secondary chars
 * @param {string} [opts.theme] - Book theme
 * @param {string} [opts.style] - Art style key (e.g. 'pixar_premium')
 * @returns {string}
 */
function buildSpreadPrompt(opts) {
  const {
    spreadIndex,
    totalSpreads,
    scenePrompt,
    leftText,
    rightText,
    hasParentOnCover,
    hasSecondaryOnCover,
    additionalCoverCharacters,
    theme,
    style,
    parentOutfit,
    storyBible,
  } = opts;
  // Back-compat: if the caller didn't pass hasSecondaryOnCover, infer it from
  // additionalCoverCharacters (matches the legacy semantics where a non-empty
  // description implied a secondary was visible).
  const secondaryOnCover = (typeof hasSecondaryOnCover === 'boolean')
    ? hasSecondaryOnCover
    : !!additionalCoverCharacters;

  const beat = getEmotionalBeat(spreadIndex, totalSpreads);
  const cameraHint = BEAT_CAMERA[beat];
  const parts = [];

  parts.push(buildPrecedenceBlock());
  parts.push(buildSpreadCriticalRules());
  parts.push('');

  // Header
  parts.push(`## SPREAD ${spreadIndex + 1} OF ${totalSpreads}`);
  parts.push('');

  // Scene description
  parts.push('### SCENE');
  parts.push(scenePrompt);
  parts.push('');

  if (OUTDOOR_WORDS.test(String(scenePrompt || ''))) {
    parts.push('### LOCATION LOCK (CRITICAL)');
    parts.push('- The scene above is OUTDOORS. Draw it outdoors. Do NOT relocate it to a kitchen, bathroom, bedroom, living room, or any indoor setting — even if the tone or action feels domestic.');
    parts.push('');
  }

  // Story bible — inject only entries that are referenced in THIS spread
  if (storyBible) {
    const selected = selectBibleEntriesForSpread(storyBible, scenePrompt, [leftText, rightText].filter(Boolean).join(' '));
    const bibleBlock = renderBibleSection(selected);
    if (bibleBlock) {
      parts.push(bibleBlock);
      parts.push('');
    }
  }

  // Character rules (image-based — no text descriptions)
  parts.push('### CHARACTER RULES');
  parts.push(...buildSpreadCharacterBaselineLines());

  const isParentTheme = theme && PARENT_THEMES.has(theme);

  const parentLexBullet = buildSpreadParentLexiconBullet(theme);
  if (parentLexBullet) parts.push(parentLexBullet);

  if (secondaryOnCover) {
    parts.push(buildSpreadSecondaryLockedBullet());
  }
  if (hasParentOnCover) {
    parts.push('- The themed parent IS among the cover characters and MAY appear in scenes where mentioned — treat them as one of the locked secondaries above.');
  }

  if (!hasParentOnCover && isParentTheme) {
    parts.push(...buildHiddenParentSpreadLines({
      secondaryOnCover,
      parentOutfit: parentOutfit || null,
      theme,
    }));
  } else if (!hasParentOnCover && !secondaryOnCover && !isParentTheme) {
    parts.push('- NO other human characters — the child is the ONLY person visible. Even if the text mentions a family member, do NOT draw them (no reference image exists).');
  }

  parts.push('- No duplicate characters — the child appears ONCE');
  parts.push('');

  // Format — seamless painting (see CRITICAL RULES above for the full anti-split/anti-duplication rules)
  parts.push('### FORMAT');
  parts.push('- Wide cinematic panoramic landscape illustration, like a wide movie still.');
  parts.push('- Honor the ONE HERO / ONE MOMENT / ONE SEAMLESS PAINTING rules from CRITICAL RULES above — no seams, no duplicate hero, no side-by-side scenes.');
  parts.push('');

  // Composition
  parts.push('### COMPOSITION');
  parts.push(`- Emotional beat: ${beat}`);
  parts.push(`- Camera angle: ${cameraHint}`);
  parts.push('- Important elements should not be placed at the exact left-right center');
  parts.push('- Main character should be in the left third or right third, NOT dead center');
  parts.push('- Fill the entire canvas edge to edge — no blank areas');
  parts.push('');

  const styleConfig = ART_STYLE_CONFIG[style] || ART_STYLE_CONFIG.pixar_premium;
  parts.push('### STYLE CONSISTENCY');
  parts.push(`- MANDATORY STYLE: ${styleConfig.prefix} ${styleConfig.suffix}`);
  parts.push('- This spread MUST use this exact style. Do NOT switch to any other rendering technique.');
  parts.push('- Match the EXACT rendering technique, lighting quality, texture detail, and color saturation of the cover and all previous spreads');
  parts.push('- This is the same physical book — every page must look like the same artist rendered it');
  parts.push('- Use the SAME font as every other page — identical family, weight, and size');
  parts.push('');

  // Text embedding
  const spreadText = [leftText, rightText].filter(Boolean).join(' ');
  parts.push(buildTextInstruction(spreadText, { spreadIndex }));

  return parts.join('\n');
}

module.exports = { buildSpreadPrompt, OUTDOOR_WORDS, outdoorLocationLockForCorrection };
