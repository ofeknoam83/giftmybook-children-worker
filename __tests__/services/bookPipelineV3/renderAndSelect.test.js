/**
 * Native renderer + QA cascade (W5/W6):
 *   - render fan-out: concurrency-limited, GCS-resume reuses existing
 *     candidates, deterministic paths
 *   - prompt: scene contract + no-text + single-hero rules
 *   - selection: cascade ordering (letterform short-circuits judges),
 *     winner ranking, repair wave with named defects, exhaustion →
 *     aggregated needs_review with all candidates
 */

const mockGcsFiles = new Map();
jest.mock('../../../services/gcsStorage', () => ({
  uploadBuffer: jest.fn(async (buf, path) => { mockGcsFiles.set(path, Buffer.from(buf)); return `https://signed.test/${path}`; }),
  downloadBuffer: jest.fn(async (path) => {
    if (!mockGcsFiles.has(path)) throw new Error('not found');
    return mockGcsFiles.get(path);
  }),
  getSignedUrl: jest.fn(async (path) => `https://signed.test/${path}`),
  saveJson: jest.fn(),
  loadJson: jest.fn(async () => { throw new Error('not found'); }),
  deletePrefix: jest.fn(),
}));

jest.mock('../../../services/bookPipelineV3/illustrator/render/imageClient', () => ({
  generateImage: jest.fn(),
}));

jest.mock('../../../services/bookPipelineV3/illustrator/qa/deterministicChecks', () => ({
  runDeterministicChecks: jest.fn(),
}));
jest.mock('../../../services/bookPipelineV3/illustrator/qa/spreadJudge', () => ({
  judgeSpreadCandidate: jest.fn(),
}));
jest.mock('../../../services/bookPipelineV3/illustrator/qa/likenessJudge', () => ({
  judgeLikenessCrossFamily: jest.fn(),
}));

const { generateImage } = require('../../../services/bookPipelineV3/illustrator/render/imageClient');
const { runDeterministicChecks } = require('../../../services/bookPipelineV3/illustrator/qa/deterministicChecks');
const { judgeSpreadCandidate } = require('../../../services/bookPipelineV3/illustrator/qa/spreadJudge');
const { judgeLikenessCrossFamily } = require('../../../services/bookPipelineV3/illustrator/qa/likenessJudge');

const { buildSpreadRenderPrompt } = require('../../../services/bookPipelineV3/illustrator/render/renderSpread');
const { renderAllSpreadsNative, candidatePath, createLimiter } = require('../../../services/bookPipelineV3/illustrator/render/renderAllSpreads');
const { selectSpreadWinner, buildSpreadQaNeedsReview } = require('../../../services/bookPipelineV3/illustrator/qa/select');

const SPREAD = (n) => ({
  spread: n,
  text: 'line',
  scene_contract: {
    setting: 'sunny backyard',
    characters_present: ['Zoe'],
    hero_action: 'watering a tiny sunflower',
    emotion: 'proud',
    key_objects: ['red watering can'],
  },
});
const PACK = [{ base64: 'sheet', mimeType: 'image/png', note: 'SHEET:' }];
const PHOTOS = [{ base64: 'photo', mimeType: 'image/jpeg' }];

beforeEach(() => {
  mockGcsFiles.clear();
  jest.clearAllMocks();
});

