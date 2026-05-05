/**
 * Unit tests for consistency QA evaluation (implied parent skin, etc.).
 */

const { evaluateConsistencyResult } = require('../../../services/illustrator/consistencyQa');

function baseParsed(overrides = {}) {
  return {
    heroChildMatches: true,
    heroChildDifferences: '',
    outfitMatches: true,
    artStyleIs3DPixar: true,
    artStyleNotes: '',
    heroCount: 1,
    heroBodyConnected: true,
    splitPanel: false,
    explicitStranger: false,
    strangerDescription: '',
    recurringItemConcerns: '',
    impliedParentSkinMismatch: false,
    impliedParentSkinNotes: '',
    ...overrides,
  };
}

describe('evaluateConsistencyResult', () => {
  test('impliedParentSkinMismatch true adds tag and issue', () => {
    const r = evaluateConsistencyResult(baseParsed({
      impliedParentSkinMismatch: true,
      impliedParentSkinNotes: 'adult hands much darker than child',
    }));
    expect(r.pass).toBe(false);
    expect(r.tags).toContain('implied_parent_skin_mismatch');
    expect(r.issues.some(i => /Implied parent.*skin/i.test(i))).toBe(true);
    expect(r.issues.join(' ')).toMatch(/darker than child/);
  });

  test('hairContinuity ignored when no recent interiors in request (recentCount 0)', () => {
    const r = evaluateConsistencyResult(baseParsed({
      hairConsistentWithRecentInteriors: false,
      hairContinuityNotes: 'wrong',
    }), 0);
    expect(r.pass).toBe(true);
    expect(r.tags).not.toContain('hair_continuity_drift');
  });

  test('hairContinuity drift tags when recent interiors were provided (recentCount > 0)', () => {
    const r = evaluateConsistencyResult(baseParsed({
      hairConsistentWithRecentInteriors: false,
      hairContinuityNotes: 'blond vs brown',
    }), 2);
    expect(r.pass).toBe(false);
    expect(r.tags).toContain('hair_continuity_drift');
    expect(r.issues.some(i => /hair drifts vs recent/i.test(i))).toBe(true);
  });

  test('outfitContinuity drift tags when recent interiors were provided', () => {
    const r = evaluateConsistencyResult(baseParsed({
      outfitConsistentWithRecentInteriors: false,
      outfitContinuityNotes: 'dress vs overalls',
    }), 1);
    expect(r.tags).toContain('outfit_continuity_drift');
  });

  test('parentAsCharacterSilhouette true adds tag and issue (anthropomorphized shadow with eyes/mouth)', () => {
    const r = evaluateConsistencyResult(baseParsed({
      parentAsCharacterSilhouette: true,
      parentAsCharacterSilhouetteNotes: 'tall mother shadow with two glowing eyes, an open mouth, and a hand silhouette gesturing at the child',
    }));
    expect(r.pass).toBe(false);
    expect(r.tags).toContain('parent_as_character_silhouette');
    expect(r.issues.some(i => /anthropomorphized character silhouette/i.test(i))).toBe(true);
    expect(r.issues.join(' ')).toMatch(/glowing eyes/);
  });

  test('parentAsCharacterSilhouette false (or missing) does not tag', () => {
    // Plain featureless silhouette — should not trigger the new detector.
    const r = evaluateConsistencyResult(baseParsed({
      parentAsCharacterSilhouette: false,
    }));
    expect(r.pass).toBe(true);
    expect(r.tags).not.toContain('parent_as_character_silhouette');
  });

  test('parent_as_character_silhouette tag is independent of unexpected_person', () => {
    // Both detectors can fire together (S10-style: shadow + visible face features),
    // but each must surface its own tag so downstream regen prompts can target both.
    const r = evaluateConsistencyResult(baseParsed({
      explicitStranger: true,
      strangerDescription: 'a stylized adult silhouette with rendered eyes and mouth',
      parentAsCharacterSilhouette: true,
      parentAsCharacterSilhouetteNotes: 'mother shadow with glowing eyes and open mouth',
    }));
    expect(r.pass).toBe(false);
    expect(r.tags).toEqual(expect.arrayContaining(['unexpected_person', 'parent_as_character_silhouette']));
  });

  test('heroSkinToneMatchesCover false adds hero_skin_drift tag and issue', () => {
    const r = evaluateConsistencyResult(baseParsed({
      heroSkinToneMatchesCover: false,
      heroSkinToneNotes: 'cover child reads as fair, candidate child reads as medium-tan with warm undertone — clear two-shade gap',
    }));
    expect(r.pass).toBe(false);
    expect(r.tags).toContain('hero_skin_drift');
    expect(r.issues.some(i => /Hero child's skin tone drifts/i.test(i))).toBe(true);
    expect(r.issues.join(' ')).toMatch(/medium-tan/);
  });

  test('heroSkinToneMatchesCover true (default) does not tag', () => {
    const r = evaluateConsistencyResult(baseParsed({
      heroSkinToneMatchesCover: true,
    }));
    expect(r.pass).toBe(true);
    expect(r.tags).not.toContain('hero_skin_drift');
  });

  test('hero_skin_drift independent of hero_mismatch (skin can drift while face is the same person)', () => {
    // The two detectors target different failure modes — face shape vs skin tone.
    // A medium-tan rendering of a clearly-fair cover child can fail skin tone
    // even when heroChildMatches still reads true (model decided the face was
    // close enough). Both tags must be able to fire independently.
    const r = evaluateConsistencyResult(baseParsed({
      heroChildMatches: true,
      heroSkinToneMatchesCover: false,
      heroSkinToneNotes: 'cover fair, spread medium-tan',
    }));
    expect(r.pass).toBe(false);
    expect(r.tags).toContain('hero_skin_drift');
    expect(r.tags).not.toContain('hero_mismatch');
  });

  test('tooManyHands true adds extra_limbs tag and issue', () => {
    const r = evaluateConsistencyResult(baseParsed({
      tooManyHands: true,
      tooManyHandsNotes: 'mother has three hands: one on the stroller bar, one on the child\'s shoulder, and a third reaching from behind',
    }));
    expect(r.pass).toBe(false);
    expect(r.tags).toContain('extra_limbs');
    expect(r.issues.some(i => /more than two hands/i.test(i))).toBe(true);
    expect(r.issues.join(' ')).toMatch(/three hands/);
  });

  test('tooManyHands false (default) does not tag', () => {
    const r = evaluateConsistencyResult(baseParsed({
      tooManyHands: false,
    }));
    expect(r.pass).toBe(true);
    expect(r.tags).not.toContain('extra_limbs');
  });

  test('objectIntegrityOk false adds object_integrity tag and issue', () => {
    const r = evaluateConsistencyResult(baseParsed({
      objectIntegrityOk: false,
      objectIntegrityNotes: 'stroller handle floats above the stroller body with no visible bar connecting the two',
    }));
    expect(r.pass).toBe(false);
    expect(r.tags).toContain('object_integrity');
    expect(r.issues.some(i => /structurally broken/i.test(i))).toBe(true);
    expect(r.issues.join(' ')).toMatch(/stroller handle/);
  });

  test('objectIntegrityOk true (default) does not tag', () => {
    const r = evaluateConsistencyResult(baseParsed({
      objectIntegrityOk: true,
    }));
    expect(r.pass).toBe(true);
    expect(r.tags).not.toContain('object_integrity');
  });

  test('extra_limbs and disembodied_limb are independent (third hand on a body vs floating limb)', () => {
    // The two detectors target different anatomy failures and must surface
    // independent tags so regen prompts can address each.
    const r = evaluateConsistencyResult(baseParsed({
      tooManyHands: true,
      tooManyHandsNotes: 'parent has 3 hands',
      disembodiedLimb: true,
      disembodiedLimbNotes: 'a fourth hand floating with no body anchor',
    }));
    expect(r.pass).toBe(false);
    expect(r.tags).toEqual(expect.arrayContaining(['extra_limbs', 'disembodied_limb']));
  });
});
