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

const { planStory, validateStoryText, combinedCritic, planGraphicNovel } = require('../../services/storyPlanner');

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

  test('truncates plans with more than 13 spreads', async () => {
    global.fetch = jest.fn(async () => makeFetchResponse(longPlan));

    const plan = await planStory(childDetails, 'adventure', 'picture_book', '');
    const spreads = plan.entries.filter(e => e.type === 'spread');
    expect(spreads.length).toBeLessThanOrEqual(13);
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

const freeFormStoryText = `TITLE: Emma's Twilight Garden

DEDICATION: For Emma

SPREAD 1:
Left: "The garden gate swung open before Emma even touched it."
Right: null

SPREAD 2:
Left: null
Right: "Something rustled in the tall grass."

SPREAD 3:
Left: "Her fingers found the toy dinosaur's worn snout."
Right: "What was that sound?"

SPREAD 4:
Left: "The flowers had closed their petals for the night."
Right: null

SPREAD 5:
Left: null
Right: "A frog croaked from somewhere close."

SPREAD 6:
Left: "The path bent where the old oak tree stood."
Right: "Hush now, little seed."

SPREAD 7:
Left: "Emma knelt beside the wilted flower."
Right: null

SPREAD 8:
Left: "She cupped water in her hands from the stream."
Right: "The flower lifted its head."

SPREAD 9:
Left: null
Right: "Hush now, little seed — the garden hums with you."

SPREAD 10:
Left: "The fireflies blinked on, one by one."
Right: null

SPREAD 11:
Left: null
Right: "The oak tree's shadow felt like a blanket."

SPREAD 12:
Left: null
Right: "Hush now, little seed. The garden sleeps."`;

describe('two-phase pipeline', () => {
  const childDetails = {
    name: 'Emma',
    age: 5,
    gender: 'female',
    interests: ['dinosaurs'],
  };

  test('uses two-phase pipeline when text parsing succeeds', async () => {
    let callNum = 0;
    global.fetch = jest.fn(async () => {
      callNum++;
      if (callNum === 1) {
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: freeFormStoryText }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 800, completion_tokens: 500 },
          }),
        };
      }
      return makeFetchResponse(validPlan);
    });

    const plan = await planStory(childDetails, 'adventure', 'picture_book', '');
    expect(plan.title).toBe('Emma and the Magic Garden');
    expect(callNum).toBe(2);
    const spreads = plan.entries.filter(e => e.type === 'spread');
    expect(spreads.length).toBe(12);
  });

  test('falls back to single-call when text parsing fails', async () => {
    let callNum = 0;
    global.fetch = jest.fn(async () => {
      callNum++;
      if (callNum === 1) {
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: 'Not a valid story format at all.' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 800, completion_tokens: 100 },
          }),
        };
      }
      return makeFetchResponse(validPlan);
    });

    const plan = await planStory(childDetails, 'adventure', 'picture_book', '');
    expect(plan.title).toBe('Emma and the Magic Garden');
    expect(callNum).toBe(2);
  });
});

