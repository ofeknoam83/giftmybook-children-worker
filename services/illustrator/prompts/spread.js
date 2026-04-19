/**
 * Illustrator V2 — Per-Spread Prompt Builder
 *
 * Builds the prompt for each spread. Purely image-based character consistency —
 * NO text descriptions of character appearance. The model sees the cover and
 * recent spreads as visual references.
 */

const { getEmotionalBeat, BEAT_CAMERA, PARENT_THEMES, ART_STYLE_CONFIG } = require('../config');
const { buildTextInstruction } = require('./text');

/**
 * Build the per-spread generation prompt.
 *
 * @param {object} opts
 * @param {number} opts.spreadIndex - 0-based spread index
 * @param {number} opts.totalSpreads - Total number of spreads
 * @param {string} opts.scenePrompt - The spread_image_prompt from the writer
 * @param {string} [opts.leftText] - Text for the left page
 * @param {string} [opts.rightText] - Text for the right page
 * @param {boolean} opts.hasParentOnCover - Whether parent is on the cover
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
    additionalCoverCharacters,
    theme,
    style,
    parentOutfit,
  } = opts;

  const beat = getEmotionalBeat(spreadIndex, totalSpreads);
  const cameraHint = BEAT_CAMERA[beat];
  const parts = [];

  // Header
  parts.push(`## SPREAD ${spreadIndex + 1} OF ${totalSpreads}`);
  parts.push('');

  // Scene description
  parts.push('### SCENE');
  parts.push(scenePrompt);
  parts.push('');

  // Character rules (image-based — no text descriptions)
  parts.push('### CHARACTER RULES');
  parts.push('- Characters must match the reference images EXACTLY');
  parts.push('- HAIR: Same color, length, style, texture as on the cover — do NOT change hairstyle');
  parts.push('- OUTFIT: Same clothes and colors as on the cover — no costume changes for any reason');
  parts.push('- FACE: Same face shape, skin tone, and features as the reference');
  parts.push('- ANATOMY: Exactly 2 hands, 2 arms, 2 legs per person. Keep hands simple — fists, cupped, or gently gripping. AVOID spread-out fingers.');

  if (hasParentOnCover) {
    parts.push('- Parent can appear and must match their cover appearance exactly');
  } else if (additionalCoverCharacters) {
    parts.push('- Secondary characters from the cover can appear and must match exactly');
  } else if (theme && PARENT_THEMES.has(theme)) {
    const isMother = theme === 'mothers_day';
    parts.push(`- The parent is the child's ${isMother ? 'MOTHER (a woman/female)' : 'FATHER (a man/male)'} — ${isMother ? 'NEVER draw a man' : 'NEVER draw a woman'}`);
    parts.push(`- ⚠️ PARENT FACE — COMPLETELY HIDDEN (NON-NEGOTIABLE): We have NO reference photo of the ${isMother ? 'mother' : 'father'}. ${isMother ? 'Her' : 'His'} face must NEVER appear in ANY illustration. Show the parent ONLY through: back view, hands/arms reaching in, kneeling with face cropped out of frame, or side view with face turned away. NEVER show eyes, mouth, nose, or any facial features. This is the #1 rule for the parent.`);
    parts.push('- BODY ORIENTATION: Even with face hidden, the parent must face TOWARD the child (leaning in, reaching, kneeling). NEVER facing away.');
    if (parentOutfit) {
      parts.push(`- PARENT OUTFIT (LOCKED): ${parentOutfit} — same outfit on EVERY spread, no changes`);
    }
  } else {
    parts.push('- NO other human characters — the child is the ONLY person visible. Even if the text mentions a family member, do NOT draw them (no reference image exists).');
  }

  parts.push('- No duplicate characters — the child appears ONCE');
  parts.push('');

  // Format — seamless painting
  parts.push('### FORMAT (CRITICAL — READ BEFORE DRAWING)');
  parts.push('- THIS IS ONE SINGLE SEAMLESS PAINTING — like a wide movie still or a panoramic photograph.');
  parts.push('- The scene flows continuously from the left edge to the right edge with NO visual break, NO divider, NO seam, NO panel split, NO color change, NO lighting change, and NO composition break at the center or anywhere else.');
  parts.push('- Do NOT treat this as two separate images side by side. There must be ZERO visual indication that this image will be split into two pages. Paint it as ONE unified wide scene.');
  parts.push('- ONE continuous background, ONE unified lighting, ONE seamless composition.');
  parts.push('');

  // Composition
  parts.push('### COMPOSITION');
  parts.push(`- Emotional beat: ${beat}`);
  parts.push(`- Camera angle: ${cameraHint}`);
  parts.push('- Important elements should not be placed at the exact left-right center');
  parts.push('- Main character should be in the left third or right third, NOT dead center');
  parts.push('- Fill the entire canvas edge to edge — no blank areas');
  parts.push('');

  // Style consistency reminder — use the actual configured style, defaulting to watercolor
  const styleConfig = ART_STYLE_CONFIG[style] || ART_STYLE_CONFIG.watercolor;
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
