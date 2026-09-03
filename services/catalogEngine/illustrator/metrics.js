/**
 * Deterministic illustration metrics (ce-9, plan §5.2) — the NO-LLM half of
 * candidate scoring. Every export is pure or fail-open: a metric that cannot
 * be computed resolves null (never throws to the caller), so a broken
 * embedding backend or a malformed bbox degrades a candidate's score
 * information, never a render.
 *
 *  - Child crop at the vision call's `child_bbox` (`cropBbox`, sharp).
 *  - Garment colour check: dominant colours of the crop's upper/lower/feet
 *    regions (`regionColours`) vs the outfit spec's machine-readable
 *    `colourHex[]` per slot (`outfitColourCheck`, CIE76 ΔE in Lab —
 *    `deltaE`, computed here with no dependency).
 *  - Bbox rules (`bboxRules`): the off-centre rule for wide renders, the
 *    print-safe zone, and shot-size sanity by bbox height — the machine
 *    reading of the numbers the renderer's prompt already pins
 *    (illustrationGenerator buildCharacterPrompt: faces within the middle
 *    85% height; wide renders keep the child out of the centre band).
 *  - Identity embedding (`embedImage` / `identityScore`): child crop ↔
 *    character-sheet crop cosine similarity behind the OPT-IN
 *    `CATALOG_IDENTITY_METRICS=1` switch, with a pluggable backend
 *    (`CATALOG_EMBEDDING_BACKEND`, default `vertex` = Vertex AI
 *    multimodalembedding@001). Thresholds are calibrated on the bench before
 *    any of these numbers gate a spread — this module only measures.
 *  - Set-level outlier test (`outlierSpreads`): spreads whose mean cosine
 *    distance to the others sits z standard deviations above the set mean.
 *
 * Nothing here produces prompt text: inputs from the vision model (bbox
 * numbers) and from the spec (hex strings) are validated against closed
 * shapes and anything malformed is dropped, never coerced.
 */

const sharp = require('sharp');
const { fetchWithTimeout } = require('../../illustrationGenerator');
const { fnv1a } = require('../selection');
const flags = require('../flags');

// ---------------------------------------------------------------------------
// Documented constants
// ---------------------------------------------------------------------------

/**
 * Bbox rules (plan §5.2). Coordinates are normalized 0-1 over the full frame.
 *  - OFF_CENTER_BAND: a `wide` render's child bbox centre-x must fall OUTSIDE
 *    this band (the prompt's "keep the child out of the centre band").
 *  - HALF_LAYOUT_MIN_CENTER_X: under the `half` text layout the child and
 *    all key action live in the RIGHT half (the verso becomes the text
 *    panel), so the centre-x must be at or beyond the midline instead.
 *  - SAFE_ZONE: the print-safe rectangle — x within 4% of each edge, y
 *    within 7.5% (the prompt's "faces within the middle 85% height").
 *  - SHOT_HEIGHT: shot-type sanity by bbox height; overhead/low-angle carry
 *    no height rule (null = not judged).
 */
const BBOX_RULES = Object.freeze({
  OFF_CENTER_BAND: Object.freeze([0.42, 0.58]),
  HALF_LAYOUT_MIN_CENTER_X: 0.5,
  SAFE_ZONE: Object.freeze({ x: Object.freeze([0.04, 0.96]), y: Object.freeze([0.075, 0.925]) }),
  SHOT_HEIGHT: Object.freeze({
    wide: Object.freeze({ max: 0.55 }),
    medium: Object.freeze({ min: 0.35, max: 0.85 }),
    'close-up': Object.freeze({ min: 0.6 }),
  }),
});

/** Closed note vocabulary emitted by bboxRules — safe to surface in advisories. */
const BBOX_NOTES = Object.freeze({
  INVALID: 'bbox_invalid',
  CENTRE_BAND: 'child_in_centre_band',
  NOT_RIGHT_HALF: 'child_not_in_right_half',
  OUTSIDE_SAFE_ZONE: 'child_outside_safe_zone',
  SHOT_SIZE: 'shot_size_mismatch',
});

/** Crop regions as fractions of the crop's height: [top, bottom). */
const DEFAULT_REGIONS = Object.freeze({
  upper: Object.freeze([0.15, 0.5]),
  lower: Object.freeze([0.5, 0.85]),
  feet: Object.freeze([0.85, 1]),
});

/** Outfit slot → crop region the garment lives in. */
const SLOT_REGION = Object.freeze({ top: 'upper', bottom: 'lower', footwear: 'feet' });

