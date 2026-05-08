/**
 * Illustrator — System Instruction Builder
 *
 * Builds the ONE-TIME system instruction that travels with every turn in the
 * Gemini chat session. All rules that must apply to every spread live here,
 * so per-turn prompts stay concise and only describe what changes (scene + text).
 *
 * Baked-in policies (no callsite toggles):
 *   - Frozen 3D Premium Pixar style
 *   - Plain Georgia-like book serif, one modest readable size tier for the whole book, scene-matched light/color on type (natural blend, not a sticker)
 *   - L/R placement only
 *   - Family-member visibility derived from cover membership
 *   - One hero, one moment, one seamless painting
 */

const { PIXAR_STYLE, TEXT_RULES, TOTAL_SPREADS, PARENT_THEMES, resolvePictureBookTextRules } = require('./config');

/**
 * Shared rule for hidden-face implied presence — prevents disembodied hands/arms.
 * Injected wherever the illustrator may show a parent/adult via partial body only.
 */
const IMPLIED_PRESENCE_ANCHORING_RULE = `ANCHORING RULE (when showing a hand, arm, or shoulder of a hidden-face person):
- The visible limb MUST be believably anchored. Use ONE of these two options:
    (a) the sleeve and arm continue cleanly to the edge of the frame with a natural elbow/shoulder angle, reading as "the body is just offscreen"; OR
    (b) a shoulder, upper arm, or cropped torso is visible in-frame as the anchor (face still hidden — cropped above shoulders, turned away, or behind the child).
- FORBIDDEN: a disembodied hand or forearm floating in mid-image with no sleeve-to-edge AND no torso anchor. A single cuff ending mid-frame is NEVER acceptable.
- FORBIDDEN: a limb entering from a direction inconsistent with a plausible adult standing, kneeling, or sitting beside/behind the child. Hands must match where a real body could be.
- If in doubt, prefer option (b) — a partial shoulder or cropped torso — over a long reaching arm, because it's easier to read.`;

/**
 * Hero child's skin tone is locked to the cover render across every interior.
 * The cover skin patch is the literal color reference — no warm-tan drift, no
 * lighting-driven undertone shift, no two-shade gap.
 * @param {string} [childAppearance]
 * @returns {string}
 */
function heroChildSkinToneLock(childAppearance) {
  const tail = childAppearance
    ? ` The cached child reference for this book reads: ${childAppearance} — if the cover and this reference disagree, the COVER pixels win, but use this short text as a belt-and-suspenders cross-check.`
    : '';
  return `HERO CHILD SKIN TONE LOCK (cover-anchored — HARD LOCK on every interior):
The HERO CHILD's skin tone on the BOOK COVER is the SINGLE ground-truth color reference for the child on every interior spread. Same lightness, same warmth, same undertone, every spread. Do not let lighting, environment, mood, or shadow drift the child's skin into a different family.
- If the cover child reads as fair / very pale (cool or warm), every interior child reads as fair / very pale — NOT medium-tan, NOT olive, NOT sun-kissed, NOT a darker family because the scene happens to be outdoors.
- If the cover child reads as medium, every interior child reads as medium — NOT much darker brown, NOT washed-out fair.
- If the cover child reads as deep brown, every interior child reads as deep brown — NOT lighter, NOT a milky pale.
- Undertones don't drift either: a cool-fair cover child does NOT become warm-tan on a sunny spread; a warm-medium cover child does NOT become cool-pale in indoor light. Lighting may change brightness, NOT skin family.
- Treat the cover child's cheek / hand skin as a literal swatch and re-use that swatch on every interior. A two-shade gap or any undertone shift between cover and interior is a HARD FAIL — the customer reads the cover and the spread side by side and notices instantly.${tail}`;
}

/**
 * Implied parent's visible skin must match the hero child (family-plausible).
 * @param {string} [childAppearance]
 * @returns {string}
 */
