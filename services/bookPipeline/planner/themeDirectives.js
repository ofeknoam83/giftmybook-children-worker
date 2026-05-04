/**
 * Theme directives.
 *
 * Adventure has no entry here — it relies entirely on the default planner
 * system prompt and produces good books. Parent themes (mothers_day,
 * fathers_day, grandparents_day) are written as ADVENTURE BOOKS WITH A CO-HERO:
 * the bond is the emotional spine, but the structural spine is an adventure.
 *
 * Earlier iterations over-engineered parent-theme directives with `mustInclude`
 * arrays, `bannedCliches`, and `adventureHooks` — those caused the LLM to
 * anchor on the listed props and pushed prose toward whimsical-sentimental.
 * Then we stripped them down to "adventure parity" framing + qualityBar, but
 * the qualityBar tilted inward (bond saturation every spread, anecdotes drive
 * the spine, rising stakes "small and warm is fine") and the peakMomentPatterns
 * menu was dominated by quiet beats — so books still came out smaller and
 * more domestic than adventure books.
 *
 * Current iteration (parent-themes-adventure-first):
 *   - framing leads with "write this as an adventure book first"
 *   - qualityBar gains an ADVENTURE SCALE item and an INHERIT THE ADVENTURE
 *     DEFAULTS item that pulls the adventure system-prompt rules in by
 *     reference; BOND SATURATION → BOND THREADS (5+ spreads, not all 13);
 *     LOCATION VARIETY raised to ≥5 with ≥2 outdoor/large-scale
 *   - peakMomentPatterns reordered kinetic-first; A SHARED TRIUMPH added;
 *     A QUIET RECOGNITION tagged "use sparingly"
 *

 * Per-directive fields:
 *   - framing:             one strong sentence that reorients the theme
 *   - qualityBar:          (parent themes) general writing-craft items every
 *                          book must satisfy — equivalent to the structural
 *                          standards adventure books inherit from the default
 *                          planner system prompt
 *   - peakMomentPatterns:  (parent themes) menu of valid emotional-peak
 *                          shapes — inspiration, not requirement
 *   - mustInclude:         (legacy — birthday only) specific creative moves
 *   - bannedCliches:       (legacy — birthday only) tropes to avoid
 *   - adventureHooks:      (legacy — birthday only) concrete activity ideas
 *
 * Birthday is intentionally untouched — it still has its full original
 * `mustInclude`/`bannedCliches`/`adventureHooks` set. If a future test book
 * exposes the same over-engineering for birthday, apply the same treatment.
 */

// Shared quality bar applied to every parent-theme book at planner time.
// General writing-craft standards, not a permission or ban list. Designed to
// sit ON TOP of the adventure-flavored defaults baked into createStoryBible.js's
// system prompt — not replace them.
const PARENT_THEME_QUALITY_BAR = [
  'SPINE — by spread 3 the reader can identify the day\'s through-line: a specific shared mission, project, journey, surprise being prepared, skill being learned, place being reached, thing being made/fixed/found/given, ritual being passed. NOT a list of pleasant tableaux.',
  'ADVENTURE SCALE — the mission must escalate in spectacle, not collapse inward. Spreads 1-3 may start grounded (home, neighborhood) but spreads 4-10 MUST move outward into at least one location that feels cinematic, photogenic, and bigger than a domestic interior — a marketplace at sunset, a coastline, a rooftop garden, a festival, a forest path, an old library, a workshop full of machines, a harbor, a hilltop, a lantern-lit night street. The book must feel like the child went somewhere they will remember, not like a tour of the kitchen and living room. Indoor-only books are only acceptable when the personalization snapshot explicitly centers a homebound activity (e.g. a child whose strongest interest is baking with the parent — and even then, the kitchen must feel cinematic).',
  'RISING STAKES — something is at risk (small and warm is fine; absent is not): a surprise being spoiled, a project failing, the right thing not being found in time, weather closing a path, a critter that complicates the mission. Around spread 4–5 the day hits a hitch and the pair pivots together.',
  'EARNED PEAK MOMENT — somewhere in spreads 7–10 there is ONE beat that is the emotional climax, image-led, fewest words. Pick a pattern from peakMomentPatterns or invent past it. Default to a kinetic peak (a shared triumph, a reaching, a shared first) — only choose A QUIET RECOGNITION when personalization specifically calls for stillness. Do NOT default to "child leans against parent".',
  'PARENT\'S FACE CHANGES ONCE — at the climax (spread 10-11), one beat where the parent visibly receives the bond: eyes shine, hand to heart, breath catches, laugh breaks. The child sees they landed. ONE beat — not pervasive — so the rest of the book stays kinetic.',
  'ECHO TRANSFORMED — spread 13 is a vivid awake echo of spread 1, transformed by the day\'s bond (the morning ritual returning but now the CHILD initiates it; the same window, now holding the gift on the sill; the same handshake, now child-led). Concrete tableau. Daylight or warm lamp glow. NOT bedtime.',
  'BOND THREADS, NOT BOND SATURATION — at least 5 spreads (not all 13) carry a parent-specific detail (an in-joke, a ritual, a carried object, a gesture only THIS pair shares — drawn from the personalization snapshot). The remaining spreads belong to the adventure itself: discovery, motion, spectacle, the world responding to the hero. Vary the detail spread to spread; do NOT make every spread a relationship beat.',
  'LOCATION VARIETY — at least 5 distinct named places across the 13 spreads, AND at least 2 of them are outdoor or large-scale settings (not interior rooms). Home routines may anchor the opening and closing only. Generic interior backdrops ("the living room", "the kitchen") are acceptable for at most 3 spreads total — the rest must be specific photogenic locations.',
  'ONE BOND-MIRROR BEAT — somewhere mid-book the world recognizes the pair: the regular bus driver waves like always, the corner cat finds her usual spot between them, the bakery owner already has the small treat ready, the breeze tugs both their scarves the same way. ONE beat, not pervasive — the parent-theme analogue of how an adventure book has the world respond to the hero.',
  'ANECDOTES DRIVE THE SPINE — the mission, the peak moment, the in-jokes, the echo are all pulled from the personalization snapshot. The structure provides the slots; the answers fill them. Generic = wasted gift book.',
  'INHERIT THE ADVENTURE DEFAULTS — every adventure-book craft rule from the planner system prompt applies here too: ONE CONNECTED ADVENTURE with causal bridges between locations (no "theme park" jumps), recurring visual motifs anchored in personalization, anti-template stack (no talking-animal-guide + map-scavenger + personified-light + prism-quest cluster by default), photogenic settings, never let the book live mostly inside a house. These are NOT in tension with the bond-theme rails — they sit underneath them. A parent-theme book that fails the adventure bar fails as a parent-theme book.',
];

