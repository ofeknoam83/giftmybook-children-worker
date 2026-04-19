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
  const styleConfig = ART_STYLE_CONFIG[opts.style] || ART_STYLE_CONFIG.pixar_premium;
  const parts = [];

  parts.push('You are creating illustrations for a personalized children\'s book.');
  parts.push('You will receive reference images of the child (real photo + approved cover) in the first turn.');
  parts.push('Use those images as your ONLY source of truth for character appearance.');
  parts.push('');

  // Art style
  parts.push(`ART STYLE (NON-NEGOTIABLE): ${styleConfig.prefix} ${styleConfig.suffix}`);
  parts.push('This art style is MANDATORY for every single illustration. Do NOT deviate to any other rendering technique.');
  parts.push('Every illustration must use the EXACT SAME rendering technique — if the style says 3D/CGI, every page must be 3D/CGI rendered. If it says watercolor, every page must be watercolor.');
  parts.push('Match the rendering style shown in the approved cover image provided in Turn 1.');
  parts.push('');

  // Character consistency (image-based, no text descriptions)
  parts.push('CHARACTER CONSISTENCY (CRITICAL — READ CAREFULLY):');
  parts.push('- Every character must look IDENTICAL to the reference images provided in Turn 1');
  parts.push('- HAIR: Same hair COLOR, LENGTH, STYLE, and TEXTURE in EVERY illustration. If the child has short dark curly hair on the cover, they must have short dark curly hair on every single page. NEVER change hairstyle, hair color, or hair length.');
  parts.push('- OUTFIT: The child wears the EXACT SAME CLOTHES in EVERY illustration — same colors, same style, same accessories. No costume changes for weather, activity, time of day, or scene. Look at the cover — that outfit is what they wear on EVERY page.');
  parts.push('- FACE: Same face shape, same skin tone, same facial features in EVERY illustration');
  parts.push('- The child\'s eyes must ALWAYS be OPEN and expressive');
  parts.push('- If the reference photo shows closed/squinting eyes, IGNORE that — draw them open');
  parts.push('');

  // Anatomy
  parts.push('ANATOMY RULES (COUNT BEFORE GENERATING):');
  parts.push('- Every person has EXACTLY 2 hands, 2 arms, 2 legs, 2 feet — NO MORE, NO LESS');
  parts.push('- Every hand has EXACTLY 5 fingers — count them before finalizing');
  parts.push('- NEVER generate 3 hands, 3 arms, or any extra limbs');
  parts.push('- When hands are visible, keep them SIMPLE — fists, cupped, relaxed, or wrapped around objects. AVOID showing individual spread-out fingers.');
  parts.push('- If the child is holding something, show the object clearly and keep the grip natural — do not splay fingers.');
  parts.push('- Proportions appropriate for a young child');
  parts.push('- No merged body parts, no distorted limbs, no body horror');
  parts.push('');

  // Composition
  parts.push('COMPOSITION (CRITICAL):');
  parts.push('- EVERY illustration is ONE SINGLE SEAMLESS PAINTING — like a wide movie still or panoramic photograph.');
  parts.push('- The scene flows continuously from left edge to right edge with NO visual break, NO divider, NO seam, NO panel split, NO color change, NO lighting change, and NO composition break ANYWHERE.');
  parts.push('- NEVER draw two separate images side by side. NEVER split into left panel and right panel. There must be ZERO visual indication of a center divide.');
  parts.push('- ONE continuous background, ONE unified lighting, ONE seamless composition across the full width.');
  parts.push('- Each illustration is one single moment — not a comic strip or sequence');
  parts.push('- Fill the entire canvas edge to edge — no blank areas');
  parts.push('- Wide cinematic 16:9 panoramic format');
  parts.push('- Important elements should NOT be placed at the exact left-right center');
  parts.push('');

  // Content rules
  parts.push('CONTENT RULES:');
  parts.push('- All content must be age-appropriate for children ages 2-8');
  parts.push('- Wholesome, warm, family-friendly');
  parts.push('- No scary imagery, no violence, no dark themes');
  parts.push('- COLOR VARIETY: Even if the scene mentions a favorite color, the illustration should have a natural, varied palette. Do NOT flood the entire scene with one color. A pink dress is fine; an all-pink world is not.');
  parts.push('');

  // Parent visibility
  if (opts.hasParentOnCover) {
    parts.push('PARENT CHARACTER:');
    parts.push('- A parent appears on the approved cover and MAY appear in illustrations');
    parts.push('- The parent must look IDENTICAL to their cover appearance in every spread');
    parts.push('- Same face, hair, skin tone, outfit as on the cover');
    parts.push('');
  } else if (opts.theme && PARENT_THEMES.has(opts.theme)) {
    const isMother = opts.theme === 'mothers_day';
    const parentLabel = isMother ? 'MOTHER (female woman)' : 'FATHER (male man)';
    const parentPronoun = isMother ? 'her' : 'his';
    parts.push(`⚠️ PARENT CHARACTER — ${parentLabel} (FACE COMPLETELY HIDDEN — #1 RULE):`);
    parts.push(`- The story references the child's ${isMother ? 'mother' : 'father'} but we have NO reference image`);
    parts.push(`- The parent is ${isMother ? 'FEMALE — always draw a woman, never a man' : 'MALE — always draw a man, never a woman'}`);
    parts.push(`- THE PARENT'S FACE MUST NEVER BE VISIBLE IN ANY ILLUSTRATION. No eyes, no mouth, no nose, no facial features. This is because we have no photo — showing a face would make it look different on every page.`);
    parts.push(`- Show ${isMother ? 'her' : 'him'} ONLY through: hands reaching toward the child, arms around the child, back view, kneeling with face cropped out of frame, or side view with face turned away and obscured. If the parent is sitting, show from behind or with face out of frame.`);
    parts.push(`- BODY ORIENTATION: The parent's body must face TOWARD the child — leaning in, bending down, reaching out. NEVER facing away from the child.`);
    parts.push(`- The ${isMother ? 'mother' : 'father'} should feel warm and physically present — just with ${parentPronoun} face completely hidden`);
    if (opts.parentOutfit) {
      parts.push(`- PARENT OUTFIT LOCK (CRITICAL): The ${isMother ? 'mother' : 'father'} MUST wear EXACTLY this outfit in EVERY illustration — no exceptions: ${opts.parentOutfit}`);
      parts.push(`- Do NOT change the parent's outfit for any reason. Same garments, same colors, every single page.`);
    }
    parts.push('');
  } else {
    parts.push('NO FAMILY MEMBERS (ABSOLUTE — NO EXCEPTIONS):');
    parts.push('- Do NOT draw any real human characters besides the child — no parents, grandparents, siblings, aunts, uncles, or any other family members.');
    parts.push('- This rule applies EVEN IF the story text mentions a family member by name. We have NO reference image for them, so drawing them would produce inconsistent faces across pages.');
    parts.push('- If the scene text mentions a family member, show their PRESENCE through traces only: a hand reaching from off-screen, a shadow, belongings, or evidence they were there. NEVER their face or full body.');
    parts.push('- The child may interact with fictional/non-human characters (animals, fairies, shopkeepers).');
    parts.push('');
  }

  // Text rendering rules
  parts.push('TEXT RENDERING RULES:');
  parts.push(`- Font: ${TEXT_RULES.fontStyle}`);
  parts.push('- The font MUST be IDENTICAL on every single page — same font family, same weight, same size. If in doubt, use a plain clean serif. NEVER switch fonts between pages.');
  parts.push(`- Size: ${TEXT_RULES.fontSize}. The illustration is the star.`);
  parts.push(`- Color: ${TEXT_RULES.fontColor}`);
  parts.push('- Text must be CRISP and SHARP — NOT blurry or fuzzy');
  parts.push(`- Maximum ${TEXT_RULES.maxWordsPerLine} words per line`);
  parts.push('- Text can be placed anywhere vertically (top, bottom, upper-left, lower-right, etc.)');
  parts.push(`- CENTER NO-TEXT ZONE (MOST COMMON MISTAKE — READ CAREFULLY): This image will be printed as a two-page spread, folded at the EXACT center. Any text near the center will disappear into the book's spine and be unreadable. The middle ${TEXT_RULES.centerExclusionPercent * 2}% is FORBIDDEN for text. ALL text must be placed entirely within the LEFT ${50 - TEXT_RULES.centerExclusionPercent}% or the RIGHT ${50 - TEXT_RULES.centerExclusionPercent}% of the image. If in doubt, push text further toward the edge.`);
  parts.push(`- EDGE PADDING: at least ${TEXT_RULES.edgePaddingPercent}% from left, right, and top edges`);
  parts.push(`- BOTTOM PADDING (CRITICAL): at least ${TEXT_RULES.bottomPaddingPercent}% from the BOTTOM edge — the bottom gets cropped during print. Text near the bottom WILL be cut off.`);
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
