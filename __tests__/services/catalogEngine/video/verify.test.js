/**
 * Clip verification (gv-1): worst-frame union of the structured verdicts,
 * the video judge's closed vocabulary mapped to blocking/advisory, the
 * unchecked case, and select.js scoring.
 */

jest.mock('../../../../services/gcsStorage', () => ({
  downloadBuffer: jest.fn(), uploadBuffer: jest.fn(), uploadBufferIfAbsent: jest.fn(), getSignedUrl: jest.fn(), deletePrefix: jest.fn(), saveJson: jest.fn(), loadJson: jest.fn(), objectExists: jest.fn(),
}));
jest.mock('../../../../services/illustrationGenerator', () => ({
  fetchWithTimeout: jest.fn(), getNextApiKey: jest.fn(() => 'k'), downloadPhotoAsBase64: jest.fn(), isModestBathWaterScene: jest.fn(() => false), compareTexts: jest.fn(() => ({ valid: true, issues: [] })),
}));
jest.mock('../../../../services/catalogEngine/illustrator/spreadQa', () => {
  const real = jest.requireActual('../../../../services/catalogEngine/illustrator/spreadQa');
  return { ...real, checkSpreadRenderV2: jest.fn() };
});
jest.mock('../../../../services/catalogEngine/video/ffmpeg', () => {
  const real = jest.requireActual('../../../../services/catalogEngine/video/ffmpeg');
  return { ...real, extractFrames: jest.fn() };
});

const os = require('os');
const { checkSpreadRenderV2 } = require('../../../../services/catalogEngine/illustrator/spreadQa');
const { extractFrames } = require('../../../../services/catalogEngine/video/ffmpeg');
const { fetchWithTimeout } = require('../../../../services/illustrationGenerator');
const { verifyClip, judgeClip, classifyClipDefects, sampleTimes } = require('../../../../services/catalogEngine/video/verify');

const frameVerdict = (defects, unavailable) => ({ pass: defects.length === 0, defects, blocking: [], advisory: [], qaUnavailable: unavailable });
const judgeReply = (json) => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] }) });
const CLEAN = { morphing: false, identity_drift: false, outfit_change: false, new_character: false, text_appears: false, speech: false, frozen: false, camera_matches: true };
const segment = { index: 1, seconds: 3, kind: 'spread' };
const brief = { cameraMotion: 'push-in' };

beforeEach(() => {
  extractFrames.mockReset().mockImplementation(async (input, times) => times.map(t => ({ t, buffer: Buffer.from(`f${t}`) })));
  checkSpreadRenderV2.mockReset();
  fetchWithTimeout.mockReset();
});

describe('sampleTimes / classifyClipDefects', () => {
  test('five samples across the USED seconds', () => {
    expect(sampleTimes(3)).toEqual([0, 0.738, 1.475, 2.213, 2.95]);
  });
  test('video-level defects block; spreadQa advisories stay advisory', () => {
    const r = classifyClipDefects(['frozen clip: no visible motion', 'anatomy defect: hands or fingers', 'identity break: x', 'composition break: y']);
    expect(r.blocking).toEqual(['identity break: x', 'frozen clip: no visible motion']);
    expect(r.advisory).toEqual(['anatomy defect: hands or fingers', 'composition break: y']);
  });
});

describe('judgeClip', () => {
  test('maps the closed vocabulary to defect strings', async () => {
    fetchWithTimeout.mockResolvedValueOnce(judgeReply({ ...CLEAN, morphing: true, speech: true, camera_matches: false }));
    const r = await judgeClip(Buffer.from('mp4'), { cameraMotion: 'pan-left' });
    expect(r.defects).toEqual([
      'motion break: the face or body morphs or deforms during the clip',
      'speech: the child appears to talk',
      'composition break: the camera move does not read as the assigned pan-left',
    ]);
    const body = JSON.parse(fetchWithTimeout.mock.calls[0][1].body);
    expect(body.contents[0].parts[1].inline_data.mimeType).toBe('video/mp4');
  });
  test('fails open with a reason', async () => {
    fetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 500 });
    expect((await judgeClip(Buffer.from('mp4'), {})).unavailable).toMatch(/HTTP 500/);
    fetchWithTimeout.mockResolvedValueOnce(judgeReply({ morphing: 'yes' }));
    expect((await judgeClip(Buffer.from('mp4'), {})).unavailable).toMatch(/malformed/);
  });
});

