jest.mock('../../../services/shared/llm/openaiClient', () => ({ callText: jest.fn(async () => { throw new Error('offline'); }) }));
jest.mock('../../../services/layoutEngine', () => ({ assemblePdf: jest.fn(), OVERLAY: { MIN_CONTRAST: 4.5 } }));
jest.mock('../../../services/coverGenerator', () => ({ generateCover: jest.fn(), generateUpsellCovers: jest.fn(async () => []) }));
jest.mock('../../../services/gcsStorage', () => ({ uploadBuffer: jest.fn(async () => {}), getSignedUrl: jest.fn(async key => `https://storage.example/${key}`), downloadBuffer: jest.fn(async () => Buffer.from('approved-front')) }));
jest.mock('../../../services/catalogEngine/illustrator', () => ({ illustrateStory: jest.fn() }));
jest.mock('../../../services/catalogEngine/storyValidation', () => ({ validateStoryResponse: () => ({ ok: true }) }));
jest.mock('../../../services/catalogEngine/augments', () => ({ augmentsFor: () => ({ personalizationMap: null }) }));
jest.mock('../../../services/catalogEngine/catalog', () => ({
  getBook: () => ({ book: { premise: 'An abstract catalog rule.' }, themeId: 'dream', ageBand: '6_7' }),
  getBookForTag: async () => ({ book: { premise: 'An abstract catalog rule.' }, themeId: 'dream', ageBand: '6_7' }),
}));
jest.mock('../../../services/catalogEngine/writer', () => ({ generateStory: jest.fn() }));

const { PDFDocument } = require('pdf-lib');
const { runBookPipeline } = require('../../../services/catalogEngine/pipeline');
const { assemblePdf } = require('../../../services/layoutEngine');
const { generateCover, generateUpsellCovers } = require('../../../services/coverGenerator');
const { illustrateStory } = require('../../../services/catalogEngine/illustrator');
const { uploadBuffer, downloadBuffer } = require('../../../services/gcsStorage');
let interior;
let cover;
let input;

async function pdf(pages, size = [630, 630]) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage(size);
  return Buffer.from(await doc.save());
}
beforeEach(async () => {
  jest.clearAllMocks();
  interior = await pdf(36); cover = await pdf(1, [1260, 630]);
  assemblePdf.mockResolvedValue(interior);
  generateCover.mockReset().mockResolvedValue({ coverPdfBuffer: cover });
  uploadBuffer.mockReset().mockResolvedValue(undefined);
  generateUpsellCovers.mockReset().mockResolvedValue([]);
  illustrateStory.mockResolvedValue({
    entries: Array.from({ length: 12 }, (_, i) => ({ spread: i + 1, type: 'spread', captionText: 'Story.', spreadIllustrationStorageKey: `saved/spread-${i + 1}.png` })),
    qaAdvisories: [{ stage: 'spreadQa', spread: 7, note: 'Outfit warning retained' }], warnings: [],
    previewImageUrls: ['https://storage.example/art.png'], illustrationTuningUsed: 'none', bible: null, bookBible: { bibleHash: 'saved' },
  });
  const profile = { name: 'Ziv', age: 6, pronouns: { subject: 'she', object: 'her', possessive_adjective: 'her' } };
  input = {
    bookId: 'pdf-book', profile, storyPair: { request: { book_id: 'dream-book', profile, versions: { personalization_map: 'none' } },
      response: { title: 'Ziv and the Moonlight Shadow', spreads: [{ spread: 1, text: 'Ziv noticed a funny shadow beside her nightlight. She wanted to find out what made it move.' }, { spread: 2, text: 'With a small experiment and a little courage, she began looking for clues.' }] } },
    approvedCoverUrl: 'https://storage.googleapis.com/bucket/approved.png?expired=1',
    saveCheckpoint: jest.fn(async () => {}), log: jest.fn(),
  };
});

test('finishes both PDFs with QA warnings and uses the actual interior page count for the spine', async () => {
  const result = await runBookPipeline(input);
  expect(result).toMatchObject({ pageCount: 36, interiorPdfUrl: expect.stringContaining('/interior.pdf'), coverPdfUrl: expect.stringContaining('/cover.pdf') });
  expect(result.qaAdvisories).toContainEqual(expect.objectContaining({ spread: 7 }));
  expect(generateCover.mock.calls[0][4]).toMatchObject({ pageCount: 36, requireCompleteCover: true, preGeneratedCoverBuffer: Buffer.from('approved-front') });
  expect(result.storyContent.synopsis).toContain('Ziv noticed a funny shadow');
  expect(result.storyContent.synopsis).not.toContain('abstract catalog');
  expect(downloadBuffer).toHaveBeenCalledWith(input.approvedCoverUrl);
});

