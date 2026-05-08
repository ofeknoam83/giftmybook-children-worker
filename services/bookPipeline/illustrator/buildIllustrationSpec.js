/**
 * Illustration spec builder.
 *
 * Converts the new-schema `(doc, spread)` pair into the fields the existing
 * low-level prompt builder (`services/illustrator/prompt.buildSpreadTurn`)
 * already accepts. This is the ONE place where the new pipeline translates
 * planning artifacts into a renderable scene instruction.
 */

const { selectRetryMemory, renderRetryMemoryForPrompt } = require('../retryMemory');
const { defaultTextCorner, resolveSideAndCorner } = require('../../illustrator/config');
const { AGE_BANDS } = require('../constants');

/**
 * Render an age-aware action constraint paragraph for the image model. For
 * the lap-baby (PB_INFANT) band we hard-cap what the hero can physically do:
 * a 7-month-old standing alone on a dock, walking, climbing, or grabbing a
 * runaway blanket is a render failure regardless of what the manuscript text
 * says. We name the supported poses explicitly so the model has a concrete
 * fallback (parent's lap, stroller, high chair, etc.) instead of inventing
 * impossible athletic actions.
 *
 * Returns an empty string for older bands — normal action vocabulary applies.
 *
 * @param {string} ageBand
 * @param {number|string|null} childAge
 * @returns {string}
 */
function renderAgeActionConstraint(ageBand, childAge) {
  if (ageBand !== AGE_BANDS.PB_INFANT) return '';
  const ageDisplay = (childAge !== null && childAge !== undefined && childAge !== '')
    ? `${childAge} years old (lap-baby)`
    : 'a lap-baby (under ~18 months)';
  return [
    `Hero age constraint (CRITICAL — overrides any text that suggests otherwise): the hero is ${ageDisplay}.`,
    '  - The hero CANNOT stand unsupported, walk, run, climb, jump, ride, or chase. The hero CANNOT grab a moving or runaway object. The hero CANNOT lead any adult anywhere.',
    '  - Permitted poses only: lying down, sitting (visibly supported by a parent\'s lap, high-chair tray, stroller, soft cushion, or blanket against a wall), being held in a parent\'s arms, being carried, reaching from a supported position, looking, smiling, touching/patting/holding a small light object, pointing, snuggling.',
    '  - In ANY pose where the hero is even partially upright, a parent\'s body, a stroller, a high chair, a lap, a soft prop, or the parent\'s hands MUST be physically supporting the baby in the frame. No "baby balancing alone on a dock". No "baby running across a meadow".',
    '  - If the focal action implies independent locomotion or athletic action, REINTERPRET it as the closest supported equivalent ("chases the puppy" → "watches the puppy from Mama\'s lap"; "walks to the door" → "reaches toward the door from Mama\'s arms").',
    '  - The hero\'s body proportions must read as an infant: large head relative to body, short limbs, soft features, no toddler-level musculature.',
  ].join('\n');
}

/**
 * Compose a compact SCENE paragraph from visualBible + spreadSpec. The scene
 * string is what the image model reads as the author's shot list. We keep it
 * tight and concrete: focal action first, location second, camera third,
 * continuity + anchors last.
 *
 * @param {object} doc
 * @param {object} spread
 * @returns {string}
 */
