/**
 * Illustrator V2 — Shared rule blocks (single source of truth for system + spread prompts).
 * Keeps composition, character lock, and parent-theme wording aligned.
 */

const { ART_STYLE_CONFIG, PARENT_THEMES, TEXT_RULES } = require('../config');
const { buildTextMidlineEnforcementBlock } = require('./text');

const LOCKED_3D_STYLES = new Set(['pixar_premium', 'cinematic_3d', 'graphic_novel_cinematic']);

/**
 * Global precedence: scene/rhyme loses to identity and hard layout rules.
 * @returns {string}
 */
function buildPrecedenceBlock() {
  return [
    'RULE PRECEDENCE (NON-NEGOTIABLE):',
    '- If the SCENE description, rhyme, or on-image story text conflicts with character identity (hero / parent / companion), single-seamless composition, embedded text policy, or safety rules below, the rules below WIN.',
    '- Do not follow scene text when it would break those policies.',
    '',
  ].join('\n');
}

/**
 * Critical rules block for per-spread prompt (mirrors system composition intent).
 * @returns {string}
 */
function buildSpreadCriticalRules() {
  return [
    '### CRITICAL RULES — READ BEFORE DRAWING',
    '- ONE HERO: The main child appears EXACTLY ONCE in this image. No duplicates, no twin, no reflection/photo copy, no before-and-after sequence of the same child.',
    '- ONE MOMENT: This is ONE single moment in time — not a comic strip, not a diptych, not two scenes side by side, not a before/after, not a split-panel.',
    '- ONE SEAMLESS PAINTING (NON-NEGOTIABLE): A single continuous panoramic illustration. NO vertical seam anywhere in the image. NO mid-frame background change. NO lighting break. NO color-palette break. NO horizon jump. NO mirrored halves. NO border, divider, frame, or gutter between left and right halves.',
    '- DO NOT COMPOSE FOR A BOOK FOLD: ignore any mental model of "left page vs right page". This is ONE single image, not two pages joined together. Treat the canvas as a single photograph — never as a spread that will be folded.',
    '- CONTINUITY TEST: If you mentally draw a vertical line anywhere in this image, BOTH sides of that line must show the SAME room, SAME background, SAME time of day, SAME weather, and the SAME lighting. If any vertical line would split the image into two differently-lit or differently-placed scenes, you have FAILED and must recompose as one scene.',
    '- HERO SAFE ZONE: The main character\'s head and full face must be inside the middle 80% of the image — never cropped at the top, bottom, left, or right edge. Leave at least 8% of image height above the top of the hero\'s head. Do NOT let text cover the hero\'s head, face, or eyes.',
    '',
  ].join('\n');
}

/**
 * @param {object} opts
 * @param {string} opts.style
 * @returns {string[]}
 */
function buildArtStyleLines(opts) {
  const styleConfig = ART_STYLE_CONFIG[opts.style] || ART_STYLE_CONFIG.pixar_premium;
  const isLocked3D = LOCKED_3D_STYLES.has(opts.style);
  const lines = [
    `ART STYLE (NON-NEGOTIABLE): ${styleConfig.prefix} ${styleConfig.suffix}`,
    'This art style is MANDATORY for every single illustration. Do NOT deviate to any other rendering technique.',
    'Every illustration must use the EXACT SAME rendering technique — if the style says 3D/CGI, every page must be 3D/CGI rendered. If it says watercolor, every page must be watercolor.',
  ];
  if (isLocked3D) {
    lines.push('The approved cover image is your reference for CHARACTER IDENTITY ONLY (face, hair, skin tone, outfit, colour palette). DO NOT match the cover\'s rendering medium or brush style — the rendering medium is locked to premium 3D CGI as stated above, regardless of how the cover looks.');
  } else {
    lines.push('Match the rendering style shown in the approved cover image provided in Turn 1.');
  }
  return lines;
}

/**
 * @returns {string[]}
 */
