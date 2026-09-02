/**
 * Clip generation (gift video, gv-1 — docs/GIFT_VIDEO_PLAN.md §4.4).
 *
 * For one segment, submit N candidate clips to the provider concurrently,
 * poll each to completion under a per-clip deadline (touching the book
 * context on every tick so the idle watchdog never kills a healthy job),
 * download the finished clip and copy it into GCS at once (vendor URLs
 * expire), and return every candidate's bytes and vendor status. Cache
 * keys follow the render cache's discipline: every scored candidate keeps
 * its OWN bytes (`.cK` for the base pass, `.rPcK` for repair pass P) beside
 * the segment's canonical clip key, so a rejected repair never overwrites
 * better pixels and a failure payload's candidates are exactly what was
 * scored. A vendor moderation refusal is `filtered` — recorded with the
 * vendor's reason, never retried as a transient error.
 */

const { downloadBuffer, uploadBuffer } = require('../../gcsStorage');
const { fnv1a } = require('../selection');
const { VIDEO_VERSION } = require('../versions');
const { clipSecondsFor } = require('./providers/models');
const flags = require('../flags');

/** Root of one book's gift-video namespace. */
function videoBase(bookId) {
  return `children-jobs/${bookId}/gift-video/${VIDEO_VERSION}`;
}

/**
 * Content identity of a clip: provider, model, the brief, the start frame,
 * the references, the requested length and aspect — same inputs, same key.
 * @param {{provider: string, model: string, briefHash: string, startFrameHash: string, referenceHashes: string[], seconds: number, aspect: string}} p
 * @returns {string}
 */
function clipHashFor(p) {
  return fnv1a(JSON.stringify({ v: VIDEO_VERSION, p: p.provider, m: p.model, b: p.briefHash, s: p.startFrameHash, r: p.referenceHashes || [], d: p.seconds, a: p.aspect })).toString(36);
}

/**
 * The canonical (promoted) clip key of one segment.
 * @param {string} bookId
 * @param {number} segmentIndex
 * @param {string} clipHash
 * @returns {string}
 */
function clipKey(bookId, segmentIndex, clipHash) {
  return `${videoBase(bookId)}/clips/s${segmentIndex}-${clipHash}.mp4`;
}

/**
 * Candidate k (1-based) of a pass beside the canonical key.
 * @param {string} canonicalKey
 * @param {number} k
 * @param {number} [pass]
 * @returns {string}
 */
function candidateClipKey(canonicalKey, k, pass = 0) {
  return canonicalKey.replace(/\.mp4$/, pass > 0 ? `.r${pass}c${k}.mp4` : `.c${k}.mp4`);
}

const CLIP_KEY_RE = /^children-jobs\/([A-Za-z0-9_-]{1,128})\/gift-video\/([A-Za-z0-9_.-]+)\/clips\/s(\d{1,2})-([a-z0-9]+)\.((?:r\d{1,2})?c\d)\.mp4$/;

/**
 * Parse a candidate clip key of THIS book (the pick-clip input).
 * @param {string} bookId
 * @param {string} key
 * @returns {{segment: number, clipHash: string, candidate: string, canonicalKey: string, version: string}|null}
 */
