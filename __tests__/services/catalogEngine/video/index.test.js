/**
 * The gift video orchestrator (gv-2) end to end with every external
 * boundary mocked: the vendor adapter, the verifier, ffmpeg, GCS, the
 * bible builder, and the still judge's vision call. Covers the happy path
 * (twelve renders judged → the best three picked → ONE 10 s take with a
 * start and an end frame → the film), the film-level replay, pinned still
 * verdicts, embedded books re-rendering their arc trio text-free, painted
 * text excluding a render (and failing the film when every render has
 * it), an unresolved take failing closed with its scored candidates, and a
 * vendor that refuses every candidate.
 */

process.env.CATALOG_VIDEO_CLIP_CANDIDATES = '1';
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

/** One distinct PNG per spread (+ the cover) so the mocked judge can tell them apart. */
const PNGS = new Map();
let COVER_PNG;
const spreadOfImage = (b64) => { for (const [n, png] of PNGS) if (png.toString('base64') === b64) return n; return null; };

const CLEAN_STILL = { text_present: false, transcript: '', child_visible: true, child_cut_off: false, reserved_side: 'none', band_or_panel: false, complete_picture: true, quality: 4 };
const stillReply = (json) => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] }) });
/** Mock the still judge per spread: `fn(spread) → partial verdict` (undefined ⇒ clean). */
const judgeBySpread = (fn) => fetchWithTimeout.mockImplementation(async (url, opts) => {
  const b64 = JSON.parse(opts.body).contents[0].parts[1].inline_data.data;
  const spread = spreadOfImage(b64);
  return stillReply({ ...CLEAN_STILL, ...(fn(spread) || {}) });
});

const cleanVerdict = () => ({ pass: true, defects: [], blocking: [], advisory: [], frames: [], judge: { defects: [] }, score: 100 });
const blockingVerdict = (d) => ({ pass: false, defects: [d], blocking: [d], advisory: [], frames: [], judge: { defects: [] }, score: -20 });

const params = (over = {}) => ({
  bookId: 'b1', story, bookDef, profile, renders: renders(), approvedCoverUrl: 'https://cover.example/c.png?sig=1',
  childPhotoUrl: null, characterDescription: null, textLayout: 'half', tuning: null,
  costTracker: new CostTracker(), log: () => {}, pollIntervalMs: 1, ...over,
});

beforeAll(async () => {
  for (let n = 1; n <= 12; n++) {
    PNGS.set(n, await sharp({ create: { width: 192, height: 108, channels: 3, background: { r: 20 * n, g: 60, b: 255 - 15 * n } } }).png().toBuffer());
  }
  COVER_PNG = await sharp({ create: { width: 192, height: 108, channels: 3, background: '#aa2244' } }).png().toBuffer();
});

