/**
 * Deterministic palette-island advisory (book pass, 2026-07-28 audit,
 * book 4c8daf08): one spread rendered as a warm-tan temple interior inside an
 * otherwise cool blue-purple night book — the per-spread judge cannot see
 * cross-book palette, and the contact-sheet reviewer missed it. This check is
 * pure pixel math: a spread whose dominant hue sits far from BOTH neighbors
 * is an "island" and ships as a bookPass qaAdvisory (closed-gate pattern —
 * advisory only, never blocking; a planned arc shift moves neighbors together,
 * an island contradicts both).
 */

const sharp = require('sharp');

// Minimum circular hue distance (degrees) to BOTH neighbors before a spread
// counts as an island. Book 4c8daf08's temple spread sits ~160° from its
// neighbors; adjacent spreads of a planned warm/cool arc shift measure well
// under this (they move together).
const HUE_ISLAND_DEG = 75;
// Hue is meaningless on near-grey pixels — require some saturation on the
// spread AND its neighbors before comparing hues.
const MIN_SATURATION = 0.12;

/**
 * Mean palette stats of one rendered image: circular-mean hue (degrees),
 * mean saturation and luma (0-1). Saturation-weighted hue so a bright prop
 * on a grey field doesn't read as the field's hue.
 *
 * @param {string} base64
 * @returns {Promise<{ hue: number, sat: number, luma: number }|null>} null when undecodable
 */
async function computePaletteStats(base64) {
  try {
    const { data, info } = await sharp(Buffer.from(base64, 'base64'))
      .resize(32, 32, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    let sumSin = 0;
    let sumCos = 0;
    let satSum = 0;
    let lumaSum = 0;
    const n = width * height;
    for (let i = 0; i < n; i += 1) {
      const o = i * channels;
      const r = data[o] / 255;
      const g = data[o + 1] / 255;
      const b = data[o + 2] / 255;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const d = mx - mn;
      let h = 0;
      if (d > 0) {
        if (mx === r) h = ((g - b) / d) % 6;
        else if (mx === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
      }
      const sat = mx === 0 ? 0 : d / mx;
      const rad = (h * Math.PI) / 180;
      sumSin += Math.sin(rad) * sat;
      sumCos += Math.cos(rad) * sat;
      satSum += sat;
      lumaSum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    const hue = ((Math.atan2(sumSin, sumCos) * 180) / Math.PI + 360) % 360;
    return { hue, sat: satSum / n, luma: lumaSum / n };
  } catch (err) {
    return null;
  }
}

/** Circular distance between two hues, in degrees (0-180). */
function hueDistance(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Find palette islands among the ordered spread stats. Pure — exported for
 * tests.
 *
 * @param {Array<{ spread: number, stats: { hue: number, sat: number, luma: number }|null }>} rows
 *   winners in reading order
 * @returns {Array<{ spread: number, note: string }>} advisories
 */
function findPaletteIslands(rows) {
  const advisories = [];
  for (let i = 1; i < rows.length - 1; i += 1) {
    const cur = rows[i];
    const prev = rows[i - 1];
    const next = rows[i + 1];
    if (!cur.stats || !prev.stats || !next.stats) continue;
    if (cur.stats.sat < MIN_SATURATION || prev.stats.sat < MIN_SATURATION || next.stats.sat < MIN_SATURATION) continue;
    const dPrev = hueDistance(cur.stats.hue, prev.stats.hue);
    const dNext = hueDistance(cur.stats.hue, next.stats.hue);
    if (Math.min(dPrev, dNext) >= HUE_ISLAND_DEG) {
      advisories.push({
        spread: cur.spread,
        note: `palette island: dominant hue ${Math.round(cur.stats.hue)}° sits ${Math.round(dPrev)}°/${Math.round(dNext)}° from both neighboring spreads — this spread may read as a different world/palette than the book around it (verify against the palette arc; regen-spread if jarring)`,
      });
    }
  }
  return advisories;
}

module.exports = { computePaletteStats, findPaletteIslands, hueDistance, HUE_ISLAND_DEG, MIN_SATURATION };