describe('validateStoryText', () => {
  test('detects emotion telling', () => {
    const plan = {
      entries: Array.from({ length: 12 }, (_, i) => ({
        type: 'spread',
        spread: i + 1,
        left: { text: i === 0 ? 'She felt happy about the adventure.' : 'The wind carried a scent.' },
        right: { text: null },
      })),
    };
    const { issues } = validateStoryText(plan);
    expect(issues.some(i => i.type === 'emotion_telling')).toBe(true);
  });

  test('passes for clean text', () => {
    const plan = {
      entries: Array.from({ length: 12 }, (_, i) => ({
        type: 'spread',
        spread: i + 1,
        left: { text: i < 10 ? 'The garden whispered secrets.' : null },
        right: { text: i >= 10 ? 'Stars blinked above.' : null },
      })),
    };
    const { issues } = validateStoryText(plan, 30);
    const blocking = issues.filter(i => i.type === 'emotion_telling' || i.type === 'spread_count');
    expect(blocking.length).toBe(0);
  });

  test('flags excessive word count', () => {
    const plan = {
      entries: [
        {
          type: 'spread',
          spread: 1,
          left: { text: 'word '.repeat(50).trim() },
          right: { text: null },
        },
        ...Array.from({ length: 11 }, (_, i) => ({
          type: 'spread',
          spread: i + 2,
          left: { text: 'Short.' },
          right: { text: null },
        })),
      ],
    };
    const { issues } = validateStoryText(plan, 25);
    expect(issues.some(i => i.type === 'word_count' && i.spread === 1)).toBe(true);
  });

  test('flags insufficient visual-only spreads', () => {
    const plan = {
      entries: Array.from({ length: 12 }, (_, i) => ({
        type: 'spread',
        spread: i + 1,
        left: { text: 'Text on left.' },
        right: { text: 'Text on right.' },
      })),
    };
    const { issues } = validateStoryText(plan, 30);
    expect(issues.some(i => i.type === 'visual_spreads')).toBe(true);
  });

  test.each([
    ['One day the adventure began'],
    ['Once upon a time there was a girl'],
    ['She woke up and stretched her arms'],
    ['It was a beautiful morning in the park'],
    ['The morning was bright and full of promise'],
    ['The day had finally arrived'],
  ])('flags opening cliche: %s', (openingText) => {
    const plan = {
      entries: Array.from({ length: 12 }, (_, i) => ({
        type: 'spread',
        spread: i + 1,
        left: { text: i === 0 ? openingText : 'The wind carried a scent.' },
        right: { text: null },
      })),
    };
    const { issues } = validateStoryText(plan, 30);
    expect(issues.some(i => i.type === 'opening_cliche' && i.spread === 1)).toBe(true);
  });

  test('does not flag a strong opening', () => {
    const plan = {
      entries: Array.from({ length: 12 }, (_, i) => ({
        type: 'spread',
        spread: i + 1,
        left: { text: i === 0 ? 'Maya pressed her nose against the spaceship glass.' : 'The wind carried a scent.' },
        right: { text: null },
      })),
    };
    const { issues } = validateStoryText(plan, 30);
    expect(issues.some(i => i.type === 'opening_cliche')).toBe(false);
  });
});

describe('combinedCritic', () => {
  test('applies improved spreads without throwing', async () => {
    const storyPlan = {
      entries: Array.from({ length: 12 }, (_, i) => ({
        type: 'spread',
        spread: i + 1,
        left: { text: `Left ${i + 1}` },
        right: { text: `Right ${i + 1}` },
      })),
    };

    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              issues: [],
              improved_spreads: Array.from({ length: 12 }, (_, i) => ({
                spread: i + 1,
                left: `Improved left ${i + 1}`,
                right: `Improved right ${i + 1}`,
              })),
            }),
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 200, completion_tokens: 300 },
      }),
    }));

    const result = await combinedCritic(storyPlan, {});
    expect(result.entries[0].left.text).toBe('Improved left 1');
    expect(result.entries[0].right.text).toBe('Improved right 1');
    expect(result.entries[11].left.text).toBe('Improved left 12');
  });

  test('propagates scores to _combinedCriticScores', async () => {
    const storyPlan = {
      entries: Array.from({ length: 12 }, (_, i) => ({
        type: 'spread',
        spread: i + 1,
        left: { text: `Left ${i + 1}` },
        right: { text: `Right ${i + 1}` },
      })),
    };

    const mockScores = { rhythm: 8, emotional_arc: 7, memorable_line: 9, language_quality: 8 };

    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              issues: [],
              scores: mockScores,
              improved_spreads: [],
            }),
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 200, completion_tokens: 300 },
      }),
    }));

    const result = await combinedCritic(storyPlan, {});
    expect(result._combinedCriticScores).toEqual(mockScores);
  });

  test('sets _combinedCriticScores to null when scores absent', async () => {
    const storyPlan = {
      entries: Array.from({ length: 12 }, (_, i) => ({
        type: 'spread',
        spread: i + 1,
        left: { text: `Left ${i + 1}` },
        right: { text: `Right ${i + 1}` },
      })),
    };

    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              issues: [],
              improved_spreads: [],
            }),
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 200, completion_tokens: 300 },
      }),
    }));

    const result = await combinedCritic(storyPlan, {});
    expect(result._combinedCriticScores).toBeNull();
  });
});

