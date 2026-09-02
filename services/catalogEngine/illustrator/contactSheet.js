/**
 * Contact sheets — the set-level gate's purpose-built comparison images
 * (ce-9, plan §5.4).
 *
 * The world gate compares twelve whole-spread JPEG thumbnails in one call;
 * at 1024px a 16:9 spread's garments are a few dozen pixels and a carried
 * prop is a smudge. ce-9 adds two images built for the question actually
 * being asked:
 *
 *   - the CHILD contact sheet — the child crops from the selected renders,
 *     tiled at ~384px with a "SPREAD n" label above each, the character
 *     model sheet as the FIRST tile labelled "REFERENCE";
 *   - the PROPS contact sheet — the prop crops the same way, the prop sheet
 *     as the reference tile.
 *
 * ONE vision call over each asks which tiles CLEARLY differ from the
 * reference (identity + outfit garment by garment for the child; object,
 * colours, material, markings, size for the prop). Every verdict is
 * validated exactly like checkWorldConsistency: only spreads in the check
 * can be flagged, duplicates collapse, the defect is a CLOSED enum owned by
 * this module (`CONTACT_DEFECTS`), and the model's free-form `note` is
 * diagnostics-only data (advisories/callbacks) that never reaches a prompt
 * — repair prompts come from `CONTACT_REPAIR_INSTRUCTIONS` alone.
 *
 * Everything pinned into the prompt is sanitized first: tile labels are
 * control-stripped, length-capped, and XML-escaped before they enter the
 * SVG overlay; the outfit / prop spec text is quoted as data with control
 * chars, quotes, and backticks stripped and a hard length cap. Nothing the
 * model answers is ever pinned anywhere.
 *
 * Fail-open by contract (the gate must never block a book on the checker
 * itself): an HTTP/transport failure or a malformed verdict passes with
 * `qaUnavailable`; a transport failure also arms a short cooldown so a
 * down vision API costs one timeout per window instead of one per book
 * stage. Kill-switch: CATALOG_WORLD_QA=0 (the set-level gate's switch)
 * resolves null — no verdict, no call. Contact sheets drive CHECKS only;
 * no render ever sees one (plan §9: renders never see other renders except
 * as crops inside a QA contact sheet).
 */

const sharp = require('sharp');
const { getNextApiKey, fetchWithTimeout } = require('../../illustrationGenerator');
const { GEMINI_QA_MODEL } = require('../../shared/illustration/config');
const { fnv1a } = require('../selection');
const flags = require('../flags');

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';
const VISION_MODEL = () => process.env.CATALOG_QA_VISION_MODEL || GEMINI_QA_MODEL;
const VISION_TIMEOUT_MS = 90000;
const VISION_MAX_OUTPUT_TOKENS = 1024;

/** A book has 12 spreads; the sheet never carries more tiles than that (+ the reference). */
const CONTACT_MAX_TILES = 12;
const DEFAULT_TILE_SIZE = 384;
const DEFAULT_COLUMNS = 4;
const DEFAULT_LABEL_HEIGHT = 28;
const TILE_SIZE_MIN = 64;
const TILE_SIZE_MAX = 1024;
const COLUMNS_MIN = 1;
const COLUMNS_MAX = 8;
const LABEL_HEIGHT_MIN = 16;
const LABEL_HEIGHT_MAX = 64;
/** The sheet is sent as JPEG: 13 tiles at 384px stay far under the inline limit while garments stay legible. */
const SHEET_JPEG_QUALITY = 90;

const LABEL_MAX_CHARS = 24;
const NOTE_MAX_CHARS = 300;
const SPEC_TEXT_MAX_CHARS = 600;
const PROP_NAME_MAX_CHARS = 80;
const REFERENCE_LABEL = 'REFERENCE';
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\uFEFF]+/g;

/**
 * Closed vocabulary of set-break classes the contact-sheet gate can act on.
 * The child sheet only ever yields `character_rendering` (the world gate's
 * own class, so one repair note serves both gates); the props sheet only
 * ever yields `prop_rendering`.
 */
const CONTACT_DEFECTS = new Set(['character_rendering', 'prop_rendering']);

/**
 * FIXED corrective instructions per contact defect. `<n>` in the prop
 * sentence is the reference-pack index of the prop sheet the render
 * attaches — substituted by `contactRepairNote` from a caller-pinned
 * integer, never from model output.
 */
