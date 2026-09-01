/**
 * Deterministic word-count bounds per age band, with exact-age calibration
 * for the 1–3 band (an age-one story is not a shortened age-three story).
 *
 * The CURRENT engine's numbers are the machine-checkable half of
 * data/ageEngines.json — kept as structured constants here (the JSON stores
 * the calibration as prose for the prompt); a unit test asserts the two stay
 * consistent.
 *
 * Bounds are VERSIONED by the age engine that generated the story: a stored
 * pair pinned to an older engine keeps re-validating under the bounds it was
 * written to (the same principle as pinned book definitions), while fresh
 * requests pin — and are held to — the current engine's bounds. Bumping
 * AGE_ENGINE_VERSION therefore requires adding a matching table below and
 * keeping the old one.
 */

const { AGE_ENGINE_VERSION } = require('./versions');

const BOUNDS_BY_ENGINE = {
  '1.3.0': {
    bands: {
      '1-3': { perSpread: [8, 40], total: [120, 450] },
      '4-5': { perSpread: [40, 70], total: [520, 800] },
      '6-7': { perSpread: [55, 95], total: [700, 1100] },
      '8-10': { perSpread: [75, 120], total: [900, 1450] },
    },
    exactAges: {
      1: { perSpread: [8, 25], total: [120, 280] },
      2: { perSpread: [12, 32], total: [160, 360] },
      3: { perSpread: [15, 40], total: [200, 450] },
    },
  },
  '1.4.0': {
    bands: {
      '1-3': { perSpread: [8, 30], total: [96, 360] },
      '4-5': { perSpread: [30, 40], total: [360, 480] },
      '6-7': { perSpread: [40, 50], total: [480, 600] },
      '8-10': { perSpread: [50, 60], total: [600, 720] },
    },
    exactAges: {
      1: { perSpread: [8, 20], total: [96, 240] },
      2: { perSpread: [12, 25], total: [144, 300] },
      3: { perSpread: [15, 30], total: [180, 360] },
    },
  },
};

const CURRENT = BOUNDS_BY_ENGINE[AGE_ENGINE_VERSION];
if (!CURRENT) {
  throw new Error(`ageBounds: no bounds table for AGE_ENGINE_VERSION '${AGE_ENGINE_VERSION}' — add it to BOUNDS_BY_ENGINE (and keep the old tables)`);
}

/** The CURRENT engine's band bounds (what fresh generations are held to). */
const BAND_BOUNDS = CURRENT.bands;

/** The CURRENT engine's exact-age calibration inside the 1–3 band. */
const EXACT_AGE_BOUNDS = CURRENT.exactAges;

/**
 * Resolve the applicable bounds for a band + exact age under one engine.
 * @param {string} ageBand catalog key ('1-3' | '4-5' | '6-7' | '8-10')
 * @param {number} age exact age 1-10
 * @param {string} [ageEngineVersion] the pinned versions.age_engine of the
 *   request being validated; omitted or unknown resolves to the CURRENT
 *   engine's bounds (never a silently laxer table)
 * @returns {{perSpread: [number, number], total: [number, number]}}
 */
function boundsFor(ageBand, age, ageEngineVersion) {
  const table = BOUNDS_BY_ENGINE[ageEngineVersion] || CURRENT;
  if (ageBand === '1-3' && table.exactAges[age]) return table.exactAges[age];
  const bounds = table.bands[ageBand];
  if (!bounds) throw new Error(`boundsFor: unknown age band '${ageBand}'`);
  return bounds;
}

/**
 * Count words the way the bounds mean them: whitespace-separated tokens
 * containing at least one letter or digit.
 * @param {string} text
 * @returns {number}
 */
function countWords(text) {
  if (!text) return 0;
  return String(text).split(/\s+/).filter(t => /[\p{L}\p{N}]/u.test(t)).length;
}

/**
 * Validate a 12-spread story against the band/age bounds.
 * @param {Array<{spread: number, text: string}>} spreads
 * @param {string} ageBand
 * @param {number} age
 * @param {string} [ageEngineVersion] pinned engine version of the request
 * @returns {string[]} errors
 */
function checkAgeBounds(spreads, ageBand, age, ageEngineVersion) {
  const { perSpread, total } = boundsFor(ageBand, age, ageEngineVersion);
  const errors = [];
  let totalWords = 0;
  for (const s of spreads) {
    const words = countWords(s.text);
    totalWords += words;
    if (words < perSpread[0] || words > perSpread[1]) {
      errors.push(`spread ${s.spread}: ${words} words, must be ${perSpread[0]}-${perSpread[1]} for age band ${ageBand}${ageBand === '1-3' ? ` (exact age ${age})` : ''}`);
    }
  }
  if (totalWords < total[0] || totalWords > total[1]) {
    errors.push(`total ${totalWords} words, must be ${total[0]}-${total[1]}`);
  }
  return errors;
}

module.exports = { BAND_BOUNDS, EXACT_AGE_BOUNDS, boundsFor, countWords, checkAgeBounds };
