/**
 * Occasion + story-theme vocabulary, normalization, and creative guides.
 *
 * The main app collects TWO distinct axes on the create form:
 *   - occasion   (why the book exists: birthday_magic, bedtime_wonder,
 *                 mothers_day, fathers_day, adventure_play, …)
 *   - storyTheme (the world the book lives in: adventure, space,
 *                 underwater, fantasy, …)
 *
 * Historically both were funneled through the single `theme` request field
 * (occasion shadowing story theme), so half the form's options never reached
 * a prompt. This module is the single source of truth for both vocabularies:
 * the request boundary (validation.js) normalizes with it, the story-seed
 * brainstorm and every v3 writer-chain prompt inject its guides, and the art
 * director gets its palette/motif notes.
 *
 * Guides are CONTENT direction only — world, imagery, emotional register,
 * palette. They never describe a rendering medium: the style bible owns the
 * medium (premium 3D), and no theme may soften that lock.
 */

/** Canonical occasion keys (mirrors the main app's occasionTheme vocabulary). */
const CANONICAL_OCCASIONS = [
  'birthday_magic',
  'bedtime_wonder',
  'mothers_day',
  'fathers_day',
  'adventure_play',
  'learning_discovery',
  'creative_arts',
  'friendship_fun',
];

/** Canonical story-theme keys (mirrors the main app's Story theme picker). */
const CANONICAL_STORY_THEMES = [
  'adventure', 'birthday', 'bedtime', 'friendship', 'holiday',
  'school', 'nature', 'space', 'underwater', 'fantasy',
];

// UI labels and common variants → canonical occasion. Keys are the
// lowercased/underscored form produced by `slugify` below.
const OCCASION_ALIASES = {
  birthday_magic: 'birthday_magic',
  bedtime_wonder: 'bedtime_wonder',
  bedtime_story: 'bedtime_wonder',
  mothers_day: 'mothers_day',
  love_to_mom: 'mothers_day',
  love_to_mum: 'mothers_day',
  fathers_day: 'fathers_day',
  love_to_dad: 'fathers_day',
  adventure_play: 'adventure_play',
  learning_discovery: 'learning_discovery',
  educational: 'learning_discovery',
  creative_arts: 'creative_arts',
  arts_imagination: 'creative_arts',
  friendship_fun: 'friendship_fun',
  friends: 'friendship_fun',
};

// Variants → canonical story theme.
const STORY_THEME_ALIASES = {
  outer_space: 'space',
  ocean: 'underwater',
  sea: 'underwater',
  under_the_sea: 'underwater',
  magic: 'fantasy',
  animals: 'nature',
  forest: 'nature',
  holidays: 'holiday',
  bedtime_story: 'bedtime',
};

/**
 * Per-occasion creative guides. `story` feeds the writer chain (why the book
 * exists — its emotional register and the moments it must land); `art` feeds
 * the art director (palette/motif mood only, never medium).
 */
const OCCASION_GUIDES = {
  birthday_magic: {
    label: 'Birthday',
    story: 'This book IS the birthday present — the day itself is the event. The story must feel like the best birthday this child ever had: anticipation that fizzes, a celebration that gathers everyone the child loves, one small wobble (a runaway balloon, a wobbling cake) that the child saves, and a candle-glow ending that says "this whole day was for YOU". Never a generic story that merely starts on a birthday.',
    art: 'celebration everywhere — streamers, confetti drift, balloons, warm candle-glow; the light peaks golden at the party climax',
  },
  bedtime_wonder: {
    label: 'Bedtime Story',
    story: 'Built to be read at lights-out. The story\'s pulse slows spread by spread — adventure early, wonder in the middle, hush at the end. The final spreads must land the child safe, warm, and heavy-eyed; the last line should read like a whisper. No jolts, no cliffhangers, no noisy triumph at the close.',
    art: 'deepening blues and violets as the book progresses, pools of warm lamplight, soft star-glow; each act a shade quieter than the last',
  },
  mothers_day: {
    label: 'Love to Mom',
    story: 'A love letter from the child to their mom. Mom co-stars — the story celebrates what SHE does and what the two of them are together: her rituals, her rescues, the small ordinary magic only she makes. The ending names the feeling: this child is lucky to be hers, and she is loved back, fiercely.',
    art: 'tender warmth — soft morning golds, close two-figure compositions, small intimate moments staged large',
  },
  fathers_day: {
    label: "Father's Day",
    story: 'A love letter from the child to their dad. Dad co-stars — his projects, his shoulders-ride view of the world, his patient hands, the jokes only he tells. The ending lands the pride flowing both directions: the child wants to be like him, and he is already proud.',
    art: 'grounded warmth — late-afternoon ambers, side-by-side and shoulder-carry compositions, big-and-small hand motifs',
  },
  adventure_play: {
    label: 'Adventure',
    story: 'Pure play energy: the gift is the child seeing themselves as the capable hero of a real expedition. Name a concrete quest early, make the obstacles physical and winnable, and let the child solve the climax with their OWN idea — no adult rescue. Triumph should feel earned and a little breathless.',
    art: 'bold expedition energy — sun-drenched vistas, dramatic scale contrast (small hero, huge world), golden-hour warmth at the victory',
  },
  learning_discovery: {
    label: 'Learning & Discovery',
    story: 'Curiosity is the engine. The child asks the question, runs the experiment, follows the clue — and the "aha" belongs to them. Wonder over facts: the book celebrates HOW this child figures things out, not a lesson recited at them.',
    art: 'bright investigative clarity — crisp daylight, close-ups on small marvels (a magnified beetle, a fizzing jar), sparks of discovery-glow',
  },
  creative_arts: {
    label: 'Arts & Imagination',
    story: 'Making things is the magic. Paint, music, cardboard castles — the mess is glorious and the child\'s imagination physically reshapes the world of the story. What they make matters to someone by the end.',
    art: 'exuberant color play — paint-splash accents, imagined elements blooming into the real scene, a palette that grows bolder as the child creates',
  },
  friendship_fun: {
    label: 'Friends',
    story: 'A togetherness story. The friend (or friends) are real characters with their own wants; the plot needs BOTH of them to succeed, and the warm ending belongs to the pair, not just the hero.',
    art: 'paired compositions — side-by-side staging, mirrored poses, two-color complementary warmth',
  },
};

