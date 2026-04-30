/**
 * Curated refrain lines for Love to Mom / Dad writers.
 * Prompts require the refrain to include the child's word for parent and stay short (≤8 words).
 */

/**
 * @param {string} p - Child's word for parent (e.g. Mama, Mommy, Daddy).
 * @returns {string[]}
 */
function defaultMothersRefrains(p) {
  return [
    `${p} hums while the kettle steams.`,
    `The day's soft edge shines through ${p}.`,
    `${p} keeps pace with skipping feet.`,
    `Two hands swing with ${p} in rhyme.`,
    `${p} points where the petals land.`,
    `Every step finds ${p}'s footprints near.`,
  ];
}

/**
 * @param {string} p
 * @returns {string[]}
 */
function defaultFathersRefrains(p) {
  return [
    `${p} steadies the tallest stack.`,
    `The wind leans sideways into ${p}.`,
    `${p} matches your loudest grin.`,
    `Boots muddy, ${p} still holds the map.`,
    `${p} lets the kite string sing.`,
    `${p} kneels eye-to-eye through dust.`,
  ];
}

/** @type {Record<string, (p: string) => string[]>} */
const MOTHERS_BY_PLOT = {
  classic_journey: p => [
    `${p} knows which turn comes next.`,
    `The sidewalk warms beside ${p}.`,
    `${p} points out one more bright thing.`,
    `Every corner tastes like trust with ${p}.`,
    `${p} hums maps only you can hear.`,
    `Two fares ride home inside ${p}'s laugh.`,
  ],
  builder: p => [
    `${p} taps the plank into true.`,
    `Sawdust sparkles stuck to ${p}.`,
    `${p} straightens nails with patient thumbs.`,
    `Hold the line level with ${p}.`,
    `${p} hands you the louder hammer.`,
    `Up goes the beam with ${p} below.`,
  ],
  role_reversal: p => [
    `Your turn to pour pretend for ${p}.`,
    `${p} sips crowns from plastic tea.`,
    `You tie loose threads while ${p} beams.`,
    `${p} leans wrong into your tiny chair.`,
    `You read the lion part for ${p}.`,
    `${p}'s laugh climbs your pillow throne.`,
  ],
  recipe_together: p => [
    `${p} names each spice without looking.`,
    `Flour fingerprints match ${p} and you.`,
    `${p} tips the spoon, you steer the steam.`,
    `The stirring song belongs to ${p}.`,
    `Bowls scrape blue under ${p}'s wrist.`,
    `Hot bread air hugs ${p}'s sleeve.`,
  ],
  rainy_day_in: p => [
    `${p}'s slippers squeak wet welcome.`,
    `Rain draws stripes past ${p}'s elbows.`,
    `${p} holds the doorway wide for light.`,
    `Dry socks piled by ${p}'s shin.`,
    `${p} hums dryers like maracas.`,
    `Fort cloth glows beside ${p}.`,
  ],
  teaching_moment: p => [
    `${p}'s palms show softer angles.`,
    `Count three slow with ${p}'s thumbs.`,
    `${p} whispers chalk where letters live.`,
    `You chase the rhyme between ${p}'s knees.`,
    `${p} steadies elbows off the sill.`,
    `Patience pours from ${p}'s shrug.`,
  ],
  memory_walk: p => [
    `${p} taps the railing you both know.`,
    `Old bricks remember ${p}'s braid.`,
    `${p} points where squirrels once waved.`,
    `Your pocket weighs what ${p} saved.`,
    `${p}'s footsteps match mossy grooves.`,
    `Two shadows stretch one story long.`,
  ],
  surprise_gift: p => [
    `${p}'s grin leaks through paper folds.`,
    `Ribbon bites match ${p}'s teeth.`,
    `${p} blinks pearls from kitchen steam.`,
    `You hide the sparkle under ${p}.`,
    `${p} gasps quieter than cello.`,
    `Wrapping hugs ${p} from both sides.`,
  ],
  dance_party: p => [
    `${p} spins crumbs into starlight.`,
    `Socks skid loud through ${p}'s kitchen.`,
    `Circles widen under ${p}'s wrists.`,
    `Stereo hums tucked in ${p}'s collar.`,
    `You dip low under ${p}'s laugh.`,
    `${p} claps dusk into pink dust.`,
  ],
  garden_day: p => [
    `${p}'s thumbs press soil like pillows.`,
    `Seeds tuck warm behind ${p}.`,
    `${p} whispers mulch into rows.`,
    `Water arcs bow toward ${p}.`,
    `Bees braid hair near ${p}'s brim.`,
    `Tomatoes swell toward ${p}'s palm.`,
  ],
  adventure_outing: p => [
    `${p} scouts the bolder stepping stones.`,
    `You lift glass first past ${p}.`,
    `${p}'s braid flags straight through mist.`,
    `You spot first fin thanks to ${p}.`,
    `${p} names clouds like cousins.`,
    `Summit granola splits with ${p}.`,
  ],
  matching_day: p => [
    `${p} ties stripes sideways like you.`,
    `Two cuffs roll crooked beside ${p}.`,
    `${p}'s brim shades half your grin.`,
    `Straw shines matched through ${p}.`,
    `${p} buttons wrong on purpose.`,
    `Photo flash pops twice on ${p}.`,
  ],
};

