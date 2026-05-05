/**
 * PR K — parent-theme picture books derive age from birth date.
 */
const { resolveEffectiveAge } = require('../../services/effectiveAge');

describe('PR K: resolveEffectiveAge', () => {
  describe('parent themes (Mother\'s Day / Father\'s Day)', () => {
    test('lap baby (8mo) with stale childAge=2 routes to celebrationAge=0', () => {
      const out = resolveEffectiveAge({
        theme: 'mothers_day',
        birthDateRaw: '2025-08-26',
        childAge: 2,
        celebrationAge: 0,
      });
      expect(out.age).toBe(0);
      expect(out.source).toBe('celebrationAge');
    });

    test('father\'s day with same shape: birth date wins', () => {
      const out = resolveEffectiveAge({
        theme: 'fathers_day',
        birthDateRaw: '2025-08-26',
        childAge: 3,
        celebrationAge: 0,
      });
      expect(out.age).toBe(0);
      expect(out.source).toBe('celebrationAge');
    });

    test('parent theme without birth date falls back to childAge (no regression)', () => {
      const out = resolveEffectiveAge({
        theme: 'mothers_day',
        birthDateRaw: null,
        childAge: 4,
        celebrationAge: 5,
      });
      expect(out.age).toBe(4);
      expect(out.source).toBe('childAge');
    });

    test('parent theme where childAge already matches birth date: no-op', () => {
      const out = resolveEffectiveAge({
        theme: 'mothers_day',
        birthDateRaw: '2020-01-01',
        childAge: 6,
        celebrationAge: 6,
      });
      expect(out.age).toBe(6);
      expect(out.source).toBe('celebrationAge');
    });
  });

  describe('birthday themes (existing behaviour preserved)', () => {
    test('birthday + birth date: celebrationAge wins (existing behaviour)', () => {
      const out = resolveEffectiveAge({
        theme: 'birthday',
        birthDateRaw: '2020-01-01',
        childAge: 5,
        celebrationAge: 6,
      });
      expect(out.age).toBe(6);
      expect(out.source).toBe('celebrationAge');
    });

    test('birthday_magic + birth date: celebrationAge wins', () => {
      const out = resolveEffectiveAge({
        theme: 'birthday_magic',
        birthDateRaw: '2020-01-01',
        childAge: 5,
        celebrationAge: 6,
      });
      expect(out.age).toBe(6);
      expect(out.source).toBe('celebrationAge');
    });

    test('birthday without birth date: childAge wins (existing fallback)', () => {
      const out = resolveEffectiveAge({
        theme: 'birthday',
        birthDateRaw: null,
        childAge: 5,
        celebrationAge: 5,
      });
      expect(out.age).toBe(5);
      expect(out.source).toBe('childAge');
    });
  });

  describe('non-birthday non-parent themes (no regression)', () => {
    test('adventure theme with birth date: childAge wins (PR K does NOT touch adventure)', () => {
      const out = resolveEffectiveAge({
        theme: 'adventure',
        birthDateRaw: '2020-01-01',
        childAge: 5,
        celebrationAge: 6,
      });
      expect(out.age).toBe(5);
      expect(out.source).toBe('childAge');
    });

    test('emotional theme: childAge wins', () => {
      const out = resolveEffectiveAge({
        theme: 'separation_anxiety',
        birthDateRaw: '2020-01-01',
        childAge: 5,
        celebrationAge: 6,
      });
      expect(out.age).toBe(5);
      expect(out.source).toBe('childAge');
    });

    test('unknown theme: childAge wins', () => {
      const out = resolveEffectiveAge({
        theme: 'made_up_theme',
        birthDateRaw: '2020-01-01',
        childAge: 7,
        celebrationAge: 8,
      });
      expect(out.age).toBe(7);
      expect(out.source).toBe('childAge');
    });
  });

  describe('regression scenarios specific to the bug', () => {
    test('exact bug: Everleigh 8mo with childAge=2 mothers_day book', () => {
      // birth_date=2025-08-26, today=2026-05-05 -> 0 full years
      // client sent childAge=2 (stale)
      const out = resolveEffectiveAge({
        theme: 'mothers_day',
        birthDateRaw: '2025-08-26',
        childAge: 2,
        celebrationAge: 0,
      });
      expect(out.age).toBe(0);
      // age=0 will route to PB_INFANT downstream, which is the whole point
    });

    test('childAge=0 lap baby with birth date: also routes to celebrationAge=0', () => {
      const out = resolveEffectiveAge({
        theme: 'mothers_day',
        birthDateRaw: '2025-08-26',
        childAge: 0,
        celebrationAge: 0,
      });
      expect(out.age).toBe(0);
      expect(out.source).toBe('celebrationAge');
    });
  });
});
