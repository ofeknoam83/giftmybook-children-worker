/**
 * Illustrator V2 — Per-Spread Prompt Builder
 *
 * Builds the prompt for each spread. Purely image-based character consistency —
 * NO text descriptions of character appearance. The model sees the cover and
 * recent spreads as visual references.
 */

const { getEmotionalBeat, BEAT_CAMERA, PARENT_THEMES, ART_STYLE_CONFIG } = require('../config');
const { buildTextInstruction } = require('./text');
const { selectBibleEntriesForSpread, renderBibleSection } = require('../storyBible');

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

  // Critical rules — read before anything else
  parts.push('### CRITICAL RULES — READ BEFORE DRAWING');
  parts.push('- ONE HERO: The main child appears EXACTLY ONCE in this image. No duplicates, no twin, no reflection/photo copy, no before-and-after sequence of the same child.');
  parts.push('- ONE MOMENT: This is ONE single moment in time — not a comic strip, not a diptych, not two scenes side by side, not a before/after, not a split-panel.');
  parts.push('- ONE SEAMLESS PAINTING (NON-NEGOTIABLE): A single continuous panoramic illustration. NO vertical seam anywhere in the image. NO mid-frame background change. NO lighting break. NO color-palette break. NO horizon jump. NO mirrored halves. NO border, divider, frame, or gutter between left and right halves.');
  parts.push('- DO NOT COMPOSE FOR A BOOK FOLD: ignore any mental model of "left page vs right page". This is ONE single image, not two pages joined together. Treat the canvas as a single photograph — never as a spread that will be folded.');
  parts.push('- CONTINUITY TEST: If you mentally draw a vertical line anywhere in this image, BOTH sides of that line must show the SAME room, SAME background, SAME time of day, SAME weather, and the SAME lighting. If any vertical line would split the image into two differently-lit or differently-placed scenes, you have FAILED and must recompose as one scene.');
  parts.push('- HERO SAFE ZONE: The main character\'s head and full face must be inside the middle 80% of the image — never cropped at the top, bottom, left, or right edge. Leave at least 8% of image height above the top of the hero\'s head. Do NOT let text cover the hero\'s head, face, or eyes.');
  parts.push('');

  // Header
  parts.push(`## SPREAD ${spreadIndex + 1} OF ${totalSpreads}`);
  parts.push('');

  // Scene description
  parts.push('### SCENE');
  parts.push(scenePrompt);
  parts.push('');

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
  parts.push('- Characters must match the reference images EXACTLY');
  parts.push('- HAIR: Same color, length, style, texture as on the cover — do NOT change hairstyle');
  parts.push('- OUTFIT: Same clothes and colors as on the cover — no costume changes for any reason');
  parts.push('- FACE: Same face shape, skin tone, and features as the reference');
  parts.push('- ANATOMY: Exactly 2 hands, 2 arms, 2 legs per person. Keep hands simple — fists, cupped, or gently gripping. AVOID spread-out fingers.');

  // Character rules — composed additively, no theme-specific gating on the
  // secondary-must-match rule.
  const isParentTheme = theme && PARENT_THEMES.has(theme);

  // Universal rule: ANY non-child character visible on the cover must match
  // their cover appearance exactly in every spread. This applies to every
  // theme and fires whether or not the themed parent is among them.
  if (secondaryOnCover) {
    parts.push('- SECONDARY CHARACTERS (LOCKED): Every non-child character visible on the cover must appear in illustrations EXACTLY as shown on the cover — same face, hair, skin tone, outfit, build. This applies to each of them individually.');
  }
  if (hasParentOnCover) {
    parts.push('- The themed parent IS among the cover characters and MAY appear in scenes where mentioned — treat them as one of the locked secondaries above.');
  }

  if (!hasParentOnCover && isParentTheme) {
    const isMother = theme === 'mothers_day';
    parts.push(`- The parent is the child's ${isMother ? 'MOTHER (a woman/female)' : 'FATHER (a man/male)'} — ${isMother ? 'NEVER draw a man as the mother' : 'NEVER draw a woman as the father'}`);
    if (secondaryOnCover) {
      parts.push(`- ⚠️ THE SECONDARY CHARACTER ON THE COVER IS NOT THE ${isMother ? 'MOTHER' : 'FATHER'}. Do NOT treat them as the parent. The ${isMother ? 'mother' : 'father'} is a SEPARATE character who has NO reference image.`);
    }
    parts.push(`- ⚠️ PARENT FACE — COMPLETELY HIDDEN (NON-NEGOTIABLE): We have NO reference photo of the ${isMother ? 'mother' : 'father'}. ${isMother ? 'Her' : 'His'} face must NEVER appear in ANY illustration. Show the parent ONLY through: back view, hands/arms reaching in, kneeling with face cropped out of frame, or side view with face turned away. NEVER show eyes, mouth, nose, or any facial features. This is the #1 rule for the parent.`);
    parts.push('- NEVER put a solid black box, bar, or opaque mask over the parent\'s head — use natural framing only. No censor artifacts, voids, or "missing face" patches.');
    parts.push('- BODY ORIENTATION: Even with face hidden, the parent must face TOWARD the child (leaning in, reaching, kneeling). NEVER facing away.');
    parts.push(`- ⚠️ FAMILY RESEMBLANCE: The ${isMother ? 'mother' : 'father'}'s visible skin (hands, arms, neck, back of head, ears) MUST be the same skin tone as the child in the reference photo. Same ethnicity, same hair color family. A white child has a white parent; a Black child has a Black parent; an East Asian child has an East Asian parent; etc. Do NOT invent a different ethnicity for the parent.`);
    if (parentOutfit) {
      parts.push(`- PARENT OUTFIT (LOCKED): ${parentOutfit} — same outfit on EVERY spread, no changes`);
    }
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

module.exports = { buildSpreadPrompt };
