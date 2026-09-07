/**
 * Coloring-page keys and the admin's "use this candidate" operation (cb-1,
 * docs/COLORING_BOOK_V2_PLAN.md §4.9, §5.2) — the illustrator's
 * candidates.js pattern.
 *
 * A book that ends `coloring_unresolved` carries each unresolved page's
 * scored candidates (`…/page-{i}.c{k}.png`, repair pass P as
 * `…/page-{i}.r{P}c{k}.png`). Promoting one copies its bytes to the page's
 * canonical key and writes a marker that VOUCHES for it as an admin decision
 * (adminPicked), so the next `/v13/generate-coloring-book` dispatch (no
 * forceNew) replays it into the PDFs.
 */

const { downloadBuffer, uploadBuffer } = require('../../gcsStorage');
const { COLORING_VERSION, COLORING_QA_VERSION } = require('../versions');
const { fnv1a } = require('../selection');

const CANDIDATE_KEY_RE = /^children-jobs\/([A-Za-z0-9_-]{1,128})\/coloring\/([A-Za-z0-9_.+-]{1,64})\/([a-z0-9]{1,32})\/page-(\d{1,2})\.(?:r(\d{1,2}))?c(\d)\.png$/;

/**
 * The book's cache base for one plan.
 * @param {string} bookId @param {string} planHash @returns {string}
 */
function coloringBase(bookId, planHash) {
  return `children-jobs/${bookId}/coloring/${COLORING_VERSION}/${planHash}`;
}

/**
 * The canonical key of one page.
 * @param {string} bookId @param {string} planHash @param {number} index @returns {string}
 */
function pageKey(bookId, planHash, index) {
  return `${coloringBase(bookId, planHash)}/page-${index}.png`;
}

/**
 * Parse a candidate key of THIS book.
 * @param {string} bookId
 * @param {string} key
 * @returns {{page: number, canonicalKey: string, candidate: number, pass: number}|null}
 */
function parseColoringCandidateKey(bookId, key) {
  if (typeof key !== 'string' || key.includes('..')) return null;
  const m = CANDIDATE_KEY_RE.exec(key);
  if (!m || m[1] !== bookId) return null;
  return { page: Number(m[4]), canonicalKey: key.replace(/\.(?:r\d{1,2})?c\d\.png$/, '.png'), candidate: Number(m[6]), pass: m[5] ? Number(m[5]) : 0 };
}

/**
 * Content fingerprint of page bytes (the marker's `renderHash`).
 * @param {Buffer} buffer @returns {string}
 */
function contentHash(buffer) {
  return fnv1a(buffer.toString('base64')).toString(36);
}

/**
 * Promote one candidate page to its canonical key with an admin-vouched marker.
 * @param {{bookId: string, candidateKey: string, log?: (level: string, msg: string) => void}} p
 * @returns {Promise<{page: number, storageKey: string, renderHash: string}>}
 */
async function pickColoringCandidate({ bookId, candidateKey, log = () => {} }) {
  const parsed = parseColoringCandidateKey(bookId, candidateKey);
  if (!parsed) {
    const err = new Error('storageKey is not a candidate coloring page of this book');
    err.statusCode = 400;
    throw err;
  }
  const buffer = await downloadBuffer(candidateKey);
  await uploadBuffer(buffer, parsed.canonicalKey, 'image/png');
  const renderHash = contentHash(buffer);
  await uploadBuffer(Buffer.from(JSON.stringify({
    coloringQaVersion: COLORING_QA_VERSION,
    coloringVersion: COLORING_VERSION,
    renderHash,
    adminPicked: true,
    unresolved: false,
    qa: { blocking: [], advisory: [], qaUnavailable: null },
    advisories: [{ stage: 'admin', page: parsed.page, note: `candidate ${parsed.candidate}${parsed.pass ? ` (repair ${parsed.pass})` : ''} picked by an admin` }],
    candidate: candidateKey,
    checkedAt: new Date().toISOString(),
  })), `${parsed.canonicalKey}.qa.json`, 'application/json');
  log('info', `page ${parsed.page}: candidate ${candidateKey} promoted to ${parsed.canonicalKey}`);
  return { page: parsed.page, storageKey: parsed.canonicalKey, renderHash };
}

module.exports = { CANDIDATE_KEY_RE, coloringBase, pageKey, parseColoringCandidateKey, contentHash, pickColoringCandidate };
