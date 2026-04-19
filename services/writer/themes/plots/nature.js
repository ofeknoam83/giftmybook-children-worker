/**
 * Nature plot templates — 12 structurally distinct story arcs.
 *
 * Each template returns 13 spreads in 4-scene (A/B/C/D) grouping.
 * opts: { child, isYoung, wt, parentName, book, theme }
 */

module.exports = [
  {
    id: 'classic_nature',
    name: 'Classic Nature Quest',
    synopsis: 'The wild woods past the meadow call the child. Deep in the forest, wonder and challenge await — and a gift from nature to carry home.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'HOOK',            description: `${n} discovers something that calls them toward the wild woods past the meadow. Vivid, sensory, immediate. At home or familiar place.`, wordTarget: wt },
        { spread: 2,  beat: 'DISCOVERY',       description: `The forest opens up. Colors, sounds, smells. Wonder fills the scene. Crossing into the wild.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'RISING_1',        description: `${n} ventures deeper. An animal companion may appear. Use child's interests. Same forest.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'RISING_2',        description: `A second discovery, stranger and more beautiful. Nature reveals its secrets.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'DEEP_EXPLORE',    description: `The heart of the wild. ${n} is fully immersed, confident, curious.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'CHALLENGE',       description: `Something goes wrong or gets tricky. A natural obstacle, a moment of doubt.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'CLEVERNESS',      description: `${n} uses something they know to solve it. Working with nature, not against it.`, wordTarget: wt + 2 },
        { spread: 8,  beat: 'TRIUMPH',         description: `The problem is solved. Joy, relief, pride. Nature responds, celebrates.`, wordTarget: wt },
        { spread: 9,  beat: 'WONDER',          description: `A quiet beat of pure wonder. The most beautiful image in the book. Fewest words.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'GIFT',            description: `Nature gives ${n} something to carry home — a feather, a stone, a seed.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'HOMECOMING',      description: `Returning home. The familiar world looks a little different now.`, wordTarget: wt },
        { spread: 12, beat: 'REFLECTION',      description: `Safe at home, but changed. The wild lives inside.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. The woods remember everyone who walks softly. Echo the opening.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'seed_journey',
    name: 'The Seed Journey',
    synopsis: 'The child follows a single seed blown by the wind — watching it travel across meadows, over streams, and into the forest, learning where things take root.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'SEED_BLOWS',      description: `A dandelion puff breaks apart. ${n} watches one seed float away — a tiny parachute on the wind. Curiosity: where is it going? Meadow.`, wordTarget: wt },
        { spread: 2,  beat: 'FOLLOWING',       description: `${n} follows the seed across the meadow. It dips and rises, teasing. Always just ahead, always drifting. Meadow.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'OVER_STREAM',     description: `The seed floats over a stream. ${n} finds stepping stones and crosses. The seed waits on the other side, hovering. Stream crossing.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'INTO_FOREST',     description: `Into the forest — the seed weaves between trees. Dappled light, soft ground, the sound changes. Deeper into nature. Forest.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'MEETING_CREATURES', description: `Along the way: a rabbit watching, a woodpecker drumming, a fox cub peeking. The forest is full of quiet life. Forest.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'SEED_RESTS',      description: `The seed lands on a rock, rests. ${n} sits beside it, both catching breath. A moment of stillness together. Forest clearing.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'WIND_AGAIN',      description: `A gust lifts the seed again. Off it goes! ${n} runs, laughing. The chase continues. Deeper forest.`, wordTarget: wt },
        { spread: 8,  beat: 'PERFECT_SPOT',    description: `The seed drifts down to a patch of rich soil, sunlit and sheltered. It settles. It chose this spot. A tiny clearing. The clearing.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'PLANTING',        description: `${n} gently presses the seed into the soil and covers it. Pats the earth. Waters it from a cupped hand of dew. Fewest words, most care.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'IMAGINING',       description: `${n} imagines the seed growing — first a sprout, then a flower, then a whole meadow. The future unfolds in a daydream. The clearing.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'HEADING_HOME',    description: `Walking home through the forest, then the meadow. Every plant along the way was a seed once too. Everything starts small. Heading home.`, wordTarget: wt },
        { spread: 12, beat: 'HOME_GARDEN',     description: `At home, ${n} picks up another dandelion. Blows. Seeds scatter everywhere. Each one a new journey. NOT bedtime. Garden.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. Every forest started with one brave seed and one good wind. Echo the first puff. Warm, wind-carried, alive.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'animal_hospital',
    name: 'The Animal Hospital',
    synopsis: 'The child finds an injured baby bird and cares for it — building a nest, finding food, keeping it warm — until it\'s strong enough to fly away.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'FINDING',         description: `${n} spots a baby bird on the ground — fluffy, shivering, one wing tucked oddly. It chirps. It needs help. Garden.`, wordTarget: wt },
        { spread: 2,  beat: 'GENTLE_HANDS',    description: `${n} scoops the bird up with cupped hands. So light, so warm. Carries it carefully inside. The rescue begins. Garden to home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'NEST_BUILDING',   description: `Making a nest: a shoebox, torn tissues, a warm sock. ${n} arranges it perfectly. The bird settles in and blinks. At home.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'FEEDING',         description: `What do baby birds eat? Trying seeds, bread crumbs, a mushed berry. The bird opens its beak wide. Success! Feeding time. At home.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'STAYING_CLOSE',   description: `${n} sits beside the box all day. Reading to the bird, singing softly, watching it sleep. The bond grows. At home.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'FIRST_HOP',       description: `The bird hops! Across the box, onto ${n}'s finger, then back. Stronger every hour. ${n} cheers each tiny victory. At home.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'WING_TEST',       description: `The bird stretches its wing — both wings. Flutters them. Not flying yet, but practicing. ${n} watches with held breath. Fewest words. At home.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'OUTSIDE',         description: `${n} takes the bird to the garden. Fresh air, real trees. The bird tilts its head at the sky. Something calling it. Garden.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'FIRST_FLIGHT',    description: `The bird flutters from ${n}'s hand to a low branch. Then higher. Then higher still. It's flying! ${n}'s heart soars with it. Garden.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'GOODBYE_CIRCLE',  description: `The bird circles ${n}'s head once, twice. A chirp that sounds like "thank you." Then it flies toward the trees. Garden.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'WATCHING_GO',     description: `${n} watches until the bird is a speck. The empty shoebox sits on the grass. Bittersweet and proud. Garden.`, wordTarget: wt },
        { spread: 12, beat: 'NEXT_MORNING',    description: `Next day, ${n} hears chirping outside the window. The bird is in the tree, singing. It came back to visit. NOT bedtime. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. Caring for something small is the bravest thing a heart can do. Echo the first chirp. Warm, gentle, winged.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'rain_adventure',
    name: 'The Rain Adventure',
    synopsis: 'Instead of staying inside, the child goes OUT in the rain — discovering a world transformed: mirrors in puddles, rivers in gutters, a whole rain-kingdom.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'RAIN_STARTS',     description: `Rain against the window. Everyone says "Stay inside." But ${n} pulls on boots and pushes out the door. Into the wet. Front door.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_PUDDLE',    description: `The first puddle — SPLASH! Water flies. Boots shine. ${n} jumps again, harder. The puddle is a mirror of the sky. The street.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'GUTTER_RIVER',    description: `The gutter has become a river! ${n} launches a leaf-boat and races alongside it. The leaf spins through rapids of rainwater. The street.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'RAIN_SOUNDS',     description: `Listening: rain on leaves sounds different from rain on metal, rain on puddles, rain on ${n}'s hood. A whole orchestra. The neighborhood.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'MUD_PLAY',        description: `A muddy patch becomes a construction site. ${n} builds a mud dam, a mud castle, a mud pie. Brown, squelchy, perfect. The park.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'CREATURES_OUT',   description: `Worms on the path, snails on the wall, a frog in the grass. The rain brought everyone out. ${n} greets each one. The park.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'RAIN_QUIET',      description: `Standing still in the rain. Eyes closed, face up. Drops on eyelids, on lips, on cheeks. The most peaceful feeling. Fewest words. Open space.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'BIGGEST_PUDDLE',  description: `The BIGGEST puddle — deep enough to wade in. ${n} marches through it like crossing an ocean. Maximum splash, maximum joy. The park.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'RAINBOW',         description: `The rain eases. A break in the clouds. A rainbow appears — the payoff for getting wet. ${n} stands beneath it, dripping and amazed. The park.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'SUN_RETURNS',     description: `Sunlight on wet everything — sparkling grass, gleaming puddles, steaming sidewalks. The world is polished and new. Walking home.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'SQUELCHING_HOME', description: `Walking home in wet boots, squelch-squelch-squelch. Soaked and grinning. Leaving wet footprints on the path. Heading home.`, wordTarget: wt },
        { spread: 12, beat: 'WARM_INSIDE',     description: `Inside, boots off, dripping on the mat. Everything smells like rain and grass. ${n} presses nose to window — already missing it. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. The best days are the ones you're not supposed to go outside. Echo the boots. Warm, wet, wild.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'tree_friend',
    name: 'The Favorite Tree',
    synopsis: 'The child has a favorite tree. Today they visit it through every season in one magical day — spring blossoms, summer shade, autumn colors, winter silence.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'MEETING_TREE',    description: `${n} walks to their favorite tree — a big, old tree they visit often. Today it looks different. It shimmers. The tree is awake. Near the tree.`, wordTarget: wt },
        { spread: 2,  beat: 'SPRING',          description: `The tree bursts into spring — blossoms everywhere, pink and white petals falling like snow. A robin builds a nest. ${n} catches petals. Under the tree.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SPRING_PLAY',     description: `Playing in the spring tree — climbing the lowest branch, finding caterpillars, listening to bees. New life everywhere. Under the tree.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'SUMMER',          description: `The tree shifts to summer — full green canopy, thick shade, the buzzing of insects. Hot sun everywhere except under the tree's cool shadow. Under the tree.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'SUMMER_PLAY',     description: `Summer activities: reading against the trunk, eating fruit that drops from above, watching ants march. Lazy, warm, perfect. Under the tree.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'AUTUMN',          description: `The leaves turn — red, gold, orange, brown. They fall in spirals. The tree is a bonfire of color. The air cools. Under the tree.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'AUTUMN_PLAY',     description: `Kicking through leaves, making leaf piles, finding acorns and conkers. A squirrel buries one nearby. Fewest words, deepest colors. Under the tree.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'WINTER',          description: `The tree is bare — branches like a drawing against a grey sky. Snow settles on the limbs. The tree is still beautiful, just quiet. Under the tree.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'WINTER_BEAUTY',   description: `Snow on every branch. An icicle hangs like a crystal. The tree's skeleton is art. ${n} presses a warm hand against the cold bark. Under the tree.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'BACK_TO_NOW',     description: `The tree shimmers again and returns to the real season. ${n} hugs the trunk. The bark is warm. The tree is old, patient, and always here. Under the tree.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'TREE_GIFT',       description: `The tree drops one perfect thing — a leaf, a seed, a piece of bark. A gift from an old friend. Under the tree.`, wordTarget: wt },
        { spread: 12, beat: 'WALKING_HOME',    description: `${n} walks home, looking back once. The tree stands tall and steady. Always there. Always waiting. NOT bedtime. Heading home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. Some friends have roots. Echo the first shimmer. Warm, rooted, eternal.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'bug_safari',
    name: 'The Bug Safari',
    synopsis: 'Armed with a magnifying glass, the child goes on a safari through the garden — discovering ant highways, beetle battles, spider architecture, and caterpillar parades.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'MAGNIFYING_GLASS', description: `${n} picks up a magnifying glass and declares: "Safari time." The garden is the jungle. ${n} is the explorer. Garden.`, wordTarget: wt },
        { spread: 2,  beat: 'ANT_HIGHWAY',     description: `First discovery: an ant highway! Hundreds of ants marching in a line, carrying crumbs ten times their size. ${n} watches, amazed. Garden ground.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'BEETLE_BATTLE',   description: `Two beetles pushing a berry — is it a fight or teamwork? ${n} watches the drama unfold. A tiny battle of wills. Garden ground.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'SPIDER_WEB',      description: `A perfect spider web — dew drops on every thread like diamonds. The spider sits in the center, still and proud. Architecture. Garden.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'CATERPILLAR',     description: `A caterpillar crossing the path — so slow, so determined. ${n} lies flat on the ground, face-to-face with it. Use child's interests in observation. Garden.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'UNDER_A_ROCK',    description: `Lifting a rock: a whole hidden world! Woodlice, centipedes, a slug. ${n} peers in with the magnifying glass. A city revealed. Garden.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'BUTTERFLY',       description: `A butterfly lands on ${n}'s hand. Perfectly still. The most delicate creature, up close. Through the glass: patterns within patterns. Fewest words.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'WORM_DIG',        description: `Digging finds earthworms — pink, wriggling, essential. ${n} holds one gently, then puts it back. The underground workers. Garden soil.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'BEE_VISIT',       description: `A bee lands on a flower and ${n} watches the whole process — legs dusty with pollen, buzzing from bloom to bloom. The hardest worker. Garden.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'DISCOVERY_LOG',   description: `${n} draws every creature seen today in a notebook. Each one gets a name and a portrait. The safari journal. Garden.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'EVENING_SOUNDS',  description: `As the sun lowers, new sounds: crickets starting, a firefly blinking. The night crew is coming on shift. Garden.`, wordTarget: wt },
        { spread: 12, beat: 'GLASS_DOWN',      description: `${n} puts down the magnifying glass. The garden looks different now — alive with tiny dramas, tiny heroes. NOT bedtime. Garden.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. The biggest world is the one under your feet. Echo the first declaration. Warm, small, teeming.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'river_follow',
    name: 'Following the River',
    synopsis: 'The child follows a stream from a tiny trickle in the garden to where it joins a river — discovering what lives along its banks and where water goes.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'TRICKLE',         description: `A tiny trickle of water in the garden — where does it come from? Where does it go? ${n} follows it. Garden.`, wordTarget: wt },
        { spread: 2,  beat: 'GROWING',         description: `The trickle joins another and becomes a stream. Rocks to hop, banks to climb. ${n} walks alongside, matching its pace. Near the garden.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'STREAM_LIFE',     description: `Life in the stream: a frog on a rock, a dragonfly hovering, tiny fish darting. ${n} spots each one like a treasure. Streamside.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'WATERFALL',       description: `A small waterfall! Water tumbling over mossy rocks. ${n} puts a hand in the cascade — cold and alive. The spray catches light. Waterfall.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'BRIDGE',          description: `A fallen log bridges the stream. ${n} crosses carefully, arms out for balance. A bird cheers from a branch. Over the stream.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'WIDER_STREAM',    description: `The stream is wider now — too wide to jump. ${n} walks along the bank through taller grass. The water knows where it's going. Along the bank.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'QUIET_POOL',      description: `A still, clear pool where the stream rests. ${n} can see the bottom — pebbles, a crayfish, ${n}'s own reflection. Fewest words. The pool.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'MEETING_RIVER',   description: `The stream joins a river! Wide, slow, powerful. ${n} stands at the meeting point and watches the small water become part of something big. River junction.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'RIVER_BANK',      description: `Walking along the river — bigger fish, a heron standing still, a family of ducks. The river world is grander but just as alive. River bank.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'STICK_BOAT',      description: `${n} drops a stick in the river and watches it float away — carrying all the journey's memories downstream. River bank.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'HEADING_HOME',    description: `Walking home, upstream now. Past the pool, the waterfall, the original trickle. Everything connected by water. Heading home.`, wordTarget: wt },
        { spread: 12, beat: 'GARDEN_TRICKLE',  description: `Back where it started — the tiny trickle in the garden. ${n} kneels and watches it flow, knowing now where it's headed. NOT bedtime. Garden.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. Every river starts with one brave drop. Echo the first trickle. Warm, flowing, connected.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'forest_concert',
    name: 'The Forest Concert',
    synopsis: 'The child discovers that the forest makes music — wind in the leaves is a flute, woodpeckers are drums, the creek is a bass. Together, they perform a symphony.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'HEARING_IT',      description: `${n} steps into the forest and hears it — not just noise, but music. Wind in the leaves plays a tune. The forest is an orchestra. Forest edge.`, wordTarget: wt },
        { spread: 2,  beat: 'WIND_FLUTE',      description: `The wind through tall pines sounds like a flute — high, clear, wavering. ${n} follows the melody deeper into the trees. Pine grove.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'WOODPECKER_DRUMS', description: `A woodpecker joins in — TAK TAK TAK. The rhythm section. It hammers in time with the wind. ${n} claps along. Near a dead tree.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'CREEK_BASS',      description: `The creek adds a low, steady hum — water over rocks, a bass line under everything. The forest's heartbeat. Creekside.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'BIRD_CHORUS',     description: `Birds join from every direction — robin, jay, wren, thrush. Each with its own part. The melody builds. ${n} whistles along. Forest canopy.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'ADDING_SOUNDS',   description: `${n} finds instruments — a hollow log to drum, a stick to scrape on bark, a leaf to hum through. Joining the band. Forest floor.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'SILENCE_BEAT',    description: `Everything stops at once. Pure silence. A rest in the music. ${n} holds breath. The forest holds breath. Then — it starts again. Fewest words. Forest.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'CRESCENDO',       description: `The music swells — all parts together, louder, richer. Frogs add croaks, crickets add chirps, the wind gusts. Maximum sound and joy. Forest.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'SOLO',            description: `The forest gives ${n} a solo — everything quiets while ${n} sings, hums, or plays the hollow log. One small voice carrying the melody. Forest clearing.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'FINALE',          description: `Everyone together for the finale. The biggest, most beautiful moment. Every creature, every element, every sound. Then it fades. Forest.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'APPLAUSE',        description: `The forest's applause: a rustle of leaves, a chatter of squirrels, a splash from the creek. ${n} bows to the trees. Forest.`, wordTarget: wt },
        { spread: 12, beat: 'WALKING_HOME',    description: `Walking out of the forest. The music fades but ${n} carries the melody inside, humming it. NOT bedtime. Heading home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. The forest plays every day — you just have to show up and listen. Echo the first hearing. Warm, musical, wild.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'cloud_watcher',
    name: 'The Cloud Watcher',
    synopsis: 'Lying in a meadow, the child watches clouds transform — into animals, castles, ships. Each cloud tells a story, and the last one looks just like the child.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'LYING_DOWN',      description: `${n} lies flat in a meadow. Grass tickles. The sky is huge and full of clouds moving slowly. Time to watch. Meadow.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_CLOUD',     description: `A cloud shaped like a cat — ears, tail, whiskers. It stretches and yawns across the sky. ${n} points and laughs. Meadow, looking up.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SECOND_CLOUD',    description: `A castle cloud — towers, a drawbridge, flags that flutter in the high wind. A whole kingdom floating by. Meadow.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'THIRD_CLOUD',     description: `A ship cloud — sailing across the blue. ${n} imagines being aboard, the wind in the sails, the waves (clouds) below. Meadow.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'CHANGING',        description: `The cat becomes a whale. The castle melts into a mountain. Everything is always becoming something else. Use child's interests. Meadow.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'STORY_CLOUD',     description: `A cloud that seems to act out a story — a dragon chases a bird, the bird escapes, the dragon becomes a flower. A sky movie. Meadow.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'SMALLEST_CLOUD',  description: `The smallest cloud, all alone, drifting slowly. Where is it going? ${n} watches it travel across the entire sky. Fewest words. Meadow.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'BIGGEST_CLOUD',   description: `The biggest cloud of the day — a mountain of white, towering and magnificent. It blocks the sun for a moment, then passes. Awe. Meadow.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'CHILD_CLOUD',     description: `A cloud that looks like ${n}! Same hair, same pose. ${n} waves — the cloud seems to wave back. The most personal, magical moment. Meadow.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'SKY_CLEARS',      description: `The clouds thin and scatter. Blue stretches wide. The show is winding down. ${n} watches the last wisps dissolve. Meadow.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'SITTING_UP',      description: `${n} sits up. Grass marks on both elbows. The meadow is still and warm. The sky is empty now but ${n} feels full. Meadow.`, wordTarget: wt },
        { spread: 12, beat: 'WALKING_HOME',    description: `Walking home, looking up every few steps. A new cloud forms — just a puff. The next show is already starting. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. The sky tells a new story every day for anyone who lies down to listen. Echo the first lie-down. Warm, soft, infinite.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'seasons_walk',
    name: 'The Seasons Walk',
    synopsis: 'The child walks a single path through the woods four times — once in each season — noticing how everything changes and how some things stay the same.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'SPRING_START',    description: `${n} steps onto a forest path in spring. Puddles, mud, buds on every branch. The world is waking up. Forest path, spring.`, wordTarget: wt },
        { spread: 2,  beat: 'SPRING_DETAILS',  description: `Crocuses pushing through snow, tadpoles in the pond, a bird carrying a twig. Spring means beginnings. ${n} touches a new leaf. Same path.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SPRING_FEELING',  description: `The air smells like rain and dirt and flowers all at once. ${n}'s jacket unzips — warm enough! The path in spring feels like hope. Same path.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'SUMMER_SAME_PATH', description: `The same path in summer — thick green everywhere, buzzing insects, the pond full of lily pads. Hot sun through leaves. Forest path, summer.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'SUMMER_DETAILS',  description: `Berries to eat, a dragonfly landing on ${n}'s finger, the long grass tickling legs. Summer means fullness. Same path.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'SUMMER_FEELING',  description: `Shade and light, shade and light as ${n} walks. The path feels endless and lazy. Summer slows everything down. Same path.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'AUTUMN_SAME_PATH', description: `The path in autumn — a carpet of red and gold. The trees are on fire with color. The air is crisp. Fewest words, most color. Forest path, autumn.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'AUTUMN_DETAILS',  description: `Kicking through leaves, finding a perfect acorn, watching a squirrel bury treasure. Autumn means letting go. Same path.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'WINTER_SAME_PATH', description: `The path in winter — bare branches, frost on everything, the pond frozen solid. The world is quiet and silver. Forest path, winter.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'WINTER_DETAILS',  description: `Footprints in snow, icicles on the branches, breath making clouds. A robin on a bare branch — the only color. Winter means patience. Same path.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'WHAT_STAYS',      description: `The same old tree is on the path in every season. The same rock. The same curve. Some things change; some things wait. Same path.`, wordTarget: wt },
        { spread: 12, beat: 'SPRING_AGAIN',    description: `Back to spring — the first crocus again, the first bud. ${n} recognizes it. The circle is complete but new. NOT bedtime. Forest path, spring.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. The path is always the same and always different. Echo the first step. Warm, cyclical, endless.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'stone_collection',
    name: 'The Stone Collection',
    synopsis: 'The child goes on a walk and collects stones — each one unique, each one with a story. A smooth river stone, a speckled egg-stone, a crystal geode.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'FIRST_STONE',     description: `${n} picks up a stone from the path — smooth, warm from the sun. It fits perfectly in a palm. The collection begins. Path near home.`, wordTarget: wt },
        { spread: 2,  beat: 'RIVER_STONE',     description: `At the stream: a flat river stone, worn smooth by water. Perfect for skipping. ${n} pockets it instead — too beautiful to throw. Streamside.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SPECKLED_STONE',  description: `A speckled stone that looks like an egg — dots of gold on grey. ${n} turns it over and over, imagining what hatched from it. Forest path.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'CRYSTAL_STONE',   description: `A broken rock with crystals inside — tiny purple or white points catching the light. A treasure hidden in plain rock. Hillside.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'HEAVY_STONE',     description: `A stone so heavy ${n} can barely lift it. Dense, dark, ancient. How old is this stone? Older than the trees, older than the path. Hillside.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'FOSSIL_STONE',    description: `A stone with a pattern — a spiral, a leaf print. A fossil! Something lived millions of years ago and left its shape here. Wonder. Rocky area.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'WARM_STONE',      description: `A stone that sits in the sun and holds the warmth. ${n} presses it to one cheek. The stone's gift: stored sunshine. Fewest words. Sunny spot.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'STACK',           description: `${n} stacks stones into a tower — balancing, adjusting, holding breath. The tower stands! A cairn marking the spot. Building spot.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'PAINTED_STONE',   description: `With a wet finger, ${n} draws a face on a flat stone. It grins back. Then another — a family of stone people. Playing with stones.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'LISTENING',       description: `${n} holds a stone to one ear (like a shell). Silence. But somehow that silence is the sound of a whole mountain. A deep quiet. Same spot.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'HEAVY_POCKETS',   description: `Pockets full and heavy. ${n} walks home slowly, stones clinking with each step. The best kind of heavy. Heading home.`, wordTarget: wt },
        { spread: 12, beat: 'DISPLAY',         description: `At home, ${n} arranges every stone on the windowsill. Smooth, speckled, crystal, fossil. A museum of the walk. NOT bedtime. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. Every stone has been somewhere longer than anyone remembers. Echo the first warm stone. Warm, ancient, held.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
];
