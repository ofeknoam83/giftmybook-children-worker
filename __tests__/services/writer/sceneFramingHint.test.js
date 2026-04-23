const { sceneHasFramingHint } = require('../../../services/writer/sceneFramingHint');

describe('sceneHasFramingHint', () => {
  test('returns false for empty or non-string', () => {
    expect(sceneHasFramingHint('')).toBe(false);
    expect(sceneHasFramingHint(null)).toBe(false);
    expect(sceneHasFramingHint(undefined)).toBe(false);
  });

  test('detects common viewpoint phrases', () => {
    expect(sceneHasFramingHint('Wide shot of the harbor at dawn.')).toBe(true);
    expect(sceneHasFramingHint('Low angle toward the clock tower.')).toBe(true);
    expect(sceneHasFramingHint('Over-the-shoulder view of the gate.')).toBe(true);
    expect(sceneHasFramingHint('Medium framing on the hero at the fountain.')).toBe(true);
    expect(sceneHasFramingHint('Close-up on hands and the red balloon.')).toBe(true);
  });

  test('returns false when scene is only action and place with no framing', () => {
    expect(sceneHasFramingHint('At the tide pools, the child crouches and points at a crab, afternoon sun, wet rocks.')).toBe(false);
  });
});
