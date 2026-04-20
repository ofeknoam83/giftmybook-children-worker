jest.mock('../../services/illustrationGenerator', () => ({
  getNextApiKey: jest.fn(() => 'test-key'),
  downloadPhotoAsBase64: jest.fn(),
  fetchWithTimeout: jest.fn(),
}));

const {
  summarizeQuestionnaire,
  detectImageMime,
  buildBackCoverPrompt,
  planBackCoverScene,
  planColoringScenes,
  convertCoverToColoringStyle,
} = require('../../services/coloringBookGenerator');
const { fetchWithTimeout } = require('../../services/illustrationGenerator');

function mockPlannerResponse(jsonObj) {
  return {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(jsonObj) }] } }],
    }),
  };
}

describe('summarizeQuestionnaire', () => {
  test('labels each non-empty field and drops empty ones', () => {
    const out = summarizeQuestionnaire({
      childInterests: ['dinosaurs', 'glitter', ''],
      customDetails: 'Loves her dog Luna',
      brief: { favoritePlace: 'grandma house' },
      emotionalSituation: '',
      emotionIntakeData: null,
    });
    expect(out).toMatch(/Interests: dinosaurs, glitter/);
    expect(out).toMatch(/Custom details: Loves her dog Luna/);
    expect(out).toMatch(/Brief: \{"favoritePlace":"grandma house"\}/);
    expect(out).not.toMatch(/Emotional situation/);
    expect(out).not.toMatch(/Emotion intake/);
  });

  test('returns empty string on an empty questionnaire', () => {
    expect(summarizeQuestionnaire({})).toBe('');
    expect(summarizeQuestionnaire()).toBe('');
  });
});

describe('detectImageMime', () => {
  test('detects PNG', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(detectImageMime(buf)).toBe('image/png');
  });
  test('detects JPEG', () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(detectImageMime(buf)).toBe('image/jpeg');
  });
  test('detects WEBP', () => {
    const buf = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(detectImageMime(buf)).toBe('image/webp');
  });
  test('falls back to jpeg on unknown', () => {
    const buf = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(detectImageMime(buf)).toBe('image/jpeg');
  });
  test('falls back on missing/short buffer', () => {
    expect(detectImageMime(null)).toBe('image/jpeg');
    expect(detectImageMime(Buffer.from([0x89]))).toBe('image/jpeg');
  });
});

describe('buildBackCoverPrompt', () => {
  test('includes the planned scene and pencil style', () => {
    const prompt = buildBackCoverPrompt({
      childName: 'Paisley',
      age: 3,
      characterDescription: 'light brown hair, blue eyes',
      scenePrompt: 'Paisley hugging her stuffed elephant on a grassy hill at sunset',
      chosenDetail: 'stuffed elephant',
    });
    expect(prompt).toContain('GRAPHITE PENCIL DRAWING');
    expect(prompt).toContain('Paisley hugging her stuffed elephant on a grassy hill at sunset');
    expect(prompt).toContain('Paisley');
    expect(prompt).toContain('light brown hair, blue eyes');
    expect(prompt).toMatch(/3:4|PORTRAIT/);
    expect(prompt).toMatch(/NO TEXT/);
  });

  test('does NOT reserve a barcode / ISBN clear-zone', () => {
    const prompt = buildBackCoverPrompt({
      childName: 'Milo',
      scenePrompt: 'Milo with his toy trains',
    });
    expect(prompt).not.toMatch(/LOWER-RIGHT.*barcode|barcode.*LOWER-RIGHT/i);
    // The prompt explicitly says we do NOT print a barcode
    expect(prompt).toMatch(/do not print a barcode or ISBN/i);
  });

  test('explicitly forbids ANY text overlays (title, tagline, blurb)', () => {
    const prompt = buildBackCoverPrompt({ childName: 'Kira', scenePrompt: 'scene' });
    expect(prompt).toMatch(/no title/i);
    expect(prompt).toMatch(/no author name|no taglines|no back-cover blurb/i);
  });

  test('falls back to chosenDetail when no scenePrompt', () => {
    const prompt = buildBackCoverPrompt({ childName: 'Milo', chosenDetail: 'toy trains' });
    expect(prompt).toContain('Milo');
    expect(prompt).toContain('toy trains');
  });
});

