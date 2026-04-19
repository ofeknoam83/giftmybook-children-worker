/**
 * Underwater plot templates — 12 structurally distinct story arcs.
 *
 * Each template returns 13 spreads in 4-scene (A/B/C/D) grouping.
 * opts: { child, isYoung, wt, parentName, book, theme }
 */

module.exports = [
  {
    id: 'classic_underwater',
    name: 'Classic Ocean Dive',
    synopsis: 'The child dives beneath the waves, discovers a luminous underwater world, solves a challenge with cleverness, and surfaces carrying a gift from the sea.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'HOOK',            description: `${n} discovers something that calls them toward the waves that lap the shore. Vivid, sensory, immediate. At the beach or shore.`, wordTarget: wt },
        { spread: 2,  beat: 'DISCOVERY',       description: `The underwater world opens up. Colors, light, movement. Wonder fills the scene. The dive beneath the surface.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'RISING_1',        description: `${n} swims deeper. A sea creature companion may appear. Use child's interests. Same underwater world.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'RISING_2',        description: `A second discovery, stranger and more wonderful. The ocean reveals its secrets.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'DEEP_EXPLORE',    description: `The heart of the underwater world. ${n} is fully immersed, confident, curious.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'CHALLENGE',       description: `Something goes wrong or gets tricky. A puzzle, a blockage, a moment of doubt.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'CLEVERNESS',      description: `${n} uses something they know to solve it. Resourcefulness underwater.`, wordTarget: wt + 2 },
        { spread: 8,  beat: 'TRIUMPH',         description: `The problem is solved. Joy, relief, pride. The ocean celebrates.`, wordTarget: wt },
        { spread: 9,  beat: 'WONDER',          description: `A quiet beat of pure wonder. The most beautiful underwater image. Fewest words.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'GIFT',            description: `The sea gives ${n} something to carry home — a pearl, a shell, a new understanding.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'HOMECOMING',      description: `Rising to the surface. The familiar world looks different now.`, wordTarget: wt },
        { spread: 12, beat: 'REFLECTION',      description: `On the shore, wet and changed. The ocean is still there, still calling.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. The sea remembers everyone who dives deep. Echo the opening.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'pearl_return',
    name: 'The Lost Pearl',
    synopsis: 'The child finds a glowing pearl on the beach that belongs to an underwater queen. The journey to return it reveals a dazzling coral kingdom.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'PEARL_FOUND',     description: `${n} finds a glowing pearl washed up on the sand. It pulses like a heartbeat, warm and alive. Someone lost this. Beach.`, wordTarget: wt },
        { spread: 2,  beat: 'CALL_OF_SEA',     description: `The pearl tugs toward the water. ${n} wades in, following. The waves part gently. A path opens beneath the surface. Shore.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'UNDERWATER_PATH',  description: `Walking on the ocean floor — a trail of glowing stones leads deeper. Fish swim alongside like escorts. ${n} can breathe here. Ocean floor.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'CORAL_GATES',     description: `Coral gates rise ahead — tall, colorful, grown into an archway. Beyond: a kingdom of coral buildings, sea-glass windows. Coral kingdom.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'KINGDOM_LIFE',    description: `The coral kingdom is alive — seahorse messengers, octopus painters, crab musicians. ${n} walks through the bustling underwater city. Coral kingdom.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'THE_THRONE',      description: `The queen's throne room — made of giant clamshells and draped in kelp silk. An empty spot in the crown where the pearl belongs. Throne room.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'RETURNING_PEARL', description: `${n} holds out the pearl. The queen's crown glows as it clicks back into place. A shimmer runs through the whole kingdom. Fewest words. Throne room.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'KINGDOM_CELEBRATES', description: `The kingdom erupts in celebration — bioluminescent fireworks, dancing jellyfish, singing whales in the distance. Maximum underwater joy. Coral kingdom.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'ROYAL_TOUR',      description: `The queen shows ${n} the secret parts of the kingdom — a garden of anemones, a library of sand-stories, a playground of bubbles. Coral kingdom.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'QUEENS_GIFT',     description: `The queen gives ${n} a smaller pearl — one that glows with all the colors of the coral kingdom. "The sea will always welcome you." Throne room.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'RISING',          description: `Swimming upward, the coral kingdom shrinking below. The escorts swim alongside, waving fins. Rising to the surface.`, wordTarget: wt },
        { spread: 12, beat: 'SHORE_AGAIN',     description: `Standing on the sand, dripping. The small pearl in hand, still glowing. The waves curl in a goodbye wave. NOT bedtime. Beach.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. Return what's lost and the sea will give you something better. Echo the first pearl. Warm, luminous, deep.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'whale_song',
    name: 'The Whale Song',
    synopsis: 'The child hears a whale singing and follows the music underwater — each verse of the song reveals a new ocean wonder, building to a chorus with the whale.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'HEARING_IT',      description: `At the shore, ${n} hears something deep — a low, beautiful hum from beneath the water. A song with no words. It pulls. Beach.`, wordTarget: wt },
        { spread: 2,  beat: 'DIVING_IN',       description: `${n} wades in, head under. The song is louder here — rich and full. It comes from somewhere deep. Following the sound. Shallows.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_VERSE',     description: `The first verse of the song shows a kelp forest — tall, swaying, golden. Fish weave between the fronds like dancers following the rhythm. Kelp forest.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'SECOND_VERSE',    description: `The song shifts and reveals a coral reef — bursting with color, life, movement. The music makes the anemones sway. Coral reef.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'THIRD_VERSE',     description: `Deeper — the song shows a sandy plain with rays gliding like kites, and ancient shells scattered like coins. The music vibrates in ${n}'s chest. Sandy depths.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'FOURTH_VERSE',    description: `The deepest verse — bioluminescent creatures. Jellyfish glow in time with the music. A squid pulses color. Pure magic. The deep.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'FINDING_WHALE',   description: `The singer! A great whale, eye as big as ${n}'s head, floating in the deep. It turns slowly to look at ${n}. Fewest words. The deep.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'TOGETHER',        description: `The whale sings one more verse — this time, it's about ${n}. Somehow the song knows ${n}'s name, ${n}'s heart. Maximum beauty and warmth. Near the whale.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'CHORUS',          description: `${n} hums along. The whale's song and ${n}'s humming merge into a chorus. All the ocean creatures join — a symphony. Near the whale.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'WHALE_GIFT',      description: `The whale breathes a bubble — inside it, a tiny perfect seashell. It floats to ${n}'s hands. The whale nods goodbye. Near the whale.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'RISING',          description: `Swimming up, the song fading but not gone — ${n} can still feel it. The ocean carries the last notes. Rising.`, wordTarget: wt },
        { spread: 12, beat: 'ON_SHORE',        description: `On the beach, shell in hand. The hum still echoing. When ${n} holds the shell to an ear — the whale's song plays. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. Every ocean carries a song for someone who listens. Echo the first hum. Warm, deep, musical.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'submarine',
    name: 'The Little Submarine',
    synopsis: 'The child discovers a tiny submarine in a tidepool. It grows big enough to ride — windows reveal an underwater world of shipwrecks, caves, and gentle giants.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'TIDEPOOL_FIND',   description: `In a tidepool: a toy submarine, yellow and shiny. ${n} picks it up — it vibrates and grows! Big enough to climb inside. Tidepool.`, wordTarget: wt },
        { spread: 2,  beat: 'BOARDING',        description: `${n} opens the hatch, climbs in. Buttons, a periscope, a steering wheel. The sub slides off the rocks into deeper water. Inside the sub.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SHALLOW_WATERS',  description: `Through the porthole: reef fish in every color, sea stars, a curious seahorse pressing its nose to the glass. Shallow ocean.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'GOING_DEEPER',    description: `${n} pushes the "down" lever. The sub descends. Light fades, mystery grows. The pressure gauge rises. Deeper water.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'SHIPWRECK',       description: `An old shipwreck! Covered in coral, fish swimming through portholes. ${n} parks the sub beside it and peers through the window. Near the wreck.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'CAVE_ENTRY',      description: `A dark cave entrance, large enough for the sub. Inside: glowing crystals on the walls, underground streams. The sub's headlights sweep. Sea cave.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'CAVE_WONDER',     description: `Deep in the cave: a grotto of bioluminescent algae painting the walls in living light. The most beautiful hidden place. Fewest words. Sea cave.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'GENTLE_GIANT',    description: `Emerging from the cave, a whale shark glides past — enormous and gentle. It looks at the sub, at ${n} through the glass. A long, calm look. Open ocean.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'RIDING_CURRENT',  description: `The sub catches a warm current — carried fast through schools of fish, past dancing jellyfish. ${n} whoops inside the cockpit. Open ocean.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'SURFACE_SIGNAL',  description: `A light on the dashboard blinks: "TIME TO SURFACE." ${n} turns the wheel. The sub rises slowly through layers of blue. Ascending.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'BREAKING_SURFACE', description: `The sub breaks the surface. Sunlight after all that blue. ${n} opens the hatch and breathes salt air. The beach is nearby. Surface.`, wordTarget: wt },
        { spread: 12, beat: 'BACK_IN_TIDEPOOL', description: `The sub shrinks back to toy size. ${n} places it in the tidepool where it started. It bobs there, waiting for next time. NOT bedtime. Beach.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. Every tidepool holds a doorway to the deep. Echo the shiny toy. Warm, salty, adventurous.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'mermaid_school',
    name: 'The Mermaid School',
    synopsis: 'The child discovers a school for young mermaids — and is invited to attend for a day. Bubble-writing, current-racing, and coral-art class.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'INVITATION',      description: `A sealed shell arrives on the shore. Inside: a letter made of seaweed ink. "You are invited to Mermaid School today." ${n} dives in. Beach.`, wordTarget: wt },
        { spread: 2,  beat: 'ARRIVAL',         description: `Underwater, a school carved into coral. Young mermaids swim in through windows. A banner of kelp reads "WELCOME." ${n} joins them. Mermaid school.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_CLASS',     description: `Bubble Writing — tracing letters in bubbles that float and pop. ${n}'s name spelled in shimmering air. The teacher is a wise octopus. Classroom.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'SECOND_CLASS',    description: `Current Racing — swimming through hoops made of kelp, riding the fast current, dodging playful dolphins. ${n} finishes with a splash! Race course.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'LUNCH',           description: `Lunch in the cafeteria — seaweed rolls, pearl juice, sand cookies. ${n} sits with the mermaids. Sharing food and laughter. Cafeteria.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'THIRD_CLASS',     description: `Coral Art — painting with sea-sponges, sculpting sand, making jewelry from shells. ${n} creates something beautiful. Use child's interests. Art room.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'RECESS',          description: `Recess in the sea garden. Playing hide-and-seek among anemones, tag with fish, swinging on kelp vines. Joyful and free. Fewest words. Sea garden.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'FOURTH_CLASS',    description: `Music class — singing with whales, drumming on shells, dancing with jellyfish. The most enchanting lesson. Maximum underwater joy. Music room.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'SHOW_AND_TELL',   description: `${n} shares something about life on land — what trees are, what rain feels like. The mermaids are fascinated. ${n} is the teacher now. Classroom.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'GRADUATION',      description: `A tiny ceremony. The octopus teacher gives ${n} a shell-diploma and a coral star pin. "Honorary Mermaid." The class cheers. Classroom.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'GOODBYE',         description: `The mermaids wave goodbye — tails flashing, bubbles streaming. ${n} swims upward, diploma held tight. Rising.`, wordTarget: wt },
        { spread: 12, beat: 'ON_SHORE',        description: `On the beach. The diploma is still there, slightly damp. The coral star pin glitters. NOT bedtime. Beach.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. The ocean has its own schools, and you're always welcome. Echo the shell invitation. Warm, playful, oceanic.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'tide_pool_world',
    name: 'The Tide Pool World',
    synopsis: 'The child peers into a tide pool and gets pulled in — shrinking to discover a miniature ocean kingdom among the rocks, with crab knights and snail sages.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'PEERING_IN',      description: `${n} kneels by a tide pool, looking at the tiny world inside. A hermit crab waves a claw — come closer. ${n} leans in too far and SPLASH. Beach rocks.`, wordTarget: wt },
        { spread: 2,  beat: 'SHRUNK',          description: `${n} is tiny now, standing on a rock inside the tide pool. The water is a lagoon, the seaweed is a forest, a starfish is the size of a table. Tide pool.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'CRAB_KNIGHT',     description: `The hermit crab approaches — it wears its shell like armor and carries a tiny stick-sword. "Welcome to Poolington," it says with a bow. Tide pool.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'TOUR',            description: `The crab knight gives a tour — the anemone apartments, the mussel market, the barnacle bell tower. A whole city in a pool. Tide pool kingdom.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'SNAIL_SAGE',      description: `The oldest snail tells stories — of tides past, of storms survived, of the Great Wave. It speaks slowly and wisely. The snail's perch.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'TROUBLE',         description: `A rock shifted and blocked the water flow. The pool is getting warm and stale. The creatures worry — without fresh water, things get dangerous. Tide pool.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'HELPING',         description: `${n} is small but has big ideas. Together with the crabs, they push pebbles to unblock the channel. Teamwork at tiny scale. Fewest words. Same spot.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'WATER_FLOWS',     description: `RUSH — fresh, cool water pours in. The pool comes alive again. Creatures dance, anemones bloom wider. ${n} saved the kingdom. Maximum joy. Tide pool.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'FEAST',           description: `A celebration feast — algae cakes, plankton punch, a shell-horn band. ${n} dances with the crabs. The whole pool parties. Tide pool.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'GIFT',            description: `The snail sage gives ${n} a tiny pearl — "For the giant who saved the small." The crab salutes. Tide pool.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'GROWING_BACK',    description: `A tingle — ${n} starts growing. The pool shrinks around. Waving goodbye to tiny faces looking up. Growing.`, wordTarget: wt },
        { spread: 12, beat: 'FULL_SIZE',       description: `Full size again, kneeling by the pool. The pearl is in ${n}'s palm, real and tiny and glowing. The crab waves from below. NOT bedtime. Beach.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. Every tide pool is a kingdom if you look small enough. Echo the first lean. Warm, tiny, vast.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'ocean_garden',
    name: 'The Ocean Garden',
    synopsis: 'The child discovers a garden growing on the ocean floor — tended by sea creatures. Together they plant new coral, wake up sleeping clams, and grow an underwater forest.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'GARDEN_GATE',     description: `A gate made of driftwood stands at the water's edge. Through it: a path of stepping stones that descends into the sea. ${n} follows. Shore.`, wordTarget: wt },
        { spread: 2,  beat: 'UNDERWATER_GARDEN', description: `An underwater garden — coral beds, kelp rows, sea-flower patches. A sea turtle tends it with gentle flippers. ${n} arrives. Ocean garden.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'PLANTING_CORAL',  description: `The turtle teaches ${n} to plant baby coral — pressing tiny pieces into sandy beds, singing to them. They grow slowly, glowing. Ocean garden.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'WAKING_CLAMS',    description: `Sleeping giant clams need waking — ${n} tickles them gently and they open, revealing pearls and letting in light. One yawns. Ocean garden.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'KELP_FOREST',     description: `Planting kelp seeds that shoot up fast — a forest grows around ${n}. Fish move in immediately, making it home. Creation in real time. Kelp forest.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'DIFFICULT_PATCH',  description: `A barren patch where nothing grows. ${n} tries everything — singing, watering with bubbles, planting seeds. Finally, patience wins. Barren patch.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'FIRST_BLOOM',     description: `A single flower pushes through the barren sand. Then another. The patch begins to bloom. Life from nothing. Fewest words, most wonder. Same patch.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'FULL_GARDEN',     description: `The entire garden in bloom — coral castles, kelp canopies, sea flowers in every color. ${n} and the turtle survey their work. Maximum beauty. Ocean garden.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'VISITORS',        description: `Creatures come to enjoy the garden — rays glide through, seahorses settle in, octopuses play. The garden is alive with visitors. Ocean garden.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'TURTLE_THANKS',   description: `The turtle nuzzles ${n}'s hand. No words needed — ${n} helped make the ocean a little more beautiful. The warmest, quietest moment. Ocean garden.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'RISING',          description: `Swimming up through the kelp forest ${n} helped plant. Fish dart between fronds. The garden will keep growing. Rising.`, wordTarget: wt },
        { spread: 12, beat: 'ON_SHORE',        description: `On the shore, sand between toes. A tiny piece of coral washed up at ${n}'s feet — a gift from the garden below. NOT bedtime. Beach.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. Plant something anywhere and life will come. Echo the driftwood gate. Warm, growing, deep.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'seahorse_race',
    name: 'The Seahorse Race',
    synopsis: 'The child rides a seahorse in the Great Underwater Race — through coral arches, kelp tunnels, and bubble rings, discovering that the race is about the journey.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'SEAHORSE_MEETS',  description: `A seahorse bobs up to ${n} at the water's edge. It nudges, turns, waits. It wants ${n} to ride. ${n} climbs on (magically shrunk). Shore.`, wordTarget: wt },
        { spread: 2,  beat: 'RACE_START',      description: `Underwater, a starting line of shells. Other tiny riders on seahorses, fish, even a lobster. A trumpet-fish blows: GO! Race starts.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'CORAL_ARCHES',    description: `Through coral arches — dipping, weaving, ducking under. The seahorse is nimble and quick. Colors blur. Coral course.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'KELP_TUNNEL',     description: `Into a kelp tunnel — dark, then flashes of light. Twisting through the forest. The seahorse knows every shortcut. Kelp tunnel.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'BUBBLE_RINGS',    description: `Jumping through bubble rings! Each one pops with a musical note. Hit them all for bonus points. ${n} cheers the seahorse on. Bubble course.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'FALLING_BEHIND',  description: `A tricky current pushes them sideways. Others zoom ahead. The seahorse is tired. ${n} pats its neck and whispers encouragement. Open water.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'SCENIC_ROUTE',    description: `The seahorse takes a detour past the most beautiful spot — a hidden cove where sunlight makes rainbows in the water. They stop to look. Fewest words. Hidden cove.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'SECOND_WIND',     description: `Refreshed, the seahorse bursts forward. Tail curling and uncurling. ${n} holds on, grinning. They pass one rider, then another. Race course.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'FINISH_LINE',     description: `The finish line! Did they win? It doesn't matter — ${n} and the seahorse cross together, breathless and beaming. Every racer cheers. Finish.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'TROPHY',          description: `Everyone gets a trophy — a spiral shell with their name etched by a calligrapher crab. The seahorse wears its shell with pride. Celebration spot.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'GOODBYE_RIDE',    description: `The seahorse carries ${n} back to the surface — a gentle, slow ride. ${n} pats its curled tail. Rising.`, wordTarget: wt },
        { spread: 12, beat: 'ON_SHORE',        description: `Full size on the beach. The spiral shell trophy is real and fits in a pocket. The seahorse blows a goodbye bubble. NOT bedtime. Beach.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. The best races have the best views. Echo the first nudge. Warm, swift, salty.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'message_bottle_sea',
    name: 'The Sea Letter',
    synopsis: 'The child drops a message in a bottle into the ocean and follows it underwater — watching fish read it, a crab carry it, an octopus reply to it.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'WRITING',         description: `${n} writes a note — "Hello from the shore! Who lives in the sea?" — rolls it up, puts it in a bottle, and drops it in the waves. Beach.`, wordTarget: wt },
        { spread: 2,  beat: 'FOLLOWING',       description: `Curiosity takes over. ${n} dives in to follow the bottle. Underwater, it bobs and drifts, caught in a gentle current. Shallow ocean.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FISH_READ',       description: `A school of fish surrounds the bottle. They peer at the note through the glass, tilt their heads. A pufferfish presses its face to it. Shallow ocean.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'CRAB_CARRIES',    description: `A determined crab grabs the bottle and scuttles along the ocean floor with it — over rocks, around coral. ${n} follows. Ocean floor.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'OCTOPUS_READS',   description: `The crab delivers it to an octopus. The octopus opens the bottle with one tentacle, reads the note with big eyes, and gets excited. Ocean floor.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'OCTOPUS_REPLIES', description: `The octopus writes back — using squid ink on a flat shell. It rolls up the reply and puts it in the bottle. Hands it to a passing fish. Ocean floor.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'CHAIN_OF_REPLIES', description: `The bottle passes from creature to creature — each one adds a note, a drawing, a treasure. It's getting full! Fewest words, growing wonder. Ocean.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'WHALE_REPLY',     description: `A whale nudges the bottle gently. Its reply is the biggest — a song that vibrates through the water. ${n} feels it in the bones. Deep ocean.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'BOTTLE_RETURNS',  description: `The bottle starts drifting back toward shore, heavy with replies. ${n} swims alongside it, excited to read everything. Toward shore.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'READING_REPLIES', description: `On the shore, ${n} opens the bottle and empties it. Shell-letters, ink drawings, a tiny pearl, a sand dollar — the ocean wrote back. Beach.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'FAVORITE_REPLY',  description: `${n}'s favorite: a simple note in wobbly ink — "We say hello too." From the octopus. Tender and real. Beach.`, wordTarget: wt },
        { spread: 12, beat: 'NEW_LETTER',      description: `${n} writes another note — "Thank you. I'll visit again soon." Rolls it up, puts it in the bottle, and drops it back in the sea. NOT bedtime. Beach.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. The sea always writes back if you write first. Echo the first note. Warm, inky, connected.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'ocean_train',
    name: 'The Ocean Express',
    synopsis: 'A glass-bottomed train runs along the ocean floor — the child boards it and rides past underwater wonders: glowing caves, dancing dolphins, sleeping volcanoes.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'STATION',         description: `At the bottom of a tide pool staircase: a tiny train station. A sign reads "OCEAN EXPRESS." A glass-bottomed train pulls in. ${n} boards. Underwater station.`, wordTarget: wt },
        { spread: 2,  beat: 'DEPARTING',       description: `The train glides along underwater tracks. Through the glass floor: sand, seashells, scurrying crabs. ${n} presses face to the glass. On the train.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'REEF_STOP',       description: `First stop: the Coral Reef. Passengers (a turtle, a seahorse) get on. Through the windows: exploding color, darting fish. Reef station.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'GLOW_CAVE',       description: `The train enters a dark tunnel — then bioluminescent light! Glowing cave walls, jellyfish chandeliers. The most magical stretch. Cave tunnel.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'DOLPHIN_ESCORT',  description: `Outside the window: dolphins racing the train. They do flips, ride the pressure wave, knock on the glass with their noses. Maximum fun. Open ocean.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'KELP_FOREST_PASS', description: `Through a kelp forest — the light turns green and golden. The train slows as kelp fronds brush the windows. Peaceful and swaying. Kelp forest.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'DEEP_VIEW',       description: `The deepest stretch — darkness below, strange creatures with lights. A giant squid peers in the window and waves a tentacle. Fewest words. The deep.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'VOLCANO_VIEW',    description: `A sleeping underwater volcano, ringed with warm vents. Fish cluster near the warmth. The train rolls along the rim. Volcanic ridge.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'WHALE_CROSSING',  description: `The train stops for a whale crossing. A pod passes overhead, blocking the light. Shadow then sunlight, shadow then sunlight. Awe. Open ocean.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'LAST_STOP',       description: `Final station: a beautiful sandy bay. The conductor (a wise old crab) announces "End of the line." ${n} waves to fellow passengers. Bay station.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'SURFACING',       description: `A bubble elevator carries ${n} to the surface. Popping out of the water in a burst of sparkle. The ocean shines below. Surface.`, wordTarget: wt },
        { spread: 12, beat: 'TICKET_STUB',     description: `${n} on the beach, holding a golden ticket stub. It reads: "Good for one more ride, any ocean, any time." NOT bedtime. Beach.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. The ocean has its own rails and they run everywhere. Echo the tide pool staircase. Warm, gliding, deep.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'bubble_world',
    name: 'The Bubble World',
    synopsis: 'The child blows a bubble at the shore that doesn\'t pop — instead it grows and carries the child underwater in a dry, floating sphere, visiting bubble cities and bubble creatures.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'MAGIC_BUBBLE',    description: `${n} blows a soap bubble at the shore. It grows and grows — big enough to sit in! It floats toward the water. Beach.`, wordTarget: wt },
        { spread: 2,  beat: 'ENTERING',        description: `${n} steps inside the bubble. It's warm and dry, with a rainbow sheen. The bubble dips beneath the waves. ${n} can see everything. Inside the bubble.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FLOATING_DOWN',   description: `Floating gently downward through turquoise water. Fish bump against the bubble curiously. Seahorses use it as a mirror. Underwater.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'BUBBLE_CITY',     description: `A whole city made of bubbles! Houses, bridges, towers — all shimmering and transparent. Tiny fish live inside them. Bubble city.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'BUBBLE_CREATURES', description: `The residents: creatures made of bubbles themselves — bubble fish, bubble horses, a bubble cat. They come to greet ${n}. Bubble city.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'BUBBLE_PLAY',     description: `Playing with bubble creatures — bouncing on bubble trampolines, sliding down bubble slides, blowing bubble-within-bubbles. Maximum fun. Bubble city.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'QUIET_FLOAT',     description: `${n}'s bubble floats to the highest point of the city — a view of everything below, shimmering and impossibly beautiful. Fewest words. High in bubble city.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'BUBBLE_FEAST',    description: `A feast of bubble food — each dish pops in the mouth with a burst of flavor. The taste of the sea but sweeter. Bubble city.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'MAKING_BUBBLES',  description: `${n} learns to blow special bubbles underwater — ones that carry messages, ones that glow, ones that play music. ${n} is a bubble artist. Bubble city.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'BUBBLE_GIFT',     description: `The bubble creatures give ${n} a special bubble — one that will never pop. It glows and hums. A permanent souvenir. Bubble city.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'RISING',          description: `${n}'s bubble floats upward. The bubble city waves — hundreds of tiny bubbles blowing kisses. Rising to the surface. Ascending.`, wordTarget: wt },
        { spread: 12, beat: 'POP',             description: `The big bubble pops softly at the surface. ${n} lands in shallow water. But the never-pop bubble is still there, glowing in one hand. NOT bedtime. Shore.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. Some bubbles aren't meant to pop — they're meant to remind you. Echo the first blown bubble. Warm, round, iridescent.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
];
