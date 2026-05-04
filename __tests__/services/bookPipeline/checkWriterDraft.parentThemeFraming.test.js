const {
  findParentThemePeerFraming,
} = require('../../../services/bookPipeline/qa/checkWriterDraft');

describe('findParentThemePeerFraming (PR D / D.5)', () => {
  test('flags "best friends" on a Mother\'s Day book', () => {
    const out = findParentThemePeerFraming('Mama and me, best friends.', 'mothers_day');
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].toLowerCase()).toBe('best friends');
  });

  test('flags "best friend" (singular) on Father\'s Day', () => {
    const out = findParentThemePeerFraming('Dada is my best friend.', 'fathers_day');
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].toLowerCase()).toBe('best friend');
  });

  test('flags "buddies" on Grandparents\' Day', () => {
    const out = findParentThemePeerFraming('Grandpa and me, buddies for life.', 'grandparents_day');
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].toLowerCase()).toBe('buddies');
  });

  test('flags "best buds" and "besties"', () => {
    expect(findParentThemePeerFraming('Mama and me, best buds.', 'mothers_day').length).toBeGreaterThan(0);
    expect(findParentThemePeerFraming('Mama and me, besties.', 'mothers_day').length).toBeGreaterThan(0);
  });

  test('does NOT flag the same phrases for non-parent themes', () => {
    expect(findParentThemePeerFraming('Best friends forever!', 'birthday')).toEqual([]);
    expect(findParentThemePeerFraming('Best friends forever!', 'first_day_of_school')).toEqual([]);
    expect(findParentThemePeerFraming('Best friends forever!', undefined)).toEqual([]);
  });

  test('does NOT flag normal parent-theme language', () => {
    expect(findParentThemePeerFraming('Mama is my hero.', 'mothers_day')).toEqual([]);
    expect(findParentThemePeerFraming('Dada holds me close.', 'fathers_day')).toEqual([]);
  });

  test('does not double-report the same phrase', () => {
    const out = findParentThemePeerFraming(
      'Best friends here. Best friends there. Best friends everywhere.',
      'mothers_day',
    );
    expect(out.length).toBe(1);
  });
});
