/**
 * AA-CW-14b → off-cover parent policy update — parentVisibility under the
 * "no visible parent" rule.
 *
 * Original AA-CW-14b reworked the 'shadow' visibility into an OFF-FRAME cast
 * shadow because the renderer kept anthropomorphizing in-frame silhouettes.
 * The follow-up policy hardened the rule further: when the parent is NOT on
 * the approved cover, the parent is NEVER drawn visibly in any form — no
 * face, no body, no hand, no shoulder, no shadow, no silhouette, no
 * reflection. Only signature OBJECTS may imply them.
 *
 * `buildParentVisibilityReminder` therefore now silently overrides ANY
 * visible-fragment value (full / hand / shoulder-back / cropped-torso /
 * shadow) into the OBJECT directive when `coverParentPresent === false`.
 * The original visible-fragment branches are still reachable when the parent
 * IS on the cover.
 */

const { buildParentVisibilityReminder } = require('../../../services/illustrator/prompt');

describe('buildParentVisibilityReminder — off-cover parent override', () => {
  const offCover = { isParentTheme: true, coverParentPresent: false };
  const onCover = { isParentTheme: true, coverParentPresent: true };

  test('returns an empty string when not a parent theme', () => {
    expect(buildParentVisibilityReminder({
      isParentTheme: false,
      coverParentPresent: false,
      parentVisibility: 'shadow',
    })).toBe('');
  });

  test('returns an empty string when parentVisibility is unset', () => {
    expect(buildParentVisibilityReminder({
      ...offCover,
      parentVisibility: '',
    })).toBe('');
  });

  test('off-cover parent + visible-fragment values (full/hand/shoulder/cropped/shadow) all collapse to the OBJECT directive', () => {
    for (const v of ['full', 'hand', 'shoulder-back', 'cropped-torso', 'shadow']) {
      const out = buildParentVisibilityReminder({
        ...offCover,
        parentVisibility: v,
      });
      expect(out).toMatch(/OBJECT IMPLIES THEM/);
      expect(out).toMatch(/off-cover policy override/i);
      expect(out).toMatch(/does NOT appear visibly/);
      expect(out).toMatch(/signature objects/i);
    }
  });

  test('off-cover parent + object value emits the OBJECT directive without the override prefix', () => {
    const out = buildParentVisibilityReminder({
      ...offCover,
      parentVisibility: 'object',
    });
    expect(out).toMatch(/OBJECT IMPLIES THEM/);
    expect(out).not.toMatch(/off-cover policy override/i);
    expect(out).toMatch(/empty chair|coat on a hook|mug|folded blanket/i);
  });

  test('off-cover parent + absent value emits the ABSENT directive (hero alone, no signature object either)', () => {
    const out = buildParentVisibilityReminder({
      ...offCover,
      parentVisibility: 'absent',
    });
    expect(out).toMatch(/ABSENT/);
    expect(out).toMatch(/child is alone in the frame/i);
  });

  test('on-cover parent + visible-fragment values are PRESERVED (no off-cover override)', () => {
    expect(buildParentVisibilityReminder({
      ...onCover,
      parentVisibility: 'full',
    })).toMatch(/FULL — render the parent fully visible/);
    expect(buildParentVisibilityReminder({
      ...onCover,
      parentVisibility: 'hand',
    })).toMatch(/HAND ONLY/);
    expect(buildParentVisibilityReminder({
      ...onCover,
      parentVisibility: 'shoulder-back',
    })).toMatch(/SHOULDER \/ BACK-OF-HEAD/);
    expect(buildParentVisibilityReminder({
      ...onCover,
      parentVisibility: 'cropped-torso',
    })).toMatch(/CROPPED TORSO/);
    expect(buildParentVisibilityReminder({
      ...onCover,
      parentVisibility: 'shadow',
    })).toMatch(/OFF-FRAME CAST SHADOW|off-frame/i);
  });
});
