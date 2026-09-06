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

describe('ce-16: the measured text size shades selection — the smaller painted block wins between equals', () => {
  const { scoreCandidate, pickBest, WEIGHTS } = require('../../../services/catalogEngine/illustrator/select');
  const clean = (k, textSizeRatio) => ({ k, qa: { pass: true, blocking: [], advisory: [], textSizeRatio }, metrics: null });

  test('excess over the footprint costs points; at or under the footprint costs nothing', () => {
    const on = { ...clean(1, 1.0), score: 0 };
    on.score = scoreCandidate(on);
    const under = { ...clean(2, 0.8), score: 0 };
    under.score = scoreCandidate(under);
    const over = { ...clean(3, 1.25), score: 0 };
    over.score = scoreCandidate(over);
    expect(on.score).toBe(WEIGHTS.base);
    expect(under.score).toBe(WEIGHTS.base);
    expect(over.score).toBeCloseTo(WEIGHTS.base + WEIGHTS.textSizeExcess * 0.25, 5);
    expect(pickBest([over, on]).k).toBe(1);
    // No ratio (caption layout, no bbox) — the score is untouched.
    const none = { ...clean(4, null), score: 0 };
    expect(scoreCandidate(none)).toBe(WEIGHTS.base);
  });
});

describe('small first-page typography references', () => {
  const { typographyAnchorRejection } = require('../../../services/catalogEngine/illustrator/select');
  test.each([null, undefined, 0, NaN, Infinity, 1.6, 2, 3])('does not copy unverified or oversized text (%s), while the illustration stays shippable', size => {
    const verdict = qa([], [], { textSizeRatio: size });
    expect(typographyAnchorRejection(verdict)).not.toBeNull();
    expect(isClean({ qa: verdict })).toBe(true);
  });
  test.each([0.8, 1, 1.5])('accepts a measured small reference with normal tolerance (%s)', size => {
    expect(typographyAnchorRejection(qa([], [], { textSizeRatio: size }))).toBeNull();
  });
  test('size does not excuse unverified or inconsistent typography', () => {
    expect(typographyAnchorRejection(qa([], [], { textSizeRatio: 1, qaUnavailable: 'offline' }))).not.toBeNull();
    expect(typographyAnchorRejection(qa([], ['embedded story text mixes fonts, sizes, or colors'], { textSizeRatio: 1 }))).not.toBeNull();
  });
  test('prefers a usable reference only on the first page, without overriding blocking defects or existing scores when none qualify', () => {
    const big = { k: 1, score: 90, qa: qa([], [], { textSizeRatio: 1.8 }) };
    const small = { k: 2, score: 80, qa: qa([], [], { textSizeRatio: 1.1 }) };
    const defective = { k: 3, score: 100, qa: qa(['identity break'], [], { textSizeRatio: 1 }) };
    const unknown = { k: 4, score: 85, qa: qa() };
    expect(pickBest([big, small])).toBe(big);
    expect(pickBest([big, small, defective], { preferTypographyAnchor: true })).toBe(small);
    expect(pickBest([big, defective], { preferTypographyAnchor: true })).toBe(big);
    expect(pickBest([big, unknown], { preferTypographyAnchor: true })).toBe(big);
    expect(compareCandidates(big, small, { preferTypographyAnchor: true })).toBeLessThan(0);
  });
});

describe('ce-18: the measured ink ΔE shades selection — the closest-to-spec render wins', () => {
  const { scoreCandidate, pickBest, WEIGHTS } = require('../../../services/catalogEngine/illustrator/select');
  const withInk = (k, deltaE) => ({ k, qa: { pass: true, blocking: [], advisory: [], textInk: deltaE == null ? null : { hex: '#2a1c12', deltaE } }, metrics: null });

  test('drift costs points in proportion; an exact match and an unmeasured block cost nothing', () => {
    const exact = { ...withInk(1, 0) };
    exact.score = scoreCandidate(exact);
    const drifted = { ...withInk(2, 12) };
    drifted.score = scoreCandidate(drifted);
    const unmeasured = { ...withInk(3, null) };
    unmeasured.score = scoreCandidate(unmeasured);
    expect(exact.score).toBe(WEIGHTS.base);
    expect(unmeasured.score).toBe(WEIGHTS.base);
    expect(drifted.score).toBeCloseTo(WEIGHTS.base + WEIGHTS.textInkDelta * 12, 5);
    expect(pickBest([drifted, exact]).k).toBe(1);
  });
});

test('verified words outrank better-looking misspelled and unverified candidates', () => {
  const correct = { k: 1, score: -100, qa: qa(['outfit break: jacket differs'], [], { textVerification: { status: 'verified' } }) };
  const typo = { k: 2, score: 100, qa: qa([], [], { textVerification: { status: 'mismatch' } }) };
  const unread = { k: 3, score: 200, qa: qa([], [], { textVerification: { status: 'unverified' } }) };
  expect(pickBest([unread, typo, correct])).toBe(correct);
  expect(isClean(typo)).toBe(false);
  expect(isClean(unread)).toBe(false);
});