describe('buildSpreadRenderPrompt', () => {
  test('carries the scene contract, no-text rule, and single-hero rule', () => {
    const p = buildSpreadRenderPrompt({ spread: SPREAD(3), briefText: 'BRIEF' });
    expect(p).toContain('sunny backyard');
    expect(p).toContain('watering a tiny sunflower');
    // Required objects are demanded visibly — missing_object was the #2 QA
    // fail class when the prompt merely listed them (book f7191348).
    expect(p).toContain('Must include, each CLEARLY VISIBLE and recognizable: red watering can');
    expect(p).toContain('BRIEF');
    expect(p).toContain('ABSOLUTELY NO TEXT');
    expect(p).toContain('Exactly ONE instance of the child');
  });

  test('written artifacts in the scene must be wordless (maps/notes get squiggles, not letters)', () => {
    const p = buildSpreadRenderPrompt({ spread: SPREAD(3), briefText: 'BRIEF' });
    expect(p).toContain('WORDLESS PROPS');
    expect(p).toContain('never place names or words');
    expect(p).toContain('NEVER the letters N/S/E/W'); // compass rule
    expect(p).toContain('dots or dashes, never numerals'); // clocks/dials
  });

  test("renders the art director's MOMENT (one freeze-frame) instead of the multi-beat action, with pose + hands guidance", () => {
    const p = buildSpreadRenderPrompt({
      spread: SPREAD(3),
      direction: { moment: 'both hands on the closed chest lid, body braced to lift', poseHint: 'whole-hand grip on the lid edge' },
      briefText: 'BRIEF',
    });
    expect(p).toContain('The child is: both hands on the closed chest lid, body braced to lift');
    expect(p).not.toContain('watering a tiny sunflower'); // raw hero_action replaced
    expect(p).toContain('Pose: whole-hand grip on the lid edge');
    expect(p).toContain('HANDS: every visible hand has exactly five clearly separated fingers');
    // without a moment, the raw action is used
    const fallback = buildSpreadRenderPrompt({ spread: SPREAD(3), briefText: 'BRIEF' });
    expect(fallback).toContain('The child is: watering a tiny sunflower');
  });

  // Page-to-page consistency (book audit 2026-07-16): individually-passing
  // spreads still drifted — stray facial moles, apparent age wobbling between
  // spreads. The prompt pins the model sheet as the ONLY source of marks,
  // age, and build.
  test('pins facial marks and age/build to the model sheet on every spread', () => {
    const p = buildSpreadRenderPrompt({ spread: SPREAD(3), briefText: 'BRIEF' });
    expect(p).toContain('FACIAL MARKS: only the marks shown on the model sheet');
    expect(p).toContain('never add moles, beauty marks, or stray dark spots');
    expect(p).toContain("AGE & BUILD: exactly the model sheet's age, proportions, and build");
    expect(p).toContain('never render the child younger/chubbier or older/slimmer');
  });
});

