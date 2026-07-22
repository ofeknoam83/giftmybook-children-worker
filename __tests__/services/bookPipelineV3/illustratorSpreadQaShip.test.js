/**
 * runNativeIllustrator — spreadQa ship-on-exhaustion (2026-07-22, book
 * 497c8b68 embedded rerun). With BOOK_PASS_SHIP_ON_EXHAUSTION set, a spread
 * that exhausts its per-spread QA budget (incl. the restage/recovery round)
 * must NOT dead-end the book on needs_review at spreadQa. Instead the least-bad
 * candidate ships, the book completes (all spreads illustrated), and the
 * residual issues ride doc.qaAdvisories + doc.bookPassReview (→ needsReview on
 * the completion callback) so the book is flagged for admin review.
 *
 * The env must be truthy BEFORE illustrator/config is first required (its
 * BOOK_PASS_SHIP_ON_EXHAUSTION constant is evaluated at module load), so this
 * lives in its own file with the assignment at the very top.
 */

const ORIGINAL_SHIP_ENV = process.env.BOOK_PASS_SHIP_ON_EXHAUSTION;
process.env.BOOK_PASS_SHIP_ON_EXHAUSTION = '1';
// Restore so this file's env mutation can't leak into another test file that
// shares the jest worker (illustratorBookPass / illustratorConfig assert the
// default-OFF behavior).
afterAll(() => {
  if (ORIGINAL_SHIP_ENV === undefined) delete process.env.BOOK_PASS_SHIP_ON_EXHAUSTION;
  else process.env.BOOK_PASS_SHIP_ON_EXHAUSTION = ORIGINAL_SHIP_ENV;
});

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
  buildSpreadQaNeedsReview: jest.fn((failures) => ({
    version: 1,
    stage: 'spreadQa',
    reason: 'spread_qa_exhausted',
    spread: failures[0]?.spread ?? null,
    defects: failures.flatMap((f) => (f.evaluations || []).map((e) => `spread ${f.spread} c${e.candidateIndex}: ${e.defects?.[0] || 'below threshold'}`)),
    candidateUrls: [],
    judgeScores: {},
  })),
  pickLeastBad: jest.fn((evals) => (Array.isArray(evals) && evals.length ? evals[0] : null)),
}));
jest.mock('../../../services/bookPipelineV3/illustrator/artDirection/artDirector', () => ({
  runArtDirection: jest.fn(),
  restageSpread: jest.fn(),
}));
jest.mock('../../../services/bookPipelineV3/illustrator/artDirection/worldPlates', () => ({
  renderWorldPlates: jest.fn(async () => new Map()),
}));
jest.mock('../../../services/bookPipelineV3/illustrator/artDirection/propPlate', () => ({
  renderPropPlate: jest.fn(async () => null),
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
  { base64: 'SHEET', mimeType: 'image/png', kind: 'sheet' },
  { base64: 'COVER', mimeType: 'image/jpeg', kind: 'cover' },
];

const SPREADS = [1, 2, 3].map((n) => ({
  spread: n,
  text: `Spread ${n} text.`,
  lines: [`Spread ${n} text.`],
  scene_contract: { setting: 'riverbank', characters_present: ['Amit'], hero_action: `action ${n}`, emotion: 'brave' },
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
    coverImageUrl: 'https://cover.test/c.png',
    coverTitle: 'Roaring River',
    operationalContext: {},
    allowBounce: true,
  };
}

const passSel = (candidates) => ({
  selected: { candidateIndex: candidates[0].candidateIndex, path: candidates[0].path, pass: true, stage: 'passed', likeness: 5, defects: [], spreadScores: null },
  evaluations: [],
  repairWaves: 0,
  allCandidates: candidates,
});

const failSel = (candidates) => ({
  selected: null,
  evaluations: candidates.map((c, i) => ({
    candidateIndex: c.candidateIndex,
    path: c.path,
    pass: false,
    stage: i === 0 ? 'spreadJudge' : 'likeness',
    defects: [i === 0 ? 'wrong setting' : 'freckles missing'],
    likeness: i === 0 ? null : 3,
  })),
  repairWaves: 1,
  allCandidates: candidates,
});

beforeEach(() => {
  jest.clearAllMocks();
  buildBookReferencePack.mockResolvedValue(BOOK_PACK);
  runArtDirection.mockResolvedValue({
    directionBySpread: new Map(SPREADS.map((s) => [s.spread, { shot: 'medium' }])),
    worldPlates: [], bounces: [], shotBudget: { reassigned: false }, paletteArc: 'warm', continuityLocks: { props: [] },
  });
  renderAllSpreadsNative.mockImplementation(async ({ spreads }) => spreads.map((s) => ({
    spread: s.spread,
    candidates: [1, 2].map((i) => ({ path: `books/bk-1/candidates/spread-${s.spread}-c${i}.png`, base64: `img-${s.spread}-${i}`, mimeType: 'image/png', candidateIndex: i })),
  })));
  renderSpreadCandidates.mockResolvedValue([
    { buffer: Buffer.from('fresh-a'), mimeType: 'image/png' },
    { buffer: Buffer.from('fresh-b'), mimeType: 'image/png' },
  ]);
  restageSpread.mockResolvedValue({ moment: null, poseHint: null, continuityNotes: null });
  runBookPass.mockResolvedValue({ pass: true, flags: [], criticalFlags: [], minorFlags: [], notes: 'clean' });
});

describe('runNativeIllustrator — spreadQa ship-on-exhaustion (embedded)', () => {
  test('a permanently-exhausted spread ships least-bad and the book completes + is flagged', async () => {
    // Spread 2 fails the main round AND the recovery round; the others pass.
    selectSpreadWinner.mockImplementation(async ({ spread, candidates }) => (
      spread.spread === 2 ? failSel(candidates) : passSel(candidates)
    ));

    const doc = await runNativeIllustrator({ ...makeInput(), textLayout: 'embedded' }, ctx());

    // Book COMPLETED — every spread illustrated, no throw.
    expect(doc.spreads).toHaveLength(3);
    expect(doc.spreads.every((s) => s.illustration && s.illustration.imageStorageKey)).toBe(true);

    // Spread 2 shipped its least-bad candidate (pickLeastBad → evals[0] = c1).
    const spread2 = doc.spreads.find((s) => s.spreadNumber === 2);
    expect(spread2.illustration.candidateIndex).toBe(1);

    // Residual flagged for admin review on the doc (server.js reads bookPassReview).
    expect(doc.bookPassReview).toBeTruthy();
    expect(doc.bookPassReview.stage).toBe('spreadQa');
    expect(doc.bookPassReview.shipped).toBe(true);

    // And surfaced as a spreadQa advisory naming the residual.
    const adv = doc.qaAdvisories.find((a) => a.stage === 'spreadQa' && a.spread === 2 && /UNRESOLVED \(shipped on spreadQa exhaustion\)/.test(a.note));
    expect(adv).toBeTruthy();

    // The recovery round still ran (restage + fresh render) before shipping.
    expect(restageSpread).toHaveBeenCalledTimes(1);
    expect(renderSpreadCandidates).toHaveBeenCalledTimes(1);
  });

  test('a fully clean book is unaffected by the env (no bookPassReview, no advisories)', async () => {
    selectSpreadWinner.mockImplementation(async ({ candidates }) => passSel(candidates));

    const doc = await runNativeIllustrator({ ...makeInput(), textLayout: 'embedded' }, ctx());

    expect(doc.spreads.every((s) => s.illustration)).toBe(true);
    expect(doc.bookPassReview).toBeUndefined();
    expect(doc.qaAdvisories).toEqual([]);
  });
});

function ctx() {
  return { bookId: 'bk-1', log: jest.fn(), reportProgress: jest.fn() };
}
