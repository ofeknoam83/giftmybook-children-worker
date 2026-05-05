/**
 * PR N.1 — createStoryBible prompt schema shape branches on age band.
 *
 * Background:
 *   The validator at services/bookPipeline/schema/validateBookDocument.js
 *   rejects PB_INFANT bibles with 3+ cinematicLocations. The prompt's
 *   prose infant clause already says "at most 2 connected micro-settings",
 *   but the JSON schema example in the same prompt was the toddler+ shape
 *   (`"3-5 specific photogenic settings...coastal lighthouse at dusk..."`).
 *   The model read both and predictably picked the schema example, hitting
 *   the validator hard. PR N.1 emits a band-shaped schema example so prose
 *   and schema agree.
 *
 *   These tests inspect the user prompt that createStoryBible would send
 *   to the LLM. We do NOT execute the LLM call — we mock callText, capture
 *   the prompt, and assert its shape.
 */

jest.mock('../../../services/bookPipeline/llm/openaiClient', () => ({
  callText: jest.fn(),
}));

const { callText } = require('../../../services/bookPipeline/llm/openaiClient');
const { createStoryBible } = require('../../../services/bookPipeline/planner/createStoryBible');
const { AGE_BANDS, FORMATS } = require('../../../services/bookPipeline/constants');

function buildDoc(ageBand, overrides = {}) {
  return {
    request: { ageBand, format: FORMATS.PICTURE_BOOK, theme: 'mothers_day', ...overrides.request },
    brief: {
      child: { name: 'Everleigh', age: ageBand === AGE_BANDS.PB_INFANT ? 0.7 : 4, gender: 'female' },
      customDetails: {},
      ...overrides.brief,
    },
    cover: { title: 'Everleigh and Mama' },
    retryMemory: [],
    trace: { llmCalls: [] },
    operationalContext: { bookId: 'test' },
    spreads: [],
    ...overrides,
  };
}

function captureUserPrompt(callTextMock) {
  // The most recent call's first argument has { systemPrompt, userPrompt, ... }.
  expect(callTextMock).toHaveBeenCalled();
  const args = callTextMock.mock.calls[callTextMock.mock.calls.length - 1][0];
  return args.userPrompt;
}

