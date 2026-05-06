/**
 * AA-CW-14a — Illustrator silhouette escape hatch.
 *
 * The QA tag `parent_as_character_silhouette` fires when the model renders the
 * implied parent as an anthropomorphized shadow / silhouette WITH face features.
 * The repair prompt asks the model to remove face features from the silhouette,
 * but the image model frequently re-emits the same head-shaped shadow on every
 * retry — "silhouette without a head" is not a stable concept for the renderer.
 *
 * Production symptom: spread pairs burn the full attempt budget on
 * `parent_as_character_silhouette` alone, then trigger a session rebuild and
 * burn another full budget — ~150s of GPU time per failing pair.
 *
 * Mirror PR X (parent-skin escape hatch). After 2 consecutive silhouette-only
 * rejections, downgrade THAT spread's parentVisibility to 'object' (then 'absent'
 * at >=3) so the parent silhouette is removed from frame entirely. The story
 * is about the hero child; an empty mug / blanket / chair implies the parent
 * without exposing a face-shaped shadow for QA to re-flag.
 */

const {
  isSilhouetteOnlyRejection,
  nextConsecutiveSilhouetteOnly,
  resolveParentVisibilityWithBothEscapeHatches,
} = require('../../../services/bookPipeline/illustrator/renderAllSpreadsQuad');

describe('isSilhouetteOnlyRejection', () => {
  test('true when the only failing tag is parent_as_character_silhouette', () => {
    expect(isSilhouetteOnlyRejection(['parent_as_character_silhouette'])).toBe(true);
  });

  test('false when an unrelated tag is also present', () => {
    expect(isSilhouetteOnlyRejection([
      'parent_as_character_silhouette',
      'outfit_mismatch',
    ])).toBe(false);
    expect(isSilhouetteOnlyRejection([
      'parent_as_character_silhouette',
      'duplicated_hero',
    ])).toBe(false);
  });

  test('false when paired with a parent-skin tag (other escape hatch handles that)', () => {
    // Parent-skin and silhouette have separate escape hatches; mixing tags
    // disqualifies both because the spread has multiple distinct failures.
    expect(isSilhouetteOnlyRejection([
      'parent_as_character_silhouette',
      'implied_parent_skin_mismatch',
    ])).toBe(false);
  });

  test('false on an empty rejection (e.g. spread that passed)', () => {
    expect(isSilhouetteOnlyRejection([])).toBe(false);
  });

  test('false on undefined / non-array tags', () => {
    expect(isSilhouetteOnlyRejection(undefined)).toBe(false);
    expect(isSilhouetteOnlyRejection(null)).toBe(false);
  });

  test('false when only unrelated tags are present', () => {
    expect(isSilhouetteOnlyRejection(['hero_mismatch', 'outfit_mismatch'])).toBe(false);
  });
});

describe('nextConsecutiveSilhouetteOnly', () => {
  test('increments on a silhouette-only rejection', () => {
    expect(nextConsecutiveSilhouetteOnly(0, ['parent_as_character_silhouette'])).toBe(1);
    expect(nextConsecutiveSilhouetteOnly(2, ['parent_as_character_silhouette'])).toBe(3);
  });

  test('resets to 0 when the rejection includes any unrelated tag', () => {
    expect(nextConsecutiveSilhouetteOnly(2, [
      'parent_as_character_silhouette',
      'outfit_mismatch',
    ])).toBe(0);
  });

  test('resets to 0 on an empty rejection (spread passed this attempt)', () => {
    expect(nextConsecutiveSilhouetteOnly(2, [])).toBe(0);
  });

  test('resets to 0 on a rejection with only unrelated tags', () => {
    expect(nextConsecutiveSilhouetteOnly(3, ['hero_mismatch'])).toBe(0);
  });

  test('handles undefined prev as 0', () => {
    expect(nextConsecutiveSilhouetteOnly(undefined, ['parent_as_character_silhouette'])).toBe(1);
  });

  test('handles non-array tags as a reset', () => {
    expect(nextConsecutiveSilhouetteOnly(2, undefined)).toBe(0);
    expect(nextConsecutiveSilhouetteOnly(2, null)).toBe(0);
  });
});