function buildCharacterConsistencyLines() {
  return [
    'CHARACTER CONSISTENCY (CRITICAL — READ CAREFULLY):',
    '- Every character must look IDENTICAL to the reference images provided in Turn 1',
    '- HAIR: Same hair COLOR, LENGTH, STYLE, and TEXTURE in EVERY illustration. If the child has short dark curly hair on the cover, they must have short dark curly hair on every single page. NEVER change hairstyle, hair color, or hair length.',
    '- OUTFIT: The child wears the EXACT SAME CLOTHES in EVERY illustration — same colors, same style, same accessories. No costume changes for weather, activity, time of day, or scene. Look at the cover — that outfit is what they wear on EVERY page.',
    '- FACE: Same face shape, same skin tone, same facial features in EVERY illustration',
    '- The child\'s eyes must ALWAYS be OPEN and expressive',
    '- If the reference photo shows closed/squinting eyes, IGNORE that — draw them open',
  ];
}

/**
 * @returns {string[]}
 */
function buildAnatomyLines() {
  return [
    'ANATOMY RULES (COUNT BEFORE GENERATING):',
    '- Every person has EXACTLY 2 hands, 2 arms, 2 legs, 2 feet — NO MORE, NO LESS',
    '- Every hand has EXACTLY 5 fingers — count them before finalizing',
    '- NEVER generate 3 hands, 3 arms, or any extra limbs',
    '- When hands are visible, keep them SIMPLE — fists, cupped, relaxed, or wrapped around objects. AVOID showing individual spread-out fingers.',
    '- If the child is holding something, show the object clearly and keep the grip natural — do not splay fingers.',
    '- Proportions appropriate for a young child',
    '- No merged body parts, no distorted limbs, no body horror',
  ];
}

/**
 * @returns {string[]}
 */
function buildCompositionSystemLines() {
  return [
    'COMPOSITION (CRITICAL):',
    '- EVERY illustration is a SINGLE PHOTOGRAPH of ONE scene. It is NOT a book layout. It is NOT two pages. It is NOT designed to be split in half. Think of it as one wide movie still captured in one frame.',
    '- EVERY illustration is ONE SINGLE SEAMLESS PAINTING — like a wide movie still or panoramic photograph.',
    '- The scene flows continuously from left edge to right edge with NO visual break, NO divider, NO seam, NO panel split, NO color change, NO lighting change, and NO composition break ANYWHERE.',
    '- NEVER draw two separate images side by side. NEVER split into left panel and right panel. There must be ZERO visual indication of a center divide.',
    '- NEVER draw a diptych, a before-and-after, mirrored halves, a filmstrip, or a comic-style panel grid.',
    '- ONE continuous background, ONE unified lighting, ONE seamless composition across the full width.',
    '- CONTINUITY TEST: drawing an imaginary vertical line anywhere in the image must NOT split it into two differently-lit or differently-placed scenes. Both halves of any vertical slice must show the SAME room / SAME outdoor setting / SAME time of day.',
    '- Each illustration is one single moment — not a comic strip or sequence',
    '- HERO SAFE ZONE: the main character\'s head and full face must sit inside the middle 80% of the frame. NEVER crop the hero\'s head at the top, bottom, left, or right edge. Leave at least 8% of image height above the top of the hero\'s head.',
    '- Fill the entire canvas edge to edge — no blank areas',
    '- Wide cinematic 16:9 panoramic format',
    '- Important elements should NOT be placed at the exact left-right center',
  ];
}

/**
 * @returns {string[]}
 */
function buildContentRulesLines() {
  return [
    'CONTENT RULES:',
    '- All content must be age-appropriate for children ages 2-8',
    '- Wholesome, warm, family-friendly',
    '- No scary imagery, no violence, no dark themes',
    '- COLOR VARIETY: Even if the scene mentions a favorite color, the illustration should have a natural, varied palette. Do NOT flood the entire scene with one color. A pink dress is fine; an all-pink world is not.',
  ];
}

