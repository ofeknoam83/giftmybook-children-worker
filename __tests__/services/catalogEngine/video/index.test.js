/**
 * The gift video orchestrator (gv-1) end to end with every external
 * boundary mocked: the vendor adapter, the verifier, ffmpeg, GCS, the
 * bible builder, and the text gate's vision call. Covers the happy path
 * (cover + three moments → one 10 s film, every candidate billed), the
 * film-level replay, embedded start frames re-rendered text-free, the text
 * gate blocking a spread, an unresolved segment failing closed with its
 * scored candidates, and a vendor that refuses every candidate.
 */

process.env.CATALOG_VIDEO_CLIP_CANDIDATES = '2';
process.env.CATALOG_VIDEO_CLIP_MAX_REPAIRS = '1';
process.env.REPLICATE_API_TOKEN = 'tok';

const fs = require('fs');

jest.mock('../../../../services/illustrationGenerator', () => ({
  downloadPhotoAsBase64: jest.fn(),
  isModestBathWaterScene: jest.fn(() => false),
  fetchWithTimeout: jest.fn(),
  getNextApiKey: jest.fn(() => 'k'),
  compareTexts: jest.fn(() => ({ valid: true, issues: [] })),
}));
jest.mock('../../../../services/gcsStorage', () => ({
  downloadBuffer: jest.fn(),
  uploadBuffer: jest.fn(async (buf, key) => `https://signed/${key}`),
  uploadBufferIfAbsent: jest.fn(async () => ({ created: true })),
  getSignedUrl: jest.fn(async (key) => `https://signed/${key}`),
  objectExists: jest.fn(async () => false),
  loadJson: jest.fn(async () => { throw new Error('no manifest'); }),
  saveJson: jest.fn(async () => undefined),
  deletePrefix: jest.fn(),
}));
jest.mock('../../../../services/catalogEngine/illustrator', () => ({
  renderStorySpreads: jest.fn(),
  storyFingerprint: () => 'fp',
}));
jest.mock('../../../../services/catalogEngine/illustrator/bible', () => ({
  buildBookBible: jest.fn(),
  summarizeBible: jest.fn(async () => ({ bibleHash: 'bh', characterSheet: { hash: 'sh' } })),
  anchorHash: () => 'ah',
}));
jest.mock('../../../../services/catalogEngine/video/providers/replicate', () => ({
  name: 'replicate', submit: jest.fn(), poll: jest.fn(), download: jest.fn(),
}));
jest.mock('../../../../services/catalogEngine/video/verify', () => ({ verifyClip: jest.fn() }));
jest.mock('../../../../services/catalogEngine/video/ffmpeg', () => {
  const real = jest.requireActual('../../../../services/catalogEngine/video/ffmpeg');
  const fsx = require('fs');
  return {
    ...real,
    runFfmpeg: jest.fn(async (args) => { fsx.writeFileSync(args[args.length - 1], Buffer.from('fake-output')); return { stdout: '', stderr: '' }; }),
    probeVideo: jest.fn(async () => ({ durationSeconds: 10, width: 1920, height: 1080, fps: 30 })),
  };
});

const sharp = require('sharp');
const { downloadPhotoAsBase64, fetchWithTimeout } = require('../../../../services/illustrationGenerator');
const { downloadBuffer, uploadBuffer, loadJson, objectExists, saveJson } = require('../../../../services/gcsStorage');
const { renderStorySpreads } = require('../../../../services/catalogEngine/illustrator');
const { buildBookBible } = require('../../../../services/catalogEngine/illustrator/bible');
const replicate = require('../../../../services/catalogEngine/video/providers/replicate');
const { verifyClip } = require('../../../../services/catalogEngine/video/verify');
const { runFfmpeg } = require('../../../../services/catalogEngine/video/ffmpeg');
const { generateGiftVideo } = require('../../../../services/catalogEngine/video');
const { getBook } = require('../../../../services/catalogEngine/catalog');
const { CostTracker } = require('../../../../services/costTracker');
const { VIDEO_VERSION } = require('../../../../services/catalogEngine/versions');