test('a failed cover render automatically falls back to approved front artwork and a typeset back', async () => {
  generateCover.mockRejectedValueOnce(new Error('image service unavailable'));
  const result = await runBookPipeline(input);
  expect(result.coverPdfUrl).toBeTruthy();
  expect(generateCover).toHaveBeenCalledTimes(2);
  expect(generateCover.mock.calls[1][4]).toMatchObject({ reuseApprovedArtworkOnly: true, preGeneratedCoverBuffer: Buffer.from('approved-front') });
  expect(illustrateStory).toHaveBeenCalledTimes(1);
});

test('a cover upload retry reuses the built PDF and never re-renders the cover', async () => {
  let failed = false;
  uploadBuffer.mockImplementation(async (_, key) => {
    if (key.endsWith('/cover.pdf') && !failed) { failed = true; throw new Error('temporary storage failure'); }
  });
  expect((await runBookPipeline(input)).coverPdfUrl).toBeTruthy();
  expect(generateCover).toHaveBeenCalledTimes(1);
});

test.each(['missing', 'invalid', 'front-only'])('does not complete with a %s cover PDF and preserves the interior', async kind => {
  generateCover.mockResolvedValue({ coverPdfBuffer: kind === 'missing' ? null : kind === 'invalid' ? Buffer.from('not a PDF') : await pdf(1) });
  await expect(runBookPipeline(input)).rejects.toMatchObject({ failureCode: 'cover_pdf_failed', interiorPdfUrl: expect.stringContaining('/interior.pdf'), pageCount: 36, previewImageUrls: ['https://storage.example/art.png'] });
  expect(input.saveCheckpoint).toHaveBeenLastCalledWith(expect.objectContaining({ completedStage: 'illustration', renderKeys: expect.any(Array) }));
});

test('a PDF-stage retry requests the exact saved artwork', async () => {
  await runBookPipeline({ ...input, checkpoint: { completedStage: 'illustration', textLayout: 'caption', story: input.storyPair, backCoverSynopsis: 'Previously saved summary.' } });
  expect(illustrateStory).toHaveBeenCalledWith(expect.objectContaining({ reviewedOnly: true }));
  expect(generateCover.mock.calls[0][4].synopsis).toBe('Previously saved summary.');
  expect(generateCover.mock.calls[0][4].reuseApprovedArtworkOnly).toBe(true);
  expect(input.saveCheckpoint.mock.calls.every(([cp]) => cp.completedStage === 'illustration')).toBe(true);
  expect(generateUpsellCovers).not.toHaveBeenCalled();
});

test('PDF retries reuse optional next-story art without buying new images', async () => {
  const upsell = { index: 2, title: 'Next Adventure', artStyle: 'pixar_premium', styleLabel: '3D Storybook', gcsPath: 'children-jobs/pdf-book/upsell/2/cover.png' };
  const result = await runBookPipeline({ ...input, checkpoint: { completedStage: 'illustration', textLayout: 'caption', story: input.storyPair, upsellCovers: [upsell] } });
  expect(generateUpsellCovers).not.toHaveBeenCalled();
  expect(downloadBuffer).toHaveBeenCalledWith(upsell.gcsPath);
  expect(assemblePdf.mock.calls[0][2].upsellCovers).toEqual([expect.objectContaining(upsell)]);
  expect(result.upsellCovers).toEqual([upsell]);
});

test('an explicit reviewed rebuild never generates marketing images even without a checkpoint', async () => {
  await runBookPipeline({ ...input, reviewedOnly: true });
  expect(generateUpsellCovers).not.toHaveBeenCalled();
  expect(generateCover.mock.calls[0][4].reuseApprovedArtworkOnly).toBe(true);
});

test.each(['story', 'layout', 'force'])('a changed %s does not accidentally reuse a completed illustration checkpoint', async change => {
  const cp = { completedStage: 'illustration', textLayout: 'caption', story: structuredClone(input.storyPair), backCoverSynopsis: 'Old summary.' };
  if (change === 'story') cp.story.response.spreads[0].text = 'Different story.';
  if (change === 'layout') cp.textLayout = 'embedded';
  await runBookPipeline({ ...input, checkpoint: cp, forceRerender: change === 'force' });
  expect(illustrateStory).toHaveBeenCalledWith(expect.objectContaining({ reviewedOnly: false }));
  expect(generateCover.mock.calls[0][4].synopsis).not.toBe('Old summary.');
});
