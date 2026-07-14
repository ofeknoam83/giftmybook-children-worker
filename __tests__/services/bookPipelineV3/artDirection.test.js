/**
 * Art direction (W7/W8) + book pass (W9):
 *   - shotBudget: validation rules + deterministic reassignment invariants
 *   - artDirector: re-ask on violation, deterministic repair after re-ask,
 *     bounce passthrough, every spread gets a direction row
 *   - contact sheet: flag parsing + needs_review payload
 */

jest.mock('../../../services/bookPipelineV3/llm/visionClient', () => ({
  callVisionRole: jest.fn(),
}));

const { callVisionRole } = require('../../../services/bookPipelineV3/llm/visionClient');
const {
  validateShotBudget, reassignShots, normalizeShot, MIN_DISTINCT_SHOTS,
} = require('../../../services/bookPipelineV3/illustrator/artDirection/shotBudget');
const { runArtDirection } = require('../../../services/bookPipelineV3/illustrator/artDirection/artDirector');
const { runBookPass, buildBookPassNeedsReview } = require('../../../services/bookPipelineV3/illustrator/bookPass/contactSheet');

const MS = {
  title: 'T',
  spreads: Array.from({ length: 13 }, (_, i) => ({
    spread: i + 1,
    scene_contract: { setting: i < 6 ? 'garden' : 'kitchen', characters_present: ['Zoe'], hero_action: 'a', emotion: 'e' },
  })),
};

const planRows = (shots) => shots.map((shot, i) => ({ spread: i + 1, shot, textZone: 'left-top', palette: 'warm' }));

beforeEach(() => jest.clearAllMocks());

describe('shotBudget', () => {
  test('flags adjacent repeats and insufficient variety', () => {
    const allMedium = validateShotBudget(planRows(Array(13).fill('medium')));
    expect(allMedium.ok).toBe(false);
    expect(allMedium.violations.join(' ')).toMatch(/adjacent/);
    expect(allMedium.violations.join(' ')).toMatch(/distinct shot types/);
  });

  test('accepts a varied plan', () => {
    const shots = ['wide-establishing', 'medium', 'close-up', 'birds-eye', 'medium', 'low-angle', 'close-up', 'over-shoulder', 'medium', 'detail-insert', 'wide-establishing', 'close-up', 'medium'];
    expect(validateShotBudget(planRows(shots)).ok).toBe(true);
  });

  test('normalizeShot maps loose labels onto the enum', () => {
    expect(normalizeShot('Wide establishing shot')).toBe('wide-establishing');
    expect(normalizeShot('overhead view')).toBe('birds-eye');
    expect(normalizeShot('extreme close up')).toBe('close-up');
    expect(normalizeShot('???')).toBeNull();
  });

  test('reassignShots always produces a valid budget (deterministic)', () => {
    const bad = planRows(Array(13).fill('medium'));
    const fixed1 = reassignShots(bad);
    const fixed2 = reassignShots(bad);
    expect(fixed1).toEqual(fixed2); // stable
    const check = validateShotBudget(fixed1);
    expect(check.ok).toBe(true);
    expect(new Set(fixed1.map((r) => r.shot)).size).toBeGreaterThanOrEqual(MIN_DISTINCT_SHOTS);
  });
});

describe('runArtDirection', () => {
  const goodPlan = {
    spreads: planRows(['wide-establishing', 'medium', 'close-up', 'birds-eye', 'medium', 'low-angle', 'close-up', 'over-shoulder', 'medium', 'detail-insert', 'wide-establishing', 'close-up', 'medium']),
    paletteArc: { act1: 'morning gold' },
    continuityLocks: { outfit: 'from cover', props: [] },
    worldPlates: [{ location: 'garden', spreads: [1, 2, 3, 4, 5, 6] }],
    bounces: [],
  };

  test('valid plan on first call: no re-ask, all spreads covered', async () => {
    callVisionRole.mockResolvedValueOnce({ json: goodPlan, model: 'm', family: 'gemini' });
    const res = await runArtDirection({ manuscript: MS, ageBand: 'PB_TODDLER', referenceImages: [], log: () => {} });
    expect(callVisionRole).toHaveBeenCalledTimes(1);
    expect(res.shotBudget).toEqual({ ok: true, reassigned: false });
    expect(res.directionBySpread.size).toBe(13);
    expect(res.worldPlates).toHaveLength(1);
  });

  test('violating plan: one re-ask naming violations, then deterministic repair', async () => {
    const badPlan = { ...goodPlan, spreads: planRows(Array(13).fill('medium')) };
    callVisionRole
      .mockResolvedValueOnce({ json: badPlan, model: 'm', family: 'gemini' })
      .mockResolvedValueOnce({ json: badPlan, model: 'm', family: 'gemini' });
    const res = await runArtDirection({ manuscript: MS, ageBand: 'PB_TODDLER', referenceImages: [], log: () => {} });
    expect(callVisionRole).toHaveBeenCalledTimes(2);
    // the re-ask prompt names the violations
    expect(callVisionRole.mock.calls[1][1].prompt).toMatch(/VIOLATED THE SHOT BUDGET/);
    expect(res.shotBudget.reassigned).toBe(true);
    const shots = [...res.directionBySpread.values()].map((d) => d.shot);
    expect(new Set(shots).size).toBeGreaterThanOrEqual(MIN_DISTINCT_SHOTS);
  });

  test('bounces pass through for the workflow to route to the writer', async () => {
    const bouncePlan = { ...goodPlan, bounces: [{ spread: 4, problem: 'infant cannot sprint', suggestion: 'crawls instead' }] };
    callVisionRole.mockResolvedValueOnce({ json: bouncePlan, model: 'm', family: 'gemini' });
    const res = await runArtDirection({ manuscript: MS, ageBand: 'PB_INFANT', referenceImages: [], log: () => {} });
    expect(res.bounces).toHaveLength(1);
    expect(res.bounces[0].spread).toBe(4);
  });
});

describe('book pass', () => {
  const direction = { directionBySpread: new Map([[1, { shot: 'medium' }]]), continuityLocks: { props: [{ name: 'red can' }] } };
  const winners = [{ spread: 1, base64: 'w1' }];

  test('clean pass', async () => {
    callVisionRole.mockResolvedValueOnce({ json: { pass: true, flags: [], notes: 'lovely' }, model: 'm', family: 'gemini' });
    const res = await runBookPass({ manuscript: MS, direction, winners, log: () => {} });
    expect(res.pass).toBe(true);
  });

  test('flags parsed and needs_review payload built', async () => {
    callVisionRole.mockResolvedValueOnce({
      json: { pass: false, flags: [{ spread: 5, issue: 'outfit color differs from cover' }], notes: 'continuity break' },
      model: 'm',
      family: 'gemini',
    });
    const res = await runBookPass({ manuscript: MS, direction, winners, log: () => {} });
    expect(res.pass).toBe(false);
    expect(res.flags).toEqual([{ spread: 5, issue: 'outfit color differs from cover' }]);

    const payload = buildBookPassNeedsReview(res.flags, ['u1']);
    expect(payload.stage).toBe('bookPass');
    expect(payload.reason).toBe('book_pass_exhausted');
    expect(payload.defects[0]).toBe('spread 5: outfit color differs from cover');
  });
});
