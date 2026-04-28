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
  const priorAnchors = spread.spec?.continuityAnchors?.length
    ? `Continuity anchors to preserve: ${spec.continuityAnchors.join('; ')}.`
    : '';
  const environment = (visualBible?.environmentAnchors || []).slice(0, 3).join('; ');
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

  function renderPartialPresenceLock(c) {
    const lock = c?.partialPresenceLock || {};
    const parts = [
      lock.skinTone ? `skin tone: ${lock.skinTone}` : '',
      lock.hand ? `hand/arm: ${lock.hand}` : '',
      lock.sleeve ? `sleeve/outfit fragment: ${lock.sleeve}` : '',
      lock.signatureProp ? `signature: ${lock.signatureProp}` : '',
    ].filter(Boolean);
    return parts.length > 0
      ? `        Partial-presence LOCK (use EVERY time this character is implied; must match across all spreads): ${parts.join('; ')}.`
      : '';
  }

  const offCoverCastBlock = declaredOffCoverCast.length > 0
    ? [
      'Off-cover cast rule (HARD):',
      ...declaredOffCoverCast.flatMap(c => {
        const label = [c.role, c.name ? `(${c.name})` : ''].filter(Boolean).join(' ');
        const ideas = Array.isArray(c.partialPresenceIdeas) && c.partialPresenceIdeas.length > 0
          ? ` Partial-presence ideas: ${c.partialPresenceIdeas.join(' / ')}.`
          : '';
        const lockLine = renderPartialPresenceLock(c);
        return [
          `  - ${label || 'supporting character'} is present in the story but is NOT on the cover. Render only as partial presence: a hand, arm, shoulder, back-of-head, silhouette, or a distant unfocused figure. Never a full face. Never a full body. A personal object (a favorite cup, a knitted scarf, a worn hat) may stand in for them.${ideas}`,
          lockLine,
        ].filter(Boolean);
      }),
      '  Any adult full face or full body figure not on the cover is forbidden.',
      '  Skin tone of every implied family member MUST plausibly match the hero on the cover — no unexplained ethnicity mismatch.',
      '  Parent–child orientation rule (HARD — applies to ANY parent in the frame, full figure OR partial presence):',
      '    - Whenever a mother or father appears (visible body OR implied through a hand/arm/silhouette), they must be visibly engaged with the hero child: oriented toward the child, eyes on the child, sharing the child\'s focus on a shared object, leaning in, holding hands, or walking alongside.',
      '    - The parent\'s back must NEVER be turned to the child with no narrative reason. No walking away from the child, no ignoring the child, no parent looking off into empty space while the child sits behind them.',
      '    - For partial presence: the implied hand or arm must reach TOWARD the child (offering, holding, steadying, pointing at the same thing) — not extending away from the child.',
      '    - Allowed natural exceptions: parent in profile leading the child forward by the hand, both parent and child facing the same shared focus (fireworks, a sunset, a cake), parent kneeling beside the child reaching for something for them. In all these the parent\'s body language still reads as connected to the child.',
      '  Partial-presence anatomy rule (HARD — image must look natural, never uncanny):',
      '    - Any visible limb (hand, arm, shoulder) MUST enter the frame from a clear edge (left, right, top, bottom, or behind a foreground object) and continue plausibly off-screen. Never a hand or limb floating in mid-frame with no path to a body.',
      '    - The off-frame body MUST be physically plausible for the composition: e.g. a parent seated on the swing beside the child, kneeling just out of frame, leaning over the porch railing, sitting across the picnic blanket. The viewer should instantly read where the rest of the body is.',
      '    - Show enough of the limb that it is unambiguously attached to a body — typically wrist + forearm + at least the start of the elbow or sleeve continuing off-frame. A bare floating hand is forbidden.',
      '    - Silhouettes and back-of-head views must sit at a believable depth and scale relative to the hero — not pasted at the wrong distance, not hovering, not duplicated.',
      '    - Never draw extra or duplicated limbs, ghostly second arms, or ambiguous body parts. One implied character contributes one set of limbs in any given spread.',
      '    - If a clean partial presence cannot be staged naturally in this composition, prefer a personal object (the signature item from the lock) instead of a limb.',
    ].join('\n')
    : '';

  // Tell the scene composition where the caption will sit so the busy focal
  // action lands AWAY from that corner (without emptying the corner out).
  const spreadIndex = Math.max(0, (Number(spread.spreadNumber) || 1) - 1);
  const manuscript = spread.manuscript;
  const { side: resolvedSide, corner: resolvedCorner } = resolveSideAndCorner(
    spreadIndex,
    manuscript?.side || spec?.textSide,
    undefined,
  );
  const captionSideOpp = resolvedSide === 'left' ? 'right' : 'left';
  const captionVertical = resolvedCorner.startsWith('top') ? 'top' : 'bottom';
  const captionOppVertical = captionVertical === 'top' ? 'bottom' : 'top';
  const captionPlacementLine =
    `Caption placement (single-scene composition): the spread caption will be tucked into the ${resolvedCorner.toUpperCase()} corner of the final image. ` +
    `Treat the ENTIRE 16:9 frame as ONE continuous environment — both halves must be the same place (same ground, sky, light, perspective, atmosphere), never two images stitched together. ` +
    `Place the focal action and main subject toward the ${captionSideOpp} side / ${captionOppVertical} area of the frame, so the ${resolvedCorner} corner naturally shows a less-busy region of the SAME scene (open sky, soft-focus background, shaded path, foliage, water, ground). ` +
    `Do NOT blur, empty, or flatten that corner into a "text panel" — scenery continues softly behind the caption.`;

  const lines = [
    `Focal action: ${spec.focalAction}.`,
    `Location: ${spec.location}.`,
    `Camera: ${spec.cameraIntent}.`,
    spec.emotionalBeat ? `Emotional beat: ${spec.emotionalBeat}.` : '',
    spec.humorBeat ? `Humor beat: ${spec.humorBeat}.` : '',
    journey,
    motifs,
    bridge,
    hero.physicalDescription ? `Hero ground truth: ${hero.physicalDescription}` : '',
    hero.outfitDescription ? `Hero outfit (locked to cover): ${hero.outfitDescription}` : '',
    environment ? `World anchors: ${environment}.` : '',
    priorAnchors,
    offCoverCastBlock,
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
  const { side, corner } = resolveSideAndCorner(
    spreadIndex,
    manuscript?.side || spec?.textSide,
    undefined,
  );

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
  };
}

module.exports = { buildIllustrationSpec, composeScene };
