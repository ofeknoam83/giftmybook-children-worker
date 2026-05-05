/**
 * PR Z — createSpreadSpecs anchor allocation.
 *
 * Two halves:
 *   1. Prompt-content tests: the system prompt names the new "ANCHORS ARE
 *      THE SPINE" directive, and the userPrompt renders the deterministic
 *      ANCHOR ALLOCATION table at the top.
 *   2. Apply-time tests: regardless of what the LLM returns, the persisted
 *      spec for spread 1 / 7 / 10 / 12 carries the deterministic anchor
 *      mustUseDetails entries (with the load-bearing tokens) and the
 *      address line lands on spread 1.
 */

jest.mock('../../../services/bookPipeline/llm/openaiClient', () => ({
  callText: jest.fn(),
}));

const { callText } = require('../../../services/bookPipeline/llm/openaiClient');
const { createSpreadSpecs } = require('../../../services/bookPipeline/planner/createSpreadSpecs');
const { AGE_BANDS, FORMATS, TOTAL_SPREADS } = require('../../../services/bookPipeline/constants');

function buildDoc(overrides = {}) {
  // Initialize spreads as the schema expects: TOTAL_SPREADS slots, each with
  // an empty spec — createSpreadSpecs.updateSpread merges by spreadNumber.
  const spreads = [];
  for (let i = 1; i <= TOTAL_SPREADS; i++) spreads.push({ spreadNumber: i });

  return {
    request: {
      ageBand: AGE_BANDS.PB_INFANT,
      format: FORMATS.PICTURE_BOOK,
      theme: 'mothers_day',
      ...overrides.request,
    },
    brief: {
      child: {
        name: 'Scarlett',
        age: 0.7,
        gender: 'female',
        anecdotes: {
          meaningful_moment: 'first time she squealed in the bath',
          moms_favorite_moment: 'morning snuggle in pajamas with Courtney',
          funny_thing: 'bites mama on the chin',
          anything_else: 'we call her smushy',
          calls_mom: 'Mama',
        },
      },
      customDetails: {},
      coverParentPresent: true,
      ...overrides.brief,
    },
    storyBible: {},
    visualBible: {
      hero: {},
      supportingCastPolicy: '',
      supportingCast: [],
      environmentAnchors: [],
      compositionRules: [],
      textRenderingRules: [],
      prohibitedVisualDrift: [],
    },
    retryMemory: [],
    trace: { llmCalls: [] },
    operationalContext: { bookId: 'pr-z-test' },
    spreads,
    ...overrides,
  };
}

function captureCall(callTextMock) {
  expect(callTextMock).toHaveBeenCalled();
  return callTextMock.mock.calls[callTextMock.mock.calls.length - 1][0];
}

function buildLLMSpread(spreadNumber, overrides = {}) {
  return {
    spreadNumber,
    purpose: 'discovery',
    plotBeat: 'a quiet beat',
    emotionalBeat: 'warm',
    humorBeat: null,
    location: 'a sunny porch',
    focalAction: 'Mama lifts Scarlett to see the light',
    cameraIntent: 'intimate close',
    textSide: spreadNumber % 2 === 0 ? 'right' : 'left',
    textLineTarget: 2,
    mustUseDetails: [],
    sceneBridge: 'continuing the warm light from before',
    continuityAnchors: ['warm light'],
    qaTargets: [],
    forbiddenMistakes: [],
    parentVisibility: 'full',
    ...overrides,
  };
}

describe('PR Z: createSpreadSpecs system prompt + userPrompt', () => {
  beforeEach(() => {
    callText.mockReset();
    const spreads = [];
    for (let i = 1; i <= TOTAL_SPREADS; i++) spreads.push(buildLLMSpread(i));
    callText.mockResolvedValue({
      json: { spreads },
      model: 'mock',
      attempts: 1,
      usage: {},
    });
  });

  test('system prompt names ANCHORS ARE THE SPINE directive with verbatim-words ban', async () => {
    await createSpreadSpecs(buildDoc());
    const { systemPrompt } = captureCall(callText);
    expect(systemPrompt).toMatch(/ANCHORS ARE THE SPINE/);
    // Verbatim-words ban: "bites" never "nibbles", "smushy" never "squishy".
    expect(systemPrompt).toMatch(/bites.*nibbles/);
    expect(systemPrompt).toMatch(/smushy.*squishy/);
  });

  test('userPrompt renders ANCHOR ALLOCATION table at the top with per-beat assignments', async () => {
    await createSpreadSpecs(buildDoc());
    const { userPrompt } = captureCall(callText);
    expect(userPrompt).toMatch(/ANCHOR ALLOCATION/);
    expect(userPrompt).toMatch(/spread 1 \(opening\) · meaningful_moment/);
    expect(userPrompt).toMatch(/spread 7 \(heart\) · moms_favorite_moment/);
    expect(userPrompt).toMatch(/spread 10 \(peak2\) · funny_thing/);
    expect(userPrompt).toMatch(/spread 12 \(closing\) · anything_else/);
    expect(userPrompt).toMatch(/ADDRESS · calls_mom/);
    // Verbatim words must be visible in the table.
    expect(userPrompt).toContain("'bites'");
    expect(userPrompt).toContain("'smushy'");
  });

  test('ANCHOR ALLOCATION block is emitted BEFORE the theme block', async () => {
    await createSpreadSpecs(buildDoc());
    const { userPrompt } = captureCall(callText);
    const anchorIdx = userPrompt.indexOf('ANCHOR ALLOCATION');
    const themeIdx = userPrompt.indexOf('THEME DIRECTIVE');
    expect(anchorIdx).toBeGreaterThan(-1);
    if (themeIdx > -1) {
      expect(anchorIdx).toBeLessThan(themeIdx);
    }
  });
});

