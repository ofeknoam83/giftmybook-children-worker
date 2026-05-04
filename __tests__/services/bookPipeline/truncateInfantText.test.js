const {
  pickInfantCoupletFromText,
  maybeTruncateInfantManuscript,
} = require('../../../services/bookPipeline/writer/truncateInfantText');
const { AGE_BANDS } = require('../../../services/bookPipeline/constants');

describe('pickInfantCoupletFromText (PR E.4)', () => {
  test('returns text unchanged when already 2 lines', () => {
    const text = 'Mama lifts the moon.\nBright as a spoon.';
    expect(pickInfantCoupletFromText(text)).toBe(text);
  });

  test('returns text unchanged when 1 line', () => {
    expect(pickInfantCoupletFromText('Just one line here.')).toBe('Just one line here.');
  });

  test('returns the first AA-rhyming pair from a 4-line spread', () => {
    // Lines 1+2 do NOT rhyme; lines 1+3 DO rhyme (moon / spoon).
    const text = [
      'Mama lifts the moon.',
      'Bright sun says hello.',
      'A bowl, a little spoon.',
      'Cozy pillow.',
    ].join('\n');
    const out = pickInfantCoupletFromText(text);
    expect(out).toBe('Mama lifts the moon.\nA bowl, a little spoon.');
  });

  test('falls back to first two lines when no pair rhymes', () => {
    const text = [
      'Mama lifts the cat.',
      'Bright sun says hello.',
      'A small warm hand.',
      'Cozy quiet day.',
    ].join('\n');
    const out = pickInfantCoupletFromText(text);
    expect(out).toBe('Mama lifts the cat.\nBright sun says hello.');
  });

  test('skips blank lines when counting', () => {
    const text = 'Line one here.\n\n\nLine two later.';
    const out = pickInfantCoupletFromText(text);
    expect(out).toBe('Line one here.\nLine two later.');
  });
});

describe('maybeTruncateInfantManuscript (PR E.4)', () => {
  test('no-op for non-infant bands', () => {
    const m = { text: 'A.\nB.\nC.\nD.', side: 'right' };
    const doc = { request: { ageBand: AGE_BANDS.PB_PRESCHOOL } };
    expect(maybeTruncateInfantManuscript(m, doc)).toBe(m);
  });

  test('no-op for infant when already 2 lines', () => {
    const m = { text: 'A.\nB.', side: 'right' };
    const doc = { request: { ageBand: AGE_BANDS.PB_INFANT } };
    const out = maybeTruncateInfantManuscript(m, doc);
    expect(out.text).toBe('A.\nB.');
  });

  test('truncates infant to 2 lines and preserves other manuscript fields', () => {
    const m = {
      text: 'Mama lifts the moon.\nBright sun says hello.\nA bowl, a little spoon.\nCozy pillow.',
      side: 'left',
      lineBreakHints: ['hint1'],
      personalizationUsed: ['mom_name'],
      writerNotes: 'a note',
    };
    const doc = { request: { ageBand: AGE_BANDS.PB_INFANT } };
    const out = maybeTruncateInfantManuscript(m, doc);
    expect(out.text.split('\n').length).toBe(2);
    expect(out.side).toBe('left');
    expect(out.lineBreakHints).toEqual(['hint1']);
    expect(out.personalizationUsed).toEqual(['mom_name']);
    expect(out.writerNotes).toBe('a note');
  });

  test('handles missing manuscript and missing text gracefully', () => {
    const doc = { request: { ageBand: AGE_BANDS.PB_INFANT } };
    expect(maybeTruncateInfantManuscript(null, doc)).toBe(null);
    const empty = { text: '', side: 'right' };
    expect(maybeTruncateInfantManuscript(empty, doc)).toBe(empty);
  });
});
