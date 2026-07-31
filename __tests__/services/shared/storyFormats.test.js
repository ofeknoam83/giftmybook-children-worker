/**
 * Story formats (AI Writer Guidelines Step 4): normalization, the smart
 * default resolver, and the prompt directive builder.
 */

const {
  STORY_FORMATS,
  FORMAT_GUIDES,
  normalizeStoryFormat,
  resolveStoryFormat,
  buildFormatDirective,
} = require('../../../services/shared/storyFormats');

describe('normalizeStoryFormat', () => {
  test('accepts canonical keys case-insensitively', () => {
    for (const key of STORY_FORMATS) {
      expect(normalizeStoryFormat(key)).toBe(key);
      expect(normalizeStoryFormat(key.toUpperCase())).toBe(key);
    }
  });

  test('maps UI labels and variants', () => {
    expect(normalizeStoryFormat('Love Story')).toBe('love_story');
    expect(normalizeStoryFormat('Classic fairy tale')).toBe('classic');
    expect(normalizeStoryFormat('fairy-tale')).toBe('classic');
    expect(normalizeStoryFormat('Super Hero')).toBe('superhero');
  });

  test('returns null for unknown/empty values', () => {
    expect(normalizeStoryFormat('horror')).toBeNull();
    expect(normalizeStoryFormat('')).toBeNull();
    expect(normalizeStoryFormat(null)).toBeNull();
    expect(normalizeStoryFormat(undefined)).toBeNull();
  });
});

describe('resolveStoryFormat', () => {
  test('a valid requested format always wins', () => {
    expect(resolveStoryFormat({ requested: 'superhero', occasion: 'mothers_day', ageYears: 3 }))
      .toEqual({ format: 'superhero', source: 'requested' });
  });

  test('parent-day occasions default to love_story', () => {
    expect(resolveStoryFormat({ occasion: 'mothers_day', ageYears: 6 }))
      .toEqual({ format: 'love_story', source: 'occasion_default' });
    expect(resolveStoryFormat({ occasion: 'fathers_day', ageYears: 3 }))
      .toEqual({ format: 'love_story', source: 'occasion_default' });
  });

  test('age <= 4 defaults to classic, else adventure', () => {
    expect(resolveStoryFormat({ ageYears: 3 })).toEqual({ format: 'classic', source: 'age_default' });
    expect(resolveStoryFormat({ ageYears: 4 })).toEqual({ format: 'classic', source: 'age_default' });
    expect(resolveStoryFormat({ ageYears: 5 })).toEqual({ format: 'adventure', source: 'default' });
    expect(resolveStoryFormat({})).toEqual({ format: 'adventure', source: 'default' });
    expect(resolveStoryFormat({ ageYears: null })).toEqual({ format: 'adventure', source: 'default' });
  });

  test('an invalid requested value falls through to the defaults', () => {
    expect(resolveStoryFormat({ requested: 'horror', occasion: 'fathers_day' }).format).toBe('love_story');
    expect(resolveStoryFormat({ requested: 'horror', ageYears: 8 }).format).toBe('adventure');
  });
});

describe('FORMAT_GUIDES', () => {
  test('every format has the fields the directive builder reads', () => {
    for (const key of STORY_FORMATS) {
      expect(FORMAT_GUIDES[key].label).toBeTruthy();
      expect(FORMAT_GUIDES[key].opener).toBeTruthy();
      expect(FORMAT_GUIDES[key].tone).toBeTruthy();
      expect(FORMAT_GUIDES[key].framing).toBeTruthy();
    }
  });
});

describe('buildFormatDirective', () => {
  test('carries the opener, the tone, and the fixed-skeleton boundary', () => {
    const d = buildFormatDirective('superhero', {});
    expect(d).toContain('In the city of');
    expect(d).toContain('bold, theatrical');
    expect(d).toContain('non-negotiable');
  });

  test('composes with the ordered story theme', () => {
    const d = buildFormatDirective('superhero', { storyTheme: 'space' });
    expect(d).toContain('space');
    expect(d).toContain('space city');
  });

  test('love_story without a named parent degrades to family warmth', () => {
    const d = buildFormatDirective('love_story', { hasSidekick: false });
    expect(d).toContain('never invent a named parent');
    // With a named parent the clause is absent.
    expect(buildFormatDirective('love_story', { hasSidekick: true })).not.toContain('never invent a named parent');
  });

  test('returns null for unknown formats', () => {
    expect(buildFormatDirective('horror', {})).toBeNull();
  });
});
