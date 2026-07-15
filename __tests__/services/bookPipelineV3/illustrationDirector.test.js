jest.mock('../../../services/bookPipeline/illustrator/renderAllSpreadsQuad', () => ({
  renderAllSpreadsQuad: jest.fn(),
}));

const { renderAllSpreadsQuad } = require('../../../services/bookPipeline/illustrator/renderAllSpreadsQuad');
const {
  illustrationDirectorActivity, buildVisualBible, buildSpreadSpecs, buildStoryBible, collectVisualFacts,
} = require('../../../services/bookPipelineV3/orchestration/activities/illustrationDirector');
const { normalizeManuscript } = require('../../../services/bookPipelineV3/schema/document');
const { PRESCHOOL_PROFILE, BRIEF, RAW_REQUEST, makeConceptJson, makeManuscriptJson } = require('./helpers/fixtures');

const ctx = { log: jest.fn(), bookId: 'test-book-1' };

function manuscriptWithCaregiver() {
  const raw = makeManuscriptJson(4);
  raw.spreads[2].scene_contract.characters_present = ['Zoe', 'Mama'];
  raw.spreads[2].scene_contract.key_objects = ['red bucket', 'striped towel'];
  return normalizeManuscript(raw, { id: 'A', expectedSpreads: 4 });
}

beforeEach(() => {
  renderAllSpreadsQuad.mockReset();
  ctx.log.mockClear();
});

describe('collectVisualFacts', () => {
  test('recurring props = key_objects on >=2 spreads; cast excludes the hero', () => {
    const m = manuscriptWithCaregiver();
    const facts = collectVisualFacts(m, 'Zoe');
    expect(facts.recurringProps.map((p) => p.name)).toContain('red bucket'); // on all spreads
    expect(facts.recurringProps.map((p) => p.name)).not.toContain('striped towel'); // only spread 3
    expect(facts.supportingCast.map((c) => c.name)).toEqual(['Mama']);
    expect(facts.supportingCast[0].isThemedParent).toBe(true);
    expect(facts.environmentAnchors.length).toBeGreaterThan(0);
  });
});

describe('buildSpreadSpecs', () => {
  test('maps scene_contract fields onto the v1 spec shape', () => {
    const m = manuscriptWithCaregiver();
    const specs = buildSpreadSpecs({ manuscript: m, ageProfile: PRESCHOOL_PROFILE });
    expect(specs).toHaveLength(4);
    const s1 = specs[0];
    expect(s1.focalAction).toBe(m.spreads[0].scene_contract.hero_action);
    expect(s1.location).toBe(m.spreads[0].scene_contract.setting);
    expect(s1.emotionalBeat).toBe('wonder');
    expect(s1.proseProps).toEqual(['red bucket']);
    expect(s1.mustUseDetails.join(' ')).toContain('red bucket');
    // refrain marker lands where refrain_here is true (spread 1 in fixtures)
    expect(s1.mustUseDetails.join(' ')).toContain('refrain moment');
  });

  test('caregiver in characters_present maps to a visible parentVisibility; absent maps to band default', () => {
    const m = manuscriptWithCaregiver();
    const specs = buildSpreadSpecs({ manuscript: m, ageProfile: PRESCHOOL_PROFILE });
    expect(specs[2].parentVisibility).toBe('full'); // Mama listed; illustrator guard demotes if off-cover
    expect(specs[0].parentVisibility).toBe('object'); // PB_PRESCHOOL default
  });

  test('arcContext threads neighboring hero actions', () => {
    const m = manuscriptWithCaregiver();
    const specs = buildSpreadSpecs({ manuscript: m, ageProfile: PRESCHOOL_PROFILE });
    expect(specs[1].arcContext.whatJustHappened).toBe(m.spreads[0].scene_contract.hero_action);
    expect(specs[1].arcContext.whatComesNext).toBe(m.spreads[2].scene_contract.hero_action);
  });
});

describe('buildStoryBible', () => {
  test('narrativeSpine is a STRING (toLegacyStoryPlan String()s it into the synopsis)', () => {
    const m = manuscriptWithCaregiver();
    const sb = buildStoryBible({ concept: makeConceptJson('a1'), manuscript: m });
    expect(typeof sb.narrativeSpine).toBe('string');
    expect(sb.narrativeSpine.length).toBeGreaterThan(10);
    expect(sb.title).toBe(m.title);
  });
});

