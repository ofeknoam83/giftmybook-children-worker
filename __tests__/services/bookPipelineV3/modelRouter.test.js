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

  test('default routing: existing vendors only — writer-class on gpt-5.4, cross-family editor + judges', () => {
    expect(modelFor('WRITER')).toEqual({ model: 'gpt-5.4', family: 'openai' });
    expect(modelFor('BRIEF').family).toBe('openai');
    expect(modelFor('CONCEPT').family).toBe('openai');
    // EDITOR + JUDGE_A on the FAST deepseek tier (2026-07-15 latency fix):
    // deepseek-v4-pro is a reasoning model that cost 60-230s per call.
    expect(modelFor('EDITOR')).toEqual({ model: 'deepseek-v4-flash', family: 'deepseek' });
    expect(modelFor('JUDGE_A')).toEqual({ model: 'deepseek-v4-flash', family: 'deepseek' });
    // Editor deliberately NOT the writer family.
    expect(modelFor('EDITOR').family).not.toBe(modelFor('WRITER').family);
    const judgeFamilies = JUDGE_ROLES.map((r) => modelFor(r).family);
    expect(new Set(judgeFamilies).size).toBe(3);
    // No role requires the anthropic vendor by default.
    expect(judgeFamilies).not.toContain('anthropic');
  });

  test('env override flips a role to the anthropic family (A/B flip-back path)', () => {
    process.env.BOOK_PIPELINE_V3_WRITER_FAMILY = 'anthropic';
    expect(modelFor('WRITER')).toEqual({ model: 'claude-opus-4-8', family: 'anthropic' });
    process.env.BOOK_PIPELINE_V3_WRITER_TIER = 'mid';
    expect(modelFor('WRITER').model).toBe('claude-sonnet-5');
    process.env.BOOK_PIPELINE_V3_JUDGE_C_FAMILY = 'deepseek';
    expect(modelFor('JUDGE_C')).toEqual({ model: 'deepseek-v4-pro', family: 'deepseek' });
  });

  test('requiredApiKeys: default needs only existing vendors; anthropic joins on override', () => {
    const flat = requiredApiKeys().map((g) => g.join('|')).sort();
    expect(flat).toContain('OPENAI_API_KEY');
    expect(flat).toContain('DEEPSEEK_API_KEY');
    expect(flat).toContain('GEMINI_API_KEY|GOOGLE_AI_STUDIO_KEY');
    expect(flat).not.toContain('ANTHROPIC_API_KEY');

    process.env.BOOK_PIPELINE_V3_WRITER_FAMILY = 'anthropic';
    const withOverride = requiredApiKeys().map((g) => g.join('|'));
    expect(withOverride).toContain('ANTHROPIC_API_KEY');
  });

  test('validatePanelFamilies warns when overrides collapse the panel', () => {
    const messages = [];
    expect(validatePanelFamilies((m) => messages.push(m)).ok).toBe(true);
    expect(messages).toHaveLength(0);

    process.env.BOOK_PIPELINE_V3_JUDGE_A_FAMILY = 'openai'; // collapses onto JUDGE_B's family
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