describe('PR N.1: createStoryBible JSON schema example branches by age band', () => {
  beforeEach(() => {
    callText.mockReset();
    callText.mockResolvedValue({
      json: {
        narrativeSpine: 'x', beginningHook: 'x', middleEscalation: 'x',
        endingPayoff: 'x', emotionalArc: 'x', humorStrategy: 'x',
        themeGuidance: 'x', personalizationTargets: ['a'],
        locationStrategy: 'x', cinematicLocations: ['a'],
        visualJourneySpine: 'x', recurringVisualMotifs: ['a'],
        forbiddenMoves: ['a'],
      },
      model: 'mock',
      attempts: 1,
      usage: {},
    });
  });

  describe('infant band (PB_INFANT)', () => {
    test('schema example caps cinematicLocations at 1-2 micro-settings (matches validator)', async () => {
      await createStoryBible(buildDoc(AGE_BANDS.PB_INFANT));
      const prompt = captureUserPrompt(callText);
      // The validator rejects 3+. The schema example MUST tell the model
      // to emit 1-2.
      expect(prompt).toMatch(/1-2 connected micro-settings/);
      expect(prompt).toMatch(/NEVER 3 or more locations/i);
    });

    test('schema example does NOT show toddler+ exemplar locations as positive examples', async () => {
      // The toddler+ exemplar phrases ("coastal lighthouse at dusk", etc.)
      // are exactly what the validator forbids for infants. They are fine
      // to appear inside a NEVER list ("NEVER a 'coastal lighthouse'")
      // because that explicitly steers the model away. What must NOT
      // appear is the toddler+ schema example's positive framing
      // ("e.g. coastal lighthouse at dusk") or the toddler+ count target.
      await createStoryBible(buildDoc(AGE_BANDS.PB_INFANT));
      const prompt = captureUserPrompt(callText);
      expect(prompt).not.toMatch(/3-5 specific photogenic settings/);
      expect(prompt).not.toMatch(/e\.g\.\s*a coastal lighthouse at dusk/);
      expect(prompt).not.toMatch(/Use real location types with time-of-day and weather/);
      // Confirm the verboten phrases only ever appear inside a NEVER
      // disclaimer, never as a positive exemplar the model should imitate.
      const lighthouseMatches = (prompt.match(/coastal lighthouse/gi) || []);
      for (const _m of lighthouseMatches) {
        // every occurrence must be on a line that contains "NEVER".
        const line = prompt.split(/\n+/).find(l => l.includes('coastal lighthouse'));
        expect(line).toMatch(/NEVER/);
      }
    });

    test('schema locationStrategy line frames the spine as contained sensory, not multi-location travel', async () => {
      await createStoryBible(buildDoc(AGE_BANDS.PB_INFANT));
      const prompt = captureUserPrompt(callText);
      expect(prompt).not.toMatch(/at least 4 visually distinct/);
      expect(prompt).toMatch(/contained sensory spine|1-2 connected micro-settings/);
    });

    test('schema visualJourneySpine line forbids quest framing for infants', async () => {
      await createStoryBible(buildDoc(AGE_BANDS.PB_INFANT));
      const prompt = captureUserPrompt(callText);
      // The toddler+ shape says "the mission, object, quest, or escalation".
      // The infant shape must NOT say that.
      expect(prompt).not.toMatch(/the mission, object, quest, or escalation/);
      expect(prompt).toMatch(/SENSORY thread|sensory thread that connects/);
    });

    test('schema example still asks for all the same fields (no schema-shape regression)', async () => {
      // Branching schema content is fine; branching schema KEYS would break
      // the parser at lines 121-135. Make sure every required key is still
      // present in the infant example.
      await createStoryBible(buildDoc(AGE_BANDS.PB_INFANT));
      const prompt = captureUserPrompt(callText);
      const requiredKeys = [
        'narrativeSpine', 'beginningHook', 'middleEscalation', 'endingPayoff',
        'emotionalArc', 'humorStrategy', 'themeGuidance', 'personalizationTargets',
        'locationStrategy', 'cinematicLocations', 'visualJourneySpine',
        'recurringVisualMotifs', 'forbiddenMoves',
      ];
      for (const key of requiredKeys) {
        expect(prompt).toContain(`"${key}"`);
      }
    });

    test('infant prompt still embeds the prose infant override clause (no regression)', async () => {
      await createStoryBible(buildDoc(AGE_BANDS.PB_INFANT));
      const prompt = captureUserPrompt(callText);
      expect(prompt).toMatch(/INFANT BAND.*SCOPE OVERRIDE/i);
      expect(prompt).toMatch(/lap-baby board book/);
    });
  });

  describe('toddler / preschool bands (no regression)', () => {
    test('toddler prompt still uses the rich travel-spine schema example', async () => {
      await createStoryBible(buildDoc(AGE_BANDS.PB_TODDLER));
      const prompt = captureUserPrompt(callText);
      expect(prompt).toMatch(/3-5 specific photogenic settings/);
      expect(prompt).toMatch(/coastal lighthouse at dusk/);
      expect(prompt).toMatch(/at least 4 visually distinct/);
    });

    test('preschool prompt still uses the rich travel-spine schema example', async () => {
      await createStoryBible(buildDoc(AGE_BANDS.PB_PRESCHOOL));
      const prompt = captureUserPrompt(callText);
      expect(prompt).toMatch(/3-5 specific photogenic settings/);
      expect(prompt).toMatch(/the mission, object, quest, or escalation/);
    });

    test('toddler / preschool prompts do NOT inherit the infant-specific schema language', async () => {
      const toddlerPrompt = await createStoryBible(buildDoc(AGE_BANDS.PB_TODDLER))
        .then(() => captureUserPrompt(callText));
      callText.mockClear();
      const preschoolPrompt = await createStoryBible(buildDoc(AGE_BANDS.PB_PRESCHOOL))
        .then(() => captureUserPrompt(callText));
      for (const p of [toddlerPrompt, preschoolPrompt]) {
        expect(p).not.toMatch(/1-2 connected micro-settings only/);
        expect(p).not.toMatch(/lap-baby board book/);
        expect(p).not.toMatch(/NEVER 3 or more locations/i);
      }
    });
  });
});
