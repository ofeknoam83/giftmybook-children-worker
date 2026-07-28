/**
 * Workflow-level tests with a fully mocked model layer + renderer:
 *   - happy path: every stage runs, ≤ round budget honored, {document, layout}
 *     shape, toLegacyStoryPlan sanity (string synopsis), band-named progress
 *   - exhaustion: panel never passes → V3ExhaustionError with judge history,
 *     mapped by index.js to PipelineError('needs_review') with a reviewQueue payload
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

// Mock the native illustrator (the only illustrator since the cutover):
// compose the same v1-shaped doc the real one does, minus the rendering.
jest.mock('../../../services/bookPipelineV3/illustrator', () => ({
  runNativeIllustrator: jest.fn(async (input, ctx) => {
    const { createBookDocument } = jest.requireActual('../../../services/bookPipelineV3/contract/bookDocument');
    const { buildVisualBible, buildSpreadSpecs, buildStoryBible } =
      jest.requireActual('../../../services/bookPipelineV3/orchestration/activities/illustrationDirector');
    const { buildSpreadsForLegacyIllustrator } =
      jest.requireActual('../../../services/bookPipelineV3/orchestration/activities/illustrationAdapterHelpers');
    const { rawRequest, brief, ageProfile, concept, manuscript, coverImageUrl, coverTitle, operationalContext } = input;
    const doc = createBookDocument({
      request: { ...rawRequest, bookId: ctx.bookId, ageBand: ageProfile?.ageBand || ageProfile?.band },
      brief: rawRequest || {},
      cover: {
        title: manuscript.title || coverTitle || rawRequest?.cover?.title || 'My Story',
        imageUrl: coverImageUrl || rawRequest?.cover?.imageUrl || null,
        characterLocks: {},
        outfitLocks: {},
      },
    });
    doc.storyBible = buildStoryBible({ concept, manuscript });
    doc.visualBible = buildVisualBible({ rawRequest, brief, concept, manuscript });
    doc.spreadSpecs = buildSpreadSpecs({ manuscript, ageProfile });
    const draftBySpread = new Map(manuscript.spreads.map((s) => [s.spread, { text: s.text, lines: s.lines }]));
    doc.spreads = buildSpreadsForLegacyIllustrator({ spreadSpecs: doc.spreadSpecs, draftBySpread });
    doc.operationalContext = operationalContext || {};
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
    if (label === 'v3.revision' || label === 'v3.revision.contractfix'
      || label === 'v3.polish' || label === 'v3.polish.contractfix') {
      // Return every targeted spread rewritten (valid shape). Bounce targets
      // (requireContractChange) get a CHANGED scene_contract, mirroring a
      // compliant writer.
      const { makeSpread } = require('./helpers/fixtures');
      const req = JSON.parse(params.userPrompt);
      const spreads = (req.targeted_revisions || []).map((t) => {
        const s = makeSpread(t.spread);
        if (t.requireContractChange) {
          s.scene_contract = {
            ...s.scene_contract,
            setting: `revised ${s.scene_contract.setting}`,
            hero_action: `revised ${s.scene_contract.hero_action}`,
          };
        }
        return s;
      });
      return resp({ spreads });
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
    // Illustrator resolution recorded (native is the only illustrator)
    expect(document.v3.illustrator).toEqual({ version: 'native', source: 'default' });
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

// Post-panel polish pass (2026-07-28): an ACCEPTED manuscript's judge flags
// and soft lints previously evaporated — the fixture manuscript's identical
// spread openers trip the repetitive_opener lint, giving the pass targets.
describe('runCreateBookWorkflow — polish pass', () => {
  afterEach(() => { delete process.env.BOOK_PIPELINE_V3_POLISH_PASS; });

  test('runs on the accept path and persists softLints on writerQa.gate', async () => {
    wireModelLayer({ judgeScore: 5 });
    const { document } = await runCreateBookWorkflow({ rawRequest: { ...RAW_REQUEST }, signals: {}, log: () => {} });
    const labels = callWithRole.mock.calls.map(([, p]) => p.label);
    expect(labels.filter((l) => l === 'v3.polish')).toHaveLength(1);
    expect(document.writerQa.pass).toBe(true);
    const lintCodes = (document.writerQa.gate.softLints || []).map((l) => l.code);
    expect(lintCodes).toContain('repetitive_opener');
  });

  test('BOOK_PIPELINE_V3_POLISH_PASS=0 disables it', async () => {
    process.env.BOOK_PIPELINE_V3_POLISH_PASS = '0';
    wireModelLayer({ judgeScore: 5 });
    await runCreateBookWorkflow({ rawRequest: { ...RAW_REQUEST }, signals: {}, log: () => {} });
    const labels = callWithRole.mock.calls.map(([, p]) => p.label);
    expect(labels.filter((l) => l === 'v3.polish')).toHaveLength(0);
  });

  test('a failing polish call never breaks the book (pre-polish manuscript ships)', async () => {
    wireModelLayer({ judgeScore: 5 });
    const base = callWithRole.getMockImplementation();
    callWithRole.mockImplementation(async (role, params) => {
      if (params.label === 'v3.polish') throw new Error('polish model down');
      return base(role, params);
    });
    const { document } = await runCreateBookWorkflow({ rawRequest: { ...RAW_REQUEST }, signals: {}, log: () => {} });
    expect(document.spreads).toHaveLength(13);
    expect(document.writerQa.pass).toBe(true);
  });
});

describe('runCreateBookWorkflow — illustrator resolution (post-cutover)', () => {
  test("a 'native' checkpoint pins with source=checkpoint", async () => {
    wireModelLayer({ judgeScore: 5 });
    const { document } = await runCreateBookWorkflow({
      rawRequest: { ...RAW_REQUEST, checkpointIllustratorVersion: 'native' },
      signals: {},
      log: () => {},
    });
    expect(document.v3.illustrator).toEqual({ version: 'native', source: 'checkpoint' });
  });

  test("a pre-cutover 'legacy' checkpoint maps LOUDLY onto native (its code is deleted)", async () => {
    wireModelLayer({ judgeScore: 5 });
    const warnings = [];
    const { document } = await runCreateBookWorkflow({
      rawRequest: { ...RAW_REQUEST, checkpointIllustratorVersion: 'legacy' },
      signals: {},
      log: (level, msg) => { if (level === 'warn') warnings.push(String(msg)); },
    });
    expect(document.v3.illustrator).toEqual({ version: 'native', source: 'default' });
    expect(warnings.join(' ')).toMatch(/deleted in the native cutover/);
  });
});

describe('runCreateBookWorkflow — text layout (admin-selectable, 2026-07-17)', () => {
  test("defaults to 'caption' and persists on doc.v3", async () => {
    wireModelLayer({ judgeScore: 5 });
    const { document } = await runCreateBookWorkflow({ rawRequest: { ...RAW_REQUEST }, signals: {}, log: () => {} });
    expect(document.v3.textLayout).toBe('caption');
  });

  test("request 'embedded' persists and reaches the illustrator input", async () => {
    wireModelLayer({ judgeScore: 5 });
    const { runNativeIllustrator } = require('../../../services/bookPipelineV3/illustrator');
    runNativeIllustrator.mockClear();
    const { document } = await runCreateBookWorkflow({
      rawRequest: { ...RAW_REQUEST, textLayout: 'embedded' },
      signals: {},
      log: () => {},
    });
    expect(document.v3.textLayout).toBe('embedded');
    expect(runNativeIllustrator.mock.calls[0][0].textLayout).toBe('embedded');
  });

  test('the checkpoint mode wins over the request (books finish on the mode they started)', async () => {
    wireModelLayer({ judgeScore: 5 });
    const { document } = await runCreateBookWorkflow({
      rawRequest: { ...RAW_REQUEST, textLayout: 'caption', checkpointTextLayout: 'embedded' },
      signals: {},
      log: () => {},
    });
    expect(document.v3.textLayout).toBe('embedded');
  });
});

describe('runCreateBookWorkflow — art-direction bounce loop', () => {
  const { runNativeIllustrator } = require('../../../services/bookPipelineV3/illustrator');

  beforeEach(() => {
    runNativeIllustrator.mockClear(); // keep the default impl, reset call counts
  });

  function bounceError(spreads) {
    return Object.assign(new Error(`bounced [${spreads.join(',')}]`), {
      name: 'ArtDirectionBounceError',
      bounces: spreads.map((n) => ({ spread: n, problem: 'unstageable geometry', suggestion: 'move the action' })),
    });
  }

  test('a spread newly flagged on a later pass gets its own revision round', async () => {
    wireModelLayer({ judgeScore: 5 });
    runNativeIllustrator
      .mockImplementationOnce(async () => { throw bounceError([6]); })
      .mockImplementationOnce(async () => { throw bounceError([10]); });
    // third call falls through to the default doc-composing mock
    const { document } = await runCreateBookWorkflow({ rawRequest: { ...RAW_REQUEST }, signals: {}, log: () => {} });
    expect(document.spreads).toHaveLength(13);
    const revisions = callWithRole.mock.calls.map(([, p]) => p.label).filter((l) => l === 'v3.revision');
    expect(revisions).toHaveLength(2); // one per bounce round
    expect(runNativeIllustrator).toHaveBeenCalledTimes(3);
    expect(runNativeIllustrator.mock.calls[0][0].allowBounce).toBe(true);
    expect(runNativeIllustrator.mock.calls[1][0].allowBounce).toBe(true);
    expect(runNativeIllustrator.mock.calls[2][0].allowBounce).toBe(false); // final pass: bounces become needs_review
    // the second pass renders the manuscript revised for spread 6
    expect(runNativeIllustrator.mock.calls[1][0].manuscript.spreads[5].scene_contract.setting).toMatch(/^revised /);
  });

  test('a spread RE-flagged after its revision short-circuits to needs_review', async () => {
    wireModelLayer({ judgeScore: 5 });
    runNativeIllustrator
      .mockImplementationOnce(async () => { throw bounceError([6]); })
      .mockImplementationOnce(async () => { throw bounceError([6]); });
    let thrown;
    try {
      await runCreateBookWorkflow({ rawRequest: { ...RAW_REQUEST }, signals: {}, log: () => {} });
    } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(V3ExhaustionError);
    expect(thrown.needsReview).toMatchObject({ stage: 'artDirection', reason: 'art_direction_unstageable', spread: 6 });
    expect(runNativeIllustrator).toHaveBeenCalledTimes(2); // no wasted third pass
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
    // W2: exhaustion carries the structured review-queue payload
    expect(thrown.needsReview).toMatchObject({ stage: 'writerQa', reason: 'judge_panel_exhausted' });
    expect(thrown.needsReview.defects.length).toBeGreaterThan(0);
    expect(Array.isArray(thrown.needsReview.judgeHistory)).toBe(true);

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

  test("review resolution action 'ship_best' ships with writerQa.pass=false (W2)", async () => {
    wireModelLayer({ judgeScore: 3 });
    const { document } = await runCreateBookWorkflow({
      rawRequest: { ...RAW_REQUEST, reviewResolution: { action: 'ship_best', admin: 'qa@giftmybook.com' } },
      signals: {},
      log: () => {},
    });
    expect(document.writerQa.pass).toBe(false);
    expect(document.writerQa.warnings).toContain('judge_panel_exhausted_shipped_by_review_approval');
  });
});

describe('index.js error mapping', () => {
  test('V3ExhaustionError maps to PipelineError needs_review with payload', async () => {
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
      expect(thrown.failureCode).toBe('needs_review');
      expect(thrown.tags).toContain('needs_review');
      expect(thrown.tags).toContain('judge_panel_exhausted');
      expect(thrown.stage).toBe('writerQa');
      expect(thrown.needsReview).toMatchObject({ stage: 'writerQa', reason: 'judge_panel_exhausted' });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
