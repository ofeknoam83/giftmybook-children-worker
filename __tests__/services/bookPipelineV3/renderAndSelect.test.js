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
const { STYLE_VERSION } = require('../../../services/bookPipelineV3/illustrator/styleBible');
const { SPREAD_RENDERER_MODEL } = require('../../../services/bookPipelineV3/illustrator/config');
const MODEL_SLUG = String(SPREAD_RENDERER_MODEL).replace(/[^a-zA-Z0-9.-]+/g, '_');
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
    // 2026-07-16 (book 5792dc26): story-named map locations got painted as
    // words ("MOON CAVE", "Waterfall", "Summit") — named places must render
    // as pictorial symbols.
    expect(p).toContain('depict them as tiny pictorial symbols');
    expect(p).toContain('NEVER write their names');
  });

  test('the cast list is numbered and unambiguous — same format the judge reads', () => {
    const p = buildSpreadRenderPrompt({ spread: SPREAD(3), briefText: 'BRIEF' });
    expect(p).toContain('Characters present (exactly 1, nobody else): [1] Zoe — the child hero');
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
    // P0 (2026-07-23 audit): anatomy guidance now also pins the LIMB COUNT
    // (two arms / two hands, no third arm/hand) — a three-handed hero shipped.
    expect(p).toContain('ANATOMY: each character has exactly two arms and two hands, with exactly five clearly separated fingers per hand');
    expect(p).toContain('no third arm or third hand');
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

  // 2026-07-16 (book f33b4200): a starlight-themed book drifted the child's
  // hair to blonde/golden on 4 spreads (12 likeness fails) — the palette
  // direction ("golden starlight") fought the identity block. Base colors
  // are lighting-invariant, and the palette line says so inline.
  test('canonical colors are lighting-invariant; the palette line is scene-only', () => {
    const p = buildSpreadRenderPrompt({
      spread: SPREAD(3),
      direction: { palette: 'golden starlight over cool night blues' },
      briefText: 'BRIEF',
    });
    expect(p).toContain('CANONICAL COLORS');
    expect(p).toContain('never re-colors the character: brown hair must still read brown (never blonde/golden) under warm light');
    expect(p).toContain('No color streaks or highlights that are not on the sheet');
    expect(p).toContain("- Palette/lighting (scene only — never re-colors the character's hair/skin/freckles, never changes the render MEDIUM): golden starlight over cool night blues");
  });

  // Prompt hygiene (2026-07-28): the style bible used to sit at block 11 of
  // 17, AFTER the scene/continuity/palette free text; the last thing the
  // model read was a finger-count rule. The bible now LEADS and a one-line
  // STYLE PIN closes, so free-text notes can never soften the medium lock.
  test('the style bible leads the prompt and the style pin closes it', () => {
    const { STYLE_PIN } = require('../../../services/bookPipelineV3/illustrator/styleBible');
    const p = buildSpreadRenderPrompt({
      spread: { ...SPREAD(3), scene_contract: { ...SPREAD(3).scene_contract, continuity_notes: 'soft watercolor mood please' } },
      briefText: 'BRIEF',
    });
    const bibleAt = p.indexOf('SIGNATURE ART STYLE');
    expect(bibleAt).toBeGreaterThan(-1);
    expect(bibleAt).toBeLessThan(p.indexOf('SCENE (from the manuscript'));
    expect(p.trim().endsWith(STYLE_PIN)).toBe(true);
    // Free-text continuity is scoped so it cannot override the lock.
    expect(p).toContain('the SIGNATURE ART STYLE above always wins over any wording here): soft watercolor mood please');
  });

  // 2026-07-16 (book f33b4200, spread 11): a planisphere/star-wheel prop got
  // month letters + numerals on all 4 candidates — inherently text-bearing
  // instruments must render as symbol-marked.
  test('instrument faces (planispheres, star wheels, dials) are wordless', () => {
    const p = buildSpreadRenderPrompt({ spread: SPREAD(3), briefText: 'BRIEF' });
    expect(p).toContain('Instrument faces — planispheres, star wheels/charts, dials, calendar wheels');
    expect(p).toContain('never letters, numerals, or month names');
  });

  // Embedded text layout (2026-07-17): wide renders span two printed pages —
  // the prompt must keep the hero off the gutter and the quiet zone truly
  // printable-over.
  describe('embedded text layout', () => {
    const { resolveSpreadAspect } = require('../../../services/bookPipelineV3/illustrator/render/renderSpread');

    test('resolveSpreadAspect: 16:9 for embedded, 1:1 for caption, env override wins', () => {
      expect(resolveSpreadAspect('embedded')).toBe('16:9');
      expect(resolveSpreadAspect('caption')).toBe('1:1');
      expect(resolveSpreadAspect(undefined)).toBe('1:1');
    });

    test('embedded prompt carries the two-page header, GUTTER rule, and printed-text zone note', () => {
      const p = buildSpreadRenderPrompt({ spread: SPREAD(3), direction: { textZone: 'left-top' }, briefText: 'BRIEF', textLayout: 'embedded' });
      expect(p).toContain('ONE WIDE scene that will span TWO facing printed pages');
      expect(p).toContain('GUTTER: the printed book folds down the exact vertical center');
      expect(p).toContain('clearly OFF the center line');
      expect(p).toContain('The story text will be PRINTED over this zone');
    });

    test('caption prompt is unchanged (no gutter/printed-text language)', () => {
      const p = buildSpreadRenderPrompt({ spread: SPREAD(3), briefText: 'BRIEF' });
      expect(p).not.toContain('GUTTER');
      expect(p).not.toContain('PRINTED over');
      expect(p).toContain('one full-page scene');
    });
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
      `children-jobs/bk1/v3-renders/${STYLE_VERSION}/${MODEL_SLUG}/spread-1-c1.png`,
      `children-jobs/bk1/v3-renders/${STYLE_VERSION}/${MODEL_SLUG}/spread-1-c2.png`,
    ]);
    expect(generateImage).toHaveBeenCalledTimes(4);
  });

  // Style+aspect-keyed cache: the candidate path encodes the style-bible
  // version (a bump re-renders every spread once instead of replaying
  // pre-bump pixels forever — book 16758e3c shipped mixed 2D/3D interiors
  // across nine revisions) and the text layout, because it decides the
  // render aspect (1:1 vs 16:9). An admin flip re-renders only the missing
  // aspect and a flip-back replays the original renders.
  test('candidatePath segments the cache by style version and text layout', () => {
    expect(candidatePath('bk', 4, 2)).toBe(`children-jobs/bk/v3-renders/${STYLE_VERSION}/${MODEL_SLUG}/spread-4-c2.png`);
    expect(candidatePath('bk', 4, 2, 'png', 'caption')).toBe(`children-jobs/bk/v3-renders/${STYLE_VERSION}/${MODEL_SLUG}/spread-4-c2.png`);
    expect(candidatePath('bk', 4, 2, 'png', 'embedded')).toBe(`children-jobs/bk/v3-renders/${STYLE_VERSION}/${MODEL_SLUG}/spread-4-c2.wide.png`);
  });

  test('candidates cached under an older style version are never reused', async () => {
    // Seed a fully-cached render for spread 1 under a PRE-BUMP style path.
    mockGcsFiles.set('children-jobs/bk-bump/v3-renders/spread-1-c1.png', Buffer.from('old-c1'));
    mockGcsFiles.set('children-jobs/bk-bump/v3-renders/sb-0-placeholder/spread-1-c1.png', Buffer.from('old-c1'));
    mockGcsFiles.set('children-jobs/bk-bump/v3-renders/sb-0-placeholder/spread-1-c2.png', Buffer.from('old-c2'));
    generateImage.mockImplementation(async ({ label }) => ({ buffer: Buffer.from(label), mimeType: 'image/png' }));

    const res = await renderAllSpreadsNative({
      bookId: 'bk-bump',
      spreads: [SPREAD(1)],
      bookPack: PACK,
      briefText: 'B',
      log: () => {},
    });
    // The stale-style cache did not satisfy the render — fresh candidates.
    expect(generateImage).toHaveBeenCalledTimes(2);
    expect(res[0].candidates.every((c) => !c.reused)).toBe(true);
    expect(res[0].candidates.map((c) => c.path)).toEqual([
      `children-jobs/bk-bump/v3-renders/${STYLE_VERSION}/${MODEL_SLUG}/spread-1-c1.png`,
      `children-jobs/bk-bump/v3-renders/${STYLE_VERSION}/${MODEL_SLUG}/spread-1-c2.png`,
    ]);
  });

  test('embedded renders never reuse caption-aspect candidates (and upload to .wide paths)', async () => {
    // Seed a fully-cached CAPTION render for spread 1.
    mockGcsFiles.set(candidatePath('bk-flip', 1, 1), Buffer.from('sq-c1'));
    mockGcsFiles.set(candidatePath('bk-flip', 1, 2), Buffer.from('sq-c2'));
    generateImage.mockImplementation(async ({ label }) => ({ buffer: Buffer.from(label), mimeType: 'image/png' }));

    const res = await renderAllSpreadsNative({
      bookId: 'bk-flip',
      spreads: [SPREAD(1)],
      bookPack: PACK,
      briefText: 'B',
      textLayout: 'embedded',
      log: () => {},
    });
    // The square cache did not satisfy the wide render — fresh candidates.
    expect(generateImage).toHaveBeenCalledTimes(2);
    expect(res[0].candidates.map((c) => c.path)).toEqual([
      `children-jobs/bk-flip/v3-renders/${STYLE_VERSION}/${MODEL_SLUG}/spread-1-c1.wide.png`,
      `children-jobs/bk-flip/v3-renders/${STYLE_VERSION}/${MODEL_SLUG}/spread-1-c2.wide.png`,
    ]);
    // The original caption renders survive for a flip-back.
    expect(mockGcsFiles.has(`children-jobs/bk-flip/v3-renders/${STYLE_VERSION}/${MODEL_SLUG}/spread-1-c1.png`)).toBe(true);
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

  // 2026-07-16 (book 5792dc26): a "no image in response — model said: no
  // content" render was silently dropped, so spread 2 fought the whole QA
  // cascade on HALF its candidate budget. Each slot gets one content-level
  // retry before being abandoned.
  describe('renderSpreadCandidates — failed slots retry once', () => {
    const { renderSpreadCandidates } = require('../../../services/bookPipelineV3/illustrator/render/renderSpread');

    test('a slot that fails once and succeeds on retry keeps the full budget', async () => {
      generateImage.mockImplementation(async ({ label }) => {
        if (label.endsWith('.c2') && generateImage.mock.calls.filter((c) => c[0].label.endsWith('.c2')).length === 1) {
          throw new Error('v3.spread.1.c2: no image in response — model said: no content');
        }
        return { buffer: Buffer.from(label), mimeType: 'image/png' };
      });

      const logs = [];
      const res = await renderSpreadCandidates({ spread: SPREAD(1), bookPack: PACK, briefText: 'B', log: (m) => logs.push(m) });

      expect(res).toHaveLength(2);
      expect(res.map((c) => c.candidateIndex).sort()).toEqual([1, 2]);
      expect(generateImage).toHaveBeenCalledTimes(3); // c1 + c2 + c2 retry
      expect(logs.some((m) => m.includes('retrying once'))).toBe(true);
    });

    test('a slot that fails twice is dropped (no infinite retries)', async () => {
      generateImage.mockImplementation(async ({ label }) => {
        if (label.endsWith('.c2')) throw new Error('no image in response');
        return { buffer: Buffer.from(label), mimeType: 'image/png' };
      });

      const logs = [];
      const res = await renderSpreadCandidates({ spread: SPREAD(1), bookPack: PACK, briefText: 'B', log: (m) => logs.push(m) });

      expect(res).toHaveLength(1);
      expect(generateImage).toHaveBeenCalledTimes(3);
      expect(logs.some((m) => m.includes('failed on retry too — dropping the slot'))).toBe(true);
    });
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

  // 2026-07-18 (book 6e018c20): a flat/desaturated spread survived spread QA
  // and died at the book pass. Style-break defects now get the same targeted
  // CRITICAL REPAIR treatment as lettering and color drift.
  test('style-break rejections trigger the cover-style CRITICAL REPAIR in repair renders', async () => {
    runDeterministicChecks.mockResolvedValue({ pass: true, defects: [] });
    judgeSpreadCandidate.mockResolvedValue({
      ...passingSpreadJudge,
      pass: false,
      minScore: 2,
      tags: ['style_drift'],
      defects: ['Jarring style break: flat, desaturated colors and thin lines vs the rest of the book'],
      criticalDefects: ['Jarring style break: flat, desaturated colors and thin lines vs the rest of the book'],
    });
    const repairPrompts = [];
    generateImage.mockImplementation(async ({ prompt, label }) => {
      repairPrompts.push(prompt);
      return { buffer: Buffer.from(label), mimeType: 'image/png' };
    });

    const res = await selectSpreadWinner({
      bookId: 'bk', spread: SPREAD(5), candidates: CANDS, bookPack: PACK,
      referenceImages: PHOTOS, briefText: 'B', qaTagCounts: {}, log: () => {},
    });
    expect(res.selected).toBeNull();
    expect(repairPrompts.length).toBeGreaterThan(0);
    for (const p of repairPrompts) {
      expect(p).toContain("CRITICAL REPAIR: previous renders broke the book's signature style");
      expect(p).toContain("APPROVED COVER reference's rendering style EXACTLY");
      expect(p).toContain('NOT a flat 2D illustration, NOT painterly/watercolor/line-art, NOT desaturated');
    }
  });

  test('the pack cover (kind: cover) is handed to the spread judge as its style reference', async () => {
    runDeterministicChecks.mockResolvedValue({ pass: true, defects: [] });
    judgeSpreadCandidate.mockResolvedValue(passingSpreadJudge);
    judgeLikenessCrossFamily.mockResolvedValue({ pass: true, minLikeness: 5, verdicts: [], defects: [] });
    const COVER = { base64: 'COVER', mimeType: 'image/jpeg', kind: 'cover' };

    await selectSpreadWinner({
      bookId: 'bk', spread: SPREAD(1), candidates: CANDS, bookPack: PACK,
      referenceImages: [{ base64: 'SHEET', kind: 'sheet' }, COVER], briefText: 'B', log: () => {},
    });
    expect(judgeSpreadCandidate).toHaveBeenCalledWith(expect.objectContaining({ coverImage: COVER }));

    // Cover-less packs degrade to the cover-blind judge (coverImage null).
    judgeSpreadCandidate.mockClear();
    await selectSpreadWinner({
      bookId: 'bk', spread: SPREAD(1), candidates: CANDS, bookPack: PACK,
      referenceImages: PHOTOS, briefText: 'B', log: () => {},
    });
    expect(judgeSpreadCandidate).toHaveBeenCalledWith(expect.objectContaining({ coverImage: null }));
  });

  // 2026-07-16 (book f33b4200): hair drifted blonde/golden across repair
  // waves too — the repair prompt now names the color fix explicitly, like
  // the lettering repair does.
  test('likeness color-drift failures trigger the color-specific CRITICAL REPAIR in repair renders', async () => {
    runDeterministicChecks.mockResolvedValue({ pass: true, defects: [] });
    judgeSpreadCandidate.mockResolvedValue(passingSpreadJudge);
    judgeLikenessCrossFamily.mockResolvedValue({
      pass: false,
      minLikeness: 3,
      verdicts: [],
      defects: ["Hair color is golden blonde, significantly lighter than the reference character's medium brown."],
    });
    const repairPrompts = [];
    generateImage.mockImplementation(async ({ prompt, label }) => {
      repairPrompts.push(prompt);
      return { buffer: Buffer.from(label), mimeType: 'image/png' };
    });

    const res = await selectSpreadWinner({
      bookId: 'bk', spread: SPREAD(6), candidates: CANDS, bookPack: PACK,
      referenceImages: PACK, briefText: 'B', qaTagCounts: {}, log: () => {},
    });
    expect(res.selected).toBeNull(); // likeness fails persist in this mock
    expect(repairPrompts.length).toBeGreaterThan(0);
    for (const p of repairPrompts) {
      expect(p).toContain("CRITICAL REPAIR: previous renders drifted the character's colors");
      expect(p).toContain('Match the MODEL SHEET\'s hair color, skin tone, and freckles EXACTLY');
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

// 2026-07-19 audit #2: the judge's fold-collision class alone let a
// fold-centered hero ship. The geometry is now enforced deterministically
// from the judge's own hero_box on wide (embedded) renders.
// 2026-07-20 (book d7625d8f): "swallowed", not "centered" — the box-center
// form failed every close-up candidate (large boxes center near 0.5 by
// nature) and deterministically exhausted spread QA into needs_review.
describe('deterministic fold backstop (embedded renders)', () => {
  const { evaluateCandidate, FOLD_BAND_MIN, FOLD_BAND_MAX, FOLD_SWALLOW_FRAC } = require('../../../services/bookPipelineV3/illustrator/qa/select');
  const CAND = { candidateIndex: 1, path: 'p1', base64: 'img' };

  beforeEach(() => {
    jest.clearAllMocks();
    runDeterministicChecks.mockResolvedValue({ pass: true, defects: [] });
    judgeLikenessCrossFamily.mockResolvedValue({ pass: true, minLikeness: 5, defects: [] });
  });

  test('narrow hero standing on the fold fails deterministically (audit-#2 case)', async () => {
    judgeSpreadCandidate.mockResolvedValue({
      pass: true, scores: {}, tags: [], minorDefects: [], defects: [],
      heroBox: { x: 0.42, y: 0.2, w: 0.14, h: 0.7 }, // 86% of the figure inside the band
      figuresBox: null,
    });
    const counts = {};
    const rec = await evaluateCandidate({
      candidate: CAND, sceneContract: {}, direction: null, referenceImages: [],
      wideSpread: true, qaTagCounts: counts,
    });
    expect(rec.pass).toBe(false);
    expect(rec.stage).toBe('foldCollision');
    expect(rec.tags).toContain('fold_collision');
    expect(counts.fold_collision).toBe(1);
    expect(rec.defects[0]).toContain('fold');
  });

  test('close-up hero spanning the frame with center ~0.5 PASSES (book d7625d8f regression)', async () => {
    judgeSpreadCandidate.mockResolvedValue({
      pass: true, scores: { anatomy: 5, contract: 5, cast: 5, style: 5, zone: 5 }, tags: [], minorDefects: [], defects: [],
      heroBox: { x: 0.2, y: 0.05, w: 0.6, h: 0.9 }, // center = 0.5, but only 20% of the box sits in the band
      figuresBox: null,
    });
    const rec = await evaluateCandidate({
      candidate: CAND, sceneContract: {}, direction: null, referenceImages: [],
      wideSpread: true, qaTagCounts: {},
    });
    expect(rec.pass).toBe(true);
    expect(rec.stage).toBe('passed');
    expect(FOLD_SWALLOW_FRAC).toBeGreaterThan(0.5);
  });

  test('hero clearly on one side passes through to likeness', async () => {
    judgeSpreadCandidate.mockResolvedValue({
      pass: true, scores: { anatomy: 5, contract: 5, cast: 5, style: 5, zone: 5 }, tags: [], minorDefects: [], defects: [],
      heroBox: { x: 0.05, y: 0.2, w: 0.3, h: 0.7 }, // center = 0.2
      figuresBox: { x: 0.05, y: 0.2, w: 0.5, h: 0.7 },
    });
    const rec = await evaluateCandidate({
      candidate: CAND, sceneContract: {}, direction: null, referenceImages: [],
      wideSpread: true, qaTagCounts: {},
    });
    expect(rec.pass).toBe(true);
    expect(rec.heroBox).toEqual({ x: 0.05, y: 0.2, w: 0.3, h: 0.7 });
    expect(rec.figuresBox).toEqual({ x: 0.05, y: 0.2, w: 0.5, h: 0.7 });
  });

  test('square (caption) renders never trigger the fold backstop', async () => {
    judgeSpreadCandidate.mockResolvedValue({
      pass: true, scores: { anatomy: 5, contract: 5, cast: 5, style: 5, zone: 5 }, tags: [], minorDefects: [], defects: [],
      heroBox: { x: 0.4, y: 0.2, w: 0.2, h: 0.7 }, // centered — fine on a square page
      figuresBox: null,
    });
    const rec = await evaluateCandidate({
      candidate: CAND, sceneContract: {}, direction: null, referenceImages: [],
      wideSpread: false, qaTagCounts: {},
    });
    expect(rec.pass).toBe(true);
    expect(FOLD_BAND_MIN).toBeLessThan(0.5);
    expect(FOLD_BAND_MAX).toBeGreaterThan(0.5);
  });

  // 2026-07-22 (book 497c8b68 embedded rerun): under ship-on-exhaustion the
  // fold backstop is a ranking-only advisory, not a hard fail — a fold-swallowed
  // candidate whose anatomy/cast/likeness are all fine can still ship instead of
  // exhausting the whole budget into needs_review.
  test('foldSoften downgrades a fold-swallowed candidate to a passing advisory (does NOT hard-fail)', async () => {
    judgeSpreadCandidate.mockResolvedValue({
      pass: true, scores: { anatomy: 5, contract: 5, cast: 5, style: 5, zone: 5 }, tags: [], minorDefects: [], defects: [],
      heroBox: { x: 0.42, y: 0.2, w: 0.14, h: 0.7 }, // 86% swallowed by the fold band
      figuresBox: null,
    });
    const counts = {};
    const rec = await evaluateCandidate({
      candidate: CAND, sceneContract: {}, direction: null, referenceImages: [],
      wideSpread: true, foldSoften: true, qaTagCounts: counts,
    });
    expect(rec.pass).toBe(true);
    expect(rec.stage).toBe('passed');
    expect(rec.foldAdvisory).toBe(true);
    expect(rec.tags).toContain('fold_collision');
    expect(counts.fold_collision).toBe(1); // still counted as a ranking signal
    expect(rec.minorDefects.some((d) => d.includes('fold collision'))).toBe(true);
  });

  test('foldSoften still hard-fails when a HARDER gate (spread judge) also fails', async () => {
    judgeSpreadCandidate.mockResolvedValue({
      pass: false, scores: {}, tags: [], minorDefects: [], defects: ['the contracted action is entirely absent'],
      criticalDefects: ['the contracted action is entirely absent'],
      heroBox: { x: 0.42, y: 0.2, w: 0.14, h: 0.7 },
      figuresBox: null,
    });
    const rec = await evaluateCandidate({
      candidate: CAND, sceneContract: {}, direction: null, referenceImages: [],
      wideSpread: true, foldSoften: true, qaTagCounts: {},
    });
    expect(rec.pass).toBe(false);
    expect(rec.stage).toBe('spreadJudge');
  });
});

describe('pickWinner / pickLeastBad (ship-on-exhaustion helpers)', () => {
  const { pickWinner, pickLeastBad } = require('../../../services/bookPipelineV3/illustrator/qa/select');

  test('pickWinner ranks a clean pass ABOVE a fold-advisory pass even with lower likeness', () => {
    const clean = { candidateIndex: 1, pass: true, likeness: 4, spreadScores: { anatomy: 5, contract: 5, cast: 5, style: 5, zone: 5 } };
    const folded = { candidateIndex: 2, pass: true, likeness: 5, foldAdvisory: true, spreadScores: { anatomy: 5, contract: 5, cast: 5, style: 5, zone: 5 } };
    expect(pickWinner([folded, clean]).candidateIndex).toBe(1);
  });

  test('pickWinner still returns the fold-advisory pass when it is the only pass', () => {
    const folded = { candidateIndex: 2, pass: true, likeness: 5, foldAdvisory: true, spreadScores: null };
    const failed = { candidateIndex: 1, pass: false, likeness: 0 };
    expect(pickWinner([failed, folded]).candidateIndex).toBe(2);
  });

  test('pickLeastBad prefers the candidate furthest through the cascade', () => {
    const evals = [
      { candidateIndex: 1, stage: 'deterministic', likeness: null, defects: ['blurry'] },
      { candidateIndex: 2, stage: 'likeness', likeness: 3, defects: ['freckles faint'] },
      { candidateIndex: 3, stage: 'foldCollision', likeness: null, defects: ['fold'] },
    ];
    expect(pickLeastBad(evals).candidateIndex).toBe(2); // likeness is deepest
  });

  test('pickLeastBad returns null on no evaluations', () => {
    expect(pickLeastBad([])).toBeNull();
    expect(pickLeastBad(undefined)).toBeNull();
  });
});
