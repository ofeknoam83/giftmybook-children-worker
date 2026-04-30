const { getThemeWriter, THEME_WRITERS } = require('../../../../services/writer/themes/index');
const { GenericThemeWriter } = require('../../../../services/writer/themes/generic');

describe('getThemeWriter', () => {
  test('routes mothers_day to GenericThemeWriter with parent category', () => {
    const w = getThemeWriter('mothers_day');
    expect(w).toBeInstanceOf(GenericThemeWriter);
    expect(w.themeName).toBe('mothers_day');
    expect(w.category).toBe('parent');
  });

  test('routes fathers_day to GenericThemeWriter with parent category', () => {
    const w = getThemeWriter('fathers_day');
    expect(w).toBeInstanceOf(GenericThemeWriter);
    expect(w.themeName).toBe('fathers_day');
    expect(w.category).toBe('parent');
  });

  test('non-parent themes still use GenericThemeWriter', () => {
    expect(getThemeWriter('birthday')).toBeInstanceOf(GenericThemeWriter);
    expect(getThemeWriter('birthday').category).toBe('celebration');
  });

  test('THEME_WRITERS stays empty legacy export', () => {
    expect(THEME_WRITERS).toEqual({});
  });
});
