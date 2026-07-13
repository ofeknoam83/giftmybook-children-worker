const {
  modelFor, resolveRole, requiredApiKeys, validatePanelFamilies, DEFAULT_ROUTING, JUDGE_ROLES,
} = require('../../../services/bookPipelineV3/llm/modelRouter');

describe('bookPipelineV3 modelRouter', () => {
  const ENV_PREFIX = 'BOOK_PIPELINE_V3_';
  const saved = {};

  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith(ENV_PREFIX)) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith(ENV_PREFIX)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  });

  test('default routing: writer-class roles on claude, editor on gpt, judges cross-family', () => {
    expect(modelFor('WRITER')).toEqual({ model: 'claude-opus-4-8', family: 'anthropic' });
    expect(modelFor('BRIEF').family).toBe('anthropic');
    expect(modelFor('CONCEPT').family).toBe('anthropic');
    expect(modelFor('EDITOR')).toEqual({ model: 'gpt-5.4', family: 'openai' });
    const judgeFamilies = JUDGE_ROLES.map((r) => modelFor(r).family);
    expect(new Set(judgeFamilies).size).toBe(3);
  });

  test('env override flips a role family', () => {
    process.env.BOOK_PIPELINE_V3_JUDGE_C_FAMILY = 'deepseek';
    expect(modelFor('JUDGE_C')).toEqual({ model: 'deepseek-v4-pro', family: 'deepseek' });
    process.env.BOOK_PIPELINE_V3_WRITER_TIER = 'mid';
    expect(modelFor('WRITER').model).toBe('claude-sonnet-5');
  });

  test('requiredApiKeys reflects resolved families incl. gemini alternatives', () => {
    const groups = requiredApiKeys();
    const flat = groups.map((g) => g.join('|')).sort();
    expect(flat).toContain('ANTHROPIC_API_KEY');
    expect(flat).toContain('OPENAI_API_KEY');
    expect(flat).toContain('GEMINI_API_KEY|GOOGLE_AI_STUDIO_KEY');
  });

  test('validatePanelFamilies warns when overrides collapse the panel', () => {
    const messages = [];
    expect(validatePanelFamilies((m) => messages.push(m)).ok).toBe(true);
    expect(messages).toHaveLength(0);

    process.env.BOOK_PIPELINE_V3_JUDGE_B_FAMILY = 'anthropic';
    const result = validatePanelFamilies((m) => messages.push(m));
    expect(result.ok).toBe(false);
    expect(messages.join(' ')).toContain('FAMILY COLLAPSE');
  });

  test('every default role resolves to a registered model', () => {
    for (const role of Object.keys(DEFAULT_ROUTING)) {
      expect(() => modelFor(role)).not.toThrow();
      expect(resolveRole(role).family).toBeTruthy();
    }
  });
});
