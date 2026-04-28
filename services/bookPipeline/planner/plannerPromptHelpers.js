/**
 * Shared fragments for story-bible, spread-spec, and visual-bible LLM prompts.
 * Keeps questionnaire formatting, cross-book variety steering, and brainstorm
 * seed serialization consistent.
 */

const crypto = require('crypto');

/** @type {Array<{ key: string, label: string }>} */
const QUESTIONNAIRE_FIELD_LABELS = [
  { key: 'favorite_activities', label: 'Favorite activities' },
  { key: 'funny_thing', label: 'Funny thing they do' },
  { key: 'meaningful_moment', label: 'Meaningful moment' },
  { key: 'moms_favorite_moment', label: "Mom's favorite moment" },
  { key: 'dads_favorite_moment', label: "Dad's favorite moment" },
  { key: 'favorite_food', label: 'Favorite food' },
  { key: 'favorite_cake_flavor', label: 'Favorite cake flavor' },
  { key: 'favorite_toys', label: 'Favorite toys' },
  { key: 'other_detail', label: 'Other detail' },
  { key: 'anything_else', label: 'Additional' },
  { key: 'calls_mom', label: 'Child calls mom' },
  { key: 'mom_name', label: "Mom's name" },
  { key: 'calls_dad', label: 'Child calls dad' },
  { key: 'dad_name', label: "Dad's name" },
  { key: 'birth_date', label: 'Birth date' },
];

/**
 * Parent free-text that smells like ordinary-home routines (triggers upstream translation nudge).
 * Keep in sync loosely with domestic heuristics in spreadLocationAudit — this is for questionnaire/custom details only.
 */
const HOME_CONTEXT_RX = /\b(kitchen|bake|baking|baker|cookies?|oven|couch|sofa|apartment|\bflat\b|hallway|laundry|living\s+room|at\s+home|dining\s+room|pantry|bedroom|backyard|family\s+room)\b/i;

/** Occasion themes that receive HOME-MENTION TRANSLATION when {@link customDetailsMentionHomeContext} matches. */
const HOME_TRANSLATION_THEMES = new Set(['mothers_day', 'fathers_day', 'grandparents_day', 'birthday', 'birthday_magic']);

/**
 * @param {string|null|undefined} text
 * @returns {boolean}
 */
function customDetailsMentionHomeContext(text) {
  if (!text || typeof text !== 'string') return false;
  return HOME_CONTEXT_RX.test(text);
}

/**
 * @param {string|null|undefined} theme
 * @param {string|null|undefined} customDetails
 * @returns {boolean}
 */
function shouldInjectBrainstormHomeTranslation(theme, customDetails) {
  const t = theme == null ? '' : String(theme);
  if (!HOME_TRANSLATION_THEMES.has(t)) return false;
  return customDetailsMentionHomeContext(customDetails);
}

/**
 * Heuristic: brainstorm seed fields still read heavily domestic (for optional pipeline preface).
 * @param {object|null|undefined} storySeed
 * @returns {boolean}
 */
function storySeedMentionHomeContext(storySeed) {
  if (!storySeed || typeof storySeed !== 'object') return false;
  const beatText = Array.isArray(storySeed.beats)
    ? storySeed.beats.map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object') return (b.description || b.text || b.beat || '').toString();
        return '';
      }).join(' ')
    : '';
  const blob = [
    storySeed.setting,
    storySeed.narrative_spine,
    storySeed.storySeed,
    beatText,
  ]
    .map((s) => (s == null ? '' : String(s)))
    .join(' ');
  return customDetailsMentionHomeContext(blob);
}