const BOOK_ID = 'farm_2_3_hello_farm';
const bookDef = getBook(BOOK_ID);
const story = {
  book_id: BOOK_ID,
  spreads: Array.from({ length: 12 }, (_, i) => ({ spread: i + 1, text: `Spread ${i + 1} text.` })),
  personalization_evidence: [],
  versions: { catalog: '1.3' },
};
const profile = { name: 'Emma', age: 2, pronouns: { subject: 'she', object: 'her', possessive_adjective: 'her' } };
const key = (n, aspect = 'wide-plain') => `children-jobs/b1/ce-renders/ce-9/fp-b1/spread-${n}.${aspect}.png`;
const renders = (aspect) => Array.from({ length: 12 }, (_, i) => ({ spread: i + 1, storageKey: key(i + 1, aspect) }));

let PNG;
let PNG_B64;
const cleanVerdict = () => ({ pass: true, defects: [], blocking: [], advisory: [], frames: [], judge: { defects: [] }, score: 100 });
const blockingVerdict = (d) => ({ pass: false, defects: [d], blocking: [d], advisory: [], frames: [], judge: { defects: [] }, score: -20 });

const params = (over = {}) => ({
  bookId: 'b1', story, bookDef, profile, renders: renders(), approvedCoverUrl: 'https://cover.example/c.png?sig=1',
  childPhotoUrl: null, characterDescription: null, textLayout: 'half', tuning: null,
  costTracker: new CostTracker(), log: () => {}, pollIntervalMs: 1, ...over,
});

beforeAll(async () => {
  PNG = await sharp({ create: { width: 192, height: 108, channels: 3, background: '#4466aa' } }).png().toBuffer();
  PNG_B64 = PNG.toString('base64');
});

beforeEach(() => {
  jest.clearAllMocks();
  downloadPhotoAsBase64.mockResolvedValue({ base64: PNG_B64, mimeType: 'image/png' });
  fetchWithTimeout.mockRejectedValue(new Error('offline')); // text gate unavailable → passes with an advisory
  downloadBuffer.mockImplementation(async (k) => {
    if (k.endsWith('.qa.json') || k.endsWith('.mp4') || k.endsWith('video.json')) throw new Error('miss');
    return PNG; // render keys + the cover URL
  });
  loadJson.mockRejectedValue(new Error('no manifest'));
  objectExists.mockResolvedValue(false);
  buildBookBible.mockResolvedValue({
    manifest: {}, hash: 'bh',
    sheet: { base64: PNG_B64, mimeType: 'image/png', hash: 'sh', storageKey: 'sheet.png' },
    outfit: { outfit: 'a blue sweater', hash: 'oh' }, props: [], companion: null, worldPlate: null,
    emotion: { plan: { 7: { emotion: 'joy', intensity: 'big' } }, hash: 'eh' }, advisories: [],
  });
  let n = 0;
  replicate.submit.mockImplementation(async () => ({ jobId: `j${++n}`, pollUrl: `https://poll/j${n}` }));
  replicate.poll.mockResolvedValue({ status: 'done', videoUrl: 'https://v/x.mp4' });
  replicate.download.mockResolvedValue(Buffer.from('mp4-bytes'));
  verifyClip.mockResolvedValue(cleanVerdict());
  renderStorySpreads.mockResolvedValue({ results: [], unresolved: [], bookBible: null });
});

