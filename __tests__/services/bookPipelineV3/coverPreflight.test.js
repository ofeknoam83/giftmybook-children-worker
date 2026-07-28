/**
 * Cover pre-flight (2026-07-28): the approved cover anchors the sheet, every
 * spread render, the plates AND the spread judge's style yardstick — but was
 * never medium-verified, and harmonization ran only at cover-PDF time
 * (after the interiors). resolveCoverAnchor verifies (and if needed
 * harmonizes + re-uploads) the anchor BEFORE anything consumes it.
 */

jest.mock('../../../services/bookPipelineV3/llm/visionClient', () => ({
  callVisionRole: jest.fn(),
}));
jest.mock('../../../services/illustrationGenerator', () => ({
  downloadPhotoAsBase64: jest.fn(),
}));
jest.mock('../../../services/gcsStorage', () => ({
  uploadBuffer: jest.fn(async (buf, path) => `https://signed.test/${path}?sig=1`),
}));
jest.mock('../../../services/coverGenerator', () => ({
  // Mirrors the real KNOWN_3D_SOURCE_MARKER predicate (loading the real
  // module pulls sharp + the whole cover stack into a unit test).
  shouldSkipCoverStyleHarmonize: (u) => /(pixar[_-]?premium|cinematic[_-]?3d|3d[_-]?harmonized|style-?3d)/i.test(String(u)),
  harmonizeChosenCoverToInteriorStyle: jest.fn(),
}));

const { callVisionRole } = require('../../../services/bookPipelineV3/llm/visionClient');
const { downloadPhotoAsBase64 } = require('../../../services/illustrationGenerator');
const { uploadBuffer } = require('../../../services/gcsStorage');
const { harmonizeChosenCoverToInteriorStyle } = require('../../../services/coverGenerator');
const { resolveCoverAnchor } = require('../../../services/bookPipelineV3/illustrator/coverPreflight');

const URL_2D = 'https://cdn.example/covers/watercolor-a.png';

beforeEach(() => {
  jest.clearAllMocks();
  downloadPhotoAsBase64.mockResolvedValue({ base64: Buffer.from('cover').toString('base64'), mimeType: 'image/png' });
});

test('no cover → null anchor, no calls', async () => {
  const r = await resolveCoverAnchor({ bookId: 'b1', coverImageUrl: null, log: () => {} });
  expect(r).toEqual({ url: null, harmonized: false, advisory: null });
  expect(callVisionRole).not.toHaveBeenCalled();
});

test('a known-3D URL marker skips the vision spend entirely', async () => {
  const url = 'https://cdn.example/covers/3d-harmonized/a.png';
  const r = await resolveCoverAnchor({ bookId: 'b1', coverImageUrl: url, log: () => {} });
  expect(r.url).toBe(url);
  expect(callVisionRole).not.toHaveBeenCalled();
  expect(downloadPhotoAsBase64).not.toHaveBeenCalled();
});

test('a medium-OK cover anchors as-is', async () => {
  callVisionRole.mockResolvedValue({ json: { medium_ok: true }, model: 'm' });
  const r = await resolveCoverAnchor({ bookId: 'b1', coverImageUrl: URL_2D, log: () => {} });
  expect(r).toEqual({ url: URL_2D, harmonized: false, advisory: null });
  expect(harmonizeChosenCoverToInteriorStyle).not.toHaveBeenCalled();
});

test('a 2D cover is harmonized, re-checked, uploaded under the 3d-harmonized marker, and becomes the anchor', async () => {
  callVisionRole
    .mockResolvedValueOnce({ json: { medium_ok: false, reason: 'soft watercolor look' }, model: 'm' })
    .mockResolvedValueOnce({ json: { medium_ok: true }, model: 'm' });
  harmonizeChosenCoverToInteriorStyle.mockResolvedValue(Buffer.from('harmonized-3d'));
  const r = await resolveCoverAnchor({ bookId: 'b1', coverImageUrl: URL_2D, log: () => {} });
  expect(r.harmonized).toBe(true);
  expect(r.url).toContain('children-jobs/b1/cover-3d-harmonized.png');
  expect(r.advisory).toContain('soft watercolor look');
  expect(uploadBuffer).toHaveBeenCalledTimes(1);
});

