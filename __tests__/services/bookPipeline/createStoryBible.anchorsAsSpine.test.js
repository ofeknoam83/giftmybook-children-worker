/**
 * PR Z — createStoryBible promotes anchors to be the BOOK SUBJECT.
 *
 * The post-PR-Y manuscript shipped 13 interchangeable couplets with anchor
 * tokens sprinkled in. PR Z rewrites the story-bible system prompt to lead
 * with "this book is ABOUT these specific moments" and renders a deterministic
 * BOOK SUBJECT block at the TOP of the userPrompt — before any abstract
 * narrative theory.
 *
 * These tests inspect both the system prompt (constant) and the rendered
 * userPrompt for a Scarlett-style brief.
 */

jest.mock('../../../services/bookPipeline/llm/openaiClient', () => ({
  callText: jest.fn(),
}));

const { callText } = require('../../../services/bookPipeline/llm/openaiClient');
const { createStoryBible } = require('../../../services/bookPipeline/planner/createStoryBible');
const { AGE_BANDS, FORMATS } = require('../../../services/bookPipeline/constants');

function buildDoc(overrides = {}) {
  return {
    request: {
      ageBand: AGE_BANDS.PB_INFANT,
      format: FORMATS.PICTURE_BOOK,
      theme: 'mothers_day',
      ...overrides.request,
    },
    brief: {
      child: {
        name: 'Scarlett',
        age: 0.7,
        gender: 'female',
        anecdotes: {
          meaningful_moment: 'first time she squealed in the bath',
          moms_favorite_moment: 'morning snuggle in pajamas with Courtney',
          funny_thing: 'bites mama on the chin',
          anything_else: 'we call her smushy',
          calls_mom: 'Mama',
        },
      },
      customDetails: {},
      ...overrides.brief,
    },
    cover: { title: 'Scarlett and Mama' },
    retryMemory: [],
    trace: { llmCalls: [] },
    operationalContext: { bookId: 'pr-z-test' },
    spreads: [],
    ...overrides,
  };
}

function captureCall(callTextMock) {
  expect(callTextMock).toHaveBeenCalled();
  return callTextMock.mock.calls[callTextMock.mock.calls.length - 1][0];
}

describe('PR Z: createStoryBible system prompt promotes anchors to subject', () => {
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

  test('system prompt leads with ANCHORS ARE THE SUBJECT directive', async () => {
    await createStoryBible(buildDoc());
    const { systemPrompt } = captureCall(callText);
    expect(systemPrompt).toMatch(/ANCHORS ARE THE SUBJECT/);
    // The directive must explicitly forbid paraphrasing the load-bearing words.
    expect(systemPrompt).toMatch(/never\s+"nibbles"|NOT\s+"nibbles"/i);
    expect(systemPrompt).toMatch(/smushy/);
  });

  test('system prompt names anti-padding compression policy', async () => {
    await createStoryBible(buildDoc());
    const { systemPrompt } = captureCall(callText);
    expect(systemPrompt).toMatch(/Anti-padding compression/);
    expect(systemPrompt).toMatch(/sensory bridges/i);
  });

  test('userPrompt renders BOOK SUBJECT block listing every signature beat verbatim', async () => {
    await createStoryBible(buildDoc());
    const { userPrompt } = captureCall(callText);
    expect(userPrompt).toMatch(/BOOK SUBJECT/);
    // Every signature beat appears verbatim.
    expect(userPrompt).toContain('first time she squealed in the bath');
    expect(userPrompt).toContain('morning snuggle in pajamas with Courtney');
    expect(userPrompt).toContain('bites mama on the chin');
    expect(userPrompt).toContain('we call her smushy');
    expect(userPrompt).toMatch(/calls_mom.*Mama/);
  });

  test('BOOK SUBJECT block appears BEFORE the personalization snapshot block', async () => {
    await createStoryBible(buildDoc());
    const { userPrompt } = captureCall(callText);
    const subjectIdx = userPrompt.indexOf('BOOK SUBJECT');
    const snapshotIdx = userPrompt.indexOf('PERSONALIZATION SNAPSHOT');
    expect(subjectIdx).toBeGreaterThan(-1);
    expect(snapshotIdx).toBeGreaterThan(-1);
    expect(subjectIdx).toBeLessThan(snapshotIdx);
  });

  test('BOOK SUBJECT block carries the compression-mode directive', async () => {
    await createStoryBible(buildDoc());
    const { userPrompt } = captureCall(callText);
    // 4 text beats → "rich" mode message.
    expect(userPrompt).toMatch(/ANCHOR DENSITY:\s*rich/);
  });

  test('empty anecdotes: no BOOK SUBJECT block (not relevant) and prompt still renders', async () => {
    const doc = buildDoc({ brief: { child: { name: 'Scarlett', age: 0.7, gender: 'female' }, customDetails: {} } });
    await createStoryBible(doc);
    const { userPrompt } = captureCall(callText);
    expect(userPrompt).not.toMatch(/BOOK SUBJECT/);
    // The rest of the prompt structure must still be present.
    expect(userPrompt).toMatch(/Approved cover title/);
  });
});
