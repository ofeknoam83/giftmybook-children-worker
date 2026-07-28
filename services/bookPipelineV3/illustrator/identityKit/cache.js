/**
 * Identity-kit GCS cache (A0) — one kit per (photos × style × prompt
 * version), shared across books and retries so repeat orders and regens
 * never re-spend the sheet generation + likeness judging.
 *
 * Follows faceEngine's appearance-cache pattern: versioned entries,
 * stale-on-version-bump, warn-and-continue on cache infrastructure
 * failures (a broken cache must never fail a book).
 */

const crypto = require('crypto');
const { saveJson, loadJson, uploadBuffer } = require('../../../gcsStorage');
const { STYLE_VERSION } = require('../styleBible');
const { SHEET_RENDERER_MODEL } = require('../config');

/** Bump to invalidate every cached kit (prompt/judging changes). */
// ik-2: cover-anchored sheet generation + defect-fed repair wave (2026-07-15)
// ik-3: likeness judged vs the APPROVED COVER character (not the photo);
//       cover URL joins the cache key — a different cover is a different
//       approved character.
// ik-4: renderer upgraded to the pro image tier — flash-rendered sheets
//       must regenerate (the sheet anchors every spread; a flash sheet
//       under pro spreads reintroduces a quality/style seam).
// 2026-07-28: the RENDERER MODEL joined the cache key itself, so a model
//       flip (env override or a future pro default) invalidates cached
//       sheets automatically — no more "remember to bump to ik-5 when the
//       real pro id lands" footgun. KIT_PROMPT_VERSION now only tracks
//       prompt/judging changes.
const KIT_PROMPT_VERSION = 'ik-4';

const KIT_CACHE_PREFIX = 'identity-kit';

/**
 * @param {string[]} photoUrls
 * @param {string|null} [coverImageUrl] - the approved cover (identity ground truth)
 * @returns {string} GCS folder for this kit
 */
function computeKitCacheKey(photoUrls, coverImageUrl = null) {
  // Signed URLs rotate their query tokens — hash the stable object path only.
  const stable = (u) => String(u).trim().split('?')[0];
  const photoHash = crypto.createHash('sha256')
    .update((photoUrls || []).map(stable).sort().join('|'))
    .digest('hex')
    .slice(0, 24);
  const coverHash = coverImageUrl
    ? `-c${crypto.createHash('sha256').update(stable(coverImageUrl)).digest('hex').slice(0, 12)}`
    : '';
  const modelSlug = String(SHEET_RENDERER_MODEL).replace(/[^a-zA-Z0-9.-]+/g, '_');
  return `${KIT_CACHE_PREFIX}/${photoHash}${coverHash}-${STYLE_VERSION}-${KIT_PROMPT_VERSION}-${modelSlug}`;
}

/**
 * @param {string} cacheKey
 * @returns {Promise<object|null>} cached kit or null (miss/stale/error)
 */
async function getCachedKit(cacheKey) {
  try {
    const data = await loadJson(`${cacheKey}/kit.json`);
    if (data && data.styleVersion === STYLE_VERSION && data.promptVersion === KIT_PROMPT_VERSION) {
      console.log(`[identityKit] cache HIT ${cacheKey}`);
      return data;
    }
    console.log(`[identityKit] cache STALE ${cacheKey}`);
    return null;
  } catch {
    console.log(`[identityKit] cache MISS ${cacheKey}`);
    return null;
  }
}

/**
 * Persist the kit: sheet image + metadata JSON.
 *
 * @param {string} cacheKey
 * @param {{ brief: object, judgeScores: object, sheetBuffer: Buffer, sheetMime: string }} kit
 * @returns {Promise<object|null>} the stored kit record (with sheetUrl) or null on failure
 */
async function setCachedKit(cacheKey, { brief, judgeScores, sheetBuffer, sheetMime }) {
  try {
    const ext = (sheetMime || 'image/png').includes('png') ? 'png' : 'jpg';
    const sheetPath = `${cacheKey}/sheet.${ext}`;
    const sheetUrl = await uploadBuffer(sheetBuffer, sheetPath, sheetMime || 'image/png');
    const record = {
      styleVersion: STYLE_VERSION,
      promptVersion: KIT_PROMPT_VERSION,
      createdAt: new Date().toISOString(),
      brief,
      judgeScores,
      sheetUrl,
      sheetPath,
    };
    await saveJson(record, `${cacheKey}/kit.json`);
    console.log(`[identityKit] cached kit at ${cacheKey}`);
    return record;
  } catch (err) {
    console.warn(`[identityKit] cache write failed (non-fatal): ${err.message}`);
    return null;
  }
}

module.exports = {
  computeKitCacheKey,
  getCachedKit,
  setCachedKit,
  KIT_PROMPT_VERSION,
  KIT_CACHE_PREFIX,
};
