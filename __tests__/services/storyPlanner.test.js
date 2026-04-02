jest.mock('openai');

const OpenAI = require('openai');

// Set env before requiring storyPlanner
process.env.OPENAI_API_KEY = 'test-key';

const validPlan = {
  title: 'Emma and the Magic Garden',
  spreads: Array.from({ length: 14 }, (_, i) => ({
    spreadNumber: i + 1,
    text: `Spread ${i + 1} text here with some words.`,
    illustrationDescription: `Scene ${i + 1} description`,
    layoutType: 'TEXT_BOTTOM',
    mood: 'cheerful',
  })),
};

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
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// Need to require after mock setup
const { planStory } = require('../../services/storyPlanner');

describe('planStory', () => {
  const childDetails = {
    name: 'Emma',
    age: 5,
    gender: 'female',
    interests: ['dinosaurs'],
  };

  test('returns valid plan for picture book', async () => {
    // First call: story plan, second call: rhyme pass
    mockCreate
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify(validPlan) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 500, completion_tokens: 2000 },
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ spreads: validPlan.spreads }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 300, completion_tokens: 1000 },
      });

    const plan = await planStory(childDetails, 'adventure', 'picture_book', '');
    expect(plan.title).toBe('Emma and the Magic Garden');
    expect(plan.spreads.length).toBe(14);
    expect(plan.spreads[0].spreadNumber).toBe(1);
  });

  test('truncates plans with more than 16 spreads', async () => {
    const longPlan = {
      title: 'Long Story',
      spreads: Array.from({ length: 20 }, (_, i) => ({
        spreadNumber: i + 1,
        text: `Text ${i + 1}`,
        illustrationDescription: `Desc ${i + 1}`,
        layoutType: 'TEXT_BOTTOM',
        mood: 'cheerful',
      })),
    };

    mockCreate
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify(longPlan) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 500, completion_tokens: 3000 },
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ spreads: longPlan.spreads.slice(0, 16) }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 300, completion_tokens: 1000 },
      });

    const plan = await planStory(childDetails, 'adventure', 'picture_book', '');
    expect(plan.spreads.length).toBeLessThanOrEqual(16);
    // Spreads should be re-numbered sequentially
    plan.spreads.forEach((s, i) => {
      expect(s.spreadNumber).toBe(i + 1);
    });
  });

  test('throws on API error', async () => {
    mockCreate.mockRejectedValue(new Error('API rate limit'));

    await expect(planStory(childDetails, 'adventure', 'picture_book', ''))
      .rejects.toThrow('Story planner API call failed');
  });

  test('throws on empty response', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '' }, finish_reason: 'stop' }],
      usage: {},
    });

    await expect(planStory(childDetails, 'adventure', 'picture_book', ''))
      .rejects.toThrow('Empty response');
  });

  test('throws on invalid plan structure', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ title: 'Test' }) }, finish_reason: 'stop' }],
      usage: {},
    });

    await expect(planStory(childDetails, 'adventure', 'early_reader', ''))
      .rejects.toThrow('Invalid story plan');
  });

  test('tracks costs when costTracker provided', async () => {
    mockCreate
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify(validPlan) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 500, completion_tokens: 2000 },
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ spreads: validPlan.spreads }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 300, completion_tokens: 1000 },
      });

    const costTracker = { addTextUsage: jest.fn() };
    await planStory(childDetails, 'adventure', 'picture_book', '', { costTracker });
    expect(costTracker.addTextUsage).toHaveBeenCalledWith('gpt-5.4', 500, 2000);
  });

  test('defaults invalid layoutType to TEXT_BOTTOM', async () => {
    const planWithBadLayout = {
      ...validPlan,
      spreads: [{ spreadNumber: 1, text: 'test', layoutType: 'INVALID', mood: 'happy' }],
    };

    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(planWithBadLayout) }, finish_reason: 'stop' }],
      usage: {},
    });

    const plan = await planStory(childDetails, 'adventure', 'early_reader', '');
    expect(plan.spreads[0].layoutType).toBe('TEXT_BOTTOM');
  });
});
