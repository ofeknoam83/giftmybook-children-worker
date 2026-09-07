/**
 * Take-candidate scoring (ab-1, docs/AUDIOBOOK_V2_PLAN.md §4.4) — the
 * illustrator's selection shape (tier first, then score, then the lower
 * index) with a weight table for narration: a blocking defect sinks a
 * candidate below zero, advisories shade, an unchecked candidate ranks
 * below any checked one, and the deterministic signals — word match,
 * duration deviation from the expected read, level outliers, the name
 * heard — are charged linearly so the truest, best-paced take wins
 * between two otherwise-equal ones. Pure.
 */

const { pickBest, compareCandidates, residualBlocking } = require('../illustrator/select');

/** Score weights — documented knobs, not tuned magic. */
const WEIGHTS = Object.freeze({
  base: 100,
  blocking: -120,
  advisory: -10,
  unchecked: -60,
  // × (wordMatch − 1): every missing percent of the manuscript costs 0.6.
  wordMatch: 60,
  // × |ratio − 1| where ratio = measured / expected midpoint: a take at half
  // or double the expected length loses 30 points.
  durationDeviation: -30,
  // × dB beyond the ±2 dB band around the book's median loudness.
  levelDelta: -2,
  nameNotHeard: -25,
  extraWords: -40, // × extraRatio (words heard that are not in the text)
});

/**
 * Score one candidate from its verdict + measurements. Pure.
 * @param {{qa?: {blocking?: string[], advisory?: string[], qaUnavailable?: string|null}, compare?: {wordMatch?: number, nameHeard?: boolean|null, extraRatio?: number}|null, durationRatio?: number|null, levelDeltaDb?: number|null}} c
 * @returns {number}
 */
function scoreTake(c) {
  const qa = (c && c.qa) || { blocking: [], advisory: [] };
  let score = WEIGHTS.base;
  if (qa.qaUnavailable) score += WEIGHTS.unchecked;
  const blocking = Array.isArray(qa.blocking) ? qa.blocking : [];
  const advisory = Array.isArray(qa.advisory) ? qa.advisory : [];
  score += blocking.length * WEIGHTS.blocking;
  score += advisory.length * WEIGHTS.advisory;
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const cmp = (c && c.compare) || null;
  if (cmp) {
    const wm = num(cmp.wordMatch);
    if (wm !== null) score += WEIGHTS.wordMatch * (Math.min(1, wm) - 1);
    if (cmp.nameHeard === false) score += WEIGHTS.nameNotHeard;
    const extra = num(cmp.extraRatio);
    if (extra !== null) score += WEIGHTS.extraWords * Math.max(0, extra);
  }
  const ratio = num(c && c.durationRatio);
  if (ratio !== null && ratio > 0) score += WEIGHTS.durationDeviation * Math.abs(ratio - 1);
  const delta = num(c && c.levelDeltaDb);
  if (delta !== null) score += WEIGHTS.levelDelta * Math.max(0, Math.abs(delta) - 2);
  return Math.round(score * 100) / 100;
}

/**
 * The storage key of one candidate take beside its canonical key.
 * @param {string} canonical `…/chunk{j}.wav`
 * @param {number} k candidate index (1-based)
 * @param {number} [pass] repair pass (0 = base)
 * @returns {string}
 */
function takeCandidateKey(canonical, k, pass = 0) {
  return canonical.replace(/\.wav$/, pass > 0 ? `.r${pass}c${k}.wav` : `.c${k}.wav`);
}

module.exports = { WEIGHTS, scoreTake, takeCandidateKey, pickBest, compareCandidates, residualBlocking };
