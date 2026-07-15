/**
 * Likeness judge (A0/A3) — scores a generated image against the APPROVED
 * COVER character, cross-family by design: the product's core promise is
 * never graded by a single model family (LIKENESS_JUDGE_A gemini +
 * LIKENESS_JUDGE_B openai by default; validateLikenessFamilies guards
 * env overrides from collapsing them).
 *
 * Reference contract (product decision 2026-07-15): the parent approved
 * the COVER — that character IS the book's character, so likeness is
 * judged illustration-vs-illustration against the cover (A0 sheet
 * candidates vs the cover; A3 spread candidates vs the model sheet +
 * cover). The RAW PHOTO is NOT a QA reference: photo-vs-illustration
 * judging is unwinnable (age stylization, medium gap) and second-guesses
 * the parent's approval. Photos remain only as a fallback reference for
 * books that somehow have no cover.
 *
 * Verdict rule: a candidate passes only when BOTH families score
 * likeness ≥ the pass score and neither reports a hard defect
 * (different character / skin-tone mismatch).
 */

const { callVisionRole } = require('../../llm/visionClient');
const { LIKENESS_ROLES } = require('../../llm/modelRouter');

/** Default pass bar (1-5 scale). Env-tunable via BOOK_PIPELINE_V3_LIKENESS_PASS_SCORE. */
const LIKENESS_PASS_SCORE = 4;

/**
 * Effective pass score — read at call time so an ops env flip takes effect
 * without a restart-sensitive module cache. Clamped to [1, 5]; anything
 * unparsable falls back to the default.
 * @returns {number}
 */
function resolveLikenessPassScore() {
  const v = Number(process.env.BOOK_PIPELINE_V3_LIKENESS_PASS_SCORE);
  if (Number.isFinite(v) && v >= 1 && v <= 5) return v;
  return LIKENESS_PASS_SCORE;
}

const JUDGE_PROMPT = `You are judging whether an illustrated candidate depicts THE SAME CHARACTER as this book's APPROVED reference art.
Image 1 is the candidate. The remaining image(s) are the APPROVED reference art of the character — the book cover the parent approved (and, when present, the character model sheet derived from it). The reference art is the identity ground truth: the parent looked at that character and said "that's my kid."

Score STRICTLY — every page of the book must star the character the parent approved.

What you are grading — CHARACTER IDENTITY between two illustrations:
- Hair: color (including warmth/coolness), texture (straight/wavy/curly), cut and fringe style.
- Skin tone: undertone AND depth must match the reference character.
- Face shape and apparent age/proportions: same character, same age, same build as the reference.
- Every distinguishing feature the reference character has (glasses, freckles, dimples, birthmarks...) — present and matching.
Both images are illustrations from the same book pipeline: minor rendering differences (lighting, brush detail, pose) are NOT identity defects. A DIFFERENT hair cut, skin tone, age, or face IS.

Return STRICT JSON:
{
  "likeness": 1-5,            // 5 = unmistakably the same character as the reference; 3 = similar coloring but reads as a different child; 1 = clearly a different character
  "skinToneMatch": true|false, // undertone AND depth match the reference character
  "hairMatch": true|false,
  "ageMatch": true|false,      // same apparent age and body/face proportions as the reference character
  "wrongChild": true|false,    // reads as a DIFFERENT character than the reference
  "defects": ["specific, actionable notes — e.g. 'hair warmer than the cover character', 'aged down ~3 years vs the cover', 'freckles missing'"]
}

Rules:
- Judge character identity, not art quality. A beautiful image of the wrong character scores 1.
- skinToneMatch=false or wrongChild=true are HARD failures regardless of the likeness number.`;

/**
 * One judge, one candidate.
 *
 * @param {object} opts
 * @param {string} opts.role - LIKENESS_JUDGE_A | LIKENESS_JUDGE_B
 * @param {{base64: string, mimeType?: string}} opts.candidate - illustrated image
 * @param {Array<{base64: string, mimeType?: string}>} opts.referenceImages - approved reference art
 *   (the cover; for spreads also the model sheet). Photos only as fallback for coverless books.
 * @param {string} [opts.contextNote] - extra grounding (e.g. 'candidate is a character model sheet with multiple poses')
 * @param {AbortSignal} [opts.abortSignal]
 * @returns {Promise<{ role: string, model: string, family: string, likeness: number, pass: boolean, defects: string[] }>}
 */
async function judgeLikenessOnce({ role, candidate, referenceImages, contextNote, abortSignal }) {
  const prompt = contextNote ? `${JUDGE_PROMPT}\n\nContext: ${contextNote}` : JUDGE_PROMPT;
  const { json, model, family } = await callVisionRole(role, {
    prompt,
    images: [candidate, ...referenceImages],
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
    pass: !hardFail && likeness >= resolveLikenessPassScore(),
    defects: Array.isArray(json.defects) ? json.defects.map(String) : [],
  };
}

/**
 * Cross-family verdict for one candidate: both judges must pass it.
 *
 * @param {object} opts - { candidate, referenceImages, contextNote, abortSignal }
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
  resolveLikenessPassScore,
  JUDGE_PROMPT,
};
