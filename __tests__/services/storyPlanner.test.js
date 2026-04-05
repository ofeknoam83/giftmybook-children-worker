// Set env before requiring storyPlanner
process.env.OPENAI_API_KEY = 'test-key';
process.env.GEMINI_API_KEY = 'test-gemini-key';

const validPlan = {
  title: 'Emma and the Magic Garden',
  entries: [
    { type: 'dedication_page', text: 'For Emma' },
    ...Array.from({ length: 12 }, (_, i) => ({
      type: 'spread',
      spread: i + 1,
      left: { text: `Spread ${i + 1} left text.` },
      right: { text: `Spread ${i + 1} right text.` },
      spread_image_prompt: `Scene ${i + 1} description`,
    })),
  ],
};

const longPlan = {
  title: 'Long Story',
  entries: [
    { type: 'dedication_page', text: 'For someone' },
    ...Array.from({ length: 18 }, (_, i) => ({
      type: 'spread',
      spread: i + 1,
      left: { text: `Text ${i + 1}` },
      right: { text: null },
      spread_image_prompt: `Desc ${i + 1}`,
    })),
  ],
};

function makeFetchResponse(plan) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(plan) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 500, completion_tokens: 2000 },
    }),
  };
}

const originalFetch = global.fetch;

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

const { planStory } = require('../../services/storyPlanner');

describe('planStory', () => {
  const childDetails = {
    name: 'Emma',
    age: 5,
    gender: 'female',
    interests: ['dinosaurs'],
  };

  test('returns valid plan with 32-page structure', async () => {
    let callCount = 0;
    global.fetch = jest.fn(async () => {
      callCount++;
      return makeFetchResponse(validPlan);
    });

    const plan = await planStory(childDetails, 'adventure', 'picture_book', '');
    expect(plan.title).toBe('Emma and the Magic Garden');

    const spreads = plan.entries.filter(e => e.type === 'spread');
    expect(spreads.length).toBe(12);

    expect(plan.entries[0].type).toBe('half_title_page');
    expect(plan.entries[1].type).toBe('blank');
    expect(plan.entries[2].type).toBe('title_page');
    expect(plan.entries[3].type).toBe('copyright_page');
    expect(plan.entries[4].type).toBe('dedication_page');

    const len = plan.entries.length;
    expect(plan.entries[len - 3].type).toBe('blank');
    expect(plan.entries[len - 2].type).toBe('closing_page');
    expect(plan.entries[len - 1].type).toBe('blank');

    // 5 front + 12 spreads + 3 back = 20 entries
    expect(plan.entries.length).toBe(20);
  });

  test('truncates plans with more than 12 spreads', async () => {
    global.fetch = jest.fn(async () => makeFetchResponse(longPlan));

    const plan = await planStory(childDetails, 'adventure', 'picture_book', '');
    const spreads = plan.entries.filter(e => e.type === 'spread');
    expect(spreads.length).toBeLessThanOrEqual(12);
    spreads.forEach((s, i) => {
      expect(s.spread).toBe(i + 1);
    });
  });

  test('throws on API error', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => 'Rate limited',
    }));

    await expect(planStory(childDetails, 'adventure', 'picture_book', ''))
      .rejects.toThrow();
  });

  test('throws on invalid plan structure', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ title: 'Test' }) }, finish_reason: 'stop' }],
        usage: {},
      }),
    }));

    await expect(planStory(childDetails, 'adventure', 'picture_book', ''))
      .rejects.toThrow();
  });

  test('propagates characterOutfit from plan', async () => {
    const planWithOutfit = {
      ...validPlan,
      characterOutfit: 'red overalls with yellow boots',
      characterDescription: 'curly brown hair, freckles',
    };
    global.fetch = jest.fn(async () => makeFetchResponse(planWithOutfit));

    const plan = await planStory(childDetails, 'adventure', 'picture_book', '');
    expect(plan.characterOutfit).toBe('red overalls with yellow boots');
    expect(plan.characterDescription).toBe('curly brown hair, freckles');
  });
});
