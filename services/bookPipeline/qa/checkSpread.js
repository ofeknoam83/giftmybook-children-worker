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
 * @param {string} [params.additionalCoverCharacters] - declared off-cover humans
 *   that QA should allow to appear even though they are not on the cover
 * @param {boolean} [params.coverParentPresent] - true if the approved cover
 *   itself depicts a secondary (parent/sibling) in addition to the hero
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

  const hasDeclaredExtraCast = typeof additionalCoverCharacters === 'string' && additionalCoverCharacters.trim().length > 0;

  // NOTE: `hasSecondaryOnCover` means "the cover image literally shows a
  // secondary human figure next to the hero". Without dedicated cover vision
  // we default to false — being declared in the brief does NOT put someone on
  // the cover. `qaAllowedHumansNote` independently allows declared off-cover
  // humans to appear in spreads without being flagged as strangers.
  const [textQa, consistencyQa] = await Promise.all([
    verifySpreadText(imageBase64, expected, { spreadIndex, abortSignal }),
    checkSpreadConsistency(
      imageBase64,
      coverRef?.base64,
      {
        characterDescription: hero,
        hasSecondaryOnCover: coverParentPresent === true,
        qaAllowedHumansNote: hasDeclaredExtraCast ? additionalCoverCharacters : '',
        abortSignal,
      },
    ).catch(err => ({
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
