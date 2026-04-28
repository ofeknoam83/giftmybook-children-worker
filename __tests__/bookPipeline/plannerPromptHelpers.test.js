const {
  formatPlannerStorySeedAppendix,
  renderVarietySteeringFromBookId,
  renderPrimarySettingSteeringFromBookId,
  customDetailsMentionHomeContext,
  shouldInjectBrainstormHomeTranslation,
  storySeedMentionHomeContext,
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

  it('renderPrimarySettingSteeringFromBookId is stable per bookId and varies across ids', () => {
    const a = renderPrimarySettingSteeringFromBookId('book-123');
    const b = renderPrimarySettingSteeringFromBookId('book-123');
    const c = renderPrimarySettingSteeringFromBookId('book-999');
    expect(a).toBe(b);
    expect(a).toContain('Cross-order setting variety');
    expect(a).toContain('Primary spectacle bias');
    expect(c).not.toBe(a);
  });

  it('customDetailsMentionHomeContext matches home-adjacent phrases', () => {
    expect(customDetailsMentionHomeContext('We bake cookies in the kitchen')).toBe(true);
    expect(customDetailsMentionHomeContext('loves the couch')).toBe(true);
    expect(customDetailsMentionHomeContext('adventure on the moon')).toBe(false);
    expect(customDetailsMentionHomeContext('')).toBe(false);
    expect(customDetailsMentionHomeContext(null)).toBe(false);
  });

  it('shouldInjectBrainstormHomeTranslation is limited to occasion themes', () => {
    expect(shouldInjectBrainstormHomeTranslation('mothers_day', 'kitchen cookies')).toBe(true);
    expect(shouldInjectBrainstormHomeTranslation('adventure', 'kitchen cookies')).toBe(false);
    expect(shouldInjectBrainstormHomeTranslation('mothers_day', 'only rockets')).toBe(false);
  });

  it('storySeedMentionHomeContext reads setting and beats', () => {
    expect(
      storySeedMentionHomeContext({
        setting: 'a cozy apartment kitchen',
        narrative_spine: 'They explore',
        storySeed: '',
        beats: [],
      }),
    ).toBe(true);
    expect(
      storySeedMentionHomeContext({
        setting: 'orbital garden',
        narrative_spine: 'They explore',
        storySeed: '',
        beats: ['hallway to the airlock'],
      }),
    ).toBe(true);
    expect(
      storySeedMentionHomeContext({
        setting: 'the rings of Saturn',
        narrative_spine: 'They explore',
        storySeed: '',
        beats: [],
      }),
    ).toBe(false);
  });
});