describe('planGraphicNovel robustness', () => {
  test('handles trailing text after JSON object during GN planning', async () => {
    let callNum = 0;
    const sceneNumbers = [
      1, 1, 1, 1,
      2, 2, 2, 2,
      3, 3, 3, 3,
      4, 4, 4,
      5, 5, 5,
      6, 6, 6,
      7, 7, 7,
    ];
    const pages = Array.from({ length: 24 }, (_, i) => ({
      pageNumber: i + 1,
      sceneNumber: sceneNumbers[i],
      sceneTitle: `Scene ${sceneNumbers[i]}`,
      pagePurpose: 'Advance the story',
      pageTurnIntent: 'question',
      dominantBeat: 'A strong beat',
      layoutTemplate: 'conversationGrid',
      panelCount: 2,
      panels: [
        {
          panelNumber: 1,
          panelType: 'dialogue',
          dialogue: 'Hello there.',
          balloons: [{ text: 'Hello there.', order: 1, anchor: 'left' }],
          captions: [],
          imagePrompt: 'Panel one prompt',
        },
        {
          panelNumber: 2,
          panelType: i === 20 || i === 23 ? 'splash' : 'reaction',
          dialogue: '',
          caption: 'A quiet beat.',
          captions: [{ text: 'A quiet beat.', placement: 'top-band', type: 'narration' }],
          balloons: [],
          imagePrompt: 'Panel two prompt',
          pageLayout: i === 20 || i === 23 ? 'splash' : '3equal',
        },
      ],
    }));
    let openAiCalls = 0;
    global.fetch = jest.fn(async (url) => {
      const urlStr = String(url);
      if (!urlStr.includes('api.openai.com')) {
        // Gemini calls (enrichCustomDetails, etc.) — return passthrough
        return {
          ok: true,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: '"no references"' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
          }),
        };
      }

      openAiCalls++;
      if (openAiCalls === 1) {
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  favorite_object: 'a silver explorer backpack',
                  fear: 'crossing drifting asteroid stones',
                  setting: 'a luminous chain of tiny planets',
                  storySeed: 'Isabella carries a fallen star seed to the Sky Orchard.',
                }),
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 100, completion_tokens: 100 },
          }),
        };
      }

      if (openAiCalls === 2) {
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  title: 'Isabella and the Moon Orchard',
                  sceneBlueprints: Array.from({ length: 7 }, (_, i) => ({
                    sceneNumber: i + 1,
                    sceneTitle: `Scene ${i + 1}`,
                    pageCountTarget: i < 3 ? 4 : 3,
                  })),
                }),
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 100, completion_tokens: 100 },
          }),
        };
      }

      // Call 3: first chunk (scenes 1-2) with trailing text after JSON
      if (openAiCalls === 3) {
        const chunkPages = pages.slice(0, 8);
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: `${JSON.stringify({ title: 'Isabella and the Moon Orchard', pages: chunkPages })}\nDONE`,
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 100, completion_tokens: 100 },
          }),
        };
      }

      // Remaining chunk calls: call 4→chunk2, call 5→chunk3, etc.
      const chunkMap = { 4: pages.slice(8, 15), 5: pages.slice(15, 18), 6: pages.slice(18, 21), 7: pages.slice(21, 24) };
      const chunkPages = chunkMap[openAiCalls] || pages.slice(0, 3);
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                title: 'Isabella and the Moon Orchard',
                pages: chunkPages,
              }),
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 100, completion_tokens: 100 },
        }),
      };
    });

    const childDetails = {
      name: 'Isabella',
      age: 10,
      gender: 'female',
      interests: ['space'],
    };

    const result = await planGraphicNovel(childDetails, 'adventure', '', { bookContext: { log: jest.fn(), touchActivity: jest.fn() } });
    expect(result.pages.length).toBeGreaterThanOrEqual(24);
    expect(result.scenes.length).toBe(7);
  }, 15000);

  test('falls back to Gemini when GPT returns malformed chunk JSON', async () => {
    const sceneNumbers = [
      1, 1, 1, 1,
      2, 2, 2, 2,
      3, 3, 3, 3,
      4, 4, 4,
      5, 5, 5,
      6, 6, 6,
      7, 7, 7,
    ];
    const validPages = Array.from({ length: 24 }, (_, i) => ({
      pageNumber: i + 1,
      sceneNumber: sceneNumbers[i],
      sceneTitle: `Scene ${sceneNumbers[i]}`,
      pagePurpose: 'Advance the story',
      pageTurnIntent: 'question',
      dominantBeat: 'A strong beat',
      layoutTemplate: 'conversationGrid',
      panelCount: 2,
      panels: [
        {
          panelNumber: 1,
          panelType: 'dialogue',
          dialogue: 'Hello there.',
          balloons: [{ text: 'Hello there.', order: 1, anchor: 'left' }],
          captions: [],
          imagePrompt: 'Panel one prompt',
        },
        {
          panelNumber: 2,
          panelType: i === 20 || i === 23 ? 'splash' : 'reaction',
          caption: 'A quiet beat.',
          captions: [{ text: 'A quiet beat.', placement: 'top-band', type: 'narration' }],
          balloons: [],
          imagePrompt: 'Panel two prompt',
          pageLayout: i === 20 || i === 23 ? 'splash' : '3equal',
        },
      ],
    }));
    const chunkSlices = [
      validPages.slice(0, 8),
      validPages.slice(8, 15),
      validPages.slice(15, 18),
      validPages.slice(18, 21),
      validPages.slice(21, 24),
    ];

    let openAiCalls = 0;
    let geminiCalls = 0;
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('api.openai.com')) {
        openAiCalls++;
        if (openAiCalls === 1) {
          return {
            ok: true,
            json: async () => ({
              choices: [{
                message: {
                  content: JSON.stringify({
                    favorite_object: 'a star-map notebook',
                    fear: 'crossing a broken starlight bridge',
                    setting: 'a chain of tiny planets',
                    storySeed: 'Isabella journeys to relight a beacon.',
                  }),
                },
                finish_reason: 'stop',
              }],
              usage: { prompt_tokens: 100, completion_tokens: 100 },
            }),
          };
        }

        if (openAiCalls === 2) {
          return {
            ok: true,
            json: async () => ({
              choices: [{
                message: {
                  content: JSON.stringify({
                    title: 'Isabella and the Lantern Planet',
                    sceneBlueprints: Array.from({ length: 7 }, (_, i) => ({
                      sceneNumber: i + 1,
                      sceneTitle: `Scene ${i + 1}`,
                      pageCountTarget: i < 3 ? 4 : 3,
                    })),
                  }),
                },
                finish_reason: 'stop',
              }],
              usage: { prompt_tokens: 100, completion_tokens: 100 },
            }),
          };
        }

        // Call 3: first chunk returns malformed JSON → triggers Gemini fallback
        if (openAiCalls === 3) {
          return {
            ok: true,
            json: async () => ({
              choices: [{
                message: {
                  content: '{"title":"Isabella and the Lantern Planet","pages":[{"pageNumber":1,"sceneTitle":"Broken',
                },
                finish_reason: 'stop',
              }],
              usage: { prompt_tokens: 100, completion_tokens: 100 },
            }),
          };
        }

        // Remaining chunk calls succeed (call 4→chunk2, call 5→chunk3, etc.)
        const chunkPages = chunkSlices[openAiCalls - 3] || validPages.slice(0, 3);
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  title: 'Isabella and the Lantern Planet',
                  pages: chunkPages,
                }),
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 100, completion_tokens: 100 },
          }),
        };
      }

      geminiCalls++;
      // Gemini fallback returns valid chunk-1 pages
      return {
        ok: true,
        json: async () => ({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  title: 'Isabella and the Lantern Planet',
                  pages: chunkSlices[0],
                }),
              }],
            },
            finishReason: 'STOP',
          }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100 },
        }),
      };
    });

    const childDetails = {
      name: 'Isabella',
      age: 10,
      gender: 'female',
      interests: ['space'],
    };

    const result = await planGraphicNovel(childDetails, 'adventure', '', { bookContext: { log: jest.fn(), touchActivity: jest.fn() } });
    expect(result.pages.length).toBe(24);
    expect(result.scenes.length).toBe(7);
    expect(geminiCalls).toBeGreaterThan(0);
  }, 15000);

  test('falls back to chunked GN planning when full-plan JSON is unsalvageable', async () => {
    const sceneNumbers = [
      1, 1, 1, 1,
      2, 2, 2, 2,
      3, 3, 3, 3,
      4, 4, 4,
      5, 5, 5,
      6, 6, 6,
      7, 7, 7,
    ];
    const validPages = Array.from({ length: 24 }, (_, i) => ({
      pageNumber: i + 1,
      sceneNumber: sceneNumbers[i],
      sceneTitle: `Scene ${sceneNumbers[i]}`,
      pagePurpose: 'Advance the story',
      pageTurnIntent: 'question',
      dominantBeat: 'A strong beat',
      layoutTemplate: 'conversationGrid',
      panelCount: 2,
      panels: [
        {
          panelNumber: 1,
          panelType: 'dialogue',
          dialogue: 'Hello there.',
          balloons: [{ text: 'Hello there.', order: 1, anchor: 'left' }],
          captions: [],
          imagePrompt: 'Panel one prompt',
        },
        {
          panelNumber: 2,
          panelType: i === 20 || i === 23 ? 'splash' : 'reaction',
          caption: 'A quiet beat.',
          captions: [{ text: 'A quiet beat.', placement: 'top-band', type: 'narration' }],
          balloons: [],
          imagePrompt: 'Panel two prompt',
          pageLayout: i === 20 || i === 23 ? 'splash' : '3equal',
        },
      ],
    }));

    let openAiCalls = 0;
    let geminiCalls = 0;
    global.fetch = jest.fn(async (url) => {
      if (!String(url).includes('api.openai.com')) {
        geminiCalls++;
        return {
          ok: true,
          json: async () => ({
            candidates: [{
              content: {
                parts: [{
                  text: '{"title":"Isabella and the Lantern Planet","pages":[{"pageNumber":1,"sceneTitle":"Broken',
                }],
              },
              finishReason: 'STOP',
            }],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100 },
          }),
        };
      }
      openAiCalls++;

      if (openAiCalls === 1) {
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  favorite_object: 'a star-map notebook',
                  fear: 'crossing a broken starlight bridge',
                  setting: 'a chain of tiny planets',
                  storySeed: 'Isabella journeys to relight a beacon.',
                }),
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 100, completion_tokens: 100 },
          }),
        };
      }

      if (openAiCalls === 2) {
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  title: 'Isabella and the Lantern Planet',
                  sceneBlueprints: [
                    { sceneNumber: 1, sceneTitle: 'Scene 1', pageCountTarget: 4 },
                    { sceneNumber: 2, sceneTitle: 'Scene 2', pageCountTarget: 4 },
                    { sceneNumber: 3, sceneTitle: 'Scene 3', pageCountTarget: 4 },
                    { sceneNumber: 4, sceneTitle: 'Scene 4', pageCountTarget: 3 },
                    { sceneNumber: 5, sceneTitle: 'Scene 5', pageCountTarget: 3 },
                    { sceneNumber: 6, sceneTitle: 'Scene 6', pageCountTarget: 3 },
                    { sceneNumber: 7, sceneTitle: 'Scene 7', pageCountTarget: 3 },
                  ],
                }),
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 100, completion_tokens: 100 },
          }),
        };
      }

      if (openAiCalls === 3) {
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: '{"title":"Isabella and the Lantern Planet","pages":[{"pageNumber":1,"sceneTitle":"Broken',
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 100, completion_tokens: 100 },
          }),
        };
      }

      const chunkSlices = [
        validPages.slice(0, 8).map((page) => ({ ...page, sceneNumber: 1, sceneTitle: 'Wrong Scene' })),
        validPages.slice(8, 15).map((page) => ({ ...page, sceneNumber: 1, sceneTitle: 'Wrong Scene' })),
        validPages.slice(15, 18).map((page) => ({ ...page, sceneNumber: 1, sceneTitle: 'Wrong Scene' })),
        validPages.slice(18, 21).map((page, index) => ({
          ...page,
          sceneNumber: 1,
          sceneTitle: 'Wrong Scene',
          layoutTemplate: index === 0 ? 'fullBleedSplash' : page.layoutTemplate,
          panels: (page.panels || []).map((panel) => ({
            ...panel,
            panelType: 'reaction',
            pageLayout: index === 0 ? 'splash' : '3equal',
          })),
        })),
        validPages.slice(21, 24).map((page, index) => ({
          ...page,
          sceneNumber: 1,
          sceneTitle: 'Wrong Scene',
          layoutTemplate: index === 0 ? 'fullBleedSplash' : page.layoutTemplate,
          panels: (page.panels || []).map((panel) => ({
            ...panel,
            panelType: 'reaction',
            pageLayout: index === 0 ? 'splash' : '3equal',
          })),
        })),
      ];

      if (openAiCalls >= 4 && openAiCalls <= 8) {
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  title: 'Isabella and the Lantern Planet',
                  pages: chunkSlices[openAiCalls - 4],
                }),
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 100, completion_tokens: 100 },
          }),
        };
      }

      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                title: 'Isabella and the Lantern Planet',
                pages: validPages,
              }),
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 100, completion_tokens: 100 },
        }),
      };
    });

    const childDetails = {
      name: 'Isabella',
      age: 10,
      gender: 'female',
      interests: ['space'],
    };

    const result = await planGraphicNovel(childDetails, 'adventure', '', {});
    expect(result.pages.length).toBe(24);
    expect(result.scenes.length).toBe(7);
    expect(openAiCalls).toBeGreaterThanOrEqual(8);
    expect(geminiCalls).toBeGreaterThan(0);
  }, 15000);

  test('logs chunk progress during chunked GN planning', async () => {
    const sceneNumbers = [
      1, 1, 1, 1,
      2, 2, 2, 2,
      3, 3, 3, 3,
      4, 4, 4,
      5, 5, 5,
      6, 6, 6,
      7, 7, 7,
    ];
    const validPages = Array.from({ length: 24 }, (_, i) => ({
      pageNumber: i + 1,
      sceneNumber: sceneNumbers[i],
      sceneTitle: `Scene ${sceneNumbers[i]}`,
      pagePurpose: 'Advance the story',
      pageTurnIntent: 'question',
      dominantBeat: 'A strong beat',
      layoutTemplate: i === 18 || i === 21 ? 'fullBleedSplash' : 'conversationGrid',
      panelCount: 2,
      panels: [
        {
          panelNumber: 1,
          panelType: 'dialogue',
          dialogue: 'Hello there.',
          balloons: [{ text: 'Hello there.', order: 1, anchor: 'left' }],
          captions: [],
          imagePrompt: 'Panel one prompt',
          pageLayout: i === 18 || i === 21 ? 'splash' : '3equal',
        },
        {
          panelNumber: 2,
          panelType: 'reaction',
          caption: 'A quiet beat.',
          captions: [{ text: 'A quiet beat.', placement: 'top-band', type: 'narration' }],
          balloons: [],
          imagePrompt: 'Panel two prompt',
          pageLayout: '3equal',
        },
      ],
    }));
    const chunkSlices = [
      validPages.slice(0, 8),
      validPages.slice(8, 15),
      validPages.slice(15, 18),
      validPages.slice(18, 21),
      validPages.slice(21, 24),
    ];

    let openAiCalls = 0;
    global.fetch = jest.fn(async (url) => {
      if (!String(url).includes('api.openai.com')) {
        return {
          ok: true,
          json: async () => ({
            candidates: [{
              content: { parts: [{ text: '{"broken":' }] },
              finishReason: 'STOP',
            }],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100 },
          }),
        };
      }

      openAiCalls++;
      if (openAiCalls === 1) {
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  favorite_object: 'a star-map notebook',
                  fear: 'crossing a broken starlight bridge',
                  setting: 'a chain of tiny planets',
                  storySeed: 'Isabella journeys to relight a beacon.',
                }),
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 100, completion_tokens: 100 },
          }),
        };
      }
      if (openAiCalls === 2) {
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  title: 'Isabella and the Lantern Planet',
                  sceneBlueprints: [
                    { sceneNumber: 1, sceneTitle: 'Scene 1', pageCountTarget: 4 },
                    { sceneNumber: 2, sceneTitle: 'Scene 2', pageCountTarget: 4 },
                    { sceneNumber: 3, sceneTitle: 'Scene 3', pageCountTarget: 4 },
                    { sceneNumber: 4, sceneTitle: 'Scene 4', pageCountTarget: 3 },
                    { sceneNumber: 5, sceneTitle: 'Scene 5', pageCountTarget: 3 },
                    { sceneNumber: 6, sceneTitle: 'Scene 6', pageCountTarget: 3 },
                    { sceneNumber: 7, sceneTitle: 'Scene 7', pageCountTarget: 3 },
                  ],
                }),
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 100, completion_tokens: 100 },
          }),
        };
      }
      if (openAiCalls === 3) {
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: { content: '{"title":"Isabella and the Lantern Planet","pages":[{"pageNumber":1' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 100, completion_tokens: 100 },
          }),
        };
      }

      const chunkPages = chunkSlices[openAiCalls - 4] || validPages;
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                title: 'Isabella and the Lantern Planet',
                pages: chunkPages,
              }),
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 100, completion_tokens: 100 },
        }),
      };
    });

    const bookContext = { log: jest.fn() };
    const result = await planGraphicNovel({
      name: 'Isabella',
      age: 10,
      gender: 'female',
      interests: ['space'],
    }, 'adventure', '', { bookContext });

    expect(result.pages.length).toBe(24);
    expect(bookContext.log).toHaveBeenCalledWith('info', 'Starting chunked graphic novel planning', expect.objectContaining({
      chunkCount: 5,
    }));
    expect(bookContext.log).toHaveBeenCalledWith('info', 'Planning graphic novel chunk', expect.objectContaining({
      scenes: '1, 2',
      attempt: 1,
    }));
    expect(bookContext.log).toHaveBeenCalledWith('info', 'Graphic novel chunk planned', expect.objectContaining({
      scenes: '7',
      pages: 3,
    }));
  }, 15000);

  test('uses chunked planner directly without full-plan attempt', async () => {
    const sceneNumbers = [
      1, 1, 1, 1,
      2, 2, 2, 2,
      3, 3, 3, 3,
      4, 4, 4,
      5, 5, 5,
      6, 6, 6,
      7, 7, 7,
    ];
    const validPages = Array.from({ length: 24 }, (_, i) => ({
      pageNumber: i + 1,
      sceneNumber: sceneNumbers[i],
      sceneTitle: `Scene ${sceneNumbers[i]}`,
      pagePurpose: 'Advance the story',
      pageTurnIntent: 'question',
      dominantBeat: 'A strong beat',
      layoutTemplate: i === 18 || i === 21 ? 'fullBleedSplash' : 'conversationGrid',
      panelCount: 2,
      panels: [
        {
          panelNumber: 1,
          panelType: 'dialogue',
          dialogue: 'Hello there.',
          balloons: [{ text: 'Hello there.', order: 1, anchor: 'left' }],
          captions: [],
          imagePrompt: 'Panel one prompt',
          pageLayout: i === 18 || i === 21 ? 'splash' : '3equal',
        },
        {
          panelNumber: 2,
          panelType: 'reaction',
          caption: 'A quiet beat.',
          captions: [{ text: 'A quiet beat.', placement: 'top-band', type: 'narration' }],
          balloons: [],
          imagePrompt: 'Panel two prompt',
          pageLayout: '3equal',
        },
      ],
    }));
    const chunkSlices = [
      validPages.slice(0, 8),
      validPages.slice(8, 15),
      validPages.slice(15, 18),
      validPages.slice(18, 21),
      validPages.slice(21, 24),
    ];

    let openAiCalls = 0;
    global.fetch = jest.fn((url) => {
      if (!String(url).includes('api.openai.com')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            candidates: [{
              content: { parts: [{ text: '{"broken":' }] },
              finishReason: 'STOP',
            }],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100 },
          }),
        });
      }

      openAiCalls++;
      // Call 1: brainstormStorySeed
      if (openAiCalls === 1) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  favorite_object: 'a star-map notebook',
                  fear: 'crossing a broken starlight bridge',
                  setting: 'a chain of tiny planets',
                  storySeed: 'Isabella journeys to relight a beacon.',
                }),
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 100, completion_tokens: 100 },
          }),
        });
      }
      // Call 2: story bible
      if (openAiCalls === 2) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  title: 'Isabella and the Lantern Planet',
                  sceneBlueprints: [
                    { sceneNumber: 1, sceneTitle: 'Scene 1', pageCountTarget: 4 },
                    { sceneNumber: 2, sceneTitle: 'Scene 2', pageCountTarget: 4 },
                    { sceneNumber: 3, sceneTitle: 'Scene 3', pageCountTarget: 4 },
                    { sceneNumber: 4, sceneTitle: 'Scene 4', pageCountTarget: 3 },
                    { sceneNumber: 5, sceneTitle: 'Scene 5', pageCountTarget: 3 },
                    { sceneNumber: 6, sceneTitle: 'Scene 6', pageCountTarget: 3 },
                    { sceneNumber: 7, sceneTitle: 'Scene 7', pageCountTarget: 3 },
                  ],
                }),
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 100, completion_tokens: 100 },
          }),
        });
      }
      // Calls 3+: chunk plans (no full-plan attempt)
      const chunkPages = chunkSlices[openAiCalls - 3] || validPages;
      return Promise.resolve({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                title: 'Isabella and the Lantern Planet',
                pages: chunkPages,
              }),
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 100, completion_tokens: 100 },
        }),
      });
    });

    const bookContext = { log: jest.fn(), touchActivity: jest.fn() };
    const result = await planGraphicNovel({
      name: 'Isabella',
      age: 10,
      gender: 'female',
      interests: ['space'],
    }, 'adventure', '', { bookContext });

    expect(result.pages.length).toBe(24);
    // Verify chunked planning was used: seed(1) + bible(1) + 5 chunks + critic(1) = 8 GPT calls
    const gptCalls = global.fetch.mock.calls.filter(c => String(c[0]).includes('api.openai.com'));
    expect(gptCalls.length).toBeGreaterThanOrEqual(7);
    expect(bookContext.log).toHaveBeenCalledWith('info', 'Starting chunked graphic novel planning', expect.any(Object));
  }, 15000);
});

