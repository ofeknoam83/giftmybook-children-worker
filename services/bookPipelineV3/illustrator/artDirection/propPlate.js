/**
 * Prop plate (A1) — ONE reference image of the book's recurring props,
 * rendered from the art director's LOCKED designs (continuityLocks.props)
 * with the book pack as style references, then attached to every spread
 * render beside the model sheet and world plate.
 *
 * Why: the 2026-07-18 print audit found the story's pivotal "lamp" drawn
 * as four different objects across one book (crystal → pendant → chest →
 * lantern) and the hero's map changing color and material. Props had no
 * pinned visual ground truth — each spread render re-invented them from
 * prose. Identity flows photo → sheet → every spread; props now flow
 * director design → plate → every spread, the same one-direction pattern.
 */

const { generateImage } = require('../render/imageClient');
const { SPREAD_RENDERER_MODEL } = require('../config');
const { STYLE_BIBLE, STYLE_PIN } = require('../styleBible');
const { qaPlateStyle, PLATE_STYLE_REPAIR } = require('./plateStyleQa');

/** Props appearing on this many spreads (or more) earn a plate slot. */
const PROP_PLATE_MIN_SPREADS = 2;
/** Plate slots are bounded — a crowded plate stops reading as a reference. */
const PROP_PLATE_MAX_PROPS = 4;

/**
 * Pick the plate-worthy props from the art director's continuity locks:
 * recurring (2+ spreads), design-locked first, most-recurring first,
 * capped at PROP_PLATE_MAX_PROPS. Pure — exported for tests.
 *
 * @param {{props?: Array<{name: string, spreads?: number[], design?: string}>}|null} continuityLocks
 * @returns {Array<{name: string, design: string|null, spreads: number[]}>}
 */
function selectPlateProps(continuityLocks) {
  const props = Array.isArray(continuityLocks?.props) ? continuityLocks.props : [];
  return props
    .filter((p) => p && p.name)
    .map((p) => ({
      name: String(p.name),
      design: p.design ? String(p.design) : null,
      spreads: Array.isArray(p.spreads) ? p.spreads.filter(Number.isFinite) : [],
    }))
    .filter((p) => p.spreads.length >= PROP_PLATE_MIN_SPREADS)
    .sort((a, b) => (Boolean(b.design) - Boolean(a.design)) || (b.spreads.length - a.spreads.length))
    .slice(0, PROP_PLATE_MAX_PROPS);
}

function buildPropPlatePrompt(props, { hasStyleReferences = false, repairNote = null } = {}) {
  return [
    `PROP REFERENCE PLATE — the recurring props of a children's picture book, laid out side by side like a museum display on a plain, softly lit neutral background.`,
    'No people, no animals, no characters of any kind, no scene — the props ONLY, each fully visible and separated from the others.',
    // Prompt hygiene (2026-07-28): the bible leads (before the free-text
    // prop designs); the pin closes.
    STYLE_BIBLE,
    `THE PROPS (exactly ${props.length}, nothing else):`,
    ...props.map((p, i) => `[${i + 1}] ${p.name}${p.design ? ` — ${p.design}` : ''}`),
    hasStyleReferences
      ? 'The attached reference images (character model sheet, approved cover) define this book\'s RENDERING STYLE — match their brushwork, color saturation, line weight, and lighting quality EXACTLY. Do NOT copy their subjects: paint the PROPS ONLY.'
      : null,
    repairNote,
    'ABSOLUTELY NO TEXT anywhere in the image. Any map, note, book, or label among the props is WORDLESS — abstract squiggles, dots, or star-glyphs that cannot be read as letters or numbers. NO invented alphabets or alien script. Compasses show a pointed star and arrows, never N/S/E/W letters; clock faces and dials show dots or dashes, never numerals.',
    STYLE_PIN,
  ].filter(Boolean).join('\n');
}

/**
 * Render the book's prop plate. Best-effort like world plates: a missing
 * plate degrades prop continuity, never fails the book.
 *
 * @param {object} opts
 * @param {object|null} opts.continuityLocks - art director's continuityLocks
 * @param {Array} [opts.styleReferences] - book reference pack (sheet + cover)
 * @param {(note: string) => void} [opts.onAdvisory] - receives a note when the
 *   plate is dropped after failing the style-medium QA twice
 * @param {AbortSignal} [opts.abortSignal]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{base64: string, mimeType: string, props: string[]}|null>}
 */
async function renderPropPlate({ continuityLocks, styleReferences = [], onAdvisory = () => {}, abortSignal, log = () => {} }) {
  const props = selectPlateProps(continuityLocks);
  if (props.length === 0) return null;
  try {
    const render = (repairNote) => generateImage({
      model: SPREAD_RENDERER_MODEL,
      prompt: buildPropPlatePrompt(props, { hasStyleReferences: styleReferences.length > 0, repairNote }),
      references: styleReferences,
      // Square regardless of book aspect — the plate anchors object design,
      // not composition.
      aspectRatio: '1:1',
      abortSignal,
      label: 'v3.propplate',
    });
    let img = await render(null);
    // Style-medium QA — same one-check-one-repair-then-drop contract as
    // world plates (see plateStyleQa.js): a 2D prop plate rides every
    // spread's reference pack and seeds a book-wide style break.
    let plate = { base64: img.buffer.toString('base64'), mimeType: img.mimeType };
    let verdict = await qaPlateStyle({ plate, styleReferences, subject: 'props', label: 'v3.propplate.styleqa', abortSignal });
    if (verdict.reason && verdict.ok) log(`prop plate: ${verdict.reason}`);
    if (!verdict.ok) {
      log(`prop plate FAILED the style-medium QA (${verdict.reason}) — one repair render`);
      img = await render(PLATE_STYLE_REPAIR);
      plate = { base64: img.buffer.toString('base64'), mimeType: img.mimeType };
      verdict = await qaPlateStyle({ plate, styleReferences, subject: 'props', label: 'v3.propplate.styleqa', abortSignal });
      if (!verdict.ok) {
        log(`WARNING: prop plate failed the style-medium QA twice (${verdict.reason}) — DROPPED (prop continuity degrades to prompt-only)`);
        onAdvisory(`prop plate dropped after failing the style-medium QA twice: ${verdict.reason}`);
        return null;
      }
    }
    log(`prop plate rendered (${props.map((p) => p.name).join(', ')})`);
    return { ...plate, props: props.map((p) => p.name) };
  } catch (err) {
    log(`prop plate failed (continuing without): ${err.message}`);
    return null;
  }
}

module.exports = { renderPropPlate, buildPropPlatePrompt, selectPlateProps, PROP_PLATE_MIN_SPREADS, PROP_PLATE_MAX_PROPS };
