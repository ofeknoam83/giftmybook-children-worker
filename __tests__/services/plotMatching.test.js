const { selectPlotTemplate, matchTitleToPlot, isPlaceholderTitle, THEME_PLOTS } = require('../../services/writer/themes/plots');

jest.mock('../../services/writer/themes/base', () => ({
  BaseThemeWriter: class {},
  callGeminiText: jest.fn(),
  GEMINI_FLASH_MODEL: 'gemini-2.5-flash',
}));

const { callGeminiText } = require('../../services/writer/themes/base');

describe('selectPlotTemplate', () => {
  test('returns null for unknown theme', () => {
    expect(selectPlotTemplate('nonexistent')).toBeNull();
  });

  test('returns a template for a known theme', () => {
    const result = selectPlotTemplate('birthday');
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('id');
    expect(result).toHaveProperty('name');
    expect(result).toHaveProperty('synopsis');
    expect(result).toHaveProperty('beats');
  });

  test('returns specific template when plotId is provided', () => {
    const plots = THEME_PLOTS.adventure;
    const targetId = plots[0].id;
    const result = selectPlotTemplate('adventure', { plotId: targetId });
    expect(result.id).toBe(targetId);
  });

  test('falls back to random when plotId is not found', () => {
    const result = selectPlotTemplate('birthday', { plotId: 'nonexistent_plot_id' });
    expect(result).not.toBeNull();
    expect(result.id).not.toBe('nonexistent_plot_id');
  });
});

describe('matchTitleToPlot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('returns null for unknown theme', async () => {
    const result = await matchTitleToPlot('Some Title', 'nonexistent');
    expect(result).toBeNull();
    expect(callGeminiText).not.toHaveBeenCalled();
  });

  test('returns null for empty title', async () => {
    expect(await matchTitleToPlot('', 'birthday')).toBeNull();
    expect(await matchTitleToPlot(null, 'birthday')).toBeNull();
    expect(await matchTitleToPlot(undefined, 'birthday')).toBeNull();
    expect(callGeminiText).not.toHaveBeenCalled();
  });

  test('returns matched plot ID on successful LLM call', async () => {
    const targetId = THEME_PLOTS.birthday[0].id;
    callGeminiText.mockResolvedValue({ text: targetId });

    const result = await matchTitleToPlot('The Birthday Surprise', 'birthday');
    expect(result).toBe(targetId);
    expect(callGeminiText).toHaveBeenCalledTimes(1);

    const [systemPrompt, userPrompt, config] = callGeminiText.mock.calls[0];
    expect(systemPrompt).toContain('plot-matching');
    expect(userPrompt).toContain('The Birthday Surprise');
    expect(userPrompt).toContain('birthday');
    expect(config.model).toBe('gemini-2.5-flash');
    expect(config.temperature).toBe(0.0);
  });

  test('handles LLM returning ID with extra whitespace/formatting', async () => {
    const targetId = THEME_PLOTS.adventure[2].id;
    callGeminiText.mockResolvedValue({ text: `\n  ${targetId}  \n` });

    const result = await matchTitleToPlot('A Grand Adventure', 'adventure');
    expect(result).toBe(targetId);
  });

  test('falls back to partial match when LLM returns extra text', async () => {
    const targetId = THEME_PLOTS.space[0].id;
    callGeminiText.mockResolvedValue({ text: `I think the best match is ${targetId} because it fits` });

    const result = await matchTitleToPlot('Rocket to the Stars', 'space');
    expect(result).toBe(targetId);
  });

  test('returns null when LLM returns unrecognized ID', async () => {
    callGeminiText.mockResolvedValue({ text: 'totally_made_up_id' });

    const result = await matchTitleToPlot('Mystery Title', 'birthday');
    expect(result).toBeNull();
  });

  test('returns null and does not throw when LLM call fails', async () => {
    callGeminiText.mockRejectedValue(new Error('API timeout'));

    const result = await matchTitleToPlot('Some Title', 'birthday');
    expect(result).toBeNull();
  });

  test('skips LLM call for placeholder titles', async () => {
    expect(await matchTitleToPlot("Luna's Story", 'birthday')).toBeNull();
    expect(await matchTitleToPlot("A Story for Luna", 'adventure')).toBeNull();
    expect(await matchTitleToPlot("My Story", 'space')).toBeNull();
    expect(callGeminiText).not.toHaveBeenCalled();
  });

  test('does NOT skip real titles that happen to contain "story"', async () => {
    const targetId = THEME_PLOTS.bedtime[0].id;
    callGeminiText.mockResolvedValue({ text: targetId });

    const result = await matchTitleToPlot("Luna's Bedtime Story Adventure", 'bedtime');
    expect(result).toBe(targetId);
    expect(callGeminiText).toHaveBeenCalledTimes(1);
  });
});

describe('isPlaceholderTitle', () => {
  test('detects standard placeholder formats', () => {
    expect(isPlaceholderTitle("Luna's Story")).toBe(true);
    expect(isPlaceholderTitle("A Story for Luna")).toBe(true);
    expect(isPlaceholderTitle("My Story")).toBe(true);
    expect(isPlaceholderTitle("  Luna's Story  ")).toBe(true);
  });

  test('does not flag real titles', () => {
    expect(isPlaceholderTitle("Luna's Runaway Balloon")).toBe(false);
    expect(isPlaceholderTitle("The Birthday Surprise")).toBe(false);
    expect(isPlaceholderTitle("Luna's Bedtime Story Adventure")).toBe(false);
    expect(isPlaceholderTitle("Daddy and Luna's Big Day")).toBe(false);
  });
});