const CONTACT_REPAIR_INSTRUCTIONS = {
  character_rendering: 'Render the child EXACTLY as the reference character and the book\'s other spreads: the same apparent age, the same face and body proportions, the same stylization level, the same outfit, and the same hair.',
  prop_rendering: 'Draw the prop EXACTLY as REFERENCE <n> shows it — the same object, colours, material and size as on the book\'s other spreads; keep the scene otherwise identical.',
};

// Transport-failure cooldown, keyed by vision model: after an HTTP 5xx/429
// or a thrown transport error, contact checks pass with `qaUnavailable`
// without calling for the window — a down API costs one timeout, not one
// per check. Bounded like worldPlate's failure map. A malformed verdict
// does NOT arm it (the API answered; the next call may parse).
const VISION_FAILURE_COOLDOWN_MS = 2 * 60 * 1000;
const VISION_FAILURE_MAX = 8;
const _failures = new Map();

/** @param {string} key @returns {boolean} still inside the failure cooldown */
function inFailureCooldown(key) {
  const at = _failures.get(key);
  if (at === undefined) return false;
  if (Date.now() - at < VISION_FAILURE_COOLDOWN_MS) return true;
  _failures.delete(key);
  return false;
}

/** Record a transport failure (evicting oldest past the cap). @param {string} key */
function recordFailure(key) {
  _failures.delete(key);
  _failures.set(key, Date.now());
  while (_failures.size > VISION_FAILURE_MAX) _failures.delete(_failures.keys().next().value);
}

/**
 * Own-property read — a parsed model answer is hostile input (`__proto__` /
 * `constructor` keys are data, never prototype walks).
 * @param {*} obj @param {string} key @returns {*}
 */