function impliedParentSkinToneLock(childAppearance) {
  const tail = childAppearance
    ? ` The child's reference also states: ${childAppearance} — apply the SAME skin tone, lightness, and undertone described there to any visible parent / relative skin in every interior spread.`
    : '';
  return `SKIN TONE LOCK (any parent / relative not on the cover — HARD LOCK):
The themed parent (mother / father / grandparent / etc.) is NOT on the BOOK COVER, so there is no cover-rendered parent identity to inherit a skin tone from. ANY visible parent / relative skin on every interior spread — hands, fingers, wrist, forearm, arm, sleeve cuff, leg, neck, jawline, ear, partial-face glimpse, OR a substantial torso/face fragment — MUST match the HERO CHILD's skin tone on the BOOK COVER EXACTLY. Same lightness, same warmth, same undertone. They are immediate family, same household, same ethnicity. If the cover child reads as fair / very pale → the parent's hand/arm/jaw also reads as fair / very pale (NOT medium-tan, NOT olive, NOT any darker family). If the cover child reads as medium → the parent reads as medium (NOT much darker, NOT much lighter). If the cover child reads as deep brown → the parent reads as deep brown. Use the cover child's skin patch as the LITERAL color reference for any visible parent skin. A two-shade gap or any undertone shift between child and parent is a hard fail — the customer will see it instantly.${tail}`;
}

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
 * @property {number|string|null} [childAge] - Under 3: top-only corners + infant caption margins; 3–8: compact read-aloud tier.
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
    childAge,
    // 'wide' (default — 16:9 single image per spread, caption baked-in,
    // legacy + Gemini path) | 'square' (1:1 single image per spread, NO
    // on-image text — caption rendered as PDF text on the facing page by
    // services/layoutEngine.js; OpenAI gpt-image-2 path).
    aspectFormat = 'wide',
  } = opts;
  const isSquare = aspectFormat === 'square';

  const textRules = resolvePictureBookTextRules(childAge);

  const secondaryOnCover = typeof hasSecondaryOnCover === 'boolean'
    ? hasSecondaryOnCover
    : !!additionalCoverCharacters;
  const isParentTheme = PARENT_THEMES.has(theme);
  const isMother = theme === 'mothers_day';
  const isGrandparents = theme === 'grandparents_day';
  const parentWord = isMother ? 'mother' : (isGrandparents ? 'grandparent' : 'father');
  const parentShort = isMother ? 'mom' : (isGrandparents ? 'grandparent' : 'dad');

  const sections = [];

  sections.push(
isSquare
? `You are the illustrator for a premium ${TOTAL_SPREADS}-spread children's picture book. Each per-spread call is STATELESS, but every call ATTACHES the BOOK COVER as the first reference image and may attach the most recent approved interior spreads as additional references — they are the canonical hero (face, hair, skin tone, outfit) and the canonical 3D CGI Pixar feature-film art style. For each prompt, generate ONE 1:1 square full-bleed illustration that matches those reference images on hero identity and style, while staging the SCENE from the per-spread prompt. The manuscript caption is rendered as PDF text on the FACING PAGE — your image must contain NO text. Every spread must read as the same hero, same outfit, same style as the references.`
: `You are the illustrator for a premium ${TOTAL_SPREADS}-spread children's picture book. You will be given a BOOK COVER image (the ground-truth character + style reference) and then a sequence of ${TOTAL_SPREADS} per-spread prompts. For each prompt, generate ONE 16:9 full-bleed illustration. Every spread must look like it came from the same painting session as the cover — identical art style, identical characters, identical outfits, same quality.`
  );

  sections.push(
`### ART STYLE — MATCH THE BOOK COVER EXACTLY (the cover is the only style ground truth)
Art style is the BOOK COVER's art style — exactly. Every interior spread must visually read as the SAME RENDERING TRADITION as the approved cover image: same surface treatment, same shading, same material logic, same hair-rendering approach, same lighting language, same level of detail.
- If the cover renders as 3D CGI, every interior is 3D CGI.
- If the cover renders as 2D illustration, every interior is 2D illustration.
- If the cover renders as a painted / watercolor / gouache style, every interior reads as that same style.
The cover is the single visual style ground truth for this book. Do not introduce any rendering tradition the cover doesn't show, and do not reject the cover's style in favor of a different one. Style consistency between cover and interiors is the contract — if you're ever torn between "match the cover" and any independent style target, always match the cover.`
  );

  sections.push(
`### CONSISTENCY CONTRACT (HARD FAIL — READ FIRST, RE-READ EVERY TURN)
Identity is the contract of this book. Lighting, camera angle, mood, and weather may change between spreads. **Identity may not.**
- The hero child's face shape, eye color, eye shape, hair color, hair length, hairstyle, skin tone, and skin undertone are IDENTICAL on every spread to the BOOK COVER. No drift, no aging up/down, no hairstyle change between spreads, no skin-tone shift between rooms or lighting.
- The hero's outfit is the same garment system as the cover on every spread. Do NOT swap to a new outfit between spreads. Situational coverage (pajamas, swimwear, towel, snow coat) is allowed ONLY when the per-spread SCENE explicitly names it (e.g. "in the bathtub", "in pajamas", "in a swimsuit"). Otherwise: hold the cover outfit.
- If a parent or recurring secondary character appears on the cover, their face, hair, build, and outfit are IDENTICAL on every spread. Not a remix, not a softer cousin, not a generic stock parent.
- If a parent or recurring secondary character is implied (hand, shoulder, back-of-head, cropped torso), they are the SAME person across every spread they appear in: same skin tone, same sleeve color and fabric, same accessories (rings/watch/necklace), same hair glimpse when shown. Lock these on first appearance and keep them identical thereafter.
- A reader flipping from spread 1 to spread 13 should be unable to tell anyone has changed except for the action of the moment.`
  );

  sections.push(
`### CHARACTER LOCK
The hero child on the cover is the ONLY hero of every spread. Preserve their face, ethnicity, skin tone, eye color, hair color + hairstyle, and body proportions EXACTLY as rendered on the cover.
${childAppearance ? `Short reference (belt-and-suspenders with the cover image): ${childAppearance}.` : ''}
Outfit (visual lock only — no separate text wardrobe list): Copy the hero's clothing **as it appears on the BOOK COVER image** and keep it aligned with **your own prior interior frames in this chat**. Same shirt/dress/pants/shoes family, colors, and silhouette across spreads unless the SCENE explicitly calls for a situational swap (pajamas, swimwear, coat in snow, bath/towel per rules below). Do not invent a new outfit each spread when the cover and recent frames show a consistent look.
**Bathtub / shower:** the usual street outfit does NOT apply while the child is in bath water — see ### BATH, SHOWER, AND SWIMMING below (bubbles/towel; never fully clothed in the tub).
Show the hero EXACTLY ONCE per spread. Never twins, never split mirror views, never montages of the hero doing multiple things.

ONE SINGLE CONNECTED BODY (CRITICAL — anatomy fail if violated):
- The hero is ONE real 3D character, rendered as a single continuous body. Head → neck → shoulders → torso → hips → legs → feet must all be anatomically connected, on ONE vertical line, in ONE pose, at ONE scale, in the same outfit from top to bottom.
- FORBIDDEN: a torso in one position with a second pair of legs / hips / shorts floating next to it; a shirt on the upper body that does NOT connect to the pants/shorts/skirt below; two overlapping versions of the child (e.g. one reaching up on the left, and a disembodied pair of legs standing to the right); a "ghost" of the body offset sideways or vertically; any visible seam where the child's upper body ends and a second lower body begins.
- The outfit is ONE outfit on ONE body: if the upper half shows a white shirt, the lower half must be the matching pants/shorts/dress of the SAME outfit attached to the SAME torso. Do NOT render an upper body in one garment and a disconnected lower body in a different garment nearby.
- Mental check before output: trace the hero's silhouette with your finger. You must be able to go head → neck → chest → waist → hips → thighs → knees → shins → feet in ONE continuous path, without ever crossing empty background or jumping to a second body.

LIMB COUNT (HARD RULE — every spread, every character):
- Each human in the frame has EXACTLY two arms, two hands, two legs, two feet. No third arm reaching from a parent's torso. No third hand on the stroller bar. No extra fingers fused into a sleeve. Before you output, count visible hands per character: it must be ≤ 2 per body. If a parent is holding the child with both arms, those are the parent's two hands — do NOT add a third "helping" hand from the same parent.
- Hands belong to one body each. A hand entering frame must trace back to an arm, a shoulder, and a torso (or a believable off-frame body). Never duplicate the same hand into two positions.

OBJECT INTEGRITY (HARD RULE — prominent man-made objects):
- Strollers, prams, shopping carts, bikes, scooters, wagons, chairs, tables, ladders, swings, cribs, high chairs must read as STRUCTURALLY COHERENT objects. Handles connect to the frame with a real bar. Wheels come in matching pairs. Seats sit on a believable base. No floating handle ending in mid-air, no two seats fused to one wheel, no duplicated frame bars overlapping at wrong angles, no chair with three legs at the front and none at the back.
- Mental check: trace the object's frame edge-to-edge. Every load-bearing part should connect into one continuous structure.`
  );

  sections.push(`### ${heroChildSkinToneLock(childAppearance)}`);

  sections.push(
`### BATH, SHOWER, AND SWIMMING (MODEST — MODEL-SAFE)
When the scene places the hero in a **bathtub**, **shower**, or **swimming pool**:
- NEVER depict the child naked, nude, or with explicit bare chest, bare bottom, or genital detail. Keep everything **PG**, preschool-picture-book modest — same standard as broadcast family animation.
- NEVER submerge the hero in water while still wearing their **usual street outfit** (overalls, jeans, dresses, sneakers, layered day clothes) — that reads absurd and is forbidden. Do not "solve" modesty by drowning the outfit.
- **Bathtub / bubble bath (preferred):** Fill the tub with **thick, opaque soap foam** (bubble bath) piled generously so the scene clearly reads as bath time. Show **face, expression, wet hair, arms to about mid-forearm, maybe hands and toy**; let **foam hide torso, hips, and legs** below the waterline. Bubbles should be **milky and dense**, not a few tiny clear circles. Rubber duck, toy boat, splashes are welcome.
- **Stepping in or out:** A **large towel** wrapped around the torso and tucked — child can wear that beat instead of foam if the moment is about drying off or wrapping up.
- **Public pool / swim lesson:** Simple **modest swimwear** is allowed — e.g. one-piece suit, or swim shirt with trunks — solid kid-friendly colors, not teen/adult fashion styling. Still no explicit bare chest for little kids if avoidable.
- **Shower:** Prefer **steam**, **silhouette**, **frosted glass**, or **towel-wrapped** beats; avoid detailed wet bare skin.
Face, hair, skin tone, and proportions still match the cover reference on every spread — only **coverage for this water beat** changes.`
  );

  // ── Who else can appear ────────────────────────────────────────────────────
  sections.push(buildFamilyPolicySection({
    secondaryOnCover,
    hasParentOnCover,
    isParentTheme,
    isMother,
    isGrandparents,
    parentWord,
    parentShort,
    parentOutfit,
    additionalCoverCharacters,
    childAppearance,
  }));

  sections.push(
`### RECURRING ITEMS & CHARACTERS
If an object, animal, or secondary character appears in one spread, it MUST keep the same design, color palette, and distinguishing features in every later spread it appears in. Treat the first on-screen appearance as the canonical look. A teddy bear that is brown with a red ribbon stays brown with a red ribbon for the whole book. A pet dog keeps the same breed, size, and markings.`
  );

  const namedLocationsSection = buildNamedLocationsSection(locationPalette);
  if (namedLocationsSection) sections.push(namedLocationsSection);

  if (isSquare) {
    sections.push(
`### COMPOSITION (1:1 SQUARE FRAME — SINGLE PAGE)
One hero. One moment. One seamless painting that fills a single square 1:1 frame edge-to-edge. The illustration occupies ONE page of the open book; the manuscript caption is rendered as PDF text on the facing page — NOT on this image.

PRINT REALITY (8.5×8.5″ SQUARE PAGE — READ BEFORE COMPOSING):
- The square frame maps 1:1 onto an 8.5×8.5″ printed page. Treat the entire square as the live area; allow ~5% inward inset for trim/bleed safety on all sides — keep faces, hands, and story-critical action away from the extreme edges.
- There is NO "other side" of the frame. There is NO diptych, NO panorama, NO 16:9 wide composition, NO left-half / right-half split, NO seam down the middle. The square is a single self-contained painting.
- Compose for a square: place the focal action centered or on a rule-of-thirds anchor. The composition must read complete on its own — no element should require an off-frame extension to make sense.
- FORBIDDEN: any vertical seam, gutter line, color shift, lighting jump, perspective change, or "two-different-pictures-glued-together" feel. There is one continuous environment in this square.

NO ON-IMAGE TEXT (HARD):
- Render NO text of any kind on this image. NO manuscript caption, NO title, NO signage, NO chalkboards, NO posters, NO menus, NO product labels, NO street names, NO storefront lettering, NO signature, NO watermark.
- The manuscript caption for this spread will be rendered as crisp PDF text on the facing page by the layout engine. If you bake text onto the illustration, the printed book will show the caption twice.
- If the SCENE description casually mentions a sign, label, or word in the world, render that object WITHOUT readable type — generic shop awning, blank chalkboard, untitled book cover, etc.

SHOT VARIETY (every book):
- The per-spread user prompt includes a SCENE line from the author: treat that SCENE as the composition contract (who is in frame, where the camera stands, what the moment is). Honor it on top of style and character locks.
- When the story revisits the same setting on the next spread, keep the place consistent but not the same composition: follow the SCENE for distance, angle, and focal action. Avoid near-duplicate compositions versus the prior spread unless the SCENE explicitly calls for it.`
    );
  } else {
  sections.push(
`### COMPOSITION
One hero. One moment. One seamless painting — no split panels, no visible seams, no diptychs, no before/after layouts, no comic grids. Full bleed 16:9. The scene should fill the frame with a clear focal point and cinematic depth.

PRINT REALITY (8.5×8.5″ SQUARE BOOK — READ BEFORE COMPOSING):
The final book trim is **8.5×8.5″**. The wide **16:9** illustration is scaled to **full spread width**, then a **centered vertical strip** is cropped from the **top and bottom** of the frame before the image is **split into two bound pages**. Treat roughly the **middle ~two-thirds of the frame height** as the **safe composition band** for faces, hands, props, and story-critical action — keep heroes and eyelines **away** from the extreme top and bottom edges of the 16:9 canvas.

PANORAMA LOCK (CRITICAL — PRINT IS ONE IMAGE CUT IN HALF FOR BINDING):
- This spread is **one** continuous wide photograph / film frame of a **single environment**. The left and right halves show different parts of the **same** place, not two different pictures.
- **FORBIDDEN:** a sharp vertical seam, gutter line, color shift, lighting jump, perspective change, or style change exactly down the middle; backgrounds that "restart" at center; a bench, stall, or person **cut off** at mid-frame as if the other half were a different picture; two different skies or horizons meeting at center.
- **FORBIDDEN — "text-canvas half":** never compose the scene as "busy subject on one side, blurred empty path / empty sky / blank slab on the other side" so the caption has somewhere to sit. That reads as two images glued together. The text-side is still part of the **same environment** — same perspective, same ground, same atmosphere — just a quieter region of that one scene.
- **REQUIRED:** unified lighting, atmosphere, ground plane, and horizon across the **entire** width; scenery continues naturally across the middle; the spine is invisible in the art.
- **COMPOSE FOR THE CAPTION INSIDE THE SCENE:** place the caption over a naturally less-busy region of the SAME environment — open sky, a soft-focus background, shaded wall, a wash of foliage, water, snow, a tablecloth — so the text is legible without emptying out that part of the frame. Details (distant stalls, far-off flowers, background figures, leaves, rooftops, clouds) should keep softly reading under / behind the caption, not be erased.
- If the scene includes a gate, path, or figure near center, **design the composition** so continuity reads as one space (e.g. gate straddles the viewing area naturally, path curves through), not as "left page scene + right page scene".

SHOT VARIETY (every book):
- The per-spread **user prompt** includes a SCENE line from the author: treat that SCENE as the **composition contract** (who is in frame, where the camera stands, what the moment is). Honor it on top of style and character locks.
- When the story revisits the **same** setting on the next spread, keep the **place** consistent but **not** the same photograph: follow the SCENE for distance, angle, and focal action. Avoid near-duplicate compositions versus the prior spread unless the SCENE explicitly calls for it.
- If this **named place** also appeared a few spreads earlier, do not copy that older "still" — the new SCENE should describe a different focal action or viewpoint so the two spreads do not look like the same stock image.

IN-WORLD READABLE TEXT (STRICT):
- The ONLY allowed text on the image is the manuscript caption on the CHOSEN SIDE given in the per-spread prompt — character-for-character identical to that passage.
- **Forbidden:** painted signage, shop names, storefront lettering, chalkboards, posters, menus, product labels, street names, or any other readable words in the scene (they are not in these books' manuscripts and cause OCR / QA failures). Describe places without inviting the model to render type.`
  );
  }

  if (!isSquare) {
    // Caption-on-image policies are only relevant for the wide path. The
    // square path renders the caption as PDF text on the facing page, so
    // the model must NOT receive caption-placement instructions.
    sections.push(buildPictureBookPrintAndCaptionPolicy(textRules));
    sections.push(buildTextSection(textRules));
  }

  sections.push(
`### QUALITY BAR
Anatomically correct hands (five fingers, normal proportions), feet, and faces. No floating limbs, no duplicated body parts, no melted or extra fingers. Eyes aligned, symmetric features, readable expression. Background details must look deliberate, not noisy or broken.

BODY CONTINUITY SELF-CHECK (do this mentally BEFORE outputting):
1. Is the hero's body ONE single connected silhouette from head to feet, with no second overlapping figure? ✓
2. Does the upper-body outfit (shirt/dress top) visibly connect to the lower-body outfit (pants/shorts/skirt) on the SAME torso-to-hips line, in the SAME garment system? ✓
3. Are there any "ghost" or duplicated torsos / extra pairs of legs / stray pairs of shoes rendered next to the hero? (There should be NONE.) ✓
4. If the child is reaching, tip-toeing, or leaning, do their legs and feet stay attached to the same hips that support the torso — not floating beside the body? ✓
If any of those fails, re-pose the child so there is ONE clean body, ONE outfit, ONE set of limbs.`
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
    isGrandparents,
    parentWord,
    parentShort,
    parentOutfit,
    additionalCoverCharacters,
    childAppearance,
  } = ctx;
  const skinLock = impliedParentSkinToneLock(childAppearance);
  const dayLabel = isMother ? "Mother's Day" : (isGrandparents ? "Grandparents' Day" : "Father's Day");

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

