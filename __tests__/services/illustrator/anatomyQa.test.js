jest.mock('../../../services/illustrationGenerator', () => ({
  fetchWithTimeout: jest.fn(),
  getNextApiKey: jest.fn(() => 'test-key'),
}));

const { fetchWithTimeout } = require('../../../services/illustrationGenerator');
const { checkAnatomy } = require('../../../services/illustrator/quality/anatomy');

function mockGeminiResponse(jsonObj) {
  return {
    ok: true,
    json: async () => ({
      candidates: [{
        content: {
          parts: [{ text: JSON.stringify(jsonObj) }],
        },
      }],
    }),
  };
}

describe('checkAnatomy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('returns tags when Gemini flags duplicated_hero', async () => {
    fetchWithTimeout.mockResolvedValue(
      mockGeminiResponse({
        pass: false,
        issues: ['Main child appears twice in left half'],
        tags: ['duplicated_hero'],
      }),
    );

    const result = await checkAnatomy('fakebase64');
    expect(result.pass).toBe(false);
    expect(result.tags).toEqual(['duplicated_hero']);
    expect(result.issues).toHaveLength(1);
  });

  test('returns tags when Gemini flags split_panel', async () => {
    fetchWithTimeout.mockResolvedValue(
      mockGeminiResponse({
        pass: false,
        issues: ['Visible seam at center between two scenes'],
        tags: ['split_panel'],
      }),
    );

    const result = await checkAnatomy('fakebase64');
    expect(result.pass).toBe(false);
    expect(result.tags).toContain('split_panel');
  });

  test('accepts multiple tags and normalizes casing/whitespace', async () => {
    fetchWithTimeout.mockResolvedValue(
      mockGeminiResponse({
        pass: false,
        issues: ['two issues'],
        tags: ['  DUPLICATED_HERO  ', 'Split_Panel'],
      }),
    );

    const result = await checkAnatomy('fakebase64');
    expect(result.tags).toEqual(['duplicated_hero', 'split_panel']);
  });

  test('passes cleanly with empty tags when Gemini passes', async () => {
    fetchWithTimeout.mockResolvedValue(
      mockGeminiResponse({ pass: true, issues: [], tags: [] }),
    );

    const result = await checkAnatomy('fakebase64');
    expect(result.pass).toBe(true);
    expect(result.tags).toEqual([]);
  });

  test('defaults to empty tags when Gemini omits the field', async () => {
    fetchWithTimeout.mockResolvedValue(
      mockGeminiResponse({ pass: false, issues: ['something'] }),
    );

    const result = await checkAnatomy('fakebase64');
    expect(result.pass).toBe(false);
    expect(result.tags).toEqual([]);
  });

  test('fails closed after HTTP error retries', async () => {
    fetchWithTimeout.mockResolvedValue({ ok: false, status: 500 });

    const result = await checkAnatomy('fakebase64');
    expect(result.pass).toBe(false);
    expect(result.tags).toContain('qa_api_error');
    expect(result.issues[0]).toMatch(/API HTTP 500/);
  });

  test('fails closed after thrown error retries', async () => {
    fetchWithTimeout.mockRejectedValue(new Error('network down'));

    const result = await checkAnatomy('fakebase64');
    expect(result.pass).toBe(false);
    expect(result.tags).toContain('qa_api_error');
    expect(result.issues[0]).toMatch(/network down/);
  });

  test('prompt includes hero duplication and split panel rules', async () => {
    fetchWithTimeout.mockResolvedValue(
      mockGeminiResponse({ pass: true, issues: [], tags: [] }),
    );

    await checkAnatomy('fakebase64');

    const call = fetchWithTimeout.mock.calls[0];
    const body = JSON.parse(call[1].body);
    const promptText = body.contents[0].parts[1].text;
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.thinkingConfig.thinkingBudget).toBe(0);

    expect(promptText).toMatch(/HERO COUNT/);
    expect(promptText).toMatch(/duplicated_hero/);
    expect(promptText).toMatch(/split_panel/);
    expect(promptText).toMatch(/SEAMLESS COMPOSITION/);
  });
});
