/**
 * 2026-07-23 audit — spread-judge gate hardening for "Amit's Star Map
 * Adventure" (P0 anatomy/limb count, P1 hero presence, P3 style break).
 */

jest.mock('../../../services/bookPipelineV3/llm/visionClient', () => ({
  callVisionRole: jest.fn(),
}));

const { callVisionRole } = require('../../../services/bookPipelineV3/llm/visionClient');
const {
  judgeSpreadCandidate,
  buildSpreadJudgePrompt,
  HARD_FAIL_TAGS,
  ANATOMY_COUNT_TAGS,
  SPREAD_QA_TAGS,
} = require('../../../services/bookPipelineV3/illustrator/qa/spreadJudge');

const CANDIDATE = { base64: 'img', mimeType: 'image/png' };

function mockVerdict(overrides) {
  callVisionRole.mockResolvedValueOnce({
    json: {
      anatomy: 5, contract: 5, cast: 5, style: 5, zone: 5,
      hero_box: { x: 0.3, y: 0.2, w: 0.3, h: 0.6 },
      tags: [], defects: [], ...overrides,
    },
    model: 'm',
  });
}

beforeEach(() => jest.clearAllMocks());

// ── P0: countable extra-hand / limb-count is always a hard anatomy fail ──
describe('P0 anatomy/limb-count gate', () => {
  test('the exported hard classes cover the countable-limb tags', () => {
    expect(ANATOMY_COUNT_TAGS).toEqual(['anatomy_hands', 'anatomy_limbs']);
  });

  test('an anatomy_hands tag escalates to critical even when the model labels it minor', async () => {
    mockVerdict({ anatomy: 2, tags: ['anatomy_hands'], defects: [{ note: 'a third hand grips the map', severity: 'minor' }] });
    const res = await judgeSpreadCandidate({ candidate: CANDIDATE, sceneContract: {} });
    expect(res.pass).toBe(false);
    expect(res.criticalDefects).toEqual(['a third hand grips the map']);
  });

  test('anatomy score <= 2 is a deterministic critical even if the model forgot the tag', async () => {
    mockVerdict({ anatomy: 2, tags: [], defects: [] });
    const res = await judgeSpreadCandidate({ candidate: CANDIDATE, sceneContract: {} });
    expect(res.pass).toBe(false);
    expect(res.criticalDefects[0]).toMatch(/anatomy score 2 <= 2|countable anatomy/i);
  });

  test('stiff-but-correct hands (anatomy 4, no count tag) still PASS', async () => {
    mockVerdict({ anatomy: 4, defects: [{ note: 'grip a little stiff', severity: 'minor' }] });
    const res = await judgeSpreadCandidate({ candidate: CANDIDATE, sceneContract: {} });
    expect(res.pass).toBe(true);
    expect(res.minorDefects).toEqual(['grip a little stiff']);
  });

  test('the prompt reserves the choreography allowance for WHICH hand — never limb COUNT', () => {
    const p = buildSpreadJudgePrompt({ sceneContract: { hero_action: 'holds the map' } });
    expect(p).toContain('does NOT excuse a limb COUNT error');
    expect(p).toContain('MORE THAN TWO hands or MORE THAN TWO arms');
    expect(p).toContain('three-handed hero shipped on the front cover');
  });
});

// ── P1: required-hero spread with the child absent is critical ──
describe('P1 hero-presence gate', () => {
  test('hero_missing is a hard-fail tag and a valid QA tag', () => {
    expect(HARD_FAIL_TAGS).toContain('hero_missing');
    expect(SPREAD_QA_TAGS).toContain('hero_missing');
  });

  test('required-hero spread + null hero_box escalates hero_missing even if the model omits the tag', async () => {
    mockVerdict({ hero_box: null, tags: [], defects: [] });
    const res = await judgeSpreadCandidate({
      candidate: CANDIDATE, sceneContract: {}, direction: { heroPresence: 'required' },
    });
    expect(res.pass).toBe(false);
    expect(res.tags).toContain('hero_missing');
    expect(res.heroBox).toBeNull();
  });

  test('optional-hero spread with the child absent is NOT a failure', async () => {
    mockVerdict({ hero_box: null, tags: [], defects: [] });
    const res = await judgeSpreadCandidate({
      candidate: CANDIDATE, sceneContract: {}, direction: { heroPresence: 'optional' },
    });
    expect(res.pass).toBe(true);
    expect(res.tags).not.toContain('hero_missing');
  });

  test('the required-hero critical class only appears in the prompt when heroRequired', () => {
    const req = buildSpreadJudgePrompt({ sceneContract: {}, direction: { heroPresence: 'required' }, heroRequired: true });
    expect(req).toContain('REQUIRED-hero spread');
    expect(req).toContain('tag hero_missing');
    const opt = buildSpreadJudgePrompt({ sceneContract: {}, direction: { heroPresence: 'optional' }, heroRequired: false });
    expect(opt).not.toContain('REQUIRED-hero spread');
  });
});

// ── P3: flat-vector + photoreal-live-action are explicit style breaks ──
describe('P3 style-break class', () => {
  test('critical class 6 names the flat-vector and photoreal-live-action breaks and keeps bokeh legal', () => {
    const p = buildSpreadJudgePrompt({ sceneContract: {} });
    expect(p).toContain('flat VECTOR look with hard cel outlines or uniform flat color fills');
    expect(p).toContain('photorealistic real-skin/real-camera CGI render');
    expect(p).toContain('cinematic depth-of-field/bokeh WITHIN the stylized 3D render is part of the style, never a defect');
  });
});
