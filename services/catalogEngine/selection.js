/**
 * Deterministic, fit-weighted plot selection (V1.3).
 *
 * Selection is CODE, never a model. Randomness exists only as a seeded
 * tie-break among equally scored books; it must never promote a weak-fit
 * plot above a materially stronger one. The scoring formula is the
 * handoff's, verbatim:
 *
 *   score = 5*primary-interest matches + 3*activity matches
 *         + 2*trait-affinity matches + 2*available Tier-1 slot categories
 *         + 1*available Tier-2 slot categories
 *         - 4*contraindication hits
 *
 * With CATALOG_FIT_RANKING off (or no authored selection profiles), every
 * book scores 0 and the seeded shuffle provides deterministic variety —
 * the V1.1 fallback behavior. Refresh never reselects: the caller persists
 * the result before any generation.
 */

const { eligibleBooks, catalogVersion, renderTitle } = require('./catalog');
const { augmentsFor } = require('./augments');
const { usableDetails, matchKey } = require('./profile');
const flags = require('./flags');
const { SELECTOR_VERSION } = require('./versions');

const TIER1_FIELDS = new Set(['object', 'habit', 'trait', 'interests', 'activities']);
const TIER2_FIELDS = new Set(['food', 'place']);

/** FNV-1a 32-bit hash of a string (stable across runs/platforms). */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 seeded PRNG — deterministic tie-break shuffles. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic Fisher-Yates with a seeded PRNG. */
function seededShuffle(items, rand) {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Fill the slate from score groups in STRICT descending-score order —
 * archetype diversity reorders picks only WITHIN an equal-score group, and
 * a group is exhausted before any lower-scoring book is considered
 * (per the runtime contract: randomness/diversity break ties only; they
 * must never promote a weaker-fit plot above a materially stronger one).
 * @param {Array<Array<{book: object}>>} groups rows grouped by score, descending
 * @param {number} count
 * @returns {object[]} picked rows
 */
function pickSlate(groups, count) {
  const picked = [];
  const usedArchetypes = new Set();
  for (const group of groups) {
    const remaining = [...group];
    while (remaining.length > 0 && picked.length < count) {
      const idx = remaining.findIndex(row => !usedArchetypes.has(row.book.archetype));
      const row = remaining.splice(idx >= 0 ? idx : 0, 1)[0];
      picked.push(row);
      usedArchetypes.add(row.book.archetype);
    }
    if (picked.length >= count) break;
  }
  return picked;
}

/**
 * Score one book against a normalized profile using its authored
 * selection profile + map. Returns 0 with empty matches when the book has
 * no authored selection profile.
 * @param {object} profile normalized profile
 * @param {object} book catalog definition
 * @returns {{score: number, matchedTags: string[], contraindicated: string[]}}
 */
function scoreBook(profile, book) {
  const { selectionProfile, personalizationMap } = augmentsFor(book.id);
  if (!selectionProfile) return { score: 0, matchedTags: [], contraindicated: [] };

  const interestKeys = new Set(profile.interests.map(matchKey));
  const activityKeys = new Set(profile.activities.map(matchKey));
  const traitKey = profile.trait ? matchKey(profile.trait) : null;
  const allDetailKeys = new Set(usableDetails(profile).map(d => d.key));

  const matchedTags = [];
  let score = 0;
  for (const tag of selectionProfile.primary_tags) {
    if (interestKeys.has(matchKey(tag))) { score += 5; matchedTags.push(`interest:${tag}`); }
  }
  for (const tag of selectionProfile.activity_tags) {
    if (activityKeys.has(matchKey(tag))) { score += 3; matchedTags.push(`activity:${tag}`); }
  }
  for (const tag of selectionProfile.trait_affinities) {
    if (traitKey && traitKey === matchKey(tag)) { score += 2; matchedTags.push(`trait:${tag}`); }
  }

  // Slot-category availability: distinct profile fields that (a) the child
  // actually supplied and (b) at least one approved map slot accepts.
  if (personalizationMap) {
    const suppliedFields = new Set(usableDetails(profile).map(d => d.field));
    const slotFields = new Set();
    for (const slot of personalizationMap.slots) {
      for (const f of slot.allowed_profile_fields) slotFields.add(f);
    }
    for (const f of slotFields) {
      if (!suppliedFields.has(f)) continue;
      if (TIER1_FIELDS.has(f)) score += 2;
      else if (TIER2_FIELDS.has(f)) score += 1;
    }
  }

  const contraindicated = [];
  for (const tag of selectionProfile.contraindications) {
    if (allDetailKeys.has(matchKey(tag))) { score -= 4; contraindicated.push(tag); }
  }
  return { score, matchedTags, contraindicated };
}

/**
 * Select `count` distinct candidate books for a child.
 *
 * Ordering: score desc, then stable book id asc; ties within a score group
 * are shuffled with the seeded PRNG. Diversity: prefer distinct archetypes
 * (the catalog's plot-family analogue) while filling the slate.
 *
 * @param {object} params
 * @param {object} params.profile normalized profile
 * @param {string} params.themeId catalog theme id
 * @param {string} params.ageBand catalog band key ('1-3' etc.)
 * @param {string} params.sessionId seed component — same session, same slate
 * @param {number} [params.count=3]
 * @returns {{candidates: Array<{bookId, title, premise, archetype, score, matchedTags}>, seed: number, selectorVersion: string, catalogVersion: string, fitRanking: boolean, insufficientFit: boolean, minFitScore: number}}
 */
function selectBooks({ profile, themeId, ageBand, sessionId, count = 3 }) {
  const books = eligibleBooks(themeId, ageBand);
  const fitRanking = flags.fitRankingEnabled();
  const seed = fnv1a(`${sessionId}|${catalogVersion()}|${SELECTOR_VERSION}`);
  const rand = mulberry32(seed);

  const scored = books.map(book => ({
    book,
    ...(fitRanking ? scoreBook(profile, book) : { score: 0, matchedTags: [], contraindicated: [] }),
  }));

  // Group by score, seeded-shuffle within each group, then fill the slate.
  const byScore = new Map();
  for (const row of scored) {
    if (!byScore.has(row.score)) byScore.set(row.score, []);
    byScore.get(row.score).push(row);
  }
  const groups = [...byScore.keys()].sort((a, b) => b - a).map(score =>
    seededShuffle(byScore.get(score).sort((a, b) => (a.book.id < b.book.id ? -1 : 1)), rand));
  const picked = pickSlate(groups, count);

  const minFitScore = Number(process.env.CATALOG_MIN_FIT_SCORE || 3);
  const details = usableDetails(profile);
  // Insufficient-fit is only meaningful when ranking is on AND the child
  // supplied optional details that scored nothing.
  const insufficientFit = fitRanking
    && details.length > 0
    && picked.filter(r => r.score >= minFitScore).length < Math.min(2, count);

  return {
    candidates: picked.map(r => ({
      bookId: r.book.id,
      title: renderTitle(r.book, profile.name),
      premise: r.book.premise,
      archetype: r.book.archetype,
      score: r.score,
      matchedTags: r.matchedTags,
      contraindicated: r.contraindicated,
    })),
    seed,
    selectorVersion: SELECTOR_VERSION,
    catalogVersion: catalogVersion(),
    fitRanking,
    insufficientFit,
    minFitScore,
  };
}

module.exports = { selectBooks, scoreBook, pickSlate, fnv1a, mulberry32, seededShuffle };
