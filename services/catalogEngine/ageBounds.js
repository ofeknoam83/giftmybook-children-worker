/**
 * Deterministic word-count bounds per age band, with exact-age calibration
 * for the 1–3 band (an age-one story is not a shortened age-three story).
 *
 * The numbers are the machine-checkable half of data/ageEngines.json —
 * kept as structured constants here (the JSON stores the calibration as
 * prose for the prompt); a unit test asserts the two stay consistent.
 */

const BAND_BOUNDS = {
  '1-3': { perSpread: [8, 40], total: [120, 450] },
  '4-5': { perSpread: [40, 70], total: [520, 800] },
  '6-7': { perSpread: [55, 95], total: [700, 1100] },
  '8-10': { perSpread: [75, 120], total: [900, 1450] },
};

/** Exact-age calibration inside the 1–3 band (from ageEngines.json). */
const EXACT_AGE_BOUNDS = {
  1: { perSpread: [8, 25], total: [120, 280] },
  2: { perSpread: [12, 32], total: [160, 360] },
  3: { perSpread: [15, 40], total: [200, 450] },
};

/**
 * Resolve the applicable bounds for a band + exact age.
 * @param {string} ageBand catalog key ('1-3' | '4-5' | '6-7' | '8-10')
 * @param {number} age exact age 1-10
 * @returns {{perSpread: [number, number], total: [number, number]}}
 */
function boundsFor(ageBand, age) {
  if (ageBand === '1-3' && EXACT_AGE_BOUNDS[age]) return EXACT_AGE_BOUNDS[age];
  const bounds = BAND_BOUNDS[ageBand];
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
 * @returns {string[]} errors
 */
function checkAgeBounds(spreads, ageBand, age) {
  const { perSpread, total } = boundsFor(ageBand, age);
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