describe('generateGiftVideo', () => {
  test('cover + three moments → one 10 s film, every candidate billed, manifest written', async () => {
    const p = params();
    const r = await generateGiftVideo(p);
    expect(r.video).toMatchObject({ durationSeconds: 10, width: 1920, height: 1080, fps: 30, cached: false, version: VIDEO_VERSION, music: 'none' });
    expect(r.video.storageKey).toMatch(new RegExp(`^children-jobs/b1/gift-video/${VIDEO_VERSION}/[a-z0-9]+/video\\.mp4$`));
    expect(r.plan.map(s => [s.kind, s.spread])).toEqual([['cover', null], ['spread', 1], ['spread', 7], ['spread', 12]]);
    expect(r.plan.every(s => s.clip && s.clip.candidates === 2 && s.clip.repairs === 0)).toBe(true);
    expect(r.unresolved).toEqual([]);
    expect(r.textGate).toHaveLength(4);
    expect(r.textGate.every(t => t.pass && t.unavailable)).toBe(true);
    expect(replicate.submit).toHaveBeenCalledTimes(8);
    // the start frame + the identity kit ride every submission
    const input = replicate.submit.mock.calls[0][0].input;
    expect(input.start_image).toMatch(/^https:\/\/signed\//);
    expect(input.elements[0].images).toHaveLength(2);
    expect(input.generate_audio).toBe(false);
    expect(p.costTracker.getSummary().breakdown['kwaivgi/kling-v3-video'].videoSeconds).toBe(32);
    expect(runFfmpeg).toHaveBeenCalledTimes(2); // stitch + poster
    const stitchArgs = runFfmpeg.mock.calls[0][0];
    expect(stitchArgs[stitchArgs.length - 2]).toBe('10.000');
    expect(saveJson).toHaveBeenCalledWith(expect.objectContaining({ videoVersion: VIDEO_VERSION, provider: 'replicate' }), expect.stringMatching(/video\.json$/));
    // promoted clips + markers
    expect(uploadBuffer.mock.calls.filter(c => /clips\/s\d+-[a-z0-9]+\.mp4$/.test(c[1]))).toHaveLength(4);
    expect(uploadBuffer.mock.calls.filter(c => /clips\/s\d+-[a-z0-9]+\.mp4\.qa\.json$/.test(c[1]))).toHaveLength(4);
    expect(r.provider).toBe('replicate');
  });

  test('a film whose manifest and mp4 exist replays without a vendor call', async () => {
    loadJson.mockResolvedValue({ video: { storageKey: 'k', hash: 'h', durationSeconds: 10 }, plan: [{ index: 0 }], textGate: [], advisories: [] });
    objectExists.mockResolvedValue(true);
    const r = await generateGiftVideo(params());
    expect(r.video.cached).toBe(true);
    expect(r.video.url).toMatch(/^https:\/\/signed\//);
    expect(replicate.submit).not.toHaveBeenCalled();
    expect(runFfmpeg).not.toHaveBeenCalled();
  });

  test('forceNew skips the replay', async () => {
    loadJson.mockResolvedValue({ video: { storageKey: 'k' }, plan: [] });
    objectExists.mockResolvedValue(true);
    const r = await generateGiftVideo(params({ forceNew: true }));
    expect(r.video.cached).toBe(false);
    expect(replicate.submit).toHaveBeenCalled();
  });

  test('embedded renders are re-rendered text-free through the half layout before animating', async () => {
    renderStorySpreads.mockImplementation(async ({ spreads }) => ({
      results: spreads.map(s => ({ spread: s, buffer: PNG, storageKey: key(s), url: 'u', advisories: [] })),
      unresolved: [], bookBible: null,
    }));
    const r = await generateGiftVideo(params({ renders: renders('wide'), textLayout: 'embedded', identityKeyed: true, probeNonce: 'n1', seed: 7 }));
    expect(renderStorySpreads).toHaveBeenCalledTimes(1);
    expect(renderStorySpreads.mock.calls[0][0]).toMatchObject({ textLayout: 'half', spreads: [1, 7, 12], identityKeyed: true, probeNonce: 'n1', seed: 7 });
    expect(r.plan.filter(s => s.kind === 'spread').every(s => s.startFrame.rerendered)).toBe(true);
  });

  test('painted text on a spread fails the film video_text_visible', async () => {
    const gate = (present, transcript) => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ text_present: present, transcript }) }] } }] }) });
    fetchWithTimeout.mockImplementation(async () => gate(true, 'Hello farm!'));
    await expect(generateGiftVideo(params())).rejects.toMatchObject({ failureCode: 'video_text_visible' });
    expect(replicate.submit).not.toHaveBeenCalled();
  });

  test('painted text on the cover alone drops the opener with an advisory and the film still ships', async () => {
    const PNG2 = await sharp({ create: { width: 192, height: 108, channels: 3, background: '#aa2244' } }).png().toBuffer();
    downloadBuffer.mockImplementation(async (k) => {
      if (k.endsWith('.qa.json') || k.endsWith('.mp4') || k.endsWith('video.json')) throw new Error('miss');
      return k.startsWith('https://cover') ? PNG2 : PNG;
    });
    const gate = (present, transcript) => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ text_present: present, transcript }) }] } }] }) });
    fetchWithTimeout.mockImplementation(async (url, opts) => {
      const img = JSON.parse(opts.body).contents[0].parts[1].inline_data.data;
      return gate(img === PNG2.toString('base64'), 'Hello farm!');
    });
    const r = await generateGiftVideo(params());
    expect(r.plan.map(s => s.kind)).toEqual(['spread', 'spread', 'spread']);
    expect(r.advisories.some(a => /cover_text_visible/.test(a.note))).toBe(true);
    expect(r.video.durationSeconds).toBe(10);
  });

  test('a segment that stays blocking after the repair budget fails closed with its scored candidates', async () => {
    verifyClip.mockImplementation(async ({ segment }) => (segment.spread === 7 ? blockingVerdict('identity break: the child does not match the character model sheet') : cleanVerdict()));
    let err;
    try { await generateGiftVideo(params()); } catch (e) { err = e; }
    expect(err.failureCode).toBe('video_unresolved');
    expect(err.details.unresolved).toHaveLength(1);
    const u = err.details.unresolved[0];
    expect(u.spread).toBe(7);
    expect(u.defects).toEqual(['identity break: the child does not match the character model sheet']);
    expect(u.candidates).toHaveLength(4); // 2 base + 2 repair candidates, each with its own key
    expect(u.candidates.map(c => c.storageKey)).toEqual(expect.arrayContaining([expect.stringMatching(/\.c1\.mp4$/), expect.stringMatching(/\.r1c2\.mp4$/)]));
    // every pass shares the base clip identity: the repair candidates sit
    // beside the SAME canonical key, so a pick-clip of one replays later
    const bases = new Set(u.candidates.map(c => c.storageKey.replace(/\.(?:r\d+)?c\d\.mp4$/, '.mp4')));
    expect(bases.size).toBe(1);
    expect([...bases][0]).toBe(err.details.plan.find(s => s.spread === 7).clip.storageKey);
    expect(u.candidates.every(c => c.url && typeof c.score === 'number')).toBe(true);
    expect(err.details.plan.find(s => s.spread === 7).clip.repairs).toBe(1);
    expect(runFfmpeg).not.toHaveBeenCalled();
    // the promoted marker records the unresolved state
    const marker = uploadBuffer.mock.calls.find(c => /s2-[a-z0-9]+\.mp4\.qa\.json$/.test(c[1]));
    expect(JSON.parse(marker[0].toString())).toMatchObject({ unresolved: true });
  });

  test('CATALOG_VIDEO_SHIP_ON_EXHAUSTION=1 stitches the residual with a shipPolicy advisory', async () => {
    process.env.CATALOG_VIDEO_SHIP_ON_EXHAUSTION = '1';
    try {
      verifyClip.mockImplementation(async ({ segment }) => (segment.spread === 12 ? blockingVerdict('frozen clip: no visible motion') : cleanVerdict()));
      const r = await generateGiftVideo(params());
      expect(r.unresolved).toHaveLength(1);
      expect(r.advisories.some(a => a.stage === 'shipPolicy')).toBe(true);
      expect(r.video.durationSeconds).toBe(10);
    } finally {
      delete process.env.CATALOG_VIDEO_SHIP_ON_EXHAUSTION;
    }
  });

  test('a vendor that refuses every candidate of a segment is unresolved, not an outage', async () => {
    replicate.poll.mockImplementation(async ({ jobId }) => (Number(jobId.slice(1)) <= 2 ? { status: 'filtered', error: 'content moderation', reasons: ['moderation'] } : { status: 'done', videoUrl: 'u' }));
    let err;
    try { await generateGiftVideo(params()); } catch (e) { err = e; }
    expect(err.failureCode).toBe('video_unresolved');
    expect(err.details.unresolved[0].defects[0]).toMatch(/moderation refused every candidate/);
  });

  test('no clip at all from the vendor is video_provider_unavailable', async () => {
    replicate.poll.mockResolvedValue({ status: 'failed', error: 'boom' });
    await expect(generateGiftVideo(params())).rejects.toMatchObject({ failureCode: 'video_provider_unavailable' });
  });

  test('without a character sheet the film refuses (identity_kit_failed)', async () => {
    buildBookBible.mockResolvedValue({ manifest: {}, hash: 'x', sheet: null, outfit: null, props: [], companion: null, worldPlate: null, emotion: null, advisories: [] });
    await expect(generateGiftVideo(params())).rejects.toMatchObject({ failureCode: 'identity_kit_failed' });
  });

  test('a missing render is video_source_missing', async () => {
    downloadBuffer.mockImplementation(async (k) => { if (k.includes('spread-12')) throw new Error('404'); if (k.endsWith('.qa.json') || k.endsWith('.mp4') || k.endsWith('video.json')) throw new Error('miss'); return PNG; });
    await expect(generateGiftVideo(params())).rejects.toMatchObject({ failureCode: 'video_source_missing' });
  });
});
