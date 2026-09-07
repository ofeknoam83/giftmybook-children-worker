/**
 * Coloring-page candidate scoring (cb-1) — the illustrator's selection
 * shape (illustrator/select.js: tier first, then score, then the lower
 * index) with a weight table for line art: a blocking defect sinks a
 * candidate below zero, advisories shade, an unchecked candidate ranks
 * below any checked one, and the two deterministic measures that decide
 * "looks like one artist drew it" — grey mass and stroke-weight deviation
 * from the band's spec — are charged linearly so the cleaner, on-spec page
 * wins between two otherwise-equal ones. Pure.
 */

const { pickBest, compareCandidates, residualBlocking, candidateKey } = require('../illustrator/select');

/** Score weights — documented knobs, not tuned magic. */
const WEIGHTS = Object.freeze({
  base: 100,
  blocking: -120,
  advisory: -10,
  unchecked: -60,
  // × grayRatio (0-1): 3% grey costs 9 points — anti-aliasing alone is ~1-3%.
  grayRatio: -300,
  // × |strokeRatio − 1| where strokeRatio = measured / band target: a page
  // drawn at half or double the spec weight loses 20 points.
  strokeDeviation: -20,
  // × max(0, inkRatio − inkMax) and × max(0, inkMin − inkRatio): out-of-band
  // ink density (too dense / too sparse) shades even below the defect line.
  inkOutOfBand: -200,
  // A speck-free page is worth a little: × specks/1000 (metrics.js despeckle count).
  specks: -0.01,
});

/**
 * Score one candidate from its verdict + metrics. Pure.
 * @param {{qa?: {pass?: boolean, blocking?: string[], advisory?: string[], qaUnavailable?: string}, metrics?: {grayRatio?: number|null, strokeRatio?: number|null, inkRatio?: number|null, inkMin?: number, inkMax?: number, specks?: number|null}|null}} c
 * @returns {number}
 */
function scoreColoringCandidate(c) {
  const qa = (c && c.qa) || { pass: false, blocking: [], advisory: [] };
  let score = WEIGHTS.base;
  if (qa.qaUnavailable) return score + WEIGHTS.unchecked;
  const blocking = Array.isArray(qa.blocking) ? qa.blocking : [];
  const advisory = Array.isArray(qa.advisory) ? qa.advisory : [];
  score += blocking.length * WEIGHTS.blocking;
  score += advisory.length * WEIGHTS.advisory;
  const m = (c && c.metrics) || {};
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const gray = num(m.grayRatio);
  if (gray !== null) score += WEIGHTS.grayRatio * Math.max(0, gray);
  const strokeRatio = num(m.strokeRatio);
  if (strokeRatio !== null && strokeRatio > 0) score += WEIGHTS.strokeDeviation * Math.abs(strokeRatio - 1);
  const ink = num(m.inkRatio);
  const inkMin = num(m.inkMin);
  const inkMax = num(m.inkMax);
  if (ink !== null) {
    if (inkMax !== null && ink > inkMax) score += WEIGHTS.inkOutOfBand * (ink - inkMax);
    if (inkMin !== null && ink < inkMin) score += WEIGHTS.inkOutOfBand * (inkMin - ink);
  }
  const specks = num(m.specks);
  if (specks !== null) score += WEIGHTS.specks * Math.max(0, specks);
  return Math.round(score * 100) / 100;
}

module.exports = { WEIGHTS, scoreColoringCandidate, pickBest, compareCandidates, residualBlocking, candidateKey };