function parseCandidateClipKey(bookId, key) {
  if (typeof key !== 'string') return null;
  const m = CLIP_KEY_RE.exec(key);
  if (!m || m[1] !== bookId) return null;
  return { segment: Number(m[3]), clipHash: m[4], candidate: m[5], canonicalKey: key.replace(/\.(?:r\d{1,2})?c\d\.mp4$/, '.mp4'), version: m[2] };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Generate N candidate clips for one segment.
 * @param {object} p
 * @param {string} p.bookId
 * @param {{index: number, requestedSeconds: number}} p.segment
 * @param {object} p.brief from brief.js (base or repair)
 * @param {{url: string, hash: string}} p.startFrame prepared start frame (signed URL + content hash)
 * @param {Array<{kind: string, urls: string[], hash: string}>} p.references reference elements
 * @param {{provider: string, model: string, adapter: object, profile: object}} p.provider
 * @param {string} p.aspect '16:9' | '9:16'
 * @param {number} p.n candidates
 * @param {number} [p.pass] repair pass (0 = base)
 * @param {number|null} [p.seed]
 * @param {string|null} [p.token] request-injected provider token (fallback)
 * @param {object} [p.costTracker]
 * @param {{touch: Function, log: Function, abortSignal?: AbortSignal}} p.ctx
 * @param {number} [p.pollIntervalMs]
 * @param {number} [p.deadlineMs]
 * @param {Function} [p.limit] p-limit instance shared across segments
 * @param {boolean} [p.forceNew] ignore cached candidate bytes
 * @returns {Promise<{clipHash: string, canonicalKey: string, seconds: number, candidates: Array<{k: number, pass: number, storageKey: string, buffer: Buffer|null, status: string, error: string|null, providerJobId: string|null, cached: boolean}>}>}
 */
async function generateCandidates(p) {
  const { provider } = p;
  const seconds = clipSecondsFor(p.segment.requestedSeconds, provider.profile.durations);
  const clipHash = clipHashFor({
    provider: provider.provider, model: provider.model, briefHash: p.brief.hash,
    startFrameHash: p.startFrame.hash, referenceHashes: (p.references || []).map(r => r.hash), seconds, aspect: p.aspect,
  });
  const canonicalKey = clipKey(p.bookId, p.segment.index, clipHash);
  const pass = p.pass || 0;
  const n = Math.max(1, p.n || 1);
  const run = p.limit || ((fn) => fn());
  const pollIntervalMs = p.pollIntervalMs || 10000;
  const deadlineMs = p.deadlineMs || flags.videoClipTimeoutSeconds() * 1000;
  const log = (p.ctx && p.ctx.log) || (() => {});
  const touch = (p.ctx && p.ctx.touch) || (() => {});
  const abortSignal = p.ctx && p.ctx.abortSignal;

  const one = async (k) => {
    const storageKey = candidateClipKey(canonicalKey, k, pass);
    if (!p.forceNew) {
      const cached = await downloadBuffer(storageKey).catch(() => null);
      if (cached && cached.length > 0) {
        log('info', `segment ${p.segment.index}: candidate ${k} (pass ${pass}) replays from ${storageKey}`);
        return { k, pass, storageKey, buffer: cached, status: 'done', error: null, providerJobId: null, cached: true, seconds };
      }
    }
    const input = provider.profile.input({
      brief: p.brief, startFrameUrl: p.startFrame.url, referenceUrls: p.references || [],
      seconds, aspect: p.aspect, seed: Number.isInteger(p.seed) ? p.seed + k + pass * 10 : null,
    }, { elements: flags.videoElementsEnabled() });
    let ref;
    try {
      ref = await provider.adapter.submit({ model: provider.model, input, token: p.token || null });
    } catch (err) {
      // A rejected input or a dead account is a configuration failure, not a
      // bad candidate — surface it as the run's failure so the admin sees it.
      if (err.failureCode === 'video_provider_input_rejected' || err.failureCode === 'video_provider_unavailable') throw err;
      log('warn', `segment ${p.segment.index}: candidate ${k} submit failed (${err.message})`);
      return { k, pass, storageKey, buffer: null, status: 'failed', error: err.message, providerJobId: null, cached: false, seconds };
    }
    const started = Date.now();
    log('info', `segment ${p.segment.index}: candidate ${k} (pass ${pass}) submitted to ${provider.provider} as ${ref.jobId}`);
    while (Date.now() - started < deadlineMs) {
      if (abortSignal && abortSignal.aborted) return { k, pass, storageKey, buffer: null, status: 'failed', error: 'aborted', providerJobId: ref.jobId, cached: false, seconds };
      await sleep(pollIntervalMs);
      touch();
      let r;
      try {
        r = await provider.adapter.poll({ ...ref, token: p.token || null });
      } catch (err) {
        log('warn', `segment ${p.segment.index}: poll of ${ref.jobId} errored (${err.message}) — retrying`);
        continue;
      }
      if (r.status === 'done') {
        let buffer;
        try {
          buffer = await provider.adapter.download(r.videoUrl);
        } catch (err) {
          return { k, pass, storageKey, buffer: null, status: 'failed', error: `download failed: ${err.message}`, providerJobId: ref.jobId, cached: false, seconds };
        }
        if (p.costTracker) p.costTracker.addVideoSeconds(provider.model, seconds);
        try {
          await uploadBuffer(buffer, storageKey, 'video/mp4');
        } catch (err) {
          log('warn', `segment ${p.segment.index}: candidate ${k} upload failed (${err.message}) — bytes kept in memory only`);
        }
        return { k, pass, storageKey, buffer, status: 'done', error: null, providerJobId: ref.jobId, cached: false, seconds };
      }
      if (r.status === 'filtered' || r.status === 'failed') {
        log('warn', `segment ${p.segment.index}: candidate ${k} ${r.status} at the vendor (${r.error})`);
        return { k, pass, storageKey, buffer: null, status: r.status, error: r.error || null, reasons: r.reasons || null, providerJobId: ref.jobId, cached: false, seconds };
      }
    }
    return { k, pass, storageKey, buffer: null, status: 'failed', error: `vendor did not finish within ${Math.round(deadlineMs / 1000)}s`, providerJobId: ref.jobId, cached: false, seconds };
  };

  const candidates = await Promise.all(Array.from({ length: n }, (_, i) => run(() => one(i + 1))));
  return { clipHash, canonicalKey, seconds, candidates };
}

module.exports = { generateCandidates, clipHashFor, clipKey, candidateClipKey, parseCandidateClipKey, videoBase, CLIP_KEY_RE };
