process.env.GEMINI_API_KEY = 'test-key';
jest.mock('../../services/gcsStorage', () => ({ uploadBuffer: jest.fn().mockResolvedValue('https://saved.example/art.png') }));
const { verifyImageText, generateIllustration } = require('../../services/illustrationGenerator');
const { uploadBuffer } = require('../../services/gcsStorage');
const originalFetch = global.fetch;
const letters = text => text.split(' ').map(w => [...w].join('|')).join(' ');
const reply = (transcript, extra = {}) => ({ ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ text_found: !!transcript, transcript }) }] }, ...extra }] }) });
afterEach(() => { global.fetch = originalFetch; jest.clearAllMocks(); });

test('the reader never receives the expected words, has enough non-thinking output, and checks all text parts', async () => {
  global.fetch = jest.fn().mockResolvedValueOnce(reply('PrivateName walked home.')).mockResolvedValue(reply(letters('PrivateName walked home.')));
  expect(await verifyImageText(Buffer.from('image'), 'PrivateName walked home.')).toMatchObject({ status: 'verified' });
  const body = JSON.parse(global.fetch.mock.calls[0][1].body);
  const prompt = body.contents[0].parts.find(p => p.text).text;
  expect(prompt).not.toContain('PrivateName');
  expect(prompt).toContain('Never correct spelling');
  expect(body.generationConfig).toMatchObject({ maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } });
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
  global.fetch = jest.fn(async (url, init) => {
    if (url.includes('gemini-2.5-flash')) { reads++; return reply(init.body.includes('CHARACTER MODE') ? letters('Siiver leaves.') : 'Siiver leaves.'); }
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

test('a full-image reader that silently corrects a typo is overruled by two magnified glyph readings', async () => {
  const sharp = require('sharp');
  const source = await sharp({ create: { width: 1000, height: 600, channels: 3, background: '#123456' } }).png().toBuffer();
  global.fetch = jest.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ text_found: true, transcript: 'Silver leaves.', text_bbox: { x: 0.6, y: 0.2, w: 0.3, h: 0.3 } }) }] } }] }) })
    .mockResolvedValue(reply(letters('Siiver leaves.')));
  const result = await verifyImageText(source, 'Silver leaves.');
  expect(result).toMatchObject({ status: 'mismatch', attempts: 3 });
  expect(result.issues[0]).toContain('read "siiver"');
  const body = JSON.parse(global.fetch.mock.calls[1][1].body);
  const zoom = Buffer.from(body.contents[0].parts[0].inline_data.data, 'base64');
  expect(zoom.equals(source)).toBe(false);
  expect((await sharp(zoom).metadata()).width).toBe(2400);
});

test('lettering repair preserves pixels outside the text column and requests the same font and spacing', async () => {
  const sharp = require('sharp');
  const { repairImageText } = require('../../services/illustrationGenerator');
  const source = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#123456' } }).png().toBuffer();
  const changed = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#abcdef' } }).png().toBuffer();
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: changed.toString('base64') } }] } }] }) });
  const edited = await repairImageText(source, 'Silver leaves.', { textBox: { x: 0.6, y: 0.2, w: 0.3, h: 0.4 } });
  const untouched = { left: 0, top: 0, width: 800, height: 900 };
  expect((await sharp(edited).extract(untouched).removeAlpha().raw().toBuffer()).equals(await sharp(source).extract(untouched).removeAlpha().raw().toBuffer())).toBe(true);
  expect(edited.equals(source)).toBe(false);
  const body = JSON.parse(global.fetch.mock.calls[0][1].body);
  expect(body.contents[0].parts[0].text).toContain('font face, weight, small letter size, ink colour, line spacing');
  expect(body.contents[0].parts[0].text).toContain('blank line between sentences');
  expect(body.contents[0].parts[0].text).toContain('5–7 words per line');
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test('an unreliable repair location is rejected without buying another image', async () => {
  const { repairImageText } = require('../../services/illustrationGenerator');
  global.fetch = jest.fn();
  await expect(repairImageText(Buffer.from('image'), 'Silver.', { textBox: { x: 0, y: 0, w: 1, h: 1 } })).rejects.toThrow('reliable text-column');
  expect(global.fetch).not.toHaveBeenCalled();
});