// ── Mother's Day theme-specific prompt tests ──
describe('buildStoryPlannerSystem — mothers_day theme', () => {
  const { buildStoryPlannerSystem } = require('../../prompts/pictureBook');

  test('without additionalCoverCharacters: Mom is explicitly required in illustrations', () => {
    const system = buildStoryPlannerSystem({ name: 'Lily', age: 5 }, null, 'mothers_day');
    expect(system).toMatch(/Mom.*MUST appear in illustration prompts/i);
    expect(system).not.toMatch(/NEVER depict family members/i);
  });

  test('without additionalCoverCharacters: other family members are still blocked', () => {
    const system = buildStoryPlannerSystem({ name: 'Lily', age: 5 }, null, 'mothers_day');
    expect(system).toMatch(/siblings.*grandparents.*dad.*must NOT appear in illustrations/i);
  });

  test('with additionalCoverCharacters: Mom is still required alongside detected secondary character', () => {
    const momDesc = 'A woman with brown hair and blue eyes';
    const system = buildStoryPlannerSystem({ name: 'Lily', age: 5 }, momDesc, 'mothers_day');
    expect(system).toMatch(/Mom.*MUST appear in illustration prompts/i);
    expect(system).toContain(momDesc);
    // Should not contain the bare "no family" rule
    expect(system).not.toMatch(/NEVER depict family members/i);
    // Should not have language that blocks Mom (old contradictory phrasing)
    expect(system).not.toMatch(/Do NOT invent other family members beyond what is listed above/i);
    // Should use the unambiguous combined-override phrasing
    expect(system).toMatch(/Only Mom and the secondary character/i);
  });

  test('non-mothers_day with additionalCoverCharacters: standard secondary character rule applies', () => {
    const desc = 'A tall man with dark hair';
    const system = buildStoryPlannerSystem({ name: 'Lily', age: 5 }, desc, 'adventure');
    expect(system).toContain(desc);
    expect(system).toMatch(/Do NOT invent other family members beyond what is listed above/i);
    // Mom should NOT be mentioned as a required character
    expect(system).not.toMatch(/Mom.*MUST appear/i);
  });

  test('non-mothers_day without additionalCoverCharacters: standard no-family rule applies', () => {
    const system = buildStoryPlannerSystem({ name: 'Lily', age: 5 }, null, 'adventure');
    expect(system).toMatch(/NEVER depict family members/i);
  });
});

