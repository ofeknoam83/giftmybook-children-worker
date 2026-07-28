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

afterEach(() => {
  delete process.env.BOOK_PIPELINE_V3_KIT_SHIP_ON_EXHAUSTION;
  delete process.env.BOOK_PIPELINE_V3_LIKENESS_PASS_SCORE;
});

describe('identity-kit cache', () => {
  test('key is order-insensitive over photo URLs and carries versions', () => {
    const a = computeKitCacheKey(['https://x/1.jpg', 'https://x/2.jpg']);
    const b = computeKitCacheKey(['https://x/2.jpg', 'https://x/1.jpg']);
    expect(a).toBe(b);
    expect(a).toContain(STYLE_VERSION);
    expect(a).toContain(KIT_PROMPT_VERSION);
    // 2026-07-28: the renderer model joined the key — a model flip
    // invalidates cached sheets without a manual ik-N bump.
    const { SHEET_RENDERER_MODEL } = require('../../../services/bookPipelineV3/illustrator/config');
    expect(a).toContain(String(SHEET_RENDERER_MODEL).replace(/[^a-zA-Z0-9.-]+/g, '_'));
    expect(computeKitCacheKey(['https://x/3.jpg'])).not.toBe(a);
  });

  test('the approved cover is part of the key; signed-URL query tokens are not', () => {
    const noCover = computeKitCacheKey(['https://x/1.jpg']);
    const coverA = computeKitCacheKey(['https://x/1.jpg'], 'https://x/covers/a.png');
    const coverB = computeKitCacheKey(['https://x/1.jpg'], 'https://x/covers/b.png');
    expect(coverA).not.toBe(noCover);
    expect(coverA).not.toBe(coverB); // different cover = different approved character
    // rotating signed-URL tokens must not bust the cache
    expect(computeKitCacheKey(['https://x/1.jpg?sig=111'], 'https://x/covers/a.png?sig=222')).toBe(
      computeKitCacheKey(['https://x/1.jpg?sig=999'], 'https://x/covers/a.png?sig=888'),
    );
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
  test('composes an illustrator-grade brief with band proportions (no cover)', async () => {
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

  test('with a cover, proportions/age defer to the cover character instead of the band chart', async () => {
    mockBriefCall();
    const res = await buildLikenessBrief({ photos: PHOTOS, ageBand: 'PB_PRESCHOOL', childDetails: { name: 'Amit', gender: 'male' }, hasCover: true });
    expect(res.briefText).toContain('match the approved cover character');
    expect(res.briefText).not.toContain(PROPORTIONS_BY_BAND.PB_PRESCHOOL);
    expect(res.briefText).toContain('the cover wins');
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
      await generateCharacterSheet({ photos: PHOTOS, briefText: 'brief', bookId: 'book-x', log: () => {} });
    } catch (err) { thrown = err; }
    expect(thrown).toBeDefined();
    expect(thrown.needsReview).toMatchObject({ stage: 'identityKit', reason: 'identity_kit_exhausted' });
    expect(thrown.needsReview.defects).toContain('generic child');
    expect(generateImage).toHaveBeenCalledTimes(6);
  });

  // 2026-07-17: an OpenAI wire-shape change 400'd EVERY judgment — the kit
  // "exhausted" with 0 judged candidates and an empty needs_review payload
  // nobody could act on. Infrastructure outage ≠ identity rejection: zero
  // judged candidates + judge errors must throw a plain retryable error.
  test('all judge calls erroring throws an infrastructure error, NOT an empty needs_review', async () => {
    for (let i = 0; i < 6; i += 1) generateImage.mockResolvedValueOnce(sheetImage(`x${i}`));
    callVisionRole.mockRejectedValue(new Error('openai vision 400: Invalid content type. image_url is only supported by certain models.'));

    let thrown;
    try {
      await generateCharacterSheet({ photos: PHOTOS, briefText: 'brief', bookId: 'book-x', log: () => {} });
    } catch (err) { thrown = err; }
    expect(thrown).toBeDefined();
    expect(thrown.needsReview).toBeUndefined();
    expect(thrown.message).toMatch(/identity kit judging infrastructure failure \(0 candidates judged/);
    expect(thrown.message).toMatch(/image_url is only supported/);
  });

  test('wave 2 feeds the prior wave\'s judge defects back into the prompt (REPAIR block)', async () => {
    for (let i = 0; i < 6; i += 1) generateImage.mockResolvedValueOnce(sheetImage(`x${i}`));
    mockLikenessVerdicts(Array.from({ length: 12 }, () => ({ likeness: 2, defects: ['hair too dark', 'skin lightened vs photo'] })));

    await generateCharacterSheet({ photos: PHOTOS, briefText: 'brief', log: () => {} }).catch(() => {});

    const wave1Prompt = generateImage.mock.calls[0][0].prompt;
    const wave2Prompt = generateImage.mock.calls[3][0].prompt;
    expect(wave1Prompt).not.toContain('REPAIR');
    expect(wave2Prompt).toContain('REPAIR');
    expect(wave2Prompt).toContain('hair too dark');
    expect(wave2Prompt).toContain('skin lightened vs photo');
  });

  test('approved cover attaches as the generation reference; absent cover means no references', async () => {
    generateImage.mockResolvedValue(sheetImage('a'));
    mockLikenessVerdicts([{ likeness: 5 }, { likeness: 5 }, { likeness: 5 }, { likeness: 5 }, { likeness: 5 }, { likeness: 5 }]);
    await generateCharacterSheet({
      photos: PHOTOS,
      briefText: 'brief',
      coverReference: { base64: 'cover-b64', mimeType: 'image/jpeg' },
      log: () => {},
    });
    const call = generateImage.mock.calls[0][0];
    expect(call.references).toHaveLength(1);
    expect(call.references[0].base64).toBe('cover-b64');
    expect(call.references[0].note).toContain('APPROVED BOOK COVER');
    expect(call.prompt).toContain('APPROVED COVER REFERENCE');
    // Part B invariant: the real PHOTOS are never in the reference list
    expect(call.references.some((r) => r.base64 === 'photo1')).toBe(false);

    // Cover-relative QA: the likeness JUDGES also reference the COVER, not the photo
    const judgeCalls = callVisionRole.mock.calls.filter(([, p]) => p.label?.startsWith('v3.likeness.'));
    expect(judgeCalls.length).toBeGreaterThan(0);
    for (const [, params] of judgeCalls) {
      expect(params.images.slice(1).map((img) => img.base64)).toEqual(['cover-b64']);
      expect(params.images.some((img) => img.base64 === 'photo1')).toBe(false);
    }

    jest.clearAllMocks();
    generateImage.mockResolvedValue(sheetImage('b'));
    mockLikenessVerdicts([{ likeness: 5 }, { likeness: 5 }, { likeness: 5 }, { likeness: 5 }, { likeness: 5 }, { likeness: 5 }]);
    await generateCharacterSheet({ photos: PHOTOS, briefText: 'brief', log: () => {} });
    expect(generateImage.mock.calls[0][0].references).toHaveLength(0);
    expect(generateImage.mock.calls[0][0].prompt).not.toContain('APPROVED COVER REFERENCE');
    // Coverless fallback: judges fall back to the photos
    const fallbackJudgeCalls = callVisionRole.mock.calls.filter(([, p]) => p.label?.startsWith('v3.likeness.'));
    expect(fallbackJudgeCalls[0][1].images.slice(1).map((img) => img.base64)).toEqual(['photo1']);
  });

  test('exhaustion payload carries candidate URLs + per-judge verdicts for the review queue', async () => {
    for (let i = 0; i < 6; i += 1) generateImage.mockResolvedValueOnce(sheetImage(`x${i}`));
    mockLikenessVerdicts(Array.from({ length: 12 }, (_, i) => ({ likeness: 2 + (i % 2), defects: ['generic child'] })));

    let thrown;
    try {
      await generateCharacterSheet({ photos: PHOTOS, briefText: 'brief', bookId: 'book-42', log: () => {} });
    } catch (err) { thrown = err; }
    expect(thrown.needsReview.candidateUrls).toHaveLength(6);
    expect(thrown.needsReview.candidateUrls[0]).toContain('children-jobs/book-42/identity-kit-review/');
    const attempt = thrown.needsReview.judgeScores.attempts[0];
    expect(attempt.judges).toHaveLength(LIKENESS_ROLES.length);
    expect(attempt.judges[0]).toMatchObject({ role: expect.any(String), likeness: expect.any(Number) });
  });

  test('BOOK_PIPELINE_V3_KIT_SHIP_ON_EXHAUSTION=1 ships the best-scoring sheet with a loud marker', async () => {
    process.env.BOOK_PIPELINE_V3_KIT_SHIP_ON_EXHAUSTION = '1';
    for (let i = 0; i < 6; i += 1) generateImage.mockResolvedValueOnce(sheetImage(`x${i}`));
    // all fail the bar; candidate x2 has the best minLikeness (3)
    mockLikenessVerdicts([
      { likeness: 2 }, { likeness: 2 },
      { likeness: 2 }, { likeness: 2 },
      { likeness: 3 }, { likeness: 3 },
      { likeness: 2 }, { likeness: 2 },
      { likeness: 2 }, { likeness: 2 },
      { likeness: 2 }, { likeness: 2 },
    ]);
    const warnings = [];
    const res = await generateCharacterSheet({ photos: PHOTOS, briefText: 'brief', log: (m) => warnings.push(m) });
    expect(res.sheetBuffer.toString()).toBe('sheet-x2');
    expect(res.judgeScores.shippedOnExhaustion).toBe(true);
    expect(warnings.join(' ')).toMatch(/KIT_SHIP_ON_EXHAUSTION/);
  });

  test('env-lowered likeness pass score takes effect (BOOK_PIPELINE_V3_LIKENESS_PASS_SCORE=3)', async () => {
    process.env.BOOK_PIPELINE_V3_LIKENESS_PASS_SCORE = '3';
    generateImage.mockResolvedValue(sheetImage('a'));
    // likeness 3 fails the default bar (4) but passes the lowered one
    mockLikenessVerdicts([{ likeness: 3 }, { likeness: 3 }]);
    const res = await generateCharacterSheet({ photos: PHOTOS, briefText: 'brief', log: () => {} });
    expect(res.judgeScores.minLikeness).toBe(3);
  });
});

describe('likeness judge rubric', () => {
  test('pins the cover-relative contract (same character as the APPROVED reference art, not the photo)', () => {
    const { JUDGE_PROMPT } = require('../../../services/bookPipelineV3/illustrator/qa/likenessJudge');
    expect(JUDGE_PROMPT).toContain('THE SAME CHARACTER');
    expect(JUDGE_PROMPT).toContain('APPROVED reference art');
    expect(JUDGE_PROMPT).toContain('identity ground truth');
    expect(JUDGE_PROMPT).not.toMatch(/real photos of the child/);
  });

  test('resolveLikenessPassScore clamps garbage to the default', () => {
    const { resolveLikenessPassScore, LIKENESS_PASS_SCORE } = require('../../../services/bookPipelineV3/illustrator/qa/likenessJudge');
    process.env.BOOK_PIPELINE_V3_LIKENESS_PASS_SCORE = 'strict';
    expect(resolveLikenessPassScore()).toBe(LIKENESS_PASS_SCORE);
    process.env.BOOK_PIPELINE_V3_LIKENESS_PASS_SCORE = '9';
    expect(resolveLikenessPassScore()).toBe(LIKENESS_PASS_SCORE);
    process.env.BOOK_PIPELINE_V3_LIKENESS_PASS_SCORE = '3';
    expect(resolveLikenessPassScore()).toBe(3);
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

  test('pick_sheet resolution bypasses generation + judging and uses the admin-picked candidate', async () => {
    mockBriefCall(); // the brief is still built (downstream renders need it)
    const kit = await buildIdentityKit({
      photoUrls: ['https://x/7.jpg'],
      ageBand: 'PB_PRESCHOOL',
      reviewResolution: { action: 'pick_sheet', candidateUrl: 'https://storage.test/children-jobs/b/identity-kit-review/candidate-w1.2.png', admin: 'qa@giftmybook.com' },
      log: () => {},
    });
    expect(generateImage).not.toHaveBeenCalled(); // no sheet generation
    expect(kit.judgeScores).toMatchObject({ adminPick: true, resolvedBy: 'qa@giftmybook.com' });
    expect(kit.fromCache).toBe(false);
    // the picked sheet was cached like any other kit
    expect(kit.sheetUrl).toContain('identity-kit/');
  });

  test('pick_sheet ignores a stale cached kit (admin decision wins)', async () => {
    const key = computeKitCacheKey(['https://x/8.jpg']);
    await setCachedKit(key, { brief: { briefText: 'cached' }, judgeScores: { minLikeness: 5 }, sheetBuffer: Buffer.from('old'), sheetMime: 'image/png' });
    jest.clearAllMocks();
    mockBriefCall();
    const kit = await buildIdentityKit({
      photoUrls: ['https://x/8.jpg'],
      ageBand: 'PB_PRESCHOOL',
      reviewResolution: { action: 'pick_sheet', candidateUrl: 'https://storage.test/picked.png' },
      log: () => {},
    });
    expect(kit.fromCache).toBe(false);
    expect(kit.judgeScores.adminPick).toBe(true);
  });
});
