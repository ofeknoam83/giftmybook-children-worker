jest.mock('../../services/gemini');

const gemini = require('../../services/gemini');

process.env.GEMINI_API_KEY = 'test-gemini-key';

/**
 * Mocks a successful Gemini `generateContent` REST response.
 * @param {string} text
 * @param {number} [inputTokens]
 * @param {number} [outputTokens]
 */
function mockGeminiFetchResponse(text, inputTokens = 200, outputTokens = 50) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: inputTokens, candidatesTokenCount: outputTokens },
    }),
  };
}

beforeEach(() => {
  global.fetch = jest.fn().mockImplementation(() => Promise.resolve(mockGeminiFetchResponse('fallback')));
  gemini.generateContent.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

const { generateSpreadText } = require('../../services/textGenerator');

describe('generateSpreadText', () => {
  const spreadPlan = {
    spreadNumber: 1,
    text: 'Emma finds a magic flower',
    illustrationDescription: 'A child discovering a glowing flower',
    layoutType: 'TEXT_BOTTOM',
    mood: 'cheerful',
  };

  const childDetails = {
    name: 'Emma',
    age: 5,
    gender: 'female',
  };

  const storyContext = {
    title: 'Emma and the Magic Garden',
    previousSpreads: [],
    totalSpreads: 14,
  };

  test('generates and returns text', async () => {
    global.fetch.mockResolvedValue(
      mockGeminiFetchResponse('Emma found a flower that glowed so bright, it lit up the garden with golden light.'),
    );
    gemini.generateContent.mockResolvedValue({ text: 'no changes needed', inputTokens: 10, outputTokens: 5 });

    const text = await generateSpreadText(spreadPlan, childDetails, 'picture_book', storyContext);
    expect(text).toContain('Emma');
    expect(text).toContain('flower');
  });

  test('strips markdown formatting', async () => {
    global.fetch.mockResolvedValue(
      mockGeminiFetchResponse('## Title\n**Emma** found a *magic* flower.'),
    );
    gemini.generateContent.mockResolvedValue({ text: 'no changes', inputTokens: 0, outputTokens: 0 });

    const text = await generateSpreadText(spreadPlan, childDetails, 'picture_book', storyContext);
    expect(text).not.toContain('##');
    expect(text).not.toContain('**');
    expect(text).not.toContain('*');
  });

  test('uses vocabulary-corrected text when Gemini suggests changes', async () => {
    global.fetch.mockResolvedValue(mockGeminiFetchResponse('Emma discovered an extraordinary phenomenon.'));
    gemini.generateContent.mockResolvedValue({
      text: JSON.stringify({
        approved: false,
        suggestion: 'Emma found something amazing and wonderful.',
      }),
      inputTokens: 10,
      outputTokens: 10,
    });

    const text = await generateSpreadText(spreadPlan, childDetails, 'picture_book', storyContext);
    expect(text).toBe('Emma found something amazing and wonderful.');
  });

  test('falls back to original text when vocab check fails', async () => {
    global.fetch.mockResolvedValue(mockGeminiFetchResponse('Emma found a flower.'));
    gemini.generateContent.mockRejectedValue(new Error('Gemini unavailable'));

    const text = await generateSpreadText(spreadPlan, childDetails, 'picture_book', storyContext);
    expect(text).toBe('Emma found a flower.');
  });

  test('throws on empty response', async () => {
    global.fetch.mockResolvedValue(mockGeminiFetchResponse(''));

    await expect(generateSpreadText(spreadPlan, childDetails, 'picture_book', storyContext))
      .rejects.toThrow('Empty text response');
  });

  test('tracks costs when costTracker provided', async () => {
    global.fetch.mockResolvedValue(mockGeminiFetchResponse('Some text here.', 200, 50));
    gemini.generateContent.mockResolvedValue({ text: 'no changes', inputTokens: 10, outputTokens: 5 });

    const costTracker = { addTextUsage: jest.fn() };
    await generateSpreadText(spreadPlan, childDetails, 'picture_book', storyContext, { costTracker });

    expect(costTracker.addTextUsage).toHaveBeenCalledWith('gemini-2.5-flash', 200, 50);
    expect(costTracker.addTextUsage).toHaveBeenCalledWith('gemini-2.5-flash', 10, 5);
  });

  test('handles gemini returning string (backwards compat)', async () => {
    global.fetch.mockResolvedValue(mockGeminiFetchResponse('Emma found a flower.'));
    gemini.generateContent.mockResolvedValue('no changes needed');

    const text = await generateSpreadText(spreadPlan, childDetails, 'picture_book', storyContext);
    expect(text).toBe('Emma found a flower.');
  });
});
