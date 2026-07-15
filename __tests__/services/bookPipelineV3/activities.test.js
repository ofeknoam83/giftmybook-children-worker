jest.mock('../../../services/bookPipelineV3/llm/modelRouter', () => ({
  callWithRole: jest.fn(),
  modelFor: jest.fn(() => ({ family: 'anthropic', model: 'claude-opus-4-8' })),
  JUDGE_ROLES: ['JUDGE_A', 'JUDGE_B', 'JUDGE_C'],
}));

const { callWithRole } = require('../../../services/bookPipelineV3/llm/modelRouter');
const { conceptRoomActivity, CONCEPT_ANGLES } = require('../../../services/bookPipelineV3/orchestration/activities/conceptRoom');
const { editorialSelectionActivity } = require('../../../services/bookPipelineV3/orchestration/activities/editorialSelection');
const { manuscriptWriterActivity, DRAFT_VARIANTS } = require('../../../services/bookPipelineV3/orchestration/activities/manuscriptWriter');
const { manuscriptRevisionActivity, mergeTargets } = require('../../../services/bookPipelineV3/orchestration/activities/manuscriptRevision');
const { normalizeManuscript } = require('../../../services/bookPipelineV3/schema/document');
const {
  PRESCHOOL_PROFILE, BRIEF, makeConceptJson, makeManuscriptJson, makeSpread,
} = require('./helpers/fixtures');

const ctx = { log: jest.fn(), bookId: 'b1' };

function resp(json) {
  return { json, usage: { inputTokens: 10, outputTokens: 5 }, model: 'test-model' };
}

beforeEach(() => {
  callWithRole.mockReset();
  ctx.log.mockClear();
});

describe('conceptRoom', () => {
  test('injects the assigned angle and normalizes the concept', async () => {
    callWithRole.mockResolvedValueOnce(resp(makeConceptJson('quiet_observational')));
    const angle = CONCEPT_ANGLES.find((a) => a.id === 'quiet_observational');
    const concept = await conceptRoomActivity(
      { brief: BRIEF, ageProfile: PRESCHOOL_PROFILE, theme: 'adventure', spreadCount: 13, angle }, ctx,
    );
    expect(concept.id).toBe('quiet_observational');
    expect(concept.form_choice).toBe('rhythmic_prose');
    const prompt = JSON.parse(callWithRole.mock.calls[0][1].userPrompt);
    expect(prompt.assigned_angle.id).toBe('quiet_observational');
    expect(prompt.assigned_angle.directive).toContain('quiet');
  });

  test('there are exactly 3 fixed angles', () => {
    expect(CONCEPT_ANGLES).toHaveLength(3);
    expect(new Set(CONCEPT_ANGLES.map((a) => a.id)).size).toBe(3);
  });

  test('invalid concept JSON throws with a precise message', async () => {
    callWithRole.mockResolvedValueOnce(resp({ id: 'x', form_choice: 'sonnet' }));
    await expect(conceptRoomActivity(
      { brief: BRIEF, ageProfile: PRESCHOOL_PROFILE, theme: 'adventure', spreadCount: 13, angle: CONCEPT_ANGLES[0] }, ctx,
    )).rejects.toThrow(/form_choice/);
  });
});

