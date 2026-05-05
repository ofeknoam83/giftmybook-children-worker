/**
 * PR X — Illustrator parent-skin escape hatch.
 *
 * The QA tags `implied_parent_skin_mismatch` and `full_body_parent_skin_mismatch`
 * are model-evaluated color-match calls on small skin patches. The image model
 * physically cannot perfectly color-match those fragments to the cover child
 * every time, so a strict QA bar can burn the entire repair budget rejecting
 * borderline gaps the model cannot close — failing the whole book.
 *
 * Instead of failing, the quad pipeline downgrades the spread's
 * parentVisibility on the next attempt to remove the parent fragment from
 * the frame entirely (object → absent ladder).
 *
 * These helpers are pure so they can be exercised without spinning up the
 * full Gemini illustrator session.
 */

const {
  isParentSkinOnlyRejection,
  nextConsecutiveParentSkinOnly,
  resolveParentVisibilityWithEscapeHatch,
} = require('../../../services/bookPipeline/illustrator/renderAllSpreadsQuad');

describe('isParentSkinOnlyRejection', () => {
  test('true when the only failing tag is implied_parent_skin_mismatch', () => {
    expect(isParentSkinOnlyRejection(['implied_parent_skin_mismatch'])).toBe(true);
  });

  test('true when the only failing tag is full_body_parent_skin_mismatch', () => {
    expect(isParentSkinOnlyRejection(['full_body_parent_skin_mismatch'])).toBe(true);
  });

  test('true when both parent-skin tags appear together (no other tags)', () => {
    expect(isParentSkinOnlyRejection([
      'implied_parent_skin_mismatch',
      'full_body_parent_skin_mismatch',
    ])).toBe(true);
  });

  test('false when an unrelated tag is also present', () => {
    expect(isParentSkinOnlyRejection([
      'implied_parent_skin_mismatch',
      'outfit_mismatch',
    ])).toBe(false);
    expect(isParentSkinOnlyRejection([
      'full_body_parent_skin_mismatch',
      'duplicated_hero',
    ])).toBe(false);
  });

  test('false on an empty rejection (e.g. spread that passed)', () => {
    expect(isParentSkinOnlyRejection([])).toBe(false);
  });

  test('false on undefined / non-array tags', () => {
    expect(isParentSkinOnlyRejection(undefined)).toBe(false);
    expect(isParentSkinOnlyRejection(null)).toBe(false);
  });

  test('false when only unrelated tags are present', () => {
    expect(isParentSkinOnlyRejection(['hero_mismatch', 'outfit_mismatch'])).toBe(false);
  });
});

describe('nextConsecutiveParentSkinOnly', () => {
  test('increments on a parent-skin-only rejection', () => {
    expect(nextConsecutiveParentSkinOnly(0, ['implied_parent_skin_mismatch'])).toBe(1);
    expect(nextConsecutiveParentSkinOnly(2, ['full_body_parent_skin_mismatch'])).toBe(3);
  });

  test('resets to 0 when the rejection includes any unrelated tag', () => {
    // Critical: an unrelated tag means the model has OTHER work to do — those
    // need the regular repair path, not the escape hatch.
    expect(nextConsecutiveParentSkinOnly(2, [
      'implied_parent_skin_mismatch',
      'outfit_mismatch',
    ])).toBe(0);
  });

  test('resets to 0 on an empty rejection (spread passed this attempt)', () => {
    expect(nextConsecutiveParentSkinOnly(2, [])).toBe(0);
  });

  test('resets to 0 on a rejection with only unrelated tags', () => {
    expect(nextConsecutiveParentSkinOnly(3, ['hero_mismatch'])).toBe(0);
  });

  test('handles undefined prev as 0', () => {
    expect(nextConsecutiveParentSkinOnly(undefined, ['implied_parent_skin_mismatch'])).toBe(1);
  });

  test('handles non-array tags as a reset', () => {
    expect(nextConsecutiveParentSkinOnly(2, undefined)).toBe(0);
    expect(nextConsecutiveParentSkinOnly(2, null)).toBe(0);
  });
});

