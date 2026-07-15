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

/** Bump to invalidate every cached kit (prompt/judging changes). */
// ik-2: cover-anchored sheet generation + defect-fed repair wave (2026-07-15)
const KIT_PROMPT_VERSION = 'ik-2';

const KIT_CACHE_PREFIX = 'identity-kit';

/**
 * @param {string[]} photoUrls
 * @returns {string} GCS folder for this kit
 */
function computeKitCacheKey(photoUrls) {
  const photoHash = crypto.createHash('sha256')
    .update((photoUrls || []).map((u) => String(u).trim()).sort().join('|'))
    .digest('hex')
    .slice(0, 24);
  return `${KIT_CACHE_PREFIX}/${photoHash}-${STYLE_VERSION}-${KIT_PROMPT_VERSION}`;
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
