/**
 * Cheap pre-checks (A3, first tier of the cascade) — run before any
 * expensive judging so obviously-broken candidates never reach the
 * vision judges:
 *
 *   1. integrity/resolution — sharp metadata (decodable, min dimensions)
 *   2. mockup-frame gate (wide renders only) — pixel scan of the outer edge
 *      strips for the painted page-stack borders of an "open book photo"
 *   3. letterform gate — ONE single-purpose vision question: "is there
 *      ANY text in this image?" Under design D5 any lettering is an
 *      automatic hard fail (this inverts the legacy textQa, which used
 *      OCR to verify painted text MATCHED — that entire QA class is
 *      retired on the native path).
 */

const sharp = require('sharp');
const { callVisionRole } = require('../../llm/visionClient');

const MIN_DIMENSION_PX = Number(process.env.BOOK_PIPELINE_V3_MIN_RENDER_PX || 768);

// Mockup-frame gate calibration (2026-07-28 audit, book 4c8daf08): three wide
// spreads rendered as PHOTOS OF AN OPEN BOOK — white page-stack strips + curled
// corners + a desk surface at the outer edges, printed into the real book. On
// that book the affected pages measured ~100% near-white low-saturation pixels
// in the outer edge strips; every legitimate full-bleed page measured <= 11%.
// The gate samples the outer MOCKUP_STRIP_FRAC of each vertical edge and fails
// when either edge's near-white fraction reaches MOCKUP_WHITE_FRAC — a wide
// margin on both sides of the observed separation. Wide (16:9) renders only:
// that is where the model reinterprets "spread" as a book photograph, and
// keeping 1:1 renders out avoids false positives on bright scene edges.
const MOCKUP_STRIP_FRAC = 0.04;
const MOCKUP_WHITE_FRAC = 0.5;
const MOCKUP_SAMPLE_SIZE = 128;
const MOCKUP_WHITE_MIN_LUMA = 195;
const MOCKUP_WHITE_MAX_CHROMA = 32;

// Calibrated 2026-07-15: the old "err on the side of hasText=true if
// anything even resembles lettering" wording hard-failed 11/13 spreads of
// the first native book (star trails / map squiggles read as "letter-like").
// The gate now flags READABLE marks only — actual letterforms a reader
// would attempt to read — and names what/where so repairs are targeted.
// Second calibration same day: a single 'N' on a compass rose is a real
// letter but not the garbled-word print-defect class D5 exists to block —
// the gate now distinguishes WORDS (hard fail) from an ISOLATED GLYPH
// integrated into a prop (tolerated, logged).
const LETTERFORM_PROMPT = `Look at this illustration. Does it contain READABLE TEXT — actual letters, numbers, or words a reader would attempt to read? This includes tiny, blurry, partial, or stylized-but-legible writing: captions, signage, book pages with words, labels, watermarks.

ALSO check for PSEUDO-SCRIPT: invented/alien letter-LIKE glyphs arranged in rows, columns, or blocks that MIMIC writing on a COMMUNICATION SURFACE — a screen, tablet, display, note, sign, label, page, or panel readout. In print these read as "weird garbled writing" and are a defect even though no real letters can be made out (2026-07-28 audit: glowing alien script blocks shipped on a map tablet and a stone-slab display).

NOT text and NOT pseudo-script (do not flag): abstract squiggles or wavy lines standing in for writing, star trails and constellation lines, scattered individual symbols or icons (dots, bars, rings, star-glyphs), DECORATIVE CARVINGS on stone, architecture, or ruins (carved runes/petroglyphs as world texture are art, not writing), decorative patterns, branches, fabric texture. The rule: readable letters/digits → "words"; letter-like glyph rows mimicking writing on a screen/tablet/sign/note → "pseudo_script"; everything else → hasText false.

Classify what you found:
- "words": any word, name, multi-letter or multi-digit sequence, caption, signage text, or writing on a page/label — anything a reader would READ.
- "pseudo_script": rows/blocks of invented letter-like glyphs mimicking writing on a screen, tablet, sign, note, label, or panel (NOT decorative carvings on stone/architecture).
- "isolated_glyph": one or more SINGLE, separate letters or digits integrated into an object's design (a compass point letter, a single dial marking, a jersey-style single digit) that do not combine into any word or number.

Return STRICT JSON: { "hasText": true|false, "textType": "words"|"pseudo_script"|"isolated_glyph"|null, "what": "the readable text or marks you see, or null", "where": "short location description or null" }`;

/**
 * @param {{base64: string}} candidate
 * @returns {Promise<{ pass: boolean, defects: string[], width?: number, height?: number }>}
 */
async function integrityCheck(candidate) {
  try {
    const meta = await sharp(Buffer.from(candidate.base64, 'base64')).metadata();
    const defects = [];
    if (!meta.width || !meta.height) defects.push('image not decodable');
    else if (meta.width < MIN_DIMENSION_PX || meta.height < MIN_DIMENSION_PX) {
      defects.push(`resolution ${meta.width}x${meta.height} below print minimum ${MIN_DIMENSION_PX}px`);
    }
    return { pass: defects.length === 0, defects, width: meta.width, height: meta.height };
  } catch (err) {
    return { pass: false, defects: [`image failed to decode: ${err.message}`] };
  }
}

