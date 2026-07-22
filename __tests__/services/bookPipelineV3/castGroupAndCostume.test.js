/**
 * Two prompt-contract fixes (2026-07-22, book 20d4fd6e space/astronaut theme):
 *   1. GROUP/collective cast members — a declared crowd ("small aliens") is no
 *      longer counted as "exactly 1", so a realistic group stops failing as
 *      extra_character.
 *   2. Costume/tech displays (chest panels, HUDs, wrist devices) render only
 *      wordless indicators — pre-empts the D5 lettering auto-fail from
 *      astronaut-suit readouts ("88:88", "ERROR").
 */

const { formatCastList, isGroupMember } = require('../../../services/bookPipelineV3/illustrator/promptFormat');
const { buildSpreadJudgePrompt } = require('../../../services/bookPipelineV3/illustrator/qa/spreadJudge');
const { buildSpreadRenderPrompt } = require('../../../services/bookPipelineV3/illustrator/render/renderSpread');
const { buildDirectorPrompt } = require('../../../services/bookPipelineV3/illustrator/artDirection/artDirector');

describe('formatCastList — group/collective cast (Fix 1)', () => {
  test('a purely-singular cast still renders "exactly N, nobody else" (unchanged)', () => {
    expect(formatCastList(['Zoe'])).toBe('(exactly 1, nobody else): [1] Zoe — the child hero');
    expect(formatCastList(['Amit', 'a magical turtle'])).toBe(
      '(exactly 2, nobody else): [1] Amit — the child hero; [2] a magical turtle',
    );
  });

  test('empty cast falls back to the single-child default', () => {
    expect(formatCastList([])).toBe('(exactly 1, nobody else): [1] the child — the child hero');
    expect(formatCastList(undefined)).toBe('(exactly 1, nobody else): [1] the child — the child hero');
  });

  test('a plural/collective string is detected as a group and does NOT increment the enforced count', () => {
    const line = formatCastList(['Amit', 'small aliens']);
    // The hero is still enforced as exactly one...
    expect(line).toContain('[1] Amit — the child hero (exactly one)');
    // ...the group is allowed to be many and is not counted.
    expect(line).toContain('a small group of small aliens (a background cluster, 2-5, exact count not enforced)');
    expect(line).toContain('No OTHER named individuals');
    // Never claims a rigid total count.
    expect(line).not.toContain('exactly 2, nobody else');
  });

  test('an explicit structured group flag is honored regardless of the label', () => {
    const line = formatCastList(['Amit', { name: 'the robot crew', group: true }]);
    expect(line).toContain('a small group of the robot crew');
    expect(line).not.toContain('exactly 2');

    const byCount = formatCastList(['Amit', { name: 'onlookers', count: 'many' }]);
    expect(byCount).toContain('a small group of onlookers');
  });

  test('"a group of ..." phrasing triggers the group path', () => {
    const line = formatCastList(['Mia', 'a group of forest creatures']);
    expect(line).toContain('a small group of a group of forest creatures');
    expect(line).not.toContain('exactly 2, nobody else');
  });

  test('isGroupMember: structured flag + heuristic; singular names are not groups', () => {
    expect(isGroupMember({ name: 'x', group: true })).toBe(true);
    expect(isGroupMember({ name: 'x', count: 'many' })).toBe(true);
    expect(isGroupMember('aliens')).toBe(true);
    expect(isGroupMember('a crowd of penguins')).toBe(true);
    expect(isGroupMember('Amit')).toBe(false);
    expect(isGroupMember('a magical turtle')).toBe(false);
    expect(isGroupMember({ name: 'Gus' })).toBe(false); // trailing-s name is not a plural
  });
});

describe('spreadJudge cast scoring — declared groups (Fix 1)', () => {
  const withGroup = { setting: 'moon base', characters_present: ['Amit', 'small aliens'], hero_action: 'greeting them', emotion: 'joy' };
  const singular = { setting: 'garden', characters_present: ['Zoe'], hero_action: 'planting', emotion: 'proud' };

  test('a declared group is explicitly allowed to show several members and never tagged extra_character', () => {
    const p = buildSpreadJudgePrompt({ sceneContract: withGroup });
    expect(p).toContain('a small group of small aliens (a background cluster, 2-5, exact count not enforced)');
    expect(p).toContain('DECLARED GROUP');
    expect(p).toContain('never emit the extra_character tag');
    expect(p).toContain('Cast counts NAMED individuals only');
  });

  test('a stranger / duplicated hero still caps cast at 1 (hard fail preserved)', () => {
    const p = buildSpreadJudgePrompt({ sceneContract: singular });
    expect(p).toContain('duplicated hero or a wrong/extra NAMED individual caps cast at 1');
    // Singular cast keeps the strict count.
    expect(p).toContain('(exactly 1, nobody else): [1] Zoe — the child hero');
  });
});

describe('renderSpread prompt — costume/tech displays are wordless (Fix 2)', () => {
  const SPREAD = {
    spread: 9,
    text: 'line',
    scene_contract: { setting: 'spaceship cockpit', characters_present: ['Amit'], hero_action: 'piloting', emotion: 'brave', key_objects: ['spacesuit'] },
  };

  test('the D5 no-text clause is extended to costume/tech readouts', () => {
    const p = buildSpreadRenderPrompt({ spread: SPREAD, briefText: 'BRIEF' });
    expect(p).toContain('WORDLESS COSTUMES & TECH');
    expect(p).toContain('chest displays');
    expect(p).toContain('spacesuit instruments');
    expect(p).toContain('glowing dots, bars, rings, star-glyphs, abstract icons');
    expect(p).toContain('NEVER digits, numbers, clock readouts, or letters');
    // The original D5 clause is untouched.
    expect(p).toContain('ABSOLUTELY NO TEXT');
  });

  test('a group cast renders the group phrasing in the render prompt too', () => {
    const groupSpread = { ...SPREAD, scene_contract: { ...SPREAD.scene_contract, characters_present: ['Amit', 'small aliens'] } };
    const p = buildSpreadRenderPrompt({ spread: groupSpread, briefText: 'BRIEF' });
    expect(p).toContain('a small group of small aliens (a background cluster, 2-5, exact count not enforced)');
  });
});

describe('artDirector prompt — group cast + wearable tech (Fixes 1 & 2)', () => {
  const MS = {
    title: 'Space Trip',
    spreads: [{ spread: 1, scene_contract: { setting: 'moon', characters_present: ['Amit', 'small aliens'], hero_action: 'wave', emotion: 'joy' } }],
  };

  test('the director is told to mark crowd/collective cast as a GROUP', () => {
    const p = buildDirectorPrompt({ manuscript: MS, ageBand: 'PB_EARLY_READER' });
    expect(p).toContain('CAST GROUPS');
    expect(p).toContain('treat it as a GROUP');
    expect(p).toContain('never as one countable individual');
  });

  test('the WRITTEN LABELS/GEAR rule covers wearable tech / costume displays', () => {
    const p = buildDirectorPrompt({ manuscript: MS, ageBand: 'PB_EARLY_READER' });
    expect(p).toContain('WEARABLE TECH & COSTUME DISPLAYS');
    expect(p).toContain('astronaut chest control panel');
    expect(p).toContain('WORDLESS symbol indicators');
    expect(p).toContain('"88:88"/"ERROR"');
  });
});
