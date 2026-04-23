/**
 * Tests for buildSystemInstruction — implied-presence anchoring rule placement.
 */

const { buildSystemInstruction } = require('../../../services/illustrator/systemInstruction');

function countAnchoringHeaders(text) {
  return (text.match(/ANCHORING RULE \(when showing a hand, arm, or shoulder of a hidden-face person\):/g) || []).length;
}

describe('buildSystemInstruction — IMPLIED_PRESENCE_ANCHORING_RULE', () => {
  test('generic child-only cover (adventure): one anchoring block from implied-presence branch', () => {
    const out = buildSystemInstruction({
      hasParentOnCover: false,
      hasSecondaryOnCover: false,
      theme: 'adventure',
    });
    expect(countAnchoringHeaders(out)).toBe(1);
    expect(out).toMatch(/disembodied hand/);
    expect(out).toMatch(/single cuff/);
  });

  test('mothers_day + child-only cover: anchoring in generic branch and themed-parent branch (twice)', () => {
    const out = buildSystemInstruction({
      hasParentOnCover: false,
      hasSecondaryOnCover: false,
      theme: 'mothers_day',
    });
    expect(countAnchoringHeaders(out)).toBe(2);
    expect(out).toMatch(/disembodied hand/);
    expect(out).toMatch(/single cuff/);
  });

  test('mothers_day + parent on cover: no anchoring (full-face parent policy, not implied-presence)', () => {
    const out = buildSystemInstruction({
      hasParentOnCover: true,
      hasSecondaryOnCover: true,
      additionalCoverCharacters: 'Mom holding the child',
      theme: 'mothers_day',
    });
    expect(countAnchoringHeaders(out)).toBe(0);
  });

  test('fathers_day + child-only cover: two anchoring blocks', () => {
    const out = buildSystemInstruction({
      hasParentOnCover: false,
      hasSecondaryOnCover: false,
      theme: 'fathers_day',
    });
    expect(countAnchoringHeaders(out)).toBe(2);
  });
});
