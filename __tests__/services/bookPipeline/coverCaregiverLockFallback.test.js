/**
 * Phase-X — caregiver-lock fallback synthesis.
 *
 * The full chain of caregiver QA tags (caregiver_body_duplicated,
 * phantom_arms, caregiver_skin_drift, caregiver_shadow_substitution) is
 * gated on a non-null `caregiverLock` in services/illustrator/consistencyQa.js
 * (lines 255 + 262). If the second vision call (callCaregiverVision) fails,
 * the lock is null and the QA defense vanishes — the renderer can ship a
 * "two Mamas" image because the QA model never saw the duplication tag
 * schema. This test pins the synthesis helper that fills that gap.
 */

const {
  synthesizeCaregiverLockFallback,
} = require('../../../services/bookPipeline/planner/caregiverLockFallback');

describe('synthesizeCaregiverLockFallback (Phase-X)', () => {
  test('mothers_day -> role=mother', () => {
    const lock = synthesizeCaregiverLockFallback('mothers_day');
    expect(lock.present).toBe(true);
    expect(lock.role).toBe('mother');
    expect(lock.synthesizedFallback).toBe(true);
  });

  test('fathers_day -> role=father', () => {
    const lock = synthesizeCaregiverLockFallback('fathers_day');
    expect(lock.role).toBe('father');
  });

  test('grandparents_day -> role=grandparent', () => {
    const lock = synthesizeCaregiverLockFallback('grandparents_day');
    expect(lock.role).toBe('grandparent');
  });

  test('unknown / empty theme -> generic role=caregiver', () => {
    expect(synthesizeCaregiverLockFallback('').role).toBe('caregiver');
    expect(synthesizeCaregiverLockFallback(null).role).toBe('caregiver');
    expect(synthesizeCaregiverLockFallback(undefined).role).toBe('caregiver');
    expect(synthesizeCaregiverLockFallback('birthday').role).toBe('caregiver');
  });

  test('case-insensitive theme matching', () => {
    expect(synthesizeCaregiverLockFallback('MOTHERS_DAY').role).toBe('mother');
    expect(synthesizeCaregiverLockFallback('Fathers_Day').role).toBe('father');
  });

  test('every visual field uses the "(see cover render)" sentinel that QA repair templates already substitute', () => {
    // consistencyQa.js lines 256, 268, 271, 274 already substitute
    // "(see cover render)" when a lock field is empty — the QA prompt
    // renders correctly with these sentinel values, and the QA model
    // falls back to reading the cover pixels for identity comparison.
    const lock = synthesizeCaregiverLockFallback('mothers_day');
    const sentinel = '(see cover render)';
    expect(lock.skinTone).toBe(sentinel);
    expect(lock.hair).toBe(sentinel);
    expect(lock.outfit).toBe(sentinel);
    expect(lock.build).toBe(sentinel);
    expect(lock.face).toBe(sentinel);
    expect(lock.skinFamilyVsChild).toBe('unclear');
  });

  test('the synthesized lock matches the shape consistencyQa expects (so caregiverLockBlock + caregiverSchema render)', () => {
    const lock = synthesizeCaregiverLockFallback('mothers_day');
    // consistencyQa.js:255 gates `caregiverLockBlock` on `lock` being truthy;
    // :262 gates `caregiverSchema` (which contains the JSON field
    // definitions for caregiverBodyDuplicated, phantomArms, etc.) on the
    // same condition. As long as `lock` is non-null and has the role +
    // visual fields the prompt reads, both blocks render and the QA model
    // can emit the duplication tags.
    expect(lock).not.toBeNull();
    expect(typeof lock.role).toBe('string');
    expect(lock.role.length).toBeGreaterThan(0);
    // These are the fields read in consistencyQa.js (lines 256, 265, 268,
    // 271, 274) — keep them present so the prompt-string interpolation
    // doesn't leave "undefined" in the QA prompt body.
    for (const k of ['skinTone', 'hair', 'outfit', 'build', 'face']) {
      expect(typeof lock[k]).toBe('string');
      expect(lock[k].length).toBeGreaterThan(0);
    }
  });
});
