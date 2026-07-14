/**
 * Identity kit (A0) — the illustrator's identity ground truth, built once
 * per (photos × style × prompt version) and cached in GCS:
 *
 *   photos → likeness brief → character model sheet (best-of-N,
 *   cross-family likeness-judged vs the photo) → cached kit
 *
 * The approved cover joins the kit as wardrobe ground truth — it is the
 * one image the parent has blessed. Runs in parallel with the writer
 * (kicked off right after input validation; joined before rendering).
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
 * @param {AbortSignal} [opts.abortSignal]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ sheetUrl: string, sheetPath: string, brief: object, judgeScores: object, cacheKey: string, styleVersion: string, fromCache: boolean, photos: Array<{base64: string, mimeType: string}> }>}
 */
async function buildIdentityKit({
  photoUrls,
  ageBand,
  childDetails = {},
  wardrobeNote = null,
  abortSignal,
  log = (m) => console.log(`[identityKit] ${m}`),
}) {
  if (!photoUrls || photoUrls.length === 0) {
    throw new Error('buildIdentityKit: at least one child photo URL is required');
  }

  // Photos are needed by callers even on cache hit (spread renders attach
  // the best photo beside the sheet), so decode them up front.
  const usableUrls = photoUrls.slice(0, MAX_KIT_PHOTOS);
  const photos = await Promise.all(usableUrls.map((u) => downloadPhotoAsBase64(u)));

  const cacheKey = computeKitCacheKey(usableUrls);
  const cached = await getCachedKit(cacheKey);
  if (cached) {
    return { ...cached, cacheKey, fromCache: true, photos };
  }

  log(`building identity kit (band=${ageBand}, photos=${photos.length}, style=${STYLE_VERSION})`);
  const brief = await buildLikenessBrief({ photos, ageBand, childDetails, abortSignal });
  const sheet = await generateCharacterSheet({
    photos,
    briefText: brief.briefText,
    wardrobeNote,
    abortSignal,
    log,
  });

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
