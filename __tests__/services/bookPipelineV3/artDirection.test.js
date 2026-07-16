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
const { runBookPass, buildContactSheetPrompt, buildBookPassNeedsReview } = require('../../../services/bookPipelineV3/illustrator/bookPass/contactSheet');

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

  test("the hero's REAL age drives the bounce criteria (an 11-year-old is not a preschooler)", async () => {
    callVisionRole.mockResolvedValueOnce({ json: goodPlan, model: 'm', family: 'gemini' });
    await runArtDirection({ manuscript: MS, ageBand: 'PB_EARLY_READER', ageYears: 11, referenceImages: [], log: () => {} });
    const [, params] = callVisionRole.mock.calls[0];
    expect(params.prompt).toContain('a 11-year-old child');
    expect(params.prompt).toContain("Judge feasibility and safety against the hero's ACTUAL age");
  });

  test('falls back to the band label when the age is unknown', async () => {
    callVisionRole.mockResolvedValueOnce({ json: goodPlan, model: 'm', family: 'gemini' });
    await runArtDirection({ manuscript: MS, ageBand: 'PB_TODDLER', referenceImages: [], log: () => {} });
    expect(callVisionRole.mock.calls[0][1].prompt).toContain('an PB_TODDLER child');
  });

  test('art direction runs deterministic (temperature 0) so passes never disagree by sampling', async () => {
    callVisionRole.mockResolvedValueOnce({ json: goodPlan, model: 'm', family: 'gemini' });
    await runArtDirection({ manuscript: MS, ageBand: 'PB_TODDLER', referenceImages: [], log: () => {} });
    expect(callVisionRole.mock.calls[0][1].temperature).toBe(0);
  });

  test('the plan schema requests a paintable MOMENT + poseHint, and finalize carries them per spread', async () => {
    const planWithMoments = {
      ...goodPlan,
      spreads: goodPlan.spreads.map((r) => (r.spread === 2
        ? { ...r, moment: 'both hands on the closed lid, braced to lift', poseHint: 'whole-hand grip' }
        : r)),
    };
    callVisionRole.mockResolvedValueOnce({ json: planWithMoments, model: 'm', family: 'gemini' });
    const res = await runArtDirection({ manuscript: MS, ageBand: 'PB_TODDLER', referenceImages: [], log: () => {} });
    expect(callVisionRole.mock.calls[0][1].prompt).toContain('"moment"');
    expect(callVisionRole.mock.calls[0][1].prompt).toContain('single freeze-frame');
    expect(res.directionBySpread.get(2).moment).toBe('both hands on the closed lid, braced to lift');
    expect(res.directionBySpread.get(2).poseHint).toBe('whole-hand grip');
    expect(res.directionBySpread.get(1).moment).toBeNull();
  });

  // 2026-07-16 (book f7191348): moments like "boot in mid-tap, connecting"
  // and "stone just leaving the foot" are unpaintable motion physics — the
  // renderer can't hit them and the judge fails literally. The moment must
  // be a HOLDABLE pose, and 3+-prop mechanisms must be staged down to the
  // 1-2 props that carry the action (or bounced as prop soup).
  test('the moment must be HOLDABLE (no split-second motion phases) and prop mechanisms are staged, not enumerated', async () => {
    callVisionRole.mockResolvedValueOnce({ json: goodPlan, model: 'm', family: 'gemini' });
    await runArtDirection({ manuscript: MS, ageBand: 'PB_TODDLER', referenceImages: [], log: () => {} });
    const prompt = callVisionRole.mock.calls[0][1].prompt;
    expect(prompt).toContain('HOLDABLE — something the child could hold for a photograph');
    expect(prompt).toContain("NEVER a split-second motion phase ('mid-tap', 'mid-air', 'just leaving the foot', 'mid-bounce')");
    expect(prompt).toContain('a still image cannot prove motion');
    expect(prompt).toContain('PROP MECHANISMS');
    expect(prompt).toContain('foreground ONE clear mechanical interaction');
    expect(prompt).toContain('bounce it as prop soup');
  });

  // 2026-07-16 (book 5792dc26): the moment named map locations ("from the
  // waterfall mark toward the moon cave mark") — the renderer painted the
  // names ("MOON CAVE", "Waterfall", "Summit") and D5 hard-failed both
  // candidates. Labels must be referenced by symbol, never by name.
  test('written labels are never referenced by name in moment/poseHint/continuityNotes', async () => {
    callVisionRole.mockResolvedValueOnce({ json: goodPlan, model: 'm', family: 'gemini' });
    await runArtDirection({ manuscript: MS, ageBand: 'PB_TODDLER', referenceImages: [], log: () => {} });
    const prompt = callVisionRole.mock.calls[0][1].prompt;
    expect(prompt).toContain('WRITTEN LABELS');
    expect(prompt).toContain('never reference map locations, signs, or any written label BY NAME');
    expect(prompt).toContain('lettering is an automatic QA kill');
  });

  // 2026-07-16 (book 8e6c23e0): moments like "his LEFT hand raised, holding
  // a vine aside" and "ONE hand holding his compass just over the open side
  // pocket" got enforced literally — renders mirror hands freely, so handed
  // or counted choreography is an unwinnable QA target.
  test('moments never specify handedness, hand count, or prop-relative positions', async () => {
    callVisionRole.mockResolvedValueOnce({ json: goodPlan, model: 'm', family: 'gemini' });
    await runArtDirection({ manuscript: MS, ageBand: 'PB_TODDLER', referenceImages: [], log: () => {} });
    const prompt = callVisionRole.mock.calls[0][1].prompt;
    expect(prompt).toContain('NO CHOREOGRAPHY');
    expect(prompt).toContain('never specify WHICH hand (left/right), how many hands');
    expect(prompt).toContain('renderers mirror hands freely');
    expect(prompt).toContain("Describe the action at the level a parent would");
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

  // Book audit 2026-07-16: per-spread QA can't see cross-spread drift — the
  // whole-book review is the only stage that can, so its checklist must name
  // age/build drift and stray facial marks explicitly.
  test('contact-sheet checklist covers character drift (age/build + stray facial marks)', () => {
    const p = buildContactSheetPrompt({ manuscript: MS, direction });
    expect(p).toContain('CHARACTER DRIFT');
    expect(p).toContain('SAME apparent age and build on every spread');
    expect(p).toContain('younger/chubbier or older/slimmer');
    expect(p).toContain('stray moles, beauty marks, or dark facial spots');
  });
});
