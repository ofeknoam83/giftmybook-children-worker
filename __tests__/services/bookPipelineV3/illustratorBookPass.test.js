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
const { runArtDirection } = require('../../../services/bookPipelineV3/illustrator/artDirection/artDirector');
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
    ageProfile: { ageBand: 'PB_EARLY_ELEM' },
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

describe('runNativeIllustrator — book-pass targeted regen wave', () => {
  test('a flagged spread regenerates with the SAME likeness references as the main QA pass (no stale photos param)', async () => {
    runBookPass
      .mockResolvedValueOnce({ pass: false, flags: [{ spread: 2, issue: 'wrong version of the treasure map' }], notes: 'prop break' })
      .mockResolvedValueOnce({ pass: true, flags: [], notes: 'fixed' });

    const doc = await runNativeIllustrator(makeInput(), ctx);

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

    // The flag's issue is fed into the regen render as a fix instruction.
    expect(regenArgs.spread.scene_contract.continuity_notes)
      .toContain('BOOK-PASS FIX REQUIRED: wrong version of the treasure map');
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

  test('a clean book pass never enters the regen path', async () => {
    runBookPass.mockResolvedValue({ pass: true, flags: [], notes: 'lovely' });

    const doc = await runNativeIllustrator(makeInput(), ctx);

    expect(selectSpreadWinner).toHaveBeenCalledTimes(3);
    expect(renderSpreadCandidates).not.toHaveBeenCalled();
    expect(doc.spreads.every((s) => s.illustration)).toBe(true);
  });

  test('flags surviving the regen wave become needs_review (never a crash, never ship-anyway)', async () => {
    runBookPass.mockResolvedValue({ pass: false, flags: [{ spread: 3, issue: 'style break' }], notes: 'still off' });

    await expect(runNativeIllustrator(makeInput(), ctx))
      .rejects.toThrow(/book pass still flags 1 spread/);
  });
});
