/**
 * QA-as-selection (A3, the cascade orchestrator) — for each spread:
 *
 *   deterministic pre-checks (integrity, letterform hard-fail)
 *     → spread vision judge (anatomy, contract, cast, style, zone)
 *       → cross-family likeness judge (the core promise)
 *
 * Best candidate passing every tier wins (ranked by likeness, then spread
 * score). If none passes: ONE repair wave — fresh candidates with the
 * judges' named defects appended to the prompt — then the spread becomes
 * a needs_review item WITH ALL CANDIDATES attached (a human picking the
 * acceptable one costs seconds).
 *
 * Generate → select, never generate → patch: repairs re-render from the
 * same fixed references, they never edit a bad image.
 */

const { runDeterministicChecks } = require('./deterministicChecks');
const { judgeSpreadCandidate } = require('./spreadJudge');
const { judgeLikenessCrossFamily } = require('./likenessJudge');
const { renderSpreadCandidates } = require('../render/renderSpread');
const { uploadBuffer } = require('../../../gcsStorage');
const { candidatePath } = require('../render/renderAllSpreads');
const { REPAIR_WAVES_PER_SPREAD, CANDIDATES_PER_SPREAD } = require('../config');
const { buildNeedsReviewPayload } = require('../../reviewQueue/payload');

// Fold band of a wide embedded render (fractions of image width). A hero
// box with at least FOLD_SWALLOW_FRAC of its width inside the band stands
// ON the printed fold and gets split by the binding. Deterministic
// backstop — the judge's fold-collision class alone let fold-centered
// subjects ship (audit #2). The swallowed-fraction form (not box-center)
// keeps close-up shots legal — a large figure spanning the fold is normal
// picture-book composition (2026-07-20, book d7625d8f).
const FOLD_BAND_MIN = 0.44;
const FOLD_BAND_MAX = 0.56;
const FOLD_SWALLOW_FRAC = 0.6;

/**
 * Run the full cascade for one candidate.
 * @returns {Promise<object>} evaluation record
 */
async function evaluateCandidate({ candidate, sceneContract, direction, referenceImages, captionText = null, wideSpread = false, abortSignal, qaTagCounts, log = () => {} }) {
  const record = { candidateIndex: candidate.candidateIndex, path: candidate.path, defects: [], tags: [] };

  const pre = await runDeterministicChecks(candidate, abortSignal, log);
  if (!pre.pass) {
    record.stage = 'deterministic';
    record.pass = false;
    record.defects = pre.defects;
    if (pre.defects.some((d) => d.includes('lettering'))) bump(qaTagCounts, 'text_in_art');
    return record;
  }

  // The pack's cover (kind: 'cover') rides along as the judge's rendering-
  // style reference — cover-less books degrade to the cover-blind judging.
  const coverImage = (referenceImages || []).find((r) => r.kind === 'cover') || null;
  const spread = await judgeSpreadCandidate({ candidate, sceneContract, direction, coverImage, captionText, wideSpread, abortSignal });
  record.spreadScores = spread.scores;
  record.tags = spread.tags;
  // The judge's boxes ride every record (even failing ones — the winner's
  // boxes feed subject-aware caption placement at layout time).
  record.heroBox = spread.heroBox || null;
  record.figuresBox = spread.figuresBox || null;

  // Deterministic fold backstop (audit #2): in a wide embedded render the
  // printed fold runs down the exact center — a NARROW hero standing on it
  // gets split by the binding. The judge's own fold class proved too lenient
  // (a rocket nose and the hero shipped fold-adjacent), so the geometry is
  // enforced here, from the judge's box, not its prose.
  //
  // "Swallowed", not "centered" (2026-07-20, book d7625d8f): the first cut
  // failed any box whose CENTER fell in the band — but a close-up hero
  // legitimately spans much of the frame with a ~0.5 center while plenty of
  // figure shows on both sides, and the shot budget REQUIRES close-ups, so
  // one spread per book could never pass and deterministically exhausted
  // spread QA into needs_review. Now a candidate fails only when the
  // MAJORITY of the hero box lies inside the fold band.
  if (wideSpread && spread.heroBox) {
    const box = spread.heroBox;
    const bandOverlap = Math.max(0, Math.min(box.x + box.w, FOLD_BAND_MAX) - Math.max(box.x, FOLD_BAND_MIN));
    const swallowedFrac = bandOverlap / box.w;
    if (swallowedFrac >= FOLD_SWALLOW_FRAC) {
      record.stage = 'foldCollision';
      record.pass = false;
      record.defects = [`fold collision: the child stands on the spread fold (${(swallowedFrac * 100).toFixed(0)}% of the figure, box width ${(box.w * 100).toFixed(0)}% of the image, sits in the center band) — the binding will swallow the subject; compose the child clearly in the left or right third`];
      record.tags = [...record.tags, 'fold_collision'];
      bump(qaTagCounts, 'fold_collision');
      return record;
    }
  }
  // Minor observations ride the record even when the candidate passes —
  // the orchestrator aggregates the WINNER's minors into doc.qaAdvisories.
  record.minorDefects = spread.minorDefects || [];
  for (const t of spread.tags) bump(qaTagCounts, t);
  if (!spread.pass) {
    record.stage = 'spreadJudge';
    record.pass = false;
    // Only critical notes name the failure (minors never block and would
    // send the repair wave chasing nitpicks).
    record.defects = spread.criticalDefects?.length ? spread.criticalDefects : spread.defects;
    return record;
  }

  const likeness = await judgeLikenessCrossFamily({
    candidate,
    referenceImages,
    contextNote: [
      'The reference art is this book\'s character MODEL SHEET and/or APPROVED COVER — judge whether the candidate spread stars the same character.',
      direction?.shot ? `This spread uses a "${direction.shot}" framing — apply the framing allowance accordingly.` : null,
    ].filter(Boolean).join(' '),
    abortSignal,
  });
  record.likeness = likeness.minLikeness;
  if (!likeness.pass) {
    record.stage = 'likeness';
    record.pass = false;
    record.defects = likeness.defects;
    bump(qaTagCounts, 'likeness_fail');
    return record;
  }

  record.stage = 'passed';
  record.pass = true;
  return record;
}

