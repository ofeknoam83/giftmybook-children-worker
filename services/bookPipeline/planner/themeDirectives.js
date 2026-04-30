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
// cover. The visual cast is strictly limited to the cover, so the parent may be
// treated as narrated/implied partial presence unless the approved cover already
// shows them full-figure — then that render is the continuity lock for any
// interior that needs Mom/Dad visible.
//
// Mother's Day: debias shared parent-adventure bullets that used to force
// melody quests, then ribbon-map / "follow the gold ribbon" spines after melody
// was softened — `MOTHERS_DAY_DIRECTIVE` below; Father's Day / grandparents
// still spread `PARENT_SHARED_ADVENTURE` unchanged.
const PARENT_SHARED_ADVENTURE = {
  framing:
    "This book is a genuinely thrilling, visually rich shared adventure the child undertakes with the parent as their guiding star — a premium animated-film quest with real stakes, surprise, wonder, and a brave mission. It is NOT a quiet day-out or a gentle errand. The world should feel fresh every time: invented public places, sensory nature, whimsical machines, tiny magical societies, festival spaces, sea/light/sky journeys, or child-scale transformations of real locations. The parent is felt throughout the adventure (voice in the child's head, a beloved object taken along, a memory that guides a choice, a silhouette at the far end waiting) but is NOT drawn as a full-figure co-hero unless the approved cover already shows them. The adventure itself is the gift — the child returns home changed, with a story only they and the parent will ever share.",
  mustInclude: [
    "a bold, imaginative core conceit — a real quest, rescue, voyage, expedition, or secret mission with a concrete goal and a ticking reason (a fading lullaby to recover, a lost melody to return, a star to deliver, a sea creature to save, a map to complete)",
    "a sense of scale and wonder — the child travels through at least 4 DISTINCT, visually spectacular environments (e.g. lantern pier, bioluminescent cave, moonlit reef, treetop post office, glass greenhouse, tidepool palace, floating flower market, lighthouse stairs) — not a suburban route",
    "at least one friendly non-human companion, guide, or story object that joins the adventure (e.g. paper bird, talking seahorse, navigator owl, pocket-sized robot, helpful kite, lantern moth, music-box mouse, wind-up beetle) — the child is NOT alone",
    "real stakes and at least one genuine obstacle the child has to solve bravely — a storm to outsmart, a bridge to cross, a riddle to answer, a lost path to recover — moments that actually matter to the plot, played with tension and then relief",
    "the parent is felt on every spread through memory, voice, a signature keepsake carried along, or a trait the child mirrors — and partial presence (a waiting silhouette, a hand reaching in at the climax, an object they gave the child) is welcome, but NEVER a full face or full body figure unless the cover already depicts them",
    "the payoff is a homecoming or reveal shared with the parent — the child returns triumphant with the thing they quested for, and the final spread is the parent and child together (partial presence or from behind if the parent is off-cover) celebrating what they alone now share — not a card, gift, breakfast tray, or tea party",
  ],
};

