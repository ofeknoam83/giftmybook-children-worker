/**
 * ThemeRouter — maps theme string to ThemeWriter instance.
 *
 * Returns null for unsupported themes, which triggers legacy fallback
 * in the /generate-book endpoint.
 */

const { MothersDayWriter } = require('./mothers_day');

const THEME_WRITERS = {
  mothers_day: new MothersDayWriter(),
  // Future themes:
  // birthday: new BirthdayWriter(),
  // adventure: new AdventureWriter(),
  // fathers_day: new FathersDayWriter(),
};

/**
 * Get the theme writer for a given theme.
 * @param {string} theme
 * @returns {BaseThemeWriter|null} null means "use legacy code"
 */
function getThemeWriter(theme) {
  return THEME_WRITERS[theme] || null;
}

module.exports = { getThemeWriter, THEME_WRITERS };
