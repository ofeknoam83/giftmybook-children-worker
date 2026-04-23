/**
 * Illustrator — System Instruction Builder
 *
 * Builds the ONE-TIME system instruction that travels with every turn in the
 * Gemini chat session. All rules that must apply to every spread live here,
 * so per-turn prompts stay concise and only describe what changes (scene + text).
 *
 * Baked-in policies (no callsite toggles):
 *   - Frozen 3D Premium Pixar style
 *   - Plain Georgia-like book serif, small subtitle size, L/R placement only
 *   - Family-member visibility derived from cover membership
 *   - One hero, one moment, one seamless painting
 */

const { PIXAR_STYLE, TEXT_RULES, TOTAL_SPREADS, PARENT_THEMES } = require('./config');

/**
 * @typedef {Object} SystemInstructionOpts
 * @property {boolean} hasParentOnCover - Is the themed parent (mother / father) on the cover?
 * @property {boolean} [hasSecondaryOnCover] - Is ANY non-child person on the cover? Default: derived from additionalCoverCharacters.
 * @property {string} [additionalCoverCharacters] - Description of secondaries on the cover (parent, sibling, grandparent, etc.)
 * @property {string} [theme] - Book theme key (e.g. 'mothers_day', 'birthday'). Controls parent-visibility policy.
 * @property {string} [parentOutfit] - Locked outfit for the themed parent when they appear via hidden-face composition.
 * @property {string} [childAppearance] - Cached short description of the child (from faceEngine). Belt-and-suspenders with cover reference.
 * @property {{palette: Array<{id:string,name:string,visual_anchors:string[]}>, beatAssignments: Array<{spread:number, location_id:string}>}} [locationPalette]
 *   Writer-generated palette of named locations. When present, a NAMED LOCATIONS
 *   section is added to the system instruction so each location is rendered
 *   consistently across the spreads that share it.
 */

/**
 * Build the system instruction string. Called once per book.
 *
 * @param {SystemInstructionOpts} opts
 * @returns {string}
 */
