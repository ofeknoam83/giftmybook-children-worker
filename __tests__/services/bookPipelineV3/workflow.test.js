/**
 * Workflow-level tests with a fully mocked model layer + renderer:
 *   - happy path: every stage runs, ≤ round budget honored, {document, layout}
 *     shape, toLegacyStoryPlan sanity (string synopsis), band-named progress
 *   - exhaustion: panel never passes → V3ExhaustionError with judge history,
 *     mapped by index.js to PipelineError('judge_panel_exhausted')
 */

jest.mock('../../../services/bookPipelineV3/llm/modelRouter', () => ({
  callWithRole: jest.fn(),
  modelFor: jest.fn((role) => ({
    family: { JUDGE_A: 'anthropic', JUDGE_B: 'openai', JUDGE_C: 'gemini' }[role] || 'anthropic',
    model: 'test-model',
  })),
  JUDGE_ROLES: ['JUDGE_A', 'JUDGE_B', 'JUDGE_C'],
  validatePanelFamilies: jest.fn(() => ({ ok: true, families: ['anthropic', 'openai', 'gemini'] })),
  resolveRole: jest.fn(() => ({ family: 'anthropic', tier: 'strong' })),
  DEFAULT_ROUTING: { WRITER: { family: 'anthropic', tier: 'strong' } },
}));

jest.mock('../../../services/bookPipeline/illustrator/renderAllSpreadsQuad', () => ({
  renderAllSpreadsQuad: jest.fn(async (doc) => {
    for (const s of doc.spreads) {
      s.illustration = { imageUrl: `https://cdn.example/spread-${s.spreadNumber}.jpg`, scenePrompt: 'prompt' };
    }
    return doc;
  }),
}));

const { callWithRole } = require('../../../services/bookPipelineV3/llm/modelRouter');
const { runCreateBookWorkflow, V3ExhaustionError } = require('../../../services/bookPipelineV3/orchestration/workflows/createBook.workflow');
const { toLegacyStoryPlan } = require('../../../services/bookPipelineV3/contract/toLegacyStoryPlan');
const { RAW_REQUEST, makeConceptJson, makeManuscriptJson, makeJudgeReportJson } = require('./helpers/fixtures');

const BRIEF_JSON = {
  child_as_character: [
    { detail: 'loves her red bucket', story_potential: 'lost and found', load_bearing: true },
    { detail: 'afraid of big waves', story_potential: 'obstacle', load_bearing: true },
  ],
  gift_intent: 'Show Zoe her curiosity beats her fear.',
  constraints: { banned_elements: [], safety_notes: [], pronouns: { subject: 'she', object: 'her', possessive: 'her' } },
};

function resp(json) {
  return { json, usage: { inputTokens: 100, outputTokens: 50 }, model: 'claude-opus-4-8' };
}

/**
 * Wire callWithRole to dispatch on the call label like the real router.
 * `judgeScore` controls whether panels pass (4) or fail (3).
 */
function wireModelLayer({ judgeScore = 4, flagged = [{ spread: 2, dimension: 'age_fit', issue: 'x', suggestion: 'y' }] } = {}) {
  callWithRole.mockImplementation(async (role, params) => {
    const label = params.label || '';
    if (label === 'v3.brief') return resp(BRIEF_JSON);
    if (label.startsWith('v3.concept.')) return resp(makeConceptJson(label.replace('v3.concept.', '')));
    if (label === 'v3.editor') {
      return resp({
        winner_id: 'quest_transformation',
        runner_up_id: 'quiet_observational',
        rationale: 'strongest premise',
        grafts: [],
        scores: {},
      });
    }
    if (label.startsWith('v3.manuscript.')) return resp(makeManuscriptJson(13));
    if (label === 'v3.revision') {
      // Return the flagged spread rewritten (valid shape).
      const { makeSpread } = require('./helpers/fixtures');
      return resp({ spreads: [makeSpread(2)] });
    }
    if (label.startsWith('v3.judge.')) {
      const labels = JSON.parse(params.userPrompt).manuscripts.map((m) => m.label);
      return resp(makeJudgeReportJson(labels, { score: judgeScore, flagged: judgeScore < 4 ? flagged : [] }));
    }
    throw new Error(`unmocked label: ${label}`);
  });
}

beforeEach(() => {
  callWithRole.mockReset();
});

