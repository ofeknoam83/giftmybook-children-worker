/**
 * Tests for buildSystemInstruction — off-cover parent / family policy.
 *
 * The earlier policy allowed an off-cover parent (or any off-cover adult) to
 * appear via "implied presence": a hand, arm, shoulder, back-of-head,
 * cropped torso, or featureless shadow. That repeatedly drove visual drift
 * (anthropomorphic shadows with face features, disembodied hands, sleeve /
 * outfit drift across spreads) so the policy was hardened: when the parent
 * (or any adult) is NOT on the approved cover, they are NEVER drawn
 * visibly in ANY form — no face, no body, no hand / arm / finger / shoulder
 * / silhouette / shadow / reflection. Their presence is communicated only
 * through (a) the manuscript text and (b) signature OBJECTS in the scene
 * (a mug, a coat on a hook, an empty chair, a folded cardigan).
 *
 * The IMPLIED_PRESENCE_ANCHORING_RULE block (which used to teach the model
 * how to anchor a visible limb) is therefore no longer emitted on this
 * branch — there is nothing to anchor.
 */

const { buildSystemInstruction } = require('../../../services/illustrator/systemInstruction');

describe('buildSystemInstruction — off-cover parent / adult policy', () => {
  test('generic child-only cover (adventure): off-cover adult policy block, no implied-presence anchoring rule', () => {
    const out = buildSystemInstruction({
      hasParentOnCover: false,
      hasSecondaryOnCover: false,
      theme: 'adventure',
    });
    // New policy block is present.
    expect(out).toMatch(/OFF-COVER ADULT POLICY/);
    expect(out).toMatch(/NEVER appears visibly in any spread/i);
    // Visible-fragment paths are explicitly forbidden.
    expect(out).toMatch(/not as a hand|not as a shoulder|not as a shadow|not as a silhouette/i);
    // Signature objects are the only allowed implication channel.
    expect(out).toMatch(/signature OBJECTS|signature object/);
    // The old anchoring-rule block is gone — no "anchoring rule" header anywhere.
    expect(out).not.toMatch(/ANCHORING RULE \(when showing a hand, arm, or shoulder of a hidden-face person\):/);
    // Old implied-presence vocabulary is gone.
    expect(out).not.toMatch(/disembodied hand/);
    expect(out).not.toMatch(/single cuff/);
  });

  test('mothers_day + child-only cover: themed-parent policy is text+signature-object only (Mom never drawn)', () => {
    const out = buildSystemInstruction({
      hasParentOnCover: false,
      hasSecondaryOnCover: false,
      theme: 'mothers_day',
    });
    expect(out).toMatch(/THEMED MOTHER POLICY \(NOT ON COVER\)/);
    expect(out).toMatch(/NEVER VISIBLY DRAWN/);
    expect(out).toMatch(/signature OBJECTS/);
    // Concrete signature-object examples for Mom.
    expect(out).toMatch(/cardigan|tea mug|rocking chair|reading glasses/i);
    // No anchoring rule; the old "implied-limb" anchoring instructions no
    // longer apply to the parent (a generic anatomy rule about hand-to-body
    // anchoring still exists for ANY person in the frame — that's fine).
    expect(out).not.toMatch(/ANCHORING RULE \(when showing a hand, arm, or shoulder of a hidden-face person\)/);
    // Old policy bullet that offered "a hand entering frame (reading to
    // the hero, holding a mug, adjusting a blanket)" as an option for the
    // off-cover parent is gone.
    expect(out).not.toMatch(/A hand entering frame \(reading to the hero/);
  });

  test('fathers_day + child-only cover: same text+signature-object policy with Dad-flavored objects', () => {
    const out = buildSystemInstruction({
      hasParentOnCover: false,
      hasSecondaryOnCover: false,
      theme: 'fathers_day',
    });
    expect(out).toMatch(/THEMED FATHER POLICY \(NOT ON COVER\)/);
    expect(out).toMatch(/NEVER VISIBLY DRAWN/);
    expect(out).toMatch(/work boots|coffee mug|wristwatch|jacket|baseball cap/i);
    expect(out).not.toMatch(/ANCHORING RULE/);
  });

  test('mothers_day + parent on cover: full-face parent policy (no off-cover policy block)', () => {
    const out = buildSystemInstruction({
      hasParentOnCover: true,
      hasSecondaryOnCover: true,
      additionalCoverCharacters: 'Mom holding the child',
      theme: 'mothers_day',
    });
    expect(out).not.toMatch(/THEMED MOTHER POLICY \(NOT ON COVER\)/);
    expect(out).not.toMatch(/OFF-COVER ADULT POLICY/);
    expect(out).toMatch(/themed mother IS on the cover/);
    expect(out).toMatch(/VISUAL MODEL LOCK/);
    expect(out).toMatch(/same facial identity/i);
    // Regression: the secondary IS the mother.
    expect(out).not.toMatch(/additional person on the cover is NOT the mother/i);
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

describe('buildSystemInstruction — implied-parent skin-tone lock is dropped under the off-cover policy', () => {
  // Under the previous policy, an off-cover parent could appear as a hand /
  // shoulder / cropped torso / shadow, and a SKIN TONE LOCK block taught the
  // model to match the parent's visible skin to the hero child's. The new
  // policy says the parent is NEVER drawn visibly when off-cover, so there
  // is no parent skin to color-match — the SKIN TONE LOCK block is no
  // longer emitted on those branches.

  test('child-only cover (adventure): no implied-parent skin tone lock', () => {
    const out = buildSystemInstruction({
      hasParentOnCover: false,
      hasSecondaryOnCover: false,
      theme: 'adventure',
    });
    expect(out).not.toMatch(/SKIN TONE LOCK \(any parent \/ relative not on the cover/);
  });

  test('mothers_day child-only: no implied-parent skin tone lock', () => {
    const out = buildSystemInstruction({
      hasParentOnCover: false,
      hasSecondaryOnCover: false,
      theme: 'mothers_day',
      childAppearance: 'light skin, brown eyes',
    });
    expect(out).not.toMatch(/SKIN TONE LOCK \(any parent \/ relative not on the cover/);
  });

  test('parent on cover: no implied-parent skin tone lock either (parent is rendered, not implied)', () => {
    const out = buildSystemInstruction({
      hasParentOnCover: true,
      hasSecondaryOnCover: true,
      additionalCoverCharacters: 'Mom and child',
      theme: 'mothers_day',
    });
    expect(out).not.toMatch(/SKIN TONE LOCK \(any parent \/ relative not on the cover/);
  });
});

describe('buildSystemInstruction — ages 3–8 compact caption tier', () => {
  test('childAge 5 includes top and larger bottom vertical insets in ON-IMAGE TEXT section', () => {
    const out = buildSystemInstruction({
      hasParentOnCover: false,
      hasSecondaryOnCover: false,
      theme: 'adventure',
      childAge: 5,
    });
    expect(out).toMatch(/about 26%/);
    expect(out).toMatch(/about 42%/);
    expect(out).toMatch(/Compact read-aloud tier/i);
  });

  test('childAge 2 (baby/toddler book) uses infant margins and not compact tier', () => {
    const out = buildSystemInstruction({
      hasParentOnCover: false,
      hasSecondaryOnCover: false,
      theme: 'adventure',
      childAge: 2,
    });
    expect(out).toMatch(/about 28%/);
    expect(out).toMatch(/about 48%/);
    expect(out).toMatch(/Baby\/toddler book|very young/i);
    expect(out).not.toMatch(/Compact read-aloud tier/i);
  });
});