beforeEach(() => {
  jest.clearAllMocks();
  downloadPhotoAsBase64.mockResolvedValue({ base64: COVER_PNG.toString('base64'), mimeType: 'image/png' });
  judgeBySpread(() => ({ quality: 4 })); // every render clean and complete
  downloadBuffer.mockImplementation(async (k) => {
    if (k.endsWith('.qa.json') || k.endsWith('.mp4') || k.endsWith('video.json')) throw new Error('miss');
    const m = /spread-(\d+)\./.exec(k);
    return m ? PNGS.get(Number(m[1])) : COVER_PNG;
  });
  loadJson.mockRejectedValue(new Error('no manifest'));
  objectExists.mockResolvedValue(false);
  buildBookBible.mockResolvedValue({
    manifest: {}, hash: 'bh',
    sheet: { base64: PNGS.get(1).toString('base64'), mimeType: 'image/png', hash: 'sh', storageKey: 'sheet.png' },
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
  test('twelve renders judged → the best three picked → ONE 10 s take with start + end frames → the film', async () => {
    judgeBySpread(s => ({ quality: s === 7 ? 5 : 4, reserved_side: s === 3 ? 'right' : 'none' }));
    const p = params();
    const r = await generateGiftVideo(p);
    expect(r.video).toMatchObject({ durationSeconds: 10, width: 1920, height: 1080, fps: 30, cached: false, version: VIDEO_VERSION, music: 'none' });
    expect(r.video.storageKey).toMatch(new RegExp(`^children-jobs/b1/gift-video/${VIDEO_VERSION}/[a-z0-9]+/video\\.mp4$`));
    // the still gate: every render judged once, the best three picked in story order
    expect(fetchWithTimeout).toHaveBeenCalledTimes(12);
    expect(r.stills).toHaveLength(12);
    expect(r.stills.filter(s => s.picked).map(s => s.spread)).toEqual([1, 7, 12]);
    expect(r.stills.find(s => s.spread === 3)).toMatchObject({ score: 55, reasons: ['right side reserved for text'], picked: false, storageKey: key(3) });
    expect(saveJson).toHaveBeenCalledWith(expect.objectContaining({ verdict: expect.any(Object) }), expect.stringMatching(/\/stills\/[a-z0-9]+\.json$/));
    // the plan: one journey segment, one act per pick, distinct angles
    expect(r.plan).toHaveLength(1);
    expect(r.plan[0]).toMatchObject({ index: 0, kind: 'journey', spread: null, spreads: [1, 7, 12], seconds: 10, motion: 'journey' });
    expect(r.plan[0].acts.map(a => a.spread)).toEqual([1, 7, 12]);
    expect(new Set(r.plan[0].acts.map(a => a.angle)).size).toBe(3);
    expect(r.plan[0].startFrame).toMatchObject({ storageKey: key(1), rerendered: false });
    expect(r.plan[0].endFrame).toMatchObject({ storageKey: key(12), rerendered: false });
    expect(r.plan[0].clip).toMatchObject({ candidates: 1, repairs: 0, replayed: false });
    expect(r.textGate).toEqual([{ segment: 0, kind: 'spread', spread: 1, pass: true }, { segment: 0, kind: 'spread', spread: 7, pass: true }, { segment: 0, kind: 'spread', spread: 12, pass: true }]);
    expect(r.unresolved).toEqual([]);
    // ONE vendor clip: start frame + end frame + the identity kit
    expect(replicate.submit).toHaveBeenCalledTimes(1);
    const input = replicate.submit.mock.calls[0][0].input;
    expect(input.start_image).toMatch(/^https:\/\/signed\/.*\/frames\//);
    expect(input.end_image).toMatch(/^https:\/\/signed\/.*\/frames\//);
    expect(input.end_image).not.toBe(input.start_image);
    expect(input.duration).toBe(10);
    expect(input.elements[0].images).toHaveLength(2);
    expect(input.generate_audio).toBe(false);
    expect(input.prompt).toContain('ONE continuous, unbroken 10-second shot');
    expect(input.prompt).toContain('MOMENT 3 (6.7–10s)');
    expect(p.costTracker.getSummary().breakdown['kwaivgi/kling-v3-video'].videoSeconds).toBe(10);
    // the verifier saw the take with its acts
    expect(verifyClip).toHaveBeenCalledTimes(1);
    expect(verifyClip.mock.calls[0][0].checks.acts.map(a => a.spread)).toEqual([1, 7, 12]);
    expect(verifyClip.mock.calls[0][0].checks.acts[1].emotion).toMatchObject({ emotion: 'joy', intensity: 'big' });
    expect(runFfmpeg).toHaveBeenCalledTimes(2); // finish + poster
    const stitchArgs = runFfmpeg.mock.calls[0][0];
    expect(stitchArgs[stitchArgs.length - 2]).toBe('10.000');
    expect(saveJson).toHaveBeenCalledWith(expect.objectContaining({ videoVersion: VIDEO_VERSION, provider: 'replicate', stills: expect.any(Array) }), expect.stringMatching(/video\.json$/));
    // one promoted clip + marker
    expect(uploadBuffer.mock.calls.filter(c => /clips\/s0-[a-z0-9]+\.mp4$/.test(c[1]))).toHaveLength(1);
    const marker = uploadBuffer.mock.calls.find(c => /clips\/s0-[a-z0-9]+\.mp4\.qa\.json$/.test(c[1]));
    expect(JSON.parse(marker[0].toString())).toMatchObject({ unresolved: false, spreads: [1, 7, 12], endFrame: true });
    expect(r.provider).toBe('replicate');
  });

  test('a pinned still verdict replays without a judge call and ranks the same', async () => {
    const pinned = { textPresent: false, transcript: null, childVisible: true, childCutOff: false, reservedSide: 'none', bandOrPanel: false, completePicture: true, quality: 5 };
    loadJson.mockImplementation(async (k) => { if (/\/stills\/[a-z0-9]+\.json$/.test(k)) return { qaVersion: require('../../../../services/catalogEngine/versions').QA_VERSION, verdict: pinned }; throw new Error('miss'); });
    const r = await generateGiftVideo(params());
    expect(fetchWithTimeout).not.toHaveBeenCalled();
    expect(r.stills.every(s => s.quality === 5 && !s.unchecked)).toBe(true);
    expect(r.stills.filter(s => s.picked).map(s => s.spread)).toEqual([1, 6, 12]);
  });

  test('CATALOG_VIDEO_END_FRAME=0 sends the start frame alone with an advisory', async () => {
    process.env.CATALOG_VIDEO_END_FRAME = '0';
    try {
      const r = await generateGiftVideo(params());
      expect('end_image' in replicate.submit.mock.calls[0][0].input).toBe(false);
      expect(r.plan[0].endFrame).toBeNull();
      expect(r.advisories.some(a => /no end frame/.test(a.note))).toBe(true);
    } finally {
      delete process.env.CATALOG_VIDEO_END_FRAME;
    }
  });

  test('a film whose manifest and mp4 exist replays without a vendor call', async () => {
    loadJson.mockImplementation(async (k) => { if (k.endsWith('video.json')) return { video: { storageKey: 'k', hash: 'h', durationSeconds: 10 }, plan: [{ index: 0 }], textGate: [], advisories: [] }; throw new Error('miss'); });
    objectExists.mockResolvedValue(true);
    const r = await generateGiftVideo(params());
    expect(r.video.cached).toBe(true);
    expect(r.video.url).toMatch(/^https:\/\/signed\//);
    expect(r.stills).toHaveLength(12);
    expect(replicate.submit).not.toHaveBeenCalled();
    expect(runFfmpeg).not.toHaveBeenCalled();
  });

  test('forceNew skips the replay and re-judges the stills', async () => {
    loadJson.mockResolvedValue({ video: { storageKey: 'k' }, plan: [], qaVersion: 'x', verdict: { quality: 1 } });
    objectExists.mockResolvedValue(true);
    const r = await generateGiftVideo(params({ forceNew: true }));
    expect(r.video.cached).toBe(false);
    expect(replicate.submit).toHaveBeenCalled();
    expect(fetchWithTimeout).toHaveBeenCalledTimes(12);
  });

  test('embedded renders re-render the story arc text-free through the half layout, then gate the frames', async () => {
    renderStorySpreads.mockImplementation(async ({ spreads }) => ({
      results: spreads.map(s => ({ spread: s, buffer: PNGS.get(s), storageKey: key(s), url: 'u', advisories: [] })),
      unresolved: [], bookBible: null,
    }));
    const r = await generateGiftVideo(params({ renders: renders('wide'), textLayout: 'embedded', identityKeyed: true, probeNonce: 'n1', seed: 7 }));
    expect(renderStorySpreads).toHaveBeenCalledTimes(1);
    expect(renderStorySpreads.mock.calls[0][0]).toMatchObject({ textLayout: 'half', spreads: [1, 7, 12], identityKeyed: true, probeNonce: 'n1', seed: 7 });
    expect(fetchWithTimeout).toHaveBeenCalledTimes(3); // only the re-rendered frames are judged
    expect(r.plan[0].spreads).toEqual([1, 7, 12]);
    expect(r.plan[0].startFrame.rerendered).toBe(true);
    expect(r.plan[0].endFrame.rerendered).toBe(true);
    expect(r.stills).toHaveLength(3);
    expect(r.stills.every(s => s.rerendered && s.picked)).toBe(true);
    expect(r.advisories.some(a => /re-rendered text-free/.test(a.note))).toBe(true);
  });

  test('painted text on some renders excludes them; on every render it fails the film video_text_visible', async () => {
    judgeBySpread(s => (s === 1 || s === 12 ? { text_present: true, transcript: 'Hello farm!' } : {}));
    const r = await generateGiftVideo(params());
    expect(r.stills.filter(s => s.picked).map(s => s.spread)).not.toEqual(expect.arrayContaining([1, 12]));
    expect(r.stills.find(s => s.spread === 1)).toMatchObject({ disqualified: true, reasons: ['painted text ("Hello farm!")'] });
    expect(r.video.durationSeconds).toBe(10);

    jest.clearAllMocks();
    replicate.submit.mockImplementation(async () => ({ jobId: 'j', pollUrl: 'p' }));
    judgeBySpread(() => ({ text_present: true, transcript: 'Hello farm!' }));
    await expect(generateGiftVideo(params())).rejects.toMatchObject({ failureCode: 'video_text_visible' });
    expect(replicate.submit).not.toHaveBeenCalled();
  });

  test('renders the judge cannot use at all (no child, a band) are video_no_sources with the reasons', async () => {
    judgeBySpread(s => (s % 2 ? { child_visible: false } : { band_or_panel: true }));
    let err;
    try { await generateGiftVideo(params()); } catch (e) { err = e; }
    expect(err.failureCode).toBe('video_no_sources');
    expect(err.message).toMatch(/child not visible/);
    expect(err.details.stills).toHaveLength(12);
    expect(replicate.submit).not.toHaveBeenCalled();
  });

  test('a judge outage ranks every still unchecked, picks the arc, and the film still ships with an advisory', async () => {
    fetchWithTimeout.mockRejectedValue(new Error('offline'));
    const r = await generateGiftVideo(params());
    expect(r.stills.every(s => s.unchecked)).toBe(true);
    expect(r.plan[0].spreads).toEqual([1, 6, 12]);
    expect(r.textGate.every(t => t.pass && t.unavailable)).toBe(true);
    expect(r.advisories.some(a => /still judge unavailable for 12/.test(a.note))).toBe(true);
    expect(r.video.durationSeconds).toBe(10);
  });

  test('a take that stays blocking after the repair budget fails closed with its scored candidates', async () => {
    verifyClip.mockResolvedValue(blockingVerdict('identity break: the child does not match the character model sheet'));
    let err;
    try { await generateGiftVideo(params()); } catch (e) { err = e; }
    expect(err.failureCode).toBe('video_unresolved');
    expect(err.details.unresolved).toHaveLength(1);
    const u = err.details.unresolved[0];
    expect(u).toMatchObject({ segment: 0, spread: null, spreads: [1, 6, 12] });
    expect(u.defects).toEqual(['identity break: the child does not match the character model sheet']);
    expect(u.candidates).toHaveLength(2); // 1 base + 1 repair candidate, each with its own key
    expect(u.candidates.map(c => c.storageKey)).toEqual([expect.stringMatching(/\.c1\.mp4$/), expect.stringMatching(/\.r1c1\.mp4$/)]);
    // every pass shares the base clip identity: the repair candidate sits
    // beside the SAME canonical key, so a pick-clip of one replays later
    const bases = new Set(u.candidates.map(c => c.storageKey.replace(/\.(?:r\d+)?c\d\.mp4$/, '.mp4')));
    expect(bases.size).toBe(1);
    expect([...bases][0]).toBe(err.details.plan[0].clip.storageKey);
    expect(u.candidates.every(c => c.url && typeof c.score === 'number')).toBe(true);
    expect(err.details.plan[0].clip.repairs).toBe(1);
    expect(err.details.stills).toHaveLength(12);
    expect(replicate.submit).toHaveBeenCalledTimes(2);
    expect(replicate.submit.mock.calls[1][0].input.prompt).toContain('IDENTITY REPAIR');
    expect(runFfmpeg).not.toHaveBeenCalled();
    // the promoted marker records the unresolved state
    const marker = uploadBuffer.mock.calls.find(c => /s0-[a-z0-9]+\.mp4\.qa\.json$/.test(c[1]));
    expect(JSON.parse(marker[0].toString())).toMatchObject({ unresolved: true });
  });

  test('a promoted clip whose marker vouches for it replays and only re-finishes the film', async () => {
    const { QA_VERSION } = require('../../../../services/catalogEngine/versions');
    const { fnv1a } = require('../../../../services/catalogEngine/selection');
    const clip = Buffer.from('picked-clip');
    loadJson.mockImplementation(async (k) => {
      if (/clips\/s0-[a-z0-9]+\.mp4\.qa\.json$/.test(k)) return { qaVersion: QA_VERSION, adminPicked: true, renderHash: fnv1a(clip.toString('base64')).toString(36), score: 100 };
      throw new Error('miss');
    });
    downloadBuffer.mockImplementation(async (k) => {
      if (/clips\/s0-[a-z0-9]+\.mp4$/.test(k)) return clip;
      if (k.endsWith('.qa.json') || k.endsWith('.mp4') || k.endsWith('video.json')) throw new Error('miss');
      const m = /spread-(\d+)\./.exec(k);
      return m ? PNGS.get(Number(m[1])) : COVER_PNG;
    });
    const r = await generateGiftVideo(params());
    expect(replicate.submit).not.toHaveBeenCalled();
    expect(r.plan[0].clip).toMatchObject({ replayed: true, adminPicked: true, candidates: 0 });
    expect(r.video.durationSeconds).toBe(10);
  });

  test('CATALOG_VIDEO_SHIP_ON_EXHAUSTION=1 finishes the residual with a shipPolicy advisory', async () => {
    process.env.CATALOG_VIDEO_SHIP_ON_EXHAUSTION = '1';
    try {
      verifyClip.mockResolvedValue(blockingVerdict('frozen clip: no visible motion'));
      const r = await generateGiftVideo(params());
      expect(r.unresolved).toHaveLength(1);
      expect(r.advisories.some(a => a.stage === 'shipPolicy')).toBe(true);
      expect(r.video.durationSeconds).toBe(10);
    } finally {
      delete process.env.CATALOG_VIDEO_SHIP_ON_EXHAUSTION;
    }
  });

  test('a vendor that refuses every candidate is unresolved, not an outage', async () => {
    replicate.poll.mockResolvedValue({ status: 'filtered', error: 'content moderation', reasons: ['moderation'] });
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
    downloadBuffer.mockImplementation(async (k) => { if (k.includes('spread-12')) throw new Error('404'); if (k.endsWith('.qa.json') || k.endsWith('.mp4') || k.endsWith('video.json')) throw new Error('miss'); const m = /spread-(\d+)\./.exec(k); return m ? PNGS.get(Number(m[1])) : COVER_PNG; });
    await expect(generateGiftVideo(params())).rejects.toMatchObject({ failureCode: 'video_source_missing' });
  });

  test('a subset of renders makes a shorter journey (two stills → two acts) on the same 10 s take', async () => {
    const r = await generateGiftVideo(params({ renders: [{ spread: 4, storageKey: key(4) }, { spread: 9, storageKey: key(9) }] }));
    expect(r.plan[0].spreads).toEqual([4, 9]);
    expect(r.plan[0].acts.map(a => [a.from, a.to])).toEqual([[0, 5], [5, 10]]);
    expect(replicate.submit).toHaveBeenCalledTimes(1);
    expect(r.video.durationSeconds).toBe(10);
  });

  // Kling error 1201 (2026-09-08): start frame + end frame + references ≤ 7.
  const PROP_VALUES = ['a wagon', 'a kite', 'a hat', 'a tractor', 'a pail', 'a duck'];
  const propEvidence = (spread = 1) => PROP_VALUES.map(v => ({ spread, visual_required: true, source_value: v, moment_type: 'object_presence', source_field: 'object' }));
  const bibleWithProps = async () => {
    const bible = await buildBookBible();
    buildBookBible.mockResolvedValue({ ...bible, props: PROP_VALUES.map((v, i) => ({ value: v, sheet: { base64: PNGS.get(2).toString('base64'), mimeType: 'image/png', hash: `p${i}`, specText: null } })) });
  };

  test('the take holds its reference kit to the seven-picture limit: start + end frames leave five elements, the omission is an advisory', async () => {
    await bibleWithProps();
    const r = await generateGiftVideo(params({ story: { ...story, personalization_evidence: propEvidence() } }));
    expect(replicate.submit).toHaveBeenCalledTimes(1);
    const input = replicate.submit.mock.calls[0][0].input;
    expect(input.start_image).toBeTruthy();
    expect(input.end_image).toBeTruthy();
    expect(input.elements).toHaveLength(5);
    expect(input.elements[0].images).toHaveLength(2); // the child (cover + sheet) is never the one dropped
    expect(input.prompt).toContain('@Element5');
    expect(input.prompt).not.toContain('@Element6');
    const advisory = r.advisories.find(a => a.stage === 'video' && /at most 7 images per request/.test(a.note));
    expect(advisory.note).toMatch(/attaches 5 of [78] references/);
    expect(advisory.note).toContain('a duck');
    expect(advisory.note).not.toContain('a wagon');
    // the verifier still checks every declared prop against its sheet
    expect(verifyClip.mock.calls[0][0].checks.props.map(p => p.name)).toEqual(PROP_VALUES);
    expect(r.video.durationSeconds).toBe(10);
  });

  test('the Omni profile on the take sends start + end frames + five reference images — never the eight that failed', async () => {
    await bibleWithProps();
    // Two stills: the three-act journey brief alone runs past Omni's 2500-character prompt cap (a separate, older limit).
    const r = await generateGiftVideo(params({ model: 'kwaivgi/kling-v3-omni-video', renders: [{ spread: 4, storageKey: key(4) }, { spread: 9, storageKey: key(9) }], story: { ...story, personalization_evidence: propEvidence(4) } }));
    const input = replicate.submit.mock.calls[0][0].input;
    expect(input.reference_images).toHaveLength(5);
    expect(1 + 1 + input.reference_images.length).toBe(7);
    expect(input.prompt).toContain('<<<image_1>>>');
    expect(input.elements).toBeUndefined();
    expect(r.advisories.some(a => /kwaivgi\/kling-v3-omni-video accepts at most 7 images/.test(a.note))).toBe(true);
  });

  test('a kit that fits the budget is sent whole, with no advisory', async () => {
    await bibleWithProps();
    const r = await generateGiftVideo(params({ story: { ...story, personalization_evidence: propEvidence().slice(0, 2) } }));
    const input = replicate.submit.mock.calls[0][0].input;
    expect(input.elements.length).toBeLessThanOrEqual(5);
    expect(input.elements.map(e => e.images.length)).toContain(2);
    expect(r.advisories.some(a => /images per request/.test(a.note))).toBe(false);
  });
});
