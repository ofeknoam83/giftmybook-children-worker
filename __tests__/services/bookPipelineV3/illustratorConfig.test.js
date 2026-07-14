/**
 * Native illustrator Phase 0 (milestone 2 W3):
 *   - resolveIllustratorVersion precedence: checkpoint → request → env → default
 *   - invalid request values throw (server 400s them upstream)
 *   - modelRouter: new illustrator roles resolve; likeness judges are
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
  test('default is legacy until the native path passes validation', () => {
    expect(DEFAULT_ILLUSTRATOR).toBe('legacy');
    expect(resolveIllustratorVersion({})).toEqual({ version: 'legacy', source: 'default' });
  });

  test('env flag selects native', () => {
    process.env.BOOK_PIPELINE_V3_ILLUSTRATOR = 'native';
    expect(resolveIllustratorVersion({})).toEqual({ version: 'native', source: 'env' });
  });

  test('request override beats env', () => {
    process.env.BOOK_PIPELINE_V3_ILLUSTRATOR = 'native';
    expect(resolveIllustratorVersion({ requestedVersion: 'legacy' }))
      .toEqual({ version: 'legacy', source: 'request' });
  });

  test('checkpoint pins the illustrator over a later request flag', () => {
    const log = jest.fn();
    expect(resolveIllustratorVersion({ requestedVersion: 'native', checkpointVersion: 'legacy', log }))
      .toEqual({ version: 'legacy', source: 'checkpoint' });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/checkpoint pins 'legacy'/));
  });

  test('invalid request value throws with a code', () => {
    expect(() => resolveIllustratorVersion({ requestedVersion: 'quad' }))
      .toThrow(/Unsupported illustratorVersion 'quad'/);
  });

  test('garbage env value warns and falls back to default', () => {
    process.env.BOOK_PIPELINE_V3_ILLUSTRATOR = 'turbo';
    const log = jest.fn();
    expect(resolveIllustratorVersion({ log })).toEqual({ version: 'legacy', source: 'default' });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/not 'native'\|'legacy'/));
  });

  test('progress sub-steps are defined for the admin stepper', () => {
    expect(ILLUSTRATOR_STEPS).toEqual(['identity_kit', 'art_direction', 'rendering', 'spread_qa', 'book_pass']);
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