/**
 * @param {string} theme
 * @returns {string[]}
 */
function buildParentLexiconLines(theme) {
  if (!theme || !PARENT_THEMES.has(theme)) return [];
  const isMother = theme === 'mothers_day';
  const parentLex = isMother
    ? 'Mama, Mom, Mommy, Mother'
    : 'Dad, Daddy, Papa, Father';
  const parentRole = isMother ? 'mother' : 'father';
  const parentHuman = isMother ? 'woman' : 'man';
  return [
    `${isMother ? 'MOTHER\'S DAY' : 'FATHER\'S DAY'} — FAMILY ROLE WORDS vs NON-HUMAN COMPANIONS (CRITICAL):`,
    `- In story text and on-image lettering, ${parentLex} always means the child's HUMAN ${parentRole} — a ${parentHuman}.`,
    '- Those words NEVER mean a toy, comfort object, pet, mascot, illustrated figure on a card, fantasy creature, or any other non-human companion—unless a line explicitly says pretend-play AND the human parent still appears as required below.',
    '- Non-human companions (match the cover/reference) keep their real type and scale. They must NOT replace the human parent or take over the parent\'s caregiving actions (e.g. walking as the child\'s guardian, pushing a stroller as the parent, reading aloud as the parent figure). Those actions belong to the HUMAN parent.',
    '- Do not upscale or anthropomorphize a companion into a life-sized adult stand-in for the human parent when the wording names Mom/Dad/Mama/Papa.',
  ];
}

/**
 * @param {object} opts
 * @param {boolean} opts.hasSecondaryOnCover
 * @param {boolean} opts.hasParentOnCover
 * @param {string} [opts.theme]
 * @returns {string[]}
 */
function buildSecondaryOnCoverLines(opts) {
  const { hasSecondaryOnCover, hasParentOnCover, theme } = opts;
  if (!hasSecondaryOnCover) return [];
  const isParentTheme = theme && PARENT_THEMES.has(theme);
  const isMother = theme === 'mothers_day';
  const lines = [
    'SECONDARY CHARACTERS ON COVER (LOCKED — APPLIES TO EVERY NON-CHILD ON THE COVER):',
    '- Every non-child character visible on the approved cover must appear in illustrations EXACTLY as shown on the cover.',
    '- Each of them, individually: same face shape, hair color/length/style, skin tone, outfit, build, distinguishing features. No variations across pages.',
    '- MEDIA EXCLUSION: This lock applies only to flesh-and-blood characters physically present in the cover scene. Figures depicted INSIDE media (a performer on a TV/tablet/phone/computer/cinema screen, a face in a framed photo, poster, magazine cover, book cover, billboard, or painting) are scene decor — not recurring characters. When drawing screens/posters/photo frames in other spreads, you are FREE to show different programs/artworks/figures; do NOT try to replicate the cover\'s on-screen performer or on-poster figure.',
  ];
  if (isParentTheme && !hasParentOnCover) {
    lines.push(`- IMPORTANT: The person visible on the cover is NOT the ${isMother ? 'mother' : 'father'}. They are a different character (sibling, grandparent, friend). Do NOT treat them as the parent.`);
  }
  if (hasParentOnCover) {
    lines.push('- The themed parent IS among the cover characters and falls under this same lock — they appear in scenes where mentioned and must look identical to their cover appearance.');
  }
  return lines;
}

/**
 * Hidden-face parent (system instruction — full).
 * @param {object} opts
 * @param {boolean} opts.hasSecondaryOnCover
 * @param {string|null} [opts.parentOutfit]
 * @param {string} opts.theme
 * @returns {string[]}
 */