/**
 * Detect the painted borders of an "open book photograph" render: near-white,
 * low-saturation page-stack strips along either vertical edge. Pure pixel
 * math via sharp — no model call.
 *
 * @param {{base64: string}} candidate
 * @returns {Promise<{ pass: boolean, defects: string[], edgeWhiteFrac?: { left: number, right: number } }>}
 */
async function mockupFrameCheck(candidate) {
  try {
    const { data, info } = await sharp(Buffer.from(candidate.base64, 'base64'))
      .resize(MOCKUP_SAMPLE_SIZE, MOCKUP_SAMPLE_SIZE, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    const stripPx = Math.max(2, Math.round(width * MOCKUP_STRIP_FRAC));
    const whiteFrac = (x0, x1) => {
      let total = 0;
      let white = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const o = (y * width + x) * channels;
          const r = data[o];
          const g = data[o + 1];
          const b = data[o + 2];
          const mx = Math.max(r, g, b);
          const mn = Math.min(r, g, b);
          total += 1;
          if (mx > MOCKUP_WHITE_MIN_LUMA && (mx - mn) < MOCKUP_WHITE_MAX_CHROMA) white += 1;
        }
      }
      return total ? white / total : 0;
    };
    const left = whiteFrac(0, stripPx);
    const right = whiteFrac(width - stripPx, width);
    if (Math.max(left, right) >= MOCKUP_WHITE_FRAC) {
      const side = left >= right ? 'left' : 'right';
      return {
        pass: false,
        edgeWhiteFrac: { left, right },
        defects: [`book-mockup frame detected: the ${side} edge is a near-white page-stack border (${Math.round(Math.max(left, right) * 100)}% of the edge strip) — the render is a photograph of an open book, not a full-bleed scene`],
      };
    }
    return { pass: true, defects: [], edgeWhiteFrac: { left, right } };
  } catch (err) {
    // A decode failure here would already have failed integrityCheck; never
    // block on the detector's own errors.
    return { pass: true, defects: [] };
  }
}

/**
 * @param {{base64: string, mimeType?: string}} candidate
 * @param {AbortSignal} [abortSignal]
 * @param {(msg: string) => void} [log]
 * @returns {Promise<{ pass: boolean, defects: string[] }>}
 */
async function letterformCheck(candidate, abortSignal, log = () => {}) {
  const { json } = await callVisionRole('QA_VISION', {
    prompt: LETTERFORM_PROMPT,
    images: [candidate],
    label: 'v3.qa.letterform',
    expectJson: true,
    temperature: 0, // a hard-fail gate must not flip verdicts by sampling luck
    abortSignal,
  });
  if (json.hasText === true) {
    const detail = [json.what, json.where].filter(Boolean).join(' — ');
    // Product decision 2026-07-15: single isolated glyphs integrated into a
    // prop (compass 'N', a dial marking) are tolerated — they either read
    // correctly (harmless at print size) or read as an abstract mark. Only
    // WORDS/readable sequences are the print-defect class D5 blocks. An
    // unknown/missing textType stays a hard fail (safe default).
    if (json.textType === 'isolated_glyph') {
      log(`letterform: tolerated isolated glyph${detail ? ` (${detail})` : ''}`);
      return { pass: true, defects: [] };
    }
    // Pseudo-script (2026-07-28 audit, book 4c8daf08): alien glyph blocks on
    // tablets/screens shipped as "weird garbled writing" in print. Same D5
    // fail as real lettering — the render prompt already bans invented
    // alphabets; this closes the QA side. Decorative stone carvings stay
    // tolerated (the prompt scopes them out).
    if (json.textType === 'pseudo_script') {
      return { pass: false, defects: [`pseudo-script detected in artwork${detail ? ` (${detail})` : ''} — letter-like glyph rows mimicking writing on a screen/tablet/sign; automatic fail (D5: no text in pixels, real or invented)`] };
    }
    return { pass: false, defects: [`lettering detected in artwork${detail ? ` (${detail})` : ''} — automatic fail (D5: no text in pixels)`] };
  }
  return { pass: true, defects: [] };
}

/**
 * Full pre-check cascade for one candidate; short-circuits on integrity.
 *
 * @param {{base64: string, mimeType?: string}} candidate
 * @param {AbortSignal} [abortSignal]
 * @param {(msg: string) => void} [log]
 * @param {{ wideSpread?: boolean }} [opts] - wideSpread enables the
 *   mockup-frame gate (embedded 16:9 renders only)
 * @returns {Promise<{ pass: boolean, defects: string[] }>}
 */
async function runDeterministicChecks(candidate, abortSignal, log, opts = {}) {
  const integrity = await integrityCheck(candidate);
  if (!integrity.pass) return integrity;
  if (opts.wideSpread) {
    const mockup = await mockupFrameCheck(candidate);
    if (!mockup.pass) return mockup;
  }
  const letterform = await letterformCheck(candidate, abortSignal, log);
  return { pass: letterform.pass, defects: letterform.defects };
}

module.exports = {
  runDeterministicChecks,
  integrityCheck,
  mockupFrameCheck,
  letterformCheck,
  MIN_DIMENSION_PX,
  LETTERFORM_PROMPT,
  MOCKUP_STRIP_FRAC,
  MOCKUP_WHITE_FRAC,
};
