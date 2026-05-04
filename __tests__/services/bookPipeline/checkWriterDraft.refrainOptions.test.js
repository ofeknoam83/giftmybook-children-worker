const {
  findRefrainCrutches,
} = require('../../../services/bookPipeline/qa/checkWriterDraft');
const { AGE_BANDS } = require('../../../services/bookPipeline/constants');

describe('findRefrainCrutches options (PR E)', () => {
  function makeBook(crutchSpreadCount, totalSpreads, crutchWord) {
    const spreads = [];
    for (let i = 1; i <= totalSpreads; i++) {
      const text = i <= crutchSpreadCount
        ? `Mama brings ${crutchWord} again.`
        : 'Mama hums a quiet little tune.';
      spreads.push({ spreadNumber: i, manuscript: { text } });
    }
    return spreads;
  }

  test('exposes spreadNumbers on offenders so book-level can become per-spread targets', () => {
    const spreads = makeBook(5, 13, 'peekaboo');
    const out = findRefrainCrutches(spreads);
    const top = out.find(o => o.word === 'peekaboo');
    expect(top).toBeDefined();
    expect(top.spreadNumbers).toEqual([1, 2, 3, 4, 5]);
  });

  test('excludes child name from refrain candidates (was a false positive)', () => {
    const spreads = [];
    // The child's name in 7 of 13 spreads is correct personalization, not a crutch.
    for (let i = 1; i <= 13; i++) {
      const text = i <= 7
        ? 'Everleigh smiles at the moon.'
        : 'Mama hums a quiet little tune.';
      spreads.push({ spreadNumber: i, manuscript: { text } });
    }
    const out = findRefrainCrutches(spreads, {
      brief: { child: { name: 'Everleigh' } },
    });
    expect(out.find(o => o.word === 'everleigh')).toBeUndefined();
  });

  test('infant band uses the tighter 20% threshold', () => {
    // 3 of 13 = 23% — passes the standard 25% threshold but FAILS infant 20%.
    const spreads = makeBook(3, 13, 'sunshine');
    const standard = findRefrainCrutches(spreads);
    expect(standard.find(o => o.word === 'sunshine')).toBeUndefined();

    const infant = findRefrainCrutches(spreads, { ageBand: AGE_BANDS.PB_INFANT });
    const top = infant.find(o => o.word === 'sunshine');
    expect(top).toBeDefined();
    expect(top.spreadCount).toBe(3);
  });

  test('also excludes declared parent address forms from the brief (mom_name)', () => {
    const spreads = [];
    for (let i = 1; i <= 13; i++) {
      const text = i <= 7
        ? 'Courtney lifts the moon high.'
        : 'A quiet little tune again.';
      spreads.push({ spreadNumber: i, manuscript: { text } });
    }
    const out = findRefrainCrutches(spreads, {
      brief: { customDetails: { mom_name: 'Courtney' } },
    });
    expect(out.find(o => o.word === 'courtney')).toBeUndefined();
  });
});
