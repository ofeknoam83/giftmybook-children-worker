/**
 * Unit tests for text QA evaluation (typography-tolerant compare) — no live API.
 */

const { evaluateOcrResult, normalizeCaptionForOcrCompare } = require('../../../services/illustrator/textQa');

describe('normalizeCaptionForOcrCompare', () => {
  test('normalizes curly apostrophe and double quotes to ASCII', () => {
    const a = "On porch, Svea claps. Her bell goes jingle on the floor.";
    const b = 'On porch, Svea claps. Her bell goes jingle on the floor.'; // straight
    expect(normalizeCaptionForOcrCompare(a)).toBe(normalizeCaptionForOcrCompare(b));
  });

  test('strips a single pair of outer wrapping quotes', () => {
    const inner = "Hello, world.";
    expect(normalizeCaptionForOcrCompare(`'${inner}'`)).toBe(normalizeCaptionForOcrCompare(inner));
  });
});

describe('evaluateOcrResult', () => {
  function basePassingParsed(over = {}) {
    return {
      ocrText: 'x',
      leftText: 'x',
      rightText: '',
      centerText: '',
      crossesMidline: false,
      textOnBothSides: false,
      fontLooksPlainBookSerif: true,
      ...over,
    };
  }

  test('passes when active side matches after quote normalization (curly vs straight)', () => {
    const expected = "‘On porch boards, Svea claps for more. Her bell goes jingle on the floor.’";
    const gotStraight = "On porch boards, Svea claps for more. Her bell goes jingle on the floor.";
    const parsed = basePassingParsed({
      ocrText: gotStraight,
      leftText: gotStraight,
      rightText: '',
    });
    const r = evaluateOcrResult(parsed, {
      expectedText: expected,
      expectedSide: 'left',
      anyExpected: true,
    });
    expect(r.pass).toBe(true);
    expect(r.tags).not.toContain('spelling_mismatch');
  });

  test('fails on real extra word in caption', () => {
    const expected = 'Hello there.';
    const got = 'Hello there friend.';
    const parsed = basePassingParsed({
      ocrText: got,
      leftText: got,
      rightText: '',
    });
    const r = evaluateOcrResult(parsed, {
      expectedText: expected,
      expectedSide: 'left',
      anyExpected: true,
    });
    expect(r.pass).toBe(false);
    expect(r.tags).toContain('extra_word');
  });
});
