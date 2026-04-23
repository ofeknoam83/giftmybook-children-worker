/**
 * Unit tests for hasDuplicatedCaption (mirror-caption / doubled OCR) — no live API.
 */

const { hasDuplicatedCaption, evaluateOcrResult } = require('../../../services/illustrator/textQa');

describe('hasDuplicatedCaption', () => {
  test('returns true when ≥50% of manuscript tokens appear exactly 2× in OCR', () => {
    const expected = 'the cat sat on the mat';
    const ocr = `${expected} ${expected}`;
    expect(hasDuplicatedCaption(expected, ocr)).toBe(true);
  });

  test('returns false for a normal single-rendered caption', () => {
    const expected = 'the cat sat on the mat';
    expect(hasDuplicatedCaption(expected, expected)).toBe(false);
  });

  test('returns false when manuscript has fewer than 3 unique tokens', () => {
    const expected = 'hi there';
    const ocr = `${expected} ${expected}`;
    expect(hasDuplicatedCaption(expected, ocr)).toBe(false);
  });
});

describe('evaluateOcrResult — text_duplicated_caption', () => {
  test('emits text_duplicated_caption when ocrText contains doubled caption but active side matches once', () => {
    const expectedText = 'the cat sat on the mat';
    const doubled = `${expectedText} ${expectedText}`;
    const parsed = {
      ocrText: doubled,
      leftText: expectedText,
      rightText: '',
      centerText: '',
      crossesMidline: false,
      textOnBothSides: false,
      fontLooksPlainBookSerif: true,
    };
    const r = evaluateOcrResult(parsed, {
      expectedText,
      expectedSide: 'left',
      anyExpected: true,
    });
    expect(r.tags).toContain('text_duplicated_caption');
    expect(r.pass).toBe(false);
  });
});