describe('verifyClip', () => {
  test('a clean clip passes with a full score', async () => {
    checkSpreadRenderV2.mockResolvedValue(frameVerdict([]));
    fetchWithTimeout.mockResolvedValue(judgeReply(CLEAN));
    const r = await verifyClip({ buffer: Buffer.from('mp4'), dir: os.tmpdir(), label: 't1', segment, brief, checks: { sheet: { base64: 's' } } });
    expect(r.pass).toBe(true);
    expect(r.score).toBe(100);
    expect(r.frames).toHaveLength(5);
    expect(checkSpreadRenderV2).toHaveBeenCalledTimes(5);
    expect(checkSpreadRenderV2.mock.calls[0][1]).toMatchObject({ expectedText: null, shotType: null, sheet: { base64: 's' } });
  });
  test('a defect on the LAST frame alone sinks the clip (worst frame governs)', async () => {
    checkSpreadRenderV2
      .mockResolvedValueOnce(frameVerdict([])).mockResolvedValueOnce(frameVerdict([])).mockResolvedValueOnce(frameVerdict([])).mockResolvedValueOnce(frameVerdict([]))
      .mockResolvedValueOnce(frameVerdict(['identity break: the child does not match the character model sheet']));
    fetchWithTimeout.mockResolvedValue(judgeReply(CLEAN));
    const r = await verifyClip({ buffer: Buffer.from('mp4'), dir: os.tmpdir(), label: 't2', segment, brief, checks: {} });
    expect(r.pass).toBe(false);
    expect(r.blocking).toEqual(['identity break: the child does not match the character model sheet']);
    expect(r.score).toBeLessThan(0);
  });
  test('the judge\'s temporal defects join the frame verdicts', async () => {
    checkSpreadRenderV2.mockResolvedValue(frameVerdict(['anatomy defect: hands or fingers']));
    fetchWithTimeout.mockResolvedValue(judgeReply({ ...CLEAN, frozen: true }));
    const r = await verifyClip({ buffer: Buffer.from('mp4'), dir: os.tmpdir(), label: 't3', segment, brief, checks: {} });
    expect(r.blocking).toEqual(['frozen clip: no visible motion']);
    expect(r.advisory).toEqual(['anatomy defect: hands or fingers']);
  });
  test('no verdict at all → unchecked (ranks below any checked clip)', async () => {
    checkSpreadRenderV2.mockResolvedValue(frameVerdict([], 'vision QA HTTP 503'));
    fetchWithTimeout.mockResolvedValue({ ok: false, status: 503 });
    const r = await verifyClip({ buffer: Buffer.from('mp4'), dir: os.tmpdir(), label: 't4', segment, brief, checks: {} });
    expect(r.qaUnavailable).toMatch(/no verdict/);
    expect(r.score).toBe(40);
  });
  test('frame extraction failure is unchecked, not a crash', async () => {
    extractFrames.mockRejectedValueOnce(new Error('ffmpeg missing'));
    const r = await verifyClip({ buffer: Buffer.from('mp4'), dir: os.tmpdir(), label: 't5', segment, brief, checks: {} });
    expect(r.qaUnavailable).toMatch(/frame extraction failed/);
  });
  test('the cover segment is not checked for the beat or the emotion', async () => {
    checkSpreadRenderV2.mockResolvedValue(frameVerdict([]));
    fetchWithTimeout.mockResolvedValue(judgeReply(CLEAN));
    await verifyClip({ buffer: Buffer.from('mp4'), dir: os.tmpdir(), label: 't6', segment: { index: 0, seconds: 2.4, kind: 'cover' }, brief, checks: { beat: 'x', emotion: { emotion: 'joy', intensity: 'big' } } });
    expect(checkSpreadRenderV2.mock.calls[0][1]).toMatchObject({ beat: null, emotion: null });
  });
});
