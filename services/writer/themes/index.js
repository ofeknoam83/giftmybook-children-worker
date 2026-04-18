/**
 * ThemeRouter — maps theme string to ThemeWriter instance.
 *
 * mothers_day has a specialized writer; every other theme uses
 * GenericThemeWriter. No theme returns null.
 */

const { MothersDayWriter } = require('./mothers_day');
const { FathersDayWriter } = require('./fathers_day');
const { GenericThemeWriter } = require('./generic');

const THEME_WRITERS = {
  mothers_day: new MothersDayWriter(),
  fathers_day: new FathersDayWriter(),
};

/**
 * Get the theme writer for a given theme.
 * @param {string} theme
 * @returns {BaseThemeWriter}
 */
function getThemeWriter(theme) {
  if (THEME_WRITERS[theme]) return THEME_WRITERS[theme];
  return new GenericThemeWriter(theme);
}

module.exports = { getThemeWriter, THEME_WRITERS };