/**
 * Per-story-theme creative guides. `world` + `energy` feed the writer chain
 * (the setting territory and narrative drive); `art` feeds the art director.
 */
const STORY_THEME_GUIDES = {
  adventure: {
    label: 'Adventure',
    world: 'Expedition territory: crackling maps, rope bridges, hidden doors, a summit or a secret worth reaching.',
    energy: 'A concrete quest named on spread 1, rising physical stakes through the middle, a triumphant earned climax.',
    art: 'wide dramatic vistas, scale contrast between the small hero and a huge world, warm victorious light at the resolution',
  },
  birthday: {
    label: 'Birthday',
    world: 'The birthday itself is the world: the party being built, the guests arriving, the cake, the wish.',
    energy: 'Anticipation → celebration → one saved wobble → candle-glow gratitude. Every spread must smell of birthday.',
    art: 'confetti and streamer motifs, balloon color pops, golden candle-light climax',
  },
  bedtime: {
    label: 'Bedtime',
    world: 'The soft machinery of night: a house settling, shadows with friendly shapes, the moon keeping watch.',
    energy: 'A winding-down cadence — each spread a notch quieter, ending sleep-ready and safe.',
    art: 'indigo-to-violet progression, warm lamplight pools, gentle star-glow',
  },
  friendship: {
    label: 'Friendship',
    world: 'Wherever the two of them are together — the plot lives in the space between the child and a true friend.',
    energy: 'A goal neither can reach alone; a wobble between them that honesty mends; a shared win.',
    art: 'two-figure staging, mirrored poses, warm complementary palettes',
  },
  holiday: {
    label: 'Holiday',
    world: 'The family\'s festive season at full sparkle: twinkle lights, kitchens that smell of baking, snow or lantern-light.',
    energy: 'Preparation and togetherness building to the season\'s big shared moment.',
    art: 'rich festive jewel tones, string-light bokeh, cozy interior glow against cool outdoor light',
  },
  school: {
    label: 'School',
    world: 'The kingdom of the classroom and playground: cubbies, chalk dust, the epic geography of the schoolyard.',
    energy: 'A school-day challenge (first day, show-and-tell, the big project) the child conquers with courage or kindness.',
    art: 'crayon-bright primaries, playground geometry, sunlit classroom warmth',
  },
  nature: {
    label: 'Nature',
    world: 'Mud, moss and weather: a named ridge, tidepool or riverbend — the wild as a living character.',
    energy: 'Exploration and quiet awe; small creatures and big skies; the child learns the wild\'s secret rhythm.',
    art: 'layered greens, dappled canopy light, a small hidden creature tucked into every spread',
  },
  space: {
    label: 'Space',
    world: 'The child among the stars: rockets, cratered moons, comet trails, nebula gardens.',
    energy: 'A voyage with a destination — launch, wonder, a deep-space challenge, a starlit return.',
    art: 'deep indigo skies, glowing nebula accents, starlight rim-light on the hero, tiny Earth warm in the distance',
  },
  underwater: {
    label: 'Underwater',
    world: 'Coral kingdoms and kelp forests: bubble trails, shipwreck arches, sea creatures as guides.',
    energy: 'A dive toward something luminous and secret; currents and creatures help and hinder; surfacing changed.',
    art: 'teal-to-turquoise gradients, refracted light shafts from the surface, bioluminescent accents in the deep',
  },
  fantasy: {
    label: 'Fantasy',
    world: 'A door to elsewhere: pocket dragons, castles in cloud, forests where the trees trade whispers.',
    energy: 'Impossible things treated as wonderfully ordinary; a quest with its own dream-logic rules the child masters.',
    art: 'jewel tones, floating lights, impossible-but-cozy architecture — enchanting, never eerie',
  },
};

