/**
 * World plates (A1) — for locations visited on 2+ spreads, render ONE
 * reference image of the EMPTY location; every revisit attaches the
 * plate, so the bedroom looks like the same bedroom on page 3 and
 * page 11 without chaining spread renders together.
 */

const { generateImage } = require('../render/imageClient');
const { SPREAD_RENDERER_MODEL } = require('../config');
const { STYLE_BIBLE, STYLE_PIN } = require('../styleBible');
const { resolveSpreadAspect } = require('../render/renderSpread');
const { qaPlateStyle, PLATE_STYLE_REPAIR } = require('./plateStyleQa');

function buildPlatePrompt(location, palette, { hasStyleReferences = false, repairNote = null } = {}) {
  return [
    `LOCATION REFERENCE PLATE — the EMPTY setting "${location}" for a children's picture book.`,
    'No people, no animals, no characters of any kind. The location only, fully dressed with its furniture/props/vegetation.',
    // Prompt hygiene (2026-07-28): the bible leads; the pin closes.
    STYLE_BIBLE,
    // Style anchoring (2026-07-18): a plate rendered from prose alone can
    // drift flat/desaturated, and every spread sharing its location is then
    // told to "match this setting's colors and lighting" — one drifted plate
    // became a book-pass style-break needs_review. The attached reference
    // art pins the rendering style; the no-characters rule above still wins.
    hasStyleReferences
      ? 'The attached reference images (character model sheet, approved cover) define this book\'s RENDERING STYLE — match their brushwork, color saturation, line weight, and lighting quality EXACTLY. Do NOT copy their subjects: paint the LOCATION ONLY, with no characters from the references.'
      : null,
    palette ? `Palette/lighting (scene mood only — never changes the render MEDIUM): ${palette}` : null,
    repairNote,
    'ABSOLUTELY NO TEXT anywhere in the image. Any signs, maps, books, or labels in the location are WORDLESS — abstract squiggles or symbols that cannot be read as letters or numbers. NO invented alphabets or alien script — signs carry pictograms only. Compasses show a pointed star and arrows, never N/S/E/W letters; clock faces show dots or dashes, never numerals.',
    STYLE_PIN,
  ].filter(Boolean).join('\n');
}

/**
 * @param {object} opts
 * @param {Array<{location: string, spreads: number[]}>} opts.plates - art director's plate list
 * @param {object|null} [opts.paletteArc]
 * @param {Array} [opts.styleReferences] - book reference pack (sheet + cover):
 *   style ground truth for the plates themselves, so a plate can never seed
 *   a book-wide style drift
 * @param {(note: string) => void} [opts.onAdvisory] - receives a note when a
 *   plate is dropped after failing the style-medium QA twice (the caller
 *   records it as a qaAdvisory so the book ships flagged, never silently)
 * @param {AbortSignal} [opts.abortSignal]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<Map<string, {base64: string, mimeType: string, location: string}>>} keyed by location string
 */
async function renderWorldPlates({ plates, paletteArc = null, textLayout = 'caption', styleReferences = [], onAdvisory = () => {}, abortSignal, log = () => {} }) {
  const byLocation = new Map();
  const results = await Promise.all((plates || []).map(async (p) => {
    try {
      const render = (repairNote) => generateImage({
        model: SPREAD_RENDERER_MODEL,
        prompt: buildPlatePrompt(p.location, paletteArc?.act1 || null, { hasStyleReferences: styleReferences.length > 0, repairNote }),
        references: styleReferences,
        // Plates match the spread aspect so they anchor composition, not
        // just palette (wide books get wide plates).
        aspectRatio: resolveSpreadAspect(textLayout),
        abortSignal,
        label: `v3.plate.${String(p.location).slice(0, 24)}`,
      });
      let img = await render(null);
      // Style-medium QA (book 16758e3c): plates were the only unjudged images
      // in the pipeline, and one drifted 2D plate drags every spread sharing
      // its location. One check, one repair render, then DROP — a missing
      // plate degrades continuity; a 2D plate seeds a book-wide style break.
      let plate = { base64: img.buffer.toString('base64'), mimeType: img.mimeType };
      let verdict = await qaPlateStyle({ plate, styleReferences, subject: 'location', label: `v3.plate.styleqa.${String(p.location).slice(0, 24)}`, abortSignal });
      if (verdict.reason && verdict.ok) log(`world plate "${p.location}": ${verdict.reason}`);
      if (!verdict.ok) {
        log(`world plate "${p.location}" FAILED the style-medium QA (${verdict.reason}) — one repair render`);
        img = await render(PLATE_STYLE_REPAIR);
        plate = { base64: img.buffer.toString('base64'), mimeType: img.mimeType };
        verdict = await qaPlateStyle({ plate, styleReferences, subject: 'location', label: `v3.plate.styleqa.${String(p.location).slice(0, 24)}`, abortSignal });
        if (!verdict.ok) {
          log(`WARNING: world plate "${p.location}" failed the style-medium QA twice (${verdict.reason}) — DROPPED (spreads keep the sheet+cover style refs)`);
          onAdvisory(`world plate "${p.location}" dropped after failing the style-medium QA twice: ${verdict.reason}`);
          return null;
        }
      }
      return { location: p.location, ...plate };
    } catch (err) {
      // A missing plate degrades continuity, not correctness — never fail the book on it.
      log(`world plate for "${p.location}" failed (continuing without): ${err.message}`);
      return null;
    }
  }));
  for (const r of results.filter(Boolean)) byLocation.set(r.location, r);
  return byLocation;
}

module.exports = { renderWorldPlates, buildPlatePrompt };
