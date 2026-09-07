/**
 * Deterministic line-art metrics (cb-1, docs/COLORING_BOOK_V2_PLAN.md §4.6)
 * — the NO-LLM half of the page verdict, in the illustrator/metrics.js
 * style: pure functions on raw pixels at NATIVE resolution, thresholds
 * pinned as constants, fail-open (an unmeasurable page yields nulls, never
 * a throw to the caller).
 *
 *  - grayRatio: pixels between the black and white cuts — shading, washes,
 *    hatching read as grey mass; anti-aliasing alone measures ≈ 1-3%.
 *  - inkRatio: black pixels — the band's density bounds (LINE_RULES).
 *  - largestSolid: the biggest connected dark component with high
 *    bounding-box solidity — a filled hair mass, a black shadow; outlines
 *    have low solidity however large.
 *  - strokeWidth: the ink's mean width, 2·area/perimeter over the black
 *    mask, as a % of the image width against the band's target.
 *  - frameRing / marginBreach: ink along a ring inside the edges (a drawn
 *    frame) and ink inside the pinned margin band.
 *  - cleanLineArt: the ONLY pixel edit the pipeline makes — near-white
 *    flattened to white, near-black snapped to black, the anti-aliasing
 *    band untouched, isolated specks removed (counted). Never a threshold.
 *  - checkAspect: the page must come back 3:4 (± tolerance) — never resized
 *    to fit.
 */

const sharp = require('sharp');

/** Pixel cuts (0-255 luminance). */
const WHITE_MIN = 235;
const BLACK_MAX = 40;
/** Verdict thresholds (verify on the bake-off prints; named on the marker). */
const GRAY_BLOCKING = 0.06;
const GRAY_ADVISORY = 0.03;
const INK_BLOCKING_MAX = 0.20;
const SOLID_MIN_AREA = 0.005;
const SOLID_MIN_SOLIDITY = 0.6;
const STROKE_LOW_RATIO = 0.6;
const STROKE_HIGH_RATIO = 1.8;
const FRAME_RING_DENSITY = 0.4;
const MARGIN_BREACH_ADVISORY = 0.05;
const ASPECT_TARGET = 3 / 4;
const ASPECT_TOLERANCE = 0.02;
const SPECK_MAX_PX = 3;
const COMPONENT_SCAN_WIDTH = 320;
const COMPONENT_DARK_MAX = 80;

const THRESHOLDS = Object.freeze({ WHITE_MIN, BLACK_MAX, GRAY_BLOCKING, GRAY_ADVISORY, INK_BLOCKING_MAX, SOLID_MIN_AREA, SOLID_MIN_SOLIDITY, STROKE_LOW_RATIO, STROKE_HIGH_RATIO, FRAME_RING_DENSITY, MARGIN_BREACH_ADVISORY, ASPECT_TARGET, ASPECT_TOLERANCE, SPECK_MAX_PX });

/** @param {number} n @returns {string} percentage with one decimal */
const pct = n => `${(n * 100).toFixed(1)}%`;

/**
 * Raw grayscale pixels of an image (1 channel), or null.
 * @param {Buffer} buffer
 * @returns {Promise<{data: Buffer, width: number, height: number}|null>}
 */
async function grayPixels(buffer) {
  try {
    const { data, info } = await sharp(buffer).flatten({ background: '#ffffff' }).grayscale().raw().toBuffer({ resolveWithObject: true });
    if (!info || !info.width || !info.height || info.channels !== 1) return null;
    return { data, width: info.width, height: info.height };
  } catch (err) {
    return null;
  }
}

/**
 * Whether the image is 3:4 (± tolerance). Never resizes.
 * @param {Buffer} buffer
 * @returns {Promise<{ok: boolean, width: number|null, height: number|null, ratio: number|null}>}
 */