describe('generateStoryText (writer system prompt) — mothers_day theme', () => {
  const capturedPrompts = [];
  const originalFetch = global.fetch;

  beforeEach(() => {
    capturedPrompts.length = 0;
    global.fetch = jest.fn(async (url, opts) => {
      const body = JSON.parse(opts?.body || '{}');
      if (body.messages) {
        capturedPrompts.push(body.messages);
      }
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Once upon a time there was a child.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 100 },
        }),
      };
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function getSystemPrompt() {
    const messages = capturedPrompts.find(m => m && m[0]?.role === 'system');
    return messages?.[0]?.content || '';
  }

  test('without additionalCoverCharacters: Mom override is injected', async () => {
    const { generateStoryText } = require('../../services/storyPlanner');
    if (!generateStoryText) return; // skip if not exported
    const childDetails = { name: 'Lily', age: 5, gender: 'female', interests: ['flowers'] };
    await generateStoryText(childDetails, 'mothers_day', '', null, {
      apiKeys: { OPENAI_API_KEY: 'test-key' },
      costTracker: { add: jest.fn(), getSummary: () => ({}) },
    }).catch(() => {});
    const sys = getSystemPrompt();
    if (sys) {
      expect(sys).toMatch(/MOTHER'S DAY OVERRIDE/i);
    }
  });

  test('with additionalCoverCharacters: both Mom override and secondary character override are present', async () => {
    const { generateStoryText } = require('../../services/storyPlanner');
    if (!generateStoryText) return; // skip if not exported
    const childDetails = { name: 'Lily', age: 5, gender: 'female', interests: ['flowers'] };
    const momDesc = 'A woman with curly red hair';
    await generateStoryText(childDetails, 'mothers_day', '', null, {
      apiKeys: { OPENAI_API_KEY: 'test-key' },
      additionalCoverCharacters: momDesc,
      costTracker: { add: jest.fn(), getSummary: () => ({}) },
    }).catch(() => {});
    const sys = getSystemPrompt();
    if (sys) {
      expect(sys).toMatch(/MOTHER'S DAY OVERRIDE/i);
      expect(sys).toMatch(/COVER PHOTO OVERRIDE/i);
      expect(sys).toContain(momDesc);
    }
  });
});
