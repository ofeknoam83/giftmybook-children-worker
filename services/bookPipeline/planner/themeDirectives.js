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

// Parent-centric themes where the parent is frequently NOT on the approved
// cover. The visual cast is strictly limited to the cover, so the parent is
// treated as a story presence — narrated, voiced, and implied through partial
// presence (a hand, a silhouette, a waiting figure, a shared object) but not
// drawn as a full face or full body figure in interior spreads.
//
// If a future book has the parent on the cover, this framing still works —
// the cover itself becomes their full-figure reference for any spread that
// needs it.
const PARENT_SHARED_ADVENTURE = {
  framing:
    "This book is a GENUINELY THRILLING, out-of-this-world adventure the child undertakes with the parent as their guiding star — a Pixar-feature-film-scale quest (magical kingdom, cosmic voyage, pirate sea, dinosaur jungle, cloud city, steampunk airship, crystal cave, submarine deep, enchanted forest, rainbow mountain) with real stakes, surprise, wonder, and a brave mission. It is NOT a quiet day-out or a gentle errand. Think *Moana*, *Up*, *Finding Nemo*, *How to Train Your Dragon* — not a kitchen scene. The parent is felt throughout the adventure (voice in the child's head, a beloved object taken along, a memory that guides a choice, a silhouette at the far end waiting) but is NOT drawn as a full-figure co-hero unless the approved cover already shows them. The adventure itself is the gift — the child returns home changed, with a story only they and the parent will ever share.",
  mustInclude: [
    "a bold, imaginative core conceit — a real quest, rescue, voyage, expedition, or secret mission with a concrete goal and a ticking reason (a fading lullaby to recover, a lost melody to return, a star to deliver, a sea creature to save, a map to complete)",
    "a sense of scale and wonder — the child travels through at least 4 DISTINCT, visually spectacular environments (e.g. cloud canyon, bioluminescent cave, moonlit reef, rainbow waterfall, sky-garden, lava bridge, crystal forest, dragon's library) — not a suburban route",
    "at least one friendly non-human companion or magical creature that joins the adventure (a baby dragon, a talking seahorse, a navigator owl, a pocket-sized robot, a helpful cloud) — the child is NOT alone",
    "real stakes and at least one genuine obstacle the child has to solve bravely — a storm to outsmart, a bridge to cross, a riddle to answer, a lost path to recover — moments that actually matter to the plot, played with tension and then relief",
    "the parent is felt on every spread through memory, voice, a signature keepsake carried along, or a trait the child mirrors — and partial presence (a waiting silhouette, a hand reaching in at the climax, an object they gave the child) is welcome, but NEVER a full face or full body figure unless the cover already depicts them",
    "the payoff is a homecoming or reveal shared with the parent — the child returns triumphant with the thing they questing for, and the final spread is the parent and child together (partial presence or from behind if the parent is off-cover) celebrating what they alone now share — not a card, gift, breakfast tray, or tea party",
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
      'farmer\'s-market day-out / strolling through a market as the whole plot',
      'gentle suburban walk or park visit as the whole plot',
      'a quiet errand run with no real stakes',
    ],
    adventureHooks: [
      "a moonlit balloon voyage through a sky of humming stars to catch a falling lullaby and bring it home before sunrise",
      "a midnight dive in a seashell submarine through a coral kingdom to return a sleeping pearl to the sea queen who once sang to Mommy",
      "a brave hike up a rainbow mountain with a tiny cloud-dragon guide to collect the last note of Mommy's favorite song",
      "a secret door behind the garden leads to a glowing forest where a clever fox and a firefly must help the child rescue a stolen spring before Mommy wakes",
      "a paper-boat journey down a winding river of starlight across a map only the child can read, with a lighthouse at the end where Mommy is waiting",
      "a clockwork airship flight across a thunderstorm to retrieve the queen-of-bees' lost crown and restore the flower meadow Mommy loves",
      "a quest through a bioluminescent cave guided by a talking seahorse to return a singing shell to a lonely whale — the song is the one Mommy sings",
      "a high-stakes treasure map across a floating island chain where a pirate parrot helps the child recover a locket that plays Mommy's voice",
      "a dragon-back ride over a valley of glass flowers to catch a runaway melody that belongs to Mommy's old music box",
      "a rescue mission in a steampunk sky-city to free a captured sunrise so Mommy can see the first light of Mother's Day",
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