async function checkAspect(buffer) {
  try {
    const { width, height } = await sharp(buffer).metadata();
    if (!width || !height) return { ok: false, width: null, height: null, ratio: null };
    const ratio = width / height;
    return { ok: Math.abs(ratio - ASPECT_TARGET) <= ASPECT_TOLERANCE, width, height, ratio: Math.round(ratio * 1000) / 1000 };
  } catch (err) {
    return { ok: false, width: null, height: null, ratio: null };
  }
}

/**
 * Connected components (4-neighbour) of a binary mask. Returns the
 * components' area and bounding boxes (deterministic scan order).
 * @param {Uint8Array} mask 1 = set
 * @param {number} width
 * @param {number} height
 * @param {number} [maxComponents] stop collecting after this many (safety)
 * @returns {Array<{area: number, minX: number, minY: number, maxX: number, maxY: number}>}
 */
function components(mask, width, height, maxComponents = 100000) {
  const seen = new Uint8Array(mask.length);
  const out = [];
  const stack = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let area = 0;
    let minX = width; let minY = height; let maxX = -1; let maxY = -1;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const idx = stack.pop();
      area += 1;
      const x = idx % width;
      const y = (idx - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[idx - 1] && !seen[idx - 1]) { seen[idx - 1] = 1; stack.push(idx - 1); }
      if (x < width - 1 && mask[idx + 1] && !seen[idx + 1]) { seen[idx + 1] = 1; stack.push(idx + 1); }
      if (y > 0 && mask[idx - width] && !seen[idx - width]) { seen[idx - width] = 1; stack.push(idx - width); }
      if (y < height - 1 && mask[idx + width] && !seen[idx + width]) { seen[idx + width] = 1; stack.push(idx + width); }
    }
    out.push({ area, minX, minY, maxX, maxY });
    if (out.length >= maxComponents) break;
  }
  return out;
}

/**
 * The largest solid dark component on a downscaled mask.
 * @param {Buffer} buffer
 * @returns {Promise<{areaFraction: number, solidity: number}|null>}
 */
async function largestSolidComponent(buffer) {
  try {
    const { data, info } = await sharp(buffer).flatten({ background: '#ffffff' }).grayscale().resize({ width: COMPONENT_SCAN_WIDTH }).raw().toBuffer({ resolveWithObject: true });
    const { width, height } = info;
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < mask.length; i++) mask[i] = data[i] <= COMPONENT_DARK_MAX ? 1 : 0;
    let best = null;
    for (const c of components(mask, width, height)) {
      const bw = c.maxX - c.minX + 1;
      const bh = c.maxY - c.minY + 1;
      const solidity = c.area / (bw * bh);
      if (solidity < SOLID_MIN_SOLIDITY) continue;
      const areaFraction = c.area / (width * height);
      if (!best || areaFraction > best.areaFraction) best = { areaFraction: Math.round(areaFraction * 10000) / 10000, solidity: Math.round(solidity * 100) / 100 };
    }
    return best;
  } catch (err) {
    return null;
  }
}

/**
 * Measure one page. Fail-open: an undecodable image yields every number
 * null and no defects.
 * @param {Buffer} buffer
 * @param {{rules?: {primaryStrokePercent: number, inkMin: number, inkMax: number, marginPercent: number}}} [opts]
 * @returns {Promise<object>} {width, height, grayRatio, inkRatio, whiteRatio, largestSolid, solidFill, strokeWidthPx, strokeWidthPercent, strokeRatio, frameRing, marginBreach, blocking: string[], advisory: string[]}
 */
