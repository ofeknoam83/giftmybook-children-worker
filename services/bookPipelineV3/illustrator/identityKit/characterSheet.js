/**
 * Character model sheet (A0 step 2) — ONE canonical image of the child in
 * the signature style: turnaround poses, expressions, full body with
 * age-correct proportions. Generated from the likeness-brief DESCRIPTION
 * plus (when available) the parent-APPROVED COVER as a reference — the
 * cover is an illustration the parent already blessed, so attaching it is
 * PROHIBITED_CONTENT-safe; the raw photos are NEVER attached to generation
 * (Part B). Every candidate is judged cross-family AGAINST THE APPROVED
 * COVER CHARACTER (the parent's likeness decision — photos are only the
 * judge fallback for coverless books). The winning sheet becomes the
 * identity ground truth every downstream render references — identity is
 * decided once, at maximum scrutiny, instead of 13 times at render time.
 *
 * Budget (plan §5): best-of-SHEET_BEST_OF, +SHEET_EXTRA_WAVES defect-fed
 * repair wave(s), then needs_review — identity is never SILENTLY shipped
 * "close enough" (BOOK_PIPELINE_V3_KIT_SHIP_ON_EXHAUSTION=1 is the loud
 * ops escape hatch; the admin pick-sheet resolution is the reviewed one).
 */

const { generateImage } = require('../render/imageClient');
const { judgeLikenessCrossFamily } = require('../qa/likenessJudge');
const { buildNeedsReviewPayload } = require('../../reviewQueue/payload');
const { uploadBuffer } = require('../../../gcsStorage');
const { SHEET_RENDERER_MODEL, SHEET_BEST_OF, SHEET_EXTRA_WAVES } = require('../config');
const { STYLE_BIBLE } = require('../styleBible');

/**
 * @param {object} opts
 * @param {string} opts.briefText - likeness brief (likenessBrief.js)
 * @param {string} [opts.wardrobeNote] - outfit ground truth from the approved cover
 * @param {boolean} [opts.hasCoverReference] - approved cover attached to the call
 * @param {string[]} [opts.repairNotes] - judge defects from the prior wave (wave >= 1)
 * @returns {string} full sheet render prompt
 */
function buildSheetPrompt({ briefText, wardrobeNote, hasCoverReference = false, repairNotes = [] }) {
  return [
    'CHARACTER MODEL SHEET — one single image containing a turnaround study of ONE child character:',
    '- THREE full-body views side by side: front, three-quarter, and profile.',
    '- Below them, TWO head-and-shoulders expression studies: a joyful smile and a curious/wondering look.',
    '- Clean, plain light background (no scene, no props beyond the outfit).',
    '- Same child, identical features and proportions, in every view.',
    '',
    briefText,
    wardrobeNote ? `\nOUTFIT (ground truth from the approved cover): ${wardrobeNote}` : '',
    hasCoverReference
      ? '\nAPPROVED COVER REFERENCE: the attached image is this book\'s parent-approved COVER illustration. The model sheet must depict THE SAME character — identical face, hair color and style, skin tone, eye color, and any distinguishing features (e.g. glasses) — translated into the turnaround layout above.'
      : '',
    repairNotes.length
      ? `\nREPAIR — previous candidates were REJECTED by likeness judges for exactly these defects. Fix every one of them:\n${repairNotes.map((d) => `- ${d}`).join('\n')}`
      : '',
    '',
    STYLE_BIBLE,
    '',
    'CHARACTER DESIGN: create an ORIGINAL illustrated children\'s-book character whose appearance follows the description above precisely — skin tone (undertone and depth), hair, eyes, and every listed feature. This is an illustration inspired by a written description, NOT a reproduction of any real, identifiable person.',
    'ABSOLUTELY NO text, labels, letters, numbers, arrows, or annotations anywhere in the image. The outfit must be letter-free: no name tags, no letter badges, no real-world logos, no national flags.',
  ].filter(Boolean).join('\n');
}

/**
 * Generate + judge one wave of sheet candidates.
 * @returns {Promise<{ best: object|null, attempts: object[] }>}
 */
