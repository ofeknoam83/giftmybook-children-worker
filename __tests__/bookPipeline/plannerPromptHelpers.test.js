const {
  formatPlannerStorySeedAppendix,
  renderVarietySteeringFromBookId,
} = require('../../services/bookPipeline/planner/plannerPromptHelpers');

describe('plannerPromptHelpers', () => {
  it('formatPlannerStorySeedAppendix includes structured fields', () => {
    const s = formatPlannerStorySeedAppendix({
      storySeed: 'The map hums.',
      favorite_object: 'red wagon',
      setting: 'tide pools at dawn',
      repeated_phrase: 'one more step',
      beats: [{ description: 'First beat' }, 'Second beat'],
    });
    expect(s).toContain('story_seed_line:');
    expect(s).toContain('The map hums.');
    expect(s).toContain('favorite_object:');
    expect(s).toContain('red wagon');
    expect(s).toContain('brainstorm_beats:');
    expect(s).toContain('First beat');
    expect(s).toContain('Second beat');
  });

  it('renderVarietySteeringFromBookId is stable per bookId', () => {
    const a = renderVarietySteeringFromBookId('book-123');
    const b = renderVarietySteeringFromBookId('book-123');
    const c = renderVarietySteeringFromBookId('book-999');
    expect(a).toBe(b);
    expect(a).toContain('Cross-order variety');
    expect(c).not.toBe(a);
  });
});
