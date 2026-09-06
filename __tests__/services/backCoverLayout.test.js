process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
const { PDFDocument, StandardFonts } = require('pdf-lib');
const sharp = require('sharp');
const { drawBookBackCover, fitLines } = require('../../services/backCoverLayout');
const { backCoverSynopsis } = require('../../services/catalogEngine/backCoverSynopsis');
const { generateCover } = require('../../services/coverGenerator');

test.each([9, 63])('the back-cover text and barcode fit within trim with %spt wrap', async edgeBleed => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([2 * 612 + 2 * edgeBleed + 18, 612 + 2 * edgeBleed]);
  const drawText = jest.spyOn(page, 'drawText');
  const drawImage = jest.spyOn(page, 'drawImage');
  const bounds = await drawBookBackCover(page, { edgeBleed, trimWidth: 612, totalHeight: page.getHeight() }, {
    title: 'Ziv and the Very Long Title of an Extraordinary Adventure in a World of Dreams',
    synopsis: 'A child follows the moonlit path and discovers an unexpected mystery. '.repeat(20),
    heartfeltNote: 'We love you to the stars and back. '.repeat(20), bookFrom: 'Mom and Dad', childName: 'Ziv',
    bookId: 'b5ba2850-8fbf-46a7-9d90-3aabebeadba2',
  });
  expect(bounds.summaryBottom).toBeGreaterThan(bounds.footerTop + 30);
  for (const [text, opts] of drawText.mock.calls) {
    expect(opts.x).toBeGreaterThanOrEqual(edgeBleed + 45);
    expect(opts.x + opts.font.widthOfTextAtSize(text, opts.size)).toBeLessThanOrEqual(edgeBleed + 612 - 45);
    expect(opts.y).toBeGreaterThan(edgeBleed + 45);
    expect(opts.y).toBeLessThan(page.getHeight() - edgeBleed - 45);
  }
  expect(drawImage).toHaveBeenCalledTimes(2); // QR stays available even in the emergency fallback.
  expect(drawText.mock.calls.map(c => c[0]).join(' ')).toContain('BOOK REFERENCE');
  expect((await PDFDocument.load(await doc.save())).getPageCount()).toBe(1);
});

test('long unbroken words cannot extend outside the text panel', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines = fitLines('x'.repeat(300), font, 15, 100, 2);
  expect(lines).toHaveLength(1);
  expect(font.widthOfTextAtSize(lines[0], 15)).toBeLessThanOrEqual(100);
});

test('the local blurb uses the actual opening and stops before the story ending', () => {
  const first = 'Ziv found a quiet path beneath the stars. ';
  const synopsis = backCoverSynopsis({ spreads: [{ text: first.repeat(12) }, { text: 'A mystery began.' }, { text: 'The ending and solution.' }] });
  expect(synopsis.split(/\s+/).length).toBeLessThanOrEqual(65);
  expect(synopsis).toContain(first.trim());
  expect(synopsis).not.toContain('ending');
});

test.each(['PAPERBACK', 'HARDCOVER'])('the saved-art fallback produces a full %s cover without external requests', async bindingType => {
  const front = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#789abc' } }).png().toBuffer();
  const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('No external requests allowed'));
  try {
    const result = await generateCover('Ziv and the Stars', { name: 'Ziv' }, null, 'PICTURE_BOOK', {
      preGeneratedCoverBuffer: front, reuseApprovedArtworkOnly: true, requireCompleteCover: true,
      bookId: 'preview-book', pageCount: 36, bindingType, synopsis: 'Ziv discovers a little mystery on a moonlit path.',
    });
    const doc = await PDFDocument.load(result.coverPdfBuffer);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPages()[0].getWidth()).toBeGreaterThan(1224);
    expect(doc.getPages()[0].getHeight()).toBe(bindingType === 'HARDCOVER' ? 738 : 630);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally { fetchSpy.mockRestore(); }
});

test('corrupt approved artwork cannot silently produce a blank front cover', async () => {
  await expect(generateCover('Ziv', { name: 'Ziv' }, null, 'PICTURE_BOOK', {
    preGeneratedCoverBuffer: Buffer.from('not an image'), reuseApprovedArtworkOnly: true, requireCompleteCover: true,
    bookId: 'preview-book', pageCount: 32,
  })).rejects.toThrow('without the front artwork');
});