describe('runCreateBookWorkflow — happy path', () => {
  test('produces a v1-shaped document + layout with V3 artifacts attached', async () => {
    wireModelLayer({ judgeScore: 4 });
    const progressSteps = [];
    const { document, layout, artifacts } = await runCreateBookWorkflow({
      rawRequest: { ...RAW_REQUEST },
      signals: { onProgress: (e) => progressSteps.push(e.step) },
      log: () => {},
    });

    // Document shape
    expect(document.spreads).toHaveLength(13);
    expect(document.spreads[0].illustration.imageUrl).toContain('spread-1');
    expect(document.writerQa.pass).toBe(true);
    expect(document.writerQa.panel.pass).toBe(true);
    expect(document.bookWideQa.pass).toBe(true);

    // V3 namespace (milestone-2 seam)
    expect(document.v3.concepts).toHaveLength(3);
    expect(document.v3.manuscriptMeta.conceptId).toBe('quest_transformation');
    expect(document.v3.sceneContracts).toHaveLength(13);
    expect(document.v3.costs.calls).toBeGreaterThan(5);

    // Layout via the real v1 adapter
    expect(Array.isArray(layout.entries)).toBe(true);
    expect(layout.entries.length).toBeGreaterThan(0);

    // Legacy adapter sanity — synopsis must be a real string, not [object Object]
    const { storyPlan } = toLegacyStoryPlan(document);
    expect(typeof storyPlan.synopsis).toBe('string');
    expect(storyPlan.synopsis).not.toContain('[object');
    expect(storyPlan.title).toBe('Zoe and the Singing Sea');
    expect(storyPlan.entries.filter((e) => e.type === 'spread')).toHaveLength(13);

    // Only band-named steps + engine stage keys we allow; the exported
    // workflow emits explicit band events.
    for (const band of ['input', 'planning', 'writing', 'writerQa', 'bookWideQa', 'layout']) {
      expect(progressSteps).toContain(band);
    }

    expect(artifacts.length).toBeGreaterThan(5);
  });

  test('accepts on first panel without any revision call', async () => {
    wireModelLayer({ judgeScore: 5 });
    await runCreateBookWorkflow({ rawRequest: { ...RAW_REQUEST }, signals: {}, log: () => {} });
    const labels = callWithRole.mock.calls.map(([, p]) => p.label);
    expect(labels.filter((l) => l === 'v3.revision')).toHaveLength(0);
    expect(labels.filter((l) => l.startsWith('v3.manuscript.'))).toHaveLength(2); // A + B only, no fresh
  });
});

describe('runCreateBookWorkflow — exhaustion', () => {
  test('panel never passes → V3ExhaustionError with judge history; revision + fresh attempted', async () => {
    wireModelLayer({ judgeScore: 3 });
    let thrown;
    try {
      await runCreateBookWorkflow({ rawRequest: { ...RAW_REQUEST }, signals: {}, log: () => {} });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(V3ExhaustionError);
    expect(thrown.issues.length).toBeGreaterThan(0);
    expect(thrown.issues.join(' ')).toMatch(/failing dimensions/i);

    const labels = callWithRole.mock.calls.map(([, p]) => p.label);
    expect(labels).toContain('v3.revision'); // revision rounds ran
    expect(labels.filter((l) => l === 'v3.manuscript.fresh')).toHaveLength(1); // runner-up branch ran
  });

  test('BOOK_PIPELINE_V3_SHIP_ON_EXHAUSTION=1 ships with writerQa.pass=false', async () => {
    process.env.BOOK_PIPELINE_V3_SHIP_ON_EXHAUSTION = '1';
    try {
      wireModelLayer({ judgeScore: 3 });
      const { document } = await runCreateBookWorkflow({ rawRequest: { ...RAW_REQUEST }, signals: {}, log: () => {} });
      expect(document.writerQa.pass).toBe(false);
      expect(document.writerQa.warnings).toContain('judge_panel_exhausted_shipped_by_env_flag');
    } finally {
      delete process.env.BOOK_PIPELINE_V3_SHIP_ON_EXHAUSTION;
    }
  });
});

describe('index.js error mapping', () => {
  test('V3ExhaustionError maps to PipelineError judge_panel_exhausted', async () => {
    // Set required keys so assertV3Config passes; the mocked router still runs the workflow.
    const saved = {};
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY']) {
      saved[k] = process.env[k];
      process.env[k] = process.env[k] || 'test';
    }
    try {
      wireModelLayer({ judgeScore: 3 });
      const { generateBook, PipelineError } = require('../../../services/bookPipelineV3');
      let thrown;
      try {
        await generateBook({ ...RAW_REQUEST }, {});
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(PipelineError);
      expect(thrown.failureCode).toBe('judge_panel_exhausted');
      expect(thrown.tags).toContain('needs_review');
      expect(thrown.stage).toBe('writerQa');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
