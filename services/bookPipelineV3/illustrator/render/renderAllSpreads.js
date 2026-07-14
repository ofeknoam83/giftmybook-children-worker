/**
 * Book-wide render fan-out (A2) — every spread renders independently and
 * concurrently through the key pool, bounded by RENDER_CONCURRENCY.
 *
 * Crash-safe resume WITHOUT sessions: every candidate is uploaded to a
 * deterministic GCS path (children-jobs/{bookId}/v3-renders/...) and the
 * fan-out checks for an existing object before re-rendering — a worker
 * killed mid-wave re-renders only the missing candidates on retry.
 */

const { uploadBuffer, downloadBuffer } = require('../../../gcsStorage');
const { renderSpreadCandidates } = require('./renderSpread');
const { CANDIDATES_PER_SPREAD, RENDER_CONCURRENCY } = require('../config');

/** Minimal semaphore — no dependency. */
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active -= 1;
      next();
    });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

function candidatePath(bookId, spreadNumber, candidateIndex, ext = 'png') {
  return `children-jobs/${bookId}/v3-renders/spread-${spreadNumber}-c${candidateIndex}.${ext}`;
}

/**
 * @param {string} bookId
 * @param {number} spreadNumber
 * @returns {Promise<Array<{path: string, base64: string, mimeType: string, candidateIndex: number, reused: true}>>}
 */
async function loadExistingCandidates(bookId, spreadNumber) {
  const found = [];
  for (let i = 1; i <= CANDIDATES_PER_SPREAD; i += 1) {
    try {
      const path = candidatePath(bookId, spreadNumber, i);
      const buf = await downloadBuffer(path);
      found.push({ path, base64: buf.toString('base64'), mimeType: 'image/png', candidateIndex: i, reused: true });
    } catch {
      // missing — will render
    }
  }
  return found;
}

/**
 * Render all spreads' candidates.
 *
 * @param {object} opts
 * @param {string} opts.bookId
 * @param {object[]} opts.spreads - manuscript spreads (spread number + scene_contract)
 * @param {Map<number, object>|null} [opts.directionBySpread] - art-direction rows keyed by spread (W7)
 * @param {Map<string, object>|null} [opts.platesByLocation] - world plates keyed by setting (W8)
 * @param {Array} opts.bookPack - buildBookReferencePack result
 * @param {string} opts.briefText
 * @param {string} [opts.wardrobeNote]
 * @param {AbortSignal} [opts.abortSignal]
 * @param {(msg: string) => void} [opts.log]
 * @param {(done: number, total: number) => void} [opts.onSpreadDone]
 * @returns {Promise<Array<{ spread: number, candidates: Array<{path: string, base64: string, mimeType: string, candidateIndex: number, reused?: boolean}> }>>}
 */
async function renderAllSpreadsNative({
  bookId, spreads, directionBySpread = null, platesByLocation = null,
  bookPack, briefText, wardrobeNote, forceSpreads = new Set(), abortSignal, log = () => {}, onSpreadDone = () => {},
}) {
  if (!bookId) throw new Error('renderAllSpreadsNative: bookId is required');
  const limit = createLimiter(RENDER_CONCURRENCY);
  let done = 0;

  const results = await Promise.all(spreads.map((spread) => limit(async () => {
    // regen_spread resolution: ignore cached candidates, render fresh over them.
    const existing = forceSpreads.has(spread.spread) ? [] : await loadExistingCandidates(bookId, spread.spread);
    if (existing.length >= CANDIDATES_PER_SPREAD) {
      log(`spread ${spread.spread}: reusing ${existing.length} rendered candidate(s) from GCS (resume)`);
      done += 1;
      onSpreadDone(done, spreads.length);
      return { spread: spread.spread, candidates: existing };
    }

    const direction = directionBySpread?.get(spread.spread) || null;
    const plate = platesByLocation?.get(spread.scene_contract?.setting) || null;
    const rendered = await renderSpreadCandidates({
      spread, direction, bookPack, plate, briefText, wardrobeNote, abortSignal, log,
    });

    const candidates = [...existing];
    for (const img of rendered) {
      // Skip indexes that already exist from a previous partial run.
      if (candidates.some((c) => c.candidateIndex === img.candidateIndex)) continue;
      const path = candidatePath(bookId, spread.spread, img.candidateIndex);
      await uploadBuffer(img.buffer, path, img.mimeType || 'image/png');
      candidates.push({
        path,
        base64: img.buffer.toString('base64'),
        mimeType: img.mimeType || 'image/png',
        candidateIndex: img.candidateIndex,
      });
    }
    candidates.sort((a, b) => a.candidateIndex - b.candidateIndex);

    log(`spread ${spread.spread}: ${candidates.length}/${CANDIDATES_PER_SPREAD} candidates ready${existing.length ? ` (${existing.length} reused)` : ''}`);
    done += 1;
    onSpreadDone(done, spreads.length);
    return { spread: spread.spread, candidates };
  })));

  return results.sort((a, b) => a.spread - b.spread);
}

module.exports = { renderAllSpreadsNative, candidatePath, createLimiter, loadExistingCandidates };