/** CIE76 ΔE at or below which a garment colour counts as matching. */
const DEFAULT_DELTA_E_THRESHOLD = 28;
/** Top-N chromatic colours reported per region. */
const REGION_TOP_COLOURS = 3;
/** A pixel whose channel spread (max-min, 0-255) is below this is near-grey. */
const GREY_SPREAD_MAX = 40;
/** Hard cap on colourHex entries read per slot (hostile specs). */
const MAX_HEX_PER_SLOT = 8;

// ── ce-18: the painted text's INK colour ────────────────────────────────
/** ΔE beyond which a painted block's ink is a different colour from the book's. */
const DEFAULT_INK_DELTA_E_THRESHOLD = 26;
/** ΔE beyond which one spread's ink differs from the book's own median ink. */
const INK_SET_DELTA_E_THRESHOLD = 14;
/** Share of the text bbox's most background-deviant pixels treated as glyph candidates. */
const INK_PIXEL_FRACTION = 0.2;
/** A pixel must sit this far (0-255 luminance) from the background median to be glyph. */
const INK_MIN_DEVIATION = 18;
/** Fewer glyph pixels than this is unmeasurable — fail open, never a verdict. */
const INK_MIN_PIXELS = 40;

// ---------------------------------------------------------------------------
// Bbox + crop
// ---------------------------------------------------------------------------

/** @param {*} n @returns {boolean} finite number within [0, 1] */
function unit(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
}

/**
 * Validate a normalized bbox from the vision verdict. Accepts `{x,y,w,h}` or
 * `[x,y,w,h]`; every value must be a finite number in [0,1], width/height
 * strictly positive, and the box must lie inside the frame. Anything else
 * is null — a malformed bbox is dropped, never clamped into a "valid" one.
 * @param {*} bbox
 * @returns {{x:number,y:number,w:number,h:number}|null}
 */
function normalizeBbox(bbox) {
  let x; let y; let w; let h;
  if (Array.isArray(bbox) && bbox.length === 4) [x, y, w, h] = bbox;
  else if (bbox && typeof bbox === 'object') ({ x, y, w, h } = bbox);
  else return null;
  if (![x, y, w, h].every(unit)) return null;
  if (w <= 0 || h <= 0) return null;
  if (x + w > 1 + 1e-9 || y + h > 1 + 1e-9) return null;
  return { x, y, w, h };
}

/**
 * Crop a render at a normalized bbox with padding (a fraction of the frame
 * on every side), clamped to the image, resized so the long edge is `size`
 * px. PNG bytes out. Null on an invalid bbox, unreadable image, or any
 * sharp failure — fail-open by contract.
 * @param {Buffer} buffer
 * @param {{x:number,y:number,w:number,h:number}|number[]} bbox normalized 0-1
 * @param {{pad?:number, size?:number}} [opts]
 * @returns {Promise<Buffer|null>}
 */