function own(obj, key) {
  return obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/** Clamp an optional integer option into [min, max], falling back to `dflt`. */
function clampInt(value, dflt, min, max) {
  const n = Number.isFinite(value) ? Math.round(value) : dflt;
  return Math.min(max, Math.max(min, n));
}

/** XML-escape one string for the SVG overlay. @param {string} s @returns {string} */
function escapeXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Tile label as it may enter the SVG overlay: control chars out, whitespace
 * collapsed, capped at LABEL_MAX_CHARS, then XML-escaped (the cap applies
 * to the readable text, so an escaped label may be longer than 24 bytes).
 * Empty input becomes "TILE" — a tile is never unlabelled.
 * @param {*} label
 * @returns {string} escaped label text, safe inside an SVG <text> node
 */
function sanitizeLabel(label) {
  const readable = String(label ?? '')
    .replace(CONTROL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LABEL_MAX_CHARS)
    .trim();
  return escapeXml(readable || 'TILE');
}

/**
 * Inert prompt form of a spec sentence or a prop name: control chars and
 * newlines collapse, quotes and backticks strip (the value is quoted into
 * the prompt as `"…"`), whitespace normalizes, length-capped. Null when
 * nothing survives — the prompt then omits the line instead of quoting
 * an empty string.
 * @param {*} value @param {number} max @returns {string|null}
 */
function inertText(value, max) {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(CONTROL_RE, ' ')
    .replace(/["'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
  return cleaned.length >= 2 ? cleaned : null;
}

/**
 * The label strip above one tile — a plain sans-serif line on a light grey
 * band. The label MUST already be sanitized (`sanitizeLabel`).
 * @param {string} escapedLabel
 * @param {number} width
 * @param {number} height
 * @returns {Buffer} SVG bytes
 */
function labelSvg(escapedLabel, width, height) {
  const fontSize = Math.max(10, Math.round(height * 0.55));
  const baseline = Math.round(height * 0.7);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<rect width="${width}" height="${height}" fill="#e6e6e6"/>`
    + `<text x="6" y="${baseline}" font-family="Liberation Sans, DejaVu Sans, Helvetica, Arial, sans-serif" font-size="${fontSize}" fill="#111111">${escapedLabel}</text>`
    + '</svg>',
  );
}

/**
 * Tile one or more images into a labelled grid (PNG). Each tile is resized
 * to fit `tileSize` × `tileSize` (contain, white background) under a
 * `labelHeight`-tall label strip; tiles fill left-to-right, top-to-bottom,
 * `columns` per row; when a `reference` is given it becomes the FIRST tile
 * with its own label (default "REFERENCE"). Deterministic for the same
 * inputs (no timestamps, fixed encoder settings). Throws on an undecodable
 * tile — the gate callers pre-filter tiles and fail open around it.
 * @param {Array<{label: string, buffer: Buffer}>} tiles
 * @param {{tileSize?: number, columns?: number, reference?: {label?: string, buffer: Buffer}|null, labelHeight?: number}} [opts]
 * @returns {Promise<Buffer>} PNG
 */
async function buildContactSheet(tiles, opts = {}) {
  const tileSize = clampInt(opts.tileSize, DEFAULT_TILE_SIZE, TILE_SIZE_MIN, TILE_SIZE_MAX);
  const columns = clampInt(opts.columns, DEFAULT_COLUMNS, COLUMNS_MIN, COLUMNS_MAX);
  const labelHeight = clampInt(opts.labelHeight, DEFAULT_LABEL_HEIGHT, LABEL_HEIGHT_MIN, LABEL_HEIGHT_MAX);
  const entries = [];
  if (opts.reference && Buffer.isBuffer(opts.reference.buffer)) {
    entries.push({ label: opts.reference.label ?? REFERENCE_LABEL, buffer: opts.reference.buffer });
  }
  for (const t of Array.isArray(tiles) ? tiles : []) {
    if (t && Buffer.isBuffer(t.buffer)) entries.push({ label: t.label, buffer: t.buffer });
  }
  if (entries.length === 0) throw new Error('contact sheet needs at least one tile');

  const cellHeight = labelHeight + tileSize;
  const rows = Math.ceil(entries.length / columns);
  const composites = [];
  for (let i = 0; i < entries.length; i++) {
    const left = (i % columns) * tileSize;
    const top = Math.floor(i / columns) * cellHeight;
    const image = await sharp(entries[i].buffer)
      .resize(tileSize, tileSize, { fit: 'contain', background: { r: 255, g: 255, b: 255 } })
      .png()
      .toBuffer();
    composites.push({ input: labelSvg(sanitizeLabel(entries[i].label), tileSize, labelHeight), left, top });
    composites.push({ input: image, left, top: top + labelHeight });
  }
  // The label SVGs and resized tiles carry alpha; the sheet itself is an
  // opaque RGB PNG (smaller, and every pixel read in QA is a plain triple).
  return sharp({
    create: { width: columns * tileSize, height: rows * cellHeight, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite(composites)
    .removeAlpha()
    .png()
    .toBuffer();
}

/**
 * Normalize the caller's tiles into the checked subset: `spread` must be a
 * positive integer, `buffer` a decodable image (an undecodable crop is
 * dropped with a log, never a failed check); duplicates collapse to the
 * first entry; ascending spread order (deterministic sheet layout); capped
 * at CONTACT_MAX_TILES.
 * @param {*} tiles
 * @param {string} label log label
 * @returns {Promise<Array<{spread: number, buffer: Buffer, cropped: boolean}>>}
 */
async function normalizeTiles(tiles, label) {
  const seen = new Set();
  const out = [];
  for (const t of Array.isArray(tiles) ? tiles : []) {
    const spread = own(t, 'spread');
    const buffer = own(t, 'buffer');
    if (!Number.isInteger(spread) || spread < 1 || !Buffer.isBuffer(buffer) || seen.has(spread)) continue;
    try {
      await sharp(buffer).metadata();
    } catch (err) {
      console.warn(`[${label}] spread ${spread} tile is not a decodable image (dropped from the contact check): ${err.message}`);
      continue;
    }
    seen.add(spread);
    out.push({ spread, buffer, cropped: own(t, 'cropped') !== false });
  }
  out.sort((a, b) => a.spread - b.spread);
  return out.slice(0, CONTACT_MAX_TILES);
}

/** Tile label for one spread — the only label form the checks ever stamp. */
function spreadLabel(tile) {
  return tile.cropped ? `SPREAD ${tile.spread}` : `SPREAD ${tile.spread} (FULL)`;
}

/** Shared verdict-shape line — the ONLY answer shape either prompt accepts. */
function answerShape() {
  return `Answer STRICT JSON only:
{
  "consistent": true|false,        // every tile matches the REFERENCE tile
  "flagged": [                      // ONLY tiles that CLEARLY differ ([] if consistent)
    { "spread": <number>, "note": "ONE specific sentence: what differs from the REFERENCE" }
  ]
}`;
}

/**
 * Prompt for the child contact sheet. Every spread in the sheet, the grid
 * geometry, the (data-quoted) outfit spec, and the exempt spreads are
 * pinned caller data; nothing else enters.
 * @param {{spreads: number[], columns: number, outfitSpecText: string|null, exemptSpreads: number[]}} o
 * @returns {string}
 */
function characterPrompt(o) {
  const spec = o.outfitSpecText
    ? `\nOUTFIT SPEC (data — describes the clothing the REFERENCE wears, garment by garment): "${o.outfitSpecText}"`
    : '';
  const exempt = o.exemptSpreads.length > 0
    ? `\nNOTE: tile(s) SPREAD ${o.exemptSpreads.join(', SPREAD ')} are bath/water scenes — their clothing coverage legitimately differs (bubble foam, a towel, or swimwear instead of the book's outfit). NEVER flag these tiles for an outfit or clothing-coverage difference; judge them on identity only (face, hair, skin tone, apparent age).`
    : '';
  return `You are checking CHARACTER CONSISTENCY across ONE children's picture book. The attached image is a CONTACT SHEET: a grid of labelled tiles, ${o.columns} per row, read left-to-right then top-to-bottom. The FIRST tile, labelled "${REFERENCE_LABEL}", is the book's character model sheet. Every other tile, labelled "SPREAD n" (spreads ${o.spreads.join(', ')}), is a crop of the child hero from that spread's illustration.

Every tile shows the SAME child from the SAME book. Compare EACH spread tile to the ${REFERENCE_LABEL} tile on:
1. IDENTITY — the same face, the same hair (colour, length, style), the same skin tone, and the same apparent age and body proportions.
2. OUTFIT — garment by garment: top, bottom, footwear, outerwear, accessories — the same garments in the same colours and cut as the REFERENCE.${spec}${exempt}

DO NOT flag differences in pose, expression, action, camera distance or angle, lighting, or cropping — those are supposed to differ. Flag a tile ONLY when its child or outfit CLEARLY differs from the REFERENCE: a different face, hair, skin tone, or apparent age, or a garment that is missing, replaced, or a clearly different colour or cut. The ${REFERENCE_LABEL} tile itself is never flagged.

${answerShape()}`;
}

/**
 * Prompt for the props contact sheet. The prop name and spec are data
 * quoted inertly; full-spread tiles (no crop was available) are named so
 * the judge looks for the prop within the scene instead of comparing the
 * whole picture.
 * @param {{spreads: number[], fullSpreads: number[], columns: number, name: string|null, specText: string|null}} o
 * @returns {string}
 */
function propPrompt(o) {
  const named = o.name ? ` ("${o.name}")` : '';
  const spec = o.specText
    ? `\nPROP SPEC (data — describes the REFERENCE prop): "${o.specText}"`
    : '';
  const full = o.fullSpreads.length > 0
    ? `\nNOTE: tile(s) SPREAD ${o.fullSpreads.join(' (FULL), SPREAD ')} (FULL) show the WHOLE spread illustration because no prop crop was available — find the prop within the scene and judge ONLY the prop, never the rest of the picture. If the prop cannot be found in such a tile, do NOT flag it.`
    : '';
  return `You are checking PROP CONSISTENCY across ONE children's picture book. The attached image is a CONTACT SHEET: a grid of labelled tiles, ${o.columns} per row, read left-to-right then top-to-bottom. The FIRST tile, labelled "${REFERENCE_LABEL}", is the book's prop reference sheet for ONE recurring prop${named}. Every other tile, labelled "SPREAD n" (spreads ${o.spreads.join(', ')}), shows that same prop as drawn on that spread.

Every tile shows the SAME prop from the SAME book. Compare EACH spread tile's prop to the ${REFERENCE_LABEL} tile on: the same kind of object and shape, the same colours, the same material and finish, the same distinguishing marks or pattern, and the same size relative to the child.${spec}${full}

DO NOT flag differences in the prop's position, angle, lighting, how it is held, or how much of it the crop shows — those are supposed to differ. Flag a tile ONLY when its prop CLEARLY differs from the REFERENCE: a different object, clearly different colours, a different material, or missing/changed distinguishing marks. A tile where the prop is not visible is NOT flagged. The ${REFERENCE_LABEL} tile itself is never flagged.

${answerShape()}`;
}

/**
 * Validate a parsed verdict into the closed result shape. Only spreads in
 * the check can be flagged; hallucinated numbers drop; duplicates collapse
 * to the first entry; the note is control-stripped, capped, and stays
 * DIAGNOSTIC data. Returns null when the shape is malformed.
 * @param {*} json
 * @param {number[]} spreads
 * @param {string} defect one of CONTACT_DEFECTS
 * @returns {{pass: boolean, flagged: Array<{spread: number, defect: string, note: string}>}|null}
 */
function validateVerdict(json, spreads, defect) {
  const consistent = own(json, 'consistent');
  const rawFlagged = own(json, 'flagged');
  if (typeof consistent !== 'boolean' || !Array.isArray(rawFlagged)) return null;
  const known = new Set(spreads);
  const seen = new Set();
  const flagged = [];
  for (const f of rawFlagged) {
    const spread = own(f, 'spread');
    if (!Number.isInteger(spread) || !known.has(spread) || seen.has(spread)) continue;
    seen.add(spread);
    const rawNote = own(f, 'note');
    const note = typeof rawNote === 'string'
      ? rawNote.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX_CHARS)
      : '';
    flagged.push({ spread, defect, note: note || `differs from the ${REFERENCE_LABEL} tile` });
  }
  flagged.sort((a, b) => a.spread - b.spread);
  return { pass: consistent && flagged.length === 0, flagged };
}

/**
 * The shared gate body: normalize tiles, build the sheet with the reference
 * first, ONE vision call (temperature 0, strict JSON), validate. Every
 * failure path is fail-open with `qaUnavailable`; the kill-switch and the
 * <2-tiles case resolve null (no verdict, no call).
 * @param {{label: string, tiles: *, reference: *, defect: string, promptFor: (tiles: Array<{spread: number, cropped: boolean}>) => string, missingReference: string}} o
 * @returns {Promise<{pass: boolean, flagged: Array<{spread: number, defect: string, note: string}>, checked: number, qaUnavailable?: string}|null>}
 */
async function runContactCheck(o) {
  const { label, defect } = o;
  if (!flags.worldQaEnabled()) return null;
  const tiles = await normalizeTiles(o.tiles, label);
  if (tiles.length < 2) return null;
  const spreads = tiles.map(t => t.spread);
  const unavailable = reason => ({ pass: true, flagged: [], checked: tiles.length, qaUnavailable: reason });
  const referenceBuffer = own(o.reference, 'buffer');
  if (!Buffer.isBuffer(referenceBuffer)) {
    console.warn(`[${label}] ${o.missingReference} — passing without the contact check`);
    return unavailable(o.missingReference);
  }
  const model = VISION_MODEL();
  if (inFailureCooldown(model)) {
    console.warn(`[${label}] contact QA transport is in cooldown — passing without the contact check`);
    return unavailable('contact QA in failure cooldown');
  }
  try {
    const sheetPng = await buildContactSheet(
      tiles.map(t => ({ label: spreadLabel(t), buffer: t.buffer })),
      { reference: { label: REFERENCE_LABEL, buffer: referenceBuffer } },
    );
    const sheetJpeg = await sharp(sheetPng).jpeg({ quality: SHEET_JPEG_QUALITY }).toBuffer();
    const parts = [
      { text: o.promptFor(tiles) },
      { inline_data: { mimeType: 'image/jpeg', data: sheetJpeg.toString('base64') } },
    ];
    const apiKey = getNextApiKey();
    const resp = await fetchWithTimeout(
      `${GEMINI_API}/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: { temperature: 0, maxOutputTokens: VISION_MAX_OUTPUT_TOKENS, responseMimeType: 'application/json' },
        }),
      },
      VISION_TIMEOUT_MS,
    );
    if (!resp.ok) {
      if (resp.status === 429 || resp.status >= 500) recordFailure(model);
      console.warn(`[${label}] contact QA HTTP ${resp.status} — passing without the contact check`);
      return unavailable(`contact QA HTTP ${resp.status}`);
    }
    const data = await resp.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    let json;
    try {
      json = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim());
    } catch {
      json = null;
    }
    const verdict = json && typeof json === 'object' ? validateVerdict(json, spreads, defect) : null;
    if (!verdict) {
      console.warn(`[${label}] contact QA returned a malformed verdict — passing without the contact check`);
      return unavailable('contact QA returned a malformed verdict');
    }
    return { ...verdict, checked: tiles.length };
  } catch (err) {
    recordFailure(model);
    console.warn(`[${label}] contact QA failed to run (passing without it): ${err.message}`);
    return unavailable(`contact QA errored: ${err.message}`);
  }
}

/**
 * Child contact sheet check: the child crops of the selected renders vs the
 * character model sheet (identity + outfit garment by garment). Exempt
 * (BATH/WATER) spreads are never flagged for outfit coverage — the prompt
 * says so explicitly; identity flags on them still stand.
 * @param {{tiles: Array<{spread: number, buffer: Buffer}>, sheet: {buffer: Buffer}, outfitSpecText?: string|null, exemptSpreads?: number[], label?: string}} o
 * @returns {Promise<{pass: boolean, flagged: Array<{spread: number, defect: 'character_rendering', note: string}>, checked: number, qaUnavailable?: string}|null>}
 *   null when fewer than 2 decodable tiles (consistency needs a comparison)
 *   or under CATALOG_WORLD_QA=0.
 */
async function checkCharacterContactSheet(o = {}) {
  const label = o.label || 'contactQa:character';
  const outfitSpecText = inertText(o.outfitSpecText, SPEC_TEXT_MAX_CHARS);
  return runContactCheck({
    label,
    tiles: o.tiles,
    reference: o.sheet,
    defect: 'character_rendering',
    missingReference: 'character sheet reference unavailable',
    promptFor: (tiles) => {
      const inCheck = new Set(tiles.map(t => t.spread));
      const exemptSpreads = [...new Set((Array.isArray(o.exemptSpreads) ? o.exemptSpreads : []).filter(s => inCheck.has(s)))]
        .sort((a, b) => a - b);
      return characterPrompt({ spreads: tiles.map(t => t.spread), columns: DEFAULT_COLUMNS, outfitSpecText, exemptSpreads });
    },
  });
}

/**
 * Props contact sheet check: the prop crops (or whole spreads, flagged
 * `cropped: false`, when no crop was available) vs the prop sheet.
 * @param {{tiles: Array<{spread: number, buffer: Buffer, cropped?: boolean}>, propSheet: {buffer: Buffer, specText?: string|null, name?: string|null}, label?: string}} o
 * @returns {Promise<{pass: boolean, flagged: Array<{spread: number, defect: 'prop_rendering', note: string}>, checked: number, qaUnavailable?: string}|null>}
 *   null when fewer than 2 decodable tiles or under CATALOG_WORLD_QA=0.
 */
async function checkPropContactSheet(o = {}) {
  const label = o.label || 'contactQa:prop';
  const name = inertText(own(o.propSheet, 'name'), PROP_NAME_MAX_CHARS);
  const specText = inertText(own(o.propSheet, 'specText'), SPEC_TEXT_MAX_CHARS);
  return runContactCheck({
    label,
    tiles: o.tiles,
    reference: o.propSheet,
    defect: 'prop_rendering',
    missingReference: 'prop sheet reference unavailable',
    promptFor: tiles => propPrompt({
      spreads: tiles.map(t => t.spread),
      fullSpreads: tiles.filter(t => !t.cropped).map(t => t.spread),
      columns: DEFAULT_COLUMNS,
      name,
      specText,
    }),
  });
}

/**
 * Corrective prompt sentence for a contact defect, built ONLY from the
 * closed vocabulary: an unknown defect maps to `character_rendering`'s
 * generic sentence; the prop sentence's `<n>` takes the caller-pinned
 * reference-pack index (a positive integer) or, without one, the words
 * "the PROP SHEET". Never model output.
 * @param {string} defect one of CONTACT_DEFECTS
 * @param {{referenceIndex?: number}} [opts]
 * @returns {string}
 */
function contactRepairNote(defect, opts = {}) {
  const key = CONTACT_DEFECTS.has(defect) ? defect : 'character_rendering';
  const base = CONTACT_REPAIR_INSTRUCTIONS[key];
  if (key !== 'prop_rendering') return base;
  const idx = Number.isInteger(opts.referenceIndex) && opts.referenceIndex > 0 ? String(opts.referenceIndex) : null;
  return base.replace('REFERENCE <n>', idx ? `REFERENCE ${idx}` : 'the PROP SHEET');
}

/**
 * Content fingerprint of a built sheet (fnv1a-base36) — for advisories /
 * markers that want to name the exact sheet a verdict was judged on.
 * @param {Buffer} sheetBuffer @returns {string}
 */
function contactSheetHash(sheetBuffer) {
  return fnv1a(sheetBuffer.toString('base64')).toString(36);
}

module.exports = {
  buildContactSheet,
  checkCharacterContactSheet,
  checkPropContactSheet,
  contactRepairNote,
  contactSheetHash,
  sanitizeLabel,
  CONTACT_DEFECTS,
  CONTACT_REPAIR_INSTRUCTIONS,
  CONTACT_MAX_TILES,
};
