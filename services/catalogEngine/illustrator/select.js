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
  // ce-16: × max(0, textSizeRatio − 1) — a painted block 1.25× its footprint
  // loses 10 points to an on-footprint one, so between two otherwise-equal
  // candidates the SMALLER text always wins (and, on the anchor page, the
  // whole book then copies the smaller one).
  textSizeExcess: -40,
  // ce-18: × the measured ink ΔE from the book's pinned hex. A wrong-ink
  // candidate is already blocking; this shades the sub-threshold drift so
  // the closest-to-spec render wins between two otherwise-equal ones.
  textInkDelta: -0.8,
};

// Reference eligibility is stricter than shipping. A large or unmeasured
// first page can remain in the book, but must not teach every other page
// to copy its type. The tolerance absorbs rough vision-estimated boxes.
const TEXT_ANCHOR_MAX_SIZE_RATIO = 1.5;
function typographyAnchorRejection(qa) {
  if (!qa || qa.qaUnavailable) return 'text size could not be verified';
  if (qa.textVerification && qa.textVerification.status !== 'verified') return 'painted story spelling is not verified';
  const defects = [...(qa.defects || []), ...(qa.blocking || []), ...(qa.advisory || [])];
  const textDefect = defects.find(d => d.startsWith('embedded story text'));
  if (textDefect) return textDefect;
  if (!Number.isFinite(qa.textSizeRatio) || qa.textSizeRatio <= 0) return 'text size could not be verified';
  if (qa.textSizeRatio > TEXT_ANCHOR_MAX_SIZE_RATIO) return 'text is larger than the reference-size target';
  return null;
}

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
 * @param {{pass: boolean, blocking?: string[], advisory?: string[], defects?: string[], qaUnavailable?: string, textSizeRatio?: number|null, textInk?: {deltaE:number|null}|null}} c.qa
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
  if (typeof qa.textSizeRatio === 'number' && Number.isFinite(qa.textSizeRatio) && qa.textSizeRatio > 1) {
    score += WEIGHTS.textSizeExcess * (qa.textSizeRatio - 1);
  }
  if (qa.textInk && typeof qa.textInk.deltaE === 'number' && Number.isFinite(qa.textInk.deltaE)) {
    score += WEIGHTS.textInkDelta * qa.textInk.deltaE;
  }
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
  return !!qa && (!qa.textVerification || qa.textVerification.status === 'verified') && !qa.qaUnavailable && (!Array.isArray(qa.blocking) || qa.blocking.length === 0);
}

/**
 * The ordering TIER of a candidate — the guarantees the score alone cannot
 * give (metric/advisory penalties add up; the unchecked score is fixed):
 * 0 = checked and blocking-free, 1 = checked with a blocking defect,
 * 2 = unchecked (no verdict, or the checker was unavailable). A lower tier
 * always outranks a higher one; the score orders only WITHIN a tier.
 * @param {{qa?: object}} c
 * @returns {0|1|2}
 */
function selectionTier(c) {
  const qa = c && c.qa;
  if (qa?.textVerification?.status === 'unverified') return 4;
  if (qa?.textVerification?.status === 'mismatch') return 3;
  if (!qa || qa.qaUnavailable) return 2;
  return Array.isArray(qa.blocking) && qa.blocking.length > 0 ? 1 : 0;
}

/**
 * Compare two candidates: positive when `a` ranks above `b`, negative when
 * below, 0 when equal (same tier, same score) — tier first, then score.
 * Index tie-breaks are the picker's business, not the comparison's.
 * @param {{qa?: object, score?: number}} a
 * @param {{qa?: object, score?: number}} b
 * @returns {number}
 */
function compareCandidates(a, b, { preferTypographyAnchor = false } = {}) {
  const ta = selectionTier(a);
  const tb = selectionTier(b);
  if (ta !== tb) return tb - ta;
  // On the first page, prefer a usable small-text reference among otherwise
  // shippable candidates. Never trade away a blocking-free image for size.
  if (preferTypographyAnchor && ta === 0) {
    const ae = typographyAnchorRejection(a.qa) === null;
    const be = typographyAnchorRejection(b.qa) === null;
    if (ae !== be) return ae ? 1 : -1;
  }
  const sa = Number.isFinite(a && a.score) ? a.score : -Infinity;
  const sb = Number.isFinite(b && b.score) ? b.score : -Infinity;
  if (sa === sb) return 0;
  return sa > sb ? 1 : -1;
}

/**
 * Pick the best candidate: checked before unchecked, blocking-free before
 * blocking, then the highest score; ties break on the LOWER index
 * (deterministic). Returns null for an empty list.
 * @param {Array<{k: number, score: number, qa?: object}>} candidates
 * @returns {object|null}
 */
function pickBest(candidates, options) {
  const list = (candidates || []).filter(Boolean);
  if (list.length === 0) return null;
  return list.reduce((best, c) => {
    if (!best) return c;
    const cmp = compareCandidates(c, best, options);
    if (cmp > 0) return c;
    if (cmp === 0 && c.k < best.k) return c;
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

module.exports = { WEIGHTS, candidateKey, scoreCandidate, isClean, selectionTier, compareCandidates, pickBest, residualBlocking, hasDriftDefect, typographyAnchorRejection, TEXT_ANCHOR_MAX_SIZE_RATIO };