describe('illustrationDirectorActivity', () => {
  test('seeds mandatory qa blocks and hands a v1-shaped doc to the renderer', async () => {
    renderAllSpreadsQuad.mockImplementation(async (doc) => doc);
    const m = manuscriptWithCaregiver();
    const rendered = await illustrationDirectorActivity({
      rawRequest: RAW_REQUEST, brief: BRIEF, ageProfile: PRESCHOOL_PROFILE,
      concept: makeConceptJson('a1'), manuscript: m,
      coverImageUrl: RAW_REQUEST.cover.imageUrl, coverTitle: RAW_REQUEST.cover.title,
      operationalContext: {},
    }, ctx);

    const doc = renderAllSpreadsQuad.mock.calls[0][0];
    expect(doc.spreads).toHaveLength(4);
    for (const s of doc.spreads) {
      expect(s.qa).toEqual({ writerChecks: [], spreadChecks: [], repairHistory: [] });
      expect(s.manuscript.text).toBeTruthy();
      expect(s.illustration).toBeNull();
      expect(s.spec.spreadNumber).toBe(s.spreadNumber);
    }
    expect(doc.visualBible.hero.name).toBe('Zoe');
    expect(doc.cover.title).toBe(m.title);
    expect(rendered.spreads).toHaveLength(4);
  });

  test('tags transient infra errors so the engine can retry', async () => {
    renderAllSpreadsQuad.mockRejectedValueOnce(new Error('Session API error 503: UNAVAILABLE'));
    const m = manuscriptWithCaregiver();
    await expect(illustrationDirectorActivity({
      rawRequest: RAW_REQUEST, brief: BRIEF, ageProfile: PRESCHOOL_PROFILE,
      concept: makeConceptJson('a1'), manuscript: m,
      coverImageUrl: null, coverTitle: null, operationalContext: {},
    }, ctx)).rejects.toMatchObject({ isTransient: true });
  });

  // P2 (audit 2026-07-15): QA-budget exhaustion routes to the review queue
  // instead of dying as a bare failure — the workflow maps err.needsReview
  // to a needs_review terminal state (design D6).
  test('spread_unresolvable exhaustion attaches a needs_review payload', async () => {
    const exhausted = new Error('spreads 5-6: spread pair exhausted repair budget');
    exhausted.failureCode = 'spread_unresolvable';
    exhausted.exhaustion = {
      spreads: [5, 6],
      tags: ['text_crosses_midline', 'hero_mismatch'],
      issues: ['Text block extends past the active-side boundary'],
    };
    renderAllSpreadsQuad.mockRejectedValueOnce(exhausted);
    const m = manuscriptWithCaregiver();
    let caught;
    try {
      await illustrationDirectorActivity({
        rawRequest: RAW_REQUEST, brief: BRIEF, ageProfile: PRESCHOOL_PROFILE,
        concept: makeConceptJson('a1'), manuscript: m,
        coverImageUrl: null, coverTitle: null, operationalContext: {},
      }, ctx);
    } catch (err) { caught = err; }
    expect(caught).toBeTruthy();
    expect(caught.needsReview).toMatchObject({
      stage: 'illustration',
      reason: 'spread_qa_exhausted',
      spread: 5,
    });
    expect(caught.needsReview.defects.join(' ')).toContain('text_crosses_midline');
    expect(caught.needsReview.defects.join(' ')).toContain('Spread(s) 5, 6');
    expect(caught.isTransient).toBeFalsy();
  });

  test('transient errors never get a needs_review payload (retry instead)', async () => {
    const transientErr = new Error('Deadline expired');
    transientErr.failureCode = 'spread_unresolvable'; // pathological combo — transient wins
    renderAllSpreadsQuad.mockRejectedValueOnce(transientErr);
    const m = manuscriptWithCaregiver();
    let caught;
    try {
      await illustrationDirectorActivity({
        rawRequest: RAW_REQUEST, brief: BRIEF, ageProfile: PRESCHOOL_PROFILE,
        concept: makeConceptJson('a1'), manuscript: m,
        coverImageUrl: null, coverTitle: null, operationalContext: {},
      }, ctx);
    } catch (err) { caught = err; }
    expect(caught.isTransient).toBe(true);
    expect(caught.needsReview).toBeUndefined();
  });
});