// Order matters: early items get picked more often by the LLM. Kinetic-first.
const PARENT_THEME_PEAK_MOMENT_PATTERNS = [
  'A SHARED TRIUMPH — the pair pull off the mission together against a real obstacle (the storm passes just in time, the gate opens, the parade reaches them, the boat lands, the kite catches, the lantern lifts, the festival starts as they arrive). The image is wide, kinetic, and bright. This is the default for a successful parent-theme adventure book.',
  'A SHARED FIRST — first ride, first try, first time crossing the street alone with parent watching, first time reaching the high shelf, first time leading the way. Kinetic, scary-then-thrilling.',
  'A REACHING — pair finally arrives at the place / completes the project they started. Wide composition, the destination feels earned and bigger than expected.',
  'A CULMINATION OF ACCUMULATED EFFORT — the recipe finishes, the building stands, the seed sprouts, the puzzle\'s last piece clicks, the kite finally rises. Action paying off, not stillness.',
  'A REVEAL — surprise unveiled, secret shared, photo presented, name on the plaque. Choose this only when the reveal itself is visually rich (a banner unfurling, a curtain pulling back) — not a card on a table.',
  'A GIVING — child presents something prepared (gift, song, drawing, meal, letter). Frame the giving as the climax of a quest, not a sentimental still life.',
  'A RETURNED GESTURE — the parent\'s signature ritual now initiated by the child (the handshake, the song, the wink, the way of asking).',
  'A QUIET RECOGNITION — wordless moment where both realize what the day has been (silhouettes overlapping, hands on the same object). Use sparingly — default to a kinetic peak unless personalization specifically calls for stillness (e.g. a child whose strongest bond with the parent is reading together, stargazing, or quiet observation).',
];

// Shared parent-as-co-hero framing. Adventure-first: the relationship is the
// emotional spine, not the structural one. The structural spine is an
// adventure — the same kind of cinematic, location-rich, surprise-driven
// journey we'd write for an adventure-themed brief. The bond shows up in
// SPECIFIC places (carried object, bond-mirror beat, climax recognition),
// not as pervasive softness that deflates the journey.
const PARENT_SHARED_ADVENTURE_FRAMING =
  'Write this book as an ADVENTURE book first — the same kind of cinematic, location-rich, surprise-driven journey you would write for an adventure-themed brief. The relationship is the EMOTIONAL spine, not the structural one. The plot must answer "what daring, photogenic mission does the child undertake today?" before it answers "how does this honor the parent?" Invent fresh worlds: nature at scale, whimsical machines, festivals, harbors, markets, night skies with lanterns, weather events, untamed routes, rooftop gardens, old libraries, workshops, hilltops. The hero is in motion, in spectacle, with stakes that scale UP — not down — as the book progresses. The parent is a co-hero whose presence threads the story (a voice in the ear, a signal flag, a hand entering frame, a familiar object the hero carries, a moment of recognition at the climax) but the parent does NOT shrink the world. The "love letter" lives in the choice of mission, the carried object, the bond-mirror beat, and the climax recognition — not in tone deflation. Do NOT default to "warm", "tender", "gentle", "sweet" as connective tissue. The adventure IS the gift. The parent is NOT drawn full-figure unless the approved cover shows them — when off-cover, the parent threads through via voice, hand, silhouette, shadow, carried object, or world-recognition beats, while the hero stays visually centered in spectacle.';

