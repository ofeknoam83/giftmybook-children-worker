/**
 * Phase 1 — thicker-bible structural gates.
 *
 * The planner now emits voiceCard, moment, weather, ritual (optional),
 * refrain { text, plant, deepen, transform }, openingImage, closingCallback.
 * Downstream stages depend on these, so the validator gates must reject
 * partial output and trigger the existing planner retry budget.
 */

const {
  validateStoryBible,
} = require('../../../services/bookPipeline/schema/validateBookDocument');
const { AGE_BANDS, FORMATS } = require('../../../services/bookPipeline/constants');

function buildDoc(sbOverrides = {}) {
  const baseSb = {
    narrativeSpine: 'Scarlett follows the warm light through one quiet day.',
    beginningHook: 'Mama lifts Scarlett to see the morning light on the wall.',
    middleEscalation: 'Together they follow the sun through kitchen and porch.',
    endingPayoff: 'Scarlett snuggles into Mama as the day softens to evening.',
    emotionalArc: 'Curious — warm — calm.',
    humorStrategy: 'The cat curls into Mama\'s lap, surprising Scarlett.',
    locationStrategy: 'Two connected micro-settings: kitchen window and porch.',
    visualJourneySpine: 'A warm beam of light travels from kitchen to porch across the day, threading both spaces.',
    recurringVisualMotifs: ['warm light', 'Mama\'s hands', 'soft blanket'],
    personalizationTargets: ['Mama Courtney', 'nickname Smushy'],
    cinematicLocations: ['kitchen window at morning', 'porch at midday'],
    forbiddenMoves: ['locomotion'],
    // Phase 1 thicker bible — strong defaults so individual tests can
    // override the one field they're exercising.
    moment: 'the slow Saturday afternoon between nap and supper',
    weather: 'late-afternoon honey light, warm and slow',
    ritual: { name: 'three deep breaths and a wink', description: 'Mama and Scarlett do this before going outside, every time.' },
    voiceCard: {
      narratorPOV: 'third-person warm',
      tonalRegister: 'gentle, slightly wry, never cute',
      signatureMove: 'a tiny sound-word at the start of each new room',
      refrainSeed: 'the warm light finds us',
    },
    refrain: {
      text: 'the warm light finds us here',
      plant: 2,
      deepen: 7,
      transform: 12,
    },
    openingImage: 'a sun-shaped beam on the kitchen wall, slowly moving',
    closingCallback: 'the same beam, now on the porch ceiling, has reached us at last',
  };
  return {
    request: { ageBand: AGE_BANDS.PB_INFANT, format: FORMATS.PICTURE_BOOK, theme: 'mothers_day', bookId: 'b-thick' },
    storyBible: { ...baseSb, ...sbOverrides },
  };
}

function passesThickerGates(doc) {
  const issues = validateStoryBible(doc);
  const thicker = issues.filter(i =>
    i.includes('moment')
    || i.includes('weather')
    || i.includes('ritual')
    || i.includes('voiceCard')
    || i.includes('refrain')
    || i.includes('openingImage')
    || i.includes('closingCallback'),
  );
  return { ok: thicker.length === 0, thicker };
}

describe('validateStoryBible — Phase 1 thicker bible', () => {
  test('a fully-emitted bible passes the new structural gates', () => {
    const { ok, thicker } = passesThickerGates(buildDoc());
    expect({ ok, thicker }).toEqual({ ok: true, thicker: [] });
  });

  test('weak moment is flagged', () => {
    const { thicker } = passesThickerGates(buildDoc({ moment: 'bedtime' }));
    expect(thicker.some(i => i.includes('storyBible.moment weak'))).toBe(true);
  });

  test('missing weather is flagged', () => {
    const { thicker } = passesThickerGates(buildDoc({ weather: '' }));
    expect(thicker.some(i => i.includes('storyBible.weather weak'))).toBe(true);
  });

  test('null ritual is allowed (rituals are optional)', () => {
    const { ok } = passesThickerGates(buildDoc({ ritual: null }));
    expect(ok).toBe(true);
  });

  test('partial ritual (only name, no description) is flagged', () => {
    const { thicker } = passesThickerGates(buildDoc({ ritual: { name: 'tap the door three times', description: '' } }));
    expect(thicker.some(i => i.includes('storyBible.ritual partial'))).toBe(true);
  });

  test('missing voiceCard fields are flagged per-field', () => {
    const { thicker } = passesThickerGates(buildDoc({
      voiceCard: { narratorPOV: 'third-person warm', tonalRegister: '', signatureMove: '', refrainSeed: 'x' },
    }));
    expect(thicker.some(i => i.includes('voiceCard.tonalRegister weak'))).toBe(true);
    expect(thicker.some(i => i.includes('voiceCard.signatureMove weak'))).toBe(true);
    expect(thicker.some(i => i.includes('voiceCard.refrainSeed weak'))).toBe(true);
    expect(thicker.some(i => i.includes('voiceCard.narratorPOV weak'))).toBe(false);
  });

  test('refrain text outside 4-12 words is flagged', () => {
    const tooShort = passesThickerGates(buildDoc({ refrain: { text: 'hi mama hi', plant: 2, deepen: 7, transform: 12 } }));
    expect(tooShort.thicker.some(i => i.includes('refrain.text must be 4-12 words'))).toBe(true);
    const tooLong = passesThickerGates(buildDoc({
      refrain: {
        text: 'one two three four five six seven eight nine ten eleven twelve thirteen',
        plant: 2, deepen: 7, transform: 12,
      },
    }));
    expect(tooLong.thicker.some(i => i.includes('refrain.text must be 4-12 words'))).toBe(true);
  });

  test('refrain plant/deepen/transform must fall in their structural windows', () => {
    const wrongPlant = passesThickerGates(buildDoc({
      refrain: { text: 'the warm light finds us here', plant: 5, deepen: 7, transform: 12 },
    }));
    expect(wrongPlant.thicker.some(i => i.includes('refrain.plant must be an integer in 1..4'))).toBe(true);

    const wrongTransform = passesThickerGates(buildDoc({
      refrain: { text: 'the warm light finds us here', plant: 2, deepen: 7, transform: 9 },
    }));
    expect(wrongTransform.thicker.some(i => i.includes('refrain.transform must be an integer in 10..13'))).toBe(true);
  });

  test('openingImage / closingCallback must be concrete (length >= 12)', () => {
    const weakOpen = passesThickerGates(buildDoc({ openingImage: 'a kid' }));
    expect(weakOpen.thicker.some(i => i.includes('openingImage weak'))).toBe(true);
    const weakClose = passesThickerGates(buildDoc({ closingCallback: 'happy' }));
    expect(weakClose.thicker.some(i => i.includes('closingCallback weak'))).toBe(true);
  });
});
