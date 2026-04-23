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

  test('mothers_day + parent on cover: must not claim the secondary on cover is NOT the mother (regression: session opts wiring)', () => {
    const out = buildSystemInstruction({
      hasParentOnCover: true,
      hasSecondaryOnCover: true,
      additionalCoverCharacters: 'Mom holding the child',
      theme: 'mothers_day',
    });
    expect(out).not.toMatch(/additional person on the cover is NOT the mother/i);
    expect(out).toMatch(/themed mother IS on the cover/);
    expect(out).toMatch(/exact-match lock/);
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

describe('buildSystemInstruction — bath / water modesty', () => {
  test('includes BATH, SHOWER, AND SWIMMING block with bubble-bath guidance', () => {
    const out = buildSystemInstruction({
      hasParentOnCover: false,
      hasSecondaryOnCover: false,
      theme: 'bedtime',
    });
    expect(out).toMatch(/BATH, SHOWER, AND SWIMMING/);
    expect(out).toMatch(/bubble/i);
    expect(out).toMatch(/street outfit/);
  });
});

describe('buildSystemInstruction — panorama / no diptych', () => {
  test('COMPOSITION includes PANORAMA LOCK against stitched halves', () => {
    const out = buildSystemInstruction({
      hasParentOnCover: false,
      hasSecondaryOnCover: false,
      theme: 'adventure',
    });
    expect(out).toMatch(/PANORAMA LOCK/);
    expect(out).toMatch(/diptych|vertical seam/i);
  });
});

describe('buildSystemInstruction — shot variety', () => {
  test('COMPOSITION includes global SHOT VARIETY guidance', () => {
    const out = buildSystemInstruction({
      hasParentOnCover: false,
      hasSecondaryOnCover: false,
      theme: 'birthday',
    });
    expect(out).toMatch(/SHOT VARIETY/);
    expect(out).toMatch(/same setting|revisits/i);
  });

  test('NAMED LOCATIONS section repeats shot variety when palette present', () => {
    const out = buildSystemInstruction({
      hasParentOnCover: false,
      hasSecondaryOnCover: false,
      theme: 'mothers_day',
      locationPalette: {
        palette: [
          { id: 'harbor', name: 'the old harbor at dawn', visual_anchors: ['rust red crane', 'wooden pier'] },
        ],
        beatAssignments: [{ spread: 1, location_id: 'harbor' }, { spread: 2, location_id: 'harbor' }],
      },
    });
    expect(out).toMatch(/SHOT VARIETY \(same place/);
    expect(out).toMatch(/near-duplicate/i);
  });
});

describe('buildSystemInstruction — IMPLIED_PARENT skin tone lock', () => {
  function countSkinLocks(text) {
    return (text.match(/SKIN TONE LOCK \(implied parent\):/g) || []).length;
  }

  test('child-only cover: one skin lock in generic implied-presence branch', () => {
    const out = buildSystemInstruction({
      hasParentOnCover: false,
      hasSecondaryOnCover: false,
      theme: 'adventure',
    });
    expect(countSkinLocks(out)).toBe(1);
    expect(out).toMatch(/match the hero child/);
  });

  test('mothers_day child-only: skin lock in generic + themed branches', () => {
    const out = buildSystemInstruction({
      hasParentOnCover: false,
      hasSecondaryOnCover: false,
      theme: 'mothers_day',
      childAppearance: 'light skin, brown eyes',
    });
    expect(countSkinLocks(out)).toBe(2);
    expect(out).toMatch(/light skin, brown eyes/);
  });

  test('parent on cover: no skin lock blocks', () => {
    const out = buildSystemInstruction({
      hasParentOnCover: true,
      hasSecondaryOnCover: true,
      additionalCoverCharacters: 'Mom and child',
      theme: 'mothers_day',
    });
    expect(countSkinLocks(out)).toBe(0);
  });
});
