/**
 * Bedtime plot templates — 12 structurally distinct story arcs.
 *
 * Each template returns 13 spreads in 4-scene (A/B/C/D) grouping.
 * opts: { child, isYoung, wt, parentName, book, theme }
 */

module.exports = [
  {
    id: 'classic_bedtime',
    name: 'Classic Bedtime Routine',
    synopsis: 'The evening unfolds in its comforting rhythm — bath, pajamas, story, lights out. Each familiar step carries the child deeper into warmth and safety.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'EVENING_BEGINS',   description: `The sky outside turns orange and pink. ${n} watches the last slice of sun dip below the rooftops. Evening is here. At home, by a window.`, wordTarget: wt },
        { spread: 2,  beat: 'BATH_TIME',         description: `Warm water, bubbles that catch the light, a rubber duck bobbing. ${n} splashes gently, making small waves. The bathroom is steamy and soft.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'TOWEL_WRAP',        description: `Wrapped in a big towel like a cocoon. ${n} shuffles down the hall, feet leaving damp prints on the floor. Warm and bundled. Hallway.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'PAJAMAS',           description: `Favorite pajamas — soft, worn, perfect. ${n} pulls them on and feels the day slide away. The fabric smells like home. Bedroom.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'TOOTH_BRUSHING',    description: `Mint and foam. ${n} makes faces in the mirror, mouth full of toothpaste. A small, silly ritual. Bathroom.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'CHOOSING_BOOK',     description: `The bookshelf glows in lamplight. ${n} runs a finger along the spines, choosing tonight's story. The most important decision of the evening. Bedroom.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'STORY_TIME',        description: `Tucked under covers, the story begins. Words wrap around ${n} like a second blanket. The room shrinks to just the bed and the voice. Bedroom.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'STUFFED_FRIENDS',   description: `${n} arranges the stuffed animals — each one in its proper spot. A bear here, a rabbit there. Everyone accounted for. In bed.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'LIGHTS_DIM',        description: `The big light goes off. The night light glows soft blue. The room changes shape — shadows are gentle, corners are round. Bedroom, dimmed.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'LISTENING',         description: `${n} listens to the house settling — the fridge humming, a clock ticking, the faraway murmur of the world going to sleep. In bed.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'HEAVY_EYES',        description: `Eyelids heavy as stones. ${n} blinks slowly. The pillow is the softest thing in the world. Everything is warm. In bed.`, wordTarget: wt },
        { spread: 12, beat: 'LAST_THOUGHT',      description: `One last thought drifts through — something happy from the day, a smile still on ${n}'s lips. The thought floats away like a balloon. In bed.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. Sleep arrives like a friend who was waiting just outside the door. Echo the evening sky. Warm, safe, held.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'dream_door',
    name: 'The Dream Door',
    synopsis: 'A small glowing door appears on the bedroom wall as the child drifts off. Behind it: gentle dream-lands of cotton-candy hills, singing rivers, and friendly creatures made of starlight.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'DOOR_APPEARS',     description: `${n} is almost asleep when a tiny door glows on the bedroom wall — no bigger than a hand. Warm light leaks through the cracks. Bedroom.`, wordTarget: wt },
        { spread: 2,  beat: 'OPENING',           description: `${n} touches the door and it swings open. A breeze like warm honey. The bedroom melts away and a dream meadow stretches out. Crossing over.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'COTTON_HILLS',      description: `Hills made of cotton and cloud. ${n} bounces across them, each landing softer than the last. The sky is lavender. Dream meadow.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'SINGING_RIVER',     description: `A river that hums a lullaby. The water is warm and silver. ${n} trails fingers in it and the song changes to match the touch. Dream river.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'STARLIGHT_CREATURE',description: `A creature made of starlight approaches — friendly, glowing, translucent. It blinks slowly and offers a paw. A dream guide. Dream meadow.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'GENTLE_FLIGHT',     description: `The creature lifts ${n} gently into the air. Floating over the dream-land — everything below is soft-edged and luminous. Dream sky.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'DREAM_GARDEN',      description: `Landing in a garden where flowers glow and close gently when touched, like sleeping eyes. Everything breathes slowly. The quietest dream. Dream garden.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'DREAM_PLAY',        description: `${n} plays in the dream — sliding down moonbeams, catching falling stars that dissolve into giggles. Weightless and warm. Dream world.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'DREAM_GIFT',        description: `The starlight creature gives ${n} a tiny orb of light — a dream to keep. It pulses gently in ${n}'s palm. Dream garden.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'FADING_SOFT',       description: `The dream-land begins to shimmer and soften. Edges blur. Colors melt together like watercolors in rain. Drifting back. Dream world, fading.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'DOOR_AGAIN',        description: `The little door glows once more. ${n} steps through and the bedroom returns — pillow, blanket, stuffed animals. But the warmth stays. Bedroom.`, wordTarget: wt },
        { spread: 12, beat: 'DEEPER_SLEEP',      description: `${n} curls up, the dream-light still faintly glowing behind closed eyelids. The door on the wall fades, waiting for tomorrow night. In bed.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. Every night the door appears for those who close their eyes gently enough. Echo the first glow. Warm, dreamy, infinite.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'star_lullaby',
    name: 'The Star Lullaby',
    synopsis: 'A bright star outside the window begins to sing — a lullaby that only the child can hear. The song carries images of gentle places, and by the last note, sleep has arrived.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'STAR_APPEARS',     description: `${n} is in bed, looking out the window. One star burns brighter than the rest. It pulses, almost like breathing. Bedroom, by the window.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_NOTE',        description: `A sound — not quite a hum, not quite a chime. The star is singing. ${n} sits up, listening. The melody is warm and low. Bedroom.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SONG_PICTURE_1',    description: `The song paints a picture in ${n}'s mind — a wide, soft meadow where fireflies drift. ${n} can almost feel the grass. In bed, eyes closed.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'SONG_PICTURE_2',    description: `The melody shifts. Now it shows a warm beach at twilight — waves whispering, sand still warm from the day. ${n} sinks deeper into the pillow. In bed.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'SONG_PICTURE_3',    description: `The song brightens. A cozy cabin with a fire crackling, snow falling outside, hot cocoa steam curling upward. ${n}'s favorite kind of warm. In bed.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'JOINING_IN',        description: `${n} hums along, matching the star's melody. The two voices together are prettier than either alone. A duet across space. Bedroom.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'QUIETEST_NOTE',     description: `The star sings the softest note — barely a whisper. The room goes perfectly still. ${n}'s breathing slows to match. The most peaceful moment. Bedroom.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'SONG_CARRIES',      description: `The lullaby lifts ${n}'s thoughts like feathers on a breeze. Memories from the day float past gently — a laugh, a color, a taste. In bed.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'OTHER_STARS',        description: `Other stars join the chorus — a whole sky singing in harmony. The night is a choir. Each star adds one note. Bedroom window.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'FADING_SONG',       description: `The melody slows, grows quieter, stretches out. Each note lasts longer than the last. The spaces between notes fill with warm silence. In bed.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'LAST_NOTE',         description: `The star holds its final note — long, steady, and kind. It fades so gently ${n} can't tell where the sound ends and sleep begins. In bed.`, wordTarget: wt },
        { spread: 12, beat: 'ASLEEP',            description: `${n} is asleep. The star outside dims to its normal twinkle, satisfied. The window frames the quiet sky. Bedroom, peaceful.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. Every night the star sings again, whether or not anyone remembers to listen. Echo the first bright pulse. Warm, sung, held.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'blanket_fort',
    name: 'The Blanket Fort',
    synopsis: 'The child builds a blanket fort on the bed — but the blankets keep growing, the pillows multiply, and the fort becomes a real castle with soft towers and fabric drawbridges.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'BUILDING',         description: `${n} drapes a blanket over two pillows and crawls inside. A fort! Small, crooked, perfect. The first wall of a kingdom. Bedroom.`, wordTarget: wt },
        { spread: 2,  beat: 'FORT_GROWS',        description: `Another blanket added, then another. The fort expands — tunnels form, rooms appear, a blanket tower rises. It's getting bigger than the bed. Bedroom.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'BECOMING_REAL',     description: `The fabric walls stiffen into stone. The pillow floor becomes a marble hall. The blanket fort is becoming a real castle. ${n} stands in the great hall. Castle.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'THRONE_ROOM',       description: `A throne made of stacked pillows, draped in the softest blanket. ${n} sits and feels the whole castle hum with sleepy magic. Castle throne room.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'CASTLE_EXPLORE',    description: `Exploring the castle — a room full of books, a room full of stars, a room that smells like cookies. Each room is a different kind of cozy. Castle corridors.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'TOWER_CLIMB',       description: `${n} climbs the tallest tower. At the top: a window overlooking a moonlit kingdom of rolling fabric hills and pillow mountains. Castle tower.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'QUIET_ROOM',        description: `The quietest room in the castle — nothing but a single candle and the sound of ${n}'s own breathing. The most peaceful place in the world. Castle room.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'CASTLE_FRIENDS',    description: `Soft creatures live here — knitted rabbits, felt foxes, stitched owls. They bow to ${n} and offer warm milk in thimble cups. Castle hall.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'FEAST',             description: `A feast of dream-food: cloud cake, starlight soup, marshmallow bread. Everything tastes like warmth and comfort. ${n} eats slowly. Castle dining room.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'CASTLE_YAWN',       description: `The castle itself yawns — the walls stretch, the candles dim, the floors grow softer. Even the castle is getting sleepy. Castle, dimming.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'ROYAL_BED',         description: `The grandest bed in the castle — piled with quilts and clouds. ${n} sinks into it. The felt creatures curl up nearby. Castle bedroom.`, wordTarget: wt },
        { spread: 12, beat: 'FORT_AGAIN',        description: `The castle softens back into blankets. ${n} is in the fort again, on the bed, surrounded by pillows. But the warmth of the castle lingers. In bed.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. Every blanket fort is a castle if you build it with enough bedtime magic. Echo the first draped blanket. Warm, soft, royal.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'moonlight_visitor',
    name: 'The Moonlight Visitor',
    synopsis: 'The moon peeks through the curtains and starts talking — telling stories of what it sees from up there: the ocean glowing, wolves howling, other children sleeping around the world.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'MOON_PEEKS',       description: `A sliver of moonlight pushes through the curtains and falls across ${n}'s bed like a silver finger. The moon is looking in. Bedroom.`, wordTarget: wt },
        { spread: 2,  beat: 'MOON_SPEAKS',       description: `A low, round voice: "Are you still awake?" The moon is talking. ${n} whispers back. The most extraordinary conversation begins. Bedroom.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'OCEAN_STORY',       description: `The moon tells of the ocean it sees from above — silver waves rolling, whales sleeping in the deep, boats rocking gently. ${n} imagines it all. In bed.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'MOUNTAIN_STORY',    description: `The moon describes snowy mountains — peaks like teeth, wind singing between them, a fox curled in a den. Far-away places, close through the telling. In bed.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'CITY_STORY',        description: `The moon tells of a city where every window is a tiny glowing square — families inside, each one doing their evening. A mosaic of warmth. In bed.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'FOREST_STORY',      description: `A moonlit forest — owls hooting, deer stepping silently, mushrooms glowing faintly. The moon lights the path for the night creatures. In bed.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'CHILDREN_SLEEPING', description: `The moon whispers about other children sleeping right now — all around the world, in different beds, dreaming different dreams. The gentlest image. In bed.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'DESERT_STORY',      description: `The moon describes a desert — sand still warm from the day, a lizard tucked under a rock, stars reflected in a tiny oasis. In bed.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'QUESTION',          description: `${n} asks the moon: "Do you ever sleep?" The moon laughs softly — a sound like light rippling on water. "I rest when the sun comes." In bed.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'PERSONAL_STORY',    description: `The moon tells ${n}'s own story — what it saw from above today: ${n} playing, laughing, being brave. "I watched you." Tender and specific. In bed.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'MOON_LULLABY',      description: `The moon hums — not words, just light made into sound. The beam on the bed grows warmer and softer. ${n}'s eyes are heavy. In bed.`, wordTarget: wt },
        { spread: 12, beat: 'MOON_RETREATS',     description: `The voice fades to a whisper, then to silence. The moonlight settles like a blanket across ${n}'s sleeping form. A guardian. In bed.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. The moon visits every window, but it stays longest at the ones that whisper back. Echo the first silver finger. Warm, round, watched-over.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'sleepy_animals',
    name: 'Sleepy Animals',
    synopsis: 'One by one, every animal in the world is falling asleep — the lion yawns, the whale sinks, the sparrow tucks. The child watches each one until sleep arrives for them too.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'WHO_SLEEPS_FIRST', description: `${n} wonders from bed: who falls asleep first in the whole world? Somewhere, right now, an animal is closing its eyes. The wondering begins. In bed.`, wordTarget: wt },
        { spread: 2,  beat: 'LION_SLEEPS',       description: `A lion in the golden grass folds its great paws and lowers its heavy head. The mane pools around it like a pillow. The lion is asleep. Imagined savanna.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'WHALE_SINKS',       description: `A whale drifts downward in dark water — slowly, slowly — until it hovers in the deep, one eye closed, dreaming of krill. Imagined ocean.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'BEAR_CURLS',        description: `${n} imagines a bear in a cave circling once, twice, then dropping into a furry heap. Its breath makes the cave warm. Snow piles up outside. Imagined cave.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'SPARROW_TUCKS',     description: `A sparrow on a branch pulls its head under a wing. So small, so round. The branch barely bends. The whole tree holds still. Imagined tree.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'KITTEN_KNOTS',      description: `A kitten on a doorstep knots itself into a perfect circle — nose to tail. One ear twitches. Then nothing. Pure peace. Imagined doorstep.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'BUTTERFLY_FOLDS',   description: `A butterfly closes its wings — a slow, silent fold. It hangs from a leaf like a tiny lantern turning off. The quietest sleep of all. Imagined garden.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'ELEPHANT_LEANS',    description: `An elephant leans against a tree, sighing so deeply the leaves tremble. Its eyes drift shut. The ground shakes gently with each breath. Imagined jungle.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'FOX_DENS',          description: `A fox slides into its den and curls its bushy tail over its nose — a built-in blanket. The den smells like earth and safety. Imagined den.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'OWL_STAYS',         description: `The owl does not sleep — it blinks its great eyes and watches over the sleeping world. Someone has to keep guard. Imagined tree.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'CHILD_YAWNS',       description: `${n} yawns — the biggest yawn yet. If every animal in the world is sleeping, maybe it's time for ${n} too. In bed.`, wordTarget: wt },
        { spread: 12, beat: 'JOINING_THEM',      description: `${n} curls up like the fox, tucks in like the sparrow, sighs like the elephant. Part of the great sleeping world now. In bed.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. All across the world, everything with eyes is closing them — and ${n} is one of them. Echo the first wondering. Warm, wild, asleep.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'lullaby_river',
    name: 'The Lullaby River',
    synopsis: 'A gentle river of music flows through the bedroom and carries the child\'s bed downstream — past glowing forests, sleeping villages, and a waterfall of whispered lullabies.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'MUSIC_STARTS',     description: `A faint melody — coming from under the bed? The floorboards ripple. A stream of silvery water appears, humming softly. ${n}'s bedroom. Bedroom.`, wordTarget: wt },
        { spread: 2,  beat: 'BED_FLOATS',        description: `The bed lifts gently and floats on the stream. ${n} grips the blanket. The bedroom walls dissolve and the river stretches ahead. The river begins.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'GLOWING_FOREST',    description: `The river winds through a forest where every tree glows from inside — amber, violet, pale gold. The music is coming from the leaves. Lullaby forest.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'SLEEPING_VILLAGE',  description: `A tiny village on the riverbank — cottages with candles in every window. Not a soul awake. The river's song is their lullaby too. Lullaby village.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'FIREFLY_ESCORT',    description: `Fireflies gather around the floating bed — hundreds of them, pulsing in time with the music. A glowing escort downstream. On the river.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'MELODY_SHIFTS',     description: `The river's melody changes — softer now, deeper. ${n} recognizes it: it's the song someone always hums at bedtime. The river knows it too. On the river.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'WATERFALL_WHISPER', description: `A waterfall of whispered lullabies — the water itself is made of gentle words. ${n} floats through the mist and each drop is a murmur of "sleep well." The waterfall.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'STARLIT_LAKE',      description: `The river opens into a wide, still lake reflecting every star. The bed drifts slowly across the middle. Complete calm, complete beauty. Star lake.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'LAKE_CREATURES',    description: `Luminous fish swim alongside the bed, their scales like tiny moons. A gentle turtle surfaces, blinks at ${n}, and dives back down. Star lake.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'CURRENT_SLOWS',     description: `The river narrows again, the current slows. The music fades to a single, sustained note — like a voice holding the word "rest." Gentle river.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'BED_SETTLES',       description: `The bed drifts to a soft bank covered in moss and moonflowers. It settles gently, perfectly. The river laps quietly beside it. River bank.`, wordTarget: wt },
        { spread: 12, beat: 'HOME_AGAIN',        description: `The moss becomes carpet. The moonflowers become curtains. The bedroom is back. ${n} is in bed, the river is gone — but the melody lingers in the walls. Bedroom.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. Every night the river runs just beneath the floor, waiting for someone to listen. Echo the first ripple. Warm, flowing, sung to sleep.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'shadow_puppets',
    name: 'Shadow Puppets',
    synopsis: 'Hands on the wall make shadows that come alive — a shadow rabbit hops across the wall, a shadow bird takes flight, and soon an entire gentle shadow adventure unfolds above the bed.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'HANDS_UP',         description: `The night light throws a warm glow. ${n} holds up two hands against the wall. Fingers bend — a rabbit shape appears in shadow. Bedroom wall.`, wordTarget: wt },
        { spread: 2,  beat: 'RABBIT_HOPS',       description: `The shadow rabbit moves on its own! It hops along the wall, ears bouncing. ${n} gasps and watches it go. The shadows are alive. Bedroom wall.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'BIRD_FLIES',        description: `${n} makes a bird shape — it lifts off the wall and soars across the ceiling, wings spreading wide. A shadow bird circling the room. Ceiling.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'SHADOW_WORLD',      description: `More shapes appear without being made — a shadow tree grows on the wall, shadow flowers bloom, a shadow stream runs along the baseboard. An entire world. Bedroom walls.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'SHADOW_FOREST',     description: `The rabbit hops into a shadow forest. The bird lands on a shadow branch. ${n} watches the adventure unfold on the walls like a movie. Bedroom walls.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'SHADOW_PLAY',       description: `The shadow creatures play — the rabbit chases a shadow butterfly, the bird does loops. ${n} laughs quietly under the covers. Bedroom walls.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'SHADOW_STILLNESS',  description: `Everything stops moving. The shadow world holds a single, perfect pose — the rabbit under the tree, the bird in the branches. Complete peace. Bedroom wall.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'SHADOW_CHILD',      description: `A shadow of ${n} appears on the wall — smaller, simpler, but recognizable. It waves. ${n} waves back. The shadow ${n} steps into the shadow forest. Bedroom wall.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'SHADOW_ADVENTURE',  description: `Shadow ${n} rides the shadow rabbit through the forest, the bird flying overhead. A gentle, silent adventure on the wall. ${n} watches, breathing slow. Bedroom walls.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'SHADOWS_YAWN',      description: `The shadow rabbit yawns. The shadow bird tucks its head under a wing. Even the shadow world is getting sleepy. Bedroom wall.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'SHADOWS_FADE',      description: `The shadow forest slowly dissolves. The creatures melt into the wall, one by one. The last to go is the rabbit, who waves one ear. Bedroom wall.`, wordTarget: wt },
        { spread: 12, beat: 'HANDS_DOWN',        description: `${n} lowers both hands under the blanket. The wall is just a wall again. But the shadows might still be there, just waiting. In bed.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. The night light and a pair of hands can build a world. Echo the first rabbit. Warm, shadowed, alive.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'pillow_clouds',
    name: 'Pillow Clouds',
    synopsis: 'The pillow becomes a cloud that lifts the child gently into a soft night sky — drifting past sleeping birds, through quiet constellations, and over a world tucked in for the night.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'PILLOW_SOFTENS',   description: `${n} fluffs the pillow and sinks in. But the pillow keeps going — softer, puffier, expanding. It's becoming a cloud. ${n}'s bed begins to rise. Bedroom.`, wordTarget: wt },
        { spread: 2,  beat: 'LIFTING_OFF',       description: `The pillow-cloud rises through the ceiling like it's made of mist. ${n} holds on, blanket still wrapped tight. The roof opens to a purple sky. Rising.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'ABOVE_THE_HOUSES',  description: `Floating above the neighborhood. Rooftops below like a quilt of little squares, each window a dim golden eye. The world from above looks cozy. Night sky.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'SLEEPING_BIRDS',    description: `A flock of sparrows asleep on a wire below — tiny round shapes. An owl glides silently past the cloud, nods at ${n}. Night sky.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'THROUGH_STARS',     description: `Drifting through constellations. The stars are closer than expected — they hum softly, tiny and warm. ${n} reaches out and one lands on a fingertip. Night sky.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'CLOUD_FRIENDS',     description: `Other pillow-clouds drift by, each carrying a sleeping animal — a cloud with a curled-up cat, one with a snoring bear cub. A sleeping sky parade. Night sky.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'MOON_CLOSE',        description: `The moon is close now — huge and silver, its craters like gentle dimples. It says nothing, just glows. ${n} floats beside it. The stillest moment. Near the moon.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'OVER_OCEAN',        description: `The cloud drifts over a sleeping ocean — waves like slow breathing, a lighthouse beam turning lazily. Everything below is hushed. Over the ocean.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'OVER_FOREST',       description: `Over a moonlit forest — treetops like broccoli crowns, silver and dark. A river winds through like a ribbon. The whole world is a bedtime picture. Over forest.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'TURNING_HOME',      description: `The cloud turns gently homeward. The familiar neighborhood appears below again. ${n}'s house, the one with the open window. Descending.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'SINKING_BACK',      description: `Down through the open window, through the ceiling. The cloud settles back onto the bed. It's a pillow again — but fluffier than before. Bedroom.`, wordTarget: wt },
        { spread: 12, beat: 'DEEP_IN_PILLOW',    description: `${n}'s head presses deep into the pillow-cloud. It still smells faintly of stars and ocean air. Eyes close. In bed.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. Every pillow remembers the sky it came from. Echo the first fluff. Warm, floating, cloud-carried.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'counting_sheep',
    name: 'Counting Sheep',
    synopsis: 'The sheep don\'t jump fences — they go on their own bedtime adventure. Each numbered sheep does something different: the first takes a bath, the second reads a story, the third puts on pajamas.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'FIRST_SHEEP',      description: `${n} closes eyes to count sheep. Sheep number one appears — but instead of jumping a fence, it runs a bath and climbs in, woolly and all. In bed, imagining.`, wordTarget: wt },
        { spread: 2,  beat: 'SECOND_SHEEP',      description: `Sheep two puts on tiny pajamas — striped ones, with a button that won't close over its wool belly. It waddles happily. ${n} giggles. Imagined.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'THIRD_SHEEP',       description: `Sheep three picks up a book and reads aloud — but the words are all "baa." It turns each page carefully with a hoof, very serious. Imagined.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'FOURTH_SHEEP',      description: `Sheep four brushes its teeth — foam everywhere, the toothbrush stuck in its wool. It grins a minty grin. Imagined.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'FIFTH_SHEEP',       description: `Sheep five arranges a nest of hay and fluffs it like a pillow. Circles three times and flops down with a happy sigh. Imagined.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'SIXTH_SHEEP',       description: `Sheep six sings a lullaby — a sheep lullaby, low and woolly. The other sheep close their eyes and sway. ${n}'s eyelids grow heavy. Imagined.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'SEVENTH_SHEEP',     description: `Sheep seven is already asleep — standing up, leaning against a fence post, snoring tiny sheep-snores. The most peaceful image. Imagined.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'EIGHTH_SHEEP',      description: `Sheep eight makes warm milk — pouring it into a little bowl, steam rising. It drinks slowly, eyes half-closed. Imagined.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'NINTH_SHEEP',       description: `Sheep nine turns off a tiny lamp with a hoof. Its meadow goes dim. It whispers "good night" to the grass. Imagined.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'TENTH_SHEEP',       description: `Sheep ten is the littlest — a lamb. It curls up against its mother's side, nose tucked in warm wool. The tenderest image. Imagined.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'LOSING_COUNT',      description: `${n} tries to count more but the numbers are blurry now. Was that eleven? Twelve? The sheep are all asleep in a woolly pile. In bed.`, wordTarget: wt },
        { spread: 12, beat: 'ALL_ASLEEP',        description: `Every sheep is sleeping. The meadow is quiet. ${n}'s counting voice fades to a murmur, then to nothing. Sleep has arrived. In bed.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. You never reach the last sheep — sleep always finds you first. Echo the first sheep's bath. Warm, woolly, counted to sleep.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'night_sounds',
    name: 'Night Sounds',
    synopsis: 'Every sound at night has a source and a story — the creak is the house stretching, the hoot is the owl checking in, the wind is the sky breathing. Each sound becomes a comfort.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'LIGHTS_OFF',       description: `The light clicks off. The room goes dark. And suddenly ${n} can hear everything — all the sounds the day was too loud to notice. Bedroom.`, wordTarget: wt },
        { spread: 2,  beat: 'HOUSE_CREAK',       description: `CREAK. The house is stretching — settling into its nighttime shape, yawning its wooden yawn. It does this every night. It means "I'm here." Bedroom.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FRIDGE_HUM',        description: `HMMMMM. The fridge downstairs, humming its one-note song. It's keeping the milk cold and the leftovers safe. A faithful, constant sound. In bed, listening.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'OWL_CALL',          description: `HOO-HOO. An owl outside, in the big tree. It's checking — "Who's awake? Who's asleep?" ${n} whispers back: "Almost asleep." In bed, by the window.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'WIND_BREATH',       description: `WHOOOOSH. The wind against the window — the sky is breathing. Big, slow breaths. It sounds like the world turning over in its sleep. In bed.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'CLOCK_TICK',        description: `TICK TICK TICK. A clock somewhere, counting seconds. Each tick is a tiny step toward morning. But morning is far away, and the ticking is steady. In bed.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'RAIN_TAP',          description: `TAP-tap-tap. Rain begins, soft and uncertain. Then steadier. Hundreds of tiny fingers on the roof. The gentlest percussion. The most soothing sound. In bed.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'DISTANT_TRAIN',     description: `A faraway horn — a train passing through the night, miles away. Someone is traveling while ${n} is staying. The sound fades like a dream. In bed.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'CRICKET_CHORUS',    description: `CHR-CHR-CHR. Crickets outside, singing in shifts. They've been at it for hours. They'll sing all night. ${n}'s personal orchestra. In bed, window open.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'HEARTBEAT',         description: `And underneath everything: thu-THUMP, thu-THUMP. ${n}'s own heartbeat, steady and warm. The first sound ${n} ever heard, still playing. In bed, under covers.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'SOUNDS_BLEND',      description: `All the sounds together now — creak, hum, hoo, whoosh, tick, tap, horn, chirp, thump — blending into one soft, continuous murmur. In bed.`, wordTarget: wt },
        { spread: 12, beat: 'SOUND_BLANKET',     description: `The murmur wraps around ${n} like a blanket made of sound. It says: the world is still here, still humming, still safe. In bed.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. The night is never silent — it's full of small voices saying "all is well." Echo the first click. Warm, humming, held.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'pajama_parade',
    name: 'The Pajama Parade',
    synopsis: 'All the stuffed animals put on pajamas and have their own bedtime routine — the bear brushes its felt teeth, the rabbit takes a pretend bath, and they all march in a bedtime parade to the pillow.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'ANNOUNCEMENT',     description: `${n} declares it's bedtime for everyone — and the stuffed animals blink. Did the bear just move? A tiny voice says: "Pajama time!" The shelf comes alive. Bedroom.`, wordTarget: wt },
        { spread: 2,  beat: 'BEAR_GETS_READY',  description: `The teddy bear waddles to a tiny sink (a thimble of water) and brushes its felt teeth with a toothpick. Very serious, very thorough. Bedroom floor.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'RABBIT_BATH',       description: `The stuffed rabbit pretends to take a bath in a teacup. Splashing imaginary water, scrubbing button ears. It wraps in a sock-towel. Bedroom floor.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'PAJAMA_CHOOSING',   description: `All the animals argue about pajamas. The elephant wants stripes. The duck wants stars. ${n} helps — cutting tiny pajamas from old cloth and tissue. Bedroom.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'DRESSED_UP',        description: `Everyone is pajama'd — the bear in flannel, the rabbit in cotton, the giraffe in something polka-dotted. They admire each other. Very proud. Bedroom.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'STORY_DEMAND',      description: `The animals insist on a bedtime story. ${n} opens a book and reads aloud while tiny stuffed bodies gather in a circle, eyes wide with stitched wonder. Bedroom floor.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'PARADE_FORMS',      description: `The parade begins! Bear first, then rabbit, then all the rest, marching in a single-file line across the bedroom floor. Tiny feet shuffling. The quietest march. Bedroom.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'PARADE_PATH',       description: `The parade circles the room — past the bookshelf, under the desk, around the laundry basket. The duck quacks a marching song. ${n} follows behind. Bedroom.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'UP_TO_BED',         description: `One by one, the animals climb up onto ${n}'s bed — hauling themselves up the blanket like tiny mountaineers. Bear pulls rabbit up. Teamwork. The bed.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'FINDING_SPOTS',     description: `Each animal finds its spot — bear by the pillow, rabbit at the feet, duck under the blanket edge. Everyone exactly where they belong. In bed.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'GOODNIGHT_ROUND',   description: `${n} says goodnight to each one by name. Each animal closes its button eyes in turn. A personal farewell for every friend. In bed.`, wordTarget: wt },
        { spread: 12, beat: 'ALL_SETTLED',       description: `Everyone is still. The parade is over, the pajamas are on, the stories are told. ${n} is surrounded by sleeping friends. In bed.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. The best bedtimes are the ones where nobody sleeps alone. Echo the first blink. Warm, fuzzy, together.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
];
