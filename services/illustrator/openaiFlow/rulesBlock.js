/**
 * OpenAI Images 2.0 — slim rules block.
 *
 * gpt-image-2 is stateless and reads the entire prompt fresh on every call,
 * so the ~6KB Gemini system instruction is mostly cost. This block keeps the
 * rules that change pixels (style anchor, anatomy, caption geometry, modesty,
 * cast policy) and drops the multi-paragraph ceremonial repetition. The cover
 * image carried in `image[]` does most of the work — text reinforces, it
 * doesn't recreate it.
 *
 * Returned string is concatenated onto the per-spread prompt by render.js.
 */

const { TEXT_RULES, PARENT_THEMES, resolvePictureBookTextRules } = require('../config');

/**
 * @typedef {Object} RulesBlockOpts
 * @property {boolean} [hasParentOnCover]
 * @property {boolean} [hasSecondaryOnCover]
 * @property {string} [additionalCoverCharacters]
 * @property {string} [theme]
 * @property {string} [parentOutfit]
 * @property {string} [childAppearance]
 * @property {{palette: Array<{id:string,name:string,visual_anchors:string[]}>, beatAssignments: Array<{spread:number, location_id:string}>}} [locationPalette]
 * @property {number|string|null} [childAge]
 */

/**
 * Build the slim, per-call rules block. Called on every spread render.
 *
 * @param {RulesBlockOpts} opts
 * @returns {string}
 */
function buildRulesBlock(opts) {
  const {
    hasParentOnCover,
    hasSecondaryOnCover,
    additionalCoverCharacters,
    theme,
    parentOutfit,
    childAppearance,
    locationPalette,
    childAge,
  } = opts || {};

  const textRules = resolvePictureBookTextRules(childAge);
  const secondaryOnCover = typeof hasSecondaryOnCover === 'boolean'
    ? hasSecondaryOnCover
    : !!additionalCoverCharacters;
  const isParentTheme = PARENT_THEMES.has(theme);
  const isMother = theme === 'mothers_day';
  const parentWord = isMother ? 'mother' : 'father';
  const parentShort = isMother ? 'mom' : 'dad';

  const blocks = [];

  blocks.push(
`### STYLE (HARD)
3D CGI Pixar feature-film still — photoreal subsurface skin scattering, individually rendered hair strands, physically based materials, ray-traced volumetric light, real optical depth-of-field. Match the BOOK COVER reference exactly.
NOT a 2D illustration, NOT watercolor / gouache / pencil / ink, NOT painterly storybook art, NOT cel-shaded anime, NOT a photograph, NOT a flat vector. If the cover reads like a Pixar frame, every spread reads like a Pixar frame.`
  );

  blocks.push(
`### CHARACTER (HARD)
The hero on the cover is the ONLY hero. Same face, ethnicity, skin tone, eye color, hair color and length, hairstyle, body proportions — every spread.${childAppearance ? ` Reference description: ${childAppearance}.` : ''}
Outfit: copy the cover outfit family (top, bottom, shoes, color story). Do not invent a new outfit each spread. Situational swaps allowed only if the SCENE explicitly requires (pajamas, swim, snow layer, towel, bath foam).
ONE single connected body — head → neck → torso → hips → legs → feet on one silhouette, one outfit attached top-to-bottom. No floating second torso, no extra pair of legs, no ghost duplicates. Anatomically correct hands (5 fingers), feet, and faces.
EXACTLY ONE hero per spread. No twins, no mirror duplicates, no montages.`
  );

  blocks.push(
`### BATH / SWIM / SHOWER (modest, family-broadcast safe)
Bathtub: thick opaque bubble foam covers torso/hips/legs; show face, expression, wet hair, arms to mid-forearm, toy. Towel-wrapped beat is also fine.
Pool / swim: simple modest swimwear — one-piece or swim shirt + trunks, kid-friendly colors.
Shower: prefer steam, silhouette, frosted glass, or towel-wrap.
Never show the child fully clothed in bath water. Never explicit nudity.`
  );

  blocks.push(buildCastPolicy({
    secondaryOnCover,
    hasParentOnCover,
    isParentTheme,
    isMother,
    parentWord,
    parentShort,
    parentOutfit,
    additionalCoverCharacters,
    childAppearance,
  }));

  const namedLocations = buildNamedLocationsBlock(locationPalette);
  if (namedLocations) blocks.push(namedLocations);

  blocks.push(
`### COMPOSITION (HARD)
One hero, one moment, ONE seamless 16:9 panorama. Both halves show the SAME environment — same ground, sky, light, perspective, atmosphere. NO vertical seam, NO lighting jump at center, NO diptych, NO before/after panels. The printer cuts this image down the middle for binding; the spine must be invisible in the art.
The text-side is just a naturally less-busy region of the same scene (open sky, soft-focus background, foliage, water). Do NOT empty out a half to make a "text canvas".
NO readable in-world text — no shop signs, banners, posters, menus, chalkboards, product labels, page numbers. The ONLY readable text on the image is the caption from §CAPTION below.`
  );

  blocks.push(buildCaptionRules(textRules));

  blocks.push(
`### OUTPUT
Exactly ONE image, full-bleed 16:9 landscape, no border, no watermark, no commentary text on or off the image other than the caption defined in §CAPTION.`
  );

  return blocks.join('\n\n');
}

/**
 * Compact cast / family-presence policy. Mirrors the long Gemini systemInstruction
 * branch but in ~1/4 the tokens.
 */
