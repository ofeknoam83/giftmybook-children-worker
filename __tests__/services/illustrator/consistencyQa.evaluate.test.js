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

  test('impliedParentSkinMismatch false passes when nothing else fails', () => {
    const r = evaluateConsistencyResult(baseParsed({
      impliedParentSkinMismatch: false,
    }));
    expect(r.pass).toBe(true);
    expect(r.tags).not.toContain('implied_parent_skin_mismatch');
  });
});
