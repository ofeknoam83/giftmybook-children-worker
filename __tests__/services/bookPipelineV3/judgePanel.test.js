jest.mock('../../../services/bookPipelineV3/llm/modelRouter', () => ({
  callWithRole: jest.fn(),
  modelFor: jest.fn((role) => ({
    family: { JUDGE_A: 'anthropic', JUDGE_B: 'openai', JUDGE_C: 'gemini' }[role] || 'anthropic',
    model: { JUDGE_A: 'claude-opus-4-8', JUDGE_B: 'gpt-5.4', JUDGE_C: 'gemini-2.5-pro' }[role] || 'claude-opus-4-8',
  })),
  JUDGE_ROLES: ['JUDGE_A', 'JUDGE_B', 'JUDGE_C'],
}));

const { callWithRole } = require('../../../services/bookPipelineV3/llm/modelRouter');
const {
  judgePanelActivity, aggregateReports, blindManuscript, median, PANEL_PASS_MEDIAN,
} = require('../../../services/bookPipelineV3/orchestration/activities/judgePanel');
const { normalizeManuscript, normalizeJudgeReport } = require('../../../services/bookPipelineV3/schema/document');
const { PRESCHOOL_PROFILE, BRIEF, makeManuscriptJson, makeJudgeReportJson } = require('./helpers/fixtures');

const ctx = { log: jest.fn(), bookId: 'b1' };

function twoManuscripts() {
  return [
    normalizeManuscript(makeManuscriptJson(3), { id: 'A', expectedSpreads: 3 }),
    normalizeManuscript(makeManuscriptJson(3), { id: 'B', expectedSpreads: 3 }),
  ];
}

function judgeResp(json) {
  return { json, usage: { inputTokens: 10, outputTokens: 5 }, model: 'test-model' };
}

beforeEach(() => {
  callWithRole.mockReset();
  ctx.log.mockClear();
});

describe('median', () => {
  test('median of 3 defeats one outlier', () => {
    expect(median([5, 4, 1])).toBe(4);
  });
  test('median of 2 means both must clear the bar', () => {
    expect(median([5, 3])).toBe(4); // 4 passes — boundary
    expect(median([5, 2])).toBe(3.5); // one bad judge sinks it
  });
});

describe('blindManuscript', () => {
  test('strips authorship/provenance fields', () => {
    const [a] = twoManuscripts();
    a.model = 'claude-opus-4-8';
    a.concept_id = 'secret';
    const blinded = blindManuscript(a, 'A');
    expect(blinded).not.toHaveProperty('model');
    expect(blinded).not.toHaveProperty('concept_id');
    expect(blinded.label).toBe('A');
    expect(blinded.spreads).toHaveLength(3);
  });
});

