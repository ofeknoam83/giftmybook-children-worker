/**
 * World plates (A1) — for locations visited on 2+ spreads, render ONE
 * reference image of the EMPTY location; every revisit attaches the
 * plate, so the bedroom looks like the same bedroom on page 3 and
 * page 11 without chaining spread renders together.
 */

const { generateImage } = require('../render/imageClient');
const { SPREAD_RENDERER_MODEL } = require('../config');
const { STYLE_BIBLE } = require('../styleBible');
const { SPREAD_ASPECT_RATIO } = require('../render/renderSpread');

function buildPlatePrompt(location, palette) {
  return [
    `LOCATION REFERENCE PLATE — the EMPTY setting "${location}" for a children's picture book.`,
    'No people, no animals, no characters of any kind. The location only, fully dressed with its furniture/props/vegetation.',
    palette ? `Palette/lighting: ${palette}` : null,
    STYLE_BIBLE,
    'ABSOLUTELY NO TEXT anywhere in the image. Any signs, maps, books, or labels in the location are WORDLESS — abstract squiggles or symbols that cannot be read as letters or numbers. Compasses show a pointed star and arrows, never N/S/E/W letters; clock faces show dots or dashes, never numerals.',
  ].filter(Boolean).join('\n');
}

/**
 * @param {object} opts
 * @param {Array<{location: string, spreads: number[]}>} opts.plates - art director's plate list
 * @param {object|null} [opts.paletteArc]
 * @param {AbortSignal} [opts.abortSignal]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<Map<string, {base64: string, mimeType: string, location: string}>>} keyed by location string
 */
async function renderWorldPlates({ plates, paletteArc = null, abortSignal, log = () => {} }) {
  const byLocation = new Map();
  const results = await Promise.all((plates || []).map(async (p) => {
    try {
      const img = await generateImage({
        model: SPREAD_RENDERER_MODEL,
        prompt: buildPlatePrompt(p.location, paletteArc?.act1 || null),
        references: [],
        aspectRatio: SPREAD_ASPECT_RATIO,
        abortSignal,
        label: `v3.plate.${String(p.location).slice(0, 24)}`,
      });
      return { location: p.location, base64: img.buffer.toString('base64'), mimeType: img.mimeType };
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
