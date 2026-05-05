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

// AA-CW-2: createSpreadSpecs now triggers a second LLM call (the Planner
// Guard) for PB_INFANT books. The original captureCall returned the LATEST
// callText invocation, which is now the guard call — wrong target for
// these tests, which inspect the spreadSpecs prompt. Filter by label so we
// always capture the spreadSpecs call regardless of how many follow it.
function captureCall(callTextMock, label = 'spreadSpecs') {
  expect(callTextMock).toHaveBeenCalled();
  const calls = callTextMock.mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i][0]?.label === label) return calls[i][0];
  }
  // Fallback: return the latest call so the test reports a useful diff
  // instead of an opaque undefined.
  return calls[calls.length - 1][0];
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

  test('system prompt names ANCHORS ARE THE SPINE directive with editor-style transformation guidance', async () => {
    await createSpreadSpecs(buildDoc());
    const { systemPrompt } = captureCall(callText);
    expect(systemPrompt).toMatch(/ANCHORS ARE THE SPINE/);
    // Editor-style: transform the moment, do not copy or erase.
    expect(systemPrompt).toMatch(/Transform the moment/i);
    expect(systemPrompt).toMatch(/not as a literal copy/i);
    expect(systemPrompt).toMatch(/generic stand-in/i);
    // Hard regression: the old verbatim-copy directive must be gone.
    expect(systemPrompt).not.toMatch(/never paraphrase the load-bearing words/i);
    expect(systemPrompt).not.toMatch(/use VERBATIM/);
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
    // Original moment text quoted so the LLM sees what to transform.
    expect(userPrompt).toContain('bites mama on the chin');
    expect(userPrompt).toContain('we call her smushy');
    // Hard regression: no "verbatim words" directive on the planner table.
    expect(userPrompt).not.toMatch(/verbatim words:/i);
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
    const sp1Anchor = sp1Details.find(d => /ANCHOR \(meaningful_moment\)/.test(d));
    expect(sp1Anchor).toBeDefined();
    // The original moment text is quoted in the anchor line so the LLM sees what to transform.
    expect(sp1Anchor).toContain('first time she squealed in the bath');
    expect(sp1Anchor).toMatch(/transform this moment/i);
    expect(sp(1).spec.anchorRole).toBe('opening');

    // Spread 7: moms_favorite_moment.
    const sp7Details = sp(7).spec.mustUseDetails;
    const sp7Anchor = sp7Details.find(d => /ANCHOR \(moms_favorite_moment\)/.test(d));
    expect(sp7Anchor).toBeDefined();
    expect(sp7Anchor).toMatch(/transform this moment/i);
    expect(sp(7).spec.anchorRole).toBe('heart');

    // Spread 10: funny_thing.
    const sp10Details = sp(10).spec.mustUseDetails;
    const sp10Anchor = sp10Details.find(d => /ANCHOR \(funny_thing\)/.test(d));
    expect(sp10Anchor).toBeDefined();
    expect(sp10Anchor).toContain('bites mama on the chin');
    expect(sp10Anchor).toMatch(/Do NOT copy the answer literally/);
    expect(sp(10).spec.anchorRole).toBe('peak2');

    // Spread 12: anything_else.
    const sp12Details = sp(12).spec.mustUseDetails;
    const sp12Anchor = sp12Details.find(d => /ANCHOR \(anything_else\)/.test(d));
    expect(sp12Anchor).toBeDefined();
    expect(sp12Anchor).toContain('we call her smushy');
    expect(sp(12).spec.anchorRole).toBe('closing');

    // Spread 5 (no anchor): no anchor role, mustUseDetails stays as the LLM left it.
    expect(sp(5).spec.anchorRole).toBeFalsy();
    expect(sp(5).spec.mustUseDetails.every(d => !d.startsWith('ANCHOR ('))).toBe(true);
  });

  test('LLM echoes the anchor line back: dedupe prevents duplication', async () => {
    // The exact strings the prompt would inject — easiest way to simulate the
    // LLM faithfully copying the prompt's ANCHOR text into mustUseDetails.
    // Build the exact anchor string the new transformation-style prompt injects.
    const exactAnchor1 =
      `ANCHOR (meaningful_moment) — Spread 1 must transform this moment into the page's couplet(s):\n  "first time she squealed in the bath"\nPreserve the emotional truth of this moment — the specific people, the specific action, the specific feeling. Do NOT copy the answer literally onto the page. Do NOT erase the specificity into something generic. The reader should read this couplet and feel that this exact moment, between these exact people, is on the page.`;
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
