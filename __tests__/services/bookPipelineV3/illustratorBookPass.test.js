/**
 * runNativeIllustrator orchestration — the A4 book-pass targeted regen wave.
 *
 * Regression (2026-07-16, book 72a496a9): the regen-path selectSpreadWinner
 * call passed a stale `photos:` param (dead since the cover-relative QA
 * rewiring) and omitted `referenceImages` — `...referenceImages` in the
 * likeness judge threw "referenceImages is not iterable", killing every
 * book whose book pass flagged a spread AFTER all 13 spreads were rendered
 * and QA'd. workflow.test.js mocks runNativeIllustrator entirely, so this
 * file exercises the REAL orchestration with its collaborators mocked.
 */

jest.mock('../../../services/bookPipelineV3/illustrator/render/referencePack', () => ({
  buildBookReferencePack: jest.fn(),
}));
jest.mock('../../../services/bookPipelineV3/illustrator/render/renderAllSpreads', () => ({
  renderAllSpreadsNative: jest.fn(),
  createLimiter: () => (fn) => fn(),
  candidatePath: (bookId, spread, idx) => `books/${bookId}/candidates/spread-${spread}-c${idx}.png`,
}));
jest.mock('../../../services/bookPipelineV3/illustrator/render/renderSpread', () => ({
  renderSpreadCandidates: jest.fn(),
  buildSpreadRenderPrompt: jest.fn(() => 'RENDER PROMPT'),
}));
jest.mock('../../../services/bookPipelineV3/illustrator/qa/select', () => ({
  selectSpreadWinner: jest.fn(),
  buildSpreadQaNeedsReview: jest.fn(() => ({})),
}));
jest.mock('../../../services/bookPipelineV3/illustrator/artDirection/artDirector', () => ({
  runArtDirection: jest.fn(),
  restageSpread: jest.fn(),
}));
jest.mock('../../../services/bookPipelineV3/illustrator/artDirection/worldPlates', () => ({
  renderWorldPlates: jest.fn(async () => new Map()),
}));
jest.mock('../../../services/bookPipelineV3/illustrator/bookPass/contactSheet', () => ({
  runBookPass: jest.fn(),
  buildBookPassNeedsReview: jest.fn(() => ({ stage: 'bookPass' })),
}));
jest.mock('../../../services/gcsStorage', () => ({
  uploadBuffer: jest.fn(async () => {}),
  getSignedUrl: jest.fn(async (p) => `https://signed.test/${p}`),
}));
jest.mock('../../../services/illustrationGenerator', () => ({
  downloadPhotoAsBase64: jest.fn(async () => ({ base64: 'COVER', mimeType: 'image/jpeg' })),
}));

const { buildBookReferencePack } = require('../../../services/bookPipelineV3/illustrator/render/referencePack');
const { renderAllSpreadsNative } = require('../../../services/bookPipelineV3/illustrator/render/renderAllSpreads');
const { renderSpreadCandidates } = require('../../../services/bookPipelineV3/illustrator/render/renderSpread');
const { selectSpreadWinner } = require('../../../services/bookPipelineV3/illustrator/qa/select');
const { runArtDirection, restageSpread } = require('../../../services/bookPipelineV3/illustrator/artDirection/artDirector');
const { runBookPass } = require('../../../services/bookPipelineV3/illustrator/bookPass/contactSheet');
const { runNativeIllustrator } = require('../../../services/bookPipelineV3/illustrator');

const BOOK_PACK = [
  { base64: 'SHEET', mimeType: 'image/png', note: 'MODEL SHEET' },
  { base64: 'COVER', mimeType: 'image/jpeg', note: 'APPROVED COVER' },
];

const SPREADS = [1, 2, 3].map((n) => ({
  spread: n,
  text: `Spread ${n} text.`,
  lines: [`Spread ${n} text.`],
  scene_contract: {
    setting: 'riverbank',
    characters_present: ['Amit'],
    hero_action: `action ${n}`,
    emotion: 'brave',
  },
}));

const MANUSCRIPT = { title: 'Roaring River', spreads: SPREADS };

function makeInput() {
  return {
    identityKit: { brief: { briefText: 'LIKENESS BRIEF' }, fromCache: true, photos: [] },
    rawRequest: { bookId: 'bk-1', child: { name: 'Amit', age: 8 } },
    brief: { child: { name: 'Amit', age: 8 } },
    ageProfile: { ageBand: 'PB_EARLY_READER' },
    concept: { logline: 'A river quest.' },
    manuscript: MANUSCRIPT,
    coverImageUrl: null,
    coverTitle: 'Roaring River',
    operationalContext: {},
    allowBounce: true,
  };
}