function composeScene(doc, spread) {
  const { visualBible, storyBible } = doc;
  const spec = spread.spec;
  const hero = visualBible?.hero || {};
  // Cover-derived caregiver visual lock — populated by
  // detectCoverComposition.js → callCaregiverVision when a caregiver IS on
  // the approved cover. This is the SAME identity the renderer must show on
  // every interior spread and the SAME identity the QA call compares against.
  // Without this block, the renderer extrapolates caregiver appearance from
  // text descriptions and degrades into:
  //   - flat featureless cast-shadow Mama on the wall (instead of her body)
  //   - skin tone two shades darker than her cover render
  //   - a third disembodied arm wrapping the child
  const caregiverLock = visualBible?.caregiverLock || null;
  const caregiverLockBlock = caregiverLock
    ? [
      'Caregiver visual lock (cover-derived — the SAME person rendered on the approved cover):',
      `  - role: ${caregiverLock.role || 'caregiver'}`,
      `  - skin tone (LOCK — read from the caregiver\'s OWN pixels on the cover, not derived from the child): ${caregiverLock.skinTone || '(see cover render)'}`,
      `  - skin family vs. the child on cover: ${caregiverLock.skinFamilyVsChild || 'unclear'} — never drift the caregiver\'s skin darker or lighter than this between spreads`,
      `  - hair: ${caregiverLock.hair || '(see cover render)'}`,
      `  - outfit: ${caregiverLock.outfit || '(see cover render)'}`,
      `  - build: ${caregiverLock.build || '(see cover render)'}`,
      `  - face: ${caregiverLock.face || '(see cover render)'}`,
      '  HARD RULES for this caregiver in every interior spread where she appears:',
      '    - Render her as the SAME person as on the cover — same face family, same skin family, same hair, outfit lineage continuous across spreads.',
      '    - When the manuscript says she is holding, sitting beside, walking with, or otherwise physically with the child, render her ACTUAL VISIBLE BODY in the frame (head + torso + arms attached to the torso).',
      '    - NEVER substitute a flat, featureless cast shadow on a wall, floor, or ceiling for her body. A wall-shadow is NEVER a stand-in for a present caregiver. If she is in the scene, she is rendered, not shadowed.',
      '    - NEVER add disembodied arms or a phantom second pair of arms wrapping the child. The caregiver contributes ONE pair of arms, both attached to her single visible torso in this frame.',
      '    - EXACTLY ONE caregiver in this frame. NEVER render TWO of the same caregiver — no duplicated body, no second torso, no headless extra body wrapping the child while a fully-rendered caregiver also reaches for the child from the other side. ONE head, ONE torso, ONE pair of arms, ONE pair of legs — all attached on a single coherent body.',
      '    - The caregiver\'s skin tone family in this spread must match the cover render exactly — no "darker family member" drift. Compare against the cover, not against the child.',
    ].join('\n')
    : '';
  const priorAnchors = spread.spec?.continuityAnchors?.length
    ? `Continuity anchors to preserve: ${spec.continuityAnchors.join('; ')}.`
    : '';
  const environment = (visualBible?.environmentAnchors || []).slice(0, 3).join('; ');
  // Recurring props: locked physical descriptions for any prop the bible says
  // appears in >1 spread. Filter to props relevant to THIS spread when
  // appearsInSpreads is specified; otherwise pass them all so the renderer
  // keeps every recurring prop visually consistent.
  const allRecurringProps = Array.isArray(visualBible?.recurringProps) ? visualBible.recurringProps : [];
  const spreadNumber = Number(spread.spreadNumber) || 0;
  const relevantRecurringProps = allRecurringProps.filter(p => {
    if (!Array.isArray(p?.appearsInSpreads) || p.appearsInSpreads.length === 0) return true;
    return p.appearsInSpreads.includes(spreadNumber);
  });
  const recurringPropsBlock = relevantRecurringProps.length > 0
    ? `Recurring props in this book (LOCKED — render IDENTICALLY every spread, do not redesign color/pattern/shape): ${relevantRecurringProps.map(p => `"${p.name}" — ${p.description}`).join(' | ')}.`
    : '';
  const journey = storyBible?.visualJourneySpine
    ? `Story journey thread (keep this setting consistent with the arc — do not treat as a random one-off): ${String(storyBible.visualJourneySpine).trim()}`
    : '';
  const motifs = Array.isArray(storyBible?.recurringVisualMotifs) && storyBible.recurringVisualMotifs.length
    ? `Recurring visual motifs to echo when the scene allows (same book, one adventure): ${storyBible.recurringVisualMotifs.join('; ')}.`
    : '';
  const bridge = spec?.sceneBridge
    ? `Scene bridge (how this moment connects to the rest of the book): ${String(spec.sceneBridge).trim()}`
    : '';

  // Off-cover cast rule: anyone declared in the brief who is NOT on the
  // approved cover may be present in the story but may NEVER be drawn as a
  // full face or full body figure. Allowed: partial presence only (hand,
  // arm, shoulder, back-of-head, silhouette, distant unfocused figure,
  // shadow, or a personal object that stands in for them). This rule keeps
  // identity consistent across the book without depending on an unreliable
  // invented likeness.
  const declaredOffCoverCast = (visualBible?.supportingCast || [])
    .filter(c => (c?.description || c?.name || c?.role) && c?.onCover !== true);

  function renderSignatureObjectLock(c) {
    const lock = c?.partialPresenceLock || {};
    const sig = lock.signatureProp;
    return sig
      ? `        Signature object LOCK (use EVERY time this character is implied; render IDENTICAL across spreads): ${sig}.`
      : '';
  }

  const offCoverCastBlock = declaredOffCoverCast.length > 0
    ? [
      'Off-cover cast rule (HARD — no off-cover person ever appears visibly in any form):',
      ...declaredOffCoverCast.flatMap(c => {
        const label = [c.role, c.name ? `(${c.name})` : ''].filter(Boolean).join(' ');
        const ideas = Array.isArray(c.partialPresenceIdeas) && c.partialPresenceIdeas.length > 0
          ? ` Signature-object ideas: ${c.partialPresenceIdeas.join(' / ')}.`
          : '';
        const lockLine = renderSignatureObjectLock(c);
        return [
          `  - ${label || 'supporting character'} is referenced in the story but is NOT on the cover. They NEVER appear visibly in any spread — not as a face, not as a body, not as a hand / arm / finger / shoulder / back-of-head / cropped torso / silhouette / shadow / reflection / distant figure. Their presence is communicated ONLY through (a) the manuscript text, and (b) one or two SIGNATURE OBJECTS placed naturally in the scene (a favorite cup, a knitted scarf, a worn hat, an empty rocking chair, a folded blanket, a coat on a hook).${ideas}`,
          lockLine,
        ].filter(Boolean);
      }),
      '  Any adult face, body, hand, shoulder, silhouette, shadow, or reflection that does not belong to a person on the approved cover is FORBIDDEN.',
      '  The hero is the only person rendered in any frame where only off-cover cast is referenced. Pets and toys named in the SCENE may appear at their true scale, but they are NEVER a stand-in for an off-cover human.',
      '  When the manuscript text describes an off-cover person performing an action ("Mama hums", "Daddy laughs", "Grandma reaches for me"), the IMAGE does NOT depict that action with a visible person. The image stages the HERO experiencing the moment — turning toward an off-frame source, smiling at a doorway, sitting beside the person\'s signature object on a chair-back. The TEXT carries the relationship; the IMAGE shows the child\'s world.',
    ].join('\n')
    : '';

  // Tell the scene composition where the caption will sit so the busy focal
  // action lands AWAY from that corner (without emptying the corner out).
  const spreadIndex = Math.max(0, (Number(spread.spreadNumber) || 1) - 1);
  const childAge = doc?.brief?.child?.age ?? null;
  const manuscript = spread.manuscript;
  const { side: resolvedSide, corner: resolvedCorner } = resolveSideAndCorner(
    spreadIndex,
    manuscript?.side || spec?.textSide,
    undefined,
    childAge,
  );
  const captionSideOpp = resolvedSide === 'left' ? 'right' : 'left';
  const captionVertical = resolvedCorner.startsWith('top') ? 'top' : 'bottom';
  const captionOppVertical = captionVertical === 'top' ? 'bottom' : 'top';
  const captionPlacementLine =
    `Caption placement (single-scene composition): the spread caption will be tucked into the ${resolvedCorner.toUpperCase()} corner of the final image. ` +
    `Treat the ENTIRE 16:9 frame as ONE continuous environment — both halves must be the same place (same ground, sky, light, perspective, atmosphere), never two images stitched together. ` +
    `Place the focal action and main subject toward the ${captionSideOpp} side / ${captionOppVertical} area of the frame, so the ${resolvedCorner} corner naturally shows a less-busy region of the SAME scene (open sky, soft-focus background, shaded path, foliage, water, ground). ` +
    `Do NOT blur, empty, or flatten that corner into a "text panel" — scenery continues softly behind the caption.`;

  const ageActionConstraint = renderAgeActionConstraint(doc?.request?.ageBand, childAge);

  // AA-CW-5a — arc-context line. Tells the illustrator WHERE this spread
  // sits in the book so a peak spread reads as a peak (image-led wonder)
  // and a closing spread reads as a callback to the opening (visual
  // continuity), not as 13 interchangeable vignettes.
  const arcContext = spec?.arcContext || null;
  const arcContextLine = arcContext
    ? `Arc context: act ${arcContext.actNumber} of 3, beat = ${arcContext.beat}, emotional register = ${arcContext.emotionalRegister}.`
      + (arcContext.callbackToSpread ? ` Visual callback to spread ${arcContext.callbackToSpread} — reuse a recognizable element (object, light, prop, gesture) from that earlier spread so the reader feels the through-line.` : '')
      + (arcContext.setsUpSpread ? ` Sets up spread ${arcContext.setsUpSpread} — plant a small visual seed (an object, a direction of travel, a glance) that the later spread will pay off.` : '')
    : '';

  const lines = [
    `Focal action: ${spec.focalAction}.`,
    `Location: ${spec.location}.`,
    `Camera: ${spec.cameraIntent}.`,
    spec.emotionalBeat ? `Emotional beat: ${spec.emotionalBeat}.` : '',
    spec.humorBeat ? `Humor beat: ${spec.humorBeat}.` : '',
    arcContextLine,
    journey,
    motifs,
    bridge,
    hero.physicalDescription ? `Hero ground truth: ${hero.physicalDescription}` : '',
    hero.outfitDescription ? `Hero outfit (locked to cover): ${hero.outfitDescription}` : '',
    ageActionConstraint,
    environment ? `World anchors: ${environment}.` : '',
    recurringPropsBlock,
    priorAnchors,
    offCoverCastBlock,
    caregiverLockBlock,
    captionPlacementLine,
    spec.forbiddenMistakes?.length ? `Avoid: ${spec.forbiddenMistakes.join('; ')}.` : '',
  ].filter(Boolean);

  return lines.join('\n');
}