OFF-COVER ADULT POLICY (HARD — applies to ANY adult or family member referenced in a per-spread prompt who is NOT on the approved cover):
  - The off-cover adult NEVER appears visibly in any spread of this book — not as a face, not as a full body, not as a hand or arm or finger, not as a shoulder or back-of-head, not as a cropped torso, not as a shadow, not as a silhouette, not as a reflection.
  - The off-cover adult's presence is communicated ONLY through (a) the manuscript text, and (b) signature OBJECTS in the scene that imply them: a still-warm mug on the table, a coat on a hook, an empty rocking chair, a folded blanket, reading glasses on a counter, a pair of slippers, the parent's signature item from the visual bible.
  - NEVER render the off-cover adult themselves in any form. NEVER substitute a pet or plush toy as a stand-in.
  - The composition is the hero alone with their environment, with the implying object placed naturally in the scene.
  - Pets and toys explicitly mentioned in the SCENE may appear at their true scale.`
    );
  }

  if (isParentTheme && hasParentOnCover) {
    lines.push(
`### THEMED PARENT — VISUAL MODEL LOCK (COVER = SAME PERSON EVERY SPREAD)
The ${parentWord} is on the BOOK COVER. Interior frames must reuse the **exact same facial identity** as that cover render — NOT a remix, NOT a softer "cousin who looks similar," NOT a generic stock ${parentWord}.
- Match **face shape, apparent age band, ethnicity / skin tone and undertones, eye color/shape where visible**, **hair length, texture, style, color**, **build**, and **outfit lineage** to the cover on every appearance.
- Expressions, pose, lighting, and camera angle may vary; the underlying **character model stays one continuous person**.
- If the descriptive text (${additionalCoverCharacters ? 'and the SECONDARY CHARACTER line above' : 'above'}) lists concrete traits, stay consistent with BOTH the wording and the cover pixels — the image wins on conflict.