const ctx = { bookId: 'bk-1', log: jest.fn(), reportProgress: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();

  buildBookReferencePack.mockResolvedValue(BOOK_PACK);
  runArtDirection.mockResolvedValue({
    directionBySpread: new Map(SPREADS.map((s) => [s.spread, { shot: 'medium' }])),
    worldPlates: [],
    bounces: [],
    shotBudget: { reassigned: false },
    paletteArc: 'warm',
    continuityLocks: { props: [] },
  });
  renderAllSpreadsNative.mockImplementation(async ({ spreads }) => spreads.map((s) => ({
    spread: s.spread,
    candidates: [1, 2].map((i) => ({
      path: `books/bk-1/candidates/spread-${s.spread}-c${i}.png`,
      base64: `img-${s.spread}-${i}`,
      mimeType: 'image/png',
      candidateIndex: i,
    })),
  })));
  // Default: pick the first candidate offered.
  selectSpreadWinner.mockImplementation(async ({ candidates }) => ({
    selected: { candidateIndex: candidates[0].candidateIndex, path: candidates[0].path, pass: true, stage: 'passed', likeness: 5, defects: [], spreadScores: null },
    evaluations: [],
    repairWaves: 0,
    allCandidates: candidates,
  }));
  renderSpreadCandidates.mockResolvedValue([
    { buffer: Buffer.from('fresh-a'), mimeType: 'image/png' },
    { buffer: Buffer.from('fresh-b'), mimeType: 'image/png' },
  ]);
});

function bookPassResult({ criticalFlags = [], minorFlags = [], notes = '' } = {}) {
  return {
    pass: criticalFlags.length === 0,
    flags: [...criticalFlags, ...minorFlags],
    criticalFlags,
    minorFlags,
    notes,
  };
}

