/**
 * The gift video's text gate on an EMBEDDED book (2026-09-07, dispatch
 * gv_1788803092138): a "text-free" re-render can still carry in-world
 * lettering (a moon map labelled "CRATER 1 CRATER 2"), and the illustrator
 * ships it with the finding on record. The gate must RECOVER within
 * `CATALOG_VIDEO_TEXT_GATE_RETRIES` — the same spread rendered FRESH first
 * (a replay returns the lettered bytes), then the nearest untried spread as
 * a substitute — and fail `video_text_visible` only when the budget is spent.
 */

process.env.NODE_ENV = 'test';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GCS_BUCKET_NAME = 'test-bucket';

jest.mock('../services/catalogEngine/illustrator', () => ({ renderStorySpreads: jest.fn(), storyFingerprint: () => 'fp' }));
jest.mock('../services/catalogEngine/illustrator/bible', () => ({
  buildBookBible: jest.fn(),
  summarizeBible: jest.fn().mockResolvedValue({}),
  anchorHash: () => 'anchor',
}));
jest.mock('../services/catalogEngine/video/stillSelect', () => {
  const actual = jest.requireActual('../services/catalogEngine/video/stillSelect');
  return { ...actual, judgeStill: jest.fn() };
});
jest.mock('../services/catalogEngine/video/stills', () => {
  const actual = jest.requireActual('../services/catalogEngine/video/stills');
  return { ...actual, prepareStartFrame: jest.fn(async (buffer) => ({ buffer, hash: 'prepared', letterboxed: false })) };
});
jest.mock('../services/catalogEngine/video/generate', () => {
  const actual = jest.requireActual('../services/catalogEngine/video/generate');
  // The gate under test sits BEFORE generation: a sentinel there proves the
  // film went on to animate (the frames passed the gate).
  return { ...actual, generateCandidates: jest.fn(async () => { throw new Error('STOP_AT_GENERATION'); }) };
});
jest.mock('../services/catalogEngine/video/ffmpeg', () => {
  const actual = jest.requireActual('../services/catalogEngine/video/ffmpeg');
  return { ...actual, makeTempDir: jest.fn(async () => '/tmp/gift-video-test'), removeDir: jest.fn(async () => {}) };
});
jest.mock('../services/catalogEngine/video/providers', () => ({
  resolveProvider: () => ({ ok: true, provider: 'replicate', model: 'test-model', profile: { name: 'test', supportsEndFrame: true, durations: [5, 10] } }),
}));
jest.mock('../services/illustrationGenerator', () => ({
  downloadPhotoAsBase64: jest.fn().mockResolvedValue({ base64: 'ZmFrZQ==', mimeType: 'image/jpeg' }),
  isModestBathWaterScene: () => false,
  getNextApiKey: () => 'k',
  fetchWithTimeout: jest.fn(),
}));
jest.mock('../services/gcsStorage', () => ({
  uploadBuffer: jest.fn().mockResolvedValue('https://storage.example.com/file'),
  getSignedUrl: jest.fn().mockResolvedValue('https://storage.example.com/signed'),
  downloadBuffer: jest.fn().mockResolvedValue(Buffer.from('fake-image')),
  objectExists: jest.fn().mockResolvedValue(false),
  saveJson: jest.fn().mockResolvedValue(undefined),
  loadJson: jest.fn().mockRejectedValue(new Error('not found')),
}));

const { renderStorySpreads } = require('../services/catalogEngine/illustrator');
const { buildBookBible } = require('../services/catalogEngine/illustrator/bible');
const { judgeStill } = require('../services/catalogEngine/video/stillSelect');
const { generateGiftVideo } = require('../services/catalogEngine/video');
const { alternateSpread } = require('../services/catalogEngine/video/plan');

const BOOK = 'book-embedded';
const beats = Array.from({ length: 12 }, (_, i) => ({ spread: i + 1, beat: `beat ${i + 1}` }));
const story = {
  spreads: beats.map(b => ({ spread: b.spread, text: `Spread ${b.spread} text.` })),
  versions: { catalog: 'v1' },
  personalization_evidence: [],
};
const bookDef = { book: { id: 'space_4_5_moon', beats }, theme: { id: 'space', companion: null }, ageBand: '4-5' };
const renders = beats.map(b => ({ spread: b.spread, storageKey: `children-jobs/${BOOK}/ce-renders/ce-19/fp/spread-${b.spread}.wide.png` }));

const cleanVerdict = { textPresent: false, transcript: null, childVisible: true, childCutOff: false, reservedSide: 'none', bandOrPanel: false, completePicture: true, quality: 4 };
const letteredVerdict = { ...cleanVerdict, textPresent: true, transcript: 'moon map CRATER 1 CRATER 2' };

/** A render call's results: one buffer per spread whose bytes name the call. */
let renderCall = 0;
function mockRenders(blockingFor = {}) {
  renderStorySpreads.mockImplementation(async ({ spreads }) => {
    renderCall += 1;
    return {
      results: spreads.map(spread => ({
        spread, buffer: Buffer.from(`render-${spread}-${renderCall}`), storageKey: `children-jobs/${BOOK}/ce-renders/ce-19/fp/spread-${spread}.wide-plain.png`,
        advisories: [], blocking: blockingFor[spread] || [], fresh: true,
      })),
      unresolved: [], bookBible: {}, advisories: [],
    };
  });
}