describe('editorialSelection', () => {
  const concepts = [makeConceptJson('a1'), makeConceptJson('a2'), makeConceptJson('a3')]
    .map((c, i) => ({ ...c, id: `a${i + 1}` }));

  test('parses winner + runner-up + grafts', async () => {
    callWithRole.mockResolvedValueOnce(resp({
      winner_id: 'a2', runner_up_id: 'a3', rationale: 'best voice',
      grafts: [{ from_concept: 'a1', element: 'the refrain', why: 'stronger hook' }],
      scores: { a1: { total: 6 }, a2: { total: 9 }, a3: { total: 7 } },
    }));
    const sel = await editorialSelectionActivity({ brief: BRIEF, ageProfile: PRESCHOOL_PROFILE, concepts }, ctx);
    expect(sel.winner_id).toBe('a2');
    expect(sel.runner_up_id).toBe('a3');
    expect(sel.grafts).toHaveLength(1);
  });

  test('rejects a winner_id not among the concepts', async () => {
    callWithRole.mockResolvedValueOnce(resp({ winner_id: 'nope', runner_up_id: 'a1' }));
    await expect(editorialSelectionActivity({ brief: BRIEF, ageProfile: PRESCHOOL_PROFILE, concepts }, ctx))
      .rejects.toThrow(/winner_id/);
  });

  test('repairs a runner_up_id that equals the winner', async () => {
    callWithRole.mockResolvedValueOnce(resp({ winner_id: 'a1', runner_up_id: 'a1' }));
    const sel = await editorialSelectionActivity({ brief: BRIEF, ageProfile: PRESCHOOL_PROFILE, concepts }, ctx);
    expect(sel.runner_up_id).not.toBe('a1');
  });
});

describe('manuscriptWriter', () => {
  test('normalizes spreads, validates scene contracts, threads the variant directive', async () => {
    callWithRole.mockResolvedValueOnce(resp(makeManuscriptJson(13)));
    const m = await manuscriptWriterActivity({
      brief: BRIEF, ageProfile: PRESCHOOL_PROFILE, concept: makeConceptJson('a1'),
      selection: { grafts: [] }, spreadCount: 13, variant: 'B',
    }, ctx);
    expect(m.id).toBe('B');
    expect(m.spreads).toHaveLength(13);
    expect(m.spreads[0].text).toContain('Zoe');
    const prompt = JSON.parse(callWithRole.mock.calls[0][1].userPrompt);
    expect(prompt.draft_variant).toBe(DRAFT_VARIANTS.B);
    expect(prompt.budget_preamble).toContain('WORD BUDGET');
  });

  test('wrong spread count throws', async () => {
    callWithRole.mockResolvedValueOnce(resp(makeManuscriptJson(11)));
    await expect(manuscriptWriterActivity({
      brief: BRIEF, ageProfile: PRESCHOOL_PROFILE, concept: makeConceptJson('a1'),
      spreadCount: 13, variant: 'A',
    }, ctx)).rejects.toThrow(/expected 13 spreads, got 11/);
  });

  test('missing scene_contract field throws naming the spread', async () => {
    const bad = makeManuscriptJson(2);
    delete bad.spreads[1].scene_contract.hero_action;
    callWithRole.mockResolvedValueOnce(resp(bad));
    await expect(manuscriptWriterActivity({
      brief: BRIEF, ageProfile: PRESCHOOL_PROFILE, concept: makeConceptJson('a1'),
      spreadCount: 2, variant: 'A',
    }, ctx)).rejects.toThrow(/spread 2.*hero_action/);
  });
});

