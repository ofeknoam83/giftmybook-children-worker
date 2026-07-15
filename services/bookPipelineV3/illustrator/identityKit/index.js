/**
 * Identity kit (A0) — the illustrator's identity ground truth, built once
 * per (photos × style × prompt version) and cached in GCS:
 *
 *   photos → likeness brief → character model sheet (best-of-N,
 *   cross-family likeness-judged vs the APPROVED COVER character) → cached kit
 *
 * The approved cover joins the kit twice: as wardrobe ground truth AND as
 * the sheet-generation reference — it is the one ILLUSTRATION of this
 * child the parent has blessed, so attaching it to generation is
 * PROHIBITED_CONTENT-safe (the raw photos never are). Runs in parallel
 * with the writer (kicked off right after input validation; joined before
 * rendering).
 *
 * Admin resolution: a review resolution `{action: 'pick_sheet',
 * candidateUrl}` (from POST /v3/review/pick-sheet after an
 * identity_kit_exhausted needs_review) bypasses generation + judging and
 * uses the admin-picked candidate as the sheet.
 */

const { downloadPhotoAsBase64 } = require('../../../illustrationGenerator');
const { buildLikenessBrief } = require('./likenessBrief');
const { generateCharacterSheet } = require('./characterSheet');
const { computeKitCacheKey, getCachedKit, setCachedKit } = require('./cache');
const { STYLE_VERSION } = require('../styleBible');

const MAX_KIT_PHOTOS = 3;

/**
 * Build (or fetch) the identity kit for a request.
 *
 * @param {object} opts
 * @param {string[]} opts.photoUrls - child photo URLs (validated upstream)
 * @param {string} opts.ageBand - PB_* band
 * @param {{name?: string, gender?: string}} [opts.childDetails]
 * @param {string} [opts.wardrobeNote] - outfit description from the approved cover
 * @param {string} [opts.coverImageUrl] - approved cover (sheet-generation anchor; download failure degrades to text-only)
 * @param {string} [opts.bookId] - for review-candidate uploads on exhaustion
 * @param {{action?: string, candidateUrl?: string, admin?: string}} [opts.reviewResolution]
 * @param {AbortSignal} [opts.abortSignal]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ sheetUrl: string, sheetPath: string, brief: object, judgeScores: object, cacheKey: string, styleVersion: string, fromCache: boolean, photos: Array<{base64: string, mimeType: string}> }>}
 */
async function buildIdentityKit({
  photoUrls,
  ageBand,
  childDetails = {},
  wardrobeNote = null,
  coverImageUrl = null,
  bookId = null,
  reviewResolution = null,
  abortSignal,
  log = (m) => console.log(`[identityKit] ${m}`),
}) {
  if (!photoUrls || photoUrls.length === 0) {
    throw new Error('buildIdentityKit: at least one child photo URL is required');
  }

  // Photos are needed by callers even on cache hit (the likeness brief is
  // photo-derived), so decode them up front.
  const usableUrls = photoUrls.slice(0, MAX_KIT_PHOTOS);
  const photos = await Promise.all(usableUrls.map((u) => downloadPhotoAsBase64(u)));

  const cacheKey = computeKitCacheKey(usableUrls, coverImageUrl);
  const adminPick = reviewResolution?.action === 'pick_sheet' && reviewResolution.candidateUrl
    ? reviewResolution
    : null;
  if (!adminPick) {
    const cached = await getCachedKit(cacheKey);
    if (cached) {
      return { ...cached, cacheKey, fromCache: true, photos };
    }
  }

  // The approved cover is the identity ground truth: generation anchor AND
  // the likeness-judge reference. A download failure degrades to the
  // photo-referenced path (non-fatal, loud).
  let coverReference = null;
  if (coverImageUrl) {
    coverReference = await downloadPhotoAsBase64(coverImageUrl).catch((err) => {
      log(`approved cover download failed (${err.message}) — falling back to description-only generation + photo-referenced judging`);
      return null;
    });
  }

  log(`building identity kit (band=${ageBand}, photos=${photos.length}, cover=${coverReference ? 'yes' : 'NO'}, style=${STYLE_VERSION}${adminPick ? ', ADMIN PICK' : ''})`);
  const brief = await buildLikenessBrief({ photos, ageBand, childDetails, hasCover: Boolean(coverReference), abortSignal });

  let sheet;
  if (adminPick) {
    // Admin reviewed the rejected candidates and picked one — that human
    // judgment outranks the automated judges. Loud in the logs + scores.
    log(`review resolution pick_sheet by ${adminPick.admin || 'admin'} — using picked candidate as the model sheet (judges bypassed)`);
    const picked = await downloadPhotoAsBase64(adminPick.candidateUrl);
    sheet = {
      sheetBuffer: Buffer.from(picked.base64, 'base64'),
      sheetMime: picked.mimeType || 'image/png',
      judgeScores: { adminPick: true, resolvedBy: adminPick.admin || 'admin' },
      attemptsUsed: 0,
    };
  } else {
    sheet = await generateCharacterSheet({
      photos,
      briefText: brief.briefText,
      wardrobeNote,
      coverReference,
      bookId,
      abortSignal,
      log,
    });
  }

  const stored = await setCachedKit(cacheKey, {
    brief,
    judgeScores: sheet.judgeScores,
    sheetBuffer: sheet.sheetBuffer,
    sheetMime: sheet.sheetMime,
  });

  return {
    // cache write is best-effort; fall back to in-memory fields
    sheetUrl: stored?.sheetUrl || null,
    sheetPath: stored?.sheetPath || null,
    sheetBase64: stored ? undefined : sheet.sheetBuffer.toString('base64'),
    sheetMime: sheet.sheetMime,
    brief,
    judgeScores: sheet.judgeScores,
    cacheKey,
    styleVersion: STYLE_VERSION,
    fromCache: false,
    photos,
  };
}

module.exports = { buildIdentityKit, MAX_KIT_PHOTOS };
