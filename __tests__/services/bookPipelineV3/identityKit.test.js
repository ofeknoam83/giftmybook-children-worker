/**
 * Identity kit (milestone 2 W4):
 *   - cache: stable keys, hit/stale/miss, best-effort writes
 *   - likeness brief: JSON fields → illustrator-grade brief text with
 *     band-correct proportions
 *   - character sheet: best-of-N cross-family selection, second wave,
 *     exhaustion → needs_review payload (identity_kit_exhausted)
 *   - buildIdentityKit: cache short-circuit + full build path
 */

const mockGcsFiles = new Map();
jest.mock('../../../services/gcsStorage', () => ({
  uploadBuffer: jest.fn(async (buf, path) => { mockGcsFiles.set(path, Buffer.from(buf)); return `https://storage.test/${path}`; }),
  saveJson: jest.fn(async (data, path) => { mockGcsFiles.set(path, Buffer.from(JSON.stringify(data))); return `https://storage.test/${path}`; }),
  loadJson: jest.fn(async (path) => {
    if (!mockGcsFiles.has(path)) throw new Error('not found');
    return JSON.parse(mockGcsFiles.get(path).toString());
  }),
  downloadBuffer: jest.fn(),
  deletePrefix: jest.fn(),
}));

jest.mock('../../../services/bookPipelineV3/llm/visionClient', () => ({
  callVisionRole: jest.fn(),
}));

jest.mock('../../../services/bookPipelineV3/illustrator/render/imageClient', () => ({
  generateImage: jest.fn(),
}));

jest.mock('../../../services/illustrationGenerator', () => ({
  downloadPhotoAsBase64: jest.fn(async (url) => ({ base64: `b64:${url}`, mimeType: 'image/jpeg' })),
  getNextApiKey: jest.fn(() => 'k'),
  fetchWithTimeout: jest.fn(),
}));

const { callVisionRole } = require('../../../services/bookPipelineV3/llm/visionClient');
const { generateImage } = require('../../../services/bookPipelineV3/illustrator/render/imageClient');
const { computeKitCacheKey, getCachedKit, setCachedKit, KIT_PROMPT_VERSION } = require('../../../services/bookPipelineV3/illustrator/identityKit/cache');
const { buildLikenessBrief, PROPORTIONS_BY_BAND } = require('../../../services/bookPipelineV3/illustrator/identityKit/likenessBrief');
const { generateCharacterSheet } = require('../../../services/bookPipelineV3/illustrator/identityKit/characterSheet');
const { buildIdentityKit } = require('../../../services/bookPipelineV3/illustrator/identityKit');
const { STYLE_VERSION } = require('../../../services/bookPipelineV3/illustrator/styleBible');
const { LIKENESS_ROLES } = require('../../../services/bookPipelineV3/llm/modelRouter');

const PHOTOS = [{ base64: 'photo1', mimeType: 'image/jpeg' }];

const BRIEF_JSON = {
  skinTone: 'warm medium-brown with golden undertones',
  hairColor: 'dark brown',
  hairStyle: 'short tight curls',
  eyeColor: 'brown',
  faceShape: 'round',
  distinguishingFeatures: ['dimple on left cheek', 'small gap between front teeth'],
  expressionNotes: 'wide grin',
};

function mockBriefCall() {
  callVisionRole.mockImplementationOnce(async () => ({ json: BRIEF_JSON, text: JSON.stringify(BRIEF_JSON), model: 'gemini-2.5-flash', family: 'gemini' }));
}

/** Queue likeness verdicts: each call to callVisionRole returns the next. */
function mockLikenessVerdicts(verdicts) {
  for (const v of verdicts) {
    callVisionRole.mockImplementationOnce(async () => ({
      json: { likeness: v.likeness, skinToneMatch: v.skinToneMatch !== false, hairMatch: true, ageMatch: true, wrongChild: v.wrongChild === true, defects: v.defects || [] },
      text: '',
      model: v.model || 'judge-model',
      family: v.family || 'gemini',
    }));
  }
}

beforeEach(() => {
  mockGcsFiles.clear();
  jest.clearAllMocks();
});

describe('identity-kit cache', () => {
  test('key is order-insensitive over photo URLs and carries versions', () => {
    const a = computeKitCacheKey(['https://x/1.jpg', 'https://x/2.jpg']);
    const b = computeKitCacheKey(['https://x/2.jpg', 'https://x/1.jpg']);
    expect(a).toBe(b);
    expect(a).toContain(STYLE_VERSION);
    expect(a).toContain(KIT_PROMPT_VERSION);
    expect(computeKitCacheKey(['https://x/3.jpg'])).not.toBe(a);
  });

  test('set → get round-trips; stale version misses', async () => {
    const key = computeKitCacheKey(['https://x/1.jpg']);
    await setCachedKit(key, { brief: { briefText: 'B' }, judgeScores: { minLikeness: 5 }, sheetBuffer: Buffer.from('img'), sheetMime: 'image/png' });
    const hit = await getCachedKit(key);
    expect(hit.sheetUrl).toContain('sheet.png');
    expect(hit.brief.briefText).toBe('B');

    const stale = JSON.parse(mockGcsFiles.get(`${key}/kit.json`).toString());
    stale.styleVersion = 'sb-OLD';
    mockGcsFiles.set(`${key}/kit.json`, Buffer.from(JSON.stringify(stale)));
    expect(await getCachedKit(key)).toBeNull();
  });
});

