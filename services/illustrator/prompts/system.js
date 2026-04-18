/**
 * Illustrator V2 — System Instruction Builder
 *
 * Builds the system instruction for the Gemini chat session.
 * Rules-only — NO character text descriptions. Character consistency
 * is achieved purely through image references (cover + photo).
 */

const { ART_STYLE_CONFIG, PARENT_THEMES, TEXT_RULES } = require('../config');

/**
 * Build the system instruction text.
 *
 * @param {object} opts
 * @param {string} opts.style - Art style key
 * @param {boolean} opts.hasParentOnCover - Whether parent appears on the approved cover
 * @param {string} [opts.theme] - Book theme (mothers_day, fathers_day, etc.)
 * @returns {string}
 */
function buildSystemInstruction(opts) {
  const styleConfig = ART_STYLE_CONFIG[opts.style] || ART_STYLE_CONFIG.watercolor;
  const parts = [];

  parts.push('You are creating illustrations for a personalized children\'s book.');
  parts.push('You will receive reference images of the child (real photo + approved cover) in the first turn.');
  parts.push('Use those images as your ONLY source of truth for character appearance.');
  parts.push('');

  // Art style
  parts.push(`ART STYLE: ${styleConfig.prefix} ${styleConfig.suffix}`);
  parts.push('Maintain this exact art style in every illustration.');
  parts.push('');

  // Character consistency (image-based, no text descriptions)
  parts.push('CHARACTER CONSISTENCY (CRITICAL):');
  parts.push('- Every character must look IDENTICAL to the reference images provided in Turn 1');
  parts.push('- Same face, hair, skin tone, body proportions in EVERY illustration');
  parts.push('- Same outfit in EVERY spread — no costume changes, no activity-specific clothing');
  parts.push('- The child\'s eyes must ALWAYS be OPEN and expressive');
  parts.push('- If the reference photo shows closed/squinting eyes, IGNORE that — draw them open');
  parts.push('');

  // Anatomy
  parts.push('ANATOMY RULES:');
  parts.push('- 5 fingers per hand, 2 arms, 2 legs — count before generating');
  parts.push('- Proportions appropriate for a young child');
  parts.push('- No extra limbs, no merged body parts, no body horror');
  parts.push('');

  // Composition
  parts.push('COMPOSITION:');
  parts.push('- Each illustration is ONE single moment — not a comic strip or sequence');
  parts.push('- Fill the entire canvas edge to edge with the illustration');
  parts.push('- No blank areas, no reserved zones');
  parts.push('- Wide cinematic 16:9 panoramic format');
  parts.push('- THIS IS ONE SINGLE SEAMLESS PAINTING — continuous from left to right edge');
  parts.push('- No visual break, divider, seam, or panel split anywhere');
  parts.push('- Important elements should NOT be placed at the exact left-right center');
  parts.push('');

  // Content rules
  parts.push('CONTENT RULES:');
  parts.push('- All content must be age-appropriate for children ages 2-8');
  parts.push('- Wholesome, warm, family-friendly');
  parts.push('- No scary imagery, no violence, no dark themes');
  parts.push('');

  // Parent visibility
  if (opts.hasParentOnCover) {
    parts.push('PARENT CHARACTER:');
    parts.push('- A parent appears on the approved cover and MAY appear in illustrations');
    parts.push('- The parent must look IDENTICAL to their cover appearance in every spread');
    parts.push('- Same face, hair, skin tone, outfit as on the cover');
    parts.push('');
  } else if (opts.theme && PARENT_THEMES.has(opts.theme)) {
    parts.push('PARENT CHARACTER (NO FACE):');
    parts.push('- The story references a parent but we have NO reference image');
    parts.push('- NEVER show the parent\'s full face — it would look different on every page');
    parts.push('- Show parent through: hands, arms, back view, side view with face turned away, silhouette, or cropped at frame edge');
    parts.push('- The parent should feel warm and physically present — just with face hidden');
    parts.push('');
  } else {
    parts.push('NO FAMILY MEMBERS:');
    parts.push('- Do NOT draw parents, siblings, or grandparents unless explicitly mentioned in the scene');
    parts.push('- The child may interact with fictional characters (animals, fairies, shopkeepers)');
    parts.push('');
  }

  // Text rendering rules
  parts.push('TEXT RENDERING RULES:');
  parts.push(`- Font: ${TEXT_RULES.fontStyle}`);
  parts.push(`- Size: ${TEXT_RULES.fontSize}. The illustration is the star.`);
  parts.push(`- Color: ${TEXT_RULES.fontColor}`);
  parts.push('- Text must be CRISP and SHARP — NOT blurry or fuzzy');
  parts.push('- EXACT same font style, size, weight, and color on EVERY page');
  parts.push(`- Maximum ${TEXT_RULES.maxWordsPerLine} words per line`);
  parts.push('- Text can be placed anywhere vertically (top, bottom, etc.)');
  parts.push('- Text must NEVER cross the left-right center of the image');
  parts.push('- Entire text block stays completely on the LEFT half or RIGHT half');
  parts.push(`- EDGE PADDING: at least ${TEXT_RULES.edgePaddingPercent}% from ALL edges`);
  parts.push('- Main characters and key action should not be hidden behind text');
  parts.push('');

  // Duplicate item detection
  parts.push('DUPLICATE PREVENTION:');
  parts.push('- Check for items that appear twice in the same illustration');
  parts.push('- No cloned/copy-pasted objects — each item should be unique');
  parts.push('');

  return parts.join('\n');
}

module.exports = { buildSystemInstruction };
