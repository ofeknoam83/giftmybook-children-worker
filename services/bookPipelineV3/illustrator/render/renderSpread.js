/**
 * Per-spread rendering (A2) — one spread, N independent candidates, all
 * from the same fixed reference pack. No sessions, no chaining, no quad.
 *
 * The prompt is built from the writer's scene contract (the machine-
 * readable writer→illustrator interface) plus the art-direction row when
 * present (shot + text-safe zone + palette; W7). Story text is NEVER
 * rendered into pixels (design D5) — the layout engine typesets it.
 */

const { generateImage } = require('./imageClient');
const { withWorldPlate } = require('./referencePack');
const { SPREAD_RENDERER_MODEL, CANDIDATES_PER_SPREAD } = require('../config');
const { STYLE_BIBLE } = require('../styleBible');

/**
 * 1:1 by design (not a stopgap): the native path lays out books in the
 * proven caption mode — typeset text on the verso page, full-bleed square
 * art on the recto (same geometry as the shipping OpenAI path), which
 * satisfies D5 (no text in pixels) with the existing layout engine. W9's
 * zone typesetting can widen this via env once wide-art overlay ships.
 */
const SPREAD_ASPECT_RATIO = process.env.BOOK_PIPELINE_V3_SPREAD_ASPECT_RATIO || '1:1';

/** Zone grammar → plain-language quiet-zone instruction. */
const ZONE_INSTRUCTIONS = {
  'left-top': 'upper-left quadrant',
  'left-bottom': 'lower-left quadrant',
  'right-top': 'upper-right quadrant',
  'right-bottom': 'lower-right quadrant',
  left: 'left third',
  right: 'right third',
};

/**
 * @param {object} opts
 * @param {object} opts.spread - manuscript spread ({ spread, scene_contract, text })
 * @param {object|null} [opts.direction] - art-direction row ({ shot, textZone, palette, continuityNotes }) — optional until W7
 * @param {string} opts.briefText - likeness brief text
 * @param {string} [opts.wardrobeNote]
 * @returns {string} full render prompt
 */
function buildSpreadRenderPrompt({ spread, direction = null, briefText, wardrobeNote = null }) {
  const sc = spread.scene_contract || {};
  const zone = direction?.textZone && (ZONE_INSTRUCTIONS[direction.textZone] || direction.textZone);

  return [
    `PICTURE-BOOK ILLUSTRATION (spread ${spread.spread} of a children's book) — one full-page scene:`,
    '',
    'SCENE (from the manuscript — depict exactly this):',
    `- Setting: ${sc.setting || 'as implied by the action'}`,
    `- Characters present: ${(sc.characters_present || []).join(', ') || 'the child'}`,
    `- The child is: ${sc.hero_action || 'present in the scene'}`,
    `- Emotion on the child's face/body: ${sc.emotion || 'engaged'}`,
    (sc.key_objects || []).length ? `- Must include: ${sc.key_objects.join(', ')}` : null,
    sc.time_of_day ? `- Time of day: ${sc.time_of_day}` : null,
    sc.continuity_notes ? `- Continuity: ${sc.continuity_notes}` : null,
    '',
    direction ? [
      'ART DIRECTION:',
      direction.shot ? `- Shot: ${direction.shot}` : null,
      direction.palette ? `- Palette/lighting: ${direction.palette}` : null,
      direction.continuityNotes ? `- Continuity locks: ${direction.continuityNotes}` : null,
    ].filter(Boolean).join('\n') : 'COMPOSITION: one clear focal action; the child off-center (left or right third); background supports but never crowds the subject.',
    zone
      ? `QUIET ZONE: keep the ${zone} of the image visually QUIET — soft, low-detail, low-contrast (sky, wall, water). Nothing important there.`
      : 'QUIET ZONE: keep one generous area of soft, low-detail background (sky, wall, or similar) so the composition breathes.',
    '',
    'CHARACTER IDENTITY:',
    briefText,
    wardrobeNote ? `OUTFIT: ${wardrobeNote}` : 'OUTFIT: exactly as on the approved cover reference.',
    '',
    STYLE_BIBLE,
    '',
    'ABSOLUTELY NO TEXT of any kind in the image — no letters, words, numbers, signs with writing, book pages with visible words, or watermarks. The story text is printed separately. Clothing must be letter-free: no name tags, letter badges, real-world logos, or national flags.',
    'The child is the ORIGINAL ILLUSTRATED CHARACTER from the attached MODEL SHEET — match that character design exactly. It is a storybook character, not a reproduction of any real, identifiable person.',
    'Exactly ONE instance of the child in the scene. No duplicated characters. No extra people beyond those listed.',
  ].filter((l) => l !== null).join('\n');
}

/**
 * Render the candidates for one spread, in parallel.
 *
 * @param {object} opts
 * @param {object} opts.spread - manuscript spread
 * @param {object|null} [opts.direction]
 * @param {Array} opts.bookPack - buildBookReferencePack result
 * @param {object|null} [opts.plate] - world plate for this spread's location
 * @param {string} opts.briefText
 * @param {string} [opts.wardrobeNote]
 * @param {number} [opts.count]
 * @param {AbortSignal} [opts.abortSignal]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<Array<{ buffer: Buffer, mimeType: string, model: string, candidateIndex: number }>>}
 *   Failed candidates are dropped (logged); an empty array means all failed.
 */
async function renderSpreadCandidates({
  spread, direction = null, bookPack, plate = null, briefText, wardrobeNote,
  count = CANDIDATES_PER_SPREAD, abortSignal, log = () => {},
}) {
  const prompt = buildSpreadRenderPrompt({ spread, direction, briefText, wardrobeNote });
  const references = withWorldPlate(bookPack, plate);

  const results = await Promise.all(Array.from({ length: count }, (_, i) =>
    generateImage({
      model: SPREAD_RENDERER_MODEL,
      prompt,
      references,
      aspectRatio: SPREAD_ASPECT_RATIO,
      abortSignal,
      label: `v3.spread.${spread.spread}.c${i + 1}`,
    })
      .then((img) => ({ ...img, candidateIndex: i + 1 }))
      .catch((err) => {
        log(`spread ${spread.spread} candidate ${i + 1} failed: ${err.message}`);
        return null;
      })));

  return results.filter(Boolean);
}

module.exports = {
  buildSpreadRenderPrompt,
  renderSpreadCandidates,
  SPREAD_ASPECT_RATIO,
  ZONE_INSTRUCTIONS,
};
