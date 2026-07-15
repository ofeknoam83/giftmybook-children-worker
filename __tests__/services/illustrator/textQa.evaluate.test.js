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

// ── Audit 2026-07-15: fold-line + trim-edge hard fails ──
// A shipped book split words in half at the page fold ("He pl|ants") and
// clipped first letters at the outer trim. These pin the new OCR fields.
describe('evaluateOcrResult — fold line and trim edge (audit 2026-07-15)', () => {
  function passingParsed(over = {}) {
    return {
      ocrText: 'Hello there.',
      leftText: 'Hello there.',
      rightText: '',
      centerText: '',
      crossesMidline: false,
      textBlockOverflow: false,
      textOnBothSides: false,
      anyTextTouchesFoldLine: false,
      textClippedAtOuterEdge: false,
      fontLooksPlainBookSerif: true,
      ...over,
    };
  }
  const ctx = { expectedText: 'Hello there.', expectedSide: 'left', anyExpected: true };

  test('text on the exact fold line (x=0.5) hard-fails with text_crosses_midline', () => {
    const r = evaluateOcrResult(passingParsed({ anyTextTouchesFoldLine: true }), ctx);
    expect(r.pass).toBe(false);
    expect(r.tags).toContain('text_crosses_midline');
    expect(r.issues.some(i => /fold/i.test(i))).toBe(true);
  });

  test('text clipped at the outer trim edge hard-fails with text_trim_clipped', () => {
    const r = evaluateOcrResult(passingParsed({ textClippedAtOuterEdge: true }), ctx);
    expect(r.pass).toBe(false);
    expect(r.tags).toContain('text_trim_clipped');
    expect(r.issues.some(i => /outer/i.test(i))).toBe(true);
  });

  test('both new fields false → still passes', () => {
    const r = evaluateOcrResult(passingParsed(), ctx);
    expect(r.pass).toBe(true);
  });
});
