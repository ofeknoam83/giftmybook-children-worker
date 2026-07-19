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
const { withWorldPlate, withPropPlate } = require('./referencePack');
const { SPREAD_RENDERER_MODEL, CANDIDATES_PER_SPREAD } = require('../config');
const { STYLE_BIBLE } = require('../styleBible');
const { formatCastList } = require('../promptFormat');

/**
 * 1:1 by design (not a stopgap): the native path lays out books in the
 * proven caption mode — typeset text on the verso page, full-bleed square
 * art on the recto (same geometry as the shipping OpenAI path), which
 * satisfies D5 (no text in pixels) with the existing layout engine. W9's
 * zone typesetting can widen this via env once wide-art overlay ships.
 */
const SPREAD_ASPECT_RATIO = process.env.BOOK_PIPELINE_V3_SPREAD_ASPECT_RATIO || null;

/**
 * Per-book aspect: 'embedded' text layout renders WIDE (16:9 — the ratio the
 * identity sheet already uses) so one illustration spans both facing pages
 * with the caption typeset over the quiet zone; 'caption' (default) renders
 * square for the verso-caption/recto-art layout. The env override wins.
 *
 * @param {string} [textLayout] - 'caption' | 'embedded'
 * @returns {string} imageConfig.aspectRatio value
 */
