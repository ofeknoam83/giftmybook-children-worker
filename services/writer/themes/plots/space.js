/**
 * Space plot templates — 12 structurally distinct story arcs.
 *
 * Each template returns 13 spreads in 4-scene (A/B/C/D) grouping.
 * opts: { child, isYoung, wt, parentName, book, theme }
 */

module.exports = [
  {
    id: 'classic_space',
    name: 'Classic Space Journey',
    synopsis: 'The child gazes at the stars above the rooftop, crosses into the cosmos, explores alien wonders, and returns home carrying stardust.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'HOOK',            description: `${n} discovers something that calls them toward the stars above the rooftop. Vivid, sensory, immediate. At home or a familiar place.`, wordTarget: wt },
        { spread: 2,  beat: 'DISCOVERY',       description: `The cosmos opens up. Colors, sounds, textures of space. Wonder fills the scene. The threshold crossing.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'RISING_1',        description: `${n} ventures deeper into space. A companion or guide may appear. Use child's interests. Same cosmic world.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'RISING_2',        description: `A second discovery, stranger and more wonderful. The universe reveals its rules.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'DEEP_EXPLORE',    description: `The heart of the cosmic world. ${n} is fully immersed, confident, curious.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'CHALLENGE',       description: `Something goes wrong or gets tricky. A puzzle, a blockage, a moment of doubt.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'CLEVERNESS',      description: `${n} uses something they know to solve it. Resourcefulness.`, wordTarget: wt + 2 },
        { spread: 8,  beat: 'TRIUMPH',         description: `The problem is solved. Joy, relief, pride. The cosmos responds, celebrates.`, wordTarget: wt },
        { spread: 9,  beat: 'WONDER',          description: `A quiet beat of pure wonder. The most beautiful image in the book. Fewest words.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'GIFT',            description: `The cosmos gives ${n} something to carry home — stardust, a glowing stone, a new understanding.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'HOMECOMING',      description: `Returning home. The familiar world looks a little different now.`, wordTarget: wt },
        { spread: 12, beat: 'REFLECTION',      description: `Safe at home, but changed. The adventure lives inside.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. A whisper of the stars still calling. Echo the opening image.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'planet_hop',
    name: 'The Planet Hopper',
    synopsis: 'The child visits a chain of tiny planets — each one has a single marvelous feature: a music planet, a color planet, a bounce planet, a whisper planet.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'ROCKET_FOUND',    description: `${n} finds a small rocket in the backyard — just big enough for one. A button says "GO." ${n} presses it. Backyard.`, wordTarget: wt },
        { spread: 2,  beat: 'LAUNCH',          description: `WHOOOOSH! The rocket shoots up through clouds, past the moon, into a sky full of tiny planets. ${n} sees them floating everywhere. Space.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'MUSIC_PLANET',    description: `First stop: a planet where everything makes music. The rocks hum, the ground drums, the air sings. ${n} dances. Music planet.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'COLOR_PLANET',    description: `Next: a planet where everything is one color (use ${n}'s favorite). The sky, the ground, the creatures — all beautiful, all that color. Color planet.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'BOUNCE_PLANET',   description: `A planet made of trampolines! Every step launches ${n} into the air. Bouncing between mountains, over lakes. Maximum physical joy. Bounce planet.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'WHISPER_PLANET',  description: `A quiet planet where everything is soft. Whisper-wind, pillow-ground, cotton-candy trees. ${n} tiptoes. The stillest, gentlest place. Whisper planet.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'INTEREST_PLANET', description: `A planet built around ${n}'s interests — covered in their favorite things. The most personal, exciting world. Use child's favorites. Special planet.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'UPSIDE_PLANET',   description: `A planet where everything is upside down — trees grow downward, rain falls up, ${n} walks on the sky. Silly and surprising. Upside planet.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'TINY_PLANET',     description: `The smallest planet — so small ${n} can see the whole thing at once. But it has the biggest surprise: a tiny version of ${n}'s house. Tiny planet.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'HOMESICK',        description: `Seeing the tiny house makes ${n} miss home. The real home, with real smells and real hugs. Time to head back. In the rocket.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'RETURN_FLIGHT',   description: `The rocket zooms home. Planets shrink behind. The moon waves. Earth gets bigger and bluer. Returning.`, wordTarget: wt },
        { spread: 12, beat: 'LANDING',         description: `Soft landing in the backyard. The rocket shrinks to toy size. But ${n}'s pockets jingle with souvenirs from every planet. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. Every star is a planet waiting for a visitor. Echo the backyard rocket. Warm, cosmic, infinite.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'mission_control',
    name: 'Mission Control',
    synopsis: 'The child becomes commander of a space station, managing gentle crises — a star flickers out, a comet needs redirecting, the moon needs cheering up.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'STATION_ARRIVES', description: `${n} wakes to find a space station orbiting the bedroom — screens, buttons, a captain's chair. A voice: "Commander ${n}, reporting for duty." Bedroom.`, wordTarget: wt },
        { spread: 2,  beat: 'SUIT_UP',         description: `A tiny spacesuit appears. ${n} puts it on — helmet, boots, gloves. Steps into the station. The view: Earth below, stars everywhere. Station.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_ALERT',     description: `BEEP! First mission: a star in the distance is flickering. It's going dim. Commander ${n} must help it shine again. Station.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'STAR_RESCUE',     description: `Flying to the star, ${n} polishes it with a cloth, whispers encouragement. The star brightens, beams, and winks. Mission complete. Near the star.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'SECOND_ALERT',    description: `BEEP! A comet is headed the wrong way. ${n} must redirect it — nudging with gentle pushes, guiding it back on course. In space.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'COMET_RIDE',      description: `${n} rides the comet for a moment — zooming past planets, trailing sparkles. The most exhilarating ride. Then hops off back at the station. Space.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'MOON_MISSION',    description: `BEEP! The moon looks sad — no visitors in ages. ${n} flies down and sits with the moon. They talk. The quietest, most tender mission. Fewest words. On the moon.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'MOON_HAPPY',      description: `${n} makes the moon laugh — tells it about Earth, sings a song, does a moonwalk dance. The moon glows brighter. Joy returned. On the moon.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'CONSTELLATION',   description: `${n} arranges some stars into a new constellation — shaped like something personal (a pet, a favorite thing). Written in the sky forever. Space.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'ALL_CLEAR',       description: `Back at the station. All alerts handled. The universe is calm and beautiful. ${n} looks out the window at the peaceful cosmos. Station.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'SHIFT_ENDS',      description: `"Shift complete, Commander." The station begins floating back toward the bedroom. Stars salute as ${n} passes. Returning.`, wordTarget: wt },
        { spread: 12, beat: 'BACK_IN_ROOM',    description: `The station is gone. ${n} in pajamas again. But the spacesuit helmet sits on the shelf, and through the window — is that star extra bright? NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. The universe runs better when someone small is in charge. Echo the first BEEP. Warm, brave, starlit.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'moon_visit',
    name: 'The Moon Visit',
    synopsis: 'The child is invited to the moon for tea — climbing up on a moonbeam, exploring craters, bouncing in low gravity, and sharing cookies with the Man in the Moon.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'MOONBEAM_LADDER', description: `A moonbeam stretches from the sky to ${n}'s window. A note tied to it: "Come up for tea." ${n} steps onto the moonbeam. Window.`, wordTarget: wt },
        { spread: 2,  beat: 'CLIMBING_UP',     description: `Climbing the moonbeam — it's solid and warm. The house shrinks, the town shrinks, the clouds pass by. Up and up. Climbing.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'MOON_LANDING',    description: `Stepping onto the moon's surface. It's powdery and soft. Craters are like bowls. The Earth is a blue marble in the black sky. Moon surface.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'BOUNCING',        description: `Low gravity! ${n} bounces in huge, slow arcs. Every jump goes higher. Somersaults in slow motion. Maximum physical joy. Moon surface.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'CRATER_EXPLORE',  description: `Exploring a crater — smooth walls, glittering dust, a view of distant planets. ${n} slides down the side like a bowl-slide. A crater.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'MOON_HOST',       description: `The Moon itself appears — a friendly face in the rock, gentle and old. "Welcome! I've been watching you from up here." The Moon greets ${n}. Moon surface.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'TEA_TIME',        description: `Moon tea — served in crater cups, with star-sugar cookies. The Moon tells stories of what it's seen from up here. Warm and cozy. Fewest words. Moon surface.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'MOON_STORIES',    description: `The Moon shows ${n} something special — a view of ${n}'s house from above, or a funny story about a shooting star. Personal and magical. Moon surface.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'MOON_PLAY',       description: `The Moon invites ${n} to play — crater bowling, star collecting, moonbeam sliding. The most fun ${n} has ever had. Maximum joy. Moon surface.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'EARTH_RISES',     description: `The Earth rises over the moon's horizon — big, blue, beautiful. ${n} sees home from space. A moment of awe and longing. Moon surface.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'GOODBYE_MOON',    description: `The Moon wraps a moonbeam around ${n}'s shoulders like a scarf. "Visit anytime." ${n} steps back onto the beam. Moon surface.`, wordTarget: wt },
        { spread: 12, beat: 'SLIDING_HOME',    description: `Sliding down the moonbeam, landing softly on the bedroom floor. Moon dust on both shoes. The moonbeam retracts. NOT bedtime. Bedroom.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. The Moon always saves a seat for old friends. Echo the note on the moonbeam. Warm, silver, luminous.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'star_collector',
    name: 'The Star Collector',
    synopsis: 'Stars have fallen from the sky and scattered across the landscape. The child gathers them one by one, each star a different color and personality, to return them home.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'STARS_FALLEN',    description: `${n} looks up — the sky is dark, almost empty. Then notices tiny lights scattered on the ground — fallen stars, everywhere. Near home.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_STAR',      description: `${n} picks up a red star. It's warm and hums. It wants to go home but can't fly alone. ${n} cups it gently. Near home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SECOND_STAR',     description: `A blue star behind a rock, shy and cold. ${n} warms it in both hands. It brightens. Two stars now, blinking at each other. Path.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'COLLECTING',      description: `More stars: a gold one on a fence post, a green one in the grass, a tiny white one in a puddle. ${n}'s arms fill with light. The neighborhood.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'FUNNY_STAR',      description: `One star is a prankster — it keeps rolling away, hiding, giggling (a tiny chime). ${n} chases it, laughing. Physical comedy. The park.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'SHY_STAR',        description: `The hardest to find: a violet star hiding deep in a bush, afraid. ${n} kneels and speaks softly. Slowly, it rolls into ${n}'s palm. Same park.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'ALL_GATHERED',    description: `${n} holds all the stars. They glow together, a handful of colors humming in harmony. The quietest, most beautiful moment. Fewest words.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'FINDING_HOME',    description: `How to get them back up? ${n} tries throwing — too low. A tall hill? Almost. Then an idea: standing on the tallest slide. The playground.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'LAUNCHING',       description: `From the top of the slide, ${n} tosses each star upward. They catch the wind and rise — red, blue, gold, green — streaming back to the sky. Playground.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'SKY_FILLS',       description: `The sky fills with light again. Each star finds its place. The violet one is the last — it pauses, blinks a thank-you, then zooms up. Looking up.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'FULL_SKY',        description: `The sky is magnificent now — brighter than before. ${n} lies on the grass, looking up at the stars that were just in their hands. The field.`, wordTarget: wt },
        { spread: 12, beat: 'STARDUST_HANDS',  description: `${n}'s hands still glow faintly — stardust that won't wash off. A permanent souvenir. NOT bedtime. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. Sometimes the sky needs a small pair of hands. Echo the empty sky. Warm, starlit, necessary.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'rocket_builder',
    name: 'The Rocket Builder',
    synopsis: 'The child builds a rocket from household items — pots, cardboard, tape — and it actually works, launching into a brief, thrilling trip to the edge of space.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'THE_PLAN',        description: `${n} draws a rocket blueprint on paper. The design: a cardboard tube, tin foil wings, a pot for a nose cone. Serious engineering. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'GATHERING',       description: `Collecting supplies — boxes from the garage, tape from the drawer, a colander helmet. Everything is perfect. At home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'BUILDING',        description: `The rocket takes shape in the backyard. Tape, cut, stack. It's wobbly and wonderful. ${n} paints a name on the side. Backyard.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'COCKPIT',         description: `${n} climbs inside. Buttons drawn in marker, a steering wheel from a toy car. It smells like cardboard and dreams. Inside the rocket.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'COUNTDOWN',       description: `Ten, nine, eight... ${n} counts down aloud. On "one" — a rumble. The rocket shakes. Could it be? The backyard.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'LIFTOFF',         description: `IT FLIES! The cardboard rocket lifts off, smoke and sparkles, climbing fast. ${n} whoops. The ground falls away. Ascending.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'IN_SPACE',        description: `Stars outside the porthole (a circle of plastic wrap). Everything floats. ${n}'s crayon floats. Silence and wonder. Fewest words. Space.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'SPACE_VIEW',      description: `Earth below — swirled blue and green. The most beautiful thing ${n} has ever seen from the best seat in the universe. Space.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'SPACE_PLAY',      description: `Floating, somersaulting, catching a passing shooting star. ${n} draws a smiley face on the fogged-up porthole. Maximum space joy. Space.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'HEADING_HOME',    description: `The fuel gauge (a crayon drawing) shows empty. Time to head back. ${n} turns the toy steering wheel. The rocket dips toward Earth. Space.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'REENTRY',         description: `Diving through clouds. The backyard gets bigger. The rocket bounces once, twice, and lands in the grass. Thud. Backyard.`, wordTarget: wt },
        { spread: 12, beat: 'CLIMBING_OUT',    description: `${n} climbs out, grass-stained and grinning. The rocket is cardboard again. But the porthole still has the smiley face on it. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. The best rockets are built with tape and dreams. Echo the blueprint. Warm, cardboard-scented, infinite.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'alien_friend',
    name: 'The Alien Friend',
    synopsis: 'A small, friendly alien crash-lands in the garden. The child shows it everything about Earth — grass, water, music, ice cream — before helping it fly home.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'CRASH_LANDING',   description: `A small bump in the garden — a tiny ship, dented and steaming, nestled in the marigolds. A hatch opens. Two big eyes blink up at ${n}. Garden.`, wordTarget: wt },
        { spread: 2,  beat: 'MEETING',         description: `The alien is small, round, and friendly. It doesn't speak words but makes musical sounds. ${n} waves. The alien waves three arms. Garden.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SHOWING_GRASS',   description: `${n} shows the alien grass — pulls some, smells it, puts it on the alien's head. The alien is amazed. It has never seen green things growing. Garden.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'SHOWING_WATER',   description: `The hose: water! The alien touches it, jumps back, then leans into the spray. Its skin changes color when wet. It dances. Garden.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'SHOWING_FOOD',    description: `${n} shares a snack — use child's favorite food. The alien tastes it and its eyes go HUGE. It does a happy spin. At home or garden.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'SHOWING_MUSIC',   description: `${n} plays music (a xylophone, a radio, humming). The alien listens, then harmonizes with its own sound. A beautiful duet. At home.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'QUIET_TOGETHER',  description: `${n} and the alien sit side by side watching a cloud, or a sunset, or a bug. No words needed. Two friends from different worlds. Fewest words. Garden.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'FIXING_THE_SHIP', description: `The alien shows its ship — something is broken. ${n} helps fix it with tape, a twig, a bit of string. Teamwork across galaxies. Garden.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'SHIP_READY',      description: `The ship hums to life. The alien looks at the sky, then at ${n}. It's time. A gift exchange — ${n} gives something, the alien gives a glowing orb. Garden.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'GOODBYE',         description: `The alien hugs ${n} with all three arms. It makes a sound like a lullaby. Then climbs into the ship. The hatch closes. Garden.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'LAUNCH',          description: `The ship rises, wobbles, then zooms upward in a streak of light. ${n} watches until it's a speck, then a star. Garden.`, wordTarget: wt },
        { spread: 12, beat: 'GLOWING_ORB',     description: `${n} holds the alien's gift — it glows in rhythm, like a heartbeat. From very far away, one star pulses the same rhythm. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. Friends don't have to speak the same language or live on the same planet. Echo the crash landing. Warm, glowing, universal.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'sun_journey',
    name: 'The Sun Journey',
    synopsis: 'The child follows the sun across the sky from sunrise to sunset — racing it, playing with its light, learning that the sun always comes back.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'SUNRISE',         description: `Early morning. ${n} watches the sun peek over the horizon — orange, huge, brand new. It winks. ${n} waves. A challenge: can you keep up? East-facing spot.`, wordTarget: wt },
        { spread: 2,  beat: 'MORNING_LIGHT',   description: `The sun climbs higher. ${n} chases their own long shadow, trying to step on it. The shadow dodges, stretches, dances. Morning play. Garden.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SUNSHINE_PLAY',   description: `Playing with sunbeams — catching them in a jar (they won't stay), making rainbow prisms, finding where sunlight lands through leaves. Garden.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'HIGH_NOON',       description: `The sun at the very top. Shadows shrink to almost nothing. ${n} lies flat and is shadowless. The strangest moment. Flat on the ground.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'SUN_STORIES',     description: `${n} imagines what the sun sees from up there — oceans, mountains, cities, jungles. The sun watches everything. A cosmic perspective. Imaginative beat.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'CLOUD_GAME',      description: `A cloud covers the sun. Everything cools. ${n} waits. "Come back!" The cloud moves, and the warmth returns. A game of peek-a-boo with the sky. Open field.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'GOLDEN_HOUR',     description: `Late afternoon. Everything turns gold. The light is thick and warm like honey. The most beautiful time of day. Fewest words. Golden landscape.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'SUNSET_BEGINS',   description: `The sun starts to dip. Colors pour across the sky — orange, pink, purple, red. ${n} watches the greatest painting in the world. West-facing spot.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'CHASING_SUNSET',  description: `${n} runs toward the sunset, trying to keep the sun up. Running on a hill, arms reaching for the light. You can't catch it but you try. Hilltop.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'SUN_DIPS',        description: `The sun touches the horizon and pauses — one last look. It glows extra warm, as if saying goodbye. Then slips below. Hilltop.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'AFTERGLOW',       description: `The sky still glows even though the sun is gone. ${n} sits in the fading warmth. The first star appears. Not sad — the sun promised to return. Hilltop.`, wordTarget: wt },
        { spread: 12, beat: 'WALKING_HOME',    description: `${n} walks home in twilight, still warm from a day spent with the sun. Skin tingling, cheeks pink. NOT bedtime. Heading home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. The sun always comes back — that's its promise. Echo the sunrise wink. Warm, golden, faithful.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'constellation_maker',
    name: 'The Constellation Maker',
    synopsis: 'The child discovers a magical telescope that can rearrange stars — and creates new constellations: a cat, a cake, a bicycle, spelling out their own name in the sky.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'TELESCOPE_FOUND', description: `${n} finds an old telescope in the attic. But when ${n} looks through it, the stars get closer — and they can be moved with a finger on the lens. Attic.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_TRY',       description: `${n} nudges a star. It slides! Then another. Two stars become eyes, a curve becomes a smile. A face in the sky! Attic window.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'CAT_CONSTELLATION',description: `${n} arranges stars into a cat — pointy ears, a curled tail. It blinks! The sky-cat stretches and yawns. Creation magic. Attic window.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'BIGGER_SHAPES',   description: `Getting creative — a bicycle, a tree, a cupcake. Each constellation sparkles to life for a moment. ${n} is an artist of the sky. Attic window.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'NAME_IN_STARS',   description: `${n} carefully spells their own name in stars. The letters glow and pulse. The whole sky knows ${n}'s name now. Attic window.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'INTEREST_SHAPE',  description: `A constellation of something ${n} loves — use child's interests. The most personal creation glows brightest. Attic window.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'MASTERPIECE',     description: `${n} creates the most ambitious constellation yet — something beautiful and complex. It takes all the skill learned so far. Fewest words, most wonder.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'SKY_ALIVE',       description: `All the constellations come alive at once — the cat chases the bicycle, the cupcake floats, ${n}'s name pulses. The sky is a story. Attic window.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'SHARING',         description: `${n} points the telescope so others could see — imagining everyone looking up at the new sky. A gift for the whole world. Attic window.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'STARS_SETTLE',    description: `The stars slowly drift back to their original spots — but ${n}'s constellations remain, faintly visible. Permanent additions. Attic window.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'TELESCOPE_RESTS', description: `${n} carefully puts the telescope down. It looks ordinary again. But the sky outside has changed. Attic.`, wordTarget: wt },
        { spread: 12, beat: 'OUTSIDE_LOOK',    description: `${n} goes outside and looks up — there, faint but real: the cat, the name, the masterpiece. In the sky forever. NOT bedtime. Garden.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. The sky has room for every shape you dream. Echo the first star-nudge. Warm, starry, authored.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'space_garden',
    name: 'The Space Garden',
    synopsis: 'The child plants seeds in a pot — but they grow into space plants: flowers that bloom in nebula colors, vines that reach toward the stars, fruit that tastes like starlight.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'STRANGE_SEEDS',   description: `${n} finds a packet of seeds that shimmer like metal and weigh nothing. The label is in symbols. Curiosity wins: plant them. Garden.`, wordTarget: wt },
        { spread: 2,  beat: 'PLANTING',        description: `Seeds in soil, water on top. Normal gardening. But the water glows faintly as it soaks in. ${n} watches, waiting. Garden.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_SPROUT',    description: `A sprout appears — but it's silver, and it grows FAST. By the time ${n} blinks, it's knee-high and humming. Space garden begins. Garden.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'SPACE_FLOWERS',   description: `Flowers bloom in nebula colors — swirling purples, burning oranges, deep space blues. They rotate slowly like tiny galaxies. Garden.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'GROWING_TALL',    description: `The vines grow toward the sky, reaching and reaching. They don't stop at normal height. By afternoon, they're above the roof. Garden.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'SPACE_FRUIT',     description: `Fruit appears: round, translucent, glowing. ${n} picks one and bites — it tastes like cold stars and warm honey. Nothing on Earth tastes like this. Garden.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'CLIMBING',        description: `${n} climbs the tallest vine — up past the roof, past the clouds. The vine reaches into space itself. Stars twinkle nearby. On the vine.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'SPACE_CANOPY',    description: `At the top: a canopy of space flowers spreading across the sky like a second constellation. ${n} sits among them, weightless. Maximum beauty. Space canopy.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'MEETING',         description: `A space creature tends the garden from this end — a gentle, glowing gardener. It planted those seeds knowing ${n} would find them. Space canopy.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'SEED_EXCHANGE',   description: `${n} and the space gardener exchange seeds — Earth seeds for space seeds. Both will grow something new in their worlds. Space canopy.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'CLIMBING_DOWN',   description: `${n} climbs back down the vine. With each step, the vine starts to shrink behind, pulling back toward the stars. Garden.`, wordTarget: wt },
        { spread: 12, beat: 'GARDEN_STAYS',    description: `The vine is gone, but the flowers remain — small, glowing, spinning. The Earth seeds ${n} gave away are already sprouting somewhere among the stars. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. Plant something small and it might reach the stars. Echo the shimmering seeds. Warm, cosmic, growing.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'shooting_star_ride',
    name: 'The Shooting Star Ride',
    synopsis: 'A shooting star pauses just long enough for the child to hop on. A wild, blazing ride across the sky — past planets, through aurora, grazing the Milky Way.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'STAR_STOPS',      description: `A shooting star streaks across the sky — then stops, right above ${n}. It hovers and dips down. An invitation. It's warm and sparking. Garden.`, wordTarget: wt },
        { spread: 2,  beat: 'HOPPING_ON',      description: `${n} climbs onto the shooting star. It's smooth and warm, trailing light. Grip tight — and ZOOM. The ground disappears below. Launching.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SPEED',           description: `Incredible speed — houses, cities, oceans flash by below. Wind streams past. The shooting star leaves a golden trail. Maximum thrill. Over Earth.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'PAST_MOON',       description: `Zooming past the Moon — it waves (or seems to). Past satellites, past darkness. The shooting star hums. Past the Moon.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'THROUGH_AURORA',  description: `The star dives through the northern lights — curtains of green and purple wrap around ${n}. Bathed in color. Through the aurora.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'RING_RIDE',       description: `The star loops around Saturn's rings — riding the outer edge, ice crystals sparkling. ${n} reaches out and catches a ring-crystal. Saturn.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'MILKY_WAY',       description: `The Milky Way up close — not a smudge but a river of a billion suns. The shooting star surfs it like a wave. Fewest words, most awe. The galaxy.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'DEEPEST_SPACE',   description: `The edge of everything. Dark and deep and beautiful. ${n} looks out at infinity. The shooting star pauses here. Maximum wonder. Deep space.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'TURNING_HOME',    description: `The star turns. Heading back. ${n} holds tight as it accelerates — the whole return trip in a blaze of light. Returning.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'EARTH_APPEARS',   description: `Earth grows from a dot to a marble to a planet to home. The most beautiful planet in any galaxy. Approaching Earth.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'SOFT_LANDING',    description: `The shooting star slows, dips, and deposits ${n} gently on the grass. Then streaks away again, leaving one last spark. Garden.`, wordTarget: wt },
        { spread: 12, beat: 'SPARK_KEPT',      description: `${n} holds the spark — it dims slowly but stays warm. A piece of the ride that won't fade. NOT bedtime. Garden.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. Every shooting star is someone else's ride home. Echo the first streak. Warm, blazing, free.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
];
