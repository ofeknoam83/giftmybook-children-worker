/**
 * Likeness judge (A0/A3) — scores a generated image against the child's
 * REAL photo(s), cross-family by design: the product's core promise is
 * never graded by a single model family (LIKENESS_JUDGE_A gemini +
 * LIKENESS_JUDGE_B openai by default; validateLikenessFamilies guards
 * env overrides from collapsing them).
 *
 * Verdict rule: a candidate passes only when BOTH families score
 * likeness ≥ LIKENESS_PASS_SCORE and neither reports a hard defect
 * (wrong child / skin-tone mismatch).
 */

const { callVisionRole } = require('../../llm/visionClient');
const { LIKENESS_ROLES } = require('../../llm/modelRouter');

const LIKENESS_PASS_SCORE = 4;

const JUDGE_PROMPT = `You are judging whether an ILLUSTRATED character is a faithful likeness of a REAL child.
Image 1 is the illustrated candidate. The remaining image(s) are real photos of the child.

Score STRICTLY — a parent bought this book because the character IS their child.

Return STRICT JSON:
{
  "likeness": 1-5,            // 5 = unmistakably this child in illustrated form; 3 = generic child with similar coloring; 1 = different child
  "skinToneMatch": true|false, // undertone AND depth must match the photo
  "hairMatch": true|false,
  "ageMatch": true|false,      // body/face proportions plausible for the SAME age as the photo
  "wrongChild": true|false,    // reads as a DIFFERENT child entirely
  "defects": ["specific, actionable notes — e.g. 'hair too dark', 'skin lightened vs photo', 'aged up ~3 years'"]
}

Rules:
- Judge identity, not art quality. A beautiful image of the wrong child scores 1.
- skinToneMatch=false or wrongChild=true are HARD failures regardless of the likeness number.`;

/**
 * One judge, one candidate.
 *
 * @param {object} opts
 * @param {string} opts.role - LIKENESS_JUDGE_A | LIKENESS_JUDGE_B
 * @param {{base64: string, mimeType?: string}} opts.candidate - illustrated image
 * @param {Array<{base64: string, mimeType?: string}>} opts.photos - real photos
 * @param {string} [opts.contextNote] - extra grounding (e.g. 'candidate is a character model sheet with multiple poses')
 * @param {AbortSignal} [opts.abortSignal]
 * @returns {Promise<{ role: string, model: string, family: string, likeness: number, pass: boolean, defects: string[] }>}
 */
async function judgeLikenessOnce({ role, candidate, photos, contextNote, abortSignal }) {
  const prompt = contextNote ? `${JUDGE_PROMPT}\n\nContext: ${contextNote}` : JUDGE_PROMPT;
  const { json, model, family } = await callVisionRole(role, {
    prompt,
    images: [candidate, ...photos],
    label: `v3.likeness.${role.toLowerCase()}`,
    expectJson: true,
    abortSignal,
  });
  const likeness = Number(json.likeness) || 1;
  const hardFail = json.wrongChild === true || json.skinToneMatch === false;
  return {
    role,
    model,
    family,
    likeness,
    skinToneMatch: json.skinToneMatch !== false,
    hairMatch: json.hairMatch !== false,
    ageMatch: json.ageMatch !== false,
    wrongChild: json.wrongChild === true,
    pass: !hardFail && likeness >= LIKENESS_PASS_SCORE,
    defects: Array.isArray(json.defects) ? json.defects.map(String) : [],
  };
}

/**
 * Cross-family verdict for one candidate: both judges must pass it.
 *
 * @param {object} opts - { candidate, photos, contextNote, abortSignal }
 * @returns {Promise<{ pass: boolean, minLikeness: number, verdicts: object[], defects: string[] }>}
 */
async function judgeLikenessCrossFamily(opts) {
  const verdicts = await Promise.all(
    LIKENESS_ROLES.map((role) => judgeLikenessOnce({ role, ...opts })),
  );
  return {
    pass: verdicts.every((v) => v.pass),
    minLikeness: Math.min(...verdicts.map((v) => v.likeness)),
    verdicts,
    defects: [...new Set(verdicts.flatMap((v) => v.defects))],
  };
}

module.exports = {
  judgeLikenessOnce,
  judgeLikenessCrossFamily,
  LIKENESS_PASS_SCORE,
  JUDGE_PROMPT,
};
