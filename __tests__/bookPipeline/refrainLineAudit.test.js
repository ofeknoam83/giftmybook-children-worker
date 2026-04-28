const {
  findCrossSpreadRepeatedLines,
  normalizeRefrainLine,
  countingHookSpamBySpread,
} = require('../../services/bookPipeline/qa/refrainLineAudit');

describe('refrainLineAudit', () => {
  it('finds same normalized line on two spreads', () => {
    const line = 'Warm flour, warm heart, glow bright.';
    const spreads = [
      { spreadNumber: 1, manuscript: { text: `A\nB\n${line}\nD` } },
      { spreadNumber: 5, manuscript: { text: `X\nY\n${line}\nZ` } },
    ];
    const v = findCrossSpreadRepeatedLines(spreads);
    expect(v.length).toBe(1);
    expect(v[0].spreadNumbers).toEqual([1, 5]);
    expect(normalizeRefrainLine(line)).toBe(v[0].normalized);
  });

  it('ignores very short lines', () => {
    const spreads = [
      { spreadNumber: 1, manuscript: { text: 'Hi there\nHi there\nLine three here\nLine four here' } },
      { spreadNumber: 2, manuscript: { text: 'A\nB\nLine three here\nD' } },
    ];
    const v = findCrossSpreadRepeatedLines(spreads);
    expect(v.find(x => x.normalized.includes('hi there'))).toBeUndefined();
  });

  it('countingHookSpamBySpread flags when 3+ spreads use one-two-three', () => {
    const mk = (n) => ({
      spreadNumber: n,
      manuscript: { text: `A high\nB sky\nC try\none, two, three go` },
    });
    const aug = countingHookSpamBySpread([mk(1), mk(2), mk(3)]);
    expect(aug.size).toBe(3);
    expect(aug.get(1).tags).toContain('counting_refrain_spam');
  });

  it('countingHookSpamBySpread is empty when only two spreads count', () => {
    const aug = countingHookSpamBySpread([
      { spreadNumber: 1, manuscript: { text: 'a\nb\nc\none two three' } },
      { spreadNumber: 2, manuscript: { text: 'a\nb\nc\none two three' } },
    ]);
    expect(aug.size).toBe(0);
  });
});
