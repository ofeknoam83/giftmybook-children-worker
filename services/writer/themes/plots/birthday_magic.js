/**
 * Birthday Magic plot templates — 12 structurally distinct story arcs.
 * These lean into the magical/fantastical side of birthdays.
 *
 * Each template returns 13 spreads in 4-scene (A/B/C/D) grouping.
 * opts: { child, isYoung, wt, parentName, book, theme }
 */

module.exports = [
  {
    id: 'classic_magic',
    name: 'Classic Birthday Magic',
    synopsis: 'Birthday morning brings a shimmer of magic — candles glow on their own, frosting sparkles, the wish is real. The whole day pulses with birthday enchantment.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'MORNING',       description: `${n} wakes on a special day. Morning light, birthday excitement, a sensory detail. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'ANTICIPATION',  description: `Something is coming — preparations happening around ${n}. Build excitement through concrete images. Still at home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'PREPARATION',   description: `Getting ready: decorations, outfit, maybe baking. Use favorite_cake_flavor if available. Still at home, same scene as spreads 1-2.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'PARTY_BEGINS',  description: `The celebration starts. ${n} greets arrivals with energy. Noise, color, action. Show where the party is.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'ACTIVITIES',    description: `Party games, play, laughter. Use favorite_toys or interests if available. Same party location.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'CONNECTION',    description: `A quiet moment amid the fun. ${n} notices something, feels something deeper. Still at the party.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'CAKE_CANDLES',  description: `The cake arrives. Candles lit. Faces glow in warm light. Build to the wish. Same party location.`, wordTarget: wt },
        { spread: 8,  beat: 'WISH_MOMENT',   description: `Eyes closed, a wish forming. The quietest, most magical spread. Fewest words.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 9,  beat: 'BLOW',          description: `The breath, the candles out, cheering erupts. Joy and release. Still at the party.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'WARMTH',        description: `${n} is surrounded by love. The feeling of being celebrated just for being you. The emotional high point.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'WINDING_DOWN',  description: `The party ends, transition home. Quiet settles. Echoes of laughter, crumbs on the table.`, wordTarget: wt },
        { spread: 12, beat: 'GLOW',          description: `${n} at home, still buzzing from the day. A favorite gift examined, a balloon still floating, frosting on a finger. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',       description: `The last line. A wish fulfilled, or a secret smile. Echo the morning. Warm, bright, joyful. NOT a goodnight.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'wish_comes_true',
    name: 'The Wish That Came True',
    synopsis: 'The child blows out the candles and whispers a wish — then the room shimmers and the wish begins to happen, right there in the living room.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'CANDLE_GLOW',      description: `Birthday cake on the table, candles flickering. ${n} leans in close. The room goes quiet. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'THE_WISH',         description: `Eyes shut tight. ${n} whispers a wish — something wonderful connected to their interests. The candles flare bright. At home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_SHIMMER',    description: `The room sparkles. Something changes — the wallpaper moves, the carpet softens, the ceiling stretches upward. Magic begins. At home, transforming.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'TRANSFORMATION',   description: `The wish is happening! The room has become the wished-for place — a jungle, a castle, a candy land, an ocean. ${n} steps into it. Wish world.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'EXPLORING',        description: `${n} explores the wish world. Everything is exactly as imagined, but better. Touching, tasting, listening. Use child's interests. Wish world.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'WISH_FRIEND',      description: `Someone (or something) greets ${n} in the wish world — a magical creature, a talking animal, a friendly character. They become a guide. Wish world.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'DEEPEST_WISH',     description: `The heart of the wish — the thing ${n} wanted most. Seeing it, touching it, being in it. The quietest, most magical moment. Fewest words.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'WISH_PLAY',        description: `Playing in the wish world — flying, swimming, building, racing. The most active, joyful spread. Maximum energy. Wish world.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'GIFT_FROM_WISH',   description: `The wish world gives ${n} something to keep — a sparkly stone, a feather, a tiny creature. A token of the magic. Wish world.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'FADING',           description: `The edges of the wish world begin to shimmer and dissolve. The room starts to reappear. Gentle transition, not sad. Between worlds.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'HOME_AGAIN',       description: `Back in the living room. The candles are out, the cake is waiting. But in ${n}'s hand — the token from the wish world. It's real. At home.`, wordTarget: wt },
        { spread: 12, beat: 'SECRET_SMILE',     description: `${n} eats cake with a secret smile. Nobody else saw what happened. But the magic is right there in ${n}'s pocket. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',          description: `The last line. Some wishes stay wishes; some become real for exactly one birthday. Echo the candle glow. Warm, sparkling, wonder.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'magic_candles',
    name: 'The Magic Candles',
    synopsis: 'Each birthday candle holds a tiny world inside its flame — one shows the ocean, another a forest, another the stars. The child peers into each before making a wish.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'CAKE_ARRIVES',     description: `The birthday cake appears with candles lit. But these candles flicker in unusual colors — blue, green, gold. ${n} leans close. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_FLAME',      description: `${n} looks into the first candle flame. Inside: a tiny ocean with waves and a whale. A gasp of wonder. At the cake.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SECOND_FLAME',     description: `The second candle holds a forest — tiny trees, a deer, falling leaves. Each flame is a world. ${n} moves from candle to candle. At the cake.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'THIRD_FLAME',      description: `A candle with stars inside — spinning galaxies, a comet trail, a planet with rings. The worlds get bigger. At the cake.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'FOURTH_FLAME',     description: `A candle that shows something connected to ${n}'s interests — the flame holds their favorite place, animal, or thing. Personal magic. At the cake.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'FIFTH_FLAME',      description: `A candle that shows a memory — a real moment from ${n}'s life, playing inside the flame like a tiny movie. Tender and specific. At the cake.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'QUIET_FLAME',      description: `The smallest candle holds the simplest world — just warmth, just light, just love. The most beautiful and quietest. Fewest words. At the cake.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'ALL_TOGETHER',     description: `${n} steps back and sees all the candle worlds glowing together — a constellation of tiny miracles on a cake. Maximum wonder. At the cake.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'THE_WISH',         description: `Time to choose a wish. With all these worlds to pick from, what does ${n} wish for? Eyes close. The room holds its breath. At the cake.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'THE_BLOW',         description: `One big breath. The flames dance, flicker, and go out. But the tiny worlds scatter like sparks into the room. Joy erupts. At home.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'SPARKS_SETTLE',    description: `The sparks from the candle worlds settle gently around the room — on shoulders, in hair, on the cake. Fading magic. At home.`, wordTarget: wt },
        { spread: 12, beat: 'CAKE_TIME',        description: `Everyone eats cake. ${n} finds one last tiny spark on a fingertip and watches it glow, then wink out. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',          description: `The last line. Every candle holds a world; every birthday holds them all. Echo the first colored flames. Warm, glowing, enchanted.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'birthday_door',
    name: 'The Birthday Door',
    synopsis: 'A glowing door appears in the bedroom on the child\'s birthday morning. Behind it: a party room that changes with every wish — ice cream walls, bouncy floors, raining confetti.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'DOOR_APPEARS',     description: `${n} wakes on birthday morning. A door that wasn't there before glows in the bedroom wall. Golden light seeps underneath. Bedroom.`, wordTarget: wt },
        { spread: 2,  beat: 'OPENING',          description: `${n} turns the handle and steps through. A vast, empty, sparkling room. A voice echoes: "Make a wish." The magic room.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_WISH',       description: `${n} wishes for something fun — the floor turns bouncy! Jumping, bouncing, flying through the air. The room obeys. Magic room.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'SECOND_WISH',      description: `Another wish: the walls turn to something delicious — chocolate, ice cream, candy. ${n} tastes and laughs. The room transforms. Magic room.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'THIRD_WISH',       description: `A bigger wish — use ${n}'s interests. The room becomes a themed wonderland. Everything ${n} loves, everywhere. Magic room.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'PLAYING',          description: `${n} plays in the wished-for world — slides, games, discoveries. Each corner has something new. Maximum joy and energy. Magic room.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'QUIET_WISH',       description: `A softer wish. The room goes calm — soft lights, gentle music, floating bubbles or stars. The most peaceful moment. Fewest words. Magic room.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'SURPRISE_WISH',    description: `The room adds something ${n} didn't wish for — something even better than expected. A surprise from the magic itself. Magic room.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'CONFETTI_RAIN',    description: `Confetti rains from the ceiling. Music plays. The room throws ${n} a proper birthday party. One person, infinite magic. Magic room.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'CAKE_APPEARS',     description: `A birthday cake materializes — perfect, glowing, with candles already lit. The room's final gift. ${n} makes the biggest wish. Magic room.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'DOOR_GLOWS',       description: `The golden door glows again — time to go back. ${n} takes one last look at the magic room. It shimmers a goodbye. Magic room.`, wordTarget: wt },
        { spread: 12, beat: 'BACK_IN_BEDROOM',  description: `${n} steps through and the door fades away. But there's confetti in ${n}'s hair and frosting on one finger. It was real. Bedroom, NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',          description: `The last line. The door will be back — it always comes on birthdays. Echo the morning glow. Warm, sparkling, full of promise.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'growing_spell',
    name: 'The Growing Spell',
    synopsis: 'On birthday morning, everything the child touches grows — flowers bloom, toys come alive, a tiny seed becomes a tree. The birthday magic is in their hands.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'TINGLY_HANDS',     description: `${n} wakes on birthday morning with tingly hands. They glow faintly. Something is different about today. Bedroom.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_TOUCH',      description: `${n} touches a wilted flower on the windowsill — it blooms instantly, bright and tall. A gasp. The magic is real. Bedroom.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SECOND_TOUCH',     description: `Running through the house, touching things — a plant shoots up, a drawing on the fridge comes to life, a stuffed animal wiggles. At home.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'OUTSIDE',          description: `${n} runs outside. Touches the grass — it grows tall and soft. Touches a bush — it explodes with berries. The yard transforms. Garden.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'BIG_TOUCH',        description: `${n} touches a tiny seed — a tree shoots up in seconds, full of leaves and birds. The biggest transformation yet. Garden.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'CREATIVE_TOUCH',   description: `Getting creative — touching a puddle (a pond appears), touching a pebble (a boulder with crystals inside). ${n} experiments. Garden.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'GENTLE_TOUCH',     description: `${n} gently touches a caterpillar — it becomes a butterfly and lands on ${n}'s shoulder. The quietest, most magical moment. Garden.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'WONDER_GARDEN',    description: `The yard has become a wonder garden — giant flowers, fruit trees, butterflies everywhere. ${n} created this. Maximum visual magic. Garden.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'SHARING',          description: `${n} touches something for someone else — grows a sunflower for the neighbor, makes a bird's nest bigger. Birthday generosity. Garden.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'FADING',           description: `The glow in ${n}'s hands starts to dim. The birthday magic is fading. But everything that grew stays. Bittersweet and warm. Garden.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'LAST_TOUCH',       description: `One last touch — ${n} chooses carefully. The most meaningful thing to grow. Use child's interests or a personal detail. Garden.`, wordTarget: wt },
        { spread: 12, beat: 'HANDS_NORMAL',     description: `${n} looks at normal hands again. No glow. But the garden is magnificent. The magic left something real behind. NOT bedtime. Garden.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',          description: `The last line. Birthday hands grow things nobody else can see. Echo the tingly morning. Warm, green, alive.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'birthday_star',
    name: 'The Birthday Star',
    synopsis: 'A star falls into the yard on birthday morning. The child keeps it safe all day, feeding it cake crumbs and singing to it, before releasing it back to the sky at night.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'STAR_FALLS',       description: `Something bright tumbles into the yard on birthday morning. ${n} finds a tiny, warm, glowing star in the grass. Garden.`, wordTarget: wt },
        { spread: 2,  beat: 'HOLDING_IT',        description: `${n} cups the star in both hands. It hums softly and glows golden. It fits perfectly in a small palm. Garden.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'BRINGING_INSIDE',   description: `${n} carries the star carefully inside. Makes a nest for it in a shoebox with cotton and a doll blanket. At home.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'FEEDING',           description: `Birthday breakfast — ${n} shares a cake crumb with the star. It glows brighter. It likes cake! ${n} giggles. Kitchen.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'PLAYING',           description: `${n} shows the star around — favorite toys, the view from the window, a drawing. The star pulses happily at each thing. At home.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'SINGING',           description: `${n} sings happy birthday to the star (or maybe it's ${n}'s birthday, so the star sings back — a tiny chiming hum). A duet. At home.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'NAPPING',           description: `The star dozes in its shoebox nest. ${n} watches it breathe light. The quietest, tenderest moment. Fewest words. At home.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'ADVENTURE_OUT',     description: `${n} takes the star outside for birthday adventures — shows it the sky it came from, the trees, the birds. The star glows at everything. Garden.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'BIRTHDAY_WISH',     description: `With cake candles lit, ${n} makes a wish holding the star. The star flares with the wish. The most magical birthday moment. At home.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'MISSING_HOME',      description: `As evening comes, the star glows toward the sky. It misses its family up there. ${n} understands — it's time. Garden, dusk.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'LETTING_GO',        description: `${n} opens both hands. The star rises slowly, pauses, blinks twice (a thank you), and floats upward. Beautiful and bittersweet. Garden.`, wordTarget: wt },
        { spread: 12, beat: 'WATCHING_IT_GO',    description: `The star rejoins the sky, brighter than before. ${n} waves. Up there, the star winks. NOT bedtime — just a goodbye. Garden.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. Every birthday night, one star glows brighter than the rest. Echo the morning discovery. Warm, golden, wonder.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'color_birthday',
    name: 'The Color Birthday',
    synopsis: 'The child wakes to a black-and-white world — but every birthday activity brings back a color. Playing brings back red, laughing brings back yellow, until the world is rainbow again.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'GREY_MORNING',     description: `${n} wakes on birthday morning, but everything is grey — no colors at all. The room, the sky, even the cake. Strange and curious. Bedroom.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_COLOR',       description: `${n} laughs at something silly — and yellow bursts back! The sun, the butter, the banana on the counter. Laughter makes yellow. Kitchen.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SECOND_COLOR',      description: `${n} runs outside to play — and red returns! Roses, a ladybug, the wagon. Playing brings red. Garden.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'THIRD_COLOR',       description: `${n} hugs someone (a pet, a stuffed animal) — and blue comes back! The sky, a bird, the puddle. Love brings blue. Garden.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'FOURTH_COLOR',      description: `${n} sings a silly song — green returns! The grass, the leaves, the frog by the pond. Music brings green. Garden.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'PATTERN',           description: `${n} understands now — birthday feelings bring back colors! What else can bring them? Time to try everything. Same location.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'QUIET_COLOR',       description: `${n} sits quietly and feels grateful — and purple appears, soft and deep. The quietest color for the quietest feeling. Fewest words.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'WILD_COLORS',       description: `${n} dances, jumps, shouts with joy — orange, pink, gold all burst back at once! The world is nearly complete. Maximum energy and color. Garden.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'LAST_COLOR',        description: `One color is still missing. ${n} looks around, thinks hard. Then makes a birthday wish — and the last color fills in. The world is whole.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'RAINBOW_WORLD',     description: `The full rainbow world, brighter than before. Everything glows with earned color. ${n} stands in the middle of it all. The emotional peak.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'CAKE_IN_COLOR',     description: `Back to the birthday cake — now in full, vivid color. The frosting, the sprinkles, the candles. More beautiful because it was earned. At home.`, wordTarget: wt },
        { spread: 12, beat: 'CELEBRATING',       description: `${n} eats cake in a world of color, savoring every bright detail. Nothing is grey anymore. NOT bedtime. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. Some birthdays add a year; this one added every color. Echo the grey morning. Warm, bright, rainbow.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'tiny_party',
    name: 'The Tiny Party',
    synopsis: 'The child shrinks to the size of a mouse and discovers a birthday party set up just for them among the flowers — tiny cakes, firefly lanterns, and ladybug guests.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'SHRINKING',        description: `${n} picks up a glowing birthday acorn from the garden and — WHOOSH — shrinks to the size of a thumb. The grass is a forest now. Garden, ground level.`, wordTarget: wt },
        { spread: 2,  beat: 'TINY_WORLD',       description: `Everything is enormous. A pebble is a boulder, a dandelion is a tree. ${n} walks between grass blades. The garden is a new world. Ground level.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'DISCOVERY',        description: `Under a mushroom: a tiny table, tiny chairs, a tiny cake with tiny candles. Someone set up a birthday party down here! Under the mushroom.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'GUESTS_ARRIVE',    description: `The guests arrive — a ladybug, an ant carrying a crumb-gift, a beetle in a tiny hat. They've been waiting for ${n}. Under the mushroom.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'TINY_FEAST',       description: `The feast is dewdrop juice and seed-cake. A petal is a plate. Everything is delicious at this size. Eating with bug friends. Under the mushroom.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'TINY_GAMES',       description: `Party games at bug scale — racing on a snail, sliding down a leaf, swinging from a spider thread (abandoned, no spider!). Maximum fun. Nearby garden.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'FIREFLY_LIGHTS',   description: `As shadows grow, fireflies arrive — living birthday lanterns. They circle ${n}, glowing. The most magical, quietest moment. Fewest words. Garden.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'TINY_CAKE',        description: `The tiny cake has candles lit by fireflies. ${n} makes a tiny wish and blows. The bugs cheer in tiny voices. Under the mushroom.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'DANCING',          description: `A cricket plays music. Everyone dances — ${n}, the ladybug, the ants in a conga line. A proper tiny party. Maximum joy. Under the mushroom.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'GIFT',             description: `The bugs give ${n} a gift — a dewdrop that holds a tiny rainbow inside. The most precious birthday present. Under the mushroom.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'GROWING_BACK',     description: `The acorn glows again. ${n} starts to grow — slowly, gently. Waving goodbye to tiny friends who wave antennae back. Garden.`, wordTarget: wt },
        { spread: 12, beat: 'FULL_SIZE',        description: `Back to full size, standing in the garden. The mushroom is just a mushroom again. But in ${n}'s palm: a dewdrop, still with its rainbow. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',          description: `The last line. The best parties are the ones you have to shrink to find. Echo the glowing acorn. Warm, tiny, wondrous.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'birthday_cloud',
    name: 'The Birthday Cloud',
    synopsis: 'A soft, puffy cloud descends into the yard and invites the child to hop on for a birthday ride across the sky — over rainbows, through sunbeams, past the moon.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'CLOUD_LANDS',      description: `A fluffy white cloud sinks down into the yard on birthday morning. It settles like a pillow on the grass. ${n} walks toward it. Garden.`, wordTarget: wt },
        { spread: 2,  beat: 'HOPPING_ON',       description: `${n} climbs onto the cloud — it's soft, warm, and bouncy. It lifts gently off the ground. The yard shrinks below. Rising up.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'ABOVE_THE_ROOFS',  description: `Flying above the neighborhood. ${n} can see the house, the school, the park — all tiny below. Wind in hair, sun on face. Sky.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'RAINBOW_PASS',     description: `The cloud flies through a rainbow. Colors wash over ${n} — warm red, cool blue, tickly yellow. Each color has a feeling. Sky.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'SUNBEAM_SLIDE',    description: `A golden sunbeam stretches out like a slide. ${n} slides down it and lands back on the cloud, laughing. Sky playground. Sky.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'CLOUD_FRIENDS',    description: `Other clouds shaped like animals float by — a cloud rabbit, a cloud elephant, a cloud dragon. They wave and tumble. Sky.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'QUIET_HEIGHT',     description: `The cloud rises to the very top of the sky. Everything below is silent and small. ${n} and the sky, alone together. Fewest words. High sky.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'MOON_VISIT',       description: `The cloud drifts past the moon (it's still up in the daytime sky). The moon sings a tiny birthday song. A lunar birthday wish. Near the moon.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'CLOUD_CAKE',       description: `The cloud reshapes itself into a birthday cake — puffy frosting towers, wispy candles. ${n} blows and the cloud-candles puff away. Maximum magic. Sky.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'DESCENDING',       description: `Time to head home. The cloud dips slowly, gently. The yard grows bigger below. The adventure is ending, but the warmth lingers. Descending.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'SOFT_LANDING',     description: `The cloud settles back on the grass. ${n} hops off. The cloud rises again, slowly, like a wave goodbye. Garden.`, wordTarget: wt },
        { spread: 12, beat: 'LOOKING_UP',       description: `${n} lies on the grass, looking up. The birthday cloud is back in the sky, just another cloud now. But ${n} knows better. NOT bedtime. Garden.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',          description: `The last line. Look up on your birthday — one cloud is always yours. Echo the morning landing. Warm, soft, sky-high.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'magic_frosting',
    name: 'The Magic Frosting',
    synopsis: 'The birthday cake frosting is magic — every color the child spreads creates something: blue frosting makes waves, green makes a garden, and the sprinkles become stars.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'FROSTING_JARS',    description: `Birthday morning. ${n} discovers jars of frosting that glow — blue, green, pink, gold. They hum faintly. Time to decorate the cake. Kitchen.`, wordTarget: wt },
        { spread: 2,  beat: 'BLUE_SPREAD',      description: `${n} spreads blue frosting on the cake — and a tiny ocean appears on the surface! Waves lap at the candles. A fish jumps. Kitchen.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'GREEN_SWIRL',      description: `Green frosting creates a tiny garden on the cake — flowers bloom, a tree sprouts, a caterpillar crawls along the edge. Living cake. Kitchen.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'PINK_DOTS',        description: `Pink frosting makes cotton candy clouds that float above the cake. A tiny bird flies between them. The cake is becoming a world. Kitchen.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'GOLD_DRIZZLE',     description: `Gold frosting poured on top becomes rivers of honey light. Everything it touches glows. The cake shimmers. Use ${n}'s interests in the design. Kitchen.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'SPRINKLES',        description: `The sprinkles! Each one becomes a tiny star. ${n} shakes them over the cake and a constellation forms. The kitchen twinkles. Kitchen.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'STEPPING_BACK',    description: `${n} steps back to see the whole cake — a magical world of oceans, gardens, clouds, and stars. Breathtaking. Fewest words. Kitchen.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'CAKE_ALIVE',       description: `The cake world is fully alive — tiny creatures waving up at ${n}, flowers swaying, stars pulsing. The most magical creation ever. Kitchen.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'CANDLE_WISH',      description: `Candles placed on top of this magical cake. ${n} makes a wish over a living world. The blow sends frosting magic swirling. Kitchen.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'FIRST_SLICE',      description: `The first slice: the ocean becomes blueberry, the garden becomes mint, the clouds become strawberry. Magic you can taste. Kitchen.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'SHARING',          description: `Every person who eats a slice sees a tiny magic in their piece — a star, a flower, a wave. ${n} made magic for everyone. Kitchen.`, wordTarget: wt },
        { spread: 12, beat: 'EMPTY_PLATE',      description: `The cake is eaten, the jars are empty. But ${n}'s fingers are still frosting-stained and faintly glowing. NOT bedtime. Kitchen.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',          description: `The last line. The sweetest magic is the kind you share. Echo the glowing jars. Warm, sugary, sparkling.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'animal_birthday',
    name: 'The Animal Birthday',
    synopsis: 'The animals in the neighborhood secretly plan a birthday for the child — the birds weave a banner, the squirrels stack nuts into a cake, the cat brings a ribbon bow.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'QUIET_MORNING',    description: `Birthday morning seems ordinary. ${n} sits on the front step, waiting for the day to begin. But in the bushes — eyes are watching. Front yard.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_SIGN',       description: `A robin drops a berry at ${n}'s feet and flies away. Odd. Then a squirrel leaves an acorn on the step. Something is happening. Front yard.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FOLLOWING',         description: `${n} follows the trail of gifts — a shiny pebble from a crow, a feather from a jay. Each one leads deeper into the yard. Yard path.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'THE_CLEARING',     description: `${n} reaches the back garden and gasps. The animals have set up a party: a leaf tablecloth, acorn cups, flower plates. Back garden.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'BIRD_BANNER',      description: `Birds hold a banner woven from grass and petals. It's crooked and wonderful. The birds sing — their version of "happy birthday." Back garden.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'NUT_CAKE',         description: `The squirrels present their masterpiece: a cake made of stacked acorns and berries, topped with a dandelion "candle." Proudly offered. Back garden.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'CAT_GIFT',         description: `A neighborhood cat saunters in with a ribbon bow in its mouth, drops it at ${n}'s feet, and sits like royalty. Tender and funny. Fewest words. Back garden.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'PARTY_GAMES',      description: `The animals play party games — butterflies do aerial tricks, a frog leaps for joy, the squirrels chase each other. ${n} laughs. Maximum energy. Back garden.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'DANDELION_WISH',   description: `${n} holds the dandelion "candle" and makes a wish. Blows — seeds scatter into the sky. The animals watch, hushed. Back garden.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'GROUP_MOMENT',      description: `${n} sits among all the animals. A robin on a shoulder, a squirrel in the lap, the cat nearby. Surrounded by an unusual kind of love. Back garden.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'GOODBYE_PARADE',   description: `One by one, the animals leave — a wave of a wing, a flick of a tail. The party dissolves gently back into nature. Back garden.`, wordTarget: wt },
        { spread: 12, beat: 'TREASURES',        description: `${n} carries the acorn cup, the ribbon, the feather inside. A birthday celebrated by the whole yard. NOT bedtime. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',          description: `The last line. When the animals throw a party, it means you belong to the world. Echo the quiet morning. Warm, wild, beloved.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'birthday_train',
    name: 'The Birthday Train',
    synopsis: 'A toy train appears on birthday morning — but it\'s big enough to ride! Each car visits a different birthday surprise: a cake car, a present car, a dance-party caboose.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'TRAIN_ARRIVES',    description: `A bright, shiny train appears on the bedroom floor on birthday morning — big enough for ${n} to climb aboard. A whistle toots. Bedroom.`, wordTarget: wt },
        { spread: 2,  beat: 'ALL_ABOARD',       description: `${n} climbs into the engine. There's a conductor hat and a golden ticket that says "Birthday Express." The train begins to move. On the train.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_CAR',        description: `The first car is full of balloons — every color, every shape. ${n} bounces among them. The train chugs along through a sparkly tunnel. Balloon car.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'CAKE_CAR',         description: `The next car is entirely cake — frosting walls, candy windows, a fountain of chocolate. ${n} takes a bite of everything. Cake car.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'PRESENT_CAR',      description: `A car stacked with wrapped presents. Each one holds something connected to ${n}'s interests. The wrapping paper is as fun as the gifts. Present car.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'GAME_CAR',         description: `A car that's a playground — slides, a ball pit, a trampoline. ${n} plays while the train rolls on. Maximum physical fun. Game car.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'QUIET_CAR',        description: `A soft, dim car full of pillows and starlight. The train slows. ${n} looks out the window at passing clouds. The restful beat. Fewest words. Quiet car.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'MUSIC_CAR',        description: `A car that's a dance party — music, lights, a disco ball made of birthday candles. ${n} dances and the whole train shakes with joy. Music car.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'WISH_CAR',         description: `The most special car: one perfect birthday cake with glowing candles. ${n} sits alone with the wish. Makes it count. Blows. Wish car.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'LAST_CAR',         description: `The caboose — a window shows everywhere the train has been. A scrapbook of the journey. ${n} traces the path. Caboose.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'PULLING_IN',       description: `The train slows and pulls back into the bedroom. The whistle toots one last time. The ride is over. Bedroom.`, wordTarget: wt },
        { spread: 12, beat: 'BACK_IN_ROOM',     description: `${n} climbs out. The train shrinks back to toy size. But the conductor hat is still on ${n}'s head. It was real. NOT bedtime. Bedroom.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',          description: `The last line. Some trains run on tracks; this one runs on birthday wishes. Echo the first whistle. Warm, bright, chugging with joy.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
];