function bump(counts, tag) {
  if (!counts) return;
  counts[tag] = (counts[tag] || 0) + 1;
}

function pickWinner(evaluations) {
  return evaluations
    .filter((e) => e.pass)
    .sort((a, b) => (b.likeness - a.likeness)
      || (minSpread(b) - minSpread(a))
      || (a.candidateIndex - b.candidateIndex))[0] || null;
}

function minSpread(e) {
  const s = e.spreadScores;
  return s ? Math.min(s.anatomy, s.contract, s.cast, s.style, s.zone) : 0;
}

/**
 * Select the winning candidate for one spread, with the bounded repair wave.
 *
 * @param {object} opts
 * @param {string} opts.bookId
 * @param {object} opts.spread - manuscript spread (scene_contract inside)
 * @param {Array<{path, base64, mimeType, candidateIndex}>} opts.candidates - rendered candidates
 * @param {object|null} [opts.direction]
 * @param {Array} opts.bookPack - reference pack (for the repair wave)
 * @param {object|null} [opts.plate]
 * @param {object|null} [opts.propPlate] - locked recurring-prop designs plate (repair wave renders)
 * @param {Array} opts.referenceImages - approved reference art for likeness judging
 *   (model sheet + cover — NOT the raw photos; the parent approved the cover character)
 * @param {string} opts.briefText
 * @param {string} [opts.wardrobeNote]
 * @param {object} [opts.qaTagCounts] - mutable telemetry counters
 * @param {AbortSignal} [opts.abortSignal]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ selected: object|null, evaluations: object[], repairWaves: number, allCandidates: object[] }>}
 */
