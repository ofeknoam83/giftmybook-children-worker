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
 * Returns the plot ID only when the LLM considers it a strong match.
 * @param {string} title - the approved book title (e.g. "Luna's Runaway Balloon")
 * @param {string} theme - theme key (e.g. 'birthday', 'adventure')
 * @returns {Promise<string|null>} plot ID or null if no good match
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

  const systemPrompt = `You are a plot-matching assistant for children's picture books.
Given a book title and a list of available plot templates, decide if any template is a STRONG match.
Return JSON: { "plotId": "<id>" } if one template clearly fits, or { "plotId": "NONE" } if no template is a strong match.
A strong match means the title's concept, setting, and emotional core align with the plot synopsis. Do NOT force a match — "NONE" is a valid and common answer.`;

  const userPrompt = `Book title: "${title.trim()}"\nTheme: ${theme}\n\nAvailable plots:\n${plotList}\n\nReturn JSON with the best plotId, or "NONE" if nothing fits well.`;

  try {
    const result = await callGeminiText(systemPrompt, userPrompt, {
      model: GEMINI_FLASH_MODEL,
      maxOutputTokens: 100,
      temperature: 0.0,
      timeoutMs: 10_000,
      requestLabel: 'title-to-plot-match',
      responseMimeType: 'application/json',
    });

    let parsed;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      const rawId = (result.text || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (validIds.includes(rawId)) {
        console.log(`[plotTemplates] Title "${title}" matched to plot "${rawId}" for theme "${theme}" (raw)`);
        return rawId;
      }
      console.warn(`[plotTemplates] Could not parse match response: "${result.text}"`);
      return null;
    }

    const matchedId = (parsed.plotId || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');

    if (matchedId === 'none' || !matchedId) {
      console.log(`[plotTemplates] No strong plot match for title "${title}" in theme "${theme}" — will generate custom`);
      return null;
    }

    if (validIds.includes(matchedId)) {
      console.log(`[plotTemplates] Title "${title}" matched to plot "${matchedId}" for theme "${theme}"`);
      return matchedId;
    }

    const found = validIds.find(id => (parsed.plotId || '').toLowerCase().includes(id));
    if (found) {
      console.log(`[plotTemplates] Title "${title}" matched to plot "${found}" for theme "${theme}" (partial)`);
      return found;
    }

    console.warn(`[plotTemplates] LLM returned unrecognized plot ID "${parsed.plotId}" for title "${title}"`);
    return null;
  } catch (err) {
    console.warn(`[plotTemplates] Title-to-plot matching failed: ${err.message}`);
    return null;
  }
}

/**
 * Generate a custom plot beat structure tailored to a specific book title.
 * Used when no existing plot template is a strong match for the title.
 * @param {string} title - the book title
 * @param {string} theme - theme key
 * @param {object} opts - { child, isYoung, wt }
 * @returns {Promise<{ id: string, name: string, synopsis: string, beats: object[] } | null>}
 */
async function generateCustomPlot(title, theme, opts) {
  const { child, isYoung, wt } = opts;

  const exampleBeats = [
    { spread: 1,  beat: 'HOOK',        wordTarget: wt },
    { spread: 2,  beat: 'DISCOVERY',   wordTarget: wt + 2 },
    { spread: 3,  beat: 'RISING_1',    wordTarget: wt + 2 },
    { spread: 4,  beat: 'RISING_2',    wordTarget: wt + 2 },
    { spread: 5,  beat: 'DEEP_EXPLORE', wordTarget: wt + 2 },
    { spread: 6,  beat: 'CHALLENGE',   wordTarget: wt + 2 },
    { spread: 7,  beat: 'CLEVERNESS',  wordTarget: wt + 2 },
    { spread: 8,  beat: 'TRIUMPH',     wordTarget: wt },
    { spread: 9,  beat: 'WONDER',      wordTarget: isYoung ? 12 : 15 },
    { spread: 10, beat: 'GIFT',        wordTarget: wt + 2 },
    { spread: 11, beat: 'HOMECOMING',  wordTarget: wt },
    { spread: 12, beat: 'REFLECTION',  wordTarget: wt },
    { spread: 13, beat: 'CLOSING',     wordTarget: isYoung ? 12 : 15 },
  ];

  const systemPrompt = `You are a children's picture-book story architect. Given a book title and theme, design a CUSTOM 13-spread story arc that fits the title perfectly.

RULES:
- 13 spreads organized into 4 SCENES (A: spreads 1-3, B: 4-7, C: 8-10, D: 11-13)
- Beats within a scene share the SAME location or emotional space
- Spread 9 is the quiet wonder moment (fewest words)
- Spread 13 is the closing line (echo the opening)
- The arc must feel inevitable for THIS title — not a generic adventure
- Use the child's name "${child.name}" in beat descriptions
- Each description should be 1-2 sentences telling the illustrator and writer what happens

Return JSON:
{
  "synopsis": "One-sentence plot summary",
  "beats": [{ "spread": 1, "beat": "BEAT_NAME", "description": "what happens", "wordTarget": <number> }]
}`;

  const userPrompt = `Book title: "${title}"
Theme: ${theme}
Child's name: ${child.name}
Age tier: ${isYoung ? 'young-picture (ages 3-4)' : 'picture-book (ages 5-6)'}
Word target per spread: ${wt}

Design a 13-spread story arc that brings this SPECIFIC title to life. The story should feel like it could only have this title.

Use these word targets per spread:
${exampleBeats.map(b => `Spread ${b.spread}: ~${b.wordTarget} words`).join('\n')}`;

  try {
    const result = await callGeminiText(systemPrompt, userPrompt, {
      model: GEMINI_FLASH_MODEL,
      maxOutputTokens: 2000,
      temperature: 0.7,
      timeoutMs: 20_000,
      requestLabel: 'custom-plot-generation',
      responseMimeType: 'application/json',
    });

    const parsed = JSON.parse(result.text);
    const beats = parsed.beats;

    if (!Array.isArray(beats) || beats.length < 10) {
      console.warn(`[plotTemplates] Custom plot generation returned ${beats?.length || 0} beats, expected 13`);
      return null;
    }

    for (const b of beats) {
      if (!b.wordTarget) {
        const ref = exampleBeats.find(e => e.spread === b.spread);
        b.wordTarget = ref ? ref.wordTarget : wt;
      }
    }

    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
    const customPlot = {
      id: `custom_${slug}`,
      name: title,
      synopsis: parsed.synopsis || `A custom story arc for "${title}"`,
      beats,
    };

    console.log(`[plotTemplates] Generated custom plot "${customPlot.id}" for title "${title}" (${beats.length} beats)`);
    return customPlot;
  } catch (err) {
    console.warn(`[plotTemplates] Custom plot generation failed: ${err.message}`);
    return null;
  }
}

module.exports = { selectPlotTemplate, getAllPlotIds, getTotalPlotCount, matchTitleToPlot, generateCustomPlot, isPlaceholderTitle, THEME_PLOTS };
