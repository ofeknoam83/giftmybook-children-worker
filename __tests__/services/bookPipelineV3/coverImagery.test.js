/**
 * coverImagery (P4, audit 2026-07-15) — the writer chain honors what the
 * parent-approved cover depicts. The audited book's cover promised a
 * compass-and-treasure-map quest; the story was a backyard game that
 * never mentioned either. This activity describes the cover's props/
 * setting/mood for the brief + concept room. It must NEVER fail a book —
 * any error degrades to null (the pre-P4 cover-blind behavior).
 */
jest.mock('../../../services/bookPipelineV3/llm/visionClient', () => ({
  callVisionRole: jest.fn(),
}));
jest.mock('../../../services/illustrationGenerator', () => ({
  downloadPhotoAsBase64: jest.fn(),
}));

const { callVisionRole } = require('../../../services/bookPipelineV3/llm/visionClient');
const { downloadPhotoAsBase64 } = require('../../../services/illustrationGenerator');
const { coverImageryActivity } = require('../../../services/bookPipelineV3/orchestration/activities/coverImagery');

const ctx = { log: jest.fn() };

beforeEach(() => {
  callVisionRole.mockReset();
  downloadPhotoAsBase64.mockReset();
  ctx.log.mockClear();
});

test('describes the cover into normalized {props, setting, mood}', async () => {
  downloadPhotoAsBase64.mockResolvedValue({ base64: 'AAAA', mimeType: 'image/jpeg' });
  callVisionRole.mockResolvedValue({
    json: {
      props: ['compass', 'treasure map', 'glowing star', 'x', 'y', 'z', 'over-limit'],
      setting: 'a magical twilight forest with glowing plants',
      mood: 'wondrous quest at dusk',
    },
  });
  const out = await coverImageryActivity({ coverImageUrl: 'https://cdn.example/cover.png' }, ctx);
  expect(out.props).toHaveLength(6); // capped
  expect(out.props).toContain('compass');
  expect(out.setting).toContain('twilight forest');
  expect(out.mood).toBe('wondrous quest at dusk');
  expect(callVisionRole).toHaveBeenCalledWith('QA_VISION', expect.objectContaining({
    expectJson: true,
    images: [{ base64: 'AAAA', mimeType: 'image/jpeg' }],
  }));
});

test('no cover URL → null, no calls', async () => {
  expect(await coverImageryActivity({ coverImageUrl: null }, ctx)).toBeNull();
  expect(downloadPhotoAsBase64).not.toHaveBeenCalled();
});

test('download failure degrades to null (never fails the book)', async () => {
  downloadPhotoAsBase64.mockRejectedValue(new Error('404'));
  expect(await coverImageryActivity({ coverImageUrl: 'https://cdn.example/gone.png' }, ctx)).toBeNull();
});

test('vision failure degrades to null (never fails the book)', async () => {
  downloadPhotoAsBase64.mockResolvedValue({ base64: 'AAAA' });
  callVisionRole.mockRejectedValue(new Error('vision blew up'));
  expect(await coverImageryActivity({ coverImageUrl: 'https://cdn.example/cover.png' }, ctx)).toBeNull();
});