**HARD RULE — NO SHADOW SUBSTITUTION FOR THE ${parentWord.toUpperCase()}'s BODY.** When the manuscript says the ${parentWord} is holding the hero, sitting beside the hero, walking with the hero, or otherwise PHYSICALLY in the scene, render the ${parentWord}'s ACTUAL VISIBLE BODY in the frame — head, torso, and arms attached to that single torso. A flat, featureless cast shadow on a wall, floor, or ceiling is NEVER a substitute for the ${parentWord}'s body. If the ${parentWord} is in the scene, she is rendered in the scene, not represented by a wall-shadow. Cast shadows on walls are ambient lighting only — not stand-ins for an absent body.

**HARD RULE — ONE TORSO, TWO ARMS.** The ${parentWord} contributes EXACTLY one torso and one pair of arms in any single frame. NEVER add a second pair of arms wrapping the hero from another angle. NEVER render a third disembodied arm reaching toward the hero. NEVER show a phantom arm coming from behind the hero with no torso visible to anchor it. If the ${parentWord} is holding the child, ONE pair of arms holds the child — not two.

**HARD RULE — EXACTLY ONE ${parentWord.toUpperCase()} IN ANY FRAME.** Never render TWO of the ${parentWord} in the same spread. NEVER draw a kneeling / bending ${parentWord} body on one side of the child AND a second fully-rendered ${parentWord} on the other side both interacting with the child. NEVER draw a headless ${parentWord} torso wrapping the child while a separate fully-rendered ${parentWord} reaches for the child. ONE head, ONE torso, ONE pair of arms, ONE pair of legs — all attached on a single coherent body, in ONE clear pose. If the scene needs the ${parentWord} close to the child, pick ONE pose (kneeling beside, holding on lap, leaning in) and render ONE body in that pose.