function resolveSpreadAspect(textLayout) {
  if (SPREAD_ASPECT_RATIO) return SPREAD_ASPECT_RATIO;
  return textLayout === 'embedded' ? '16:9' : '1:1';
}

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
function buildSpreadRenderPrompt({ spread, direction = null, briefText, wardrobeNote = null, textLayout = 'caption' }) {
  const sc = spread.scene_contract || {};
  const zone = direction?.textZone && (ZONE_INSTRUCTIONS[direction.textZone] || direction.textZone);
  const embedded = textLayout === 'embedded';

  return [
    embedded
      ? `PICTURE-BOOK ILLUSTRATION (spread ${spread.spread} of a children's book) — ONE WIDE scene that will span TWO facing printed pages:`
      : `PICTURE-BOOK ILLUSTRATION (spread ${spread.spread} of a children's book) — one full-page scene:`,
    embedded
      ? 'GUTTER: the printed book folds down the exact vertical center of this image — keep the child, faces, and the focal action clearly OFF the center line (left or right third), and let the background flow naturally across it.'
      : null,
    embedded
      ? 'ONE CONTINUOUS SCENE: the two halves are ONE panorama, never two mirrored panels. Every distinctive landmark (an archway, a rocket, a doorway, a tunnel mouth) appears EXACTLY ONCE in the whole image — never once per half, never as symmetric twins — and no large landmark sits centered on the fold line.'
      : null,
    '',
    'SCENE (from the manuscript — depict exactly this):',
    `- Setting: ${sc.setting || 'as implied by the action'}`,
    `- Characters present ${formatCastList(sc.characters_present)}`,
    // The art director's `moment` is ONE paintable freeze-frame of the
    // action — using it (over the writer's multi-beat sentence) removes
    // the sequence-vs-frame ambiguity the QA judge then grades against.
    `- The child is: ${direction?.moment || sc.hero_action || 'present in the scene'}`,
    direction?.poseHint ? `- Pose: ${direction.poseHint}` : null,
    `- Emotion on the child's face/body: ${sc.emotion || 'engaged'}`,
    (sc.key_objects || []).length ? `- Must include, each CLEARLY VISIBLE and recognizable: ${sc.key_objects.join(', ')}` : null,
    sc.time_of_day ? `- Time of day: ${sc.time_of_day}` : null,
    sc.continuity_notes ? `- Continuity: ${sc.continuity_notes}` : null,
    '',
    direction ? [
      'ART DIRECTION:',
      direction.shot ? `- Shot: ${direction.shot}` : null,
      direction.palette ? `- Palette/lighting (scene only — never re-colors the character's hair/skin/freckles): ${direction.palette}` : null,
      direction.continuityNotes ? `- Continuity locks: ${direction.continuityNotes}` : null,
    ].filter(Boolean).join('\n') : 'COMPOSITION: one clear focal action; the child off-center (left or right third); background supports but never crowds the subject.',
    zone
      ? `QUIET ZONE: keep the ${zone} of the image visually QUIET — soft, low-detail, low-contrast (sky, wall, water). Nothing important there.${embedded ? ' The story text will be PRINTED over this zone, so it must stay genuinely calm and uncluttered.' : ''}`
      : `QUIET ZONE: keep one generous area of soft, low-detail background (sky, wall, or similar) so the composition breathes.${embedded ? ' The story text will be PRINTED over that area.' : ''}`,
    '',
    'CHARACTER IDENTITY:',
    briefText,
    wardrobeNote ? `OUTFIT: ${wardrobeNote}` : 'OUTFIT: exactly as on the approved cover reference.',
    'FACIAL MARKS: only the marks shown on the model sheet (e.g. its freckles, if any) — never add moles, beauty marks, or stray dark spots that are not on the sheet.',
    "AGE & BUILD: exactly the model sheet's age, proportions, and build on every spread — never render the child younger/chubbier or older/slimmer than the sheet.",
    "CANONICAL COLORS: the character's hair color, skin tone, and freckles come from the MODEL SHEET and are IDENTICAL in every scene. Lighting (night, starlight, lantern glow, golden hour) tints the SCENE — it never re-colors the character: brown hair must still read brown (never blonde/golden) under warm light, freckles stay visible, skin keeps its depth. No color streaks or highlights that are not on the sheet.",
    '',
    STYLE_BIBLE,
    '',
    'ABSOLUTELY NO TEXT of any kind in the image — no letters, words, numbers, signs with writing, book pages with visible words, or watermarks. The story text is printed separately. Clothing must be letter-free: no name tags, letter badges, real-world logos, or national flags.',
    'WORDLESS PROPS: if the scene includes any written artifact — a map, note, letter, book, scroll, sign, or label — depict it WITHOUT readable writing. Use abstract wavy squiggle lines, dots, star-glyphs, or symbols that clearly cannot be read as letters or numbers. NO invented alphabets or alien script either — letter-LIKE glyph rows on signs read as "weird writing" in print; signs and shopfronts carry PICTOGRAMS only (a fruit, a star, a wrench). A map shows paths, landmarks, and constellation marks — never place names or words. A compass or compass rose shows a pointed star and arrows for directions — NEVER the letters N/S/E/W. Clock faces and dials show dots or dashes, never numerals. Instrument faces — planispheres, star wheels/charts, dials, calendar wheels — show tick marks, dots, and constellation glyphs ONLY: never letters, numerals, or month names. If the story names map locations, depict them as tiny pictorial symbols (a waterfall drawing, a crescent moon, a mountain icon) — NEVER write their names.',
    'The child is the ORIGINAL ILLUSTRATED CHARACTER from the attached MODEL SHEET — match that character design exactly. It is a storybook character, not a reproduction of any real, identifiable person.',
    'Exactly ONE instance of the child in the scene. No duplicated characters. No extra people beyond those listed.',
    'HANDS: every visible hand has exactly five clearly separated fingers. Prefer simple, natural grips (whole-hand holds, open palms); avoid complex finger-object interlocks and foreshortened finger tangles.',
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
 * @param {object|null} [opts.propPlate] - locked recurring-prop designs plate
 * @param {string} opts.briefText
 * @param {string} [opts.wardrobeNote]
 * @param {number} [opts.count]
 * @param {AbortSignal} [opts.abortSignal]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<Array<{ buffer: Buffer, mimeType: string, model: string, candidateIndex: number }>>}
 *   Failed candidates are dropped (logged); an empty array means all failed.
 */
async function renderSpreadCandidates({
  spread, direction = null, bookPack, plate = null, propPlate = null, briefText, wardrobeNote,
  textLayout = 'caption', count = CANDIDATES_PER_SPREAD, abortSignal, log = () => {},
}) {
  const prompt = buildSpreadRenderPrompt({ spread, direction, briefText, wardrobeNote, textLayout });
  const references = withPropPlate(withWorldPlate(bookPack, plate), propPlate);

  const renderOne = (i) => generateImage({
    model: SPREAD_RENDERER_MODEL,
    prompt,
    references,
    aspectRatio: resolveSpreadAspect(textLayout),
    abortSignal,
    label: `v3.spread.${spread.spread}.c${i + 1}`,
  }).then((img) => ({ ...img, candidateIndex: i + 1 }));

  // One content-level retry per slot: imageClient already retries transport
  // errors, but a "no image in response" empty is terminal there — dropping
  // the slot silently halved spread 2's QA budget (book 5792dc26). A slot is
  // abandoned only after failing twice.
  const results = await Promise.all(Array.from({ length: count }, (_, i) =>
    renderOne(i).catch((err) => {
      log(`spread ${spread.spread} candidate ${i + 1} failed — retrying once (first attempt: ${err.message})`);
      return renderOne(i).catch((retryErr) => {
        log(`spread ${spread.spread} candidate ${i + 1} failed on retry too — dropping the slot: ${retryErr.message}`);
        return null;
      });
    })));

  return results.filter(Boolean);
}

module.exports = {
  buildSpreadRenderPrompt,
  renderSpreadCandidates,
  resolveSpreadAspect,
  SPREAD_ASPECT_RATIO,
  ZONE_INSTRUCTIONS,
};