async function runSheetWave({ prompt, photos, coverReference, waveTag, count, abortSignal, log }) {
  // Part B (PROHIBITED_CONTENT safety): the real photos are NEVER attached
  // to a generation call — "render this exact real child" is what Gemini's
  // non-configurable child-safety tier blocks. The approved COVER is an
  // illustration, not a photo, so it may anchor generation; the
  // cross-family judge below still compares every candidate against the
  // real photos (vision analysis is not blocked), so likeness is enforced
  // by selection, not replication.
  const references = coverReference
    ? [{ base64: coverReference.base64, mimeType: coverReference.mimeType || 'image/jpeg', note: 'APPROVED BOOK COVER (character identity + art style ground truth):' }]
    : [];
  const candidates = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      generateImage({
        model: SHEET_RENDERER_MODEL,
        prompt,
        references,
        aspectRatio: '16:9',
        abortSignal,
        label: `v3.sheet.${waveTag}.${i + 1}`,
      }).catch((err) => {
        log(`sheet candidate ${waveTag}.${i + 1} render failed: ${err.message}`);
        return null;
      })),
  );

  // QA reference contract: the APPROVED COVER character is the identity
  // ground truth (parent-approved) — photos are only the fallback for
  // books that somehow have no cover.
  const referenceImages = coverReference
    ? [{ base64: coverReference.base64, mimeType: coverReference.mimeType || 'image/jpeg' }]
    : photos;
  // Judge the wave's candidates in parallel (the serial loop cost
  // ~10-15s per candidate of pure wall clock).
  const attempts = (await Promise.all(candidates.map(async (candidate, i) => {
    if (!candidate) return null;
    try {
      const verdict = await judgeLikenessCrossFamily({
        candidate: { base64: candidate.buffer.toString('base64'), mimeType: candidate.mimeType },
        referenceImages,
        contextNote: 'The candidate is a character MODEL SHEET containing multiple views/poses of the same character — judge the character design against the approved cover character, not the sheet layout.',
        abortSignal,
      });
      log(`sheet ${waveTag}.${i + 1}: likeness=${verdict.minLikeness} pass=${verdict.pass}${verdict.defects.length ? ` defects=[${verdict.defects.slice(0, 3).join('; ')}]` : ''}`);
      return { tag: `${waveTag}.${i + 1}`, candidate, verdict };
    } catch (err) {
      log(`sheet ${waveTag}.${i + 1} judging failed: ${err.message}`);
      return null;
    }
  }))).filter(Boolean);

  const passing = attempts.filter((a) => a.verdict.pass)
    .sort((a, b) => b.verdict.minLikeness - a.verdict.minLikeness);
  return { best: passing[0] || null, attempts };
}

/** Shape one attempt for return/telemetry. */
function toKitResult(attempt, allAttempts, extra = {}) {
  return {
    sheetBuffer: attempt.candidate.buffer,
    sheetMime: attempt.candidate.mimeType,
    judgeScores: {
      minLikeness: attempt.verdict.minLikeness,
      verdicts: attempt.verdict.verdicts.map((v) => ({ role: v.role, family: v.family, model: v.model, likeness: v.likeness })),
      ...extra,
    },
    attemptsUsed: allAttempts.length,
  };
}

/**
 * Best-effort upload of the rejected candidates so the review queue can
 * SHOW the admin what was generated and why it failed. Never throws.
 *
 * @returns {Promise<string[]>} public/signed URLs (may be empty)
 */
async function uploadRejectedCandidates({ attempts, bookId, log }) {
  const folder = `children-jobs/${bookId || 'unknown-book'}/identity-kit-review`;
  const urls = [];
  for (const a of attempts) {
    try {
      const ext = (a.candidate.mimeType || 'image/png').includes('png') ? 'png' : 'jpg';
      const url = await uploadBuffer(a.candidate.buffer, `${folder}/candidate-${a.tag}.${ext}`, a.candidate.mimeType || 'image/png');
      if (url) urls.push(url);
    } catch (err) {
      log(`candidate ${a.tag} review upload failed (non-fatal): ${err.message}`);
    }
  }
  return urls;
}