/**
 * Lowercase/underscore an incoming label so `"Bedtime Story"`, `"Father's Day"`
 * and `bedtime_wonder` all key the same alias table.
 * @param {unknown} raw
 * @returns {string}
 */
function slugify(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[\s-]+/g, '_')
    .replace(/&/g, '')
    .replace(/_{2,}/g, '_');
}

/**
 * Normalize an incoming occasion value (canonical key, UI label, or common
 * variant) to a canonical occasion key.
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeOccasion(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  return OCCASION_ALIASES[slugify(raw)] || null;
}

/**
 * Normalize an incoming story-theme value to a canonical story-theme key.
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeStoryTheme(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const slug = slugify(raw);
  if (CANONICAL_STORY_THEMES.includes(slug)) return slug;
  return STORY_THEME_ALIASES[slug] || null;
}

/**
 * Resolve the two theme axes from a request that may carry the new explicit
 * fields (`occasion`, `storyTheme`) and/or the legacy single `theme` field.
 *
 * Legacy classification: the main app historically sent the OCCASION under
 * `theme` (`occasionTheme || theme`), while the old self-serve funnel sent a
 * story theme — so a legacy value is treated as an occasion only when it is
 * an unambiguous occasion key/label (bare 'adventure'/'birthday'/'bedtime'
 * classify as story themes).
 *
 * @param {{ occasion?: unknown, storyTheme?: unknown, theme?: unknown }} fields
 * @returns {{ occasion: string|null, storyTheme: string|null }}
 */
function resolveThemeAxes({ occasion, storyTheme, theme } = {}) {
  const explicitOccasion = normalizeOccasion(occasion);
  const explicitStory = normalizeStoryTheme(storyTheme);
  const legacyOccasion = normalizeOccasion(theme);
  const legacyStory = legacyOccasion ? null : normalizeStoryTheme(theme);
  return {
    occasion: explicitOccasion || legacyOccasion || null,
    storyTheme: explicitStory || legacyStory || null,
  };
}

// The legacy single-`theme` machinery (emotional tiers, effective age,
// parent-theme guards, storyPlanner beat structures) keys on VALID_THEMES
// values. Map each occasion to the legacy theme that machinery expects.
const LEGACY_THEME_FOR_OCCASION = {
  birthday_magic: 'birthday_magic',
  bedtime_wonder: 'bedtime',
  mothers_day: 'mothers_day',
  fathers_day: 'fathers_day',
  adventure_play: 'adventure',
  learning_discovery: 'school',
  creative_arts: 'adventure',
  friendship_fun: 'friendship',
};

/**
 * Compose the writer-chain theme directive: WHY the book exists (occasion)
 * fused with WHERE it lives (story theme). Returns null when neither axis
 * resolved — callers omit the block entirely.
 *
 * @param {{ occasion?: string|null, storyTheme?: string|null }} axes
 * @returns {string|null}
 */
function buildThemeDirective({ occasion, storyTheme } = {}) {
  const occ = OCCASION_GUIDES[occasion];
  const st = STORY_THEME_GUIDES[storyTheme];
  const parts = [];
  if (occ) parts.push(`OCCASION — ${occ.label}: ${occ.story}`);
  if (st) parts.push(`STORY THEME — ${st.label}: ${st.world} ${st.energy}`);
  if (occ && st) {
    parts.push(
      'FUSE THEM: the occasion is WHY this book exists (its emotional register and the moments it must land); '
      + 'the story theme is WHERE it lives (its world and imagery). '
      + `A ${occ.label} + ${st.label} order is the occasion celebrated INSIDE that world — never a generic story with a theme sticker on it.`,
    );
  }
  return parts.length ? parts.join('\n') : null;
}

/**
 * Compose the art-director mood note (palette/motif only — the medium stays
 * locked to the style bible). Returns null when neither axis resolved.
 *
 * @param {{ occasion?: string|null, storyTheme?: string|null }} axes
 * @returns {string|null}
 */
function buildThemeArtNote({ occasion, storyTheme } = {}) {
  const occ = OCCASION_GUIDES[occasion];
  const st = STORY_THEME_GUIDES[storyTheme];
  const bits = [];
  if (st?.art) bits.push(`story theme '${st.label}': ${st.art}`);
  if (occ?.art) bits.push(`occasion '${occ.label}': ${occ.art}`);
  return bits.length ? bits.join(' · ') : null;
}

module.exports = {
  CANONICAL_OCCASIONS,
  CANONICAL_STORY_THEMES,
  OCCASION_GUIDES,
  STORY_THEME_GUIDES,
  LEGACY_THEME_FOR_OCCASION,
  normalizeOccasion,
  normalizeStoryTheme,
  resolveThemeAxes,
  buildThemeDirective,
  buildThemeArtNote,
};