**HARD RULE — ${parentWord.toUpperCase()} SKIN TONE = COVER ${parentWord.toUpperCase()} SKIN TONE.** The ${parentWord}'s skin in every interior spread must read as the SAME skin family as the ${parentWord} on the cover — same lightness, same warmth, same undertone. Compare against the cover ${parentWord}'s skin patch, NOT against the hero child's skin. The hero child and the ${parentWord} may have different skin tones (children take after one parent more than the other) — what matters is that the ${parentWord}'s skin matches her OWN cover render. A two-shade gap or undertone shift between the ${parentWord} on the cover and the ${parentWord} in an interior spread is a hard fail.`
    );
  }

  if (isParentTheme && !hasParentOnCover) {
    const lockedParentSignatureObject = parentOutfit
      || (isMother
        ? 'a folded soft cardigan, a still-warm tea mug, a worn paperback face-down on a side table, a single pair of slippers'
        : (isGrandparents
          ? 'reading glasses on a side table, a knitted shawl folded on a chair, a teacup on a saucer, a worn novel face-down'
          : 'a casual wristwatch on a counter, a folded jacket over a chair-back, a coffee mug, a pair of work boots'));
    lines.push(
`### THEMED ${parentWord.toUpperCase()} POLICY (NOT ON COVER) — TEXT + SIGNATURE OBJECT, NEVER VISIBLY DRAWN
This is a ${dayLabel} book and the ${parentWord} is NOT on the cover. The ${parentWord} is the GIFT RECIPIENT — they are central to the manuscript text — but they NEVER appear visibly in any illustration of this book.

HARD RULES (every spread, no exceptions):
  - The ${parentWord} is NEVER drawn in any form. NOT as a face. NOT as a full body. NOT as a hand, arm, finger, foot, leg, or any limb. NOT as a shoulder, back-of-head, neck, jaw, or cropped torso. NOT as a shadow, silhouette, reflection, or glowing outline. NOT as a stylized symbolic figure. The ${parentWord}'s body is OFF-FRAME, period.
  - The ${parentWord}'s presence is communicated through TWO channels only: (a) the manuscript caption text on the page, and (b) signature OBJECTS staged in the scene that clearly belong to them. Examples for this book: ${lockedParentSignatureObject}. Use the same family of signature objects across the book so the reader recognizes them as the ${parentWord}'s.
  - NEVER substitute a pet, plush toy, or invented relative as a visual stand-in for the ${parentWord}. The hero is the ONLY person in the frame.
  - The hero is shown ALONE with their environment, with one or two of the signature objects placed naturally in the scene (a mug on the table, a cardigan over a chair-back, a hat on a hook in the doorway).
  - When the manuscript says "Mama hums" or "Daddy laughs" or "${parentShort} reaches for me", the IMAGE does NOT depict that action with a visible ${parentWord} — instead the image shows the HERO experiencing the moment (turning toward an off-frame source, smiling at an empty doorway with the ${parentShort}'s mug on the counter, sitting on a blanket on the floor with the ${parentShort}'s cardigan folded beside them). The TEXT carries the relationship; the IMAGE carries the child's world.

