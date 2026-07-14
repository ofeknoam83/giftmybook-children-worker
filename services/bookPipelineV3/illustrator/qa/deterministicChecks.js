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

const LETTERFORM_PROMPT = `Look at this illustration. Does it contain ANY text, letters, numbers, words, captions, signage with writing, book pages with visible words, watermarks, or letter-like glyphs anywhere — even tiny, blurry, or partially hidden?
Return STRICT JSON: { "hasText": true|false, "where": "short location description or null" }
Err on the side of hasText=true if anything even resembles lettering.`;

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
    abortSignal,
  });
  if (json.hasText === true) {
    return { pass: false, defects: [`lettering detected in artwork${json.where ? ` (${json.where})` : ''} — automatic fail (D5: no text in pixels)`] };
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