describe('renderAllSpreadsNative', () => {
  test('renders 2 candidates per spread and uploads to deterministic paths', async () => {
    generateImage.mockImplementation(async ({ label }) => ({ buffer: Buffer.from(label), mimeType: 'image/png' }));
    const res = await renderAllSpreadsNative({
      bookId: 'bk1',
      spreads: [SPREAD(1), SPREAD(2)],
      bookPack: PACK,
      briefText: 'B',
      log: () => {},
    });
    expect(res).toHaveLength(2);
    expect(res[0].candidates.map((c) => c.path)).toEqual([
      'children-jobs/bk1/v3-renders/spread-1-c1.png',
      'children-jobs/bk1/v3-renders/spread-1-c2.png',
    ]);
    expect(generateImage).toHaveBeenCalledTimes(4);
  });

  test('resume: existing GCS candidates are reused, only missing ones render', async () => {
    mockGcsFiles.set(candidatePath('bk2', 1, 1), Buffer.from('old-c1'));
    mockGcsFiles.set(candidatePath('bk2', 1, 2), Buffer.from('old-c2'));
    generateImage.mockImplementation(async ({ label }) => ({ buffer: Buffer.from(label), mimeType: 'image/png' }));

    const res = await renderAllSpreadsNative({
      bookId: 'bk2',
      spreads: [SPREAD(1), SPREAD(2)],
      bookPack: PACK,
      briefText: 'B',
      log: () => {},
    });
    expect(res[0].candidates.every((c) => c.reused)).toBe(true);
    // only spread 2 rendered
    expect(generateImage).toHaveBeenCalledTimes(2);
    expect(res[1].candidates).toHaveLength(2);
  });

  test('limiter caps concurrency', async () => {
    let active = 0; let peak = 0;
    const limit = createLimiter(2);
    await Promise.all(Array.from({ length: 6 }, () => limit(async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    })));
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('selectSpreadWinner cascade', () => {
  const CANDS = [
    { path: 'p1', base64: 'c1', mimeType: 'image/png', candidateIndex: 1 },
    { path: 'p2', base64: 'c2', mimeType: 'image/png', candidateIndex: 2 },
  ];
  const passingSpreadJudge = { scores: { anatomy: 5, contract: 5, cast: 5, style: 5, zone: 5 }, minScore: 5, pass: true, tags: [], defects: [] };

  // Regression (2026-07-16): the book-pass regen call site omitted
  // referenceImages entirely (stale `photos:` param) — `...referenceImages`
  // in the likeness judge crashed every book whose book pass flagged a
  // spread, after full render spend. A drifted call site must degrade
  // LOUDLY to the bookPack (the refs every caller passes) — never crash.
  test('missing referenceImages falls back to bookPack refs instead of crashing', async () => {
    runDeterministicChecks.mockResolvedValue({ pass: true, defects: [] });
    judgeSpreadCandidate.mockResolvedValue(passingSpreadJudge);
    judgeLikenessCrossFamily.mockResolvedValue({ pass: true, minLikeness: 5, verdicts: [], defects: [] });

    const logs = [];
    const res = await selectSpreadWinner({
      bookId: 'bk', spread: SPREAD(1), candidates: CANDS, bookPack: PACK,
      /* referenceImages intentionally omitted */ briefText: 'B', log: (m) => logs.push(m),
    });

    expect(res.selected).not.toBeNull();
    expect(judgeLikenessCrossFamily).toHaveBeenCalledWith(expect.objectContaining({ referenceImages: PACK }));
    expect(logs.some((m) => m.includes('referenceImages missing — falling back to bookPack refs'))).toBe(true);
  });

  test('letterform hard-fail short-circuits (judges never called for that candidate)', async () => {
    runDeterministicChecks
      .mockResolvedValueOnce({ pass: false, defects: ['lettering detected in artwork (sign) — automatic fail (D5: no text in pixels)'] })
      .mockResolvedValueOnce({ pass: true, defects: [] });
    judgeSpreadCandidate.mockResolvedValueOnce(passingSpreadJudge);
    judgeLikenessCrossFamily.mockResolvedValueOnce({ pass: true, minLikeness: 5, verdicts: [], defects: [] });

    const qaTagCounts = {};
    const res = await selectSpreadWinner({
      bookId: 'bk', spread: SPREAD(1), candidates: CANDS, bookPack: PACK,
      referenceImages: PHOTOS, briefText: 'B', qaTagCounts, log: () => {},
    });
    expect(res.selected.candidateIndex).toBe(2);
    expect(judgeSpreadCandidate).toHaveBeenCalledTimes(1); // c1 never reached the judge
    expect(qaTagCounts.text_in_art).toBe(1);
  });

  test('winner ranked by likeness across passing candidates', async () => {
    runDeterministicChecks.mockResolvedValue({ pass: true, defects: [] });
    judgeSpreadCandidate.mockResolvedValue(passingSpreadJudge);
    judgeLikenessCrossFamily
      .mockResolvedValueOnce({ pass: true, minLikeness: 4, verdicts: [], defects: [] })
      .mockResolvedValueOnce({ pass: true, minLikeness: 5, verdicts: [], defects: [] });

    const res = await selectSpreadWinner({
      bookId: 'bk', spread: SPREAD(1), candidates: CANDS, bookPack: PACK,
      referenceImages: PHOTOS, briefText: 'B', log: () => {},
    });
    expect(res.selected.candidateIndex).toBe(2);
    expect(res.selected.likeness).toBe(5);
  });

  test('repair wave renders fresh candidates with named defects; exhaustion aggregates needs_review', async () => {
    const { renderSpreadCandidates } = require('../../../services/bookPipelineV3/illustrator/render/renderSpread');
    // Everything fails at the spread judge with a named defect.
    runDeterministicChecks.mockResolvedValue({ pass: true, defects: [] });
    judgeSpreadCandidate.mockResolvedValue({ ...passingSpreadJudge, pass: false, minScore: 2, tags: ['duplicated_hero'], defects: ['two copies of the hero'] });
    generateImage.mockImplementation(async ({ prompt, label }) => {
      // repair prompts must carry the named defect
      expect(prompt).toContain('AVOID these defects');
      return { buffer: Buffer.from(label), mimeType: 'image/png' };
    });

    const qaTagCounts = {};
    const res = await selectSpreadWinner({
      bookId: 'bk', spread: SPREAD(7), candidates: CANDS, bookPack: PACK,
      referenceImages: PHOTOS, briefText: 'B', qaTagCounts, log: () => {},
    });
    expect(res.selected).toBeNull();
    expect(res.repairWaves).toBe(1);
    expect(res.allCandidates.length).toBe(4); // 2 original + 2 repair
    expect(qaTagCounts.duplicated_hero).toBe(4);

    const payload = buildSpreadQaNeedsReview(
      [{ spread: 7, evaluations: res.evaluations, allCandidates: res.allCandidates }],
      (p) => `https://signed.test/${p}`,
    );
    expect(payload.stage).toBe('spreadQa');
    expect(payload.reason).toBe('spread_qa_exhausted');
    expect(payload.spread).toBe(7);
    expect(payload.candidateUrls).toHaveLength(4);
    expect(payload.defects[0]).toMatch(/spread 7 c1 \[spreadJudge\]: two copies of the hero/);
  });

  test('lettering rejections produce a SPECIFIC wordless-props repair instruction', async () => {
    runDeterministicChecks.mockResolvedValue({
      pass: false,
      defects: ['lettering detected in artwork (handwriting on the map — upper right) — automatic fail (D5: no text in pixels)'],
    });
    const repairPrompts = [];
    generateImage.mockImplementation(async ({ prompt, label }) => {
      repairPrompts.push(prompt);
      return { buffer: Buffer.from(label), mimeType: 'image/png' };
    });

    const res = await selectSpreadWinner({
      bookId: 'bk', spread: SPREAD(4), candidates: CANDS, bookPack: PACK,
      referenceImages: PHOTOS, briefText: 'B', qaTagCounts: {}, log: () => {},
    });
    expect(res.selected).toBeNull();
    expect(repairPrompts.length).toBeGreaterThan(0);
    for (const p of repairPrompts) {
      expect(p).toContain('CRITICAL REPAIR: previous renders contained readable writing');
      expect(p).toContain('handwriting on the map');
      expect(p).toContain('WORDLESS abstract marks');
    }
  });

  test('the likeness judge receives the spread\'s shot framing for the framing allowance', async () => {
    runDeterministicChecks.mockResolvedValue({ pass: true, defects: [] });
    judgeSpreadCandidate.mockResolvedValue(passingSpreadJudge);
    judgeLikenessCrossFamily.mockResolvedValue({ pass: true, minLikeness: 5, verdicts: [], defects: [] });

    await selectSpreadWinner({
      bookId: 'bk', spread: SPREAD(1), candidates: [CANDS[0]], bookPack: PACK,
      direction: { shot: 'wide-establishing', textZone: 'left-top' },
      referenceImages: PHOTOS, briefText: 'B', log: () => {},
    });
    expect(judgeLikenessCrossFamily.mock.calls[0][0].contextNote).toContain('"wide-establishing" framing');
  });
});
