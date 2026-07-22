/**
 * P1 (2026-07-23 audit): hero-presence validation + deterministic repair.
 * "Amit's Star Map Adventure" shipped the hero missing from 12/13 spreads.
 */

const {
  HERO_PRESENCE_VALUES,
  MAX_HERO_LIGHT_SPREADS,
  isActionSpread,
  normalizeHeroPresence,
  validateHeroPresence,
  reassignHeroPresence,
} = require('../../../services/bookPipelineV3/illustrator/artDirection/heroPresence');

describe('isActionSpread', () => {
  test('a real hero action counts', () => {
    expect(isActionSpread({ hero_action: 'climbs the ladder' })).toBe(true);
  });
  test('empty / scene-only / establishing sentinels do not', () => {
    expect(isActionSpread({ hero_action: '' })).toBe(false);
    expect(isActionSpread({ hero_action: 'none' })).toBe(false);
    expect(isActionSpread({ hero_action: 'scene only' })).toBe(false);
    expect(isActionSpread({ hero_action: 'establishing shot of the valley' })).toBe(false);
    expect(isActionSpread(null)).toBe(false);
  });
});

describe('normalizeHeroPresence', () => {
  test('valid enum values pass through', () => {
    for (const v of HERO_PRESENCE_VALUES) {
      expect(normalizeHeroPresence(v, {})).toBe(v);
    }
    expect(normalizeHeroPresence('REQUIRED', {})).toBe('required');
  });
  test('missing/invalid falls back from the scene contract', () => {
    expect(normalizeHeroPresence(undefined, { hero_action: 'jumps' })).toBe('required');
    expect(normalizeHeroPresence('bogus', { hero_action: '' })).toBe('optional');
  });
});

describe('validateHeroPresence', () => {
  test('an action spread staged hero-absent is a violation', () => {
    const { ok, violations } = validateHeroPresence([
      { spread: 3, heroPresence: 'absent', isAction: true },
    ]);
    expect(ok).toBe(false);
    expect(violations[0]).toContain('spread 3');
    expect(violations[0]).toContain('hero-absent');
  });

  test('more hero-light spreads than the budget is a violation', () => {
    const rows = [1, 2, 3, 4].map((n) => ({ spread: n, heroPresence: 'optional', isAction: false }));
    const { ok, violations } = validateHeroPresence(rows);
    expect(ok).toBe(false);
    expect(violations.some((v) => v.includes(`budget of ${MAX_HERO_LIGHT_SPREADS}`))).toBe(true);
  });

  test('within budget and no action-absent spreads passes', () => {
    const rows = [
      { spread: 1, heroPresence: 'optional', isAction: false },
      { spread: 2, heroPresence: 'required', isAction: true },
      { spread: 3, heroPresence: 'absent', isAction: false },
    ];
    expect(validateHeroPresence(rows).ok).toBe(true);
  });
});

describe('reassignHeroPresence (deterministic repair)', () => {
  test('forces every action spread to required', () => {
    const out = reassignHeroPresence([
      { spread: 1, heroPresence: 'absent', isAction: true },
      { spread: 2, heroPresence: 'optional', isAction: false },
    ]);
    expect(out[0]).toEqual({ spread: 1, heroPresence: 'required', reassigned: true });
    expect(out[1].heroPresence).toBe('optional');
  });

  test('trims the hero-light budget from the END so the climax is never hero-absent', () => {
    const rows = [1, 2, 3, 4, 5].map((n) => ({ spread: n, heroPresence: 'optional', isAction: false }));
    const out = reassignHeroPresence(rows);
    const light = out.filter((r) => r.heroPresence !== 'required');
    expect(light.length).toBeLessThanOrEqual(MAX_HERO_LIGHT_SPREADS);
    // the earliest establishing beats stay light; the later ones are promoted
    expect(out[0].heroPresence).toBe('optional');
    expect(out[4].heroPresence).toBe('required');
  });
});