describe('runNativeIllustrator — book-pass targeted regen wave', () => {
  test('a flagged spread regenerates with the SAME likeness references as the main QA pass (no stale photos param)', async () => {
    runBookPass
      .mockResolvedValueOnce(bookPassResult({ criticalFlags: [{ spread: 2, issue: 'wrong version of the treasure map', severity: 'critical' }], notes: 'prop break' }))
      .mockResolvedValueOnce(bookPassResult({ notes: 'fixed' }));

    const doc = await runNativeIllustrator({ ...makeInput(), textLayout: 'embedded' }, ctx);

    // 3 main QA calls + 1 regen call for the flagged spread.
    expect(selectSpreadWinner).toHaveBeenCalledTimes(4);
    const regenArgs = selectSpreadWinner.mock.calls[3][0];
    expect(regenArgs.spread.spread).toBe(2);

    // THE regression pin: the regen call must carry iterable likeness refs
    // (the bookPack), exactly like the main QA call — and no dead `photos`.
    expect(Array.isArray(regenArgs.referenceImages)).toBe(true);
    expect(regenArgs.referenceImages).toBe(BOOK_PACK);
    expect(regenArgs).not.toHaveProperty('photos');
    const mainArgs = selectSpreadWinner.mock.calls.find((c) => c[0].spread.spread === 2)[0];
    expect(regenArgs.referenceImages).toEqual(mainArgs.referenceImages);

    // The regen rerun keeps the book's text layout — a repair wave inside
    // selectSpreadWinner must re-render at the embedded (wide) aspect, not
    // fall back to caption/square.
    expect(regenArgs.textLayout).toBe('embedded');
    expect(renderSpreadCandidates.mock.calls[0][0].textLayout).toBe('embedded');

    // The flag's issue is fed into the regen render as a fix instruction —
    // and a non-style flag gets no style repair template.
    expect(regenArgs.spread.scene_contract.continuity_notes)
      .toContain('BOOK-PASS FIX REQUIRED: wrong version of the treasure map');
    expect(regenArgs.spread.scene_contract.continuity_notes).not.toContain('CRITICAL REPAIR');
    expect(renderSpreadCandidates).toHaveBeenCalledTimes(1);

    // The regen winner replaces the flagged spread; every spread ships.
    expect(doc.spreads).toHaveLength(3);
    for (const s of doc.spreads) {
      expect(s.illustration).toBeTruthy();
      expect(s.illustration.imageStorageKey).toBeTruthy();
    }
    // Fresh candidates continue the index sequence (originals were 1-2).
    const spread2 = doc.spreads.find((s) => s.spreadNumber === 2);
    expect(spread2.illustration.candidateIndex).toBe(3);
  });

  // 2026-07-18 (book 6e018c20): "Jarring style break" survived the regen wave
  // because the raw judge prose gave the renderer no concrete target. Style
  // flags now append the cover-style CRITICAL REPAIR template, and world
  // plates render anchored on the book pack so a plate can't seed the drift.
  test('a style-break flag adds the cover-style repair template; plates render style-anchored', async () => {
    const { renderWorldPlates } = require('../../../services/bookPipelineV3/illustrator/artDirection/worldPlates');
    runBookPass
      .mockResolvedValueOnce(bookPassResult({
        criticalFlags: [{ spread: 2, issue: 'Jarring style break. The rendering style (flat, desaturated colors, thin lines) is inconsistent with the cover.', severity: 'critical' }],
        notes: 'style break',
      }))
      .mockResolvedValueOnce(bookPassResult({ notes: 'fixed' }));

    await runNativeIllustrator(makeInput(), ctx);

    const regenArgs = selectSpreadWinner.mock.calls[3][0];
    const notes = regenArgs.spread.scene_contract.continuity_notes;
    expect(notes).toContain('BOOK-PASS FIX REQUIRED: Jarring style break');
    expect(notes).toContain("CRITICAL REPAIR: match the APPROVED COVER reference's rendering style EXACTLY");
    expect(notes).toContain('NOT a flat 2D illustration, NOT painterly/watercolor/line-art, NOT desaturated');

    // G1: plates are style-anchored on the book pack (sheet + cover).
    expect(renderWorldPlates).toHaveBeenCalledWith(expect.objectContaining({ styleReferences: BOOK_PACK }));
  });

  test('a clean book pass never enters the regen path', async () => {
    runBookPass.mockResolvedValue(bookPassResult({ notes: 'lovely' }));

    const doc = await runNativeIllustrator(makeInput(), ctx);

    expect(selectSpreadWinner).toHaveBeenCalledTimes(3);
    expect(renderSpreadCandidates).not.toHaveBeenCalled();
    expect(doc.spreads.every((s) => s.illustration)).toBe(true);
  });

  test('CRITICAL flags surviving the regen wave become needs_review (never a crash, never ship-anyway)', async () => {
    runBookPass.mockResolvedValue(bookPassResult({ criticalFlags: [{ spread: 3, issue: 'style break', severity: 'critical' }], notes: 'still off' }));

    await expect(runNativeIllustrator(makeInput(), ctx))
      .rejects.toThrow(/book pass still flags 1 spread/);
  });

  // Closed critical gate (2026-07-16): minor flags never regen and never
  // block — the book SHIPS with the observations recorded as advisories
  // (doc.qaAdvisories → completion callback → admin can regen-spread later).
  test('minor-only book-pass flags ship immediately with qaAdvisories on the document', async () => {
    runBookPass.mockResolvedValue(bookPassResult({
      minorFlags: [
        { spread: 3, issue: 'map drawn differently than the cover', severity: 'minor' },
        { spread: 7, issue: 'simple wavy-line map', severity: 'minor' },
      ],
      notes: 'prop nitpicks only',
    }));

    const doc = await runNativeIllustrator(makeInput(), ctx);

    expect(runBookPass).toHaveBeenCalledTimes(1); // pass on wave 0 — no regen wave
    expect(renderSpreadCandidates).not.toHaveBeenCalled();
    expect(doc.qaAdvisories).toEqual([
      { stage: 'bookPass', spread: 3, note: 'map drawn differently than the cover' },
      { stage: 'bookPass', spread: 7, note: 'simple wavy-line map' },
    ]);
    expect(doc.spreads.every((s) => s.illustration)).toBe(true);
  });

  // Spread recovery ladder (2026-07-17): one unlucky page must not kill the
  // book — an exhausted spread gets a restaged scene + one fresh full round
  // before needs_review.
  describe('spread recovery ladder', () => {
    const failedRound = (spreadNumber, candidates) => ({
      selected: null,
      evaluations: [
        { candidateIndex: 1, path: candidates[0].path, pass: false, stage: 'spreadJudge', defects: ['the contracted action is entirely absent'] },
        { candidateIndex: 2, path: candidates[1].path, pass: false, stage: 'likeness', defects: ['hair color drifted blonde'] },
      ],
      repairWaves: 1,
      allCandidates: candidates,
    });

    beforeEach(() => {
      runBookPass.mockResolvedValue(bookPassResult({ notes: 'clean' }));
      restageSpread.mockResolvedValue({ moment: 'kneeling beside the pedestal, gem cupped in both hands', poseHint: 'whole-hand cradle', continuityNotes: null });
    });

    test('an exhausted spread is restaged and recovered on the fresh round', async () => {
      // Spread 2 fails its first round; every other call (including the
      // recovery round) picks the first candidate offered.
      let spread2Rounds = 0;
      selectSpreadWinner.mockImplementation(async ({ spread, candidates }) => {
        if (spread.spread === 2 && spread2Rounds === 0) {
          spread2Rounds += 1;
          return failedRound(2, candidates);
        }
        return {
          selected: { candidateIndex: candidates[0].candidateIndex, path: candidates[0].path, pass: true, stage: 'passed', likeness: 5, defects: [], spreadScores: null },
          evaluations: [],
          repairWaves: 0,
          allCandidates: candidates,
        };
      });

      const doc = await runNativeIllustrator({ ...makeInput(), textLayout: 'embedded' }, ctx);

      // Restage got the accumulated defects from the failed round.
      expect(restageSpread).toHaveBeenCalledTimes(1);
      const restageArgs = restageSpread.mock.calls[0][0];
      expect(restageArgs.spread.spread).toBe(2);
      expect(restageArgs.defects).toEqual(expect.arrayContaining(['the contracted action is entirely absent', 'hair color drifted blonde']));

      // The recovery round rendered fresh candidates and judged them under
      // the RESTAGED direction with continued candidate indices.
      expect(renderSpreadCandidates).toHaveBeenCalledTimes(1);
      const recoveryCall = selectSpreadWinner.mock.calls.find((c) => c[0].spread.spread === 2 && c[0].candidates[0].candidateIndex === 3);
      expect(recoveryCall).toBeDefined();
      expect(recoveryCall[0].direction.moment).toBe('kneeling beside the pedestal, gem cupped in both hands');
      expect(recoveryCall[0].direction.continuityNotes).toContain('RESTAGED after QA exhaustion');
      expect(recoveryCall[0].referenceImages).toBe(BOOK_PACK);
      // The recovery rerun keeps the book's text layout (embedded books
      // must not fall back to caption/square in a repair wave).
      expect(recoveryCall[0].textLayout).toBe('embedded');
      expect(renderSpreadCandidates.mock.calls[0][0].textLayout).toBe('embedded');

      // The book completes with every spread illustrated.
      expect(doc.spreads.every((s) => s.illustration)).toBe(true);
      expect(doc.spreads.find((s) => s.spreadNumber === 2).illustration.candidateIndex).toBe(3);
    });

    test('a spread that fails the recovery round too goes to needs_review with MERGED candidates', async () => {
      selectSpreadWinner.mockImplementation(async ({ spread, candidates }) => {
        if (spread.spread === 2) return failedRound(2, candidates);
        return {
          selected: { candidateIndex: candidates[0].candidateIndex, path: candidates[0].path, pass: true, stage: 'passed', likeness: 5, defects: [], spreadScores: null },
          evaluations: [],
          repairWaves: 0,
          allCandidates: candidates,
        };
      });

      await expect(runNativeIllustrator(makeInput(), ctx)).rejects.toThrow(/1 spread\(s\) exhausted the QA budget/);
      expect(restageSpread).toHaveBeenCalledTimes(1);
      expect(renderSpreadCandidates).toHaveBeenCalledTimes(1); // recovery round ran before giving up
    });

    test('a restage failure does not abort recovery — the fresh round still runs', async () => {
      restageSpread.mockRejectedValue(new Error('art director timeout'));
      let spread2Rounds = 0;
      selectSpreadWinner.mockImplementation(async ({ spread, candidates }) => {
        if (spread.spread === 2 && spread2Rounds === 0) {
          spread2Rounds += 1;
          return failedRound(2, candidates);
        }
        return {
          selected: { candidateIndex: candidates[0].candidateIndex, path: candidates[0].path, pass: true, stage: 'passed', likeness: 5, defects: [], spreadScores: null },
          evaluations: [],
          repairWaves: 0,
          allCandidates: candidates,
        };
      });

      const doc = await runNativeIllustrator(makeInput(), ctx);
      expect(doc.spreads.every((s) => s.illustration)).toBe(true);
    });
  });

  test("winners' minor spread-judge defects aggregate into qaAdvisories", async () => {
    selectSpreadWinner.mockImplementation(async ({ candidates, spread }) => ({
      selected: {
        candidateIndex: candidates[0].candidateIndex,
        path: candidates[0].path,
        pass: true,
        stage: 'passed',
        likeness: 5,
        defects: [],
        minorDefects: spread.spread === 2 ? ['hands slightly stiff on the paddle'] : [],
        spreadScores: null,
      },
      evaluations: [],
      repairWaves: 0,
      allCandidates: candidates,
    }));
    runBookPass.mockResolvedValue(bookPassResult({ notes: 'clean' }));

    const doc = await runNativeIllustrator(makeInput(), ctx);

    expect(doc.qaAdvisories).toEqual([
      { stage: 'spreadQa', spread: 2, note: 'hands slightly stiff on the paddle' },
    ]);
  });
});