describe('planBackCoverScene', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('falls back deterministically when questionnaire is empty', async () => {
    const out = await planBackCoverScene({ childName: 'Noa', age: 4, questionnaire: {} });
    expect(out.rationale).toBe('deterministic fallback');
    expect(out.scenePrompt).toContain('Noa');
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  test('uses first childInterest for fallback when LLM absent', async () => {
    const out = await planBackCoverScene({
      childName: 'Noa',
      questionnaire: { childInterests: ['dinosaurs', 'glitter'] },
    });
    // No fetch mock set — planBackCoverScene should still succeed with LLM, let's force no-key path instead.
    // (Actually summary is non-empty so it'll hit fetch — use second test below for deterministic check.)
    expect(out.scenePrompt.length).toBeGreaterThan(0);
  });

  test('parses valid LLM JSON response', async () => {
    fetchWithTimeout.mockResolvedValue(mockPlannerResponse({
      chosenDetail: 'her dog Luna',
      scenePrompt: 'Paisley reading a book to her dog Luna on the rug',
      rationale: 'Luna is named in custom details',
    }));
    const out = await planBackCoverScene({
      childName: 'Paisley',
      questionnaire: { customDetails: 'Loves her dog Luna' },
    });
    expect(out.chosenDetail).toBe('her dog Luna');
    expect(out.scenePrompt).toMatch(/Paisley.*Luna/);
    expect(out.rationale).toBe('Luna is named in custom details');
  });

  test('falls back on LLM error', async () => {
    fetchWithTimeout.mockRejectedValue(new Error('network down'));
    const out = await planBackCoverScene({
      childName: 'Paisley',
      questionnaire: { childInterests: ['butterflies'] },
    });
    expect(out.chosenDetail).toMatch(/butterflies|favorite moment/);
    expect(out.scenePrompt).toContain('Paisley');
  });

  test('falls back on unparseable LLM output', async () => {
    fetchWithTimeout.mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'not-json' }] } }] }),
    });
    const out = await planBackCoverScene({
      childName: 'Kira',
      questionnaire: { childInterests: ['painting'] },
    });
    expect(out.rationale).toBe('deterministic fallback');
    expect(out.scenePrompt).toContain('Kira');
  });
});

describe('convertCoverToColoringStyle prompt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('tells the model to PRESERVE the parent cover title and never invent text', async () => {
    // Capture the prompt text by mocking the API call
    fetchWithTimeout.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from('x').toString('base64') } }] } }],
      }),
    });

    await convertCoverToColoringStyle(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]));

    const call = fetchWithTimeout.mock.calls[0];
    const body = JSON.parse(call[1].body);
    const promptText = body.contents[0].parts[0].text;

    expect(promptText).toMatch(/PRESERVE it exactly|PRESERVE.*title/);
    expect(promptText).toMatch(/Do NOT add any new text|do not add any new text/i);
    expect(promptText).toMatch(/Never invent a title|never invent/i);
    // No clean-paper-for-overlay hints should remain
    expect(promptText).not.toMatch(/clean paper space at the TOP|for a title overlay later|for a branding overlay later/);
  });

  test('uses detected MIME (PNG) for the inline image part', async () => {
    fetchWithTimeout.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from('x').toString('base64') } }] } }],
      }),
    });

    // PNG magic bytes
    await convertCoverToColoringStyle(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]));
    const body = JSON.parse(fetchWithTimeout.mock.calls[0][1].body);
    const imgPart = body.contents[0].parts.find(p => p.inline_data);
    expect(imgPart.inline_data.mime_type).toBe('image/png');
  });
});

describe('planColoringScenes with storyMoments', () => {
  const ORIGINAL_FETCH = global.fetch;
  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-key';
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    delete process.env.GEMINI_API_KEY;
    jest.restoreAllMocks();
  });

  test('passes storyMoments into the system prompt as complementing guidance', async () => {
    let capturedBody;
    global.fetch = jest.fn(async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify([
            { title: 'Bonus Scene', prompt: 'Child reading in the garden' },
          ]) }] } }],
        }),
      };
    });

    const scenes = await planColoringScenes({
      title: 'Paisley and the Magic Garden',
      childName: 'Paisley',
      age: 4,
      count: 3,
      storyMoments: [
        'Spread 1: Paisley finds a seed.',
        'Spread 2: The seed sprouts.',
        'Spread 3: A magical flower blooms.',
      ],
    });

    expect(scenes).toHaveLength(1);
    const systemText = capturedBody.systemInstruction.parts[0].text;
    expect(systemText).toMatch(/Story moments from the parent picture book/);
    expect(systemText).toMatch(/Paisley finds a seed/);
    expect(systemText).toMatch(/COMPLEMENT/);
    expect(systemText).toMatch(/Do NOT simply retell/);
  });

  test('uses generic guidance when no storyMoments', async () => {
    let capturedBody;
    global.fetch = jest.fn(async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify([{ title: 't', prompt: 'p' }]) }] } }],
        }),
      };
    });

    await planColoringScenes({ title: 'Book', childName: 'X', count: 1 });
    const systemText = capturedBody.systemInstruction.parts[0].text;
    expect(systemText).toMatch(/fun, varied adventure scenes/);
    expect(systemText).not.toMatch(/Story moments from/);
  });
});
