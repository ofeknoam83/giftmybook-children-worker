/**
 * ThemeRouter — maps theme string to ThemeWriter instance.
 *
 * All themes use GenericThemeWriter (parent holidays, birthdays, adventures, etc.).
 */

const { GenericThemeWriter } = require('./generic');

/**
 * Deprecated: kept empty for callers that destructured legacy specialized writers.
 * @type {Record<string, import('./base').BaseThemeWriter>}
 */
const THEME_WRITERS = {};

/**
 * Get the theme writer for a given theme.
 * @param {string} theme
 * @returns {import('./base').BaseThemeWriter}
 */
function getThemeWriter(theme) {
  return new GenericThemeWriter(theme);
}

module.exports = { getThemeWriter, THEME_WRITERS };
