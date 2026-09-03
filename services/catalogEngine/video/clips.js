/**
 * Clip promotion (gift video, gv-1 — docs/GIFT_VIDEO_PLAN.md §4.5): the
 * admin's "use this clip" operation, mirroring illustrator/candidates.js.
 *
 * A film that ends `video_unresolved` carries each unresolved segment's
 * scored candidate clips (`…/clips/s{i}-{hash}.cK.mp4`). Promoting one
 * copies its bytes to the segment's canonical clip key and writes a marker
 * that VOUCHES for it as an admin decision (adminPicked), so the next
 * `/v13/generate-video` dispatch (no forceNew) replays it and only
 * re-stitches.
 */

const { downloadBuffer, uploadBuffer } = require('../../gcsStorage');
const { QA_VERSION } = require('../versions');
const { fnv1a } = require('../selection');
const { parseCandidateClipKey } = require('./generate');

/**
 * Promote one candidate clip to its segment's canonical key.
 * @param {{bookId: string, candidateKey: string, log?: (level: string, msg: string) => void}} p
 * @returns {Promise<{segment: number, storageKey: string, clipHash: string}>}
 */
async function pickClip({ bookId, candidateKey, log = () => {} }) {
  const parsed = parseCandidateClipKey(bookId, candidateKey);
  if (!parsed) {
    const err = new Error('storageKey is not a candidate clip of this book');
    err.statusCode = 400;
    throw err;
  }
  const buffer = await downloadBuffer(candidateKey);
  await uploadBuffer(buffer, parsed.canonicalKey, 'video/mp4');
  const renderHash = fnv1a(buffer.toString('base64')).toString(36);
  await uploadBuffer(
    Buffer.from(JSON.stringify({
      advisories: [{ stage: 'admin', segment: parsed.segment, note: `clip candidate ${parsed.candidate} picked by an admin` }],
      renderHash,
      clipHash: parsed.clipHash,
      qaVersion: QA_VERSION,
      adminPicked: true,
      unresolved: false,
      checkedAt: new Date().toISOString(),
    })),
    `${parsed.canonicalKey}.qa.json`,
    'application/json',
  );
  log('info', `segment ${parsed.segment}: clip ${candidateKey} promoted to ${parsed.canonicalKey}`);
  return { segment: parsed.segment, storageKey: parsed.canonicalKey, clipHash: parsed.clipHash };
}

module.exports = { pickClip };
