'use strict';

jest.mock('../../services/catalogEngine/flags', () => ({
  coverOutpaint: jest.fn(() => 'casewrap'),
  coverOutpaintSize: jest.fn(() => '2K'),
  coverImageSize: jest.fn(() => '2K'),
}));

jest.mock('../../services/illustrationGenerator', () => ({
  generateIllustration: jest.fn(),
  getNextApiKey: jest.fn(() => 'test-key'),
  fetchWithTimeout: jest.fn(),
  renderStyleBlock: jest.fn(() => 'STYLE BLOCK'),
  ART_STYLE_CONFIG: { pixar_premium: {}, cinematic_3d: {} },
  canonicalBookArtStyle: jest.fn(x => x),
  callGeminiImageParts: jest.fn(),
}));

const sharp = require('sharp');
const { fetchWithTimeout, callGeminiImageParts } = require('../../services/illustrationGenerator');
const { harmonizeChosenCoverToInteriorStyle, extendWithOutpaint } = require('../../services/coverGenerator');

const png = (width, height, background) => sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();

test('harmonizeChosenCoverToInteriorStyle passes the cover image tier through Gemini imageConfig', async () => {
  const img = await png(64, 64, '#88aadd');
  fetchWithTimeout.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: img.toString('base64') } }] } }],
    }),
  });
  const out = await harmonizeChosenCoverToInteriorStyle(img, { coverImageSize: '4K' });
  expect(Buffer.isBuffer(out)).toBe(true);
  const body = JSON.parse(fetchWithTimeout.mock.calls[0][1].body);
  expect(body.generationConfig.imageConfig).toEqual({ imageSize: '4K' });
});

test('extendWithOutpaint rejects a result with one painted side but blank top/bottom bands', async () => {
  const trim = await png(20, 20, '#6699cc');
  const raw = Buffer.alloc(24 * 24 * 3, 255);
  for (let y = 0; y < 2; y += 1) {
    for (let x = 0; x < 24; x += 1) {
      const i = (y * 24 + x) * 3;
      raw[i] = 0;
      raw[i + 1] = 0;
      raw[i + 2] = 0;
    }
  }
  for (let y = 22; y < 24; y += 1) {
    for (let x = 0; x < 24; x += 1) {
      const i = (y * 24 + x) * 3;
      raw[i] = 0;
      raw[i + 1] = 0;
      raw[i + 2] = 0;
    }
  }
  for (let y = 2; y < 22; y += 1) {
    const tone = y % 2 === 0 ? 40 : 200;
    for (let x = 21; x < 23; x += 1) {
      const i = (y * 24 + x) * 3;
      raw[i] = tone;
      raw[i + 1] = 80;
      raw[i + 2] = 160;
    }
  }
  callGeminiImageParts.mockResolvedValueOnce(await sharp(raw, { raw: { width: 24, height: 24, channels: 3 } }).png().toBuffer());
  const out = await extendWithOutpaint(trim, { top: 2, bottom: 2, right: 2 }, { binding: 'casewrap', label: 'test' });
  expect(out.method).toBe('blur');
  expect(out.note).toMatch(/top painted band is flat or blank/);
});