// Copilot review on #252: harmonize returns raw Gemini bytes with no
// guaranteed format — the upload's extension/content-type must follow the
// ACTUAL bytes, not assume PNG.
test('a JPEG harmonized buffer uploads as .jpg with image/jpeg content type', async () => {
  callVisionRole
    .mockResolvedValueOnce({ json: { medium_ok: false, reason: 'flat 2D look' }, model: 'm' })
    .mockResolvedValueOnce({ json: { medium_ok: true }, model: 'm' });
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('jpeg-body')]);
  harmonizeChosenCoverToInteriorStyle.mockResolvedValue(jpeg);
  const r = await resolveCoverAnchor({ bookId: 'b1', coverImageUrl: URL_2D, log: () => {} });
  expect(r.harmonized).toBe(true);
  expect(r.url).toContain('cover-3d-harmonized.jpg'); // marker survives either extension
  expect(uploadBuffer).toHaveBeenCalledWith(jpeg, 'children-jobs/b1/cover-3d-harmonized.jpg', 'image/jpeg');
});

test('harmonize NO-OP (returns the original buffer) → keep the original URL, skip the re-check, loud advisory', async () => {
  const original = Buffer.from('cover');
  callVisionRole.mockResolvedValueOnce({ json: { medium_ok: false, reason: 'flat 2D look' }, model: 'm' });
  harmonizeChosenCoverToInteriorStyle.mockImplementation(async (buf) => buf);
  downloadPhotoAsBase64.mockResolvedValue({ base64: original.toString('base64'), mimeType: 'image/png' });
  const r = await resolveCoverAnchor({ bookId: 'b1', coverImageUrl: URL_2D, log: () => {} });
  expect(r.url).toBe(URL_2D);
  expect(r.harmonized).toBe(false);
  expect(r.advisory).toContain('NO-OP');
  // Re-checking the SAME pixels could contradict verdict #1 and mint a false
  // known-3D marker — the no-op path never makes a second vision call.
  expect(callVisionRole).toHaveBeenCalledTimes(1);
  expect(uploadBuffer).not.toHaveBeenCalled();
});

test('a changed buffer that still fails the re-check → keep the original URL with a loud advisory', async () => {
  callVisionRole
    .mockResolvedValueOnce({ json: { medium_ok: false, reason: 'flat 2D look' }, model: 'm' })
    .mockResolvedValueOnce({ json: { medium_ok: false, reason: 'still flat' }, model: 'm' });
  harmonizeChosenCoverToInteriorStyle.mockResolvedValue(Buffer.from('different-but-still-flat'));
  const r = await resolveCoverAnchor({ bookId: 'b1', coverImageUrl: URL_2D, log: () => {} });
  expect(r.url).toBe(URL_2D);
  expect(r.harmonized).toBe(false);
  expect(r.advisory).toContain('did not fix it');
  expect(uploadBuffer).not.toHaveBeenCalled();
});

// Copilot review on #252: infra failures used to return advisory:null — the
// book anchored on an unverified cover with only a Cloud Logging trace.
test('any infrastructure failure keeps the original anchor with an UNVERIFIED advisory (never blocks)', async () => {
  downloadPhotoAsBase64.mockRejectedValue(new Error('403'));
  const r = await resolveCoverAnchor({ bookId: 'b1', coverImageUrl: URL_2D, log: () => {} });
  expect(r.url).toBe(URL_2D);
  expect(r.harmonized).toBe(false);
  expect(r.advisory).toContain('UNVERIFIED');
});
