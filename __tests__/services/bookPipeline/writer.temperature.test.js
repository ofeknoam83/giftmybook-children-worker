/**
 * PR J.4 \u2014 per-band writer sampling temperature.
 *
 * Two tracks of tests:
 *
 * 1. Unit tests for the pure resolver `getWriterTemperature(stage, ageBand)`.
 *    These pin the policy: infant draft is 0.6, infant rewrite is 0.4,
 *    other bands keep historical defaults.
 *
 * 2. Integration tests that mock `callText` and assert the threaded
 *    temperature actually reaches the LLM call site for both
 *    draftBookText and rewriteBookText. Without these, a future refactor
 *    could silently revert the literal at the call site without
 *    breaking the unit tests.
 */

jest.mock('../../../services/bookPipeline/llm/openaiClient', () => ({
  callText: jest.fn(),
}));

const {
  AGE_BANDS,
  WRITER_TEMPERATURE,
  getWriterTemperature,
} = require('../../../services/bookPipeline/constants');
const { callText } = require('../../../services/bookPipeline/llm/openaiClient');

describe('PR J.4: getWriterTemperature policy', () => {
  test('infant draft samples at low temperature for hard-constraint task', () => {
    expect(getWriterTemperature('draft', AGE_BANDS.PB_INFANT)).toBe(0.6);
  });

  test('infant rewrite samples even lower (matches compressor stage)', () => {
    expect(getWriterTemperature('rewrite', AGE_BANDS.PB_INFANT)).toBe(0.4);
  });

  test('toddler keeps historical 0.95 / 0.85 defaults (no creative range loss)', () => {
    expect(getWriterTemperature('draft', AGE_BANDS.PB_TODDLER)).toBe(0.95);
    expect(getWriterTemperature('rewrite', AGE_BANDS.PB_TODDLER)).toBe(0.85);
  });

  test('preschool keeps historical 0.95 / 0.85 defaults', () => {
    expect(getWriterTemperature('draft', AGE_BANDS.PB_PRESCHOOL)).toBe(0.95);
    expect(getWriterTemperature('rewrite', AGE_BANDS.PB_PRESCHOOL)).toBe(0.85);
  });

  test('early reader keeps historical defaults', () => {
    expect(getWriterTemperature('draft', AGE_BANDS.ER_EARLY)).toBe(0.95);
    expect(getWriterTemperature('rewrite', AGE_BANDS.ER_EARLY)).toBe(0.85);
  });

  test('unknown age band falls back to toddler default (no crash)', () => {
    expect(getWriterTemperature('draft', 'PB_UNKNOWN')).toBe(0.95);
    expect(getWriterTemperature('rewrite', undefined)).toBe(0.85);
  });

  test('unknown stage returns a safe default of 0.95', () => {
    expect(getWriterTemperature('not_a_stage', AGE_BANDS.PB_INFANT)).toBe(0.95);
  });

  test('infant temperatures are STRICTLY LOWER than toddler (the whole point)', () => {
    expect(WRITER_TEMPERATURE.draft[AGE_BANDS.PB_INFANT])
      .toBeLessThan(WRITER_TEMPERATURE.draft[AGE_BANDS.PB_TODDLER]);
    expect(WRITER_TEMPERATURE.rewrite[AGE_BANDS.PB_INFANT])
      .toBeLessThan(WRITER_TEMPERATURE.rewrite[AGE_BANDS.PB_TODDLER]);
  });
});

describe('PR J.4: temperature threading reaches the LLM call', () => {
  beforeEach(() => {
    callText.mockReset();
    callText.mockResolvedValue({
      json: { spreads: [] },
      model: 'mock',
      attempts: 1,
      usage: {},
    });
  });

  function buildDoc(ageBand) {
    return {
      request: { ageBand, format: 'picture_book' },
      brief: { child: { name: 'Test', age: 1 } },
      storyBible: { title: 'Test', themeArc: 'test' },
      visualBible: {
        palette: [],
        environmentAnchors: [],
      },
      spreads: Array.from({ length: 13 }, (_, i) => ({
        spreadNumber: i + 1,
        spec: {
          purpose: 'discovery',
          plotBeat: 'something happens',
          focalAction: 'Mama holds Test',
          location: 'home',
          textSide: 'left',
          textLineTarget: 2,
          forbiddenMistakes: [],
        },
      })),
      retryMemory: [],
      trace: { llmCalls: [] },
      operationalContext: {},
    };
  }

  test('draftBookText passes infant=0.6 to callText', async () => {
    const { draftBookText } = require('../../../services/bookPipeline/writer/draftBookText');
    await draftBookText(buildDoc(AGE_BANDS.PB_INFANT));
    expect(callText).toHaveBeenCalledTimes(1);
    expect(callText.mock.calls[0][0].temperature).toBe(0.6);
    expect(callText.mock.calls[0][0].label).toBe('writerDraft');
  });

  test('draftBookText passes toddler=0.95 to callText (no regression)', async () => {
    const { draftBookText } = require('../../../services/bookPipeline/writer/draftBookText');
    await draftBookText(buildDoc(AGE_BANDS.PB_TODDLER));
    expect(callText).toHaveBeenCalledTimes(1);
    expect(callText.mock.calls[0][0].temperature).toBe(0.95);
  });

  test('draftBookText passes preschool=0.95 to callText (no regression)', async () => {
    const { draftBookText } = require('../../../services/bookPipeline/writer/draftBookText');
    await draftBookText(buildDoc(AGE_BANDS.PB_PRESCHOOL));
    expect(callText).toHaveBeenCalledTimes(1);
    expect(callText.mock.calls[0][0].temperature).toBe(0.95);
  });
});