WHY: this book has no approved cover render of the ${parentWord}. Inventing one (even a "subtle" hand or shoulder) drifts visually across the 13 spreads and breaks the gift. Anchoring the ${parentWord}'s presence in stable signature OBJECTS keeps every spread consistent and trustworthy.`
    );
  }

  lines.push(
`### FAMILY WORDS vs COMPANIONS
Words like "family", "we", "our", "together" refer to people. A pet or a plush toy is a COMPANION — it is welcome in the scene but it does NOT satisfy a "family" beat. If the manuscript says "my family loves me", render the people the cover + family policy allows (the hero alone, or the hero with their on-cover companions), not a chorus of animals or toys pretending to be family members.`
  );

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Print trim / PDF crop + caption policy (product-level — matches layoutEngine).
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Consolidated print and on-image caption policy for square picture books.
 * Percents stay in sync with `TEXT_RULES` / `resolvePictureBookTextRules`.
 *
 * @param {typeof TEXT_RULES} textRules
 * @returns {string}
 */
function buildPictureBookPrintAndCaptionPolicy(textRules = TEXT_RULES) {
  const edge = textRules.edgePaddingPercent;
  const topPad = textRules.topPaddingPercent ?? textRules.cornerVerticalPaddingPercent;
  const bottomPad = textRules.bottomPaddingPercent ?? textRules.cornerVerticalPaddingPercent;
  const centerBandPct = Math.max(0, Math.round(100 - 2 * textRules.activeSideMaxPercent));

  return `### PRINT & LAYOUT CONSTRAINT (16:9 → SQUARE SPREAD)
The final book is an **8.5×8.5″** picture book. The wide **16:9** illustration is scaled to full spread width, then a **centered vertical strip** is cropped from the **top and bottom** of the frame before the image is split into two pages. Treat roughly the **middle ~two-thirds of the image height** as the safe composition band for faces, hands, props, and story-critical action — keep heroes and eyelines away from the extreme top and bottom edges of the 16:9 frame.

### ON-IMAGE CAPTION (ONLY ALLOWED TEXT)
The **only** readable lettering is the supplied **manuscript passage**. **No** other legible signs, labels, or UI-like type unless the manuscript **explicitly** requires it (otherwise blur or blank props).

### ONE SIDE + ONE CORNER
The entire passage is a **single compact block** on the **assigned side only** (left or right), anchored to the **assigned corner** (top-left, top-right, bottom-left, or bottom-right). It must **not** be vertically centered along the side, **not** span the spine, and **not** repeat on the other half.

### VERTICAL & HORIZONTAL SAFE MARGINS (NON-NEGOTIABLE)
Because of crop and bleed, the caption must sit **well inside** the frame: at least **~${topPad}%** of the frame height inward from the **top** if using a top corner, and at least **~${bottomPad}%** inward from the **bottom** if using a bottom corner (treat that as a **floor** — **bottom-corner** captions must bias **higher**, with clear empty space under the last descender, never hugging the bottom edge). **~${edge}%** inward from the **outer (trim) edge** horizontally; keep the inner edge of the block **far from the spine** — the center **~${centerBandPct}%** of the total width must stay **text-free** (no letters, ascenders, descenders, or punctuation there).

### READABILITY WITHOUT "DEAD HALVES"
The caption sits over a **quiet region of the same continuous scene** (open sky, soft bokeh, shade, water, foliage) — **not** an empty second illustration or a blurred slab. The environment **continues** under the type; **do not** erase the whole background behind the words.

### MULTI-LINE / LONG READ-ALOUD
Use a **modest, book-like serif** (consistent with prior spreads in the session), **compact** line breaks (short lines), and **slightly smaller** type if needed so the full stack **never** approaches the top/bottom crop zone. **One book-wide subtitle scale** — no random jumps to poster or title size.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Text rules — font lock, size, placement, content-fidelity.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {typeof TEXT_RULES} textRules
 */
function buildTextSection(textRules = TEXT_RULES) {
  const maxWords = textRules.maxWordsPerLine;
  const edge = textRules.edgePaddingPercent;
  const topPad = textRules.topPaddingPercent ?? textRules.cornerVerticalPaddingPercent;
  const bottomPad = textRules.bottomPaddingPercent ?? textRules.cornerVerticalPaddingPercent;
  const activeSideMax = textRules.activeSideMaxPercent;

  return `### ON-IMAGE TEXT (CRITICAL)
Each per-spread prompt will give you ONE short passage (TEXT), a CHOSEN SIDE ("left" or "right"), and a CHOSEN CORNER (one of "top-left", "top-right", "bottom-left", "bottom-right"). Render the passage INSIDE the illustration as a single embedded caption anchored to that corner. Follow these rules without deviation:

1. CORNER-ANCHOR RULE (NON-NEGOTIABLE). The caption is one compact stacked block in the CHOSEN CORNER of the frame — NOT centered vertically in its half, NOT floating in the middle of a blurred region, NOT spread across the whole side. It sits near the corner with generous safe padding (see PLACEMENT) so the rest of the frame is free to show the illustration.
2. ONE-SIDE-ONLY RULE. The caption lives fully on the CHOSEN SIDE. The opposite half of the image carries ONLY illustration. Do NOT mirror, duplicate, or split the caption across sides.
3. PLACEMENT (exact geometry — the book is bound through the middle so gutter lettering is unreadable in print):
   • Horizontal: the caption block is snug against the outer trim on its side — about ${edge}% in from the outer edge (never less, never flush to the bleed), and its inner edge stays far from the center spine (well inside the outer ~${activeSideMax}% of the width).
   • Vertical: the caption block is snug against the top or bottom edge of its corner — about ${topPad}% in from the TOP when the corner is top-aligned, or about ${bottomPad}% in from the BOTTOM when it is bottom-aligned (never less — print PDFs have trim and bleed, and the layout step may crop a band off the top and bottom of the image). For **bottom** corners, add **extra** empty space below the last line (descenders must sit clearly above the danger zone — do not minimize bottom margin). Leave comfortable extra space so ascenders, descenders, and the full caption block stay fully inside the safe area. Do NOT drift to the vertical middle of the chosen side. The caption is explicitly a CORNER block, not a side block.
   • The vertical strip around the spine (middle of the spread) is a STRICT NO-TEXT ZONE. No caption line, word fragment, or punctuation may sit in or cross that gutter band.
   • Never center-justify type across the spine. One caption block must never visually bridge from one half into the other.
4. THE CORNER IS NOT A BLANK CANVAS. Do not empty out or heavily blur the corner region just to "make room for text". The scene continues underneath — open sky, soft-focus background, shaded foliage, ground, water, or any other naturally less-busy region of the SAME environment reads through behind the caption. The caption overlays the scene; the scene is never deleted for it.
5. EXACT TEXT — NO HALLUCINATED WORDS. The text you render must be CHARACTER-FOR-CHARACTER identical to the passage in the prompt. Same spelling, same apostrophes, same punctuation, same capitalization. NO paraphrasing, NO substitutions, NO added words, NO dropped words, NO repeated words. Any word on the image that is NOT in the provided passage is forbidden — including signatures, titles, labels, "THE END", dedications, love notes like "I LOVE MAMA", page numbers, book titles, math symbols, measurement notes, or any other invented text.
6. NO DUPLICATE CAPTIONS. Render the caption EXACTLY ONCE in the chosen corner. Never print the same sentence in two places. Never double-print. Never copy the caption to the empty side.
7. FONT (locked for the whole book): ${textRules.fontStyle}
8. CROSS-SPREAD CONSISTENCY: ${textRules.typographyConsistency}
9. SIZE (locked tier — readable, not big): ${textRules.fontSize} Headlines, poster type, and giant storybook display lettering are forbidden. The reader should never wonder “why is this page’s text a different size or font from the last page?”
10. COLOR & LIGHT (match the world, not the point size): ${textRules.fontColor} Contrast for reading is required, but the caption must not look like generic video subtitles glued on top of the art — it should read as **type that lives in the same 3D lighting pass** as the characters and set. Adjust **tint and shadow** for blend, not type scale.
11. NATURAL BLEND (NOT a sticker): ${textRules.textIntegration}
12. WRAPPING: Break long text into short lines — at most ${maxWords} words per line. Use natural phrase breaks (after commas, conjunctions). The whole passage stays as ONE stacked caption block in the chosen corner.
13. NOT A TITLE: The text is restrained in-scene typography, not a poster headline. The illustration is the hero — the letters should feel **painted into the comp** (same render), not a separate graphic design layer.
14. If the prompt says TEXT is empty, generate a full-bleed illustration with NO on-image text anywhere.

### MANDATORY SELF-CHECK BEFORE FINALIZING THE IMAGE
Before you emit the image, mentally scan the full canvas and verify:
  (a) Is text present on ONLY the CHOSEN SIDE? If text appears on the opposite side, delete it.
  (b) Is the caption tucked into the CHOSEN CORNER — near the outer edge AND near the top/bottom edge — and NOT floating in the vertical middle of its half? If it drifted to the middle, move it into the corner. For **bottom** corners, is there clear empty space **below** the last line (descenders not hugging the bottom)?
  (c) Does any text, letter, or punctuation intrude into the middle spine band? If YES, move the whole caption fully into the chosen outer corner.
  (d) Does the caption appear in more than one place? If YES, delete the duplicate.
  (e) Is there ANY word on the image that is not in the provided TEXT passage? If YES, delete it — no exceptions, including affectionate labels, titles, and signatures.
  (f) Do both halves of the frame clearly show the SAME environment (same ground, sky, lighting, perspective, atmosphere) — NOT one "picture" on the subject side and a separate blurred "text canvas" on the other? If the text-side reads as a second image, re-render as one continuous scene.
  (g) Does the caption **look blended into the illustration** — same color grade, plausible light on the letters, soft edge treatment that matches depth and atmosphere — or does it read as a flat sticker / UI bar / sharp box? If it looks pasted on, re-render with type lit and graded like the rest of the Pixar-style frame.
  (h) Is the **font, weight, and apparent size** of the caption consistent with the on-image caption style in the **earlier interior spreads in this same session** (and with rule 7–9 above)? If this spread’s text looks like a different font, bolder, or much larger/smaller, re-render to match the series.
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
  lines.push('');
  lines.push('### SHOT VARIETY (same place ≠ same photograph)');
  lines.push('Continuity means **environment**: same architecture, materials, signature props, and palette anchors — not identical camera distance, angle, or hero placement every time.');
  lines.push('When multiple spreads use the same named place, follow the **per-spread SCENE** for framing and focal action. **Avoid** near-duplicate compositions versus the immediately previous spread unless the SCENE explicitly calls for a matched beat (rare).');
  return lines.join('\n');
}

