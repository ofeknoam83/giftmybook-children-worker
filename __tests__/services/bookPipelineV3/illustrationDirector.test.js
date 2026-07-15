// Builder tests only — the legacy illustrationDirectorActivity (V3→v1 quad
// adapter) was deleted in the native-illustrator cutover; the pure builders
// survive because the native illustrator derives its inputs from them.
const {
  buildSpreadSpecs, buildStoryBible, collectVisualFacts,
} = require('../../../services/bookPipelineV3/orchestration/activities/illustrationDirector');
const { normalizeManuscript } = require('../../../services/bookPipelineV3/schema/document');
const { PRESCHOOL_PROFILE, makeConceptJson, makeManuscriptJson } = require('./helpers/fixtures');

function manuscriptWithCaregiver() {
  const raw = makeManuscriptJson(4);
  raw.spreads[2].scene_contract.characters_present = ['Zoe', 'Mama'];
  raw.spreads[2].scene_contract.key_objects = ['red bucket', 'striped towel'];
  return normalizeManuscript(raw, { id: 'A', expectedSpreads: 4 });
}

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

