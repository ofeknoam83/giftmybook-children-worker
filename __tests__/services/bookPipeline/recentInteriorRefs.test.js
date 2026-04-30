'use strict';

const { pickRecentInteriorRefsForQa } = require('../../../services/bookPipeline/qa/recentInteriorRefs');

describe('pickRecentInteriorRefsForQa', () => {
  test('returns tail by index, excludes current spreads, caps count', () => {
    const accepted = [
      { index: 0, imageBase64: 'x'.repeat(120) },
      { index: 1, imageBase64: 'y'.repeat(120) },
      { index: 2, imageBase64: 'z'.repeat(120) },
      { index: 3, imageBase64: 'w'.repeat(120) },
    ];
    const out = pickRecentInteriorRefsForQa(accepted, [3], 2);
    expect(out).toHaveLength(2);
    expect(out.map(r => r.spreadNumber)).toEqual([2, 3]);
    expect(out.every(r => r.mimeType === 'image/jpeg')).toBe(true);
  });

  test('excludes both spreads in a quad pair', () => {
    const accepted = [
      { index: 4, imageBase64: 'a'.repeat(120) },
      { index: 5, imageBase64: 'b'.repeat(120) },
      { index: 6, imageBase64: 'c'.repeat(120) },
    ];
    const out = pickRecentInteriorRefsForQa(accepted, [5, 6], 3);
    expect(out.map(r => r.spreadNumber)).toEqual([5]);
  });
});
