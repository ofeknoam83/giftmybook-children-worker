/**
 * Illustration spec builder.
 *
 * Converts the new-schema `(doc, spread)` pair into the fields the existing
 * low-level prompt builder (`services/illustrator/prompt.buildSpreadTurn`)
 * already accepts. This is the ONE place where the new pipeline translates
 * planning artifacts into a renderable scene instruction.
 */

const { selectRetryMemory, renderRetryMemoryForPrompt } = require('../retryMemory');

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
  const { visualBible } = doc;
  const spec = spread.spec;
  const hero = visualBible?.hero || {};
  const priorAnchors = spread.spec?.continuityAnchors?.length
    ? `Continuity anchors to preserve: ${spec.continuityAnchors.join('; ')}.`
    : '';
  const environment = (visualBible?.environmentAnchors || []).slice(0, 3).join('; ');

  const lines = [
    `Focal action: ${spec.focalAction}.`,
    `Location: ${spec.location}.`,
    `Camera: ${spec.cameraIntent}.`,
    spec.emotionalBeat ? `Emotional beat: ${spec.emotionalBeat}.` : '',
    spec.humorBeat ? `Humor beat: ${spec.humorBeat}.` : '',
    hero.physicalDescription ? `Hero ground truth: ${hero.physicalDescription}` : '',
    hero.outfitDescription ? `Hero outfit (locked to cover): ${hero.outfitDescription}` : '',
    environment ? `World anchors: ${environment}.` : '',
    priorAnchors,
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

  return {
    spreadNumber: spread.spreadNumber,
    spreadIndex: spread.spreadNumber - 1,
    scene: retryBlock ? `${scene}\n\n${retryBlock}` : scene,
    text: manuscript?.text || '',
    textSide: manuscript?.side || spec?.textSide || 'right',
    textLineTarget: spec?.textLineTarget || 3,
    theme: doc.request.theme,
    lineBreakHints: manuscript?.lineBreakHints || [],
    qaTargets: spec?.qaTargets || [],
    forbiddenMistakes: spec?.forbiddenMistakes || [],
  };
}

module.exports = { buildIllustrationSpec, composeScene };