function buildSystemInstruction(opts) {
  const {
    hasParentOnCover,
    hasSecondaryOnCover,
    additionalCoverCharacters,
    theme,
    parentOutfit,
    childAppearance,
    locationPalette,
  } = opts;

  const secondaryOnCover = typeof hasSecondaryOnCover === 'boolean'
    ? hasSecondaryOnCover
    : !!additionalCoverCharacters;
  const isParentTheme = PARENT_THEMES.has(theme);
  const isMother = theme === 'mothers_day';
  const parentWord = isMother ? 'mother' : 'father';
  const parentShort = isMother ? 'mom' : 'dad';

  const sections = [];

  sections.push(
`You are the illustrator for a premium ${TOTAL_SPREADS}-spread children's picture book. You will be given a BOOK COVER image (the ground-truth character + style reference) and then a sequence of ${TOTAL_SPREADS} per-spread prompts. For each prompt, generate ONE 16:9 full-bleed illustration. Every spread must look like it came from the same painting session as the cover — identical art style, identical characters, identical outfits, same quality.`
  );

  sections.push(
`### ART STYLE (FROZEN — every spread)
${PIXAR_STYLE.prefix} ${PIXAR_STYLE.suffix}.
Never drift toward 2D flat, watercolor, pencil sketch, gouache, paper cutout, anime cel-shading, storybook ink-and-wash, pixel art, or any other style. If the cover looks 3D Pixar, every spread must look 3D Pixar. No exceptions.`
  );

  sections.push(
`### CHARACTER LOCK
The hero child on the cover is the ONLY hero of every spread. Preserve their face, ethnicity, skin tone, eye color, hair color + hairstyle, and body proportions EXACTLY as rendered on the cover.
${childAppearance ? `Short reference (belt-and-suspenders with the cover image): ${childAppearance}.` : ''}
Outfit: the hero wears the SAME outfit they wear on the cover across every spread, unless the story prompt explicitly calls for a costume swap (pajamas for bedtime, swimwear at a pool, a coat in the snow). When the outfit swaps, keep the palette and silhouette consistent with the cover look.
Show the hero EXACTLY ONCE per spread. Never twins, never split mirror views, never montages of the hero doing multiple things.`
  );

  // ── Who else can appear ────────────────────────────────────────────────────
  sections.push(buildFamilyPolicySection({
    secondaryOnCover,
    hasParentOnCover,
    isParentTheme,
    isMother,
    parentWord,
    parentShort,
    parentOutfit,
    additionalCoverCharacters,
  }));

  sections.push(
`### RECURRING ITEMS & CHARACTERS
If an object, animal, or secondary character appears in one spread, it MUST keep the same design, color palette, and distinguishing features in every later spread it appears in. Treat the first on-screen appearance as the canonical look. A teddy bear that is brown with a red ribbon stays brown with a red ribbon for the whole book. A pet dog keeps the same breed, size, and markings.`
  );

  const namedLocationsSection = buildNamedLocationsSection(locationPalette);
  if (namedLocationsSection) sections.push(namedLocationsSection);

  sections.push(
`### COMPOSITION
One hero. One moment. One seamless painting — no split panels, no visible seams, no diptychs, no before/after layouts, no comic grids. Full bleed 16:9. The scene should fill the frame with a clear focal point and cinematic depth.`
  );

  sections.push(buildTextSection());

  sections.push(
`### QUALITY BAR
Anatomically correct hands (five fingers, normal proportions), feet, and faces. No floating limbs, no duplicated body parts, no melted or extra fingers. Eyes aligned, symmetric features, readable expression. Background details must look deliberate, not noisy or broken.`
  );

  sections.push(
`### OUTPUT
Respond with exactly ONE image per prompt. Do not narrate. Do not output commentary text unless explicitly asked for a text-only acknowledgment.`
  );

  return sections.join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Family / secondary character visibility — the most error-prone rule set, so
// we templatize it instead of inlining a giant ternary chain.
// ─────────────────────────────────────────────────────────────────────────────
function buildFamilyPolicySection(ctx) {
  const {
    secondaryOnCover,
    hasParentOnCover,
    isParentTheme,
    isMother,
    parentWord,
    parentShort,
    parentOutfit,
    additionalCoverCharacters,
  } = ctx;

  const lines = ['### WHO MAY APPEAR ON SPREADS'];

  if (secondaryOnCover) {
    lines.push(
`The cover shows the hero child AND additional people: ${additionalCoverCharacters || 'see cover reference'}. Each of those cover characters keeps their EXACT cover appearance whenever they appear on a spread — same face, hair, skin tone, outfit, build. Treat the cover as their character model.`
    );
    if (hasParentOnCover) {
      lines.push(
`The themed ${parentWord} IS on the cover and falls under this same exact-match lock. ${parentShort.charAt(0).toUpperCase() + parentShort.slice(1)} wears their cover outfit and keeps their cover look on every spread they appear in.`
      );
    } else if (isParentTheme) {
      lines.push(
`IMPORTANT: the additional person on the cover is NOT the ${parentWord} — they are a sibling, grandparent, or friend. Do NOT draw them as the ${parentWord}. Do NOT treat them as the gift recipient.`
      );
    }
  } else {
    lines.push(
`The cover shows ONLY the hero child — no secondary people. Do not invent new full-face humans (siblings, grandparents, friends, classmates, neighbors) on your own.

When a per-spread prompt explicitly references an adult (e.g., "Mommy", "Daddy", a parent, grandparent, or other family member), you MAY show them — but via IMPLIED PRESENCE only:
  • A hand or arm entering frame (holding, lifting, reading to, adjusting a blanket).
  • The back of their head or a shoulder silhouette.
  • A cropped torso from chest-down, face out of frame.
  • An empty chair / coat on a hook / mug on a table that implies them.
NEVER show the referenced adult's face. NEVER render a full-body adult figure. NEVER substitute a pet or plush toy as a stand-in for a referenced human.

The implicit adult must stay CONSISTENT across every spread they appear in: lock their skin tone, visible clothing colors/fabric, and hand/arm details on their first appearance and keep them identical in later spreads. Treat them like any other recurring character — same look every time.

When in doubt, show the hero alone with the environment and any companions (pets, toys).`
    );
  }

  if (isParentTheme && !hasParentOnCover) {
    lines.push(
`### THEMED PARENT POLICY (${parentWord.toUpperCase()} NOT ON COVER)
This is a ${isMother ? "Mother's Day" : "Father's Day"} book and the ${parentWord} is NOT on the cover. When the story refers to "${parentShort}" / "${parentWord}", show them via IMPLIED PRESENCE only:
  • A hand entering frame (reading to the hero, holding a mug, adjusting a blanket).
  • The back of their head or a shoulder silhouette.
  • A cropped torso from chest-down, face out of frame.
  • An empty chair / coat on a hook / mug on a table that implies them.
NEVER show the ${parentWord}'s face. NEVER invent a full-body ${parentWord}. NEVER substitute a pet, plush toy, or inanimate object as a stand-in for the human ${parentWord} — non-human companions stay at their true scale and are NOT a replacement for the human ${parentWord}.`
    );
    if (parentOutfit) {
      lines.push(`When parts of the ${parentWord} are visible (hand, shoulder, back of head), they wear: ${parentOutfit}. This outfit is locked across every spread.`);
    }
  }

  lines.push(
`### FAMILY WORDS vs COMPANIONS
Words like "family", "we", "our", "together" refer to people. A pet or a plush toy is a COMPANION — it is welcome in the scene but it does NOT satisfy a "family" beat. If the manuscript says "my family loves me", render the people the cover + family policy allows (the hero alone, or the hero with their on-cover companions), not a chorus of animals or toys pretending to be family members.`
  );

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Text rules — font lock, size, placement, content-fidelity.
// ─────────────────────────────────────────────────────────────────────────────
function buildTextSection() {
  const maxWords = TEXT_RULES.maxWordsPerLine;
  const edge = TEXT_RULES.edgePaddingPercent;
  const top = TEXT_RULES.topPaddingPercent;
  const bottom = TEXT_RULES.bottomPaddingPercent;
  const activeMax = TEXT_RULES.activeSideMaxPercent;

  return `### ON-IMAGE TEXT (CRITICAL)
Each per-spread prompt will give you ONE short passage (TEXT) AND a CHOSEN SIDE ("left" or "right"). Render the passage INSIDE the illustration as a single embedded caption on that side only. Follow these rules without deviation:

1. ONE-SIDE-ONLY RULE (NON-NEGOTIABLE). Every spread's text lives on EXACTLY ONE side — the CHOSEN SIDE. The opposite half of the image carries ONLY illustration, no text. Do NOT mirror, duplicate, or split the caption across sides.
2. PLACEMENT. The book is bound through the middle; any text in the center gutter gets swallowed by the spine.
   • If CHOSEN SIDE = "left": the entire text block's bounding box is inside the LEFT column, x ∈ [${edge}%, ${activeMax}%]. Nothing crosses x = ${activeMax}%. The RIGHT half (x > 50%) must be completely free of letters, punctuation, drop-shadow, or any typographic element.
   • If CHOSEN SIDE = "right": the entire text block's bounding box is inside the RIGHT column, x ∈ [${100 - activeMax}%, ${100 - edge}%]. Nothing crosses x = ${100 - activeMax}%. The LEFT half (x < 50%) must be completely free of letters, punctuation, drop-shadow, or any typographic element.
   • The CENTER BAND around the midline (approx x ∈ [${activeMax}%, ${100 - activeMax}%]) is a STRICT NO-TEXT ZONE. No letter, no serif, no punctuation, no part of any word may cross or touch this band.
   • Text is never center-justified across the midline. A single text block may NEVER span from one half into the other.
   • Keep ${top}% padding from the top and ${bottom}% padding from the bottom. No text in the extreme corners or the top/bottom crop zones.
3. EXACT TEXT — NO HALLUCINATED WORDS. The text you render must be CHARACTER-FOR-CHARACTER identical to the passage in the prompt. Same spelling, same apostrophes, same punctuation, same capitalization. NO paraphrasing, NO substitutions, NO added words, NO dropped words, NO repeated words. Any word on the image that is NOT in the provided passage is forbidden — including signatures, titles, labels, "THE END", dedications, love notes like "I LOVE MAMA", page numbers, book titles, or any other invented text.
4. NO DUPLICATE CAPTIONS. Render the caption EXACTLY ONCE on the chosen side. Never print the same sentence in two places. Never double-print. Never copy the caption to the empty side.
5. FONT: ${TEXT_RULES.fontStyle}
6. SIZE: ${TEXT_RULES.fontSize}
7. COLOR: ${TEXT_RULES.fontColor}. Never pure black on dark areas, never pure white on bright sky; ensure contrast against the local background with the subtle shadow.
8. WRAPPING: Break long text into short lines — at most ${maxWords} words per line. Use natural phrase breaks (after commas, conjunctions). The whole passage stays as ONE stacked caption block on the chosen side.
9. NOT A TITLE: The text is a subtitle-style caption, not a poster headline. The illustration is the hero — the text should feel like a quiet overlay, not dominate the frame.
10. If the prompt says TEXT is empty, generate a full-bleed illustration with NO on-image text anywhere.

### MANDATORY SELF-CHECK BEFORE FINALIZING THE IMAGE
Before you emit the image, mentally scan the full canvas and verify:
  (a) Is text present on ONLY the CHOSEN SIDE? If text appears on the opposite side, delete it.
  (b) Does any text, letter, or punctuation touch the center band (${activeMax}%–${100 - activeMax}% of width)? If YES, move it fully into the chosen half.
  (c) Does the caption appear in more than one place? If YES, delete the duplicate.
  (d) Is there ANY word on the image that is not in the provided TEXT passage? If YES, delete it — no exceptions, including affectionate labels, titles, and signatures.
If any check fails, re-render before emitting.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Named locations — emitted from the writer's location palette so every spread
// set at the same palette location looks like the same place. Without this
// section the illustrator treats each per-spread prompt as a fresh place.
// ─────────────────────────────────────────────────────────────────────────────
function buildNamedLocationsSection(locationPalette) {
  if (!locationPalette || !Array.isArray(locationPalette.palette) || locationPalette.palette.length === 0) {
    return '';
  }

  const byId = new Map(locationPalette.palette.map(p => [p.id, p]));
  const spreadsByLoc = new Map();
  if (Array.isArray(locationPalette.beatAssignments)) {
    for (const a of locationPalette.beatAssignments) {
      if (!a || !a.location_id || !Number.isFinite(Number(a.spread))) continue;
      const arr = spreadsByLoc.get(a.location_id) || [];
      arr.push(Number(a.spread));
      spreadsByLoc.set(a.location_id, arr);
    }
  }

  const lines = ['### NAMED LOCATIONS (continuity across spreads that share a place)'];
  lines.push(
    'The story unfolds across the named places below. Each place has its own light, architecture, materials, and mood — lock those on first appearance and reuse them exactly every time that place returns. Treat "revisiting the rooftop garden" like revisiting a set in a movie: same layout, same hero props, same sky, same plants. Changes are legitimate ONLY when the per-spread SCENE explicitly calls for them (time of day shift, weather turn, a new wing opens up). Never swap materials or palette at random between spreads set at the same place.'
  );
  lines.push('');
  for (const entry of locationPalette.palette) {
    const name = entry.name;
    const anchors = Array.isArray(entry.visual_anchors) && entry.visual_anchors.length
      ? entry.visual_anchors.join('; ')
      : '(establish on first appearance and reuse every time)';
    const spreads = (spreadsByLoc.get(entry.id) || []).sort((a, b) => a - b);
    const spreadsHint = spreads.length > 0
      ? ` (used on spread${spreads.length === 1 ? '' : 's'} ${spreads.join(', ')})`
      : '';
    lines.push(`• ${name}${spreadsHint}`);
    lines.push(`  Locked visual anchors: ${anchors}`);
  }
  lines.push('');
  lines.push('When a spread prompt says "Setting: <palette name>", render THAT specific place — not a generic version of the category. If the SCENE block in the prompt names the palette place explicitly (e.g., "at the harbor fish market at dawn"), it is mandatory to include it visibly.');
  return lines.join('\n');
}

module.exports = { buildSystemInstruction };
