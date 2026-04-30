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
 * @param {Array<{ base64: string, mimeType?: string, spreadNumber?: number }>} [params.recentInteriorRefs]
 *   Recent accepted interiors for continuity QA (hair/outfit vs story-so-far).
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
    recentInteriorRefs,
    abortSignal,
  } = params;

  // Product rule: the cover defines the full visual cast. Off-cover
  // characters (declared in the brief but not on the cover) may only appear
  // as partial presence (hand, silhouette, back-of-head, distant unfocused
  // figure). Any full adult face or full body figure not on the cover is a
  // failure. We therefore do NOT pass an allowed-humans note; consistency
  // QA flags every full non-hero human. `additionalCoverCharacters` is kept
  // on the API for future use (e.g. when we add cover vision and can declare
  // which adults actually appear on the cover), but intentionally ignored
  // here.
  void additionalCoverCharacters;

  const [textQa, consistencyQa] = await Promise.all([
    verifySpreadText(imageBase64, expected, { spreadIndex, abortSignal }),
    checkSpreadConsistency(
      imageBase64,
      coverRef?.base64,
      {
        characterDescription: hero,
        hasSecondaryOnCover: coverParentPresent === true,
        qaAllowedHumansNote: '',
        recentInteriorRefs,
        abortSignal,
      },
    ).catch(err => ({
      pass: false,
      issues: [`consistency QA error: ${err?.message || 'unknown'}`],
      tags: ['qa_consistency_error'],
    })),
  ]);

  let issues = [
    ...(textQa.issues || []),
    ...(consistencyQa.issues || []),
  ];
  let tags = [
    ...(textQa.tags || []),
    ...(consistencyQa.tags || []),
  ];

  // Cascade suppression: if the hero itself is wrong on the spread, the
  // implied-parent skin comparison against the COVER is almost always a
  // cascading false positive ("the parent hand looks mismatched because the
  // child is darker/lighter than the cover") — the real bug is hero_mismatch.
  // Drop the skin tag so the correction turn focuses on fixing the child
  // rather than fighting two conflicting signals at once.
  if (tags.includes('hero_mismatch') && tags.includes('implied_parent_skin_mismatch')) {
    tags = tags.filter(t => t !== 'implied_parent_skin_mismatch');
    issues = issues.filter(i => !/Implied parent/i.test(i));
  }

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
