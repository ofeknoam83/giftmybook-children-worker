/**
 * Elected audio assets (ab-1, docs/AUDIOBOOK_V2_PLAN.md §3.3, §4.5-4.6):
 * the world-plate pattern for sound. An asset (a music cue, a sound cue,
 * an ambience bed) is generated ONCE from a fixed prompt, N candidates
 * judged + measured, the best written CREATE-IF-ABSENT under
 * `catalog-assets/…/{AUDIO_VERSION}/` beside a JSON record — racing
 * instances adopt ONE winner. A failure falls open to a library file
 * (music) or to nothing (a sound cue), never fails a run.
 */

const crypto = require('crypto');
const { uploadBufferIfAbsent, loadJson, downloadBuffer } = require('../../gcsStorage');
const { AUDIO_VERSION } = require('../versions');

const failures = new Map();
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;

/** @param {string} s @returns {string} 8-hex prompt hash */
function promptHash(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
}

/** @param {Buffer} buffer @returns {string} */
function bytesHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

/** @param {string} mimeType @returns {string} */
function extensionFor(mimeType) {
  if (/wav/i.test(mimeType)) return 'wav';
  if (/mpeg|mp3/i.test(mimeType)) return 'mp3';
  if (/ogg|opus/i.test(mimeType)) return 'ogg';
  if (/aac|mp4|m4a/i.test(mimeType)) return 'm4a';
  return 'bin';
}

/**
 * Elect one asset: the pinned record when it exists, else produce,
 * publish create-if-absent, and adopt the winner.
 * @param {object} p
 * @param {string} p.recordKey the JSON record key (`…/{cueId}.json`)
 * @param {string} p.bytesKeyBase the bytes key without extension
 * @param {() => Promise<{buffer: Buffer, mimeType: string, meta: object}|null>} p.produce
 *   produce the winning candidate (null → nothing to elect)
 * @param {(level: string, msg: string) => void} [p.log]
 * @returns {Promise<{record: object|null, created: boolean, cached: boolean}>}
 */
async function electAsset({ recordKey, bytesKeyBase, produce, log = () => {} }) {
  const pinned = await loadJson(recordKey).catch(() => null);
  if (pinned && pinned.storageKey) return { record: pinned, created: false, cached: true };
  const last = failures.get(recordKey);
  if (last && Date.now() - last < FAILURE_COOLDOWN_MS) return { record: null, created: false, cached: false };
  let winner;
  try {
    winner = await produce();
  } catch (err) {
    failures.set(recordKey, Date.now());
    log('warn', `asset ${recordKey}: production failed (${err.message})`);
    return { record: null, created: false, cached: false };
  }
  if (!winner || !winner.buffer) { failures.set(recordKey, Date.now()); return { record: null, created: false, cached: false }; }
  const storageKey = `${bytesKeyBase}.${extensionFor(winner.mimeType)}`;
  const record = { ...winner.meta, storageKey, mimeType: winner.mimeType, hash: bytesHash(winner.buffer), audioVersion: AUDIO_VERSION, createdAt: new Date().toISOString() };
  const bytes = await uploadBufferIfAbsent(winner.buffer, storageKey, winner.mimeType);
  const json = await uploadBufferIfAbsent(Buffer.from(JSON.stringify(record)), recordKey, 'application/json');
  if (!json.created) {
    const other = await loadJson(recordKey).catch(() => null);
    if (other && other.storageKey) { log('info', `asset ${recordKey}: another instance elected first — adopting it`); return { record: other, created: false, cached: true }; }
  }
  log('info', `asset ${recordKey}: elected${bytes.created ? '' : ' (bytes already present)'}`);
  return { record, created: true, cached: false };
}

/**
 * The bytes of an elected record (GCS), cached in-process per key.
 * @param {{storageKey: string}} record
 * @returns {Promise<Buffer>}
 */
const bytesCache = new Map();
async function assetBytes(record) {
  if (bytesCache.has(record.storageKey)) return bytesCache.get(record.storageKey);
  const buffer = await downloadBuffer(record.storageKey);
  if (bytesCache.size > 64) bytesCache.delete(bytesCache.keys().next().value);
  bytesCache.set(record.storageKey, buffer);
  return buffer;
}

/** Test hook. */
function resetAssetCaches() { failures.clear(); bytesCache.clear(); }

module.exports = { promptHash, bytesHash, extensionFor, electAsset, assetBytes, resetAssetCaches, FAILURE_COOLDOWN_MS };