/**
 * Generate the model sheet with the bounded best-of/wave budget. Wave 2+
 * feeds the prior wave's judge defects back into the prompt (defect-named
 * repair, same philosophy as the spread QA repair wave).
 *
 * @param {object} opts
 * @param {Array<{base64: string, mimeType?: string}>} opts.photos
 * @param {string} opts.briefText
 * @param {string} [opts.wardrobeNote]
 * @param {{base64: string, mimeType?: string}} [opts.coverReference] - approved cover (illustration; policy-safe to attach)
 * @param {string} [opts.bookId] - for review-candidate uploads on exhaustion
 * @param {AbortSignal} [opts.abortSignal]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ sheetBuffer: Buffer, sheetMime: string, judgeScores: object, attemptsUsed: number }>}
 * @throws Error with .needsReview payload (reason identity_kit_exhausted) on budget exhaustion
 */
async function generateCharacterSheet({ photos, briefText, wardrobeNote, coverReference = null, bookId = null, abortSignal, log = (m) => console.log(`[identityKit] ${m}`) }) {
  const allAttempts = [];

  for (let wave = 0; wave <= SHEET_EXTRA_WAVES; wave += 1) {
    const waveTag = `w${wave}`;
    const repairNotes = wave > 0
      ? [...new Set(allAttempts.flatMap((a) => a.verdict.defects))].slice(0, 10)
      : [];
    const prompt = buildSheetPrompt({
      briefText,
      wardrobeNote,
      hasCoverReference: Boolean(coverReference),
      repairNotes,
    });
    const { best, attempts } = await runSheetWave({
      prompt, photos, coverReference, waveTag, count: SHEET_BEST_OF, abortSignal, log,
    });
    allAttempts.push(...attempts);
    if (best) {
      return toKitResult(best, allAttempts);
    }
    if (wave < SHEET_EXTRA_WAVES) log(`sheet wave ${waveTag} exhausted (${attempts.length} judged candidates, none passed) — repair wave with ${repairNotes.length || 'the'} judge defects fed back`);
  }

  // Loud ops escape hatch: ship the best-scoring sheet instead of blocking
  // the book. NEVER silent — the warning names the score and the flag.
  if (process.env.BOOK_PIPELINE_V3_KIT_SHIP_ON_EXHAUSTION === '1' && allAttempts.length > 0) {
    const best = [...allAttempts].sort((a, b) => b.verdict.minLikeness - a.verdict.minLikeness)[0];
    log(`WARNING: likeness budget exhausted but BOOK_PIPELINE_V3_KIT_SHIP_ON_EXHAUSTION=1 — shipping best-scoring sheet ${best.tag} (minLikeness=${best.verdict.minLikeness}, below the pass bar)`);
    return toKitResult(best, allAttempts, { shippedOnExhaustion: true });
  }

  const candidateUrls = await uploadRejectedCandidates({ attempts: allAttempts, bookId, log });
  const err = new Error(
    `character model sheet failed cross-family likeness after ${allAttempts.length} judged candidates across ${SHEET_EXTRA_WAVES + 1} waves — identity is never shipped "close enough"`,
  );
  err.needsReview = buildNeedsReviewPayload({
    stage: 'identityKit',
    reason: 'identity_kit_exhausted',
    defects: [...new Set(allAttempts.flatMap((a) => a.verdict.defects))].slice(0, 20),
    candidateUrls,
    judgeScores: {
      attempts: allAttempts.map((a) => ({
        tag: a.tag,
        minLikeness: a.verdict.minLikeness,
        pass: a.verdict.pass,
        judges: a.verdict.verdicts.map((v) => ({
          role: v.role,
          family: v.family,
          likeness: v.likeness,
          skinToneMatch: v.skinToneMatch,
          hairMatch: v.hairMatch,
          wrongChild: v.wrongChild,
          defects: v.defects.slice(0, 5),
        })),
      })),
    },
  });
  throw err;
}

module.exports = { generateCharacterSheet, buildSheetPrompt, runSheetWave };
