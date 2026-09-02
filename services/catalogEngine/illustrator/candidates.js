/**
 * Candidate promotion (ce-9) — the admin's "use this candidate" operation.
 *
 * A spread that ends `consistency_unresolved` carries its scored candidate
 * renders on the failure callback (children-jobs/{bookId}/ce-renders/…/
 * spread-N.<aspect>.cK.png). Promoting one copies its bytes to the spread's
 * canonical cache key and writes a QA marker that VOUCHES for it as an
 * admin decision (adminPicked), so the next /generate-book dispatch replays
 * it into the PDFs instead of re-rendering. The marker records the current
 * QA_VERSION and the exact bytes' hash like every other marker.
 */

const { downloadBuffer, uploadBuffer } = require('../../gcsStorage');
const { QA_VERSION } = require('../versions');
const { fnv1a } = require('../selection');

const CANDIDATE_KEY_RE = /^children-jobs\/([A-Za-z0-9_-]{1,128})\/ce-renders\/.+\/spread-(\d{1,2})\.[a-z-]+\.c(\d)\.png$/;

/**
 * Validate a candidate storage key belongs to the given book's render
 * namespace and parse its spread number.
 * @param {string} bookId
 * @param {string} key
 * @returns {{spread: number, canonicalKey: string}|null}
 */
function parseCandidateKey(bookId, key) {
  if (typeof key !== 'string') return null;
  const m = key.match(CANDIDATE_KEY_RE);
  if (!m || m[1] !== bookId) return null;
  return { spread: Number(m[2]), canonicalKey: key.replace(/\.c\d\.png$/, '.png') };
}

/**
 * Promote one candidate render to its spread's canonical key.
 * @param {{bookId: string, candidateKey: string, log?: (level: string, msg: string) => void}} p
 * @returns {Promise<{spread: number, storageKey: string, renderHash: string}>}
 */
async function pickCandidate({ bookId, candidateKey, log = () => {} }) {
  const parsed = parseCandidateKey(bookId, candidateKey);
  if (!parsed) {
    const err = new Error('storageKey is not a candidate render of this book');
    err.statusCode = 400;
    throw err;
  }
  const buffer = await downloadBuffer(candidateKey);
  await uploadBuffer(buffer, parsed.canonicalKey, 'image/png');
  const renderHash = fnv1a(buffer.toString('base64')).toString(36);
  await uploadBuffer(
    Buffer.from(JSON.stringify({
      advisories: [{ stage: 'admin', spread: parsed.spread, note: `candidate ${candidateKey.match(/\.c(\d)\.png$/)[1]} picked by an admin` }],
      renderHash,
      qaVersion: QA_VERSION,
      adminPicked: true,
      checkedAt: new Date().toISOString(),
    })),
    `${parsed.canonicalKey}.qa.json`,
    'application/json',
  );
  log('info', `spread ${parsed.spread}: candidate ${candidateKey} promoted to ${parsed.canonicalKey}`);
  return { spread: parsed.spread, storageKey: parsed.canonicalKey, renderHash };
}

module.exports = { pickCandidate, parseCandidateKey };