describe('resolveParentVisibilityWithEscapeHatch', () => {
  test('preserves planner choice when count is below threshold', () => {
    expect(resolveParentVisibilityWithEscapeHatch('hand', 0)).toBe('hand');
    expect(resolveParentVisibilityWithEscapeHatch('hand', 1)).toBe('hand');
    expect(resolveParentVisibilityWithEscapeHatch('shoulder-back', 1)).toBe('shoulder-back');
    expect(resolveParentVisibilityWithEscapeHatch('cropped-torso', 1)).toBe('cropped-torso');
  });

  test('downgrades to object at the 2-rejection threshold', () => {
    expect(resolveParentVisibilityWithEscapeHatch('hand', 2)).toBe('object');
    expect(resolveParentVisibilityWithEscapeHatch('shoulder-back', 2)).toBe('object');
    expect(resolveParentVisibilityWithEscapeHatch('cropped-torso', 2)).toBe('object');
  });

  test('downgrades to absent at the 3+-rejection threshold', () => {
    expect(resolveParentVisibilityWithEscapeHatch('hand', 3)).toBe('absent');
    expect(resolveParentVisibilityWithEscapeHatch('hand', 5)).toBe('absent');
    expect(resolveParentVisibilityWithEscapeHatch('object', 4)).toBe('absent');
  });

  test('preserves null/undefined planned values when below threshold', () => {
    expect(resolveParentVisibilityWithEscapeHatch(null, 0)).toBe(null);
    expect(resolveParentVisibilityWithEscapeHatch(undefined, 1)).toBe(undefined);
  });

  test('still applies escape hatch when planned is null (non-parent theme)', () => {
    // Edge case: even if the planner did not set parentVisibility, after 2+
    // parent-skin rejections we still want to force 'object' / 'absent' so
    // the prompt explicitly tells the model "no parent fragment in frame".
    expect(resolveParentVisibilityWithEscapeHatch(null, 2)).toBe('object');
    expect(resolveParentVisibilityWithEscapeHatch(undefined, 3)).toBe('absent');
  });
});

describe('escape hatch behaviour through realistic rejection sequences', () => {
  test('repeated parent-skin-only rejections trigger the escape hatch on attempt 3', () => {
    // Mirrors the actual Scarlett book e3f4e0c0 log: every rejection had
    // implied_parent_skin_mismatch as the sole failing tag.
    const sequence = [
      ['implied_parent_skin_mismatch'],
      ['implied_parent_skin_mismatch'],
      ['implied_parent_skin_mismatch'],
      ['implied_parent_skin_mismatch'],
      ['implied_parent_skin_mismatch'],
    ];
    let count = 0;
    const visibilityPath = ['hand']; // attempt 1 uses planner default
    for (let i = 0; i < sequence.length; i += 1) {
      count = nextConsecutiveParentSkinOnly(count, sequence[i]);
      // visibility for the NEXT attempt
      visibilityPath.push(resolveParentVisibilityWithEscapeHatch('hand', count));
    }
    // visibilityPath: attempts 1..6 — escape hatch engages on attempt 3 (count=2)
    expect(visibilityPath).toEqual(['hand', 'hand', 'object', 'absent', 'absent', 'absent']);
  });

  test('mixed rejections do NOT engage the escape hatch (only true streaks count)', () => {
    // A spread that fails parent-skin once then fails outfit once is in normal
    // repair territory — the escape hatch must NOT engage and remove the parent.
    const sequence = [
      ['implied_parent_skin_mismatch'],
      ['outfit_mismatch'],
      ['implied_parent_skin_mismatch'],
      ['hero_mismatch'],
      ['implied_parent_skin_mismatch'],
    ];
    let count = 0;
    const visibilityPath = ['hand'];
    for (const tags of sequence) {
      count = nextConsecutiveParentSkinOnly(count, tags);
      visibilityPath.push(resolveParentVisibilityWithEscapeHatch('hand', count));
    }
    // After every reset the count goes back to 0 / 1 — never reaches 2.
    expect(visibilityPath.every(v => v === 'hand')).toBe(true);
  });

  test('a spread that recovers (passes once) clears the streak', () => {
    // Pass clears any streak. A subsequent parent-skin rejection starts the
    // counter from 0 again.
    let count = 0;
    count = nextConsecutiveParentSkinOnly(count, ['implied_parent_skin_mismatch']);
    expect(count).toBe(1);
    count = nextConsecutiveParentSkinOnly(count, []); // pass
    expect(count).toBe(0);
    count = nextConsecutiveParentSkinOnly(count, ['implied_parent_skin_mismatch']);
    expect(count).toBe(1);
    expect(resolveParentVisibilityWithEscapeHatch('hand', count)).toBe('hand');
  });
});
