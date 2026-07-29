'use strict';

/**
 * Input-to-role mapping (2026-07-29 QA review rule 3: "Pre-map inputs to
 * roles before generation"). Deterministic — no LLM.
 */

const { buildStoryRoles, roleTokens, summarizeRolesForLog } = require('../../../services/bookPipelineV3/storyRoles');

describe('buildStoryRoles', () => {
  test('the Liv case: full mapping including calls_mom as the turning point', () => {
    const roles = buildStoryRoles({
      childAnecdotes: {
        favorite_activities: 'playing and swimming',
        funny_thing: '',
        calls_mom: 'calls everything mama',
        favorite_food: 'strawberries and bananas',
        mom_name: 'Alex',
        dad_name: 'Daniel',
      },
      childName: 'Liv',
    });
    expect(roles.tool.value).toBe('playing and swimming');
    expect(roles.tool.directive).toContain('TOOL');
    // funny_thing is empty → the calls_mom quirk IS the funny trait.
    expect(roles.turningPoint.source).toBe('calls_mom');
    expect(roles.turningPoint.directive).toContain('BEHAVIOUR');
    expect(roles.turningPoint.directive).toContain('NOT someone shouting');
    expect(roles.worldObject.value).toBe('strawberries and bananas');
    expect(roles.worldObject.directive).toContain('MID-STORY');
    expect(roles.finalScene.momName).toBe('Alex');
    expect(roles.finalScene.dadName).toBe('Daniel');
    expect(roles.homeBase.default).toBe(true);
  });

  test('funny_thing wins over calls_* when both exist', () => {
    const roles = buildStoryRoles({
      childAnecdotes: { funny_thing: 'spins in circles when happy', calls_mom: 'Mama', mom_name: 'Ruth' },
      childName: 'Marcos',
    });
    expect(roles.turningPoint.source).toBe('funny_thing');
    expect(roles.finalScene.callsMom).toBe('Mama');
  });

  test('interests back the tool role when favorite_activities is empty', () => {
    const roles = buildStoryRoles({
      childAnecdotes: { favorite_activities: '' },
      interests: ['race cars', 'football'],
      childName: 'Marcos',
    });
    expect(roles.tool.value).toBe('race cars, football');
  });

  test('empty strings mean "not provided" (sanitizeAnecdotes emits every key)', () => {
    const roles = buildStoryRoles({
      childAnecdotes: {
        favorite_activities: '', funny_thing: '  ', favorite_food: '', mom_name: '', dad_name: '', calls_mom: '',
      },
      childName: 'Liv',
    });
    expect(roles).toBeNull();
  });

  test('favorite_place fills homeBase; absence uses the warm default', () => {
    const withPlace = buildStoryRoles({
      childAnecdotes: { favorite_place: 'grandma’s garden', favorite_food: 'pancakes' },
      childName: 'Liv',
    });
    expect(withPlace.homeBase.default).toBe(false);
    expect(withPlace.homeBase.value).toContain('garden');
    const without = buildStoryRoles({ childAnecdotes: { favorite_food: 'pancakes' }, childName: 'Liv' });
    expect(without.homeBase.default).toBe(true);
    expect(without.homeBase.directive).toContain('choice, not a fallback');
  });

  test('no anecdotes and no interests → null (nothing to cast)', () => {
    expect(buildStoryRoles({})).toBeNull();
    expect(buildStoryRoles({ childAnecdotes: null, interests: [] })).toBeNull();
  });
});

describe('roleTokens', () => {
  test('drops stopwords and short tokens, keeps content words', () => {
    expect(roleTokens('playing and swimming')).toEqual(['swimming']);
    expect(roleTokens('strawberries and bananas')).toEqual(['strawberries', 'bananas']);
    expect(roleTokens('calls everything mama')).toEqual(['mama']);
  });
});

describe('summarizeRolesForLog', () => {
  test('compact one-liner', () => {
    const roles = buildStoryRoles({
      childAnecdotes: { favorite_food: 'pancakes', mom_name: 'Ruth' },
      childName: 'Marcos',
    });
    const s = summarizeRolesForLog(roles);
    expect(s).toContain("worldObject='pancakes'");
    expect(s).toContain('finalScene=[Ruth]');
    expect(summarizeRolesForLog(null)).toBe('none');
  });
});