function buildCastPolicy(ctx) {
  const {
    secondaryOnCover,
    hasParentOnCover,
    isParentTheme,
    isMother,
    parentWord,
    parentShort,
    parentOutfit,
    additionalCoverCharacters,
    childAppearance,
  } = ctx;

  const lines = ['### CAST'];

  if (secondaryOnCover) {
    lines.push(
      `Cover shows hero + additional people: ${additionalCoverCharacters || 'see cover image'}. Each non-hero on the cover keeps their EXACT cover face, hair, skin, build, outfit on every spread they appear in.`,
    );
    if (hasParentOnCover) {
      lines.push(`The themed ${parentWord} IS on the cover; ${parentShort} keeps the cover look on every spread.`);
    } else if (isParentTheme) {
      lines.push(`The additional cover person is NOT the ${parentWord} (sibling/grandparent/friend). Do not draw them as the ${parentWord}.`);
    }
  } else {
    lines.push(
      'Cover shows ONLY the hero child. Do not invent new full-face humans (siblings, grandparents, classmates, neighbors, background pedestrians).',
      'When the spread prompt names an adult (parent, grandparent), show them by IMPLIED PRESENCE only: a hand or arm, the back of a head, a cropped torso (face out of frame), a shoulder silhouette, or a personal object that stands in (mug, coat). Never the adult\'s face, never a full-body adult.',
    );
  }

  lines.push(
    'IMPLIED-PRESENCE ANATOMY: any visible limb must be plausibly anchored — sleeve continues to frame edge, OR a shoulder/cropped torso is visible as anchor. NEVER a disembodied hand floating mid-frame. Hands must enter from a direction consistent with a real adult body standing/kneeling/sitting beside the child.',
    `IMPLIED-PARENT SKIN MUST MATCH the hero's skin tone and undertone (same family).${childAppearance ? ` Hero appearance: ${childAppearance}.` : ''}`,
  );

  if (isParentTheme && !hasParentOnCover) {
    lines.push(
      `THEMED ${parentWord.toUpperCase()} (off-cover): show only as implied presence. Never face, never full body, never substituted by a pet/plush.${parentOutfit ? ` When parts are visible (hand, sleeve, shoulder), they wear: ${parentOutfit}.` : ''}`,
    );
  }

  lines.push(
    'PARENT–CHILD ORIENTATION: any parent in frame (full or partial) reads as engaged with the child — oriented toward them, leaning in, holding hands, sharing a focus. Never back-turned with no narrative reason.',
    'FAMILY WORDS vs COMPANIONS: pets and toys are companions, not family substitutes. "Family" beats need humans (per cast policy above), not a chorus of animals.',
  );

  return lines.join('\n');
}

/**
 * Caption / on-image text rules — the most defect-prone part of the pipeline,
 * so we spell out geometry rather than relying on the cover image alone.
 *
 * @param {typeof TEXT_RULES} textRules
 */
function buildCaptionRules(textRules) {
  const maxWords = textRules.maxWordsPerLine;
  const edge = textRules.edgePaddingPercent;
  const corner = textRules.cornerVerticalPaddingPercent || 21;

  return `### CAPTION (HARD — geometry + fidelity)
The per-spread prompt gives one passage TEXT, a SIDE (left|right), and a CORNER (top-left|top-right|bottom-left|bottom-right). Render the passage exactly once as a single compact stacked block in that CORNER.
Geometry: the block sits about ${edge}% in from the outer (left/right) edge of the chosen SIDE AND about ${corner}% in from the top/bottom edge of the chosen CORNER. NEVER center the caption in its half. The opposite half and the middle spine band are STRICTLY text-free.
Fidelity: render the passage CHARACTER-FOR-CHARACTER identical — same spelling, punctuation, capitalization. NO paraphrase, NO added words, NO duplicate copy, NO "the end", NO signatures, NO page numbers, NO titles. Any word not in the passage is forbidden.
Wrapping: at most ${maxWords} words per line, natural phrase breaks. One stacked block in the chosen corner.
Type: ${textRules.fontStyle}
Size (LOCKED): ${textRules.fontSize} Same modest size on every spread; never poster/title scale.
Cross-spread consistency: ${textRules.typographyConsistency}
Color and light: ${textRules.fontColor}
Blend: ${textRules.textIntegration}
If the prompt's TEXT is empty, render NO text anywhere on the image.`;
}

/**
 * Named-locations block — only emitted when the writer's location palette is
 * present. Mirrors the Gemini systemInstruction logic at a fraction of the
 * tokens so revisited locations stay consistent.
 */
function buildNamedLocationsBlock(locationPalette) {
  if (!locationPalette || !Array.isArray(locationPalette.palette) || locationPalette.palette.length === 0) {
    return '';
  }
  const spreadsByLoc = new Map();
  if (Array.isArray(locationPalette.beatAssignments)) {
    for (const a of locationPalette.beatAssignments) {
      if (!a || !a.location_id || !Number.isFinite(Number(a.spread))) continue;
      const arr = spreadsByLoc.get(a.location_id) || [];
      arr.push(Number(a.spread));
      spreadsByLoc.set(a.location_id, arr);
    }
  }

  const lines = [
    '### NAMED LOCATIONS (continuity across revisits)',
    'When a spread reuses a named location, match the same architecture, materials, props, and palette anchors every time. Camera angle, distance, and focal action follow the per-spread SCENE — not a copy of the earlier still.',
  ];
  for (const entry of locationPalette.palette) {
    const anchors = Array.isArray(entry.visual_anchors) && entry.visual_anchors.length
      ? entry.visual_anchors.join('; ')
      : '(establish on first appearance)';
    const spreads = (spreadsByLoc.get(entry.id) || []).sort((a, b) => a - b);
    const tail = spreads.length > 0 ? ` (spreads ${spreads.join(', ')})` : '';
    lines.push(`• ${entry.name}${tail}: ${anchors}`);
  }
  return lines.join('\n');
}

module.exports = { buildRulesBlock };