async function cropBbox(buffer, bbox, { pad = 0.05, size = 512 } = {}) {
  const box = normalizeBbox(bbox);
  if (!box || !Buffer.isBuffer(buffer)) return null;
  const padFrac = unit(pad) ? pad : 0.05;
  const edge = Number.isInteger(size) && size > 0 ? size : 512;
  try {
    const { width, height } = await sharp(buffer).metadata();
    if (!width || !height) return null;
    const left = Math.max(0, Math.floor((box.x - padFrac) * width));
    const top = Math.max(0, Math.floor((box.y - padFrac) * height));
    const right = Math.min(width, Math.ceil((box.x + box.w + padFrac) * width));
    const bottom = Math.min(height, Math.ceil((box.y + box.h + padFrac) * height));
    const cw = right - left;
    const ch = bottom - top;
    if (cw < 1 || ch < 1) return null;
    return await sharp(buffer)
      .extract({ left, top, width: cw, height: ch })
      .resize({ width: edge, height: edge, fit: 'inside' })
      .png()
      .toBuffer();
  } catch (err) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/** @param {number} n 0-255 @returns {string} two lowercase hex digits */
function hex2(n) {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
}

/** @param {number} r @param {number} g @param {number} b @returns {string} `#rrggbb` */
function rgbToHex(r, g, b) {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

/**
 * Parse a strict `#rrggbb` / `rrggbb` string. Anything else (short form,
 * names, control chars, objects) is null — spec colours are validated, never
 * coerced.
 * @param {*} hex
 * @returns {{r:number,g:number,b:number}|null}
 */
function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** @param {number} c 0-255 sRGB channel @returns {number} linear 0-1 */
function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/**
 * sRGB (D65) → CIE Lab.
 * @param {{r:number,g:number,b:number}} rgb
 * @returns {{L:number,a:number,b:number}}
 */
function rgbToLab({ r, g, b }) {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  // sRGB → XYZ (D65), normalized to the D65 white point.
  const x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const y = (R * 0.2126729 + G * 0.7151522 + B * 0.0721750) / 1.0;
  const z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / 1.08883;
  const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/**
 * CIE76 colour difference between two hex colours. NaN when either is not a
 * strict hex string (callers compare with `<=`, so NaN never passes).
 * @param {string} hexA
 * @param {string} hexB
 * @returns {number}
 */
function deltaE(hexA, hexB) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  if (!a || !b) return NaN;
  const la = rgbToLab(a);
  const lb = rgbToLab(b);
  return Math.sqrt((la.L - lb.L) ** 2 + (la.a - lb.a) ** 2 + (la.b - lb.b) ** 2);
}

/**
 * Smallest ΔE between any spec colour and any region colour. Region entries
 * may be `{hex}` objects or hex strings. Infinity when nothing comparable is
 * on either side.
 * @param {string[]} hexList
 * @param {Array<{hex:string}|string>} regionColours
 * @returns {number}
 */
function nearestDeltaE(hexList, regionColours) {
  if (!Array.isArray(hexList) || !Array.isArray(regionColours)) return Infinity;
  let best = Infinity;
  for (const spec of hexList) {
    for (const entry of regionColours) {
      const hex = typeof entry === 'string' ? entry : entry && entry.hex;
      const d = deltaE(spec, hex);
      if (Number.isFinite(d) && d < best) best = d;
    }
  }
  return best;
}

/** @param {*} range @returns {[number, number]|null} a valid [top, bottom) fraction pair */
function regionRange(range) {
  if (!Array.isArray(range) || range.length !== 2) return null;
  const [a, b] = range;
  if (!unit(a) || !unit(b) || b <= a) return null;
  return [a, b];
}

/**
 * Quantized colour histogram of one horizontal band of a raw RGB image.
 * 4-bit-per-channel buckets; each bucket reports the MEAN colour of its
 * pixels (not the bucket centre) so the reported hex is a real colour of
 * the region. Near-grey pixels (low channel spread) are excluded from the
 * chromatic ranking but count toward the dominant colour.
 * @param {Buffer} data raw pixels
 * @param {{width:number,height:number,channels:number}} info
 * @param {[number, number]} range fraction of height [top, bottom)
 * @returns {{colours: Array<{hex:string,share:number}>, dominant: {hex:string,share:number}|null}}
 */
function bandColours(data, info, range) {
  const { width, height, channels } = info;
  const rowStart = Math.min(height, Math.floor(range[0] * height));
  const rowEnd = Math.min(height, Math.max(rowStart + 1, Math.ceil(range[1] * height)));
  const buckets = new Map(); // key → {count, r, g, b, chromatic}
  let total = 0;
  for (let y = rowStart; y < rowEnd; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      let bucket = buckets.get(key);
      if (!bucket) {
        const spread = Math.max(r, g, b) - Math.min(r, g, b);
        bucket = { count: 0, r: 0, g: 0, b: 0, chromatic: spread >= GREY_SPREAD_MAX };
        buckets.set(key, bucket);
      }
      bucket.count++;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      total++;
    }
  }
  if (total === 0) return { colours: [], dominant: null };
  const entries = [...buckets.entries()]
    .map(([key, v]) => ({ key, chromatic: v.chromatic, count: v.count, hex: rgbToHex(v.r / v.count, v.g / v.count, v.b / v.count) }))
    // Deterministic order: by count desc, then by bucket key so ties never
    // depend on Map insertion (scan) order across image sizes.
    .sort((p, q) => q.count - p.count || p.key - q.key);
  const toEntry = e => ({ hex: e.hex, share: Number((e.count / total).toFixed(4)) });
  const colours = entries.filter(e => e.chromatic).slice(0, REGION_TOP_COLOURS).map(toEntry);
  return { colours, dominant: toEntry(entries[0]) };
}

/**
 * Dominant colours of the crop's upper (torso), lower (legs), and feet
 * bands — the machine-readable side of the garment colour check. Each
 * region lists its top chromatic colours by share (near-grey pixels are
 * ignored there) and `dominant` carries each region's single most common
 * colour, grey included, so a white or black garment still has a number.
 * Null on an unreadable crop.
 * @param {Buffer} cropBuffer
 * @param {{upper?:number[], lower?:number[], feet?:number[]}} [regions] height fractions [top, bottom)
 * @returns {Promise<{upper:Array<{hex:string,share:number}>, lower:Array<{hex:string,share:number}>, feet:Array<{hex:string,share:number}>, dominant:{upper:{hex:string,share:number}|null, lower:{hex:string,share:number}|null, feet:{hex:string,share:number}|null}}|null>}
 */
async function regionColours(cropBuffer, regions = DEFAULT_REGIONS) {
  if (!Buffer.isBuffer(cropBuffer)) return null;
  try {
    const { data, info } = await sharp(cropBuffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    if (!info.width || !info.height || info.channels < 3) return null;
    const out = { upper: [], lower: [], feet: [], dominant: { upper: null, lower: null, feet: null } };
    for (const name of Object.keys(DEFAULT_REGIONS)) {
      const custom = regions && Object.prototype.hasOwnProperty.call(regions, name) ? regionRange(regions[name]) : null;
      const range = custom || DEFAULT_REGIONS[name];
      const band = bandColours(data, info, range);
      out[name] = band.colours;
      out.dominant[name] = band.dominant;
    }
    return out;
  } catch (err) {
    return null;
  }
}

/**
 * The INK colour of a painted text block (ce-18). The text bbox is mostly
 * BACKGROUND — the glyphs are a thin minority — so the read is: extract the
 * bbox at native resolution (never downscaled: interpolation drags thin
 * strokes toward the background and biases the colour), take the pixels
 * furthest in luminance from the region's median (the background proxy),
 * split them by which side of the median they fall on, and keep the LARGER
 * group. That group is the glyph FILL, because the pale hairline the spec
 * allows is by definition thinner than the stroke it hugs — which is also
 * what makes the read report the painted POLARITY rather than assume one.
 *
 * Deterministic; fail-open (null) on an unreadable image, an invalid bbox,
 * or too few glyph pixels to average. Pure pixels — nothing here reaches a
 * prompt except through the caller's fixed defect strings.
 *
 * @param {Buffer} buffer the render's bytes
 * @param {{x:number,y:number,w:number,h:number}|number[]} bbox the judged text bbox (fractions)
 * @param {{targetHex?: string, threshold?: number}} [opts] the book's pinned ink + ΔE tolerance
 * @returns {Promise<{hex:string, deltaE:number|null, polarity:'dark'|'light', pass:boolean|null, pixels:number}|null>}
 */
async function textInkColour(buffer, bbox, opts = {}) {
  const box = normalizeBbox(bbox);
  if (!Buffer.isBuffer(buffer) || !box) return null;
  try {
    const meta = await sharp(buffer).metadata();
    const W = meta.width || 0;
    const H = meta.height || 0;
    if (W < 8 || H < 8) return null;
    const left = Math.min(Math.max(0, Math.round(box.x * W)), W - 1);
    const top = Math.min(Math.max(0, Math.round(box.y * H)), H - 1);
    const width = Math.max(1, Math.min(Math.round(box.w * W), W - left));
    const height = Math.max(1, Math.min(Math.round(box.h * H), H - top));
    const { data, info } = await sharp(buffer)
      .extract({ left, top, width, height })
      .removeAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.channels < 3) return null;
    const n = info.width * info.height;
    if (n < INK_MIN_PIXELS) return null;
    const lum = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const p = i * info.channels;
      lum[i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
    }
    const median = [...lum].sort((a, b) => a - b)[Math.floor(n / 2)];
    // Candidate glyph pixels: the most deviant INK_PIXEL_FRACTION, each at
    // least INK_MIN_DEVIATION from the background — a flat crop yields none.
    const idx = Array.from({ length: n }, (_, i) => i)
      .filter(i => Math.abs(lum[i] - median) >= INK_MIN_DEVIATION)
      .sort((a, b) => Math.abs(lum[b] - median) - Math.abs(lum[a] - median))
      .slice(0, Math.max(INK_MIN_PIXELS, Math.round(n * INK_PIXEL_FRACTION)));
    const darker = idx.filter(i => lum[i] < median);
    const lighter = idx.filter(i => lum[i] >= median);
    const fill = darker.length >= lighter.length ? darker : lighter;
    if (fill.length < INK_MIN_PIXELS) return null;
    let r = 0;
    let g = 0;
    let b = 0;
    for (const i of fill) {
      const p = i * info.channels;
      r += data[p];
      g += data[p + 1];
      b += data[p + 2];
    }
    const hex = rgbToHex(r / fill.length, g / fill.length, b / fill.length);
    const target = typeof opts.targetHex === 'string' ? opts.targetHex : null;
    const limit = Number.isFinite(opts.threshold) && opts.threshold >= 0 ? opts.threshold : DEFAULT_INK_DELTA_E_THRESHOLD;
    const d = target ? deltaE(hex, target) : NaN;
    return {
      hex,
      deltaE: Number.isFinite(d) ? Number(d.toFixed(2)) : null,
      polarity: fill === darker ? 'dark' : 'light',
      pass: Number.isFinite(d) ? d <= limit : null,
      pixels: fill.length,
    };
  } catch (err) {
    return null;
  }
}

/**
 * Spreads whose measured ink differs from the BOOK'S OWN median ink (ce-18).
 * The per-spread check holds every render to the pinned hex, but its
 * tolerance must absorb scene bleed on thin glyphs — two spreads can sit
 * inside it in opposite directions and still look different from each
 * other. The reference is the entry closest to the component-wise median
 * Lab (a real measured colour, so the existing hex-based ΔE applies), and
 * anything beyond `threshold` from it is flagged. Pure — exported for tests.
 *
 * @param {Array<{spread:number, hex:string}>} entries measured inks (any order)
 * @param {{threshold?: number}} [opts]
 * @returns {{referenceHex: string|null, flagged: Array<{spread:number, hex:string, deltaE:number}>}}
 */
function inkSetOutliers(entries, opts = {}) {
  const limit = Number.isFinite(opts.threshold) && opts.threshold >= 0 ? opts.threshold : INK_SET_DELTA_E_THRESHOLD;
  const list = (Array.isArray(entries) ? entries : [])
    .filter(e => e && Number.isInteger(e.spread) && hexToRgb(e.hex))
    .map(e => ({ spread: e.spread, hex: e.hex, lab: rgbToLab(hexToRgb(e.hex)) }));
  if (list.length < 2) return { referenceHex: null, flagged: [] };
  const mid = (key) => {
    const v = list.map(e => e.lab[key]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  const target = { L: mid('L'), a: mid('a'), b: mid('b') };
  const ref = list.reduce((best, e) => {
    const d = (e.lab.L - target.L) ** 2 + (e.lab.a - target.a) ** 2 + (e.lab.b - target.b) ** 2;
    return !best || d < best.d ? { e, d } : best;
  }, null).e;
  const flagged = list
    .map(e => ({ spread: e.spread, hex: e.hex, deltaE: Number(deltaE(e.hex, ref.hex).toFixed(2)) }))
    .filter(e => Number.isFinite(e.deltaE) && e.deltaE > limit)
    .sort((a, b) => a.spread - b.spread);
  return { referenceHex: ref.hex, flagged };
}

/**
 * Read a slot's `colourHex[]` from a spec, keeping only strict hex strings
 * (own-property checks — a `__proto__`-keyed spec is hostile input, never a
 * prototype read), capped in count.
 * @param {object} spec
 * @param {string} slot
 * @returns {string[]}
 */
function slotHexes(spec, slot) {
  if (!spec || typeof spec !== 'object' || !Object.prototype.hasOwnProperty.call(spec, slot)) return [];
  const entry = spec[slot];
  if (!entry || typeof entry !== 'object' || !Object.prototype.hasOwnProperty.call(entry, 'colourHex')) return [];
  const list = entry.colourHex;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const v of list) {
    const rgb = hexToRgb(v);
    if (rgb) out.push(rgbToHex(rgb.r, rgb.g, rgb.b));
    if (out.length >= MAX_HEX_PER_SLOT) break;
  }
  return out;
}

/**
 * Garment colour check: per outfit slot, the nearest ΔE between the spec's
 * `colourHex[]` and the matching crop region's colours (top chromatic
 * colours + the region's dominant colour). A slot with no usable hex or a
 * region with no colours is SKIPPED, not failed — the check only judges what
 * both sides can state. `pass` is true when every checked slot passes
 * (vacuously true when nothing was checkable; see `checked`).
 * @param {object|null} colours result of regionColours
 * @param {{top?:{colourHex?:string[]}, bottom?:{colourHex?:string[]}, footwear?:{colourHex?:string[]}}} outfitSpec
 * @param {{threshold?:number}} [opts]
 * @returns {{slots: Object<string, {deltaE:number, pass:boolean}>, pass:boolean, checked:string[]}}
 */
function outfitColourCheck(colours, outfitSpec, { threshold = DEFAULT_DELTA_E_THRESHOLD } = {}) {
  const limit = typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 0 ? threshold : DEFAULT_DELTA_E_THRESHOLD;
  const result = { slots: {}, pass: true, checked: [] };
  if (!colours || typeof colours !== 'object') return result;
  for (const slot of Object.keys(SLOT_REGION)) {
    const hexes = slotHexes(outfitSpec, slot);
    if (hexes.length === 0) continue;
    const region = SLOT_REGION[slot];
    const found = Array.isArray(colours[region]) ? colours[region].slice() : [];
    const dominant = colours.dominant && colours.dominant[region];
    if (dominant && dominant.hex) found.push(dominant);
    if (found.length === 0) continue;
    const d = nearestDeltaE(hexes, found);
    if (!Number.isFinite(d)) continue;
    const pass = d <= limit;
    result.slots[slot] = { deltaE: Number(d.toFixed(2)), pass };
    result.checked.push(slot);
    if (!pass) result.pass = false;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Bbox rules
// ---------------------------------------------------------------------------

/**
 * Composition sanity from the child bbox alone (plan §5.2):
 *  - offCenterOk — `wide` aspect only (null for square): the bbox centre-x
 *    is outside BBOX_RULES.OFF_CENTER_BAND, or, under the `half` text
 *    layout, at/beyond HALF_LAYOUT_MIN_CENTER_X (the child lives in the
 *    right half).
 *  - safeZoneOk — the bbox lies within BBOX_RULES.SAFE_ZONE.
 *  - shotSizeOk — bbox height vs BBOX_RULES.SHOT_HEIGHT for wide/medium/
 *    close-up; null for overhead/low-angle/unknown (not judged).
 * `ageBand` is accepted for signature stability (the band 1-3 menu only
 * contains judged shot types) and does not change any rule today.
 * An invalid bbox yields offCenterOk/shotSizeOk null, safeZoneOk false,
 * and the `bbox_invalid` note. Notes come from the closed BBOX_NOTES set.
 * @param {{bbox:*, shotType?:string, aspect?:'wide'|'square', textLayout?:string, ageBand?:string}} params
 * @returns {{offCenterOk:boolean|null, safeZoneOk:boolean, shotSizeOk:boolean|null, notes:string[]}}
 */
function bboxRules({ bbox, shotType, aspect, textLayout } = {}) {
  const box = normalizeBbox(bbox);
  if (!box) return { offCenterOk: null, safeZoneOk: false, shotSizeOk: null, notes: [BBOX_NOTES.INVALID] };
  const notes = [];
  const cx = box.x + box.w / 2;

  let offCenterOk = null;
  if (aspect === 'wide') {
    if (textLayout === 'half') {
      offCenterOk = cx >= BBOX_RULES.HALF_LAYOUT_MIN_CENTER_X;
      if (!offCenterOk) notes.push(BBOX_NOTES.NOT_RIGHT_HALF);
    } else {
      const [lo, hi] = BBOX_RULES.OFF_CENTER_BAND;
      offCenterOk = cx < lo || cx > hi;
      if (!offCenterOk) notes.push(BBOX_NOTES.CENTRE_BAND);
    }
  }

  // Edge tolerance: a bbox sitting exactly on the zone boundary is inside
  // it (0.075 + 0.85 is not 0.925 in floating point).
  const EPS = 1e-9;
  const { x: [sx0, sx1], y: [sy0, sy1] } = BBOX_RULES.SAFE_ZONE;
  const safeZoneOk = box.x >= sx0 - EPS && box.x + box.w <= sx1 + EPS && box.y >= sy0 - EPS && box.y + box.h <= sy1 + EPS;
  if (!safeZoneOk) notes.push(BBOX_NOTES.OUTSIDE_SAFE_ZONE);

  let shotSizeOk = null;
  const rule = typeof shotType === 'string' && Object.prototype.hasOwnProperty.call(BBOX_RULES.SHOT_HEIGHT, shotType)
    ? BBOX_RULES.SHOT_HEIGHT[shotType] : null;
  if (rule) {
    shotSizeOk = (rule.min === undefined || box.h >= rule.min) && (rule.max === undefined || box.h <= rule.max);
    if (!shotSizeOk) notes.push(BBOX_NOTES.SHOT_SIZE);
  }

  return { offCenterOk, safeZoneOk, shotSizeOk, notes };
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

const EMBED_TIMEOUT_MS = 30000;
const VERTEX_EMBED_MODEL = 'multimodalembedding@001';
const DEFAULT_VERTEX_LOCATION = 'us-central1';

// Failure cooldown: a backend that is unreachable/misconfigured sits out a
// window instead of costing one failed call per candidate. Keyed by backend
// name; the one-time "cannot load auth library" log is a separate latch.
const EMBED_FAILURE_COOLDOWN_MS = 60 * 1000;
const _embedFailures = new Map();
let _authLibraryWarned = false;
let _authClient = null;

// Bounded LRU of sheet embeddings by content hash — the sheet is embedded
// once per book, not once per candidate.
const SHEET_EMBED_MAX = 8;
const _sheetEmbeddings = new Map();

/** @param {string} key @returns {boolean} */
function inEmbedCooldown(key) {
  const at = _embedFailures.get(key);
  if (at === undefined) return false;
  if (Date.now() - at < EMBED_FAILURE_COOLDOWN_MS) return true;
  _embedFailures.delete(key);
  return false;
}

/** @param {string} key */
function recordEmbedFailure(key) {
  _embedFailures.delete(key);
  _embedFailures.set(key, Date.now());
  while (_embedFailures.size > 16) _embedFailures.delete(_embedFailures.keys().next().value);
}

/** LRU get for sheet embeddings. @param {string} key @returns {number[]|null} */
function sheetCacheGet(key) {
  if (!_sheetEmbeddings.has(key)) return null;
  const v = _sheetEmbeddings.get(key);
  _sheetEmbeddings.delete(key);
  _sheetEmbeddings.set(key, v);
  return v;
}

/** LRU set for sheet embeddings. @param {string} key @param {number[]} value */
function sheetCacheSet(key, value) {
  _sheetEmbeddings.delete(key);
  _sheetEmbeddings.set(key, value);
  while (_sheetEmbeddings.size > SHEET_EMBED_MAX) _sheetEmbeddings.delete(_sheetEmbeddings.keys().next().value);
}

/** @param {*} v @returns {boolean} a non-empty array of finite numbers */
function isVector(v) {
  return Array.isArray(v) && v.length > 0 && v.every(n => typeof n === 'number' && Number.isFinite(n));
}

/**
 * Lazily build the Google OAuth client. `google-auth-library` is a
 * transitive dependency today (via @google-cloud/storage) — it is resolved
 * at call time and its absence logs ONCE and disables the backend.
 * @param {(level: string, msg: string) => void} log
 * @returns {Promise<string|null>} bearer token or null
 */
async function vertexAccessToken(log) {
  if (!_authClient) {
    let lib;
    try {
      require.resolve('google-auth-library');
      lib = require('google-auth-library'); // eslint-disable-line global-require
    } catch (err) {
      if (!_authLibraryWarned) {
        _authLibraryWarned = true;
        log('warn', `identity metrics: google-auth-library is not available (${err.message}) — the vertex embedding backend is disabled`);
      }
      return null;
    }
    _authClient = new lib.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  }
  const token = await _authClient.getAccessToken();
  const value = token && typeof token === 'object' ? token.token : token;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Vertex AI multimodalembedding@001 backend: one predict call per image,
 * bearer-authenticated. Returns the image embedding vector or null.
 * @param {Buffer} buffer
 * @param {(level: string, msg: string) => void} log
 * @returns {Promise<number[]|null>}
 */
async function vertexEmbed(buffer, log) {
  const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
  if (!project) {
    log('warn', 'identity metrics: GOOGLE_CLOUD_PROJECT is not set — the vertex embedding backend is disabled');
    return null;
  }
  const location = process.env.CATALOG_EMBEDDING_LOCATION || DEFAULT_VERTEX_LOCATION;
  const token = await vertexAccessToken(log);
  if (!token) return null;
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${VERTEX_EMBED_MODEL}:predict`;
  const resp = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ instances: [{ image: { bytesBase64Encoded: buffer.toString('base64') } }] }),
    },
    EMBED_TIMEOUT_MS,
  );
  if (!resp.ok) throw new Error(`vertex embedding HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`);
  const data = await resp.json();
  const vec = data && Array.isArray(data.predictions) && data.predictions[0] ? data.predictions[0].imageEmbedding : null;
  if (!isVector(vec)) throw new Error('vertex embedding response carried no imageEmbedding vector');
  return vec;
}

/**
 * Pluggable backends by name. `vertex` ships; a test or a future container
 * model registers another via registerEmbeddingBackend. Each backend is
 * `(buffer, log) => Promise<number[]|null>` and may throw — embedImage
 * converts every failure into null + cooldown.
 */
const EMBEDDING_BACKENDS = new Map([['vertex', vertexEmbed]]);

/**
 * Register (or replace) an embedding backend.
 * @param {string} name
 * @param {(buffer: Buffer, log: Function) => Promise<number[]|null>} fn
 */
function registerEmbeddingBackend(name, fn) {
  if (typeof name !== 'string' || !name || typeof fn !== 'function') return;
  EMBEDDING_BACKENDS.set(name, fn);
}

/** @returns {string} the configured backend name */
function embeddingBackendName() {
  const v = process.env.CATALOG_EMBEDDING_BACKEND;
  return typeof v === 'string' && v.trim() ? v.trim() : 'vertex';
}

/**
 * Embed one image. Null (never a throw) when the identity-metrics switch is
 * off, the backend is unknown/in cooldown/misconfigured, or the call fails.
 * @param {Buffer} buffer PNG/JPEG bytes
 * @param {{log?: (level: string, msg: string) => void}} [opts]
 * @returns {Promise<number[]|null>}
 */
async function embedImage(buffer, { log = () => {} } = {}) {
  if (!flags.identityMetricsEnabled()) return null;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const name = embeddingBackendName();
  const backend = EMBEDDING_BACKENDS.get(name);
  if (!backend) {
    if (!inEmbedCooldown(`unknown:${name}`)) {
      recordEmbedFailure(`unknown:${name}`);
      log('warn', `identity metrics: unknown embedding backend '${name}' — metrics unavailable`);
    }
    return null;
  }
  if (inEmbedCooldown(name)) return null;
  try {
    const vec = await backend(buffer, log);
    if (vec === null) {
      recordEmbedFailure(name);
      return null;
    }
    if (!isVector(vec)) throw new Error('backend returned a malformed vector');
    return vec.slice();
  } catch (err) {
    recordEmbedFailure(name);
    log('warn', `identity metrics: embedding via '${name}' failed (${err.message}) — metrics unavailable for ${EMBED_FAILURE_COOLDOWN_MS / 1000}s`);
    return null;
  }
}

/**
 * Cosine similarity of two equal-length vectors. Null on malformed input,
 * mismatched lengths, or a zero-norm vector.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number|null}
 */
function cosineSimilarity(a, b) {
  if (!isVector(a) || !isVector(b) || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return null;
  return Math.max(-1, Math.min(1, dot / Math.sqrt(na * nb)));
}

/**
 * Identity score: cosine similarity between the render's child crop and the
 * character sheet's crop. The sheet embedding is cached in-process by
 * content hash (fnv1a of the bytes, base36). Null when metrics are off or
 * either embedding is unavailable.
 * @param {{renderCrop: Buffer, sheetCrop: Buffer, log?: Function}} params
 * @returns {Promise<number|null>}
 */
async function identityScore({ renderCrop, sheetCrop, log = () => {} } = {}) {
  if (!flags.identityMetricsEnabled()) return null;
  if (!Buffer.isBuffer(renderCrop) || !Buffer.isBuffer(sheetCrop)) return null;
  try {
    const key = fnv1a(sheetCrop.toString('base64')).toString(36);
    let sheetVec = sheetCacheGet(key);
    if (!sheetVec) {
      sheetVec = await embedImage(sheetCrop, { log });
      if (!sheetVec) return null;
      sheetCacheSet(key, sheetVec);
    }
    const renderVec = await embedImage(renderCrop, { log });
    if (!renderVec) return null;
    return cosineSimilarity(renderVec, sheetVec);
  } catch (err) {
    log('warn', `identity metrics: identityScore failed (${err.message})`);
    return null;
  }
}

/**
 * Set-level outlier test: spreads whose MEAN cosine distance to every other
 * spread is more than `z` standard deviations above the set's mean of those
 * means. Deterministic; empty when fewer than `minCount` valid embeddings
 * (or when the set has no spread at all) or when the embeddings disagree in
 * length. Returns ascending numeric spread ids.
 * @param {Object<string, number[]>} embeddings spread → vector
 * @param {{z?:number, minCount?:number}} [opts]
 * @returns {number[]}
 */
function outlierSpreads(embeddings, { z = 2.0, minCount = 6 } = {}) {
  if (!embeddings || typeof embeddings !== 'object') return [];
  const zed = typeof z === 'number' && Number.isFinite(z) && z > 0 ? z : 2.0;
  const min = Number.isInteger(minCount) && minCount >= 3 ? minCount : 6;
  const rows = [];
  for (const key of Object.keys(embeddings)) {
    const spread = Number(key);
    if (!Number.isInteger(spread) || spread < 1) continue;
    const vec = embeddings[key];
    if (!isVector(vec)) continue;
    rows.push({ spread, vec });
  }
  if (rows.length < min) return [];
  const dim = rows[0].vec.length;
  if (rows.some(r => r.vec.length !== dim)) return [];
  rows.sort((p, q) => p.spread - q.spread);

  const meanDistance = rows.map((row, i) => {
    let sum = 0;
    let n = 0;
    for (let j = 0; j < rows.length; j++) {
      if (j === i) continue;
      const cos = cosineSimilarity(row.vec, rows[j].vec);
      if (cos === null) continue;
      sum += 1 - cos;
      n++;
    }
    return n ? sum / n : 0;
  });
  const mean = meanDistance.reduce((a, b) => a + b, 0) / meanDistance.length;
  const variance = meanDistance.reduce((a, d) => a + (d - mean) ** 2, 0) / meanDistance.length;
  const sd = Math.sqrt(variance);
  if (!(sd > 1e-9)) return [];
  const cutoff = mean + zed * sd;
  return rows.filter((row, i) => meanDistance[i] > cutoff).map(row => row.spread);
}

module.exports = {
  BBOX_RULES,
  BBOX_NOTES,
  DEFAULT_REGIONS,
  SLOT_REGION,
  DEFAULT_DELTA_E_THRESHOLD,
  DEFAULT_INK_DELTA_E_THRESHOLD,
  INK_SET_DELTA_E_THRESHOLD,
  normalizeBbox,
  cropBbox,
  regionColours,
  hexToRgb,
  rgbToHex,
  rgbToLab,
  deltaE,
  nearestDeltaE,
  outfitColourCheck,
  textInkColour,
  inkSetOutliers,
  bboxRules,
  embedImage,
  registerEmbeddingBackend,
  cosineSimilarity,
  identityScore,
  outlierSpreads,
};
