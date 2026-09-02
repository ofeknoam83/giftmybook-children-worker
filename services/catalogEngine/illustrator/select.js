/**
 * Candidate selection (ce-9) — pure helpers for the N-candidate render.
 *
 * A stateless render is a sample; twelve first-try samples are twelve coin
 * flips. The selection gate renders N candidates per spread, scores each
 * with the structured QA verdict (spreadQa.js v2) plus the deterministic
 * metrics (metrics.js), and ships the BEST — repairs only run when no
 * candidate clears the blocking checks. Everything here is deterministic
 * arithmetic over verdicts; no model output reaches a prompt through it.
 */

/** Score weights — documented knobs, not tuned magic. */
const WEIGHTS = {
  base: 100,
  blocking: -120, // any blocking defect makes the candidate un-shippable (score < 0)
  advisory: -10,
  unchecked: -60, // a candidate the checker could not verify ranks below any checked one
  identity: 40, // × (identityScore - 0.5): a strong sheet match earns up to +20
  colourSlotFail: -15,
  safeZoneFail: -10,
  offCenterFail: -10,
  shotSizeFail: -5,
};

/**
 * Deterministic cache key for candidate k of a spread: beside the shipped
 * key, never at it — the winner is COPIED to the shipped key, so replay,
 * markers, and the world gate keep their single-key contract.
 * @param {string} storageKey the spread's shipped cache key (…/spread-N.wide.png)
 * @param {number} k 1-based candidate index
 * @returns {string}
 */
function candidateKey(storageKey, k, pass = 0) {
  // Every pass keeps its own bytes: `.c{k}` for the base pass, `.r{p}c{k}`
  // for repair pass p — a candidate the failure payload scored must never
  // be overwritten by a later pass (the admin picks what was scored).
  return storageKey.replace(/\.png$/, pass > 0 ? `.r${pass}c${k}.png` : `.c${k}.png`);
}

/**
 * Score one candidate from its verdict + metrics. Pure.
 * @param {object} c
 * @param {{pass: boolean, blocking?: string[], advisory?: string[], defects?: string[], qaUnavailable?: string}} c.qa
 * @param {{identityScore?: number|null, colour?: {slots?: object}|null, bbox?: {safeZoneOk?: boolean, offCenterOk?: boolean|null, shotSizeOk?: boolean|null}|null}|null} [c.metrics]
 * @returns {number}
 */
function scoreCandidate(c) {
  const qa = c.qa || { pass: false, blocking: [], advisory: [] };
  let score = WEIGHTS.base;
  if (qa.qaUnavailable) return score + WEIGHTS.unchecked;
  const blocking = Array.isArray(qa.blocking) ? qa.blocking : [];
  const advisory = Array.isArray(qa.advisory) ? qa.advisory : (Array.isArray(qa.defects) ? qa.defects : []);
  score += blocking.length * WEIGHTS.blocking;
  score += advisory.length * WEIGHTS.advisory;
  const m = c.metrics || {};
  if (typeof m.identityScore === 'number' && Number.isFinite(m.identityScore)) {
    score += WEIGHTS.identity * (m.identityScore - 0.5);
  }
  if (m.colour && m.colour.slots) {
    for (const slot of Object.values(m.colour.slots)) {
      if (slot && slot.pass === false) score += WEIGHTS.colourSlotFail;
    }
  }
  if (m.bbox) {
    if (m.bbox.safeZoneOk === false) score += WEIGHTS.safeZoneFail;
    if (m.bbox.offCenterOk === false) score += WEIGHTS.offCenterFail;
    if (m.bbox.shotSizeOk === false) score += WEIGHTS.shotSizeFail;
  }
  return Math.round(score * 100) / 100;
}

/**
 * Whether a scored candidate is shippable without repair: it was checked
 * and carries no blocking defect. (An UNCHECKED candidate is shippable only
 * when nothing checked exists — the caller decides; see pickBest.)
 * @param {{qa: object}} c
 * @returns {boolean}
 */
function isClean(c) {
  const qa = c && c.qa;
  return !!qa && !qa.qaUnavailable && (!Array.isArray(qa.blocking) || qa.blocking.length === 0);
}

/**
 * Pick the best candidate: highest score; ties break on the LOWER index
 * (deterministic). Returns null for an empty list.
 * @param {Array<{k: number, score: number}>} candidates
 * @returns {object|null}
 */
function pickBest(candidates) {
  const list = (candidates || []).filter(Boolean);
  if (list.length === 0) return null;
  return list.reduce((best, c) => {
    if (!best) return c;
    if (c.score > best.score) return c;
    if (c.score === best.score && c.k < best.k) return c;
    return best;
  }, null);
}

/**
 * The union of blocking defects still standing after selection — what a
 * repair pass must fix, and what the ship policy reports on exhaustion.
 * @param {{qa: object}} best
 * @returns {string[]}
 */
function residualBlocking(best) {
  const qa = best && best.qa;
  return qa && Array.isArray(qa.blocking) ? [...qa.blocking] : [];
}

/**
 * Whether ANY defect in the list is a DRIFT-class defect (identity/outfit/
 * prop/companion) — these draw on the separate drift repair budget.
 * @param {string[]} defects
 * @returns {boolean}
 */
function hasDriftDefect(defects) {
  return (defects || []).some(d => /^(identity break|hair differs|skin tone differs|age or proportions differ|outfit break|prop |companion )/.test(d));
}

module.exports = { WEIGHTS, candidateKey, scoreCandidate, isClean, pickBest, residualBlocking, hasDriftDefect };
