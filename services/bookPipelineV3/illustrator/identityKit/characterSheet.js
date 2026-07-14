/**
 * Character model sheet (A0 step 2) — ONE canonical image of the child in
 * the signature style: turnaround poses, expressions, full body with
 * age-correct proportions. Generated with the REAL photos as reference
 * inputs; every candidate is judged for likeness AGAINST THE PHOTO by two
 * model families. The winning sheet becomes the identity ground truth
 * every downstream render references — identity is decided once, at
 * maximum scrutiny, instead of 13 times at render time.
 *
 * Budget (plan §5): best-of-SHEET_BEST_OF, +SHEET_EXTRA_WAVES fresh wave,
 * then needs_review — identity is never shipped "close enough".
 */

const { generateImage } = require('../render/imageClient');
const { judgeLikenessCrossFamily } = require('../qa/likenessJudge');
const { buildNeedsReviewPayload } = require('../../reviewQueue/payload');
const { SHEET_RENDERER_MODEL, SHEET_BEST_OF, SHEET_EXTRA_WAVES } = require('../config');
const { STYLE_BIBLE } = require('../styleBible');

/**
 * @param {object} opts
 * @param {string} opts.briefText - likeness brief (likenessBrief.js)
 * @param {string} [opts.wardrobeNote] - outfit ground truth from the approved cover
 * @returns {string} full sheet render prompt
 */
function buildSheetPrompt({ briefText, wardrobeNote }) {
  return [
    'CHARACTER MODEL SHEET — one single image containing a turnaround study of ONE child character:',
    '- THREE full-body views side by side: front, three-quarter, and profile.',
    '- Below them, TWO head-and-shoulders expression studies: a joyful smile and a curious/wondering look.',
    '- Clean, plain light background (no scene, no props beyond the outfit).',
    '- Same child, identical features and proportions, in every view.',
    '',
    briefText,
    wardrobeNote ? `\nOUTFIT (ground truth from the approved cover): ${wardrobeNote}` : '',
    '',
    STYLE_BIBLE,
    '',
    'The attached photo(s) are the REAL child — the illustrated character must be unmistakably this child. Match skin tone (undertone and depth), hair, eyes, and every listed feature exactly.',
    'ABSOLUTELY NO text, labels, letters, numbers, arrows, or annotations anywhere in the image.',
  ].filter(Boolean).join('\n');
}

/**
 * Generate + judge one wave of sheet candidates.
 * @returns {Promise<{ best: object|null, attempts: object[] }>}
 */
async function runSheetWave({ prompt, photos, waveTag, count, abortSignal, log }) {
  const candidates = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      generateImage({
        model: SHEET_RENDERER_MODEL,
        prompt,
        references: photos.map((p, idx) => ({ ...p, note: `REAL PHOTO ${idx + 1} of the child (identity reference):` })),
        aspectRatio: '16:9',
        abortSignal,
        label: `v3.sheet.${waveTag}.${i + 1}`,
      }).catch((err) => {
        log(`sheet candidate ${waveTag}.${i + 1} render failed: ${err.message}`);
        return null;
      })),
  );

  const attempts = [];
  for (const [i, candidate] of candidates.entries()) {
    if (!candidate) continue;
    try {
      const verdict = await judgeLikenessCrossFamily({
        candidate: { base64: candidate.buffer.toString('base64'), mimeType: candidate.mimeType },
        photos,
        contextNote: 'The candidate is a character MODEL SHEET containing multiple views/poses of the same child — judge the character design, not the sheet layout.',
        abortSignal,
      });
      attempts.push({ tag: `${waveTag}.${i + 1}`, candidate, verdict });
      log(`sheet ${waveTag}.${i + 1}: likeness=${verdict.minLikeness} pass=${verdict.pass}${verdict.defects.length ? ` defects=[${verdict.defects.slice(0, 3).join('; ')}]` : ''}`);
    } catch (err) {
      log(`sheet ${waveTag}.${i + 1} judging failed: ${err.message}`);
    }
  }

  const passing = attempts.filter((a) => a.verdict.pass)
    .sort((a, b) => b.verdict.minLikeness - a.verdict.minLikeness);
  return { best: passing[0] || null, attempts };
}

/**
 * Generate the model sheet with the bounded best-of/wave budget.
 *
 * @param {object} opts
 * @param {Array<{base64: string, mimeType?: string}>} opts.photos
 * @param {string} opts.briefText
 * @param {string} [opts.wardrobeNote]
 * @param {AbortSignal} [opts.abortSignal]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ sheetBuffer: Buffer, sheetMime: string, judgeScores: object, attemptsUsed: number }>}
 * @throws Error with .needsReview payload (reason identity_kit_exhausted) on budget exhaustion
 */
async function generateCharacterSheet({ photos, briefText, wardrobeNote, abortSignal, log = (m) => console.log(`[identityKit] ${m}`) }) {
  const prompt = buildSheetPrompt({ briefText, wardrobeNote });
  const allAttempts = [];

  for (let wave = 0; wave <= SHEET_EXTRA_WAVES; wave += 1) {
    const waveTag = `w${wave}`;
    const { best, attempts } = await runSheetWave({
      prompt, photos, waveTag, count: SHEET_BEST_OF, abortSignal, log,
    });
    allAttempts.push(...attempts);
    if (best) {
      return {
        sheetBuffer: best.candidate.buffer,
        sheetMime: best.candidate.mimeType,
        judgeScores: {
          minLikeness: best.verdict.minLikeness,
          verdicts: best.verdict.verdicts.map((v) => ({ role: v.role, family: v.family, model: v.model, likeness: v.likeness })),
        },
        attemptsUsed: allAttempts.length,
      };
    }
    if (wave < SHEET_EXTRA_WAVES) log(`sheet wave ${waveTag} exhausted (${attempts.length} judged candidates, none passed) — one fresh wave`);
  }

  const err = new Error(
    `character model sheet failed cross-family likeness after ${allAttempts.length} judged candidates across ${SHEET_EXTRA_WAVES + 1} waves — identity is never shipped "close enough"`,
  );
  err.needsReview = buildNeedsReviewPayload({
    stage: 'identityKit',
    reason: 'identity_kit_exhausted',
    defects: [...new Set(allAttempts.flatMap((a) => a.verdict.defects))].slice(0, 20),
    judgeScores: {
      attempts: allAttempts.map((a) => ({ tag: a.tag, minLikeness: a.verdict.minLikeness, pass: a.verdict.pass })),
    },
  });
  throw err;
}

module.exports = { generateCharacterSheet, buildSheetPrompt, runSheetWave };