function buildPictureBookPrintAndCaptionPolicyQuad(textRules = TEXT_RULES) {
  const edge = textRules.edgePaddingPercent;
  const topPad = textRules.topPaddingPercent ?? textRules.cornerVerticalPaddingPercent;
  const bottomPad = textRules.bottomPaddingPercent ?? textRules.cornerVerticalPaddingPercent;
  const centerBandPct = Math.max(0, Math.round(100 - 2 * textRules.activeSideMaxPercent));

  return `### PRINT & LAYOUT CONSTRAINT (4:1 → TWO 2:1 SPREADS)
Production **splits the 4:1 image at the horizontal midpoint** into two buffers. Each buffer is **2:1** (one spread). Vertical trim/crop matches the picture book pipeline — keep faces and story action in the **middle ~two-thirds** of frame **height** in **each** half.

### DUAL-SPREAD GEOMETRY
LEFT buffer = earlier spread. RIGHT buffer = next spread. Never swap order. Never place spread A's caption in spread B's half.

### CAPTIONS (PER HALF)
Each half gets **one** caption in **one** corner, **one** manuscript side — computed **within that half's** 2:1 sub-frame. Spine band at the center **of each half** stays text-free.

### MARGINS
~${edge}% from the outer edge of each half; ~${topPad}% / ~${bottomPad}% vertical inset for corner blocks; inner **~${centerBandPct}%** width band of each half stays text-free.`;
}

