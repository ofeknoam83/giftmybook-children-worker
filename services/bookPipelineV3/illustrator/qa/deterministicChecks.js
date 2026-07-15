/**
 * Cheap pre-checks (A3, first tier of the cascade) — run before any
 * expensive judging so obviously-broken candidates never reach the
 * vision judges:
 *
 *   1. integrity/resolution — sharp metadata (decodable, min dimensions)
 *   2. letterform gate — ONE single-purpose vision question: "is there
 *      ANY text in this image?" Under design D5 any lettering is an
 *      automatic hard fail (this inverts the legacy textQa, which used
 *      OCR to verify painted text MATCHED — that entire QA class is
 *      retired on the native path).
 */

const sharp = require('sharp');
const { callVisionRole } = require('../../llm/visionClient');

const MIN_DIMENSION_PX = Number(process.env.BOOK_PIPELINE_V3_MIN_RENDER_PX || 768);

// Calibrated 2026-07-15: the old "err on the side of hasText=true if
// anything even resembles lettering" wording hard-failed 11/13 spreads of
// the first native book (star trails / map squiggles read as "letter-like").
// The gate now flags READABLE marks only — actual letterforms a reader
// would attempt to read — and names what/where so repairs are targeted.
const LETTERFORM_PROMPT = `Look at this illustration. Does it contain READABLE TEXT — actual letters, numbers, or words a reader would attempt to read? This includes tiny, blurry, partial, or stylized-but-legible writing: captions, signage, book pages with words, labels, watermarks.

NOT text (do not flag): abstract squiggles or wavy lines standing in for writing, star trails and constellation lines, glowing glyphs or symbols that cannot be read, decorative patterns, branches, fabric texture. The rule: if no specific letters or digits can be made out or reasonably inferred, hasText is false.

Return STRICT JSON: { "hasText": true|false, "what": "the readable text or marks you see, or null", "where": "short location description or null" }`;

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
 * @param {{base64: string, mimeType?: string}} candidate
 * @param {AbortSignal} [abortSignal]
 * @returns {Promise<{ pass: boolean, defects: string[] }>}
 */
async function letterformCheck(candidate, abortSignal) {
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
    return { pass: false, defects: [`lettering detected in artwork${detail ? ` (${detail})` : ''} — automatic fail (D5: no text in pixels)`] };
  }
  return { pass: true, defects: [] };
}

/**
 * Full pre-check cascade for one candidate; short-circuits on integrity.
 *
 * @param {{base64: string, mimeType?: string}} candidate
 * @param {AbortSignal} [abortSignal]
 * @returns {Promise<{ pass: boolean, defects: string[] }>}
 */
async function runDeterministicChecks(candidate, abortSignal) {
  const integrity = await integrityCheck(candidate);
  if (!integrity.pass) return integrity;
  const letterform = await letterformCheck(candidate, abortSignal);
  return { pass: letterform.pass, defects: letterform.defects };
}

module.exports = {
  runDeterministicChecks,
  integrityCheck,
  letterformCheck,
  MIN_DIMENSION_PX,
  LETTERFORM_PROMPT,
};
