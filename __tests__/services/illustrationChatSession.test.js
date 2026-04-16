// Mock illustrationGenerator exports used by illustrationChatSession
jest.mock('../../services/illustrationGenerator', () => ({
  fetchWithTimeout: jest.fn(),
  ART_STYLE_CONFIG: {
    watercolor: {
      prefix: "children's book watercolor illustration,",
      suffix: 'soft watercolor textures, gentle colors, hand-painted look',
    },
    pixar_premium: {
      prefix: "Cinematic 3D Pixar-like soft render children's book illustration,",
      suffix: 'photorealistic 3D CGI render, soft volumetric cinematic lighting',
    },
  },
}));

const {
  createIllustrationSession,
  establishCharacter,
  generateSpreadInSession,
  trimSessionHistory,
  _countImagesInHistory,
  _buildCharacterEstablishmentPrompt,
} = require('../../services/illustrationChatSession');
const { fetchWithTimeout } = require('../../services/illustrationGenerator');

describe('illustrationChatSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    // Provide a test API key
    process.env.GEMINI_API_KEY = 'test-key-123';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.GEMINI_API_KEY;
  });

  describe('createIllustrationSession', () => {
    test('creates a session with default model', () => {
      const session = createIllustrationSession({
        style: 'watercolor',
        childName: 'Emma',
        characterDescription: 'Brown curly hair',
        characterOutfit: 'Red dress with white polka dots',
      });

      expect(session).toBeDefined();
      expect(session.model).toBe('gemini-3.1-flash-image-preview');
      expect(session.history).toEqual([]);
      expect(session.turnsUsed).toBe(0);
      expect(session.abandoned).toBe(false);
      expect(session.opts.childName).toBe('Emma');
    });

    test('uses custom model when provided', () => {
      const session = createIllustrationSession({
        model: 'gemini-custom-model',
        style: 'watercolor',
      });

      expect(session.model).toBe('gemini-custom-model');
    });

    test('falls back to watercolor style for unknown styles', () => {
      const session = createIllustrationSession({ style: 'unknown_style' });
      expect(session.styleConfig.prefix).toContain('watercolor');
    });

    test('uses provided API key over pool', () => {
      const session = createIllustrationSession({ apiKey: 'custom-key' });
      expect(session.apiKey).toBe('custom-key');
    });

    test('throws if no API key available', () => {
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_AI_STUDIO_KEY;
      for (let i = 1; i <= 10; i++) delete process.env[`GEMINI_API_KEY_${i}`];

      expect(() => createIllustrationSession({ style: 'watercolor' })).toThrow('No API key');
    });
  });

  describe('establishCharacter', () => {
    test('sends character establishment turn and stores response in history', async () => {
      fetchWithTimeout.mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [{
            content: {
              parts: [
                { text: 'I understand. I will maintain character consistency.', thought_signature: 'sig_ack' },
              ],
            },
          }],
        }),
      });

      const session = createIllustrationSession({
        style: 'watercolor',
        characterPhotoBase64: 'photo_base64_data',
        characterPhotoMime: 'image/jpeg',
        coverBase64: 'cover_base64_data',
        coverMime: 'image/png',
        childName: 'Emma',
        characterAnchor: 'Light skin, brown eyes',
        characterDescription: 'Curly brown hair, big eyes',
        characterOutfit: 'Red dress with white dots',
      });

      await establishCharacter(session);

      // Verify history has user + model turn
      expect(session.history.length).toBe(2);
      expect(session.history[0].role).toBe('user');
      expect(session.history[1].role).toBe('model');

      // Verify user turn includes photo and cover inline_data
      const userParts = session.history[0].parts;
      const inlineDataParts = userParts.filter(p => p.inline_data);
      expect(inlineDataParts.length).toBe(2); // photo + cover

      // Verify text-only response modalities were requested
      const callBody = JSON.parse(fetchWithTimeout.mock.calls[0][1].body);
      expect(callBody.generationConfig.responseModalities).toEqual(['TEXT']);

      // Verify turns counter
      expect(session.turnsUsed).toBe(1);
    });

    test('includes character anchor and outfit in establishment prompt', async () => {
      fetchWithTimeout.mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [{
            content: { parts: [{ text: 'OK' }] },
          }],
        }),
      });

      const session = createIllustrationSession({
        style: 'watercolor',
        characterAnchor: 'Dark skin, brown eyes',
        characterOutfit: 'Blue overalls, white t-shirt',
        childName: 'Marcus',
        recurringElement: 'A small brown teddy bear',
        keyObjects: 'Magic wand, star-shaped hat',
      });

      await establishCharacter(session);

      const userText = session.history[0].parts[0].text;
      expect(userText).toContain('Dark skin, brown eyes');
      expect(userText).toContain('Blue overalls, white t-shirt');
      expect(userText).toContain('Marcus');
      expect(userText).toContain('small brown teddy bear');
      expect(userText).toContain('Magic wand, star-shaped hat');
    });
  });

  describe('thought_signature preservation', () => {
    test('preserves thought_signature fields in model response history', async () => {
      // First call: establishment
      fetchWithTimeout.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{
            content: {
              parts: [{ text: 'OK' }],
            },
          }],
        }),
      });

      const session = createIllustrationSession({
        style: 'watercolor',
        characterPhotoBase64: 'photo_data',
      });
      await establishCharacter(session);

      // Second call: generate spread with thought_signatures in response
      fetchWithTimeout.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{
            content: {
              parts: [
                { text: 'Here is the illustration.', thought_signature: 'sig_text_A' },
                {
                  inlineData: { mimeType: 'image/png', data: Buffer.from('fake-image').toString('base64') },
                  thought_signature: 'sig_image_B',
                },
              ],
            },
          }],
        }),
      });

      await generateSpreadInSession(session, 'A child in a garden', { spreadIndex: 0 });

      // Verify thought_signatures are preserved in history
      const modelResponse = session.history[session.history.length - 1];
      expect(modelResponse.role).toBe('model');

      const textPart = modelResponse.parts.find(p => p.text);
      expect(textPart.thought_signature).toBe('sig_text_A');

      const imagePart = modelResponse.parts.find(p => p.inlineData);
      expect(imagePart.thought_signature).toBe('sig_image_B');
    });

    test('handles parts without thought_signature gracefully', async () => {
      fetchWithTimeout.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{
            content: { parts: [{ text: 'OK' }] },
          }],
        }),
      });

      const session = createIllustrationSession({ style: 'watercolor' });
      await establishCharacter(session);

      fetchWithTimeout.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{
            content: {
              parts: [
                { text: 'Description without signature' },
                { inlineData: { mimeType: 'image/png', data: Buffer.from('img').toString('base64') } },
              ],
            },
          }],
        }),
      });

      await generateSpreadInSession(session, 'A scene', { spreadIndex: 0 });

      const modelResponse = session.history[session.history.length - 1];
      const textPart = modelResponse.parts.find(p => p.text);
      expect(textPart.thought_signature).toBeUndefined();
    });
  });

  describe('trimSessionHistory', () => {
    function buildMockHistory(turnCount) {
      const history = [];
      // Turn 1: establishment (user with 2 images + model text)
      history.push({
        role: 'user',
        parts: [
          { text: 'Establish character' },
          { inline_data: { mimeType: 'image/jpeg', data: 'photo_base64' } },
          { inline_data: { mimeType: 'image/jpeg', data: 'cover_base64' } },
        ],
      });
      history.push({
        role: 'model',
        parts: [{ text: 'Character understood.' }],
      });

      // Spread turns: user text + model (text + image)
      for (let i = 1; i < turnCount; i++) {
        history.push({
          role: 'user',
          parts: [{ text: `Generate spread ${i}` }],
        });
        history.push({
          role: 'model',
          parts: [
            { text: `Spread ${i} generated`, thought_signature: `sig_${i}` },
            { inlineData: { mimeType: 'image/png', data: `image_${i}` }, thought_signature: `sig_img_${i}` },
          ],
        });
      }
      return history;
    }

    test('does not trim when under image limit', () => {
      const session = createIllustrationSession({ style: 'watercolor' });
      session.history = buildMockHistory(3); // 2 (establishment) + 2 (spread images) = 4 images
      const originalLength = session.history.length;

      trimSessionHistory(session);

      expect(session.history.length).toBe(originalLength); // No change
    });

    test('trims when over image limit', () => {
      const session = createIllustrationSession({ style: 'watercolor' });
      session.history = buildMockHistory(12); // 2 + 11 images = 13 images (over 10 limit)

      const originalLength = session.history.length;
      trimSessionHistory(session);

      // Should be trimmed
      expect(session.history.length).toBeLessThan(originalLength);
    });

    test('always keeps first exchange (character establishment)', () => {
      const session = createIllustrationSession({ style: 'watercolor' });
      session.history = buildMockHistory(12);

      trimSessionHistory(session);

      // First exchange should still be the character establishment
      expect(session.history[0].role).toBe('user');
      expect(session.history[0].parts[0].text).toBe('Establish character');
      expect(session.history[1].role).toBe('model');
      expect(session.history[1].parts[0].text).toBe('Character understood.');
    });

    test('keeps the last N turns', () => {
      const session = createIllustrationSession({ style: 'watercolor' });
      session.history = buildMockHistory(12);

      trimSessionHistory(session);

      // Last turns should be the most recent spreads
      const lastModelMsg = session.history[session.history.length - 1];
      expect(lastModelMsg.role).toBe('model');
      expect(lastModelMsg.parts[0].text).toBe('Spread 11 generated');
    });

    test('inserts text summary placeholder for dropped turns', () => {
      const session = createIllustrationSession({ style: 'watercolor' });
      session.history = buildMockHistory(12);
      session.spreadSummaries = {};
      for (let i = 1; i < 12; i++) {
        session.spreadSummaries[i] = `Scene ${i}: child in location ${i}`;
      }

      trimSessionHistory(session);

      // Find the summary placeholder turn
      const summaryTurn = session.history.find(
        msg => msg.role === 'user' && msg.parts[0]?.text?.includes('Previously generated')
      );
      expect(summaryTurn).toBeDefined();
      expect(summaryTurn.parts[0].text).toContain('Previously generated');
    });
  });

  describe('_countImagesInHistory', () => {
    test('counts inline_data parts (snake_case)', () => {
      const history = [
        { role: 'user', parts: [{ text: 'hello' }, { inline_data: { data: 'x' } }] },
        { role: 'model', parts: [{ text: 'ok' }] },
      ];
      expect(_countImagesInHistory(history)).toBe(1);
    });

    test('counts inlineData parts (camelCase)', () => {
      const history = [
        { role: 'model', parts: [{ inlineData: { data: 'y' } }] },
      ];
      expect(_countImagesInHistory(history)).toBe(1);
    });

    test('counts both formats', () => {
      const history = [
        { role: 'user', parts: [{ inline_data: { data: 'a' } }, { inline_data: { data: 'b' } }] },
        { role: 'model', parts: [{ inlineData: { data: 'c' } }, { text: 'desc' }] },
      ];
      expect(_countImagesInHistory(history)).toBe(3);
    });

    test('returns 0 for empty history', () => {
      expect(_countImagesInHistory([])).toBe(0);
    });
  });

  describe('_buildCharacterEstablishmentPrompt', () => {
    test('includes art style from session config', () => {
      const session = createIllustrationSession({ style: 'watercolor' });
      const prompt = _buildCharacterEstablishmentPrompt(session);
      expect(prompt).toContain('watercolor');
    });

    test('includes character details', () => {
      const session = createIllustrationSession({
        style: 'watercolor',
        characterAnchor: 'Dark skin, big brown eyes',
        characterDescription: 'Short curly black hair',
        characterOutfit: 'Yellow raincoat',
        childName: 'Zara',
        additionalCoverCharacters: 'Mom with long braids',
      });
      const prompt = _buildCharacterEstablishmentPrompt(session);

      expect(prompt).toContain('Dark skin, big brown eyes');
      expect(prompt).toContain('Short curly black hair');
      expect(prompt).toContain('Yellow raincoat');
      expect(prompt).toContain('Zara');
      expect(prompt).toContain('Mom with long braids');
    });

    test('includes recurring element and key objects', () => {
      const session = createIllustrationSession({
        style: 'watercolor',
        recurringElement: 'A small grey kitten',
        keyObjects: 'Magic wand, golden crown',
      });
      const prompt = _buildCharacterEstablishmentPrompt(session);

      expect(prompt).toContain('small grey kitten');
      expect(prompt).toContain('Magic wand, golden crown');
    });

    test('includes text rendering instructions', () => {
      const session = createIllustrationSession({ style: 'watercolor' });
      const prompt = _buildCharacterEstablishmentPrompt(session);

      expect(prompt).toContain('TEXT RENDERING RULES FOR ALL ILLUSTRATIONS');
      expect(prompt).toContain('story text rendered directly INTO the image');
      expect(prompt).toContain('consistent, playful, highly readable');
      expect(prompt).toContain('white or light-colored text with a dark drop shadow');
      expect(prompt).toContain('NEVER change the font style, size, or color between pages');
    });
  });

  describe('generateSpreadInSession', () => {
    test('returns image buffer from successful response', async () => {
      const fakeImageData = Buffer.from('fake-png-image-data').toString('base64');

      // Establishment
      fetchWithTimeout.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'OK' }] } }],
        }),
      });

      const session = createIllustrationSession({ style: 'watercolor' });
      await establishCharacter(session);

      // Spread generation
      fetchWithTimeout.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{
            content: {
              parts: [
                { text: 'Illustration description' },
                { inlineData: { mimeType: 'image/png', data: fakeImageData } },
              ],
            },
          }],
        }),
      });

      const result = await generateSpreadInSession(session, 'Child playing in garden', {
        spreadIndex: 0,
        aspectRatio: '16:9',
      });

      expect(result.imageBuffer).toBeInstanceOf(Buffer);
      expect(result.imageBase64).toBe(fakeImageData);
    });

    test('throws when session is abandoned', async () => {
      const session = createIllustrationSession({ style: 'watercolor' });
      session.abandoned = true;

      await expect(
        generateSpreadInSession(session, 'A scene')
      ).rejects.toThrow('abandoned');
    });

    test('throws when no image in response', async () => {
      fetchWithTimeout.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'OK' }] } }],
        }),
      });

      const session = createIllustrationSession({ style: 'watercolor' });
      await establishCharacter(session);

      fetchWithTimeout.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'No image here' }] } }],
        }),
      });

      await expect(
        generateSpreadInSession(session, 'A scene', { spreadIndex: 0 })
      ).rejects.toThrow('No image');
    });

    test('removes failed user message from history on API error', async () => {
      fetchWithTimeout.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'OK' }] } }],
        }),
      });

      const session = createIllustrationSession({ style: 'watercolor' });
      await establishCharacter(session);

      const historyLengthBefore = session.history.length;

      fetchWithTimeout.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal server error',
      });

      await expect(
        generateSpreadInSession(session, 'A scene', { spreadIndex: 0 })
      ).rejects.toThrow('500');

      // History should not have the failed user message
      expect(session.history.length).toBe(historyLengthBefore);
    });

    test('sets isNsfw flag on safety blocks', async () => {
      fetchWithTimeout.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'OK' }] } }],
        }),
      });

      const session = createIllustrationSession({ style: 'watercolor' });
      await establishCharacter(session);

      fetchWithTimeout.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'blocked due to safety policy',
      });

      try {
        await generateSpreadInSession(session, 'A scene', { spreadIndex: 0 });
        fail('Should have thrown');
      } catch (err) {
        expect(err.isNsfw).toBe(true);
      }
    });

    test('appends both user and model messages to history on success', async () => {
      fetchWithTimeout.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'OK' }] } }],
        }),
      });

      const session = createIllustrationSession({ style: 'watercolor' });
      await establishCharacter(session);

      const historyBefore = session.history.length;

      fetchWithTimeout.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{
            content: {
              parts: [
                { text: 'Generated' },
                { inlineData: { mimeType: 'image/png', data: Buffer.from('img').toString('base64') } },
              ],
            },
          }],
        }),
      });

      await generateSpreadInSession(session, 'A scene', { spreadIndex: 0 });

      // Should have added user + model = 2 messages
      expect(session.history.length).toBe(historyBefore + 2);
      expect(session.history[session.history.length - 2].role).toBe('user');
      expect(session.history[session.history.length - 1].role).toBe('model');
    });

    test('includes page text in prompt when pageText is provided', async () => {
      fetchWithTimeout.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'OK' }] } }],
        }),
      });

      const session = createIllustrationSession({ style: 'watercolor' });
      await establishCharacter(session);

      fetchWithTimeout.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{
            content: {
              parts: [
                { text: 'Generated' },
                { inlineData: { mimeType: 'image/png', data: Buffer.from('img').toString('base64') } },
              ],
            },
          }],
        }),
      });

      await generateSpreadInSession(session, 'Child flying a kite', {
        spreadIndex: 0,
        pageText: 'The kite soared high above the trees!',
      });

      // Check the user prompt sent to the API includes the page text
      const spreadCall = fetchWithTimeout.mock.calls[1];
      const body = JSON.parse(spreadCall[1].body);
      const userContent = body.contents[body.contents.length - 1];
      expect(userContent.role).toBe('user');
      const promptText = userContent.parts[0].text;
      expect(promptText).toContain('STORY TEXT TO RENDER ON THIS PAGE');
      expect(promptText).toContain('The kite soared high above the trees!');
      expect(promptText).not.toContain('Do NOT render any text');
    });

    test('instructs no text rendering when pageText is not provided', async () => {
      fetchWithTimeout.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'OK' }] } }],
        }),
      });

      const session = createIllustrationSession({ style: 'watercolor' });
      await establishCharacter(session);

      fetchWithTimeout.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{
            content: {
              parts: [
                { text: 'Generated' },
                { inlineData: { mimeType: 'image/png', data: Buffer.from('img').toString('base64') } },
              ],
            },
          }],
        }),
      });

      await generateSpreadInSession(session, 'Child flying a kite', {
        spreadIndex: 0,
      });

      const spreadCall = fetchWithTimeout.mock.calls[1];
      const body = JSON.parse(spreadCall[1].body);
      const userContent = body.contents[body.contents.length - 1];
      const promptText = userContent.parts[0].text;
      expect(promptText).toContain('Do NOT render any text');
      expect(promptText).not.toContain('STORY TEXT TO RENDER ON THIS PAGE');
    });
  });
});
