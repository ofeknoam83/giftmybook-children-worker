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
const { verifyClip, judgeClip, classifyClipDefects, sampleTimes, actAt } = require('../../../../services/catalogEngine/video/verify');

const frameVerdict = (defects, unavailable) => ({ pass: defects.length === 0, defects, blocking: [], advisory: [], qaUnavailable: unavailable });
const judgeReply = (json) => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] }) });
const CLEAN = { morphing: false, identity_drift: false, outfit_change: false, new_character: false, text_appears: false, speech: false, frozen: false, cuts: false, scene_progression: true, camera_matches: true };
const segment = { index: 1, seconds: 3, kind: 'spread' };
const brief = { cameraMotion: 'push-in' };
const journey = { index: 0, seconds: 10, kind: 'journey' };
const journeyBrief = { cameraMotion: 'journey', angles: ['wide', 'close', 'overhead'] };

beforeEach(() => {
  extractFrames.mockReset().mockImplementation(async (input, times) => times.map(t => ({ t, buffer: Buffer.from(`f${t}`) })));
  checkSpreadRenderV2.mockReset();
  fetchWithTimeout.mockReset();
});

describe('sampleTimes / classifyClipDefects', () => {
  test('five samples across the USED seconds', () => {
    expect(sampleTimes(3)).toEqual([0, 0.738, 1.475, 2.213, 2.95]);
  });
  test('video-level defects block; spreadQa advisories stay advisory; a cut blocks, a static journey does not', () => {
    const r = classifyClipDefects(['frozen clip: no visible motion', 'anatomy defect: hands or fingers', 'identity break: x', 'composition break: y', 'cut break: z', 'journey break: w']);
    expect(r.blocking).toEqual(['identity break: x', 'frozen clip: no visible motion', 'cut break: z']);
    expect(r.advisory).toEqual(['anatomy defect: hands or fingers', 'composition break: y', 'journey break: w']);
  });
  test('actAt picks the act a timestamp falls in; the last act owns the tail', () => {
    const acts = [{ index: 0, from: 0, to: 3.3 }, { index: 1, from: 3.3, to: 6.7 }, { index: 2, from: 6.7, to: 10 }];
    expect(actAt(acts, 0).index).toBe(0);
    expect(actAt(acts, 3.3).index).toBe(1);
    expect(actAt(acts, 9.95).index).toBe(2);
    expect(actAt(acts, 10).index).toBe(2);
    expect(actAt(null, 1)).toBeNull();
    expect(actAt([], 1)).toBeNull();
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
  test('the single take is judged for cuts, progression and a changing camera angle', async () => {
    fetchWithTimeout.mockResolvedValueOnce(judgeReply({ ...CLEAN, cuts: true, scene_progression: false, camera_matches: false }));
    const r = await judgeClip(Buffer.from('mp4'), { cameraMotion: 'journey', angles: ['wide', 'close', 'overhead'] });
    expect(r.defects).toEqual([
      'cut break: the clip contains a cut or transition instead of one continuous shot',
      'journey break: the surroundings never change — the child does not advance into the next moment',
      'composition break: the camera angle does not change along the take',
    ]);
    const prompt = JSON.parse(fetchWithTimeout.mock.calls[0][1].body).contents[0].parts[0].text;
    expect(prompt).toContain('wide → close → overhead');
    expect(prompt).toContain('"cuts"');
    // the take-level fields are soft: a verdict without them is still strict on the rest
    fetchWithTimeout.mockResolvedValueOnce(judgeReply({ morphing: false, identity_drift: false, outfit_change: false, new_character: false, text_appears: false, speech: false, frozen: false, camera_matches: true }));
    const soft = await judgeClip(Buffer.from('mp4'), { cameraMotion: 'journey' });
    expect(soft.defects).toEqual([]);
    expect(soft.verdict).toMatchObject({ cuts: false, scene_progression: null });
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
  test('the single take checks each sampled frame against the act its timestamp falls in', async () => {
    checkSpreadRenderV2.mockResolvedValue(frameVerdict([]));
    fetchWithTimeout.mockResolvedValue(judgeReply(CLEAN));
    const companion = { name: 'Buttons', type: 'goat' };
    const acts = [
      { index: 0, from: 0, to: 3.3, beat: 'Beat one.', emotion: { emotion: 'joy', intensity: 'big' }, companion: null, outfitSpec: 'a blue sweater' },
      { index: 1, from: 3.3, to: 6.7, beat: 'Beat two.', emotion: { emotion: 'wonder', intensity: 'clear' }, companion, outfitSpec: null },
      { index: 2, from: 6.7, to: 10, beat: 'Beat three.', emotion: null, companion, outfitSpec: 'a blue sweater' },
    ];
    const r = await verifyClip({ buffer: Buffer.from('mp4'), dir: os.tmpdir(), label: 't7', segment: journey, brief: journeyBrief, checks: { sheet: { base64: 's' }, outfitSpec: 'a blue sweater', acts } });
    expect(r.pass).toBe(true);
    expect(r.frames.map(f => f.act)).toEqual([0, 0, 1, 2, 2]);
    const calls = checkSpreadRenderV2.mock.calls.map(c => c[1]);
    expect(calls[0]).toMatchObject({ beat: 'Beat one.', emotion: { emotion: 'joy', intensity: 'big' }, companion: null, outfitSpec: 'a blue sweater' });
    expect(calls[2]).toMatchObject({ beat: 'Beat two.', companion, outfitSpec: null });
    expect(calls[4]).toMatchObject({ beat: 'Beat three.', emotion: null, companion });
    const judgePrompt = JSON.parse(fetchWithTimeout.mock.calls[0][1].body).contents[0].parts[0].text;
    expect(judgePrompt).toContain('wide → close → overhead');
  });
  test('the cover segment is not checked for the beat or the emotion', async () => {
    checkSpreadRenderV2.mockResolvedValue(frameVerdict([]));
    fetchWithTimeout.mockResolvedValue(judgeReply(CLEAN));
    await verifyClip({ buffer: Buffer.from('mp4'), dir: os.tmpdir(), label: 't6', segment: { index: 0, seconds: 2.4, kind: 'cover' }, brief, checks: { beat: 'x', emotion: { emotion: 'joy', intensity: 'big' } } });
    expect(checkSpreadRenderV2.mock.calls[0][1]).toMatchObject({ beat: null, emotion: null });
  });
});
