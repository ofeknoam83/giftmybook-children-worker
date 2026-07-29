/**
 * Occasion + story-theme vocabulary: normalization, legacy-`theme`
 * classification, and the prompt directive builders.
 */

const {
  normalizeOccasion,
  normalizeStoryTheme,
  resolveThemeAxes,
  buildThemeDirective,
  buildThemeArtNote,
  CANONICAL_OCCASIONS,
  CANONICAL_STORY_THEMES,
  OCCASION_GUIDES,
  STORY_THEME_GUIDES,
  LEGACY_THEME_FOR_OCCASION,
} = require('../../../services/shared/themes');

describe('normalizeOccasion', () => {
  test('accepts canonical keys', () => {
    for (const key of CANONICAL_OCCASIONS) {
      expect(normalizeOccasion(key)).toBe(key);
    }
  });

  test('maps UI labels regardless of case/punctuation', () => {
    expect(normalizeOccasion('Bedtime Story')).toBe('bedtime_wonder');
    expect(normalizeOccasion("Father's Day")).toBe('fathers_day');
    expect(normalizeOccasion('Love to mom')).toBe('mothers_day');
    expect(normalizeOccasion('BIRTHDAY_MAGIC')).toBe('birthday_magic');
  });

  test('returns null for unknown or empty values', () => {
    expect(normalizeOccasion('space')).toBeNull();
    expect(normalizeOccasion('adventure')).toBeNull(); // bare 'adventure' is a story theme
    expect(normalizeOccasion('')).toBeNull();
    expect(normalizeOccasion(null)).toBeNull();
    expect(normalizeOccasion(undefined)).toBeNull();
  });
});

describe('normalizeStoryTheme', () => {
  test('accepts all canonical story themes case-insensitively', () => {
    for (const key of CANONICAL_STORY_THEMES) {
      expect(normalizeStoryTheme(key)).toBe(key);
      expect(normalizeStoryTheme(key.toUpperCase())).toBe(key);
    }
  });

  test('maps common variants', () => {
    expect(normalizeStoryTheme('Outer Space')).toBe('space');
    expect(normalizeStoryTheme('ocean')).toBe('underwater');
    expect(normalizeStoryTheme('magic')).toBe('fantasy');
  });

  test('returns null for occasions and unknowns', () => {
    expect(normalizeStoryTheme('mothers_day')).toBeNull();
    expect(normalizeStoryTheme('horror')).toBeNull();
    expect(normalizeStoryTheme(null)).toBeNull();
  });
});

describe('resolveThemeAxes', () => {
  test('explicit fields win over legacy theme', () => {
    expect(resolveThemeAxes({ occasion: 'birthday_magic', storyTheme: 'space', theme: 'adventure_play' }))
      .toEqual({ occasion: 'birthday_magic', storyTheme: 'space' });
  });

  test('classifies a legacy occasion-shaped theme as occasion', () => {
    // The main app historically sent occasionTheme under `theme` — the
    // exact shadowing bug this module exists to fix.
    expect(resolveThemeAxes({ theme: 'bedtime_wonder' }))
      .toEqual({ occasion: 'bedtime_wonder', storyTheme: null });
    expect(resolveThemeAxes({ theme: 'mothers_day' }))
      .toEqual({ occasion: 'mothers_day', storyTheme: null });
  });

  test('classifies a legacy story-theme-shaped theme as storyTheme', () => {
    expect(resolveThemeAxes({ theme: 'underwater' }))
      .toEqual({ occasion: null, storyTheme: 'underwater' });
    expect(resolveThemeAxes({ theme: 'adventure' }))
      .toEqual({ occasion: null, storyTheme: 'adventure' });
  });

  test('unknown values resolve to nulls', () => {
    expect(resolveThemeAxes({ theme: 'anxiety' })).toEqual({ occasion: null, storyTheme: null });
    expect(resolveThemeAxes({})).toEqual({ occasion: null, storyTheme: null });
  });
});

describe('guides', () => {
  test('every canonical key has a guide with the fields the prompts read', () => {
    for (const key of CANONICAL_OCCASIONS) {
      expect(OCCASION_GUIDES[key]).toBeDefined();
      expect(OCCASION_GUIDES[key].label).toBeTruthy();
      expect(OCCASION_GUIDES[key].story).toBeTruthy();
      expect(OCCASION_GUIDES[key].art).toBeTruthy();
    }
    for (const key of CANONICAL_STORY_THEMES) {
      expect(STORY_THEME_GUIDES[key]).toBeDefined();
      expect(STORY_THEME_GUIDES[key].label).toBeTruthy();
      expect(STORY_THEME_GUIDES[key].world).toBeTruthy();
      expect(STORY_THEME_GUIDES[key].energy).toBeTruthy();
      expect(STORY_THEME_GUIDES[key].art).toBeTruthy();
    }
  });

  test('every occasion maps to a legacy theme for the single-theme machinery', () => {
    for (const key of CANONICAL_OCCASIONS) {
      expect(LEGACY_THEME_FOR_OCCASION[key]).toBeTruthy();
    }
  });

  test('guides never mention a rendering medium (the style bible owns it)', () => {
    // D5-adjacent guard: theme guides steer content/palette, never medium.
    const all = JSON.stringify({ OCCASION_GUIDES, STORY_THEME_GUIDES }).toLowerCase();
    for (const banned of ['watercolor', '2d', 'flat illustration', 'painterly', 'photograph']) {
      expect(all).not.toContain(banned);
    }
  });
});

describe('buildThemeDirective', () => {
  test('composes occasion + storyTheme + fuse instruction', () => {
    const d = buildThemeDirective({ occasion: 'birthday_magic', storyTheme: 'space' });
    expect(d).toContain('OCCASION — Birthday');
    expect(d).toContain('STORY THEME — Space');
    expect(d).toContain('FUSE THEM');
  });

  test('single axis omits the fuse instruction', () => {
    const d = buildThemeDirective({ storyTheme: 'underwater' });
    expect(d).toContain('STORY THEME — Underwater');
    expect(d).not.toContain('FUSE THEM');
    expect(d).not.toContain('OCCASION');
  });

  test('returns null when neither axis resolves', () => {
    expect(buildThemeDirective({})).toBeNull();
    expect(buildThemeDirective({ occasion: null, storyTheme: null })).toBeNull();
  });
});

describe('buildThemeArtNote', () => {
  test('composes both art hints', () => {
    const note = buildThemeArtNote({ occasion: 'bedtime_wonder', storyTheme: 'space' });
    expect(note).toContain("story theme 'Space'");
    expect(note).toContain("occasion 'Bedtime Story'");
  });

  test('returns null with no axes', () => {
    expect(buildThemeArtNote({})).toBeNull();
  });
});
