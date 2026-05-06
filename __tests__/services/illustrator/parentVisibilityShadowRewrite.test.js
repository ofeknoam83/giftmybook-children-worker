/**
 * AA-CW-14b — parentVisibility: 'shadow' rewrite to OFF-FRAME cast shadow.
 *
 * The previous prompt told the renderer to draw a "plain, featureless shadow on
 * a wall" — but the renderer kept inventing a head-and-shoulders profile with
 * face features inside it (eyes, mouth, glow). "Silhouette of a person without
 * a face" is not a stable concept for the image model.
 *
 * The rewritten prompt asks for an OFF-FRAME CAST SHADOW: the parent stands
 * just outside the frame and only their cast shadow falls onto a surface
 * inside the frame. Because the body is off-frame, no head profile is visible
 * — the model can produce this reliably without inventing facial features.
 */

const { buildParentVisibilityReminder } = require('../../../services/illustrator/prompt');

describe('buildParentVisibilityReminder — shadow visibility (AA-CW-14b)', () => {
  const baseOpts = { isParentTheme: true, coverParentPresent: false };

  test('returns an empty string when not a parent theme', () => {
    expect(buildParentVisibilityReminder({
      isParentTheme: false,
      coverParentPresent: false,
      parentVisibility: 'shadow',
    })).toBe('');
  });

  test('returns an empty string when parentVisibility is unset', () => {
    expect(buildParentVisibilityReminder({
      ...baseOpts,
      parentVisibility: '',
    })).toBe('');
  });

  test('shadow visibility describes an OFF-FRAME parent with a cast shadow on a surface', () => {
    const out = buildParentVisibilityReminder({
      ...baseOpts,
      parentVisibility: 'shadow',
    });
    // The new directive establishes the parent is OFF-FRAME, not in-frame.
    expect(out).toMatch(/OFF-FRAME CAST SHADOW|off-frame|outside the picture/i);
    // The shadow falls onto a surface inside the frame.
    expect(out).toMatch(/floor|grass|carpet|bedspread|wall/i);
    // No facial features inside the shadow.
    expect(out).toMatch(/NO eyes/);
    expect(out).toMatch(/NO mouth/);
    // Explicitly NOT a clean head-and-shoulders profile (this was the failure mode).
    expect(out).toMatch(/NOT a clean head-and-shoulders profile|cropped by the edge/i);
    // Provides a fallback: hand entering frame.
    expect(out).toMatch(/hand or forearm entering the frame/i);
    // Reaffirms: never an in-frame anthropomorphized character.
    expect(out).toMatch(/Never an anthropomorphized in-frame character/i);
  });

  test('shadow directive does NOT use the old "ambient presence" / "featureless silhouette" wording that misled the renderer', () => {
    const out = buildParentVisibilityReminder({
      ...baseOpts,
      parentVisibility: 'shadow',
    });
    // The previous prompt opened with "SHADOW / REFLECTION — parent shown only
    // as a plain, featureless shadow ... ambient presence only". That framing
    // led the model to draw an in-frame silhouette which it then anthropomorphized.
    // The new framing is structural (off-frame body, cast shadow on surface).
    expect(out).not.toMatch(/^- Themed parent visibility this spread: SHADOW \/ REFLECTION/);
    // The phrase "ambient presence only" was the old vague language; the new
    // directive is explicit and concrete.
    expect(out).not.toMatch(/Ambient presence only/);
  });

  test('other visibility modes are not affected by the shadow rewrite', () => {
    expect(buildParentVisibilityReminder({
      ...baseOpts,
      parentVisibility: 'hand',
    })).toMatch(/HAND ONLY/);
    expect(buildParentVisibilityReminder({
      ...baseOpts,
      parentVisibility: 'object',
    })).toMatch(/OBJECT IMPLIES THEM/);
    expect(buildParentVisibilityReminder({
      ...baseOpts,
      parentVisibility: 'absent',
    })).toMatch(/ABSENT/);
    expect(buildParentVisibilityReminder({
      ...baseOpts,
      parentVisibility: 'cropped-torso',
    })).toMatch(/CROPPED TORSO/);
    expect(buildParentVisibilityReminder({
      ...baseOpts,
      parentVisibility: 'shoulder-back',
    })).toMatch(/SHOULDER \/ BACK-OF-HEAD/);
  });

  test('full-body parent on a non-cover parent still downgrades to implied (existing safety)', () => {
    const out = buildParentVisibilityReminder({
      isParentTheme: true,
      coverParentPresent: false,
      parentVisibility: 'full',
    });
    expect(out).toMatch(/implied only|Do NOT render a full-face parent/i);
  });
});