async function measureLineArt(buffer, opts = {}) {
  const rules = opts.rules || { primaryStrokePercent: 0.9, inkMin: 0.03, inkMax: 0.14, marginPercent: 5 };
  const empty = { width: null, height: null, grayRatio: null, inkRatio: null, whiteRatio: null, largestSolid: null, solidFill: false, strokeWidthPx: null, strokeWidthPercent: null, strokeRatio: null, frameRing: null, marginBreach: null, blocking: [], advisory: [] };
  const px = await grayPixels(buffer);
  if (!px) return empty;
  const { data, width, height } = px;
  const total = width * height;
  let black = 0; let white = 0; let boundary = 0; let ringDark = 0; let ringTotal = 0; let marginInk = 0;
  const ringMin = Math.round(Math.min(width, height) * 0.015);
  const ringMax = Math.round(Math.min(width, height) * 0.035);
  const marginW = Math.round(width * (rules.marginPercent / 100));
  const marginH = Math.round(height * (rules.marginPercent / 100));
  const sideCounts = [0, 0, 0, 0]; const sideTotals = [0, 0, 0, 0];
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const v = data[row + x];
      const isBlack = v <= BLACK_MAX;
      if (isBlack) {
        black += 1;
        const edge = (x === 0 || data[row + x - 1] > BLACK_MAX) || (x === width - 1 || data[row + x + 1] > BLACK_MAX)
          || (y === 0 || data[row - width + x] > BLACK_MAX) || (y === height - 1 || data[row + width + x] > BLACK_MAX);
        if (edge) boundary += 1;
        if (x < marginW || x >= width - marginW || y < marginH || y >= height - marginH) marginInk += 1;
      } else if (v >= WHITE_MIN) {
        white += 1;
      }
      // Frame ring: four bands 1.5%-3.5% inside each edge.
      const dTop = y; const dBottom = height - 1 - y; const dLeft = x; const dRight = width - 1 - x;
      const inTop = dTop >= ringMin && dTop <= ringMax && dLeft > ringMax && dRight > ringMax;
      const inBottom = dBottom >= ringMin && dBottom <= ringMax && dLeft > ringMax && dRight > ringMax;
      const inLeft = dLeft >= ringMin && dLeft <= ringMax && dTop > ringMax && dBottom > ringMax;
      const inRight = dRight >= ringMin && dRight <= ringMax && dTop > ringMax && dBottom > ringMax;
      const side = inTop ? 0 : inBottom ? 1 : inLeft ? 2 : inRight ? 3 : -1;
      if (side >= 0) {
        sideTotals[side] += 1; ringTotal += 1;
        if (v <= 128) { sideCounts[side] += 1; ringDark += 1; }
      }
    }
  }
  const grayRatio = (total - black - white) / total;
  const inkRatio = black / total;
  const whiteRatio = white / total;
  const strokeWidthPx = boundary > 0 ? (2 * black) / boundary : null;
  const strokeWidthPercent = strokeWidthPx != null ? (strokeWidthPx / width) * 100 : null;
  const strokeRatio = strokeWidthPercent != null && rules.primaryStrokePercent > 0 ? strokeWidthPercent / rules.primaryStrokePercent : null;
  const frameRing = ringTotal > 0 ? Math.min(...sideTotals.map((t, i) => (t > 0 ? sideCounts[i] / t : 0))) : null;
  const marginBreach = black > 0 ? marginInk / black : 0;
  const largestSolid = await largestSolidComponent(buffer);
  const solidFill = !!(largestSolid && largestSolid.areaFraction >= SOLID_MIN_AREA);

  const blocking = [];
  const advisory = [];
  if (grayRatio >= GRAY_BLOCKING) blocking.push(`grey shading present (${pct(grayRatio)} mid-tone pixels)`);
  else if (grayRatio >= GRAY_ADVISORY) advisory.push(`light grey traces (${pct(grayRatio)} mid-tone pixels)`);
  if (solidFill) blocking.push(`solid black fills (largest ${pct(largestSolid.areaFraction)} of the page)`);
  if (inkRatio > INK_BLOCKING_MAX) blocking.push(`too dense: solid fills or heavy ink (${pct(inkRatio)} ink)`);
  else if (inkRatio > rules.inkMax) advisory.push(`ink density above the band (${pct(inkRatio)} ink, max ${pct(rules.inkMax)})`);
  if (inkRatio < rules.inkMin) advisory.push(`too sparse (${pct(inkRatio)} ink, min ${pct(rules.inkMin)})`);
  if (strokeRatio != null && (strokeRatio < STROKE_LOW_RATIO || strokeRatio > STROKE_HIGH_RATIO)) {
    advisory.push(`stroke weight off spec (${strokeWidthPercent.toFixed(2)}% of the width vs ${rules.primaryStrokePercent}%)`);
  }
  if (frameRing != null && ringDark > 0 && frameRing >= FRAME_RING_DENSITY) advisory.push('frame drawn around the page');
  if (marginBreach > MARGIN_BREACH_ADVISORY) advisory.push(`ink inside the edge margin (${pct(marginBreach)} of the ink)`);

  const r4 = n => (n == null ? null : Math.round(n * 10000) / 10000);
  return {
    width, height,
    grayRatio: r4(grayRatio), inkRatio: r4(inkRatio), whiteRatio: r4(whiteRatio),
    largestSolid, solidFill,
    strokeWidthPx: strokeWidthPx == null ? null : Math.round(strokeWidthPx * 10) / 10,
    strokeWidthPercent: r4(strokeWidthPercent), strokeRatio: r4(strokeRatio),
    frameRing: r4(frameRing), marginBreach: r4(marginBreach),
    blocking, advisory,
  };
}

