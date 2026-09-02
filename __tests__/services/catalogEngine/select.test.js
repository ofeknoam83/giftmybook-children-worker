/**
 * Candidate selection (ce-9) — pure scoring/picking helpers. A blocking
 * defect must always rank below any clean candidate; an unchecked candidate
 * must rank below any checked one; ties are deterministic.
 */

const { WEIGHTS, candidateKey, scoreCandidate, isClean, selectionTier, compareCandidates, pickBest, residualBlocking, hasDriftDefect } = require('../../../services/catalogEngine/illustrator/select');

const qa = (blocking = [], advisory = [], extra = {}) => ({ pass: blocking.length + advisory.length === 0, defects: [...blocking, ...advisory], blocking, advisory, ...extra });

test('candidateKey sits beside the shipped key, never at it', () => {
  expect(candidateKey('children-jobs/b1/ce-renders/ce-9/abc/spread-3.wide.png', 2))
    .toBe('children-jobs/b1/ce-renders/ce-9/abc/spread-3.wide.c2.png');
});

test('a clean candidate outranks one with a blocking defect, which outranks nothing', () => {
  const clean = { k: 1, qa: qa() };
  const broken = { k: 2, qa: qa(['outfit break: bottom differs from the locked outfit spec']) };
  expect(scoreCandidate(clean)).toBe(WEIGHTS.base);
  expect(scoreCandidate(broken)).toBeLessThan(0);
  expect(isClean(clean)).toBe(true);
  expect(isClean(broken)).toBe(false);
});

test('advisory defects lower the score without making the candidate un-shippable', () => {
  const c = { k: 1, qa: qa([], ['emotion mismatch: reads as joy instead of worry']) };
  expect(scoreCandidate(c)).toBe(WEIGHTS.base + WEIGHTS.advisory);
  expect(isClean(c)).toBe(true);
});

test('an unchecked candidate ranks below any checked one, even a defective one', () => {
  const unchecked = { k: 1, qa: { pass: true, defects: [], blocking: [], advisory: [], qaUnavailable: 'HTTP 500' } };
  const advisoryOnly = { k: 2, qa: qa([], ['anatomy defect: hands or fingers', 'stray lettering or signage in the artwork']) };
  expect(scoreCandidate(unchecked)).toBeLessThan(scoreCandidate(advisoryOnly));
  expect(isClean(unchecked)).toBe(false);
});

test('metrics move the score: identity similarity up, colour/bbox misses down', () => {
  const base = { k: 1, qa: qa() };
  const good = { k: 1, qa: qa(), metrics: { identityScore: 0.9 } };
  const bad = { k: 1, qa: qa(), metrics: { identityScore: 0.2, colour: { slots: { bottom: { pass: false }, top: { pass: true } } }, bbox: { safeZoneOk: false, offCenterOk: false, shotSizeOk: null } } };
  expect(scoreCandidate(good)).toBeGreaterThan(scoreCandidate(base));
  expect(scoreCandidate(bad)).toBeLessThan(scoreCandidate(base));
  expect(scoreCandidate(bad)).toBe(WEIGHTS.base + WEIGHTS.identity * (0.2 - 0.5) + WEIGHTS.colourSlotFail + WEIGHTS.safeZoneFail + WEIGHTS.offCenterFail);
});

test('pickBest takes the highest score within a tier and breaks ties on the lower index', () => {
  const a = { k: 1, score: 90, qa: qa() };
  const b = { k: 2, score: 100, qa: qa() };
  const c = { k: 3, score: 100, qa: qa() };
  expect(pickBest([a, b, c])).toBe(b);
  expect(pickBest([c, b])).toBe(b);
  expect(pickBest([])).toBeNull();
  expect(pickBest([null, a])).toBe(a);
});

test('pickBest ranks by TIER first — checked over unchecked, blocking-free over blocking — never by score alone', () => {
  // Seven advisories sink a CLEAN candidate to 30, below a blocking candidate
  // that metrics lifted and below the fixed unchecked score of 40.
  const cleanButPenalized = { k: 3, score: 30, qa: qa([], ['a', 'b', 'c', 'd', 'e', 'f', 'g']) };
  const blockingLifted = { k: 2, score: 60, qa: qa(['duplicated child hero']) };
  const unchecked = { k: 1, score: 40, qa: { pass: true, defects: [], blocking: [], advisory: [], qaUnavailable: 'HTTP 500' } };
  expect(selectionTier(cleanButPenalized)).toBe(0);
  expect(selectionTier(blockingLifted)).toBe(1);
  expect(selectionTier(unchecked)).toBe(2);
  expect(selectionTier({ k: 9, score: 100 })).toBe(2); // no verdict at all = unchecked
  expect(pickBest([unchecked, blockingLifted, cleanButPenalized])).toBe(cleanButPenalized);
  expect(pickBest([unchecked, blockingLifted])).toBe(blockingLifted);
  expect(compareCandidates(cleanButPenalized, blockingLifted)).toBeGreaterThan(0);
  expect(compareCandidates(unchecked, blockingLifted)).toBeLessThan(0);
  expect(compareCandidates(blockingLifted, { k: 5, score: 61, qa: qa(['child hero missing from the scene']) })).toBeLessThan(0);
  expect(compareCandidates({ k: 1, score: 10, qa: qa() }, { k: 2, score: 10, qa: qa() })).toBe(0);
});

test('residualBlocking and hasDriftDefect read the closed defect vocabulary', () => {
  const best = { qa: qa(['prop missing: "teddy bear"', 'duplicated child hero']) };
  expect(residualBlocking(best)).toEqual(['prop missing: "teddy bear"', 'duplicated child hero']);
  expect(hasDriftDefect(['prop missing: "teddy bear"'])).toBe(true);
  expect(hasDriftDefect(['outfit break: footwear differs from the locked outfit spec'])).toBe(true);
  expect(hasDriftDefect(['identity break: the child does not match the character model sheet'])).toBe(true);
  expect(hasDriftDefect(['duplicated child hero', 'painted text in the illustration'])).toBe(false);
  expect(residualBlocking({ qa: null })).toEqual([]);
});