describe('resolveParentVisibilityWithBothEscapeHatches', () => {
  test('preserves planner choice when both counters are below threshold', () => {
    expect(resolveParentVisibilityWithBothEscapeHatches('hand', 0, 0)).toBe('hand');
    expect(resolveParentVisibilityWithBothEscapeHatches('hand', 1, 0)).toBe('hand');
    expect(resolveParentVisibilityWithBothEscapeHatches('hand', 0, 1)).toBe('hand');
    expect(resolveParentVisibilityWithBothEscapeHatches('hand', 1, 1)).toBe('hand');
    expect(resolveParentVisibilityWithBothEscapeHatches('shoulder-back', 1, 1)).toBe('shoulder-back');
  });

  test('downgrades to object when silhouette counter alone reaches 2', () => {
    expect(resolveParentVisibilityWithBothEscapeHatches('hand', 0, 2)).toBe('object');
    expect(resolveParentVisibilityWithBothEscapeHatches('shoulder-back', 1, 2)).toBe('object');
  });

  test('downgrades to absent when silhouette counter alone reaches 3+', () => {
    expect(resolveParentVisibilityWithBothEscapeHatches('hand', 0, 3)).toBe('absent');
    expect(resolveParentVisibilityWithBothEscapeHatches('hand', 1, 4)).toBe('absent');
  });

  test('downgrades to object when parent-skin counter alone reaches 2 (existing behavior preserved)', () => {
    expect(resolveParentVisibilityWithBothEscapeHatches('hand', 2, 0)).toBe('object');
    expect(resolveParentVisibilityWithBothEscapeHatches('hand', 2, 1)).toBe('object');
  });

  test('downgrades to absent when parent-skin counter alone reaches 3+', () => {
    expect(resolveParentVisibilityWithBothEscapeHatches('hand', 3, 0)).toBe('absent');
    expect(resolveParentVisibilityWithBothEscapeHatches('hand', 5, 1)).toBe('absent');
  });

  test('takes the strongest downgrade across both counters', () => {
    // parent-skin says object, silhouette says absent → absent wins
    expect(resolveParentVisibilityWithBothEscapeHatches('hand', 2, 3)).toBe('absent');
    // parent-skin says absent, silhouette says object → absent wins
    expect(resolveParentVisibilityWithBothEscapeHatches('hand', 3, 2)).toBe('absent');
    // both at object → object
    expect(resolveParentVisibilityWithBothEscapeHatches('hand', 2, 2)).toBe('object');
  });

  test('preserves null/undefined planned values when below threshold', () => {
    expect(resolveParentVisibilityWithBothEscapeHatches(null, 0, 0)).toBe(null);
    expect(resolveParentVisibilityWithBothEscapeHatches(undefined, 1, 1)).toBe(undefined);
  });

  test('still applies escape hatch when planned is null (forces object/absent in prompt)', () => {
    expect(resolveParentVisibilityWithBothEscapeHatches(null, 0, 2)).toBe('object');
    expect(resolveParentVisibilityWithBothEscapeHatches(undefined, 0, 3)).toBe('absent');
    expect(resolveParentVisibilityWithBothEscapeHatches(null, 2, 0)).toBe('object');
  });
});

describe('silhouette escape hatch behaviour through realistic rejection sequences', () => {
  test('repeated silhouette-only rejections trigger the escape hatch on attempt 3', () => {
    // Mirrors the production Cloud Run log: spread 5+6 burned 5 attempts on
    // parent_as_character_silhouette alone with no other failure tags.
    const sequence = [
      ['parent_as_character_silhouette'],
      ['parent_as_character_silhouette'],
      ['parent_as_character_silhouette'],
      ['parent_as_character_silhouette'],
      ['parent_as_character_silhouette'],
    ];
    let count = 0;
    // visibilityPath[i] = parentVisibility used for attempt i+1
    const visibilityPath = ['hand']; // attempt 1 uses planner default
    for (const tags of sequence) {
      count = nextConsecutiveSilhouetteOnly(count, tags);
      visibilityPath.push(resolveParentVisibilityWithBothEscapeHatches('hand', 0, count));
    }
    // Escape hatch engages on attempt 3 (after 2 consecutive rejections),
    // tightens to absent on attempt 4 (after 3 rejections), and stays absent.
    expect(visibilityPath).toEqual(['hand', 'hand', 'object', 'absent', 'absent', 'absent']);
  });

  test('mixed rejections do NOT engage the escape hatch (only true streaks count)', () => {
    const sequence = [
      ['parent_as_character_silhouette'],
      ['outfit_mismatch'],
      ['parent_as_character_silhouette'],
      ['hero_mismatch'],
      ['parent_as_character_silhouette'],
    ];
    let count = 0;
    const visibilityPath = ['hand'];
    for (const tags of sequence) {
      count = nextConsecutiveSilhouetteOnly(count, tags);
      visibilityPath.push(resolveParentVisibilityWithBothEscapeHatches('hand', 0, count));
    }
    expect(visibilityPath.every(v => v === 'hand')).toBe(true);
  });

  test('a spread that recovers (passes once) clears the streak', () => {
    let count = 0;
    count = nextConsecutiveSilhouetteOnly(count, ['parent_as_character_silhouette']);
    expect(count).toBe(1);
    count = nextConsecutiveSilhouetteOnly(count, []); // pass
    expect(count).toBe(0);
    count = nextConsecutiveSilhouetteOnly(count, ['parent_as_character_silhouette']);
    expect(count).toBe(1);
    expect(resolveParentVisibilityWithBothEscapeHatches('hand', 0, count)).toBe('hand');
  });

  test('combined parent-skin + silhouette streaks both contribute to the downgrade', () => {
    // A spread that alternates between the two failure families never builds
    // a streak in EITHER counter, so the escape hatch never fires. This is
    // intentional — alternating failure modes mean the model is making real
    // changes between attempts and the repair path should keep going.
    let cps = 0;
    let cs = 0;
    const sequence = [
      ['parent_as_character_silhouette'],
      ['implied_parent_skin_mismatch'],
      ['parent_as_character_silhouette'],
      ['implied_parent_skin_mismatch'],
    ];
    const visibilityPath = ['hand'];
    for (const tags of sequence) {
      cps = (function nextCps(prev, t) {
        const has = (t || []).every(x => x === 'implied_parent_skin_mismatch' || x === 'full_body_parent_skin_mismatch')
          && (t || []).some(x => x === 'implied_parent_skin_mismatch' || x === 'full_body_parent_skin_mismatch');
        return has ? (prev || 0) + 1 : 0;
      })(cps, tags);
      cs = nextConsecutiveSilhouetteOnly(cs, tags);
      visibilityPath.push(resolveParentVisibilityWithBothEscapeHatches('hand', cps, cs));
    }
    // Each counter only ever reaches 1 in this sequence — no downgrade.
    expect(visibilityPath.every(v => v === 'hand')).toBe(true);
  });
});
