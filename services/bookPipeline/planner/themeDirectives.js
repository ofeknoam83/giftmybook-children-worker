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

// Shared parent-as-co-hero adventure for themes where Mom/Dad may be off-cover
// (partial presence) or full-figure when the approved cover shows them.
const PARENT_SHARED_ADVENTURE = {
  framing:
    'This book is a genuinely thrilling, visually rich shared adventure the child undertakes with the parent as their guiding star — quest with real stakes, surprise, wonder, and a brave mission. It is NOT only a quiet day-out or gentle errand. Invent fresh worlds: public places, nature, whimsical machines, festivals, bright night scenes, lanterns, luminous moments — use what fits personalization. The parent is felt throughout (voice, object, memory, silhouette, dialogue) but is NOT drawn full-figure unless the approved cover shows them. The adventure itself is the gift — the child returns changed, with a story only they and the parent share.',
  mustInclude: [
    'a bold imaginative core conceit — quest, rescue, voyage, or secret mission with a concrete goal and ticking reason anchored in personalization when possible',
    'at least 4 DISTINCT, visually spectacular environments',
    'at least one friendly non-human companion, guide, or story object (paper bird, beetle postman, pocket otter, moth or butterfly guide, gardener frog, helpful kite — any that fit the questionnaire); the child is NOT alone',
    'real stakes and at least one obstacle the child solves bravely — tension then relief',
    'the parent is felt on every spread through memory, voice, a keepsake, or mirrored traits — partial silhouette or hands at climax when off-cover; cover-consistent likeness when the parent is cover-approved',
    'payoff homecoming or reveal shared with the parent — not ONLY a breakfast tray, card, or tea party without a fuller adventure spine',
  ],
};

const MOTHERS_DAY_DIRECTIVE = {
  framing:
    `${PARENT_SHARED_ADVENTURE.framing}\n\nLove to Mom — lean on interests, anecdotes, and customDetails for missions, companions, props, and settings.`,
  mustInclude: [
    'a bold imaginative through-line grounded first in personalization (toy, sport, joke, ritual, pet, hobby) — sea, lanterns, prism play, lighthouse tales, ribbons, melodies, glowing guides, ALL allowed when organic to the questionnaire',
    'at least 4 DISTINCT vivid worlds or stops',
    'a companion or charismatic story object tuned to THIS child',
    'obstacles with real payoff; Mom present emotionally beat-to-beat',
    'hidden-face/implied visuals when Mom is strictly off-cover; exact cover match when Mom is on the approved cover',
    'celebratory close with Mom — breakfast/tea/card beats are fine AS moments if the larger arc still feels like adventure, not cliché stationery',
  ],
  bannedCliches: [
    'tea party / pouring tea as THE entire plot spine',
    'breakfast in bed as the ONLY climax',
    'handmade card as the ONLY payoff',
    'picking flowers from the garden and handing them over with no broader adventure',
    'mom asleep while child tiptoes around the house as the main gag',
    'entirely indoor cozy-house rut with zero outward motion',
    'silent or speechless mom who only smiles through the whole arc',
    'spa day / foot-bath / mom in a face mask as the centerpiece',
    'tying an apron / baking cupcakes indoors as the whole book',
    'farmer\'s-market stroll or generic suburban walk as the sole structure with no stakes',
    'gentle pointless errand montage masquerading as the whole quest',
    'a quiet errand run with no real stakes or change',
  ],
  adventureHooks: [
    'Compose from questionnaire first; palette lines below are sparks only — copy nothing verbatim.',
    'missions: tidal clue, carousel repair, kite-mail across water, scout relay, market stamp hunt, kindness token chain, misplaced hobby rescue, prism/lantern quests if brief invites them',
    'companions: paper gull, beetle postman, compass crab, gardener frog, pocket otter, moth or firefly envoy, trolley mouse, helpful kite — pick textures the parent named',
    'worlds: pier and festivals, lantern rows, conservatory glass, dunes, murals, reefs, meadows, flea rows, ferry booths',
    'Mom ties: humming while rowing, lighthouse story retold aloud, scarf stripe echoed, apron patch gag, tucked map scraps, snack riddles Mom always tells',
    'recombination: paper gull + ferry stamp clears tidepool parade gate.',
    'recombination: compass crab hides in Grandma\'s berry basket; conservatory scouts reopen.',
    'recombination: gardener frog + irrigation pennants kite line message home.',
    'recombination: beetle swaps brass midway cog; stalled ride spins; Mom waves railing.',
    'recombination: pocket otter + tub-toy diplomat + joke snack Mom packed.',
  ],
};

const THEME_DIRECTIVES = {
  mothers_day: MOTHERS_DAY_DIRECTIVE,
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
      'quiet walk around the block as the whole plot',
      'a suburban errand run with no real stakes',
      'hardware-store trip as the entire adventure',
    ],
    adventureHooks: [
      "a thundering train chase across a canyon of clouds to deliver Daddy's lost blueprint to the engineer of the sunrise",
      "a dinosaur-egg rescue expedition deep in a prehistoric jungle, with a friendly baby T-rex as the child's guide",
      "a robot-repair mission inside a giant clockwork castle where the child must bring the last copper cog home before the tower stops ticking",
      "a rocket launch to a tiny moon to answer a signal from Daddy's old radio — a star-pirate tries to steal the message and the child out-pilots them",
      "a viking longship voyage across an iceberg sea, guided by a star-fox, to deliver a compass stone to the keeper of the northern lights",
      "a spelunking quest through a crystal cave where a glow-worm explorer helps the child find the lost crown of the mountain-king that Daddy always told stories about",
      "an airship race above a dragon-forest to retrieve a runaway kite that carries Daddy's voice",
      "a deep-sea submarine mission to photograph the legendary sun-whale that only appears on Father's Day",
      "a jungle expedition with a brave parrot navigator to recover a sacred drum so the rainforest can sing again",
      "a lava-bridge crossing on a friendly dragon's back to deliver a small brave flame to the forge where Daddy once worked",
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