const THEME_DIRECTIVES = {
  mothers_day: {
    framing: `${PARENT_SHARED_ADVENTURE_FRAMING}\n\nLove to Mom — lean on interests, anecdotes, and customDetails for missions, companions, props, and settings.`,
    qualityBar: PARENT_THEME_QUALITY_BAR,
    peakMomentPatterns: PARENT_THEME_PEAK_MOMENT_PATTERNS,
  },
  fathers_day: {
    framing: PARENT_SHARED_ADVENTURE_FRAMING,
    qualityBar: PARENT_THEME_QUALITY_BAR,
    peakMomentPatterns: PARENT_THEME_PEAK_MOMENT_PATTERNS,
  },
  grandparents_day: {
    framing: 'A shared adventure between the child and grandparent(s). The grandparent is a co-hero with their own beats, not a nostalgic observer. The payoff is a shared experience, not a card or framed photo. The grandparent is felt throughout (voice, object, memory, silhouette, dialogue) but is NOT drawn full-figure unless the approved cover shows them.',
    qualityBar: PARENT_THEME_QUALITY_BAR,
    peakMomentPatterns: PARENT_THEME_PEAK_MOMENT_PATTERNS,
  },
  birthday: {
    framing:
      "A celebratory adventure centered on the child, but not a standard party scene. The day should feel surprising and location-rich.",
    mustInclude: [
      "at least 3 distinct photogenic locations, not just 'the party at home'",
      "a concrete wish, quest, or surprise that gives the day stakes",
      "specific personalization details (favorite thing, friends by name, signature prop) land in the plot — not just as decoration",
    ],
    bannedCliches: [
      'cake with candles as the only centerpiece',
      'generic balloons-in-a-living-room scene',
      'song-then-presents as the main structure',
    ],
    adventureHooks: [
      "backstage tour at a local small business",
      "scavenger-hunt birthday across a neighborhood",
      'mini road trip to a specific place the child has always wanted to see',
    ],
  },
};

/**
 * Return the directive for a theme, or null if there is no special handling.
 *
 * @param {string} theme
 * @returns {null|object}
 */
function getThemeDirective(theme) {
  const key = String(theme || '').toLowerCase();
  return THEME_DIRECTIVES[key] || null;
}

/**
 * Render a directive as a prompt block. Returns '' when there is no directive
 * so it can be concatenated without conditionals. Each section is rendered
 * only if its data is present — directives are free to omit fields they don't
 * use (e.g. parent-theme directives have no mustInclude/bannedCliches/
 * adventureHooks; birthday has no qualityBar/peakMomentPatterns).
 *
 * @param {string} theme
 * @returns {string}
 */
function renderThemeDirectiveBlock(theme) {
  const d = getThemeDirective(theme);
  if (!d) return '';
  const lines = [
    `THEME DIRECTIVE — ${theme}:`,
    `  FRAMING: ${d.framing}`,
  ];
  if (Array.isArray(d.mustInclude) && d.mustInclude.length > 0) {
    lines.push(
      '  MUST INCLUDE:',
      ...d.mustInclude.map(s => `    - ${s}`),
    );
  }
  if (Array.isArray(d.bannedCliches) && d.bannedCliches.length > 0) {
    lines.push(
      '  BANNED CLICHÉS (the book must not use any of these):',
      ...d.bannedCliches.map(s => `    - ${s}`),
    );
  }
  if (Array.isArray(d.adventureHooks) && d.adventureHooks.length > 0) {
    lines.push(
      '  ADVENTURE HOOKS (pick or improvise on — do not copy verbatim):',
      ...d.adventureHooks.map(s => `    - ${s}`),
    );
  }
  if (Array.isArray(d.qualityBar) && d.qualityBar.length > 0) {
    lines.push(
      '  PARENT-THEME QUALITY BAR (general writing-craft standards every book must satisfy — the writer is free to invent the arc):',
      ...d.qualityBar.map((s, i) => `    ${i + 1}. ${s}`),
    );
  }
  if (Array.isArray(d.peakMomentPatterns) && d.peakMomentPatterns.length > 0) {
    lines.push(
      '  PEAK-MOMENT PATTERNS (menu for qualityBar item #3 — pick one, blend two, or invent past it; not a mandate):',
      ...d.peakMomentPatterns.map(s => `    - ${s}`),
    );
  }
  return lines.join('\n');
}

module.exports = {
  getThemeDirective,
  renderThemeDirectiveBlock,
};