function run(overrides = {}) {
  return generateGiftVideo({
    bookId: BOOK, story, bookDef, profile: { name: 'Noa', age: 4 }, renders,
    approvedCoverUrl: 'https://storage.example.com/cover.png', textLayout: 'embedded',
    costTracker: { addTextUsage: jest.fn(), addImageGeneration: jest.fn(), getSummary: () => ({}) },
    log: () => {}, onProgress: () => {}, ...overrides,
  });
}

beforeEach(() => {
  renderCall = 0;
  jest.clearAllMocks();
  delete process.env.CATALOG_VIDEO_TEXT_GATE_RETRIES;
  buildBookBible.mockResolvedValue({ hash: 'b', advisories: [], sheet: { base64: 'c2hlZXQ=', mimeType: 'image/png', hash: 'sheet' }, outfit: null, companion: null, props: [], emotion: null });
});

describe('alternateSpread', () => {
  test('picks the nearest untried spread, earlier on ties, null when exhausted', () => {
    const all = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    expect(alternateSpread(1, all, [1, 7, 12])).toBe(2);
    expect(alternateSpread(7, all, [1, 7, 12])).toBe(6);
    expect(alternateSpread(7, all, [1, 6, 7, 12])).toBe(8);
    expect(alternateSpread(12, all, [1, 7, 12])).toBe(11);
    expect(alternateSpread(1, [1, 7, 12], [1, 7, 12])).toBeNull();
    expect(alternateSpread(1, [1, 2], [1])).toBe(2);
  });
});

describe('generateGiftVideo — embedded text gate recovery', () => {
  test('a lettered start frame is re-rendered FRESH first, and the film goes on when it comes back clean', async () => {
    mockRenders();
    // Call 1 (the arc 1/7/12): spread 1 lettered. Call 2 (spread 1 fresh): clean.
    judgeStill.mockImplementation(async (buffer) => ({ verdict: String(buffer) === 'render-1-1' ? letteredVerdict : cleanVerdict }));
    await expect(run()).rejects.toThrow('STOP_AT_GENERATION');
    expect(renderStorySpreads).toHaveBeenCalledTimes(2);
    expect(renderStorySpreads.mock.calls[0][0]).toMatchObject({ textLayout: 'half', spreads: [1, 8, 12], rerenderSpreads: null });
    expect(renderStorySpreads.mock.calls[1][0]).toMatchObject({ textLayout: 'half', spreads: [1], rerenderSpreads: [1], forceRerender: false });
    expect(judgeStill).toHaveBeenCalledTimes(4);
  });

  test('a spread that keeps its lettering is replaced by the nearest untried spread', async () => {
    mockRenders();
    // Spread 1 lettered on the arc call AND on its fresh re-render; spread 2 (the substitute) clean.
    judgeStill.mockImplementation(async (buffer) => ({ verdict: /^render-1-/.test(String(buffer)) ? letteredVerdict : cleanVerdict }));
    await expect(run()).rejects.toThrow('STOP_AT_GENERATION');
    expect(renderStorySpreads).toHaveBeenCalledTimes(3);
    expect(renderStorySpreads.mock.calls[1][0]).toMatchObject({ spreads: [1], rerenderSpreads: [1] });
    expect(renderStorySpreads.mock.calls[2][0]).toMatchObject({ spreads: [2], rerenderSpreads: null });
  });

  test("the illustrator's own painted-text finding rejects a frame even when the judge passes it", async () => {
    mockRenders({ 1: ['painted text in the illustration'] });
    judgeStill.mockResolvedValue({ verdict: cleanVerdict });
    process.env.CATALOG_VIDEO_TEXT_GATE_RETRIES = '0';
    const err = await run().catch(e => e);
    expect(err.failureCode).toBe('video_text_visible');
    expect(err.details.textGate).toEqual([{ segment: 0, kind: 'spread', spread: 1, pass: false, transcript: 'painted text in the illustration' }]);
    expect(renderStorySpreads).toHaveBeenCalledTimes(1);
  });

  test('a spent budget fails video_text_visible with every lettered attempt on record', async () => {
    mockRenders();
    judgeStill.mockImplementation(async (buffer) => ({ verdict: /^render-(1|2)-/.test(String(buffer)) ? letteredVerdict : cleanVerdict }));
    process.env.CATALOG_VIDEO_TEXT_GATE_RETRIES = '2';
    const err = await run().catch(e => e);
    expect(err.failureCode).toBe('video_text_visible');
    expect(err.message).toMatch(/moon map CRATER 1 CRATER 2/);
    expect(err.message).toMatch(/retry budget is spent/);
    expect(err.details.textGate.map(t => t.spread)).toEqual([1, 1, 2]);
    expect(renderStorySpreads).toHaveBeenCalledTimes(3);
  });
});