describe('buildLikenessBrief', () => {
  test('composes an illustrator-grade brief with band proportions', async () => {
    mockBriefCall();
    const res = await buildLikenessBrief({ photos: PHOTOS, ageBand: 'PB_INFANT', childDetails: { name: 'Zoe', gender: 'female' } });
    expect(res.fields.skinTone).toMatch(/medium-brown/);
    expect(res.briefText).toContain('Zoe');
    expect(res.briefText).toContain('warm medium-brown with golden undertones');
    expect(res.briefText).toContain('dimple on left cheek');
    expect(res.briefText).toContain(PROPORTIONS_BY_BAND.PB_INFANT);
    expect(res.briefText).toContain('She must be recognizable');
    expect(callVisionRole).toHaveBeenCalledWith('QA_VISION', expect.objectContaining({ expectJson: true }));
  });
});

describe('generateCharacterSheet', () => {
  const sheetImage = (tag) => ({ buffer: Buffer.from(`sheet-${tag}`), mimeType: 'image/png', model: 'img-model' });

  test('picks the passing candidate with the highest min likeness', async () => {
    generateImage
      .mockResolvedValueOnce(sheetImage('a'))
      .mockResolvedValueOnce(sheetImage('b'))
      .mockResolvedValueOnce(sheetImage('c'));
    // candidate a: 4/4 pass; candidate b: 5/5 pass (should win); candidate c: fails family B
    mockLikenessVerdicts([
      { likeness: 4 }, { likeness: 4 },
      { likeness: 5 }, { likeness: 5 },
      { likeness: 5 }, { likeness: 2, defects: ['hair too dark'] },
    ]);
    const res = await generateCharacterSheet({ photos: PHOTOS, briefText: 'brief', log: () => {} });
    expect(res.sheetBuffer.toString()).toBe('sheet-b');
    expect(res.judgeScores.minLikeness).toBe(5);
    expect(res.judgeScores.verdicts).toHaveLength(LIKENESS_ROLES.length);
  });

  test('hard fail (skin tone) rejects a candidate even at likeness 5', async () => {
    generateImage
      .mockResolvedValueOnce(sheetImage('a'))
      .mockResolvedValueOnce(sheetImage('b'))
      .mockResolvedValueOnce(sheetImage('c'));
    mockLikenessVerdicts([
      { likeness: 5, skinToneMatch: false, defects: ['skin lightened vs photo'] }, { likeness: 5 },
      { likeness: 4 }, { likeness: 4 },
      { likeness: 3 }, { likeness: 3 },
    ]);
    const res = await generateCharacterSheet({ photos: PHOTOS, briefText: 'brief', log: () => {} });
    expect(res.sheetBuffer.toString()).toBe('sheet-b');
  });

  test('second wave runs when the first exhausts; exhaustion throws needs_review payload', async () => {
    // 6 renders (2 waves × 3), all judged failing
    for (let i = 0; i < 6; i += 1) generateImage.mockResolvedValueOnce(sheetImage(`x${i}`));
    mockLikenessVerdicts(Array.from({ length: 12 }, () => ({ likeness: 2, defects: ['generic child'] })));

    let thrown;
    try {
      await generateCharacterSheet({ photos: PHOTOS, briefText: 'brief', log: () => {} });
    } catch (err) { thrown = err; }
    expect(thrown).toBeDefined();
    expect(thrown.needsReview).toMatchObject({ stage: 'identityKit', reason: 'identity_kit_exhausted' });
    expect(thrown.needsReview.defects).toContain('generic child');
    expect(generateImage).toHaveBeenCalledTimes(6);
  });
});

describe('buildIdentityKit', () => {
  test('cache hit short-circuits generation but still decodes photos', async () => {
    const key = computeKitCacheKey(['https://x/1.jpg']);
    await setCachedKit(key, { brief: { briefText: 'cached' }, judgeScores: { minLikeness: 5 }, sheetBuffer: Buffer.from('img'), sheetMime: 'image/png' });
    jest.clearAllMocks();

    const kit = await buildIdentityKit({ photoUrls: ['https://x/1.jpg'], ageBand: 'PB_TODDLER', log: () => {} });
    expect(kit.fromCache).toBe(true);
    expect(kit.brief.briefText).toBe('cached');
    expect(kit.photos).toHaveLength(1);
    expect(generateImage).not.toHaveBeenCalled();
    expect(callVisionRole).not.toHaveBeenCalled();
  });

  test('full build: brief → sheet → cached kit with sheetUrl', async () => {
    mockBriefCall();
    generateImage
      .mockResolvedValueOnce({ buffer: Buffer.from('s1'), mimeType: 'image/png' })
      .mockResolvedValueOnce({ buffer: Buffer.from('s2'), mimeType: 'image/png' })
      .mockResolvedValueOnce({ buffer: Buffer.from('s3'), mimeType: 'image/png' });
    mockLikenessVerdicts([
      { likeness: 5 }, { likeness: 5 },
      { likeness: 3 }, { likeness: 3 },
      { likeness: 3 }, { likeness: 3 },
    ]);

    const kit = await buildIdentityKit({
      photoUrls: ['https://x/9.jpg'],
      ageBand: 'PB_PRESCHOOL',
      childDetails: { name: 'Ari' },
      log: () => {},
    });
    expect(kit.fromCache).toBe(false);
    expect(kit.sheetUrl).toContain('identity-kit/');
    expect(kit.judgeScores.minLikeness).toBe(5);
    expect(kit.styleVersion).toBe(STYLE_VERSION);
    // second call is a cache hit
    const again = await buildIdentityKit({ photoUrls: ['https://x/9.jpg'], ageBand: 'PB_PRESCHOOL', log: () => {} });
    expect(again.fromCache).toBe(true);
  });

  test('requires photos', async () => {
    await expect(buildIdentityKit({ photoUrls: [], ageBand: 'PB_TODDLER' })).rejects.toThrow(/photo URL/);
  });
});