/**
 * System instruction for the 4:1 dual-spread illustrator (two consecutive
 * spreads per generated image). Used only when `renderAllSpreadsQuad` runs.
 *
 * @param {Object} opts - same shape as buildSystemInstruction
 * @returns {string}
 */
function buildSystemInstructionQuad(opts) {
  const {
    hasParentOnCover,
    hasSecondaryOnCover,
    additionalCoverCharacters,
    theme,
    parentOutfit,
    childAppearance,
    locationPalette,
    childAge,
  } = opts;

  const textRules = resolvePictureBookTextRules(childAge);

  const secondaryOnCover = typeof hasSecondaryOnCover === 'boolean'
    ? hasSecondaryOnCover
    : !!additionalCoverCharacters;
  const isParentTheme = PARENT_THEMES.has(theme);
  const isMother = theme === 'mothers_day';
  const isGrandparents = theme === 'grandparents_day';
  const parentWord = isMother ? 'mother' : (isGrandparents ? 'grandparent' : 'father');
  const parentShort = isMother ? 'mom' : (isGrandparents ? 'grandparent' : 'dad');

  const sections = [];

  sections.push(
    `You are the illustrator for a premium ${TOTAL_SPREADS}-spread children's picture book. You will be given a BOOK COVER image (ground-truth character + style) and then **paired** user prompts. For each pair, generate **ONE 4:1** ultra-wide full-bleed image containing **TWO consecutive story spreads** side by side: the **LEFT** half is the **earlier** spread (two bound pages as one 2:1 wide scene); the **RIGHT** half is the **next** spread (its own 2:1 wide scene). A lone final spread uses a normal single-spread prompt. Every frame must match the cover — identical 3D Pixar CGI style, characters, outfit family, quality.`,
  );

  sections.push(
    `### ART STYLE (FROZEN — every spread must be 3D CGI, not 2D illustration)
POSITIVE style: ${PIXAR_STYLE.prefix} ${PIXAR_STYLE.suffix}.

NEGATIVE style (FORBIDDEN — hard fail if any of these read on the image): ${PIXAR_STYLE.antiStyle}.

Think: a still frame from a modern Disney-Pixar feature film — NOT a traditional children's-book illustration. The cover is the style ground truth.`,
  );

  sections.push(
    `### CHARACTER LOCK
The hero child on the cover is the ONLY hero of every spread. Preserve their face, ethnicity, skin tone, eye color, hair color + hairstyle, and body proportions EXACTLY as rendered on the cover.
${childAppearance ? `Short reference (belt-and-suspenders with the cover image): ${childAppearance}.` : ''}
Copy the hero's clothing **as on the BOOK COVER** and prior interiors. Same outfit family unless the SCENE explicitly calls for bath/pool/pajamas/layer per system rules.
Show the hero **EXACTLY ONCE per spread half** — each half is one moment. Across the pair the story may advance so the hero appears in both halves with correct continuity.`,
  );

  sections.push(
    `### BATH, SHOWER, AND SWIMMING (MODEST — MODEL-SAFE)
When the scene places the hero in a **bathtub**, **shower**, or **swimming pool**:
- NEVER depict the child naked, nude, or with explicit bare chest, bare bottom, or genital detail. Keep everything **PG**, preschool-picture-book modest.
- NEVER submerge the hero in water while still wearing **usual street outfit**.
- **Bathtub / bubble bath (preferred):** thick opaque soap foam; face, arms; foam hides torso and legs below waterline.
- **Pool:** modest swimwear allowed.
- **Shower:** steam, silhouette, frosted glass, towel-wrapped beats.`,
  );

  sections.push(buildFamilyPolicySection({
    secondaryOnCover,
    hasParentOnCover,
    isParentTheme,
    isMother,
    isGrandparents,
    parentWord,
    parentShort,
    parentOutfit,
    additionalCoverCharacters,
    childAppearance,
  }));

  sections.push(
    `### RECURRING ITEMS & CHARACTERS
If an object, animal, or secondary character appears in one spread, it MUST keep the same design, color palette, and distinguishing features in every later spread it appears in.`,
  );

  const namedLocationsSection = buildNamedLocationsSection(locationPalette);
  if (namedLocationsSection) sections.push(namedLocationsSection);

  sections.push(
    `### COMPOSITION (4:1 DUAL — ONE IMAGE, TWO SPREAD HALVES)
**Layout:** One ultra-wide **4:1** painting. **Left = spread A** (one seamless 2:1 environment). **Right = spread B** (one seamless 2:1 environment). Story time flows **left → right**.
**Continuity:** Prefer one cohesive day, light, and world palette across the full width — adjacent beats, not unrelated locales. **FORBIDDEN:** a harsh seam, exposure jump, or mismatched horizon **at the 4:1 center** as if two unrelated photos were glued. **REQUIRED:** each half reads as a **complete** spread with its own focal action and caption per the prompt.
**Within each half:** left and right **pages** of that spread are **one** continuous place — no vertical seam at the middle of that half.
**In-world text:** ONLY the **two** manuscript captions from the user prompt — one per half, exact wording. No shop signs, labels, or extra type.`,
  );

  sections.push(buildPictureBookPrintAndCaptionPolicyQuad(textRules));
  sections.push(buildTextSection(textRules));

  sections.push(
    `### QUALITY BAR
Anatomically correct hands, feet, faces. No floating limbs. Readable expression.`,
  );

  sections.push(
    `### OUTPUT
Respond with exactly ONE 4:1 image per paired prompt. Do not narrate unless asked for a text-only acknowledgment.`,
  );

  return sections.join('\n\n');
}

module.exports = {
  buildSystemInstruction,
  buildSystemInstructionQuad,
};