describe('manuscriptRevision', () => {
  const manuscript = normalizeManuscript(makeManuscriptJson(4), { id: 'A', expectedSpreads: 4 });

  test('mergeTargets combines judge flags and gate failures per spread', () => {
    const targets = mergeTargets(
      [{ spread: 2, dimension: 'age_fit', issue: 'too long', suggestion: 'shorten', judge: 'JUDGE_A' }],
      [{ spread: 2, passed: false, failures: [{ code: 'word_budget', message: 'over budget' }] },
        { spread: 3, passed: false, failures: [{ code: 'pronoun_lock', message: 'wrong pronoun' }] },
        { spread: 4, passed: true, failures: [] }],
    );
    expect(targets.map((t) => t.spread)).toEqual([2, 3]);
    expect(targets[0].notes).toHaveLength(2);
  });

  test('merges only targeted rewrites back into the manuscript', async () => {
    const rewritten = { ...makeSpread(2) };
    rewritten.lines = ['Zoe finds a striped shell hidden in the cool wet sand today.', 'She holds it to her ear and hears the ocean sing her name.'];
    const offTarget = { ...makeSpread(4) };
    callWithRole.mockResolvedValueOnce(resp({ spreads: [rewritten, offTarget] }));
    const revised = await manuscriptRevisionActivity({
      brief: BRIEF, ageProfile: PRESCHOOL_PROFILE, manuscript,
      targets: [{ spread: 2, notes: ['fix it'] }],
    }, ctx);
    expect(revised.spreads.find((s) => s.spread === 2).lines[0]).toContain('striped shell');
    // Off-target rewrite of spread 4 is discarded.
    expect(revised.spreads.find((s) => s.spread === 4).lines[0]).toBe(manuscript.spreads[3].lines[0]);
  });

  test('throws when no returned spread matches a target', async () => {
    callWithRole.mockResolvedValueOnce(resp({ spreads: [makeSpread(4)] }));
    await expect(manuscriptRevisionActivity({
      brief: BRIEF, ageProfile: PRESCHOOL_PROFILE, manuscript,
      targets: [{ spread: 2, notes: ['fix'] }],
    }, ctx)).rejects.toThrow(/none of the returned spreads/);
  });

  // Art-director bounces set requireContractChange: the director stages
  // from scene_contract, so a lines-only rewrite is a failed revision.
  test('requireContractChange: an unchanged scene_contract triggers one harder re-ask', async () => {
    const stale = { ...makeSpread(2) }; // identical contract → stale
    const fixed = { ...makeSpread(2) };
    fixed.scene_contract = { ...fixed.scene_contract, setting: 'a dry cavern behind the falls', hero_action: 'follows the path into the dry cavern' };
    callWithRole
      .mockResolvedValueOnce(resp({ spreads: [stale] }))
      .mockResolvedValueOnce(resp({ spreads: [fixed] }));

    const revised = await manuscriptRevisionActivity({
      brief: BRIEF, ageProfile: PRESCHOOL_PROFILE, manuscript,
      targets: [{ spread: 2, notes: ['unstageable: behind the waterfall'], requireContractChange: true }],
    }, ctx);

    expect(callWithRole).toHaveBeenCalledTimes(2);
    expect(callWithRole.mock.calls[1][1].label).toBe('v3.revision.contractfix');
    expect(callWithRole.mock.calls[1][1].userPrompt).toContain('YOUR PREVIOUS REVISION FAILED');
    expect(revised.spreads.find((s) => s.spread === 2).scene_contract.setting).toContain('dry cavern');
  });

  test('requireContractChange: still-stale after the re-ask continues with a loud warning', async () => {
    const stale = { ...makeSpread(2) };
    callWithRole
      .mockResolvedValueOnce(resp({ spreads: [stale] }))
      .mockResolvedValueOnce(resp({ spreads: [stale] }));

    const revised = await manuscriptRevisionActivity({
      brief: BRIEF, ageProfile: PRESCHOOL_PROFILE, manuscript,
      targets: [{ spread: 2, notes: ['unstageable'], requireContractChange: true }],
    }, ctx);

    expect(revised.spreads).toHaveLength(4); // never bricks the book
    const warns = ctx.log.mock.calls.filter(([level]) => level === 'warn').map(([, msg]) => msg).join(' ');
    expect(warns).toMatch(/STILL unchanged/);
  });

  test('judge-path targets (no requireContractChange) never re-ask on an unchanged contract', async () => {
    const stale = { ...makeSpread(2) };
    callWithRole.mockResolvedValueOnce(resp({ spreads: [stale] }));
    await manuscriptRevisionActivity({
      brief: BRIEF, ageProfile: PRESCHOOL_PROFILE, manuscript,
      targets: [{ spread: 2, notes: ['craft: weak line'] }],
    }, ctx);
    expect(callWithRole).toHaveBeenCalledTimes(1);
  });
});
