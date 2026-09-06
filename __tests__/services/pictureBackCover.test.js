process.env.GEMINI_API_KEY = 'test-key';
jest.mock('../../services/gcsStorage', () => ({
  downloadBuffer: jest.fn(async () => { throw new Error('not found'); }),
  uploadBuffer: jest.fn(async () => {}),
  getSignedUrl: jest.fn(async () => 'https://storage.example/back.png'),
}));
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const { generateCover, qaBackCoverArtwork } = require('../../services/coverGenerator');
const { backCoverCopy, pictureBackCoverPrompt, pictureBackCoverCachePath } = require('../../services/pictureBackCover');
const storage = require('../../services/gcsStorage');
let image;
let requests;
let fetchSpy;
const opts = { title: 'Ziv and the Moonlit Map', childName: 'Ziv', synopsis: 'Ziv follows a glowing map through the trees.', bookId: 'preview-book' };
beforeEach(async () => {
  jest.clearAllMocks();
  storage.downloadBuffer.mockRejectedValue(new Error('not found'));
  image = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#234567' } }).png().toBuffer();
  requests = [];
  fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    requests.push({ url, ...JSON.parse(init.body) });
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: String(url).includes('flash-image')
      ? [{ inlineData: { mimeType: 'image/png', data: image.toString('base64') } }]
      : [{ text: JSON.stringify({ readable_text: true, text_mismatch: false }) }] } }] }) };
  });
});
afterEach(() => fetchSpy.mockRestore());

async function render(extra = {}) {
  return generateCover(opts.title, { name: opts.childName }, null, 'PICTURE_BOOK', {
    ...opts, preGeneratedCoverBuffer: image, reuseApprovedArtworkOnly: true, allowBackCoverGeneration: true,
    cacheBackCover: true, requireCompleteCover: true, ...extra,
  });
}

test('Gemini receives the front reference and exact copy; PDF does not cover its designed typography with another panel', async () => {
  const result = await render();
  const generations = requests.filter(r => r.url.includes('flash-image'));
  expect(generations).toHaveLength(1);
  expect(generations[0].contents[0].parts[0].text).toContain(opts.synopsis);
  expect(generations[0].contents[0].parts[1].inline_data.data).toBeTruthy();
  expect(generations[0].generationConfig.imageConfig).toEqual({ aspectRatio: '1:1', imageSize: '2K' });
  expect((await PDFDocument.load(result.coverPdfBuffer)).getPageCount()).toBe(1);
  const cached = storage.uploadBuffer.mock.calls.find(c => c[1].includes('/back-covers/'));
  expect(cached[2]).toBe('image/png');
  expect(await sharp(cached[0]).metadata()).toMatchObject({ width: 2550, height: 2550 });
});

test('PDF rebuild reuses the finished back including text and codes, without calling Gemini', async () => {
  const cached = await sharp(image).resize(2550, 2550).png().toBuffer();
  storage.downloadBuffer.mockResolvedValue(cached);
  await render({ allowBackCoverGeneration: false });
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(storage.downloadBuffer).toHaveBeenCalledWith(pictureBackCoverCachePath(image, opts));
});

test('copy and artwork changes invalidate only the back-cover cache', () => {
  const key = pictureBackCoverCachePath(image, opts);
  expect(pictureBackCoverCachePath(image, { ...opts, synopsis: 'A new synopsis.' })).not.toBe(key);
  expect(pictureBackCoverCachePath(Buffer.from('other image'), opts)).not.toBe(key);
  expect(pictureBackCoverCachePath(image, { ...opts, bindingType: 'HARDCOVER' })).toBe(key);
});

test('the reference, exact text and reserved code areas survive a bounded typography retry', async () => {
  let judgeCalls = 0;
  fetchSpy.mockImplementation(async (url, init) => {
    requests.push({ url, ...JSON.parse(init.body) });
    const parts = String(url).includes('flash-image')
      ? [{ inlineData: { mimeType: 'image/png', data: image.toString('base64') } }]
      : [{ text: JSON.stringify({ readable_text: true, text_mismatch: ++judgeCalls === 1 }) }];
    return { ok: true, json: async () => ({ candidates: [{ content: { parts } }] }) };
  });
  await render();
  const generations = requests.filter(r => r.url.includes('flash-image'));
  expect(generations).toHaveLength(2);
  expect(generations[1].contents[0].parts).toHaveLength(2);
  expect(generations[1].contents[0].parts[0].text).toContain('Correct the previous attempt');
});

test('text is intentional for the new design but remains rejected in legacy text-free artwork', async () => {
  expect((await qaBackCoverArtwork(image, 'test', { ...opts, embeddedText: true })).pass).toBe(true);
  expect((await qaBackCoverArtwork(image, 'test')).pass).toBe(false);
});

test('the design does not duplicate a signed dedication or ask for painted machine codes', () => {
  expect(backCoverCopy({ ...opts, heartfeltNote: 'With love from Dad.', bookFrom: 'Dad' }).dedication).toBe('With love from Dad.');
  expect(pictureBackCoverPrompt(opts)).toContain('Do not draw your own QR');
});
