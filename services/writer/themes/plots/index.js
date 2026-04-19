/**
 * Plot template registry — selects a plot template for a given theme.
 *
 * Each theme has 10-12 structurally distinct story arcs. At generation time,
 * one is selected by matching against the approved book title (via Gemini Flash),
 * by explicit plotId, or at random. The rest of the Writer V2 pipeline
 * (enrichment, writing, revision) works unchanged.
 */

const { callGeminiText, GEMINI_FLASH_MODEL } = require('../base');

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

/**
 * Returns true if the title is a generic placeholder (e.g. "Luna's Story", "A Story for Luna")
 * that carries no plot-selection signal.
 */
function isPlaceholderTitle(title) {
  const t = title.trim().toLowerCase();
  return /^.+'s story$/i.test(t) || /^a story for .+$/i.test(t) || /^my story$/i.test(t);
}

/**
 * Use Gemini Flash to match a book title to the best plot template for a theme.
 * @param {string} title - the approved book title (e.g. "Luna's Runaway Balloon")
 * @param {string} theme - theme key (e.g. 'birthday', 'adventure')
 * @returns {Promise<string|null>} plot ID or null if matching fails
 */
async function matchTitleToPlot(title, theme) {
  const plots = THEME_PLOTS[theme];
  if (!plots || plots.length === 0) return null;
  if (!title || typeof title !== 'string' || title.trim().length === 0) return null;
  if (isPlaceholderTitle(title)) {
    console.log(`[plotTemplates] Skipping title-to-plot matching — placeholder title "${title}"`);
    return null;
  }

  const plotList = plots.map(p => `- ${p.id}: "${p.name}" — ${p.synopsis}`).join('\n');
  const validIds = plots.map(p => p.id);

  const systemPrompt = 'You are a plot-matching assistant. Given a children\'s book title and a list of available plot templates, return the ID of the single best-matching plot. Return ONLY the plot ID, nothing else.';
  const userPrompt = `Book title: "${title.trim()}"\nTheme: ${theme}\n\nAvailable plots:\n${plotList}\n\nWhich plot ID best matches this title? Return only the ID.`;

  try {
    const result = await callGeminiText(systemPrompt, userPrompt, {
      model: GEMINI_FLASH_MODEL,
      maxOutputTokens: 50,
      temperature: 0.0,
      timeoutMs: 10_000,
      requestLabel: 'title-to-plot-match',
    });

    const rawId = (result.text || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (validIds.includes(rawId)) {
      console.log(`[plotTemplates] Title "${title}" matched to plot "${rawId}" for theme "${theme}"`);
      return rawId;
    }

    // Try partial match in case the model returned extra text
    const found = validIds.find(id => result.text.toLowerCase().includes(id));
    if (found) {
      console.log(`[plotTemplates] Title "${title}" matched to plot "${found}" for theme "${theme}" (partial)`);
      return found;
    }

    console.warn(`[plotTemplates] LLM returned unrecognized plot ID "${result.text}" for title "${title}"`);
    return null;
  } catch (err) {
    console.warn(`[plotTemplates] Title-to-plot matching failed: ${err.message}`);
    return null;
  }
}

module.exports = { selectPlotTemplate, getAllPlotIds, getTotalPlotCount, matchTitleToPlot, isPlaceholderTitle, THEME_PLOTS };
