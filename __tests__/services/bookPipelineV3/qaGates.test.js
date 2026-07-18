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

  // 2026-07-16 (book 5792dc26): ["Amit", "a magical turtle"] joined with ', '
  // read as an apposition — the judge decided Amit IS the turtle and failed
  // good candidates for showing "an extra boy". The cast list is numbered
  // with a count and the hero labeled, identically in render + judge prompts.
  test('cast list is numbered and unambiguous (no apposition misread)', () => {
    const { formatCastList } = require('../../../services/bookPipelineV3/illustrator/promptFormat');
    expect(formatCastList(['Amit', 'a magical turtle']))
      .toBe('(exactly 2, nobody else): [1] Amit — the child hero; [2] a magical turtle');
    expect(formatCastList([])).toBe('(exactly 1, nobody else): [1] the child — the child hero');
    expect(formatCastList(undefined)).toContain('the child — the child hero');

    const p = buildSpreadJudgePrompt({ sceneContract: { characters_present: ['Amit', 'a magical turtle'] }, direction: null });
    expect(p).toContain('Characters present (exactly 2, nobody else): [1] Amit — the child hero; [2] a magical turtle');
  });

  // 2026-07-16 (book 5792dc26, spread 2 c3): failed for the finger tracing
  // "past the moon cave mark" instead of "from the waterfall mark toward" —
  // pointer position along a prop is unjudgeable pedantry.
  test('prop micro-geometry is never a defect', () => {
    const p = buildSpreadJudgePrompt({ sceneContract: { hero_action: 'traces the route on the map' }, direction: null });
    expect(p).toContain('PROP MICRO-GEOMETRY');
    expect(p).toContain('NEVER a defect');
    expect(p).toContain('right prop in the right general manner');
  });

  // 2026-07-16 (book 8e6c23e0): "left hand" done by the right hand, "one
  // hand" done with two, and "compass not just over the side pocket" all
  // failed candidates; "slightly stiff grip" STILL failed despite the
  // rules-list anatomy floor — the floor must live inline in the score
  // definitions, which is what the judge actually follows.
  test('choreography allowance + binding inline anatomy/contract floors', () => {
    const p = buildSpreadJudgePrompt({ sceneContract: { hero_action: 'tucks the compass away' }, direction: null });
    expect(p).toContain('CHOREOGRAPHY ALLOWANCE');
    expect(p).toContain('left/right are interchangeable');
    expect(p).toContain('Judge whether the ACTION reads, not its choreography');
    // inline score anchors
    expect(p).toContain('stiffness or awkwardness is NEVER below 4; only countably wrong anatomy');
    expect(p).toContain('choreography (which hand, how many hands, exact prop-relative position) never lowers this score');
  });

  // 2026-07-16 (book f7191348, spreads 3+8 exhausted): action_mismatch:9 came
  // from grading motion physics a still image can't prove ("boot resting, not
  // mid-tap"); missing_object:7 from treating every small mechanism prop as a
  // hard requirement; and "slightly stiff" hands still failed despite the
  // minor-anatomy allowance.
  test('motion-phase allowance, object criticality, and the hard anatomy floor', () => {
    const p = buildSpreadJudgePrompt({ sceneContract: { hero_action: 'taps the stone into the groove' }, direction: null });
    expect(p).toContain('MOTION-PHASE ALLOWANCE');
    expect(p).toContain('a still image cannot depict a motion phase');
    expect(p).toContain('never fail for static-vs-in-motion, resting-vs-tapping, or about-to-vs-just-did');
    expect(p).toContain('OBJECT CRITICALITY');
    expect(p).toContain('critical ONLY when the action becomes unreadable without it');
    expect(p).toContain('is a minor defect');
    expect(p).toContain('NEVER scores below 4 — only countably wrong anatomy');
  });

  // Closed critical gate (2026-07-16): five calibration rounds proved an
  // open-ended judge invents a new pedantry class every run. The judge can
  // now BLOCK only for the closed critical list (THE PARENT TEST); minors
  // are recorded and shipped as advisories.
  describe('severity gate', () => {
    const { judgeSpreadCandidate: judge, HARD_FAIL_TAGS } = require('../../../services/bookPipelineV3/illustrator/qa/spreadJudge');

    function mockVerdict(overrides) {
      callVisionRole.mockResolvedValueOnce({
        json: { anatomy: 5, contract: 5, cast: 5, style: 5, zone: 5, tags: [], defects: [], ...overrides },
        model: 'm',
      });
    }

    test('prompt states THE PARENT TEST, the closed critical list, and the severity schema', () => {
      const p = buildSpreadJudgePrompt({ sceneContract: {}, direction: null });
      expect(p).toContain('THE PARENT TEST');
      expect(p).toContain('The complete list of critical classes');
      expect(p).toContain('EVERYTHING ELSE IS "minor"');
      expect(p).toContain('"severity": "critical|minor"');
    });

    test('a critical defect fails the candidate', async () => {
      mockVerdict({ defects: [{ note: 'a second identical child stands in the doorway', severity: 'critical' }] });
      const res = await judge({ candidate: CANDIDATE, sceneContract: {} });
      expect(res.pass).toBe(false);
      expect(res.criticalDefects).toEqual(['a second identical child stands in the doorway']);
    });

    test('minor-only defects PASS — recorded, not blocking (even with low scores)', async () => {
      mockVerdict({
        contract: 3, // scores rank, they no longer gate
        defects: [
          { note: 'the map is drawn differently than on the cover', severity: 'minor' },
          { note: 'hands slightly stiff', severity: 'minor' },
        ],
      });
      const res = await judge({ candidate: CANDIDATE, sceneContract: {} });
      expect(res.pass).toBe(true);
      expect(res.minorDefects).toHaveLength(2);
      expect(res.criticalDefects).toHaveLength(0);
    });

    test('hard-tag backstop: a duplicated_hero tag escalates to critical even if the model says minor', async () => {
      expect(HARD_FAIL_TAGS).toContain('duplicated_hero');
      mockVerdict({
        tags: ['duplicated_hero'],
        defects: [{ note: 'two copies of the hero', severity: 'minor' }],
      });
      const res = await judge({ candidate: CANDIDATE, sceneContract: {} });
      expect(res.pass).toBe(false);
      expect(res.criticalDefects).toEqual(['two copies of the hero']);
    });

    test('legacy string defects are tolerated as minors (backstop covers the hard classes)', async () => {
      mockVerdict({ defects: ['background rooftop reads distant'] });
      const res = await judge({ candidate: CANDIDATE, sceneContract: {} });
      expect(res.pass).toBe(true);
      expect(res.minorDefects).toEqual(['background rooftop reads distant']);
    });
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

// Cover-aware style judging (2026-07-18): a cover-blind judge passed a
// flat/desaturated spread that the book pass then killed as a style break
// (book 6e018c20). The judge now receives the parent-approved cover as a
// RENDERING-STYLE reference only — identity stays the likeness judge's job.
describe('cover-aware style judging', () => {
  const { buildSpreadJudgePrompt } = require('../../../services/bookPipelineV3/illustrator/qa/spreadJudge');
  const COVER = { base64: 'COVER', mimeType: 'image/jpeg', kind: 'cover' };
  const cleanVerdict = { anatomy: 5, contract: 5, cast: 5, style: 5, zone: 5, tags: [], defects: [] };

  test('without a cover the prompt keeps the cover-blind wording', () => {
    const p = buildSpreadJudgePrompt({ sceneContract: {}, direction: null });
    expect(p).toContain('you have no reference art');
    expect(p).not.toContain('COVER reference');
  });

  test('with a cover the style critical class broadens and stays STYLE-ONLY', () => {
    const p = buildSpreadJudgePrompt({ sceneContract: {}, direction: null, hasCover: true });
    expect(p).toContain('RENDERING-STYLE reference ONLY');
    expect(p).toContain('rendering style clearly inconsistent with the COVER reference');
    expect(p).toContain('flat/desaturated');
    // Identity/likeness judging is still forbidden — the likeness judge owns it.
    expect(p).toContain('NO IDENTITY OR GENDER JUDGING');
    expect(p).toContain('RENDERING STYLE comparison ONLY');
    expect(p).not.toContain('you have no reference art');
  });

  test('judgeSpreadCandidate attaches the cover as image 2 when provided', async () => {
    callVisionRole.mockResolvedValueOnce({ json: cleanVerdict, model: 'm' });
    await judgeSpreadCandidate({ candidate: CANDIDATE, sceneContract: {}, coverImage: COVER });
    const call = callVisionRole.mock.calls[0][1];
    expect(call.images).toEqual([CANDIDATE, COVER]);
    expect(call.prompt).toContain('Image 2 is the parent-approved COVER');
  });

  test('cover-less judging is byte-for-byte the legacy shape (single image)', async () => {
    callVisionRole.mockResolvedValueOnce({ json: cleanVerdict, model: 'm' });
    await judgeSpreadCandidate({ candidate: CANDIDATE, sceneContract: {} });
    const call = callVisionRole.mock.calls[0][1];
    expect(call.images).toEqual([CANDIDATE]);
    expect(call.prompt).toContain('you have no reference art');
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

  // 2026-07-16 (book f33b4200): 12 likeness fails, almost all "hair reads
  // golden/blonde" in a starlight-themed book — warm light glows on brown
  // hair. The lighting rule now covers HAIR: fail only a genuinely
  // different base color, never warm-lit brown.
  test('warm-lit hair is not a hair-color mismatch — only a genuinely different base color fails', () => {
    expect(JUDGE_PROMPT).toContain('The same applies to HAIR');
    expect(JUDGE_PROMPT).toContain("judge the hair's base color under the scene's light");
    expect(JUDGE_PROMPT).toContain('fail only when the hair genuinely reads a DIFFERENT color');
  });
});
