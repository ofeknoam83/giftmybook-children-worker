/**
 * Native illustrator config (post-cutover — native is the ONLY illustrator):
 *   - resolveIllustratorVersion always resolves native; pre-cutover 'legacy'
 *     checkpoints map LOUDLY onto native (their code is deleted); stale env
 *     values warn and are ignored; invalid request values throw (server
 *     400s them upstream).
 *   - modelRouter: illustrator roles resolve; likeness judges are
 *     cross-family by default and a collapsing override warns.
 */

const {
  resolveIllustratorVersion,
  DEFAULT_ILLUSTRATOR,
  ILLUSTRATOR_STEPS,
} = require('../../../services/bookPipelineV3/illustrator/config');

const {
  modelFor,
  resolveRole,
  validateLikenessFamilies,
  LIKENESS_ROLES,
} = require('../../../services/bookPipelineV3/llm/modelRouter');

afterEach(() => {
  delete process.env.BOOK_PIPELINE_V3_ILLUSTRATOR;
  delete process.env.BOOK_PIPELINE_V3_LIKENESS_JUDGE_B_FAMILY;
});

describe('resolveIllustratorVersion', () => {
  test('native is the one and only default', () => {
    expect(DEFAULT_ILLUSTRATOR).toBe('native');
    expect(resolveIllustratorVersion({})).toEqual({ version: 'native', source: 'default' });
  });

  test("env flag 'native' resolves with source=env", () => {
    process.env.BOOK_PIPELINE_V3_ILLUSTRATOR = 'native';
    expect(resolveIllustratorVersion({})).toEqual({ version: 'native', source: 'env' });
  });

  test("a 'native' checkpoint pins with source=checkpoint", () => {
    expect(resolveIllustratorVersion({ checkpointVersion: 'native' }))
      .toEqual({ version: 'native', source: 'checkpoint' });
  });

  test("a pre-cutover 'legacy' checkpoint maps LOUDLY onto native", () => {
    const log = jest.fn();
    expect(resolveIllustratorVersion({ checkpointVersion: 'legacy', log }))
      .toEqual({ version: 'native', source: 'default' });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/deleted in the native cutover/));
  });

  test("a 'legacy' request value throws (no code behind it)", () => {
    expect(() => resolveIllustratorVersion({ requestedVersion: 'legacy' }))
      .toThrow(/Unsupported illustratorVersion 'legacy'/);
  });

  test('invalid request value throws with a code', () => {
    expect(() => resolveIllustratorVersion({ requestedVersion: 'quad' }))
      .toThrow(/Unsupported illustratorVersion 'quad'/);
  });

  test("stale env value (e.g. 'legacy') warns and is ignored", () => {
    process.env.BOOK_PIPELINE_V3_ILLUSTRATOR = 'legacy';
    const log = jest.fn();
    expect(resolveIllustratorVersion({ log })).toEqual({ version: 'native', source: 'default' });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/stale/));
  });

  test('progress sub-steps are defined for the admin stepper', () => {
    expect(ILLUSTRATOR_STEPS).toEqual(['identity_kit', 'art_direction', 'rendering', 'spread_qa', 'book_pass']);
  });

  test('renderers default to the VERIFIED-available model (the guessed pro id 404d in production)', () => {
    const { SHEET_RENDERER_MODEL, SPREAD_RENDERER_MODEL } = require('../../../services/bookPipelineV3/illustrator/config');
    expect(SHEET_RENDERER_MODEL).toBe('gemini-3.1-flash-image');
    expect(SPREAD_RENDERER_MODEL).toBe('gemini-3.1-flash-image');
  });
});

describe('modelRouter illustrator roles', () => {
  test('new roles resolve to provisioned vendors', () => {
    expect(modelFor('ART_DIRECTOR')).toEqual({ model: 'gemini-2.5-pro', family: 'gemini' });
    expect(modelFor('QA_VISION')).toEqual({ model: 'gemini-2.5-flash', family: 'gemini' });
    expect(modelFor('LIKENESS_JUDGE_A').family).toBe('gemini');
    expect(modelFor('LIKENESS_JUDGE_B').family).toBe('openai');
  });

  test('likeness judges are cross-family by default', () => {
    const res = validateLikenessFamilies(() => {});
    expect(res.ok).toBe(true);
    expect(new Set(res.families).size).toBe(LIKENESS_ROLES.length);
  });

  test('collapsing likeness families warns FAMILY COLLAPSE', () => {
    process.env.BOOK_PIPELINE_V3_LIKENESS_JUDGE_B_FAMILY = 'gemini';
    const log = jest.fn();
    const res = validateLikenessFamilies(log);
    expect(res.ok).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/LIKENESS JUDGE FAMILY COLLAPSE/));
    expect(resolveRole('LIKENESS_JUDGE_B').family).toBe('gemini');
  });
});