/** Mother's Day: melody/ribbon debiased + creative diversity (questionnaire over stock moth/light). */
const MOTHERS_DAY_DIRECTIVE = {
  framing:
    `${PARENT_SHARED_ADVENTURE.framing}

PALETTE DISCIPLINE — Mother's Day only: Treat \`mustInclude\`, \`adventureHooks\`, and example recombinations below as an **inspiration pantry**, not mandatory ingredients. **Prefer** interests, anecdotes, and customDetails when building companion, MacGuffin, and locations. **Do not** default the spine to a moth + personified glow/light + prism trio unless the questionnaire or custom text names moths, lanterns, lighthouses, or light-fantasy.`,
  mustInclude: [
    'a bold, imaginative core conceit — a real quest, rescue, voyage, expedition, or secret mission with a concrete goal and a ticking reason grounded first in **personalization data** when present (toy, sport, food joke, family ritual, pet, drawing habit) — fallback examples: festival kindness token, tidepool courier, brass carousel tab, shell-runners, ferry-boat note — do **not** default the spine to a "lost melody" chase, ribbon-MacGuffin, **or** spread-to-spread "chase the gleam / restore Mr Sun beam" **or** lantern-moth guide + prism unless brief names those',
    'a sense of scale and wonder — the child travels through at least 4 DISTINCT, visually spectacular environments (e.g. lantern pier, tidepool plaza, treetop post office, glass greenhouse, meadow shell, floating market, lighthouse stairs) — not a suburban route',
    'at least one friendly non-human companion OR strongly personified story object — examples to **vary** (not all in one book): pocket otter envoy, paper gull, beetle postman, compass crab, gardener frog, trolley mouse, helpful kite — **lantern moth ONLY** if questionnaire/interests mention dusk, moths, butterflies, or lanterns — music-themed props optional, never required',
    'real stakes and at least one genuine obstacle the child has to solve bravely — a storm to outsmart, a bridge to cross, a riddle to answer, a lost path to recover — moments that actually matter to the plot, played with tension and then relief',
    'Mom is felt on every spread through memory, voice, a signature keepsake, or mirrored traits — partial silhouette / hands-at-climax when she is strictly off-cover; when she IS on the approved cover, keep her face/body welded to that cover likeness on any full-figure beats',
    'the payoff is a homecoming or reveal shared with Mom — triumphant closure and Mom with the child (same cover look when Mom is cover-approved), not breakfast tray/tea/card clichés',
  ],
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
    'floating musical notes / glowing cartoon notes driving the plot',
    'runaway melody or chasing the melody as the backbone quest',
    'recovering Mom\'s "lost song" or fading-lullaby MacGuffin without questionnaire support',
    'recovering literal song fragments as collectible objects unless the brief explicitly asks',
    'talking or sentient ribbon as the quest engine',
    'gold / magic ribbon that calls the child spread-to-spread ("follow me" ribbon)',
    'ribbon crumbs, ribbon trail, or ribbon leash as the backbone MacGuffin unless the brief explicitly requests ribbons',
    'default spine: moth or firefly "guide" PLUS personified lamp/light named character PLUS prism restore — unless brief names those',
    'talking star, sun beam, or lighthouse spirit beckoning the hero spread-to-spread without questionnaire support',
    'follow the gleam / chasing dawn light as the only motor of the plot unless custom details ask for light fantasy',
  ],
  adventureHooks: [
    'Build a hook by mining **interests + questionnaire** first, then add one mission + one companion + one world — palette lines are seasoning, not scripture. Do NOT copy any line verbatim.',
    'mission palette (music & ribbon optional only if brief names them): tidal-clock rescue clue, kite-mail over the marina (twine, not a mascot), shell-runners carrying a cousin\'s note, carousel brass gear before dusk, berry-basket relay, ferry-booth stamp hunt, lost **physical** object tied to an anecdote — not a pure light-chase',
    'companion/object palette: compass crab, paper gull envoy, beetle postman, gardener frog, pocket otter (wet beat), trolley mouse, helpful kite — moth/butterfly flyer **only** if brief mentions; skip music-box-only drivers unless brief asks',
    'world palette: lantern pier, tidepool plaza, meadow theater shell, rooftop garden maze between chimneys, conservatory glasshouse, rainy parade artery, dunes with shell pennants or kite tails, coral library foyer',
    'Mom connection palette: snack doodle jokes, tucked coat-pocket map scraps, lighthouse anecdote Mom retells **as dialogue not a glow-spirit**, scarf stripe the child echoes, apron patch color, humming-while-dishes as **body rhythm** not a floating note character',
    'Music-in-brief sparingly allowed: karaoke booth backlight as one waypoint only; humming while rowing; distant marching-band bleed-through.',
    'example recombination: a paper gull snaps a ferry-booth stamp onto the berry basket so the tidepool gates open before the parade drum.',
    'example recombination: a compass crab stows itself in Grandma\'s berry basket so tidepool scouts reopen the conservatory door Mom sketches on napkins.',
    'example recombination: gardener frog reroutes irrigation so shell pennants align for the kite-string message home — no talking star.',
    'example recombination: a beetle postman trades a carousel brass cog so the stalled ride spins again moments before Mom waves from the midway railing.',
    'example recombination: pocket otter ferries a bathtub toy "diplomat" across a tidepool channel so the child recovers a joke snack Mom packed — comic, not luminosity.',
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
