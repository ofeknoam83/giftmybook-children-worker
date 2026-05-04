/**
 * Theme directives.
 *
 * Adventure has no entry here — it relies entirely on the default planner
 * system prompt and produces good books. The previous parent-theme directives
 * were over-engineered: `mustInclude` arrays pushed the LLM toward listed
 * items (one test book picked up "ribbons" and built the entire spine around
 * it because the directive listed it as something allowed), `bannedCliches`
 * added noise that anchored the model on the exact things it was told to
 * avoid, and `adventureHooks` was a twee companion menu that pushed the prose
 * toward whimsical-sentimental rather than the bolder register adventure
 * books reach by default.
 *
 * Parent-theme directives are now stripped down to **adventure parity**: just
 * a `framing` sentence plus the structural `qualityBar` and
 * `peakMomentPatterns` (general standards, not specific permissions or bans).
 * The LLM uses its defaults for everything else — same as adventure.
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

// Shared 9-item quality bar applied to every parent-theme book at planner
// time. General writing-craft standards, not a permission or ban list. The
// parent-theme analogue of the adventure-flavored defaults baked into
// createStoryBible.js's system prompt.
const PARENT_THEME_QUALITY_BAR = [
  'SPINE — by spread 3 the reader can identify the day\'s through-line: a specific shared mission, project, journey, surprise being prepared, skill being learned, place being reached, thing being made/fixed/found/given, ritual being passed. NOT a list of pleasant tableaux.',
  'RISING STAKES — something is at risk (small and warm is fine; absent is not): a surprise being spoiled, a project failing, the right thing not being found in time. Around spread 4–5 the day hits a small hitch and the pair pivots together.',
  'EARNED PEAK MOMENT — somewhere in spreads 7–10 there is ONE beat that is the emotional climax, image-led, fewest words. Pick a pattern from peakMomentPatterns or invent past it. Do NOT default to "child leans against parent".',
  'PARENT\'S FACE CHANGES ONCE — at least one beat where the parent visibly receives the bond: eyes shine, hand to heart, breath catches, laugh breaks. The child sees they landed. Without this, the love letter has no addressee.',
  'ECHO TRANSFORMED — spread 13 is a vivid awake echo of spread 1, transformed by the day\'s bond (the morning ritual returning but now the CHILD initiates it; the same window, now holding the gift on the sill; the same handshake, now child-led). Concrete tableau. Daylight or warm lamp glow. NOT bedtime.',
  'BOND SATURATION — every spread carries at least one parent-specific detail (an in-joke, a ritual, a gesture only THIS pair shares — drawn from the personalization snapshot). Vary the detail spread to spread.',
  'LOCATION VARIETY — at least 4 distinct named places across the 13 spreads, unless the personalization snapshot centers home routines.',
  'ONE BOND-MIRROR BEAT — somewhere mid-book the world recognizes the pair: the regular bus driver waves like always, the corner cat finds her usual spot between them, the bakery owner already has the small treat ready, the breeze tugs both their scarves the same way. ONE beat, not pervasive — the parent-theme analogue of how an adventure book has the world respond to the hero.',
  'ANECDOTES DRIVE THE SPINE — the mission, the peak moment, the in-jokes, the echo are all pulled from the personalization snapshot. The structure provides the slots; the answers fill them. Generic = wasted gift book.',
];

const PARENT_THEME_PEAK_MOMENT_PATTERNS = [
  'A GIVING — child presents something prepared (gift, song, drawing, meal, letter).',
  'A REACHING — pair finally arrives at the place / completes the project they started.',
  'A REVEAL — surprise unveiled, secret shared, photo presented, name on the plaque.',
  'A SHARED FIRST — first ride, first try, first time crossing the street alone with parent watching.',
  'A QUIET RECOGNITION — wordless moment where both realize what the day has been (silhouettes overlapping, hands on the same object, two pairs of feet under one quilt, child catching parent\'s eye in the mirror).',
  'A RETURNED GESTURE — the parent\'s signature ritual now initiated by the child (the handshake, the song, the wink, the way of asking).',
  'A CULMINATION OF ACCUMULATED EFFORT — the recipe finishes, the building stands, the seed sprouts, the puzzle\'s last piece clicks.',
];

// Shared parent-as-co-hero framing. No mustInclude/bannedCliches/
// adventureHooks — adventure parity. Trust the LLM's defaults to write the
// adventure; the framing reorients the theme so it doesn't collapse into
// tea-party / breakfast-tray clichés on its own, and the qualityBar carries
// the structural craft requirements.
const PARENT_SHARED_ADVENTURE_FRAMING =
  'This book is a genuinely thrilling, visually rich shared adventure the child undertakes with the parent as their guiding star — quest with real stakes, surprise, wonder, and a brave mission. It is NOT only a quiet day-out or gentle errand. Invent fresh worlds: public places, nature, whimsical machines, festivals, bright night scenes, lanterns, luminous moments — use what fits personalization. The parent is felt throughout (voice, object, memory, silhouette, dialogue) but is NOT drawn full-figure unless the approved cover shows them. The adventure itself is the gift — the child returns changed, with a story only they and the parent share.';

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
