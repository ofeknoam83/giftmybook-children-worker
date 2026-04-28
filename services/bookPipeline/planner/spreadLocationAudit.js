/**
 * Deterministic audit: too many spread specs read as same-house interiors
 * (baking-on-couch crawl) → gate failure + spreadSpecs retry with memory.
 */

/** Themes where most spreads may stay cozy/domestic. */
const COZY_DOMESTIC_OK_THEMES = new Set(['bedtime', 'bedtime_wonder']);

/** Used for extra spread-spec retries + parent-day planner nudges (same domestic cap as all themes). */
const PARENT_DAY_THEMES = new Set(['mothers_day', 'fathers_day', 'grandparents_day']);

/** Max spreads that may match domestic interior heuristics (13 total), except cozy bedtime themes. */
const MAX_DOMESTIC_SPREADS_DEFAULT = 5;

/**
 * Interior / realistic-home cues in location + plot + focal text.
 * Avoid bare \bhall\b (town hall, concert hall). Prefer hallway / down the hall.
 */
const DOMESTIC_INTERIOR_RX = /\b(kitchen|oven|stovetop|microwave|fridge|refrigerator|couch|sofa|loveseat|living room|family room|\bden\b|hallway|down the hall|in the hall|master bedroom|bedroom|bathroom|dining room|nursery|playroom|breakfast nook|pantry|laundry room|mudroom|on the rug|countertop|cookie sheet|baking sheet)\b/i;

/**
 * @param {string} theme
 * @returns {number}
 */
function maxDomesticSpreadsAllowed(theme) {
  const t = String(theme || '').toLowerCase();
  if (COZY_DOMESTIC_OK_THEMES.has(t)) return 13;
  return MAX_DOMESTIC_SPREADS_DEFAULT;
}

/**
 * @param {{ location?: string, plotBeat?: string, focalAction?: string }|null} spec
 * @returns {boolean}
 */
function spreadReadsDomestic(spec) {
  if (!spec) return false;
  const blob = [spec.location, spec.plotBeat, spec.focalAction].map(s => String(s || '')).join(' ');
  return DOMESTIC_INTERIOR_RX.test(blob);
}

/**
 * @param {object} doc - book document with spreads[].spec
 * @returns {{ ok: boolean, domesticSpreadNumbers: number[], maxAllowed: number, issues: string[] }}
 */
function auditSpreadSpecsLocationDiversity(doc) {
  const theme = doc?.request?.theme;
  const maxAllowed = maxDomesticSpreadsAllowed(theme);
  const domesticSpreadNumbers = [];
  for (const s of doc.spreads || []) {
    if (spreadReadsDomestic(s.spec)) domesticSpreadNumbers.push(s.spreadNumber);
  }
  if (domesticSpreadNumbers.length <= maxAllowed) {
    return { ok: true, domesticSpreadNumbers, maxAllowed, issues: [] };
  }
  return {
    ok: false,
    domesticSpreadNumbers,
    maxAllowed,
    issues: [
      `Too many home-interior spreads (${domesticSpreadNumbers.length} > ${maxAllowed}): ${domesticSpreadNumbers.join(', ')}. `
      + 'Rewrite those specs to outward, cinematic locations (market, pier, greenhouse, festival, rooftop, trail, harbor, public square, museum atrium, bakery district, etc.) while preserving plot beats, personalization, and continuityAnchors.',
    ],
  };
}

module.exports = {
  auditSpreadSpecsLocationDiversity,
  spreadReadsDomestic,
  maxDomesticSpreadsAllowed,
  COZY_DOMESTIC_OK_THEMES,
  PARENT_DAY_THEMES,
  MAX_DOMESTIC_SPREADS_DEFAULT,
};
