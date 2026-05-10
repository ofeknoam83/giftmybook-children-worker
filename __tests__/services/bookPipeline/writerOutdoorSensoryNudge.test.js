/**
 * Phase-X — outdoor-sensory budget block for outdoor-weather infant books.
 *
 * The nudge fires when the story bible names porch / garden / river / park /
 * walk / spring / etc. in moment / weather / locationStrategy / motifs. When
 * it fires, the writer is asked to land at least 5 outdoor sensory anchors
 * across the 13 spreads — addresses the "13 spreads of Mama holds her /
 * blanket / hum / dozes" failure mode on outdoor infant books.
 */

const {
  renderOutdoorSensoryNudge,
} = require('../../../services/bookPipeline/writer/draftBookText');

describe('renderOutdoorSensoryNudge (Phase-X)', () => {
  test('returns empty string for null / empty / non-outdoor bibles', () => {
    expect(renderOutdoorSensoryNudge(null)).toBe('');
    expect(renderOutdoorSensoryNudge({})).toBe('');
    expect(renderOutdoorSensoryNudge({
      moment: 'the slow Saturday afternoon between nap and supper',
      weather: 'soft golden light',
      locationStrategy: 'kitchen window and crib',
      cinematicLocations: ['kitchen window at morning', 'crib at nap-light'],
    })).toBe('');
  });

  test('emits the budget block when weather mentions an outdoor cue', () => {
    const out = renderOutdoorSensoryNudge({
      weather: 'late-spring sunlight, warm and slow',
      locationStrategy: 'two micro-settings: the kitchen and the crib',
    });
    expect(out).toContain('### OUTDOOR-SENSORY BUDGET');
    expect(out).toContain('FIVE outdoor sensory anchors');
    expect(out).toContain('petal');
    expect(out).toContain('breeze');
  });

  test('emits the block when locationStrategy mentions porch / garden / river', () => {
    const out = renderOutdoorSensoryNudge({
      locationStrategy: 'a continuous outdoor walk: front stoop, garden path, river-edge bench',
      cinematicLocations: ['front stoop', 'garden path', 'river-edge bench'],
    });
    expect(out).toContain('### OUTDOOR-SENSORY BUDGET');
  });

  test('emits the block when moment names a walk / stroll', () => {
    const out = renderOutdoorSensoryNudge({
      moment: 'the bright springtime walk from the front stoop to the river',
    });
    expect(out).toContain('### OUTDOOR-SENSORY BUDGET');
  });

  test('keyword detection is whole-word, not substring (no "outline" → outdoor)', () => {
    expect(renderOutdoorSensoryNudge({
      moment: 'A quiet outline of the day, rocking near the cot',
      weather: 'warm interior light',
    })).toBe('');
  });
});