function buildHiddenParentSystemLines(opts) {
  const { hasSecondaryOnCover, parentOutfit, theme } = opts;
  const isMother = theme === 'mothers_day';
  const parentLabel = isMother ? 'MOTHER (female woman)' : 'FATHER (male man)';
  const parentPronoun = isMother ? 'her' : 'his';
  const lines = [
    `⚠️ PARENT CHARACTER — ${parentLabel} (FACE COMPLETELY HIDDEN — #1 RULE):`,
  ];
  if (hasSecondaryOnCover) {
    lines.push(`- The person visible on the cover is NOT the ${isMother ? 'mother' : 'father'}. The ${isMother ? 'mother' : 'father'} is a SEPARATE character who has NO reference image.`);
  }
  lines.push(
    `- The story references the child's ${isMother ? 'mother' : 'father'} but we have NO reference image`,
    `- The parent is ${isMother ? 'FEMALE — always draw a woman, never a man' : 'MALE — always draw a man, never a woman'}`,
    '- THE PARENT\'S FACE MUST NEVER BE VISIBLE IN ANY ILLUSTRATION. No eyes, no mouth, no nose, no facial features. This is because we have no photo — showing a face would make it look different on every page.',
    `- Show ${isMother ? 'her' : 'him'} ONLY through: hands reaching toward the child, arms around the child, back view, kneeling with face cropped out of frame, or side view with face turned away and obscured. If the parent is sitting, show from behind or with face out of frame.`,
    '- NEVER use a solid black rectangle, black bar, opaque censor block, void, hole, or placeholder shape where a face would be — that is a broken image, not illustration. Hide faces only with real composition (angle, crop, hair, body position, soft backlight). The painting must look seamless and finished.',
    '- BODY ORIENTATION: The parent\'s body must face TOWARD the child — leaning in, bending down, reaching out. NEVER facing away from the child.',
    `- The ${isMother ? 'mother' : 'father'} should feel warm and physically present — just with ${parentPronoun} face completely hidden`,
    `- ⚠️ FAMILY RESEMBLANCE (HARD RULE): The parent is biologically related to the child. ${isMother ? 'Her' : 'His'} SKIN TONE, HAIR COLOR, and ETHNICITY must match the child's photo. Use the child's photograph as the BASELINE for family appearance. The parent's visible skin (hands, arms, neck, back of head, ears) must be the SAME skin tone as the child's skin in the photograph — not lighter, not darker, not a different ethnicity. Hair color/texture should be in the same family as the child's. Never draw a black-skinned parent for a white-skinned child or vice versa. If the child in the photo looks East Asian, the parent is East Asian; if South Asian, the parent is South Asian; if white, the parent is white; if Black, the parent is Black; and so on.`,
  );
  if (parentOutfit) {
    lines.push(
      `- PARENT OUTFIT LOCK (CRITICAL): The ${isMother ? 'mother' : 'father'} MUST wear EXACTLY this outfit in EVERY illustration — no exceptions: ${parentOutfit}`,
      '- Do NOT change the parent\'s outfit for any reason. Same garments, same colors, every single page.',
    );
  }
  return lines;
}

/**
 * Hidden-face parent (per-spread — compact bullets).
 * @param {object} opts
 * @param {boolean} opts.secondaryOnCover
 * @param {string|null} [opts.parentOutfit]
 * @param {string} opts.theme
 * @returns {string[]}
 */