/** One hash-chosen principle per book — orthogonal “where” biases without naming copy-paste venues. */
const PRIMARY_SETTING_STEERING_POOL = [
  'Primary spectacle bias (this book id): lean into sky, flight decks, weather layers, and airy vertical scale. Obey theme and questionnaire; invent specific place names — do not paste wording from this instruction.',
  'Primary spectacle bias (this book id): lean into depth, pressure-glow hulls, and undersea architecture. Obey theme and questionnaire; invent specifics — do not default every book to the same vessel type.',
  'Primary spectacle bias (this book id): lean into non-Earth horizons, unfamiliar ecology, and small-settlement life. Keep child-safe and paintable; invent names — avoid a generic “planet” label as the whole setting.',
  'Primary spectacle bias (this book id): lean into layered civic scale, transit, and busy public interiors. Obey theme; invent a coherent city or hub — not a hallway–kitchen–couch crawl.',
  'Primary spectacle bias (this book id): lean into extreme earth nature (named ridges, canyons, storm edges, tides). Obey theme; forbid vague “nice park” unless the brief names that exact place.',
  'Primary spectacle bias (this book id): lean into a long-distance travel spine (route, convoy, deck, corridor-of-the-journey). Obey theme; invent vehicle and stops — one clear mile-by-mile arc.',
];

/**
 * Deterministic primary-setting nudge from book id (different byte index than trope steering).
 * @param {string|null|undefined} bookId
 * @returns {string}
 */
function renderPrimarySettingSteeringFromBookId(bookId) {
  const h = crypto.createHash('sha256').update(String(bookId || 'pipeline'), 'utf8').digest();
  const idx = h[2] % PRIMARY_SETTING_STEERING_POOL.length;
  return [
    'Cross-order setting variety (deterministic nudge — still obey brief and theme):',
    `  ${PRIMARY_SETTING_STEERING_POOL[idx]}`,
  ].join('\n');
}

/** Soft trope nudges — hash picks two so repeat orders do not all default the same way. */
const TROPE_STEERING_POOL = [
  'Do not let a ribbon, bow, or gift ribbon be the main recurring visual thread unless the parent text names one.',
  'Do not default to a "magic song" or lullaby as the plot engine unless the theme truly requires music.',
  'Do not default to a tiny generic animal sidekick unless the brief names a pet or creature.',
  'Do not default to a vague "trail of light or sparkles" as the only connective motif.',
];

/**
 * @param {{ anecdotes?: Record<string, string> }} child
 * @returns {string}
 */
function formatQuestionnaireBlock(child) {
  const a = child && child.anecdotes && typeof child.anecdotes === 'object' ? child.anecdotes : {};
  const lines = [];
  for (const { key, label } of QUESTIONNAIRE_FIELD_LABELS) {
    const val = a[key];
    if (typeof val === 'string' && val.trim()) lines.push(`${label}: ${val.trim()}`);
  }
  if (!lines.length) return '(none — use custom details and story seed only)';
  return lines.join('\n');
}

/**
 * Deterministic steering from book id (or fallback string).
 * @param {string|null|undefined} bookId
 * @returns {string}
 */
function renderVarietySteeringFromBookId(bookId) {
  const h = crypto.createHash('sha256').update(String(bookId || 'pipeline'), 'utf8').digest();
  const i0 = h[0] % TROPE_STEERING_POOL.length;
  let i1 = h[1] % TROPE_STEERING_POOL.length;
  if (i1 === i0) i1 = (i0 + 1) % TROPE_STEERING_POOL.length;
  const picks = [TROPE_STEERING_POOL[i0], TROPE_STEERING_POOL[i1]];
  return [
    'Cross-order variety (for this book id): extra steering — still obey theme, brief, and personalization.',
    ...picks.map((p, idx) => `  ${idx + 1}. ${p}`),
  ].join('\n');
}

/**
 * Serialize brainstorm output for the book pipeline planner (appended to customDetails freeText).
 * @param {object|null|undefined} storySeed
 * @returns {string} suffix to append (with leading newlines) or ''
 */
