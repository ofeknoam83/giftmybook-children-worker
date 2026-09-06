process.env.GEMINI_API_KEY = 'test-key';
jest.mock('../../services/gcsStorage', () => ({ uploadBuffer: jest.fn().mockResolvedValue('https://saved.example/art.png') }));
const { verifyImageText, generateIllustration } = require('../../services/illustrationGenerator');
const { uploadBuffer } = require('../../services/gcsStorage');
const originalFetch = global.fetch;
const reply = (transcript, extra = {}) => ({ ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ text_found: !!transcript, transcript }) }] }, ...extra }] }) });
afterEach(() => { global.fetch = originalFetch; jest.clearAllMocks(); });

test('the reader never receives the expected words, has enough non-thinking output, and checks all text parts', async () => {
  global.fetch = jest.fn().mockResolvedValue(reply('PrivateName walked home.'));
  expect(await verifyImageText(Buffer.from('image'), 'PrivateName walked home.')).toMatchObject({ status: 'verified' });
  const body = JSON.parse(global.fetch.mock.calls[0][1].body);
  const prompt = body.contents[0].parts.find(p => p.text).text;
  expect(prompt).not.toContain('PrivateName');
  expect(prompt).toContain('Never correct spelling');
  expect(body.generationConfig).toMatchObject({ maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } });
});

test.each([
  { ok: false, status: 503 },
  reply('', { finishReason: 'MAX_TOKENS' }),
  { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }) },
])('an unavailable or incomplete reader fails closed', async response => {
  global.fetch = jest.fn().mockResolvedValue(response);
  expect(await verifyImageText(Buffer.from('image'), 'The fox waved.')).toMatchObject({ status: 'unverified', valid: false });
  expect(global.fetch).toHaveBeenCalledTimes(2);
});

test('the final legacy image attempt cannot bypass spelling or upload bad lettering', async () => {
  let images = 0, reads = 0;
  global.fetch = jest.fn(async (url) => {
    if (url.includes('gemini-2.5-flash')) { reads++; return reply('Siiver leaves.'); }
    images++;
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: 'YQ==', mimeType: 'image/png' } }] } }] }) };
  });
  await expect(generateIllustration('Forest.', 'https://p/x.png', 'pixar_premium', {
    _cachedPhotoBase64: 'YQ==', bookId: 'test', embedText: true, pageText: 'Silver leaves.',
  })).rejects.toThrow('No illustration generated');
  expect(images).toBe(3);
  expect(reads).toBe(6);
  expect(uploadBuffer).not.toHaveBeenCalled();
});

test('a reader outage stops legacy image retries instead of generating five more pictures', async () => {
  let images = 0;
  global.fetch = jest.fn(async url => {
    if (url.includes('gemini-2.5-flash')) return { ok: false, status: 503 };
    images++;
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: 'YQ==', mimeType: 'image/png' } }] } }] }) };
  });
  await expect(generateIllustration('Forest.', 'https://p/x.png', 'pixar_premium', {
    _cachedPhotoBase64: 'YQ==', bookId: 'test', embedText: true, pageText: 'Silver leaves.',
  })).rejects.toMatchObject({ failureCode: 'embedded_text_unverified' });
  expect(images).toBe(1);
});