function buildHiddenParentSpreadLines(opts) {
  const { secondaryOnCover, parentOutfit, theme } = opts;
  const isMother = theme === 'mothers_day';
  const lines = [
    `- The parent is the child's ${isMother ? 'MOTHER (a woman/female)' : 'FATHER (a man/male)'} — ${isMother ? 'NEVER draw a man as the mother' : 'NEVER draw a woman as the father'}`,
  ];
  if (secondaryOnCover) {
    lines.push(`- ⚠️ THE SECONDARY CHARACTER ON THE COVER IS NOT THE ${isMother ? 'MOTHER' : 'FATHER'}. Do NOT treat them as the parent. The ${isMother ? 'mother' : 'father'} is a SEPARATE character who has NO reference image.`);
  }
  lines.push(
    `- ⚠️ PARENT FACE — COMPLETELY HIDDEN (NON-NEGOTIABLE): We have NO reference photo of the ${isMother ? 'mother' : 'father'}. ${isMother ? 'Her' : 'His'} face must NEVER appear in ANY illustration. Show the parent ONLY through: back view, hands/arms reaching in, kneeling with face cropped out of frame, or side view with face turned away. NEVER show eyes, mouth, nose, or any facial features. This is the #1 rule for the parent.`,
    '- NEVER put a solid black box, bar, or opaque mask over the parent\'s head — use natural framing only. No censor artifacts, voids, or "missing face" patches.',
    '- BODY ORIENTATION: Even with face hidden, the parent must face TOWARD the child (leaning in, reaching, kneeling). NEVER facing away.',
    `- ⚠️ FAMILY RESEMBLANCE: The ${isMother ? 'mother' : 'father'}'s visible skin (hands, arms, neck, back of head, ears) MUST be the same skin tone as the child in the reference photo. Same ethnicity, same hair color family. A white child has a white parent; a Black child has a Black parent; an East Asian child has an East Asian parent; etc. Do NOT invent a different ethnicity for the parent.`,
  );
  if (parentOutfit) {
    lines.push(`- PARENT OUTFIT (LOCKED): ${parentOutfit} — same outfit on EVERY spread, no changes`);
  }
  return lines;
}

/**
 * @returns {string[]}
 */
function buildNoFamilyLines() {
  return [
    'NO FAMILY MEMBERS (ABSOLUTE — NO EXCEPTIONS):',
    '- Do NOT draw any real human characters besides the child — no parents, grandparents, siblings, aunts, uncles, or any other family members.',
    '- This rule applies EVEN IF the story text mentions a family member by name. We have NO reference image for them, so drawing them would produce inconsistent faces across pages.',
    '- If the scene text mentions a family member, show their PRESENCE through traces only: a hand reaching from off-screen, a shadow, belongings, or evidence they were there. NEVER their face or full body.',
    '- The child may interact with fictional/non-human characters (animals, fairies, shopkeepers).',
  ];
}

/**
 * Text rendering for system instruction (aligned with per-spread text.js — no "anywhere vertically").
 * @returns {string[]}
 */
function buildTextRenderingSystemLines() {
  return [
    'TEXT RENDERING RULES:',
    'FONT IS A HARD CONSTRAINT (MOST COMMON QA FAILURE — READ TWICE):',
    `- Font: ${TEXT_RULES.fontStyle}`,
    '- The font MUST be PIXEL-IDENTICAL on every single page of this book. Same family, same weight, same slant, same x-height, same stroke contrast, same letter spacing. Treat spread 1\'s font as a locked reference — every subsequent spread must match it exactly.',
    '- NEVER switch fonts between pages. Do NOT vary the font for emphasis, for different moods, or to match the illustration.',
    '- NEVER use: handwritten, script, cursive, calligraphic, italic, bold display, bubble, rounded, Comic Sans, Papyrus, Chalkboard, Impact, Marker, Dancing Script, decorative, thin modern sans, condensed, or stenciled fonts. If any text in this book looks playful, hand-drawn, or decorative, that is a FAILURE and must be regenerated.',
    '- Upright only — never italic, never oblique.',
    '- When in doubt, render as plain Georgia regular weight.',
    `- Size: ${TEXT_RULES.fontSize}. The illustration is the star.`,
    `- Color: ${TEXT_RULES.fontColor}`,
    '- Text must be CRISP and SHARP — NOT blurry or fuzzy',
    `- Maximum ${TEXT_RULES.maxWordsPerLine} words per line`,
    '- EMBEDDED TEXT POSITION: Each spread specifies an anchor (left or right strip, upper or lower). Place ALL story text only in that anchor, with the padding and center no-text rules below — do not invent a different corner or a second text block.',
    `- CENTER NO-TEXT ZONE (MOST COMMON MISTAKE — READ CAREFULLY): The illustration is ONE single image, not a book layout. The middle ${TEXT_RULES.centerExclusionPercent * 2}% of the image is reserved for imagery only — keep it free of text. Place ALL text entirely within either the LEFT ${50 - TEXT_RULES.centerExclusionPercent}% strip or the RIGHT ${50 - TEXT_RULES.centerExclusionPercent}% strip of the image, per that spread's instruction. If in doubt, push text further toward the edge. Do NOT draw or imply any center fold, page break, or spine.`,
    `- ${buildTextMidlineEnforcementBlock()}`,
    `- EDGE PADDING: at least ${TEXT_RULES.edgePaddingPercent}% from left and right edges`,
    `- TOP PADDING: at least ${TEXT_RULES.topPaddingPercent}% from the TOP edge — text should never feel cramped against the top of the image.`,
    `- BOTTOM PADDING (CRITICAL): at least ${TEXT_RULES.bottomPaddingPercent}% from the BOTTOM edge — the bottom gets cropped during print. Text near the bottom WILL be cut off.`,
    '- Main characters and key action should not be hidden behind text. NEVER place text over the hero\'s head, face, or eyes.',
  ];
}