async function selectSpreadWinner({
  bookId, spread, candidates, direction = null, bookPack, plate = null, propPlate = null,
  referenceImages, briefText, wardrobeNote, textLayout = 'caption', qaTagCounts, abortSignal, log = () => {},
}) {
  // Every caller passes the bookPack (model sheet + cover) as the likeness
  // references; if a call site drifts and omits referenceImages, degrade
  // LOUDLY to the bookPack instead of crashing mid-QA after full render
  // spend (`...referenceImages` in the likeness judge is not iterable).
  if (!Array.isArray(referenceImages)) {
    log(`spread ${spread.spread}: referenceImages missing — falling back to bookPack refs`);
    referenceImages = Array.isArray(bookPack) ? bookPack : [];
  }
  const sceneContract = spread.scene_contract || {};
  let allCandidates = [...candidates];
  let evaluations = [];
  let repairWaves = 0;

  // Caption text + wide-render flag flow to the judge: the count rule reads
  // the printed text; the fold classes apply only to embedded wide art.
  const captionText = spread.text || null;
  const wideSpread = textLayout === 'embedded';

  for (let wave = 0; wave <= REPAIR_WAVES_PER_SPREAD; wave += 1) {
    const fresh = allCandidates.filter((c) => !evaluations.some((e) => e.candidateIndex === c.candidateIndex));
    for (const candidate of fresh) {
      const record = await evaluateCandidate({ candidate, sceneContract, direction, referenceImages, captionText, wideSpread, abortSignal, qaTagCounts, log });
      evaluations.push(record);
      log(`spread ${spread.spread} c${candidate.candidateIndex}: ${record.pass ? 'PASS' : `fail@${record.stage}`}${record.likeness ? ` likeness=${record.likeness}` : ''}${record.defects.length ? ` [${record.defects[0]}]` : ''}`);
    }

    const winner = pickWinner(evaluations);
    if (winner) {
      return { selected: winner, evaluations, repairWaves, allCandidates };
    }

    if (wave < REPAIR_WAVES_PER_SPREAD) {
      repairWaves += 1;
      const namedDefects = [...new Set(evaluations.flatMap((e) => e.defects))].slice(0, 8);
      log(`spread ${spread.spread}: no candidate passed — repair wave with named defects: ${namedDefects.join('; ') || 'none recorded'}`);
      // Lettering rejections get a SPECIFIC fix instruction — "avoid
      // lettering" is too weak when the scene itself contains a map/note
      // the model keeps writing on.
      const letteringDefects = namedDefects.filter((d) => d.includes('lettering detected'));
      // Likeness color drift (hair→blonde under warm light, fading freckles,
      // lightened skin) gets the same targeted treatment: name the fix, not
      // just the defect — the model sheet's colors are lighting-invariant.
      const colorDriftDefects = namedDefects.filter((d) => /hair|skin|freckle/i.test(d)
        && /colou?r|tone|blonde|golden|lighter|darker|warmer|paler|streak|missing|less prominent/i.test(d));
      // Style breaks (flat/desaturated/line-art drift vs the cover) get the
      // same targeted treatment — the generic "AVOID" line was too weak to
      // steer a renderer that had already drifted off the book's style.
      const styleBreakDefects = namedDefects.filter((d) => /style|flat|desaturat|photoreal|3d render|line[- ]?art|line ?weight|vector/i.test(d));
      const repairSpread = {
        ...spread,
        scene_contract: {
          ...sceneContract,
          continuity_notes: [
            sceneContract.continuity_notes,
            letteringDefects.length
              ? `CRITICAL REPAIR: previous renders contained readable writing (${letteringDefects.join('; ')}). Depict every written artifact (map, note, sign, book) with WORDLESS abstract marks — wavy squiggles, dots, star-glyphs — never letters or numbers.`
              : null,
            colorDriftDefects.length
              ? `CRITICAL REPAIR: previous renders drifted the character's colors (${colorDriftDefects.join('; ')}). Match the MODEL SHEET's hair color, skin tone, and freckles EXACTLY — base colors never change with scene lighting.`
              : null,
            styleBreakDefects.length
              ? `CRITICAL REPAIR: previous renders broke the book's signature style (${styleBreakDefects.join('; ')}). Match the APPROVED COVER reference's rendering style EXACTLY — warm painterly brushwork, rich saturated colors, soft rounded shading, consistent line weight. NOT flat vector, NOT desaturated, NOT thin-line.`
              : null,
            namedDefects.length ? `AVOID these defects from rejected attempts: ${namedDefects.join('; ')}` : null,
          ].filter(Boolean).join(' | '),
        },
      };
      const rendered = await renderSpreadCandidates({
        spread: repairSpread, direction, bookPack, plate, propPlate, briefText, wardrobeNote, textLayout,
        count: CANDIDATES_PER_SPREAD, abortSignal, log,
      });
      const baseIndex = Math.max(0, ...allCandidates.map((c) => c.candidateIndex));
      for (const [i, img] of rendered.entries()) {
        const candidateIndex = baseIndex + i + 1;
        const path = candidatePath(bookId, spread.spread, candidateIndex, 'png', textLayout);
        await uploadBuffer(img.buffer, path, img.mimeType || 'image/png');
        allCandidates.push({ path, base64: img.buffer.toString('base64'), mimeType: img.mimeType || 'image/png', candidateIndex });
      }
    }
  }

  return { selected: null, evaluations, repairWaves, allCandidates };
}

/**
 * Aggregate failed spreads into ONE book-level needs_review payload
 * (spread-level detail rides in defects + candidateUrls).
 *
 * @param {Array<{ spread: number, evaluations: object[], allCandidates: object[] }>} failures
 * @param {(path: string) => string} toUrl - storage path → viewable URL
 * @returns {object} needs_review payload
 */
function buildSpreadQaNeedsReview(failures, toUrl = (p) => p) {
  return buildNeedsReviewPayload({
    stage: 'spreadQa',
    reason: 'spread_qa_exhausted',
    spread: failures[0]?.spread ?? null,
    defects: failures.flatMap((f) => f.evaluations
      .filter((e) => !e.pass)
      .map((e) => `spread ${f.spread} c${e.candidateIndex} [${e.stage}]: ${e.defects[0] || 'below threshold'}`)),
    judgeScores: {
      failedSpreads: failures.map((f) => ({
        spread: f.spread,
        attempts: f.evaluations.map((e) => ({ c: e.candidateIndex, stage: e.stage, likeness: e.likeness ?? null })),
      })),
    },
    candidateUrls: failures.flatMap((f) => f.allCandidates.map((c) => toUrl(c.path))),
  });
}

module.exports = {
  selectSpreadWinner,
  evaluateCandidate,
  buildSpreadQaNeedsReview,
  pickWinner,
  FOLD_BAND_MIN,
  FOLD_BAND_MAX,
  FOLD_SWALLOW_FRAC,
};
