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
});