describe('judgePanelActivity', () => {
  test('3 clean judges → pass, winner by sum of medians, usage captured', async () => {
    callWithRole
      .mockResolvedValueOnce(judgeResp(makeJudgeReportJson(['A', 'B'], { score: 4 })))
      .mockResolvedValueOnce(judgeResp(makeJudgeReportJson(['A', 'B'], { score: 5 })))
      .mockResolvedValueOnce(judgeResp(makeJudgeReportJson(['A', 'B'], { score: 4 })));
    const out = await judgePanelActivity({ brief: BRIEF, ageProfile: PRESCHOOL_PROFILE, manuscripts: twoManuscripts() }, ctx);
    expect(out.degraded).toBe(false);
    expect(out.perManuscript.A.pass).toBe(true);
    expect(out.perManuscript.A.medians.age_fit).toBe(4);
    expect(Object.keys(out.usageByJudge)).toHaveLength(3);
    expect(out.passMedian).toBe(PANEL_PASS_MEDIAN);
    // 8000, not 4000: gemini-2.5-pro truncated at 4000 on every observed run.
    expect(callWithRole.mock.calls[0][1].maxTokens).toBe(8000);
  });

  test('judges receive raw interests + story_world beside the brief ranking', async () => {
    callWithRole
      .mockResolvedValueOnce(judgeResp(makeJudgeReportJson(['A', 'B'], { score: 4 })))
      .mockResolvedValueOnce(judgeResp(makeJudgeReportJson(['A', 'B'], { score: 4 })))
      .mockResolvedValueOnce(judgeResp(makeJudgeReportJson(['A', 'B'], { score: 4 })));
    await judgePanelActivity({
      brief: { ...BRIEF, interests: ['space'], story_world: 'A backyard-astronomy world.' },
      ageProfile: PRESCHOOL_PROFILE,
      manuscripts: twoManuscripts(),
    }, ctx);
    const prompt = JSON.parse(callWithRole.mock.calls[0][1].userPrompt);
    expect(prompt.brief.interests).toEqual(['space']);
    expect(prompt.brief.story_world).toBe('A backyard-astronomy world.');
    // Old-shape brief (resumed checkpoint) still judges without throwing.
    callWithRole
      .mockResolvedValueOnce(judgeResp(makeJudgeReportJson(['A', 'B'], { score: 4 })))
      .mockResolvedValueOnce(judgeResp(makeJudgeReportJson(['A', 'B'], { score: 4 })))
      .mockResolvedValueOnce(judgeResp(makeJudgeReportJson(['A', 'B'], { score: 4 })));
    const out = await judgePanelActivity({ brief: BRIEF, ageProfile: PRESCHOOL_PROFILE, manuscripts: twoManuscripts() }, ctx);
    expect(out.perManuscript.A.pass).toBe(true);
  });

  test('any meaning_sanity_fail vetoes the manuscript regardless of scores', async () => {
    callWithRole
      .mockResolvedValueOnce(judgeResp(makeJudgeReportJson(['A'], { score: 5, meaningSanityFail: true })))
      .mockResolvedValueOnce(judgeResp(makeJudgeReportJson(['A'], { score: 5 })))
      .mockResolvedValueOnce(judgeResp(makeJudgeReportJson(['A'], { score: 5 })));
    const [a] = twoManuscripts();
    const out = await judgePanelActivity({ brief: BRIEF, ageProfile: PRESCHOOL_PROFILE, manuscripts: [a] }, ctx);
    expect(out.perManuscript.A.pass).toBe(false);
    expect(out.perManuscript.A.meaningSanityVetoes).toEqual(['JUDGE_A']);
  });

  test('one judge returning garbage twice degrades the panel to 2 with a warning', async () => {
    // JUDGE_A ok, JUDGE_B ok, JUDGE_C garbage twice.
    callWithRole.mockImplementation(async (role) => {
      if (role === 'JUDGE_C') return judgeResp({ nonsense: true });
      return judgeResp(makeJudgeReportJson(['A'], { score: 4 }));
    });
    const [a] = twoManuscripts();
    const out = await judgePanelActivity({ brief: BRIEF, ageProfile: PRESCHOOL_PROFILE, manuscripts: [a] }, ctx);
    expect(out.degraded).toBe(true);
    expect(out.failedJudges.map((f) => f.role)).toEqual(['JUDGE_C']);
    expect(out.perManuscript.A.pass).toBe(true); // median of two 4s = 4
    expect(ctx.log.mock.calls.some(([, msg]) => /DEGRADED/.test(msg))).toBe(true);
  });

  test('fewer than 2 valid judges throws', async () => {
    callWithRole.mockImplementation(async (role) => {
      if (role === 'JUDGE_A') return judgeResp(makeJudgeReportJson(['A'], { score: 4 }));
      return judgeResp({ nope: 1 });
    });
    const [a] = twoManuscripts();
    await expect(
      judgePanelActivity({ brief: BRIEF, ageProfile: PRESCHOOL_PROFILE, manuscripts: [a] }, ctx),
    ).rejects.toThrow(/only 1\/3 judges/);
  });

  test('judges receive blinded manuscripts with rotated order', async () => {
    callWithRole.mockImplementation(async () => judgeResp(makeJudgeReportJson(['A', 'B'], { score: 4 })));
    await judgePanelActivity({ brief: BRIEF, ageProfile: PRESCHOOL_PROFILE, manuscripts: twoManuscripts() }, ctx);
    const prompts = callWithRole.mock.calls.map(([, params]) => JSON.parse(params.userPrompt));
    for (const p of prompts) {
      for (const m of p.manuscripts) {
        expect(m).not.toHaveProperty('model');
        expect(m).not.toHaveProperty('concept_id');
      }
    }
    const orders = prompts.map((p) => p.manuscripts.map((m) => m.label).join(''));
    expect(new Set(orders).size).toBeGreaterThan(1); // at least one judge saw a different order
  });
});

describe('aggregateReports', () => {
  test('flagged spreads merge across judges with judge attribution', () => {
    const meta = (judge) => ({ judge, family: 'x', model: 'y', expectedLabels: ['A'] });
    const r1 = normalizeJudgeReport(makeJudgeReportJson(['A'], {
      score: 3, flagged: [{ spread: 2, dimension: 'page_turn_pull', issue: 'flat', suggestion: 'add hook' }],
    }), meta('JUDGE_A'));
    const r2 = normalizeJudgeReport(makeJudgeReportJson(['A'], {
      score: 3, flagged: [{ spread: 5, dimension: 'age_fit', issue: 'long words', suggestion: 'simplify' }],
    }), meta('JUDGE_B'));
    const { perManuscript } = aggregateReports([r1, r2], ['A']);
    expect(perManuscript.A.pass).toBe(false);
    expect(perManuscript.A.flaggedSpreads).toHaveLength(2);
    expect(perManuscript.A.flaggedSpreads.map((f) => f.judge).sort()).toEqual(['JUDGE_A', 'JUDGE_B']);
  });
});
