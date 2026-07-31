/**
 * Story formats (AI Writer Guidelines, June 2026 — Step 4).
 *
 * The buyer picks ONE of four formats. Every format runs the same 13-spread
 * beat skeleton and the same input-to-role casting (storyRoles) — only the
 * tone, the framing, and the world flavor change. The format NEVER overrides
 * the skeleton, the role map, or the ordered theme axes: a Superhero + space
 * order is the hero of a space city; a love_story order still runs
 * trigger → challenge → turning point, just told through the relationship.
 *
 * Lives in shared/ (not bookPipelineV3/) because validation.js normalizes
 * the request field at the API boundary — the same split as shared/themes.js.
 */

const STORY_FORMATS = ['classic', 'superhero', 'adventure', 'love_story'];

/**
 * Per-format creative guides. `opener` is the format-specific first-line
 * convention (spread 1); `tone` is the register the whole book keeps;
 * `framing` is how the world and the challenge are dressed.
 */
const FORMAT_GUIDES = {
  classic: {
    label: 'Classic fairy tale',
    opener: 'Open with "Once upon a time…" (or a close, natural variant of it).',
    tone: 'warm, soft, magical — tender bedtime-story cadence, wonder over thrill',
    framing: 'a gentle fairy-tale world: the fantasy world is soft-edged and kind, the challenge is a worry to soothe rather than a battle, and the ending glows',
  },
  superhero: {
    label: 'Superhero',
    opener: 'Open with "In the city of [the coined world name]…" — the child introduced as the city\'s tiny hero, with a hero name earned from their real traits (The Ball Boy, Captain Giggle).',
    tone: 'bold, theatrical, energetic — comic-book beats, punchy declarations, big verbs',
    framing: 'the world is a bright buzzing city named after the child or their dominant trait; the challenge is a city-scale problem the child\'s specific powers (their real hobby and funny trait) are exactly suited to fix; never grim, never violent',
  },
  adventure: {
    label: 'Adventure',
    opener: 'Open with "It started like any normal day…" — an ordinary moment that tips into discovery.',
    tone: 'curious, brave, puzzle-driven — the child figures things out; earned triumph over granted magic',
    framing: 'an expedition: a found map, a tiny door, a trail of clues; obstacles are physical and solvable, and the child\'s hobby is the trick that cracks each one',
  },
  love_story: {
    label: 'Love story',
    opener: 'Open grounded — no set formula: a real, warm moment between the child and the person this book celebrates.',
    tone: 'emotional, warm, relational — the story\'s engine is the bond; quiet feelings named through actions, never sentiment dumped in narration',
    framing: 'the adventure is shared: the celebrated person (the named parent when provided — otherwise the family\'s warmth) co-stars in the journey, and the ending lands the love flowing both directions',
  },
};

// UI labels and common variants → canonical format key.
const FORMAT_ALIASES = {
  classic: 'classic',
  classic_fairy_tale: 'classic',
  fairy_tale: 'classic',
  fairytale: 'classic',
  superhero: 'superhero',
  super_hero: 'superhero',
  hero: 'superhero',
  adventure: 'adventure',
  love_story: 'love_story',
  love: 'love_story',
  lovestory: 'love_story',
};

/**
 * Lowercase/underscore an incoming label ("Love Story" → love_story).
 * @param {unknown} raw
 * @returns {string}
 */
function slugifyFormat(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[\s-]+/g, '_')
    .replace(/_{2,}/g, '_');
}

/**
 * Normalize an incoming story-format value to a canonical key.
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeStoryFormat(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  return FORMAT_ALIASES[slugifyFormat(raw)] || null;
}

/**
 * Resolve the format for a book. Precedence: a valid requested format wins;
 * else parent-day occasions read as love stories; else the youngest readers
 * get the classic register; else adventure (the guidelines' default energy).
 *
 * @param {{ requested?: unknown, occasion?: string|null, ageYears?: number|null }} input
 * @returns {{ format: string, source: 'requested'|'occasion_default'|'age_default'|'default' }}
 */
function resolveStoryFormat({ requested, occasion, ageYears } = {}) {
  const explicit = normalizeStoryFormat(requested);
  if (explicit) return { format: explicit, source: 'requested' };
  if (occasion === 'mothers_day' || occasion === 'fathers_day') {
    return { format: 'love_story', source: 'occasion_default' };
  }
  const age = Number(ageYears);
  if (Number.isFinite(age) && age > 0 && age <= 4) {
    return { format: 'classic', source: 'age_default' };
  }
  return { format: 'adventure', source: 'default' };
}

/**
 * Compose the format directive for the writer-chain prompts. States the
 * boundary explicitly: the format owns tone/framing ONLY — the beat
 * skeleton, the storyRoles casting, and the ordered themes stay fixed.
 *
 * @param {string} format - canonical key
 * @param {{ storyTheme?: string|null, hasSidekick?: boolean }} [opts]
 * @returns {string|null}
 */
function buildFormatDirective(format, { storyTheme, hasSidekick } = {}) {
  const guide = FORMAT_GUIDES[format];
  if (!guide) return null;
  const parts = [
    `STORY FORMAT — ${guide.label}: ${guide.tone}.`,
    guide.opener,
    guide.framing.charAt(0).toUpperCase() + guide.framing.slice(1) + '.',
    'The format changes ONLY the tone, the framing, and the world flavor — the beat skeleton, the storyRoles casting, and the ordered occasion/story theme are fixed and non-negotiable.',
  ];
  if (storyTheme) {
    parts.push(`Express the format INSIDE the ordered story-theme world (${storyTheme}) — e.g. a Superhero format in a space world makes the child the hero of a space city, not a generic metropolis.`);
  }
  if (format === 'love_story' && hasSidekick === false) {
    parts.push('No parent was named on the order — center the love on the child\'s family and home generically; never invent a named parent.');
  }
  return parts.join('\n');
}

module.exports = {
  STORY_FORMATS,
  FORMAT_GUIDES,
  normalizeStoryFormat,
  resolveStoryFormat,
  buildFormatDirective,
};
