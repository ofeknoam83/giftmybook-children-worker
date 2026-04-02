jest.mock('openai');
jest.mock('../../services/gemini');

const OpenAI = require('openai');
const gemini = require('../../services/gemini');

// Set env before requiring module
process.env.OPENAI_API_KEY = 'test-key';

const mockCreate = jest.fn();

beforeAll(() => {
  OpenAI.mockImplementation(() => ({
    chat: {
      completions: { create: mockCreate },
    },
  }));
});

beforeEach(() => {
  mockCreate.mockReset();
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
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Emma found a flower that glowed so bright, it lit up the garden with golden light.' } }],
      usage: { prompt_tokens: 200, completion_tokens: 50 },
    });
    gemini.generateContent.mockResolvedValue({ text: 'no changes needed', inputTokens: 10, outputTokens: 5 });

    const text = await generateSpreadText(spreadPlan, childDetails, 'picture_book', storyContext);
    expect(text).toContain('Emma');
    expect(text).toContain('flower');
  });

  test('strips markdown formatting', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '## Title\n**Emma** found a *magic* flower.' } }],
      usage: {},
    });
    gemini.generateContent.mockResolvedValue({ text: 'no changes', inputTokens: 0, outputTokens: 0 });

    const text = await generateSpreadText(spreadPlan, childDetails, 'picture_book', storyContext);
    expect(text).not.toContain('##');
    expect(text).not.toContain('**');
    expect(text).not.toContain('*');
  });

  test('uses vocabulary-corrected text when Gemini suggests changes', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Emma discovered an extraordinary phenomenon.' } }],
      usage: {},
    });
    gemini.generateContent.mockResolvedValue({
      text: 'Emma found something amazing and wonderful.',
      inputTokens: 10,
      outputTokens: 10,
    });

    const text = await generateSpreadText(spreadPlan, childDetails, 'picture_book', storyContext);
    expect(text).toBe('Emma found something amazing and wonderful.');
  });

  test('falls back to original text when vocab check fails', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Emma found a flower.' } }],
      usage: {},
    });
    gemini.generateContent.mockRejectedValue(new Error('Gemini unavailable'));

    const text = await generateSpreadText(spreadPlan, childDetails, 'picture_book', storyContext);
    expect(text).toBe('Emma found a flower.');
  });

  test('throws on empty response', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '' } }],
      usage: {},
    });

    await expect(generateSpreadText(spreadPlan, childDetails, 'picture_book', storyContext))
      .rejects.toThrow('Empty text response');
  });

  test('tracks costs when costTracker provided', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Some text here.' } }],
      usage: { prompt_tokens: 200, completion_tokens: 50 },
    });
    gemini.generateContent.mockResolvedValue({ text: 'no changes', inputTokens: 10, outputTokens: 5 });

    const costTracker = { addTextUsage: jest.fn() };
    await generateSpreadText(spreadPlan, childDetails, 'picture_book', storyContext, { costTracker });

    expect(costTracker.addTextUsage).toHaveBeenCalledWith('gpt-5.4', 200, 50);
    expect(costTracker.addTextUsage).toHaveBeenCalledWith('gemini-2.5-flash', 10, 5);
  });

  test('handles gemini returning string (backwards compat)', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Emma found a flower.' } }],
      usage: {},
    });
    // Old-style string return
    gemini.generateContent.mockResolvedValue('no changes needed');

    const text = await generateSpreadText(spreadPlan, childDetails, 'picture_book', storyContext);
    expect(text).toBe('Emma found a flower.');
  });
});
