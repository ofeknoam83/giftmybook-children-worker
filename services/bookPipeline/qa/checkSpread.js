/**
 * Per-spread QA for the new pipeline.
 *
 * Runs the existing text QA (OCR vs expected caption, single-side, no stray
 * text) and consistency QA (hero identity, outfit, cast) in parallel, then
 * merges their verdicts into one structured result. Returns a minimal shape
 * the orchestrator can use to accept, correct, or escalate a spread.
 */

const { verifySpreadText } = require('../../illustrator/textQa');
const { checkSpreadConsistency } = require('../../illustrator/consistencyQa');

/**
 * @param {object} params
 * @param {string} params.imageBase64
 * @param {{ text: string, side: 'left'|'right' }} params.expected
 * @param {object} params.coverRef - { base64, mime } for consistency QA
 * @param {string} params.hero - hero description string for consistency QA
 * @param {string} [params.additionalCoverCharacters]
 * @param {boolean} [params.coverParentPresent]
 * @param {number} params.spreadIndex - 0-based
 * @param {AbortSignal} [params.abortSignal]
 * @returns {Promise<{ pass: boolean, issues: string[], tags: string[], ocrText?: string, text: object, consistency: object }>}
 */
async function checkSpread(params) {
  const {
    imageBase64,
    expected,
    coverRef,
    hero,
    additionalCoverCharacters,
    coverParentPresent,
    spreadIndex,
    abortSignal,
  } = params;

  const [textQa, consistencyQa] = await Promise.all([
    verifySpreadText(imageBase64, expected, { spreadIndex, abortSignal }),
    checkSpreadConsistency({
      imageBase64,
      coverBase64: coverRef?.base64,
      coverMime: coverRef?.mime || 'image/jpeg',
      childAppearance: hero,
      additionalCoverCharacters,
      coverParentPresent,
      abortSignal,
    }).catch(err => ({
      pass: false,
      issues: [`consistency QA error: ${err?.message || 'unknown'}`],
      tags: ['qa_consistency_error'],
    })),
  ]);

  const issues = [
    ...(textQa.issues || []),
    ...(consistencyQa.issues || []),
  ];
  const tags = [
    ...(textQa.tags || []),
    ...(consistencyQa.tags || []),
  ];

  return {
    pass: issues.length === 0,
    issues,
    tags: [...new Set(tags)],
    ocrText: textQa.ocrText,
    text: textQa,
    consistency: consistencyQa,
  };
}

module.exports = { checkSpread };
