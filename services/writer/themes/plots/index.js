/**
 * Plot template registry — selects a random plot template for a given theme.
 *
 * Each theme has 10-12 structurally distinct story arcs. At generation time,
 * one is selected randomly (or by explicit plotId). The rest of the Writer V2
 * pipeline (enrichment, writing, revision) works unchanged.
 */

const THEME_PLOTS = {
  birthday:       require('./birthday'),
  birthday_magic: require('./birthday_magic'),
  adventure:      require('./adventure'),
  fantasy:        require('./fantasy'),
  space:          require('./space'),
  underwater:     require('./underwater'),
  nature:         require('./nature'),
  bedtime:        require('./bedtime'),
  school:         require('./school'),
  friendship:     require('./friendship'),
  holiday:        require('./holiday'),
  mothers_day:    require('./mothers_day'),
  fathers_day:    require('./fathers_day'),
};

/**
 * Select a plot template for the given theme.
 * @param {string} theme - e.g. 'birthday', 'adventure', 'mothers_day'
 * @param {object} [opts] - optional overrides
 * @param {string} [opts.plotId] - specific plot id to select (for testing/debugging)
 * @returns {{ id: string, name: string, synopsis: string, beats: Function } | null}
 */
function selectPlotTemplate(theme, opts = {}) {
  const plots = THEME_PLOTS[theme];
  if (!plots || plots.length === 0) return null;

  if (opts.plotId) {
    const found = plots.find(p => p.id === opts.plotId);
    if (found) return found;
    console.warn(`[plotTemplates] plotId "${opts.plotId}" not found for theme "${theme}", using random`);
  }

  return plots[Math.floor(Math.random() * plots.length)];
}

/**
 * Get all available plot IDs for a theme (useful for debugging/admin).
 * @param {string} theme
 * @returns {string[]}
 */
function getAllPlotIds(theme) {
  const plots = THEME_PLOTS[theme];
  if (!plots) return [];
  return plots.map(p => p.id);
}

/**
 * Get the total number of plot templates across all themes.
 * @returns {number}
 */
function getTotalPlotCount() {
  return Object.values(THEME_PLOTS).reduce((sum, plots) => sum + plots.length, 0);
}

module.exports = { selectPlotTemplate, getAllPlotIds, getTotalPlotCount, THEME_PLOTS };
