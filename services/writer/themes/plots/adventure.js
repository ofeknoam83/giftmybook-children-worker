/**
 * Adventure plot templates — 12 structurally distinct story arcs.
 *
 * Each template returns 13 spreads in 4-scene (A/B/C/D) grouping.
 * opts: { child, isYoung, wt, parentName, book, theme }
 */

module.exports = [
  {
    id: 'classic_quest',
    name: 'Classic Quest',
    synopsis: 'The child discovers a threshold to a new world, explores it with wonder, faces a challenge using cleverness, and returns home changed.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'HOOK',            description: `${n} discovers something that calls them toward somewhere just past the familiar. Vivid, sensory, immediate. At home or a familiar place.`, wordTarget: wt },
        { spread: 2,  beat: 'DISCOVERY',       description: `The new world opens up. Colors, sounds, textures. Wonder fills the scene. The threshold crossing.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'RISING_1',        description: `${n} ventures deeper. A companion or guide may appear. Use child's interests. Same new world.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'RISING_2',        description: `A second discovery, stranger and more wonderful. The world reveals its rules. Same adventure world.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'DEEP_EXPLORE',    description: `The heart of the adventure world. ${n} is fully immersed, confident, curious. Same location.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'CHALLENGE',       description: `Something goes wrong or gets tricky. A puzzle, a blockage, a moment of doubt. Same adventure world.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'CLEVERNESS',      description: `${n} uses something they know, something from home, to solve it. Resourcefulness. Same location as the challenge.`, wordTarget: wt + 2 },
        { spread: 8,  beat: 'TRIUMPH',         description: `The problem is solved. Joy, relief, pride. The world responds, celebrates. Same adventure world.`, wordTarget: wt },
        { spread: 9,  beat: 'WONDER',          description: `A quiet beat of pure wonder. The most beautiful image in the book. Fewest words. Still in the adventure world.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'GIFT',            description: `The world gives ${n} something to carry home — a token, a memory, a new understanding. The farewell.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'HOMECOMING',      description: `Returning home. Show the journey back. The familiar world looks a little different now.`, wordTarget: wt },
        { spread: 12, beat: 'REFLECTION',      description: `Safe at home, but changed. The adventure lives inside. Echo of the opening. Same home as spread 1.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. A whisper of the adventure still waiting. Echo the opening image. The most beautiful sentence.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'lost_thing',
    name: 'The Lost Thing',
    synopsis: 'The child finds something that clearly doesn\'t belong here — a glowing shell, a lost creature, a forgotten key — and must journey to return it to its rightful home.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'FINDING',         description: `${n} finds something strange and beautiful on the ground — it hums, it glows, it clearly belongs somewhere else. Near home.`, wordTarget: wt },
        { spread: 2,  beat: 'EXAMINING',       description: `Turning it over, studying it. It's warm, it reacts to touch. Where did it come from? What does it want? ${n} decides to find out. Near home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_LEAD',      description: `The thing tugs gently in a direction, like a compass. ${n} follows, leaving the familiar behind. The journey begins. Leaving home.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'WRONG_PLACE',     description: `The first stop — a pond, a hollow tree, a rocky ledge. The thing doesn't fit here. Not its home. Keep going. First location.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'SECOND_TRY',      description: `Another place, another mismatch. But ${n} learns something each time — the thing likes warmth, or shade, or music. Getting closer. Second location.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'DOUBT',           description: `${n} wonders if the thing even has a home. Maybe it's lost forever. A moment of empathy — knowing what it's like to feel out of place. Walking.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'NEW_CLUE',        description: `The thing suddenly glows brighter, hums louder. It recognizes something nearby. Close now! Excitement returns. Near the destination.`, wordTarget: wt },
        { spread: 8,  beat: 'HOME_FOUND',      description: `There it is — the place where the thing belongs. A nest, a grove, a special spot. Others like it are waiting. The thing's home.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'REUNION',         description: `${n} places the thing in its home. It settles, glows, and hums with happiness. The others welcome it back. Joy. The thing's home.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'THANK_YOU',       description: `The thing (or its family) gives ${n} something small in return — a seed, a glow, a sound. A thank you that ${n} can keep. The thing's home.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'WALKING_BACK',    description: `${n} walks home, lighter now. The journey back is quiet and warm. The world feels friendlier. Heading home.`, wordTarget: wt },
        { spread: 12, beat: 'HOME_CHANGED',    description: `Back home, everything familiar feels a little more precious. ${n} sees what belongs here, too. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. Helping something find its home helps you find yours. Echo the discovery. Warm, gentle, purposeful.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'mapmaker',
    name: 'The Mapmaker',
    synopsis: 'The child draws a map of an imaginary place — then discovers the map has become real. They must navigate their own creation, with all its silly inventions.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'DRAWING',         description: `${n} sits with crayons, drawing a map — mountains made of pillows, a river of lemonade, a forest of lollipops. A child's dream world. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'MAP_GLOWS',       description: `The finished map shimmers and glows. The crayon lines pulse. ${n} touches it and — WHOOSH — the room dissolves into the map world. Crossing over.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'MAP_WORLD',       description: `${n} stands inside the map. Everything is exactly as drawn, but real — the pillow mountains are soft, the lemonade river is sour-sweet. Map world.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'FIRST_LANDMARK',  description: `Exploring the first thing ${n} drew — use child's interests. It's even better in real life. Walking through the map world.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'SURPRISE',        description: `Something ${n} drew as a joke is now real and alive — a walking sandwich, a singing tree, a rainbow slide. Unexpected delight. Map world.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'PROBLEM_SPOT',    description: `A part of the map ${n} scribbled carelessly — a wobbly bridge, a dark smudge zone. It's harder to navigate than expected. Must cross it. Map world.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'CREATIVE_FIX',    description: `${n} finds the crayon in a pocket. Draws an addition to fix the problem — a ladder, a light, a friend. It works! Same spot.`, wordTarget: wt },
        { spread: 8,  beat: 'BEST_PART',       description: `The crown jewel of the map — the place ${n} dreamed up most vividly. It's magnificent. Maximum wonder. The center of the map world.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'QUIET_MOMENT',    description: `Sitting in the most beautiful spot on the map. ${n} made this whole world. Pride and awe. The quietest beat. Fewest words. Map world.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'EDGE_OF_MAP',     description: `${n} reaches the edge — where the drawing stops. Beyond is blank space. Time to go home. The map world has boundaries.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'RETURNING',       description: `Walking back through the map. Everything is just as lovely on the return trip. The river waves, the mountains bow. Map world fading.`, wordTarget: wt },
        { spread: 12, beat: 'BACK_HOME',       description: `${n} is home again. The map is just paper now. But the crayon lines still glow faintly, just a little. At home. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. Every map you draw is a world waiting to be real. Echo the crayon moment. Warm, colorful, creator-proud.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'shrink_adventure',
    name: 'The Shrink Adventure',
    synopsis: 'The child becomes tiny — and the backyard becomes a jungle. A blade of grass is a tree, a puddle is a lake, and a ladybug is a friend.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'SHRINKING',       description: `Something magical happens — ${n} shrinks to the size of a thumb. The backyard grass towers overhead like a forest. Ground level.`, wordTarget: wt },
        { spread: 2,  beat: 'NEW_PERSPECTIVE',  description: `Everything is gigantic. A pebble is a boulder, a puddle is a lake, a dandelion is a skyscraper. ${n} looks around in awe. Backyard ground.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_ENCOUNTER',  description: `An ant walks by carrying a crumb bigger than ${n}. A beetle rumbles past like a truck. The ground is alive with creatures. Backyard ground.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'MAKING_FRIENDS',   description: `A ladybug stops and stares. ${n} waves. The ladybug tilts its head. A friendship forms. They start walking together. Backyard ground.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'EXPLORING',        description: `${n} and the ladybug explore — climbing a mushroom, sliding down a leaf, swinging from a spider thread. A tiny adventure. Backyard ground.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'DANGER',           description: `A garden hose turns on! A river of water rushes past. ${n} must find higher ground. Real peril at tiny scale. Same backyard.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'CLEVER_ESCAPE',    description: `${n} uses a leaf as a boat, rides the current to safety. The ladybug flies overhead, guiding the way. Same backyard.`, wordTarget: wt },
        { spread: 8,  beat: 'SAFE_HARBOR',      description: `Landing on a dry rock. Catching breath. The ladybug lands beside ${n}. They did it together. Relief and pride. Backyard.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'WONDER_VIEW',      description: `From the top of the rock, the whole backyard stretches out — a vast, beautiful landscape. ${n} has never seen home like this. Fewest words.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'GROWING_BACK',     description: `A tingle starts. ${n} begins to grow. The grass shrinks, the rock shrinks, the ladybug becomes tiny again. Backyard.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'FULL_SIZE',        description: `Back to normal. The backyard is just a backyard again. But ${n} kneels down and sees the ladybug waving a leg. Backyard.`, wordTarget: wt },
        { spread: 12, beat: 'NEW_EYES',         description: `${n} lies in the grass on purpose now, face close to the ground. A whole world down there, still going. NOT bedtime. Backyard.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',          description: `The last line. The biggest adventures are sometimes the smallest. Echo the shrinking moment. Warm, small, vast.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'wrong_door',
    name: 'The Wrong Door',
    synopsis: 'Every door the child opens leads somewhere unexpected — the closet opens onto a meadow, the fridge door reveals a cave, the garden gate opens to the clouds.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'FIRST_DOOR',      description: `${n} opens the bedroom closet — and instead of clothes, there's a meadow with butterflies. Steps through, amazed. Through the closet.`, wordTarget: wt },
        { spread: 2,  beat: 'MEADOW',          description: `Running through the meadow. Flowers taller than ${n}. A rabbit dashes past. But there's another door standing in the grass. Meadow world.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SECOND_DOOR',     description: `${n} opens the meadow door — it leads to a crystal cave dripping with colored light. Every step echoes. Cave world.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'CAVE_EXPLORE',    description: `Exploring the cave — touching crystals that hum, finding a underground stream that glows blue. Another door at the far end. Cave world.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'THIRD_DOOR',      description: `Through the cave door — and into the clouds! Walking on cottony floor, sun everywhere, birds flying at eye level. Cloud world.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'CLOUD_PLAY',      description: `Jumping between clouds, catching snowflakes that taste like sugar, meeting a friendly wind. A door floats in the air. Cloud world.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'FOURTH_DOOR',     description: `This door leads to the most magical place yet — connected to ${n}'s interests. The best world so far. Maximum wonder. Fewest words.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'BEST_WORLD',      description: `${n} explores this favorite world fully. Playing, discovering, marveling. Everything here fits perfectly. Maximum joy. Favorite world.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'MANY_DOORS',      description: `A hall of doors appears — dozens of them, each one leading somewhere new. ${n} could go anywhere. The thrill of infinite possibility. Door hall.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'CHOOSING_HOME',    description: `${n} finds one door that looks familiar — same wood, same handle. Opens it to peek. Home. The warmest world of all. Door hall.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'STEPPING_THROUGH', description: `${n} steps through into the house. Familiar smells, familiar light. But the adventure changed how everything looks. At home.`, wordTarget: wt },
        { spread: 12, beat: 'DOORS_EVERYWHERE', description: `${n} looks at all the doors at home — closet, fridge, garden gate — with new eyes. Any of them could be the next adventure. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. Every door is a maybe. Echo the first closet moment. Warm, curious, infinite.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'storm_chaser',
    name: 'The Storm Chaser',
    synopsis: 'A whimsical storm blows through and scatters wonderful things — feathers, buttons, notes. The child follows the wind, collecting treasures it leaves behind.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'WIND_ARRIVES',    description: `A playful wind picks up suddenly — not scary, but mischievous. It snatches ${n}'s hat and runs. Outside, near home.`, wordTarget: wt },
        { spread: 2,  beat: 'CHASING',         description: `${n} chases the wind. It drops something — a bright feather from nowhere. Pick it up, keep running. Wind moves on. The street.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SECOND_DROP',     description: `The wind drops a shiny button, a lost ribbon, a marble. Each thing appears mid-air and lands at ${n}'s feet. Collecting treasures. The street.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'INTO_THE_PARK',   description: `The wind heads to the park. Leaves swirl in spirals, making tunnels to run through. ${n} follows, arms full of found things. The park.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'PARK_TREASURES',  description: `In the park, bigger things appear — a paper airplane with a drawing on it, a seashell (nowhere near the sea!), a tiny bell. The park.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'WIND_DANCE',      description: `The wind makes the trees dance. ${n} joins — spinning, leaping, twirling with the gusts. A wild, joyful dance with invisible air. The park.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'CALM_MOMENT',     description: `The wind pauses. Everything is still. ${n} catches breath and examines the treasures collected so far. A quiet inventory. Fewest words. The park.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'WIND_RESUMES',    description: `The wind starts again, bigger now. It carries ${n}'s hat higher, further. The chase leads to a hilltop. The hilltop.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'HILLTOP',         description: `On top of the hill, the wind circles ${n}, making a gentle tornado of all the found things — feather, button, shell, spinning around in beauty. Hilltop.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'HAT_RETURNS',     description: `The wind places the hat gently on ${n}'s head. A final gift — something the wind kept from the very start, now returned. Hilltop.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'WIND_LEAVES',     description: `The wind grows gentle, then still. It's gone, leaving the world quiet and sparkling. ${n} stands with pockets full of treasures. Hilltop.`, wordTarget: wt },
        { spread: 12, beat: 'WALKING_HOME',    description: `${n} walks home, treasures in pockets and hands. Each one tells a piece of the wind's story. NOT bedtime. Heading home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. Some adventures chase you first. Echo the snatched hat. Warm, windswept, treasure-filled.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'bridge_builder',
    name: 'The Bridge Builder',
    synopsis: 'The child must cross a series of gaps to reach a glowing tree on a distant hill — building bridges from whatever is at hand: sticks, stones, music, courage.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'THE_TREE',        description: `${n} spots a glowing tree on a distant hill. It's beautiful and calls to ${n}. But the path is broken — gaps, rivers, walls between here and there. Overlook.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_GAP',       description: `The first gap — a small stream. ${n} lays sticks across it, teetering and adjusting. The first bridge holds! Crossing the stream.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'CONFIDENCE',      description: `On the other side, ${n} looks back proudly. That was easy. Onwards! The path continues toward the hill. Past the stream.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'BIGGER_GAP',      description: `A wider gap — too big for sticks. ${n} stacks stones into stepping stones, tests each one. Wobbles but makes it. Getting harder. Rocky area.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'CREATIVE_BRIDGE',  description: `The next obstacle requires creativity — maybe a log becomes a seesaw, vines become a swing. ${n} uses what's around in a surprising way. Forest area.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'HARD_GAP',        description: `The biggest gap yet. Nothing around to build with. ${n} sits and thinks. The tree glows in the distance, encouraging. Stuck at a cliff edge.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'AHA_MOMENT',      description: `${n} finds the solution — something non-physical. A song that makes flowers grow into a bridge, a loud clap that makes an echo-path. Fewest words. Same spot.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'CROSSING',        description: `Crossing the impossible bridge. It holds. ${n} runs, laughing. The tree is close now. Almost there. Nearing the hill.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'REACHING_TREE',   description: `${n} touches the glowing tree. It's warm, it hums, and its light wraps around ${n} like a hug. The destination reached. At the tree.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'TREE_GIFT',       description: `The tree drops something — a glowing fruit, a golden leaf, a perfect seed. Something to carry home. Under the tree.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'BRIDGES_STILL',   description: `Looking back, all the bridges ${n} built are still there. The path home is clear because ${n} made it. Heading home.`, wordTarget: wt },
        { spread: 12, beat: 'HOME_ARRIVAL',    description: `Home again, the tree's gift in hand. ${n} knows now: anything can be reached if you build the way there. At home. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. The best bridges are built by the ones who cross them. Echo the first gap. Warm, earned, glowing.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'collector',
    name: 'The Collector',
    synopsis: 'A recipe card appears with mysterious ingredients — a laugh from a brook, the blue from a jay, the softness of moss. The child must collect each one to make something wonderful.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'RECIPE_FOUND',    description: `${n} finds a shimmering recipe card on the ground. It lists impossible ingredients: "One splash of brook-laughter. One pinch of sky-blue." Near home.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_INGREDIENT',description: `"Brook-laughter" — ${n} goes to the stream, listens, catches the sound in cupped hands. It tickles and glows. By the brook.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SECOND_INGREDIENT',description: `"Sky-blue" — ${n} finds a jay's feather on the path. When picked up, the blue shimmers like a living color. On the path.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'THIRD_INGREDIENT', description: `"Moss-softness" — ${n} presses a handful of moss. It releases a green, velvety glow. Each ingredient is stranger and more beautiful. Forest floor.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'FOURTH_INGREDIENT',description: `Something connected to ${n}'s interests. A smell, a sound, a texture — captured and added to the growing collection. Use child's favorites. New spot.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'HARD_ONE',         description: `The trickiest ingredient — "A forgotten song" or "The warmth of a sunbeam." How do you collect that? ${n} has to think creatively. Thinking spot.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'CLEVER_SOLUTION',  description: `${n} finds a way — hums the song into a shell, catches the sunbeam in a dewdrop. It works! Pride and cleverness. Same spot.`, wordTarget: wt },
        { spread: 8,  beat: 'LAST_INGREDIENT',  description: `The final item on the recipe: "One brave step forward." ${n} takes it. A glow fills the air. All ingredients gathered. Clearing.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'MIXING',           description: `${n} puts everything together. The ingredients swirl, shimmer, combine. The air smells like every good thing. The quietest, most magical beat. Fewest words.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'CREATION',         description: `What appears: something wonderful and unexpected — a glowing orb, a rainbow scarf, a singing flower. Made from the world's best pieces. Clearing.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'CARRYING_HOME',   description: `${n} carries the creation home. It glows gently. The path home feels shorter when you carry something you made. Heading home.`, wordTarget: wt },
        { spread: 12, beat: 'HOME_WITH_MAGIC', description: `The creation sits on the windowsill at home, still glowing. ${n} keeps the recipe card for next time. At home. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. The world is full of ingredients if you know how to listen. Echo the found recipe. Warm, gathered, whole.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'night_walk',
    name: 'The Night Walk',
    synopsis: 'Familiar places look completely different at night — the playground is a silver castle, the library is a giant asleep. The child discovers the night-world is wondrous, not scary.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'STEPPING_OUT',    description: `${n} steps outside into the evening. The streetlights are on, the air smells different. The familiar street has transformed. Front steps.`, wordTarget: wt },
        { spread: 2,  beat: 'SILVER_WORLD',    description: `Moonlight turns everything silver. The sidewalk gleams. Shadows make new shapes. The night world is the same place, but not. The street.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'PLAYGROUND',      description: `The playground at night — swings sway by themselves, the slide is a silver waterfall, the sandbox glows. Magical, not scary. The playground.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'NIGHT_SOUNDS',    description: `Sounds ${n} never noticed — crickets, a distant owl, the hum of streetlights. A whole orchestra that only plays after dark. Walking.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'NIGHT_CREATURES', description: `A bat dips overhead, a cat walks on a wall like royalty, fireflies blink. The night has its own residents. Walking through the neighborhood.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'FAMILIAR_TRANSFORMED', description: `Something very familiar — the school, a friend's house, the corner shop — looks completely different at night. ${n} sees it with fresh eyes. The neighborhood.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'QUIET_SPOT',      description: `${n} finds a quiet spot — a bench, a wall, a step — and sits. The night is gentle. Stars visible above. The stillest moment. Fewest words.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'STARS',           description: `Looking up. Stars everywhere — more than ${n} ever noticed. One seems to blink right at ${n}. The sky is the biggest view in the book. Same spot.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'NIGHT_BEAUTY',    description: `The most beautiful night image — moonlight on water, frost on a leaf, a spider web catching light. Pure wonder. Same area.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'TOWARD_HOME',     description: `${n} starts walking home. Each step is familiar and new. The shadows feel friendly now. Heading home.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'PORCH_LIGHT',     description: `The porch light of home glows warm and gold. The most welcoming sight. Almost there. Approaching home.`, wordTarget: wt },
        { spread: 12, beat: 'INSIDE_WARM',     description: `${n} steps inside. The warmth wraps around. But through the window, the night world is still out there, silver and alive. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. The night isn't dark — it's a different color of bright. Echo the first step outside. Warm, silver, brave.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'helper',
    name: 'The Helper',
    synopsis: 'A small, lost creature appears on the doorstep. It can\'t speak but clearly needs help getting home. The child becomes its guide through unfamiliar territory.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'CREATURE_ARRIVES', description: `Something small and round and soft sits on the doorstep, looking up at ${n} with big eyes. It trembles. It's lost. Front door.`, wordTarget: wt },
        { spread: 2,  beat: 'COMMUNICATION',    description: `The creature can't talk, but it points, nudges, chirps. ${n} crouches down and listens with hands and eyes. An understanding forms. Front door.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SETTING_OUT',      description: `${n} picks up the creature gently and starts walking in the direction it points. Adventure begins. Leaving home.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'OBSTACLE_1',       description: `A fence blocks the way. The creature is too small to climb. ${n} lifts it over and squeezes through. Teamwork. Near a fence.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'LEARNING',         description: `${n} learns the creature's likes — it purrs near water, hides from loud noises, dances in sunlight. Growing closer. Walking path.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'WRONG_TURN',       description: `The path forks and the creature hesitates. ${n} chooses one direction — wrong! They have to backtrack. Patience and determination. Fork in path.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'RIGHT_PATH',       description: `The creature suddenly perks up, bounces excitedly. This is the right way! It recognizes something. Close now! On the path.`, wordTarget: wt },
        { spread: 8,  beat: 'HOME_FOUND',       description: `They find it — a hollow log, a mossy nook, a stone circle — where more creatures just like this one are waiting. The creature's home! Creature home.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'REUNION',          description: `The creature runs to its family. They nuzzle, chirp, celebrate. ${n} watches the reunion. Joy and a small ache of goodbye. Creature home.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'FAREWELL',         description: `The creature looks back at ${n} one more time. Runs over, nuzzles ${n}'s hand. Then runs back home. The goodbye that means thank you. Creature home.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'WALKING_HOME',     description: `${n} walks home alone. But not lonely — the warmth of helping stays. The path home is familiar and good. Heading home.`, wordTarget: wt },
        { spread: 12, beat: 'HOME_AGAIN',       description: `Back home, ${n}'s hand still warm from the creature's nuzzle. Some things you can't keep, but you always have. At home. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',          description: `The last line. The best adventures are the ones where you're someone else's hero. Echo the doorstep. Warm, gentle, brave.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'message_bottle',
    name: 'The Message in a Bottle',
    synopsis: 'The child finds a bottle with a message that leads to another message, then another — a trail of notes from an unknown friend leading to a wonderful discovery.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'FINDING',         description: `${n} finds a small bottle with a rolled-up note inside. The note says: "Follow me to the next one." An arrow points toward the garden. Near home.`, wordTarget: wt },
        { spread: 2,  beat: 'SECOND_NOTE',     description: `Under the garden rock: another bottle, another note. This one has a riddle. ${n} solves it — the answer points to the big tree. Garden.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'THIRD_NOTE',      description: `In the tree hollow: a bottle with a drawing inside — a picture of a bridge. ${n} knows which bridge. The trail leads further. Near the tree.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'FOURTH_NOTE',     description: `At the bridge: a bottle tied to the railing. The note says something kind: "You're doing great. Keep going." Who wrote these? The bridge.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'FIFTH_NOTE',      description: `The trail leads to an unexpected place — use child's interests. Another bottle, another clue. Each note is friendlier, warmer. New location.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'PUZZLING',        description: `A note with a trickier clue. ${n} has to think hard. Sitting on the ground, turning the paper around, whispering the words. Thinking spot.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'AHA',             description: `The answer clicks. ${n} jumps up and runs. The trail is getting exciting now. Something big is waiting at the end. Running.`, wordTarget: wt },
        { spread: 8,  beat: 'LAST_NOTE',       description: `The final bottle. The note says: "Turn around." ${n} turns slowly. New location near original home.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'DISCOVERY',       description: `Behind ${n}: something wonderful. A treehouse, a fairy garden, a painted mural, a friendship bracelet hanging from a branch. The trail's destination. Same spot.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'WHO_DID_THIS',    description: `${n} looks at the handwriting on all the notes. The drawings. The care. Someone made this whole trail just for ${n}. The emotional peak. Same spot.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'KEEPING_NOTES',   description: `${n} carefully collects all the bottles and notes. They're treasures now — a story told in scraps of paper. Same spot.`, wordTarget: wt },
        { spread: 12, beat: 'HOME_WITH_BOTTLES',description: `At home, the bottles lined up on a shelf. Each one a stop on the trail, each one a memory. At home. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. The best messages find the people who need them. Echo the first bottle. Warm, curious, found.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'the_race',
    name: 'The Great Race',
    synopsis: 'A friendly race through a landscape that keeps changing — a meadow turns to mud, the path splits, a hill appears. The child\'s determination and creativity win the day.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'ON_YOUR_MARKS',   description: `A starting line in the grass. ${n} crouches, ready. A bird tweets "GO!" and ${n} takes off. The great race begins. Starting field.`, wordTarget: wt },
        { spread: 2,  beat: 'FAST_START',      description: `Running through a meadow of flowers. Legs pumping, arms swinging. Wind in face. The landscape blurs with speed. The meadow.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_CHANGE',    description: `The meadow turns to mud! Feet squelch, progress slows. ${n} has to adjust — high steps, careful balance. Adaptation. Muddy patch.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'PATH_SPLITS',     description: `The path forks — a short steep way and a long flat way. ${n} picks one. A choice that matters. Quick thinking. Fork in path.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'UPHILL',          description: `A hill rises up. Steep and tall. ${n} digs in, leans forward, pushes. Every step harder than the last. Determination. The hill.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'HILLTOP_VIEW',    description: `The hilltop! The view is incredible — the whole race course laid out. The finish line visible in the distance. A moment of awe. Hilltop.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'DOWNHILL_JOY',    description: `Running downhill — gravity pulling, feet barely touching ground. Arms out like wings. The fastest, freest moment. Maximum speed and joy. Downhill.`, wordTarget: wt },
        { spread: 8,  beat: 'WATER_CROSSING',  description: `A stream blocks the path. No bridge. ${n} finds stepping stones — hop, hop, balance, hop! Making it across. Stream crossing.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'FINAL_STRETCH',   description: `The finish line is close. Everything ${n} has — all the energy, all the heart — goes into this last push. Flat-out running. Final stretch.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'CROSSING_LINE',   description: `${n} crosses the finish line! Arms up, chest heaving, the biggest smile. It doesn't matter if first or last — finishing IS winning. Finish line.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'CATCHING_BREATH', description: `Lying on the grass, chest rising and falling, looking at the sky. The race is over. The body is tired and happy. Beyond the finish line.`, wordTarget: wt },
        { spread: 12, beat: 'MEDAL',           description: `A medal or ribbon — maybe self-made, maybe from the wind. ${n} holds it proudly. The race was the reward. NOT bedtime. Same spot.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. The best races are the ones where you run your own way. Echo the starting crouch. Warm, breathless, triumphant.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
];
