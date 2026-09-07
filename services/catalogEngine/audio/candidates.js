/**
 * Take keys and the admin's "use this take" operation (ab-1,
 * docs/AUDIOBOOK_V2_PLAN.md §5.2) — the illustrator's candidates.js pattern.
 *
 * A book that ends `audiobook_unresolved` carries each unresolved chunk's
 * scored candidates (`…/chunk{j}.c{k}.wav`, repair pass P as
 * `…/chunk{j}.r{P}c{k}.wav`). Promoting one copies its bytes to the chunk's
 * canonical key and writes a marker that VOUCHES for it as an admin
 * decision (adminPicked), so the next `/v13/generate-audiobook` dispatch
 * (no forceNew) replays it into the mix.
 */

const { downloadBuffer, uploadBuffer } = require('../../gcsStorage');
const { AUDIO_VERSION, AUDIO_QA_VERSION } = require('../versions');
const { measureTake } = require('./metrics');
const { contentHash } = require('./narrate');

const CANDIDATE_KEY_RE = /^children-jobs\/([A-Za-z0-9_-]{1,128})\/audiobook\/([A-Za-z0-9_.+-]{1,64})\/takes\/([0-9a-f]{16})\/chunk(\d{1,2})\.(?:retry-[0-9a-f]{16}\.)?(?:r(\d{1,2}))?c(\d)\.wav$/;

/**
 * Parse a candidate take key of THIS book.
 * @param {string} bookId
 * @param {string} key
 * @returns {{takeHash: string, chunk: number, canonicalKey: string, candidate: number, pass: number}|null}
 */
function parseTakeCandidateKey(bookId, key) {
  if (typeof key !== 'string' || key.includes('..')) return null;
  const m = CANDIDATE_KEY_RE.exec(key);
  if (!m || m[1] !== bookId) return null;
  return { takeHash: m[3], chunk: Number(m[4]), canonicalKey: key.replace(/\.(?:retry-[0-9a-f]{16}\.)?(?:r\d{1,2})?c\d\.wav$/, '.wav'), candidate: Number(m[6]), pass: m[5] ? Number(m[5]) : 0 };
}

/**
 * Promote one candidate take to its canonical key with an admin-vouched marker.
 * @param {{bookId: string, candidateKey: string, log?: (level: string, msg: string) => void}} p
 * @returns {Promise<{chunk: number, takeHash: string, storageKey: string, renderHash: string, seconds: number}>}
 */
async function pickTake({ bookId, candidateKey, log = () => {} }) {
  const parsed = parseTakeCandidateKey(bookId, candidateKey);
  if (!parsed) {
    const err = new Error('storageKey is not a candidate take of this book');
    err.statusCode = 400;
    throw err;
  }
  const buffer = await downloadBuffer(candidateKey);
  let measure;
  try {
    const m = measureTake(buffer);
    measure = { seconds: m.seconds, trim: m.trim, trimmedSeconds: m.trimmedSeconds, lufs: m.lufs, peakDb: m.peakDb, truePeakDb: m.truePeakDb, longestSilenceSeconds: m.longestSilenceSeconds, sampleRate: m.sampleRate };
  } catch (err) {
    const e = new Error(`the candidate is not a readable WAV (${err.message})`);
    e.statusCode = 400;
    throw e;
  }
  await uploadBuffer(buffer, parsed.canonicalKey, 'audio/wav');
  const renderHash = contentHash(buffer);
  await uploadBuffer(Buffer.from(JSON.stringify({
    audioQaVersion: AUDIO_QA_VERSION, audioVersion: AUDIO_VERSION, takeHash: parsed.takeHash, renderHash, measure,
    adminPicked: true, unresolved: false, qa: { blocking: [], advisory: [], qaUnavailable: null },
    advisories: [{ stage: 'admin', note: `candidate ${parsed.candidate}${parsed.pass ? ` (repair ${parsed.pass})` : ''} of chunk ${parsed.chunk} picked by an admin` }],
    candidate: candidateKey, checkedAt: new Date().toISOString(),
  })), `${parsed.canonicalKey}.qa.json`, 'application/json');
  log('info', `chunk ${parsed.chunk} of take ${parsed.takeHash}: candidate ${candidateKey} promoted to ${parsed.canonicalKey}`);
  return { chunk: parsed.chunk, takeHash: parsed.takeHash, storageKey: parsed.canonicalKey, renderHash, seconds: measure.trimmedSeconds };
}

module.exports = { CANDIDATE_KEY_RE, parseTakeCandidateKey, pickTake };