/**
 * The non-destructive clean-up: near-white → white, near-black → black,
 * the anti-aliasing band untouched, isolated specks (dark components of
 * ≤ SPECK_MAX_PX pixels) removed and counted. 8-bit grayscale PNG out.
 * Fail-open: an undecodable input comes back unchanged with specks null.
 * @param {Buffer} buffer
 * @param {{despeckle?: boolean}} [opts]
 * @returns {Promise<{buffer: Buffer, specks: number|null, changed: boolean}>}
 */
async function cleanLineArt(buffer, opts = {}) {
  const px = await grayPixels(buffer);
  if (!px) return { buffer, specks: null, changed: false };
  const { data, width, height } = px;
  const out = Buffer.from(data);
  for (let i = 0; i < out.length; i++) {
    const v = out[i];
    if (v >= WHITE_MIN) out[i] = 255;
    else if (v <= BLACK_MAX) out[i] = 0;
  }
  let specks = 0;
  if (opts.despeckle !== false) {
    const mask = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) mask[i] = out[i] <= 128 ? 1 : 0;
    // Components at native resolution; only the tiny ones are touched.
    const seen = new Uint8Array(mask.length);
    const stack = [];
    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || seen[start]) continue;
      const members = [];
      stack.push(start);
      seen[start] = 1;
      let oversized = false;
      while (stack.length) {
        const idx = stack.pop();
        if (!oversized) members.push(idx);
        if (members.length > SPECK_MAX_PX) oversized = true;
        const x = idx % width;
        const y = (idx - x) / width;
        if (x > 0 && mask[idx - 1] && !seen[idx - 1]) { seen[idx - 1] = 1; stack.push(idx - 1); }
        if (x < width - 1 && mask[idx + 1] && !seen[idx + 1]) { seen[idx + 1] = 1; stack.push(idx + 1); }
        if (y > 0 && mask[idx - width] && !seen[idx - width]) { seen[idx - width] = 1; stack.push(idx - width); }
        if (y < height - 1 && mask[idx + width] && !seen[idx + width]) { seen[idx + width] = 1; stack.push(idx + width); }
      }
      if (!oversized && members.length <= SPECK_MAX_PX) {
        specks += 1;
        for (const idx of members) out[idx] = 255;
      }
    }
  }
  const png = await sharp(out, { raw: { width, height, channels: 1 } }).toColourspace('b-w').png().toBuffer();
  return { buffer: png, specks, changed: true };
}

module.exports = { THRESHOLDS, checkAspect, measureLineArt, cleanLineArt, components, largestSolidComponent, grayPixels };