/**
 * Build the full illustration spec for one spread. Returned shape matches
 * what `services/illustrator/prompt.buildSpreadTurn` accepts, with added
 * metadata for QA routing and retry memory.
 *
 * @param {object} doc
 * @param {object} spread
 * @returns {object}
 */
function buildIllustrationSpec(doc, spread) {
  const spec = spread.spec;
  const manuscript = spread.manuscript;

  const scene = composeScene(doc, spread);
  const retries = selectRetryMemory(doc.retryMemory, 'spreadRender', spread.spreadNumber);
  const retryBlock = renderRetryMemoryForPrompt(retries);

  const spreadIndex = spread.spreadNumber - 1;
  const childAge = doc?.brief?.child?.age ?? null;
  const { side, corner } = resolveSideAndCorner(
    spreadIndex,
    manuscript?.side || spec?.textSide,
    undefined,
    childAge,
  );

  // Identity-anchor passthrough — these are RE-PASTED on every per-spread turn
  // (see prompt.js buildCharacterAnchorBlock) so identity stays pinned even
  // when Gemini drifts onto its own prior outputs late in the chat.
  const visualBible = doc.visualBible || {};
  const hero = visualBible.hero || {};
  const characterDescription = [
    hero.physicalDescription,
    hero.outfitDescription ? `Outfit (locked to cover): ${hero.outfitDescription}` : '',
  ].filter(Boolean).join(' — ') || undefined;

  const additionalCoverCharacters = (visualBible.supportingCast || [])
    .filter(c => c?.onCover === true)
    .map(c => [c.role, c.name ? `(${c.name})` : '', c.description ? `: ${c.description}` : ''].filter(Boolean).join(' '))
    .join('; ') || undefined;
  const hasSecondaryOnCover = !!additionalCoverCharacters;

  // The themed parent (mom/dad) is on the cover when a supportingCast entry
  // marked as the recipient parent has onCover: true. Falls back to the
  // brief-level flag if the visual bible doesn't carry it.
  const coverParentPresent = !!(
    doc.brief?.coverParentPresent
    || (visualBible.supportingCast || []).some(c => c?.onCover === true && c?.isThemedParent === true)
  );

  // Implied-parent descriptor: built once per book at planning time
  // (createVisualBible.js → composeImpliedParentDescriptor) and cached on
  // visualBible.impliedParent. Falls back to a per-call reconstruction from
  // supportingCast lock fields for backwards compatibility with older book
  // documents (e.g. resumed checkpoints written before E.3 landed).
  let impliedParentDescriptor = visualBible.impliedParent?.descriptor || undefined;
  if (!impliedParentDescriptor) {
    const themedParent = (visualBible.supportingCast || []).find(c => c?.isThemedParent === true && c?.onCover !== true);
    if (themedParent) {
      const lock = themedParent.partialPresenceLock || {};
      const parts = [
        lock.skinTone ? `skin: ${lock.skinTone}` : '',
        lock.hand ? `hand: ${lock.hand}` : '',
        lock.sleeve ? `sleeve/outfit: ${lock.sleeve}` : '',
        lock.signatureProp ? `signature: ${lock.signatureProp}` : '',
      ].filter(Boolean);
      if (parts.length > 0) impliedParentDescriptor = parts.join('; ');
    }
  }

  return {
    spreadNumber: spread.spreadNumber,
    spreadIndex,
    scene: retryBlock ? `${scene}\n\n${retryBlock}` : scene,
    text: manuscript?.text || '',
    textSide: side,
    textCorner: corner,
    textLineTarget: spec?.textLineTarget || 3,
    theme: doc.request.theme,
    lineBreakHints: manuscript?.lineBreakHints || [],
    qaTargets: spec?.qaTargets || [],
    forbiddenMistakes: spec?.forbiddenMistakes || [],
    // Identity anchors (passed through to buildSpreadTurn for the per-spread
    // ### CHARACTER ANCHOR re-paste).
    characterDescription,
    coverParentPresent,
    hasSecondaryOnCover,
    additionalCoverCharacters,
    impliedParentDescriptor,
    // Per-beat composition stage direction. Comes from the spread spec
    // (createSpreadSpecs.js — emitted by the LLM for parent themes, with a
    // deterministic fallback per spread number when omitted). Drives
    // buildParentVisibilityReminder in prompt.js. Null for non-parent themes.
    parentVisibility: spec?.parentVisibility || null,
  };
}

module.exports = { buildIllustrationSpec, composeScene };