/**
 * @returns {string[]}
 */
function buildDuplicatePreventionLines() {
  return [
    'DUPLICATE PREVENTION:',
    '- Check for items that appear twice in the same illustration',
    '- No cloned/copy-pasted objects — each item should be unique',
  ];
}

/**
 * Spread CHARACTER RULES bullet lines (non-parent-specific baseline; no ### header).
 * @returns {string[]}
 */
function buildSpreadCharacterBaselineLines() {
  return [
    '- Characters must match the reference images EXACTLY',
    '- HAIR: Same color, length, style, texture as on the cover — do NOT change hairstyle',
    '- OUTFIT: Same clothes and colors as on the cover — no costume changes for any reason',
    '- FACE: Same face shape, skin tone, and features as the reference',
    '- ANATOMY: Exactly 2 hands, 2 arms, 2 legs per person. Keep hands simple — fists, cupped, or gently gripping. AVOID spread-out fingers.',
  ];
}

/**
 * Parent lexicon single bullet for spread (compact).
 * @param {string} theme
 * @returns {string|null}
 */
function buildSpreadParentLexiconBullet(theme) {
  if (!theme || !PARENT_THEMES.has(theme)) return null;
  const isMother = theme === 'mothers_day';
  return `- ⚠️ PARENT WORDS = HUMAN PARENT ONLY: ${isMother ? 'Mama/Mom/Mother' : 'Dad/Daddy/Papa'} in the text refers to the human ${isMother ? 'mother (woman)' : 'father (man)'} — not a toy, pet, or other non-human on the cover. Keep every companion true to its type and scale. Caregiving / guardian actions (stroller, walking beside as parent, lifting as parent) belong to the human ${isMother ? 'mother' : 'father'} per the rules below.`;
}

/**
 * Secondary locked bullet for spread.
 * @returns {string}
 */
function buildSpreadSecondaryLockedBullet() {
  return '- SECONDARY CHARACTERS (LOCKED): Every non-child character visible on the cover must appear in illustrations EXACTLY as shown on the cover — same face, hair, skin tone, outfit, build. This applies to each of them individually.';
}

module.exports = {
  buildPrecedenceBlock,
  buildSpreadCriticalRules,
  buildArtStyleLines,
  buildCharacterConsistencyLines,
  buildAnatomyLines,
  buildCompositionSystemLines,
  buildContentRulesLines,
  buildParentLexiconLines,
  buildSecondaryOnCoverLines,
  buildHiddenParentSystemLines,
  buildHiddenParentSpreadLines,
  buildNoFamilyLines,
  buildTextRenderingSystemLines,
  buildDuplicatePreventionLines,
  buildSpreadCharacterBaselineLines,
  buildSpreadParentLexiconBullet,
  buildSpreadSecondaryLockedBullet,
  LOCKED_3D_STYLES,
};