describe('PR Z: createSpreadSpecs deterministic mustUseDetails injection', () => {
  beforeEach(() => {
    callText.mockReset();
  });

  test('LLM returns empty mustUseDetails: anchor lines are still injected on opening / heart / peak2 / closing', async () => {
    // LLM intentionally drops mustUseDetails on every spread.
    const spreads = [];
    for (let i = 1; i <= TOTAL_SPREADS; i++) {
      spreads.push(buildLLMSpread(i, { mustUseDetails: [] }));
    }
    callText.mockResolvedValue({ json: { spreads }, model: 'mock', attempts: 1, usage: {} });

    const doc = await createSpreadSpecs(buildDoc());

    const sp = (n) => doc.spreads.find(s => s.spreadNumber === n);

    // Spread 1: leading address line + meaningful_moment anchor.
    const sp1Details = sp(1).spec.mustUseDetails;
    expect(sp1Details[0]).toMatch(/ADDRESS \(calls_mom\)/);
    expect(sp1Details[0]).toContain('Mama');
    expect(sp1Details.some(d => /ANCHOR \(meaningful_moment\)/.test(d))).toBe(true);
    expect(sp1Details.some(d => d.includes("'squealed'"))).toBe(true);
    expect(sp1Details.some(d => d.includes("'bath'"))).toBe(true);
    expect(sp(1).spec.anchorRole).toBe('opening');

    // Spread 7: moms_favorite_moment with verbatim words.
    const sp7Details = sp(7).spec.mustUseDetails;
    expect(sp7Details.some(d => /ANCHOR \(moms_favorite_moment\)/.test(d))).toBe(true);
    expect(sp7Details.some(d => d.includes("'snuggle'"))).toBe(true);
    expect(sp7Details.some(d => d.includes("'courtney'"))).toBe(true);
    expect(sp(7).spec.anchorRole).toBe('heart');

    // Spread 10: funny_thing with bites + chin.
    const sp10Details = sp(10).spec.mustUseDetails;
    expect(sp10Details.some(d => d.includes("'bites'"))).toBe(true);
    expect(sp10Details.some(d => d.includes("'chin'"))).toBe(true);
    expect(sp(10).spec.anchorRole).toBe('peak2');

    // Spread 12: anything_else with smushy.
    const sp12Details = sp(12).spec.mustUseDetails;
    expect(sp12Details.some(d => d.includes("'smushy'"))).toBe(true);
    expect(sp(12).spec.anchorRole).toBe('closing');

    // Spread 5 (no anchor): no anchor role, mustUseDetails stays as the LLM left it.
    expect(sp(5).spec.anchorRole).toBeFalsy();
    expect(sp(5).spec.mustUseDetails.every(d => !d.startsWith('ANCHOR ('))).toBe(true);
  });

  test('LLM echoes the anchor line back: dedupe prevents duplication', async () => {
    // The exact strings the prompt would inject — easiest way to simulate the
    // LLM faithfully copying the prompt's ANCHOR text into mustUseDetails.
    const exactAnchor1 =
      `ANCHOR (meaningful_moment) — this spread must surface the moment "first time she squealed in the bath". Use these load-bearing words VERBATIM (do not paraphrase): 'first', 'time', 'squealed', 'bath'.`;
    const spreads = [];
    for (let i = 1; i <= TOTAL_SPREADS; i++) {
      const md = i === 1 ? [exactAnchor1] : [];
      spreads.push(buildLLMSpread(i, { mustUseDetails: md }));
    }
    callText.mockResolvedValue({ json: { spreads }, model: 'mock', attempts: 1, usage: {} });

    const doc = await createSpreadSpecs(buildDoc());
    const sp1Details = doc.spreads.find(s => s.spreadNumber === 1).spec.mustUseDetails;
    // The exact anchor must NOT appear twice in the persisted spec.
    const occurrences = sp1Details.filter(d => d === exactAnchor1).length;
    expect(occurrences).toBe(1);
  });

  test('verbatimTokens are stashed on the spec for downstream QA / writer use', async () => {
    const spreads = [];
    for (let i = 1; i <= TOTAL_SPREADS; i++) spreads.push(buildLLMSpread(i));
    callText.mockResolvedValue({ json: { spreads }, model: 'mock', attempts: 1, usage: {} });

    const doc = await createSpreadSpecs(buildDoc());
    const sp10 = doc.spreads.find(s => s.spreadNumber === 10).spec;
    expect(sp10.anchorVerbatimTokens).toEqual(expect.arrayContaining(['bites', 'chin']));
  });

  test('empty anecdotes: no anchor injection, specs are LLM-driven only', async () => {
    const spreads = [];
    for (let i = 1; i <= TOTAL_SPREADS; i++) spreads.push(buildLLMSpread(i));
    callText.mockResolvedValue({ json: { spreads }, model: 'mock', attempts: 1, usage: {} });

    const doc = await createSpreadSpecs(buildDoc({
      brief: {
        child: { name: 'Scarlett', age: 0.7, gender: 'female' },
        customDetails: {},
        coverParentPresent: true,
      },
    }));

    for (const s of doc.spreads) {
      expect(s.spec.anchorRole).toBeFalsy();
      expect((s.spec.mustUseDetails || []).every(d => !d.startsWith('ANCHOR ('))).toBe(true);
      expect((s.spec.mustUseDetails || []).every(d => !d.startsWith('ADDRESS ('))).toBe(true);
    }
  });
});
