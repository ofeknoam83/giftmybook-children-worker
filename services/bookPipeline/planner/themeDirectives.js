/**
 * Theme directives.
 *
 * Left alone, large models collapse recurring themes into their single most
 * common trope (tea party for Mother's Day, necktie + BBQ for Father's Day,
 * cupcake + candle for birthday). The planner prompts must explicitly reframe
 * those themes and ban the clichés by name.
 *
 * Every directive returns:
 *   - framing:         one strong sentence that reorients the theme
 *   - mustInclude:     specific creative moves that reshape the story
 *   - bannedCliches:   tropes the book must not use
 *   - adventureHooks:  concrete setting/activity ideas the planner can pick from
 *
 * Parent-centric themes (mother's day, father's day, grandparents day, etc.)
 * always resolve to a *shared adventure* — the parent is a co-hero, not the
 * passive recipient of a gift. The "gift" in these books is the shared memory
 * itself, not a handmade card or breakfast tray.
 */

const PARENT_SHARED_ADVENTURE = {
  framing:
    "This book is a shared adventure between the child and the parent. The parent is a full co-hero — funny, brave, curious, with their own beats — not a passive recipient of a gift. The 'gift' is the memory of what they do together, not an object the child hands over.",
  mustInclude: [
    "the parent and child travel across at least 4 visually distinct real-world locations together",
    "the parent has at least one moment where they lead the action (not just smile from the sidelines)",
    "the child and parent share a running in-joke, signature move, or shared prop that evolves across the book",
    "at least one playful surprise that changes the plan (weather, detour, misread map, small disaster played for laughs)",
    "the final payoff is a shared moment or shared triumph, not a card, gift, or breakfast-in-bed reveal",
  ],
};

const THEME_DIRECTIVES = {
  mothers_day: {
    ...PARENT_SHARED_ADVENTURE,
    bannedCliches: [
      'tea party / pouring tea',
      'breakfast in bed as the main event',
      'handmade card as the climax',
      'picking flowers from the garden and handing them over',
      "mom asleep while child tiptoes around the house",
      "entirely indoor cozy-house setting",
      "silent or speechless mom who only smiles",
      'spa day / foot-bath / mom in a face mask',
      'tying an apron / baking cupcakes indoors as the whole plot',
    ],
    adventureHooks: [
      "city museum scavenger hunt",
      "tidepool discovery morning at a beach",
      "farmer's-market expedition that keeps surprising them",
      "sunrise hike up a named local hill",
      "neighborhood bike loop that turns into a treasure map",
      'aquarium or zoo with a small secret mission',
      "ferry ride across a bay / river",
      "kite-flying on a windy headland",
    ],
  },
  fathers_day: {
    ...PARENT_SHARED_ADVENTURE,
    bannedCliches: [
      'necktie gift / handing Dad a tie',
      'BBQ / grilling burgers as the whole plot',
      "dad asleep in a recliner with remote control",
      '"world\'s best dad" mug as the climax',
      'entirely indoor garage / living-room setting',
      'fishing pond silent montage with no real story',
      'handmade card as the final gift',
    ],
    adventureHooks: [
      "dawn fishing trip that turns into a rescue-the-hat chase",
      "city rooftop stargazing with a borrowed telescope",
      "bike-and-ferry loop across town",
      "tide-pool exploration looking for one specific creature",
      "hardware-store quest to build a backyard contraption",
      "trail hike to a named waterfall",
      "sunset drive-in or rooftop movie with snacks they pack together",
    ],
  },
  grandparents_day: {
    ...PARENT_SHARED_ADVENTURE,
    framing:
      "A shared adventure between the child and grandparent(s). The grandparent is a co-hero with their own beats, not a nostalgic observer. The payoff is a shared experience, not a card or framed photo.",
    bannedCliches: [
      'grandparent asleep in a rocking chair',
      'tea and biscuits as the entire plot',
      'photo album flashback montage',
      'handmade card as the climax',
      'entirely indoor house setting',
    ],
    adventureHooks: [
      "grandparent teaches the child a real skill on location (fishing, baking at a specific bakery, garden walk identifying plants)",
      "day-trip to a place the grandparent remembers from childhood",
      'public garden / botanical walk that turns into a treasure hunt',
      'farmers market tradition with a small twist',
    ],
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
 * @param {string} theme
 * @returns {null|{ framing:string, mustInclude:string[], bannedCliches:string[], adventureHooks:string[] }}
 */
function getThemeDirective(theme) {
  const key = String(theme || '').toLowerCase();
  return THEME_DIRECTIVES[key] || null;
}

/**
 * Render a directive as a prompt block. Returns '' when there is no directive
 * so it can be concatenated without conditionals.
 *
 * @param {string} theme
 * @returns {string}
 */
function renderThemeDirectiveBlock(theme) {
  const d = getThemeDirective(theme);
  if (!d) return '';
  return [
    `THEME DIRECTIVE — ${theme}:`,
    `  FRAMING: ${d.framing}`,
    '  MUST INCLUDE:',
    ...d.mustInclude.map(s => `    - ${s}`),
    '  BANNED CLICHÉS (the book must not use any of these):',
    ...d.bannedCliches.map(s => `    - ${s}`),
    '  ADVENTURE HOOKS (pick or improvise on — do not copy verbatim):',
    ...d.adventureHooks.map(s => `    - ${s}`),
  ].join('\n');
}

module.exports = {
  getThemeDirective,
  renderThemeDirectiveBlock,
};