/** @type {Record<string, (p: string) => string[]>} */
const FATHERS_BY_PLOT = {
  classic_adventure: p => [
    `${p} scouts the bolder stepping stones.`,
    `Backpack kisses knock ${p}'s knees.`,
    `${p}'s thumbs hook folded map.`,
    `You blaze trails thanks to ${p}.`,
    `${p} hums ridges into rhythm.`,
    `Trail mix splits grin with ${p}.`,
  ],
  builder: p => [
    `${p} taps the plank into true.`,
    `Screws spin true through ${p}'s wrist.`,
    `${p} hands you louder measuring tape.`,
    `Level bubbles park on ${p}.`,
    `${p} stomps studs into song.`,
    `Up goes the beam with ${p} below.`,
  ],
  role_reversal: p => [
    `${p} sips sideways from toy cups.`,
    `You crown ${p}'s hair with chenille.`,
    `${p} leans throne into kiddie stool.`,
    `You steer the stroller past ${p}.`,
    `${p} claps seals you invented.`,
    `Chartreuse clay prints ${p}'s chin.`,
  ],
  fix_it: p => [
    `${p}'s toolbox clicks like quiet teeth.`,
    `Wire hums tame between ${p}'s teeth.`,
    `${p} names each screw polite.`,
    `Tape tears loud beside ${p}.`,
    `${p} salutes gasket victory.`,
    `Blueprints curl under ${p}'s elbow.`,
  ],
  camping_trip: p => [
    `${p} breathes marshmallow rings.`,
    `Tent snaps glow against ${p}.`,
    `${p}'s flashlight writes owl eyes.`,
    `You stack twigs beside ${p}.`,
    `${p}'s fleece smells pine and tin.`,
    `Coals hiss yes near ${p}'s knees.`,
  ],
  race_day: p => [
    `${p}'s countdown drums your soles.`,
    `Ribbon grazes teeth near ${p}.`,
    `${p} hands off water taut.`,
    `${p}'s grin leaks stopwatch red.`,
    `You lap sparkler breath from ${p}.`,
    `${p}'s cheers ribbon your ribs.`,
  ],
  teaching_moment: p => [
    `${p} guides handlebars ghost-steady.`,
    `Practice chalk circles ${p}'s sneakers.`,
    `${p}'s palms float under your elbows.`,
    `You cast farther past ${p}.`,
    `${p} whistles knots into rope.`,
    `Pedals spin hymn beside ${p}.`,
  ],
  surprise_breakfast: p => [
    `${p}'s spatula drums dawn awake.`,
    `Plates grin sunny toward ${p}.`,
    `${p}'s apron wears syrup stripes.`,
    `You flip tall beside ${p}.`,
    `${p}'s mugs steam secret shapes.`,
    `Orange juice arcs toast ${p}'s cuffs.`,
  ],
  workshop: p => [
    `${p}'s clamps hum patient moon.`,
    `${p} wipes blade oil like ink.`,
    `Shavings braid curls near ${p}.`,
    `${p}'s goggles fog story steam.`,
    `You sand grain sweet with ${p}.`,
    `${p} thumbs dowels flush true.`,
  ],
  sports_day: p => [
    `${p}'s whistle tastes like peeled lime.`,
    `Cleats carve dust rings ${p}.`,
    `${p} launches spirals loose.`,
    `You spike joy through ${p}.`,
    `${p}'s clipboard wings moth soft.`,
    `Gatorade sunsets stain ${p}.`,
  ],
  treasure_hunt: p => [
    `${p}'s clue crinkles map bright.`,
    `You dig spark near ${p}'s toes.`,
    `${p} winks tinsel moss aside.`,
    `X marks giggles beside ${p}.`,
    `${p}'s flashlight paints doubloons.`,
    `Chest lids sigh with ${p}.`,
  ],
  fort_day: p => [
    `${p} pins blanket starlight tight.`,
    `Clothespins clip courage on ${p}.`,
    `${p}'s flashlight swallows hallway.`,
    `You crown ramparts touching ${p}.`,
    `${p}'s socks slide on carpet tides.`,
    `Pillow turrets flank ${p}'s grin.`,
  ],
};

/**
 * @param {'mothers_day'|'fathers_day'} theme
 * @param {string|null|undefined} plotId
 * @param {string} parentWord
 * @returns {string[]}
 */
function getParentRefrainSuggestions(theme, plotId, parentWord) {
  const p = (parentWord || '').trim() || (theme === 'fathers_day' ? 'Daddy' : 'Mama');
  const id = typeof plotId === 'string' ? plotId.trim() : '';
  if (theme === 'fathers_day') {
    const fn = id && FATHERS_BY_PLOT[id];
    return fn ? fn(p) : defaultFathersRefrains(p);
  }
  const fn = id && MOTHERS_BY_PLOT[id];
  return fn ? fn(p) : defaultMothersRefrains(p);
}

module.exports = {
  getParentRefrainSuggestions,
  defaultMothersRefrains,
  defaultFathersRefrains,
};