function formatPlannerStorySeedAppendix(storySeed) {
  if (!storySeed || typeof storySeed !== 'object') return '';
  const lines = [];
  const add = (label, val) => {
    if (val == null) return;
    const s = typeof val === 'string' ? val.trim() : String(val);
    if (s) lines.push(`${label}: ${s}`);
  };
  add('story_seed_line', storySeed.storySeed);
  add('favorite_object', storySeed.favorite_object);
  add('fear', storySeed.fear);
  add('setting', storySeed.setting);
  add('narrative_spine', storySeed.narrative_spine);
  add('emotional_core', storySeed.emotional_core);
  add('repeated_phrase', storySeed.repeated_phrase);
  add('style_mode', storySeed.style_mode);
  if (Array.isArray(storySeed.techniques) && storySeed.techniques.length) {
    lines.push(`techniques: ${storySeed.techniques.map(String).join(', ')}`);
  }
  if (Array.isArray(storySeed.phrase_arc) && storySeed.phrase_arc.length) {
    lines.push(`phrase_arc: ${storySeed.phrase_arc.map(String).join(' | ')}`);
  }
  if (Array.isArray(storySeed.beats) && storySeed.beats.length) {
    const beatStrs = storySeed.beats.map((b, i) => {
      if (typeof b === 'string') return `  ${i + 1}. ${b.trim()}`;
      if (b && typeof b === 'object') {
        const t = (b.description || b.text || b.beat || '').toString().trim();
        return t ? `  ${i + 1}. ${t}` : '';
      }
      return '';
    }).filter(Boolean);
    if (beatStrs.length) {
      lines.push('brainstorm_beats:');
      lines.push(...beatStrs);
    }
  }
  if (!lines.length) return '';
  return `\n\nBRAINSTORM SEED (structured — honor as creative direction; weave with parent questionnaire):\n${lines.join('\n')}`;
}

/** System-prompt bullets shared by story bible + spread specs (spectacle, arc, personalization). */
const PLANNER_CREATIVE_BAR = `
- **Boring-answer elevation:** If the questionnaire is mostly soft emotion (loves hugs/kisses/snuggles/family) with little concrete nouns, do NOT make that the plot engine. Invent a bold, child-safe external adventure (mystery, quest, comic misunderstanding, build, race to help) that fits the theme. Land the warmth in 1–2 beats (heart spread + closing), not every spread.
- **Real arc:** There must be escalation toward a peak with at least one kid-safe surprise or reversal. Forbidden: a flat slideshow of equally nice moments with nothing pulling the page-turn.
- **Spectacular locations:** At least 4 major settings must feel film-worthy — specific scale OR unusual architecture OR extreme natural beauty OR one fairytale-safe wonder beat each, plus concrete light (golden hour, storm rim, bioluminescence, cathedral beams, etc.) and materials (water, stone, glass, living plants, textiles). Ban vague placeholders alone ("nice park", "the backyard", "playroom") unless the brief names that exact place — and even then add a cinematic differentiator.
- **Unified journey (not location roulette):** Spectacle must not become **13 unrelated backdrops** stitched to showcase questionnaire nouns. Prefer **2–3 anchor venue families** (one shared outing, vehicle, festival, or mystery) and **return, deepen, or move within** them. The "4 distinct major settings" rule is satisfied by **distinct zones of the same parent journey** (e.g. same line: carriage interior → platform → terminus overlook → harbor foot of the same route) as well as genuinely new legs — each move must be **causally earned** in the spine. **Forbidden:** unmotivated tourist-hop where spreads exist only to tick a new prop or place type.
- **Hobby translation (baking, cooking, kitchen play):** Do NOT set more than 2–3 spreads in a realistic home kitchen/living-room loop unless the theme is explicitly cozy-home or bedtime. Translate the hobby outward: market hall, bakery row, festival tent, greenhouse, harbor stall, rooftop garden, train-platform treat shop — still about cookies/flour/spoons, but not twelve spreads of hallway/couch/oven.
- **Recurring motifs (grounded):** \`recurringVisualMotifs\` must include at least ONE motif clearly tied to a concrete questionnaire or custom-detail noun (named toy, food, place, ritual object). Do NOT default to generic ribbons, lullabies, generic tiny sidekicks, or "trail of light" unless the parent text or seed justifies it.
- **Refrain discipline:** Do not plan a repeating lyric that will force the final writer to paste the same full line on many spreads; one callback beat is enough.
`.trim();

module.exports = {
  QUESTIONNAIRE_FIELD_LABELS,
  formatQuestionnaireBlock,
  renderVarietySteeringFromBookId,
  renderPrimarySettingSteeringFromBookId,
  customDetailsMentionHomeContext,
  shouldInjectBrainstormHomeTranslation,
  storySeedMentionHomeContext,
  formatPlannerStorySeedAppendix,
  PLANNER_CREATIVE_BAR,
  HOME_TRANSLATION_THEMES,
  PRIMARY_SETTING_STEERING_POOL,
};
