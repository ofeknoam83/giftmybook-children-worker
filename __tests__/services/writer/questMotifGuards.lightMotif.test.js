const {
  detectParentGiftPersonifiedLightMotifInStory,
  plannerLightMothBriefOptIn,
  plannerOptInDetailBlob,
} = require('../../../services/writer/questMotifGuards');
const { QualityGate } = require('../../../services/writer/quality/gate');

describe('questMotifGuards — personified light heuristic', () => {
  test('detects MrLight-style names', () => {
    expect(detectParentGiftPersonifiedLightMotifInStory('MrLight danced over town.')).toBe(true);
    expect(detectParentGiftPersonifiedLightMotifInStory('Mr. Light smiled down.')).toBe(true);
  });

  test('detects light/gleam that blinks out or wakes', () => {
    expect(detectParentGiftPersonifiedLightMotifInStory('Her gleam blinked out that night.')).toBe(true);
    expect(detectParentGiftPersonifiedLightMotifInStory('The beam flickered back to bright.')).toBe(true);
  });

  test('does not trip on benign ambient lighting wording', () => {
    expect(detectParentGiftPersonifiedLightMotifInStory('Warm café lamps glowed on the sill.')).toBe(false);
    expect(detectParentGiftPersonifiedLightMotifInStory('Warm round lights blinked out along the pier.')).toBe(false);
  });

  test('QualityGate vets mothers_day when motif present and brief thin', async () => {
    const story = {
      spreads: [
        { spread: 1, text: 'MrLight flickered overhead.', scene: 'Café dusk' },
        { spread: 2, text: 'We ran downstairs.', scene: 'Stoop' },
      ],
    };
    const child = { name: 'J', age: 5 };
    const book = { theme: 'mothers_day', customDetails: '' };

    const res = await QualityGate.check(story, child, book, {});
    expect(res.pass).toBe(false);
    expect(res.issues.some(i => i.dimension === 'questMotif')).toBe(true);
    expect(res.deterministicVetoes.questMotifPersonifiedLight).toBe(true);
  });

  test('QualityGate skips when questionnaire opts into lantern fantasy', async () => {
    const story = {
      spreads: [
        { spread: 1, text: 'Mr. Light waved from the prism.', scene: 'Lighthouse stairs' },
      ],
    };
    const child = { name: 'J', age: 5, anecdotes: {}, interests: ['lantern tales'] };

    const res = await QualityGate.check(story, child, {
      theme: 'mothers_day',
      customDetails: '',
      heartfeltNote: null,
    }, {});
    expect(res.deterministicVetoes.questMotifPersonifiedLight).toBe(false);
    expect(res.pass).toBe(true);
  });

  test('plannerOptInDetailBlob stringifies object customDetails for opt-in scans', () => {
    expect(plannerLightMothBriefOptIn(
      { anecdotes: {}, interests: ['soccer'] },
      plannerOptInDetailBlob({
        customDetails: { fave: 'loves lantern walks' },
      }),
    )).toBe(true);
  });
});
