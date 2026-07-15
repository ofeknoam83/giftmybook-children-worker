/**
 * QA gate calibration (2026-07-15 — first native book exhausted 11/13
 * spreads at fail@deterministic):
 *   - letterform gate flags READABLE marks only (star trails / squiggles
 *     are not text), names what/where, runs at temperature 0
 *   - spread + likeness judges run at temperature 0 (stable repair targets)
 *   - likeness rubric carries the framing allowance + scene-lighting clause
 */

jest.mock('../../../services/bookPipelineV3/llm/visionClient', () => ({
  callVisionRole: jest.fn(),
}));

const { callVisionRole } = require('../../../services/bookPipelineV3/llm/visionClient');
const { letterformCheck, LETTERFORM_PROMPT } = require('../../../services/bookPipelineV3/illustrator/qa/deterministicChecks');
const { judgeSpreadCandidate } = require('../../../services/bookPipelineV3/illustrator/qa/spreadJudge');
const { judgeLikenessOnce, JUDGE_PROMPT } = require('../../../services/bookPipelineV3/illustrator/qa/likenessJudge');

const CANDIDATE = { base64: 'img', mimeType: 'image/png' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('letterform gate', () => {
  test('prompt is calibrated to READABLE marks only — no "resembles lettering" over-trigger', () => {
    expect(LETTERFORM_PROMPT).toContain('READABLE TEXT');
    expect(LETTERFORM_PROMPT).toContain('star trails and constellation lines');
    expect(LETTERFORM_PROMPT).toContain('abstract squiggles');
    expect(LETTERFORM_PROMPT).not.toMatch(/resembles lettering/);
    expect(LETTERFORM_PROMPT).toContain('"what"');
    expect(LETTERFORM_PROMPT).toContain('"textType"');
    expect(LETTERFORM_PROMPT).toContain('isolated_glyph');
  });

  test('readable WORDS fail with what/where in the defect; runs at temperature 0', async () => {
    callVisionRole.mockResolvedValueOnce({ json: { hasText: true, textType: 'words', what: 'the word STAR', where: 'on the map, upper right' }, model: 'm', family: 'gemini' });
    const res = await letterformCheck(CANDIDATE);
    expect(res.pass).toBe(false);
    expect(res.defects[0]).toContain('the word STAR');
    expect(res.defects[0]).toContain('on the map, upper right');
    expect(callVisionRole.mock.calls[0][1].temperature).toBe(0);
  });

  test("an isolated glyph on a prop (compass 'N') is tolerated with a log note", async () => {
    callVisionRole.mockResolvedValueOnce({ json: { hasText: true, textType: 'isolated_glyph', what: "the letter 'N'", where: 'compass rose' }, model: 'm', family: 'gemini' });
    const notes = [];
    const res = await letterformCheck(CANDIDATE, undefined, (m) => notes.push(m));
    expect(res.pass).toBe(true);
    expect(res.defects).toHaveLength(0);
    expect(notes.join(' ')).toContain("tolerated isolated glyph (the letter 'N' — compass rose)");
  });

  test('hasText=true with no textType stays a hard fail (safe default)', async () => {
    callVisionRole.mockResolvedValueOnce({ json: { hasText: true, what: 'unclear marks', where: 'sign' }, model: 'm', family: 'gemini' });
    const res = await letterformCheck(CANDIDATE);
    expect(res.pass).toBe(false);
  });

  test('hasText=false passes', async () => {
    callVisionRole.mockResolvedValueOnce({ json: { hasText: false, what: null, where: null }, model: 'm', family: 'gemini' });
    const res = await letterformCheck(CANDIDATE);
    expect(res.pass).toBe(true);
    expect(res.defects).toHaveLength(0);
  });
});

describe('spread judge rubric — non-critical failure allowances (2026-07-15)', () => {
  const { buildSpreadJudgePrompt } = require('../../../services/bookPipelineV3/illustrator/qa/spreadJudge');

  test('one-moment rule, minor-anatomy allowance, object equivalence, no identity judging, shot advisory', () => {
    const p = buildSpreadJudgePrompt({ sceneContract: { hero_action: 'tries to lift the lid' }, direction: { shot: 'over-shoulder' } });
    expect(p).toContain('ONE-MOMENT RULE');
    expect(p).toContain('never fail for not depicting a sequence');
    expect(p).toContain('MINOR-ANATOMY ALLOWANCE');
    expect(p).toContain('scores 4, not 3');
    expect(p).toContain('OBJECT EQUIVALENCE');
    expect(p).toContain('NO IDENTITY OR GENDER JUDGING');
    expect(p).toContain('ADVISORY');
    // hard fails survive
    expect(p).toContain('caps cast at 1');
    expect(p).toContain('caps anatomy at 2');
  });

  test('when the art director specified a moment, the judge grades the action against IT', () => {
    const p = buildSpreadJudgePrompt({
      sceneContract: { hero_action: 'searches the porch, then unfolds the map' },
      direction: { moment: 'kneeling on the porch, map half-unfolded in both hands' },
    });
    expect(p).toContain('THE DEPICTED MOMENT');
    expect(p).toContain('kneeling on the porch, map half-unfolded in both hands');
  });
});

describe('judge determinism (temperature 0)', () => {
  test('spread judge', async () => {
    callVisionRole.mockResolvedValueOnce({
      json: { anatomy: 5, contract: 5, cast: 5, style: 5, zone: 5, tags: [], defects: [] },
      model: 'm',
    });
    await judgeSpreadCandidate({ candidate: CANDIDATE, sceneContract: {} });
    expect(callVisionRole.mock.calls[0][1].temperature).toBe(0);
  });

  test('likeness judge', async () => {
    callVisionRole.mockResolvedValueOnce({
      json: { likeness: 5, skinToneMatch: true, hairMatch: true, ageMatch: true, wrongChild: false, defects: [] },
      model: 'm', family: 'gemini',
    });
    await judgeLikenessOnce({ role: 'LIKENESS_JUDGE_A', candidate: CANDIDATE, referenceImages: [CANDIDATE] });
    expect(callVisionRole.mock.calls[0][1].temperature).toBe(0);
  });
});

describe('likeness rubric — spread-level allowances', () => {
  test('framing allowance: hidden features are not mismatches; wrongChild needs positive evidence', () => {
    expect(JUDGE_PROMPT).toContain('FRAMING ALLOWANCE');
    expect(JUDGE_PROMPT).toContain('Absence of evidence is NOT a mismatch');
    expect(JUDGE_PROMPT).toContain('POSITIVE evidence');
  });

  test('scene lighting is not a skin-tone mismatch', () => {
    expect(JUDGE_PROMPT).toContain('Scene lighting is not a skin-tone mismatch');
  });
});
