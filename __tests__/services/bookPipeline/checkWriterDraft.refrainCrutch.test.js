const {
  findRefrainCrutches,
} = require('../../../services/bookPipeline/qa/checkWriterDraft');

describe('findRefrainCrutches (PR D / D.6)', () => {
  function makeBook(crutchSpreadCount, totalSpreads, crutchWord = 'peekaboo') {
    const spreads = [];
    for (let i = 1; i <= totalSpreads; i++) {
      const text = i <= crutchSpreadCount
        ? `Mama plays ${crutchWord} on the rug.`
        : 'Mama hums a quiet little tune.';
      spreads.push({ spreadNumber: i, manuscript: { text } });
    }
    return spreads;
  }

  test('flags "peekaboo" repeated in 5 of 13 spreads (~38%)', () => {
    const out = findRefrainCrutches(makeBook(5, 13, 'peekaboo'));
    const top = out.find(o => o.word === 'peekaboo');
    expect(top).toBeDefined();
    expect(top.spreadCount).toBe(5);
    expect(top.ratio).toBeGreaterThan(0.25);
  });

  test('does NOT flag a noun appearing in only 2 of 13 spreads (~15%)', () => {
    const out = findRefrainCrutches(makeBook(2, 13, 'peekaboo'));
    expect(out.find(o => o.word === 'peekaboo')).toBeUndefined();
  });

  test('does NOT flag verb-inflected words (those go to verb_crutch)', () => {
    const spreads = [];
    for (let i = 1; i <= 13; i++) {
      spreads.push({ spreadNumber: i, manuscript: { text: 'Baby giggles softly today.' } });
    }
    const out = findRefrainCrutches(spreads);
    // "giggles" ends in -s and should be excluded; the test confirms refrain
    // crutch detector is *not* the place verbs get flagged.
    expect(out.find(o => o.word === 'giggles')).toBeUndefined();
  });

  test('does NOT flag parent-address terms (mama, dada) — they are personalization, not crutches', () => {
    const spreads = [];
    for (let i = 1; i <= 13; i++) {
      spreads.push({ spreadNumber: i, manuscript: { text: 'Mama is here today.' } });
    }
    const out = findRefrainCrutches(spreads);
    expect(out.find(o => o.word === 'mama')).toBeUndefined();
  });

  test('returns empty array for an empty book', () => {
    expect(findRefrainCrutches([])).toEqual([]);
  });

  test('returns empty when crutch appears in fewer than 3 spreads (min spreadCount gate)', () => {
    // Even if 2 of 3 spreads = 67% ratio, requires ≥3 spread occurrences.
    const out = findRefrainCrutches(makeBook(2, 3, 'peekaboo'));
    expect(out.find(o => o.word === 'peekaboo')).toBeUndefined();
  });
});
