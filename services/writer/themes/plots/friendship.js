/**
 * Friendship plot templates — 12 structurally distinct story arcs.
 *
 * Each template returns 13 spreads in 4-scene (A/B/C/D) grouping.
 * opts: { child, isYoung, wt, parentName, book, theme }
 */

module.exports = [
  {
    id: 'classic_friendship',
    name: 'Classic Friendship',
    synopsis: 'An ordinary day is disrupted by an unexpected meeting — a creature appears, curiosity sparks connection, and by day\'s end the child understands what it means to have a friend.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'ORDINARY_DAY',     description: `${n} is outside, doing nothing in particular — poking a stick, watching ants, lying in the grass. An ordinary moment about to become extraordinary. Near home.`, wordTarget: wt },
        { spread: 2,  beat: 'RUSTLING',          description: `A sound in the bushes. Something moves. ${n} leans closer. Two bright eyes peer back — curious, cautious, friendly. A creature appears. Near home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_MEETING',     description: `The creature steps out — unusual, endearing, a little odd. It tilts its head at ${n}. ${n} tilts back. The first silent conversation. Near home.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'OFFERING',          description: `${n} offers something — a crumb, a leaf, an open hand. The creature sniffs, considers, and accepts. The first gift between friends. Near home.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'PLAYING',           description: `They play — chasing, hiding, exploring together. The creature is fast; ${n} is clever. They figure out each other's rhythms. Nearby.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'UNDERSTANDING',     description: `A moment of real understanding — the creature shows ${n} something meaningful, a favorite spot, a hidden treasure. Trust is being built. Nearby.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'TROUBLE',           description: `Something goes wrong — a misunderstanding, a scare, a moment of distance. The creature backs away. ${n} feels the gap. The ache of almost-lost connection. Same spot.`, wordTarget: wt + 2 },
        { spread: 8,  beat: 'REACHING_OUT',      description: `${n} sits quietly, waits, doesn't push. Extends a hand again. Patience. The creature returns, slowly. Friendship is rebuilt in gentleness. Same spot.`, wordTarget: wt },
        { spread: 9,  beat: 'TOGETHER_AGAIN',    description: `Together again, closer now. The rift made the bond stronger. They sit side by side, watching the world. The quietest, most connected moment. Same spot.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'SHARED_MOMENT',     description: `A sunset, a shared snack, a joke only they understand. The creature leans against ${n}. Warmth without words. The peak of friendship. Same spot.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'GOODBYE_FOR_NOW',   description: `The creature stands, stretches, nuzzles ${n}'s hand. It has somewhere to be. Not a forever goodbye — a "see you tomorrow." Near home.`, wordTarget: wt },
        { spread: 12, beat: 'WALKING_HOME',      description: `${n} walks home with a full heart and a slightly muddy hand. Tomorrow they'll meet again. The world has one more friend in it. NOT bedtime. Walking home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. Friends appear when you're quiet enough to notice the rustling. Echo the first ordinary moment. Warm, connected, found.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'pen_pal',
    name: 'The Pen Pal',
    synopsis: 'A letter arrives — no return address, odd handwriting, a feather tucked inside. The child writes back, and an exchange of letters with a mysterious creature reveals a friendship built in ink.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'LETTER_ARRIVES',   description: `${n} finds a letter in the mailbox — no stamp, no return address. Inside: wobbly handwriting, a pressed flower, and the words: "Dear friend, I live in the oak tree." At home.`, wordTarget: wt },
        { spread: 2,  beat: 'READING',           description: `${n} reads the letter three times. The writer describes watching ${n} play from the branches. It signs off with a tiny pawprint instead of a name. At home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'WRITING_BACK',      description: `${n} writes a reply — "Dear tree friend" — and tucks in a drawing and a cookie crumb. Places the letter at the base of the big oak. Near the oak tree.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'SECOND_LETTER',     description: `Next morning: another letter in the mailbox! The pen pal loved the cookie crumb. This letter includes a tiny map of the tree branches. The exchange is real. At home.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'GROWING_EXCHANGE',  description: `Letters fly back and forth. Each one shares more — favorite colors, favorite weather, dreams. ${n} learns the pen pal is small, furry, and afraid of thunder. At home.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'GIFT_EXCHANGE',     description: `The pen pal sends a gift — an acorn cap, a feather, a berry. ${n} sends back a button, a piece of ribbon, a crayon drawing. Treasures traded. At home.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'RAINY_LETTER',      description: `A letter on a rainy day — the ink is smudged, the paper damp. "I'm lonely when it rains." ${n} writes back immediately: "Me too." The most honest exchange. At home.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'WANTING_TO_MEET',   description: `${n} writes: "Can I see you?" The reply: "I'm shy. But come sit under the oak and I'll be close." Anticipation builds. At home.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'UNDER_THE_OAK',     description: `${n} sits under the oak tree with a letter and a cookie. A rustle in the branches. A tiny face peeks through the leaves — bright eyes, whiskers, a wave. Under the oak.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'ALMOST_MEETING',    description: `The creature drops a nut into ${n}'s lap. ${n} places a cookie on a branch. They look at each other — really look — and both smile. Words aren't needed. Under the oak.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'HEADING_HOME',      description: `${n} walks home, already composing the next letter in mind. The pen pal watches from the branches, already composing its own. Near home.`, wordTarget: wt },
        { spread: 12, beat: 'LETTER_BOX',        description: `At home, ${n} puts all the letters in a special box — tied with the ribbon the pen pal sent. A friendship in paper and ink and crumbs. NOT bedtime. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. Some friends are found in mailboxes, written in wobbly ink, and loved from a distance. Echo the first letter. Warm, written, cherished.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'opposite_friends',
    name: 'Opposite Friends',
    synopsis: 'The child meets a creature who is completely different — big where the child is small, loud where the child is quiet, fast where the child is slow. They shouldn\'t be friends. But they are.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'COLLISION',        description: `${n} is walking quietly when CRASH — a large, bouncy, loud creature lands in the path. Feathers everywhere, or fur, or spots. It grins enormously. Outdoors.`, wordTarget: wt },
        { spread: 2,  beat: 'DIFFERENCES',      description: `${n} is small; the creature is big. ${n} speaks softly; the creature booms. ${n} walks; the creature bounces. Everything about them is opposite. Outdoors.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'ANNOYANCE',        description: `At first it's annoying. The creature is too loud, too close, too much. ${n} tries to walk away but the creature follows, cheerfully oblivious. Outdoors.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'STUCK_TOGETHER',   description: `They both want to cross the same stream, climb the same hill, sit under the same tree. The world keeps pushing them together. Outdoors.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'FIRST_HELP',       description: `${n} can't reach a high branch. The creature lifts ${n} easily. The creature can't fit through a narrow gap. ${n} scouts ahead. They need each other. Outdoors.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'FIRST_LAUGH',      description: `Something silly happens and they both laugh — different laughs, one quiet, one thunderous. But the timing is the same. The first real connection. Outdoors.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'TEACHING_EACH',    description: `${n} teaches the creature to be quiet and listen to birdsong. The creature teaches ${n} to be loud and roar at the sky. Each learns the other's way. Outdoors.`, wordTarget: wt + 2 },
        { spread: 8,  beat: 'PERFECT_TEAM',     description: `A challenge appears — something neither could handle alone. Together, using their opposite strengths, they solve it perfectly. Teamwork at its best. Outdoors.`, wordTarget: wt },
        { spread: 9,  beat: 'QUIET_TOGETHER',   description: `Sitting side by side — the big creature trying to be still, ${n} trying to take up more space. Meeting in the middle. The warmest silence. Outdoors.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'CELEBRATING',      description: `They celebrate their differences now — ${n} decorates the creature with flowers, the creature spins ${n} in the air. Joy in what makes each one unique. Outdoors.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'PARTING',           description: `The creature has to go — it lives somewhere wild and different, of course. A huge, warm hug. The creature's goodbye is loud; ${n}'s is a whisper. Both perfect. Outdoors.`, wordTarget: wt },
        { spread: 12, beat: 'REMEMBERING',      description: `${n} walks home, stepping louder than usual, grinning wider. The opposite friend left something behind — a way of being that wasn't there before. NOT bedtime. Walking home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',          description: `The last line. The best friends are the ones who are nothing like you and everything you needed. Echo the first crash. Warm, loud, opposite, perfect.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'friendship_recipe',
    name: 'The Friendship Recipe',
    synopsis: 'What makes a friend? The child sets out to discover the ingredients — a cup of sharing, a pinch of listening, a handful of laughter — each one found through the day\'s small encounters.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'THE_QUESTION',     description: `${n} asks the biggest question: "What makes a friend?" Not the word — the real thing. What is it made of? ${n} decides to find out. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'SHARING_INGREDIENT',description: `At the park, ${n} shares a snack with a squirrel on the bench. The squirrel takes the crumb gently. "Sharing," ${n} whispers. First ingredient found. Park.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'LISTENING_INGREDIENT',description: `By the pond, a frog croaks a long, complicated song. ${n} sits and listens — really listens — until the song is done. "Listening." Second ingredient. Pond.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'LAUGHING_INGREDIENT',description: `A bird does something ridiculous — a wobble, a tumble, a silly strut. ${n} laughs out loud and the bird does it again. "Laughing together." Third ingredient. Path.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'PATIENCE_INGREDIENT',description: `A caterpillar is crossing the path — painfully slow. ${n} waits, walks beside it, matches its pace. "Patience." Fourth ingredient. Path.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'KINDNESS_INGREDIENT',description: `A beetle is stuck on its back, legs waving. ${n} gently tips it right-side-up. It scurries away, then pauses to look back. "Kindness." Fifth ingredient. Garden.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'HONESTY_INGREDIENT', description: `${n} looks at a reflection in a puddle and says something true: "Sometimes I'm scared." The reflection nods. "Honesty." The hardest ingredient. Puddle.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'FORGIVENESS_INGREDIENT',description: `${n} accidentally steps on a worm's path. The worm wriggles away, then comes back. No grudge, no memory of the hurt. "Forgiveness." Seventh ingredient. Garden.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'SHOWING_UP',       description: `Rain starts. The squirrel from earlier appears and sits under the same bench with ${n}. "Just being there." The most important ingredient of all. Park bench.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'MIXING_IT',        description: `${n} imagines putting all the ingredients together — sharing, listening, laughing, patience, kindness, honesty, forgiveness, showing up. What does it make? Thinking spot.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'THE_ANSWER',       description: `It makes warmth. A feeling like a full stomach and a held hand and a sunny afternoon. That's what a friend is made of. ${n} knows now. Walking home.`, wordTarget: wt },
        { spread: 12, beat: 'HOME_WITH_RECIPE', description: `${n} draws the recipe on paper — with pictures for each ingredient. It goes on the wall. A recipe to remember. NOT bedtime. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',          description: `The last line. A friend is something you make, one ingredient at a time. Echo the first question. Warm, mixed, whole.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'rainy_day_friend',
    name: 'The Rainy Day Friend',
    synopsis: 'A friend only appears when it rains — a creature made of raindrops, puddle-eyes, and mist. The child and the rain-friend play in the wet world, knowing sunshine will take them away.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'RAIN_BEGINS',      description: `Rain taps the window. ${n} presses nose to the glass and sees something in the puddle below — a face made of water, rippling and smiling. Garden.`, wordTarget: wt },
        { spread: 2,  beat: 'GOING_OUT',         description: `${n} runs outside in boots and a raincoat. The puddle-creature rises — a small, shimmering figure made entirely of rain. It waves with dripping fingers. Garden.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_PLAY',        description: `They splash together — the rain-friend turns every puddle into a trampoline. Water flies, laughter rises, the rain falls harder as if cheering. Garden.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'RAIN_WORLD',        description: `The rain-friend shows ${n} the rain world — the gutter is a river, the drain is a waterfall, every rooftop pours its own stream. A water kingdom. Neighborhood.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'RAIN_MUSIC',        description: `The rain-friend makes music — drumming on leaves, tapping on metal, pattering on stone. ${n} dances to the rain-friend's concert. Neighborhood.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'RAIN_GIFTS',        description: `The rain-friend gives gifts made of water — a bracelet of raindrops, a crown of mist, a tiny boat that floats on air. Beautiful and temporary. Park.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'QUIET_RAIN',        description: `They sit under a tree together as the rain slows to a drizzle. The rain-friend grows fainter. ${n} holds a watery hand. The gentlest, saddest-happiest moment. Park.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'SUN_THREATENS',     description: `The clouds thin. A patch of blue appears. The rain-friend looks up, worried. When the sun comes, rain-friends dissolve. ${n} understands. Park.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'LAST_DANCE',        description: `One last dance in the remaining rain — spinning, jumping, the rain-friend flickering like a candle. Making the most of every drop. Park.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'DISSOLVING',        description: `The sun breaks through. The rain-friend smiles, shimmers, and melts back into the puddle. A ripple — like a wave goodbye. Just water now. Park.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'WAITING',           description: `${n} stands in the suddenly sunny world, boots wet, cheeks damp. Looking at the sky for clouds. The rain-friend will come back. They always do. Park.`, wordTarget: wt },
        { spread: 12, beat: 'HOME_WET',          description: `${n} walks home, soaked and smiling. In a pocket: nothing — rain-friends don't leave things behind. Except the feeling. NOT bedtime. Walking home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. Some friends can only visit when the sky cries, and that makes every rainy day a gift. Echo the first tap. Warm, wet, treasured.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'building_together',
    name: 'Building Together',
    synopsis: 'Two friends — the child and a creature — decide to build something together. They argue about the design, compromise on the materials, and create something neither could have made alone.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'THE_IDEA',         description: `${n} and a friendly creature find a pile of sticks, stones, and leaves. Same thought, same moment: "Let's build something!" They both grin. Outdoors.`, wordTarget: wt },
        { spread: 2,  beat: 'DIFFERENT_PLANS',  description: `${n} wants to build a tower. The creature wants to build a bridge. They draw plans in the dirt — side by side, completely different. Outdoors.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_ARGUMENT',   description: `"Tower!" "Bridge!" "TOWER!" "BRIDGE!" They turn their backs on each other. Two separate piles of sticks. Two stubborn builders. Outdoors.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'BUILDING_ALONE',   description: `Each builds alone. ${n}'s tower is tall but wobbly. The creature's bridge is flat but goes nowhere. Something is missing from both. Outdoors.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'TOWER_FALLS',      description: `${n}'s tower topples. The creature's bridge sags. They look at each other's failures and — instead of laughing — they feel sorry. A softening. Outdoors.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'NEW_IDEA',         description: `"What if..." ${n} starts. "...we build both?" the creature finishes. A tower connected by a bridge. Eyes light up. The compromise is better than either plan. Outdoors.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'WORKING_TOGETHER', description: `Now they build as a team — ${n} holds while the creature stacks, the creature reaches while ${n} places. Together their hands make something steady. Outdoors.`, wordTarget: wt + 2 },
        { spread: 8,  beat: 'PROBLEM_SOLVING',  description: `The bridge won't hold. They try moss, then bark, then packed mud. Each failure makes them think harder. Each attempt is closer. Working together. Outdoors.`, wordTarget: wt },
        { spread: 9,  beat: 'IT_WORKS',         description: `The structure stands — tower and bridge, connected and strong. They step back and stare. Neither could have made this alone. The most proud, quiet moment. Outdoors.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'CELEBRATING',      description: `They dance around the creation, pointing at their favorite parts. "I did this bit!" "And I did this!" Every piece has two builders. Outdoors.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'ADDING_FINISHING',  description: `Final touches — a leaf flag on the tower, a pebble path on the bridge. ${n} and the creature add one last detail together. Outdoors.`, wordTarget: wt },
        { spread: 12, beat: 'LEAVING_IT',       description: `They walk away side by side, looking back at what they made. It stands in the golden light. Tomorrow it might fall — but today it's perfect. NOT bedtime. Walking home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',          description: `The last line. The best things are built by two pairs of hands that learned to agree. Echo the first grin. Warm, built, shared.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'lost_friend',
    name: 'The Lost Imaginary Friend',
    synopsis: 'The child\'s imaginary friend has gone missing — not in the bedroom, not under the stairs. A search through familiar places reveals that imaginary friends hide when they feel forgotten.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'MISSING',          description: `${n} reaches for the imaginary friend — the one who's always there, always listening. But the space beside ${n} is empty. Something is missing. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'SEARCHING_HOME',   description: `Under the bed, behind the couch, inside the closet. ${n} looks in all the hiding spots. Not there. The house feels bigger without the invisible friend. At home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'OUTSIDE_SEARCH',   description: `${n} checks the garden — the special bush, the hollow log, the spot behind the shed where they used to tell secrets. Empty. Growing worried. Garden.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'MEMORY_LANE',      description: `Walking to all their favorite places — the park bench where they sat, the puddle they jumped in, the wall they balanced on. Each place has a memory but no friend. Park.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'ASKING_AROUND',    description: `${n} asks a passing cat, a robin, a ladybug: "Have you seen my friend?" Animals tilt their heads. Imaginary friends are hard to describe to others. Walking.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'GUILT',            description: `${n} sits on the curb and thinks. When was the last time they played together? When did ${n} stop talking to the imaginary friend? Has it been too long? Curb.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'REMEMBERING',      description: `${n} closes eyes and remembers — the games, the whispered conversations, the way the friend always laughed at the silly jokes. The memories glow. Sitting still.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'CALLING_OUT',      description: `${n} stands up and calls the friend's name — out loud, not caring who hears. "I'm sorry! I didn't forget you! Come back!" Echoing across the park. Park.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'A_SIGN',           description: `A breeze. A warmth beside ${n}'s shoulder. The faintest outline — shimmering, hesitant, peeking from behind a tree. The friend was hiding, not gone. Park.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'REUNION',          description: `${n} runs to the tree. The friend is there — fainter than before, but smiling. ${n} hugs the air and the air hugs back. "I missed you." "I missed you more." Park.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'PROMISE',          description: `Walking home together — ${n} talking, the invisible friend listening. A promise: "I won't forget again." The friend glows a little brighter. Walking home.`, wordTarget: wt },
        { spread: 12, beat: 'TOGETHER_AGAIN',   description: `At home, ${n} sets a place at the table for two. Pours an extra cup. The invisible friend sits in its chair, solid again. NOT bedtime. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',          description: `The last line. Imaginary friends never truly leave — they just get quiet when you stop listening. Echo the empty space. Warm, invisible, found.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'animal_companion',
    name: 'The Animal Companion',
    synopsis: 'A stray animal appears at the garden gate — scruffy, cautious, wild-eyed. The child earns its trust through patience and snacks, and together they have the best afternoon ever.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'AT_THE_GATE',      description: `Something sits outside the garden gate — scruffy fur, wary eyes, ears flattened. A stray animal, watching ${n} from a distance. Neither moves. Garden gate.`, wordTarget: wt },
        { spread: 2,  beat: 'SLOW_APPROACH',     description: `${n} crouches low and holds out a hand, palm up. The animal sniffs the air. One step closer. Then another. Then it freezes. Patience required. Garden gate.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_SNACK',       description: `${n} places a cracker on the ground and backs away. The animal creeps forward, sniffs, and eats. Looks up with crumb-covered whiskers. Trust is a cracker. Garden.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'CLOSER',            description: `More snacks, less distance. The animal lets ${n} sit nearby while it eats. No touching yet, but the space between them has become comfortable. Garden.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'FIRST_TOUCH',       description: `${n} extends one finger. The animal bumps its head against it — warm, alive, deliberate. First contact. ${n}'s heart beats so loud the animal must hear it. Garden.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'PLAYING',           description: `A stick! A leaf! The animal pounces, tumbles, chases. ${n} runs alongside. The wariness is gone — replaced by pure, wild joy. Garden.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'RESTING_TOGETHER',  description: `Both flop down in the grass, panting. The animal rolls onto its back. ${n} lies beside it. Two creatures, breathing in sync. The quietest bond. Garden.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'ADVENTURE',         description: `Together they explore beyond the garden — along the fence, through the hedge, into the field. The animal knows paths ${n} never noticed. Beyond the garden.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'ANIMAL_SHOWS',      description: `The animal leads ${n} to something special — a hidden den, a burrow, a secret spot with a view. A gift of trust: "This is where I come." Secret spot.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'HEADING_BACK',      description: `The sky turns gold. The animal seems to know it's time. They walk back together — the animal matching ${n}'s pace, shoulder against leg. Walking back.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'AT_THE_GATE_AGAIN', description: `Back at the garden gate. The animal pauses, looks at ${n} with those wild eyes — softened now. Nuzzles ${n}'s hand once. Then slips through the hedge. Garden gate.`, wordTarget: wt },
        { spread: 12, beat: 'WATCHING_IT_GO',    description: `${n} watches the animal disappear. The gate is just a gate again. But tomorrow ${n} will leave a cracker there, just in case. NOT bedtime. Garden.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. The wildest friends are the ones who choose you when they don't have to. Echo the wary eyes. Warm, wild, earned.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'sharing_day',
    name: 'Sharing Day',
    synopsis: 'The child starts the day with one apple. By sharing it — a piece here, a piece there — it multiplies into a day full of gifts returned: a feather, a song, a dance, a smile.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'ONE_APPLE',        description: `${n} has one apple — red, round, perfect. It's the only snack. ${n} holds it in both hands and walks outside. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_SHARE',       description: `A rabbit on the path looks hungry. ${n} breaks off a piece of apple and places it down. The rabbit eats, twitches its nose in thanks, and hops away. Path.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'RABBIT_RETURNS',    description: `The rabbit comes back with a clover flower and drops it at ${n}'s feet. A gift for a gift. Sharing returned something. ${n} tucks the clover behind an ear. Path.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'SECOND_SHARE',      description: `A bird on a branch eyes the apple. ${n} tosses a piece upward. The bird catches it mid-air and sings — the most beautiful three-note song. A song for a snack. Park.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'THIRD_SHARE',       description: `A turtle by the pond moves slowly toward ${n}. Another piece of apple offered. The turtle eats, then taps its shell — a rhythm, a thank-you drumbeat. Pond.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'APPLE_SHRINKS',     description: `The apple is getting smaller. ${n} looks at what's left — barely a few bites. But the pockets are full of gifts: clover, song, rhythm. Worth it. Walking.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'GIVING_MORE',       description: `A ladybug gets a tiny piece — it opens its wings in a flash of red and gold. A thank-you in color. ${n} gives without thinking now. Garden.`, wordTarget: wt + 2 },
        { spread: 8,  beat: 'LAST_PIECE',        description: `One piece left. ${n} holds it, stomach growling. A caterpillar reaches up. ${n} gives it away — the last bit — and the caterpillar glows. Garden.`, wordTarget: wt },
        { spread: 9,  beat: 'EMPTY_HANDS',       description: `No apple left. ${n} looks at empty hands. But they're not really empty — they held kindness all day. The quietest, truest feeling. Garden.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'SURPRISE_RETURN',   description: `The animals appear — all of them, at once. The rabbit, the bird, the turtle, the ladybug. Each brings something: a berry, a seed, a petal. A feast returns. Garden.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'SHARED_FEAST',      description: `${n} and all the animals share the tiny feast together in the grass. It's more food than one apple ever was. Sharing multiplied it. Garden.`, wordTarget: wt },
        { spread: 12, beat: 'WALKING_HOME',      description: `${n} walks home with pockets full of petals and seeds, stomach full, heart fuller. Tomorrow: two apples. NOT bedtime. Walking home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. The more you give away, the more comes back — but never in the same shape. Echo the one red apple. Warm, shared, multiplied.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'sorry_story',
    name: 'The Sorry Story',
    synopsis: 'A misunderstanding with a friend — the child said something thoughtless, or bumped without looking. The whole day is the journey to say sorry and mean it, and find that forgiveness was waiting.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'THE_MISTAKE',      description: `It happens fast — ${n} says something without thinking, or knocks something over, or turns away at the wrong moment. A friend's face crumples. The damage is done. Outdoors.`, wordTarget: wt },
        { spread: 2,  beat: 'FRIEND_LEAVES',    description: `The friend — a creature with soft eyes — turns and walks away. Not angry, just hurt. The silence left behind is the loudest sound ${n} has ever heard. Outdoors.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'ALONE',             description: `${n} stands alone. The world feels wrong — colors dimmer, sounds hollow. The spot where the friend stood is just empty grass now. Outdoors.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'TRYING_TO_FORGET',  description: `${n} tries to play, to distract, to pretend it doesn't matter. But the feeling follows — a heaviness in the chest, a knot that won't untie. Various spots.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'UNDERSTANDING',     description: `Sitting on a rock, ${n} finally thinks about it — really thinks. What it felt like from the friend's side. The realization stings but it's important. A quiet spot.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'DECIDING',          description: `${n} stands up. The word "sorry" forms — not easy, not simple, but necessary. ${n} knows where the friend goes when hurt. Time to go there. Walking.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'FINDING_THE_FRIEND',description: `The friend is in their quiet spot — curled up, still sad. ${n} approaches slowly, heart hammering. The hardest walk of the day. Friend's quiet spot.`, wordTarget: wt },
        { spread: 8,  beat: 'SAYING_SORRY',      description: `${n} sits down beside the friend. "I'm sorry." Two words, said quietly, said truly. Not "sorry but" — just sorry. The friend listens. Friend's spot.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'THE_PAUSE',         description: `A long pause. The friend looks at ${n}. Searching for truth in the eyes. Finding it. A slow nod. The space between them gets smaller. Friend's spot.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'FORGIVENESS',       description: `The friend leans against ${n}. Not words, just warmth. Forgiveness isn't a sentence — it's a leaning-in. The knot in ${n}'s chest unties. Friend's spot.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'TOGETHER_AGAIN',    description: `They walk home together, a little quieter than before, a little closer. The crack in the friendship has healed into something stronger. Walking home.`, wordTarget: wt },
        { spread: 12, beat: 'HOME_LIGHTER',      description: `At home, ${n} feels lighter than morning. Saying sorry was the hardest thing and the best thing. NOT bedtime. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. Sorry is a small word that holds a very big love inside it. Echo the moment of the mistake. Warm, mended, stronger.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'friendship_bracelet',
    name: 'The Friendship Bracelet',
    synopsis: 'Making friendship bracelets — each bead represents a shared memory. As the child strings each one, the day\'s adventures replay: the time they laughed, explored, got scared, were brave together.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'BEADS_FOUND',      description: `${n} finds a jar of colorful beads and a piece of string. An idea sparks: a bracelet for a friend. But not just any bracelet — each bead will mean something. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'YELLOW_BEAD',       description: `The yellow bead — for the sunny day ${n} and the friend first met. A meadow, a wave, a shy hello. The memory glows as ${n} threads it on. At home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'BLUE_BEAD',         description: `The blue bead — for the rainy afternoon they spent in a puddle, soaked and laughing. Mud on knees, joy on faces. ${n} smiles, threading. At home.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'GREEN_BEAD',        description: `The green bead — for the time they explored the woods together, discovering a clearing full of mushrooms. An adventure in miniature. At home.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'RED_BEAD',          description: `The red bead — for the argument. They fought, turned away, felt the empty space. Even hard memories are part of the story. ${n} threads it carefully. At home.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'PURPLE_BEAD',       description: `The purple bead — for when they made up. The apology, the forgiveness, the hug that said "I'm glad you're still here." The bracelet is growing. At home.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'WHITE_BEAD',        description: `The white bead — for the quiet times. Sitting together saying nothing, needing nothing. The most peaceful memory of all. ${n} holds it before threading. At home.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'ORANGE_BEAD',       description: `The orange bead — for the time they were scared together. A loud noise, a dark shadow. But being scared with a friend is half as scary. At home.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'SPARKLY_BEAD',      description: `The sparkly bead — for today, because today ${n} is making something that holds everything they are together. The present moment joins the past. At home.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'TYING_OFF',         description: `${n} ties the knot. The bracelet is done — a circle of colored memories, each one a chapter in a friendship still being written. At home.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'GOING_TO_GIVE',     description: `${n} runs outside, bracelet in pocket, to find the friend. Heart racing — what if they don't like it? What if it's silly? Running. On the way.`, wordTarget: wt },
        { spread: 12, beat: 'GIVING_IT',         description: `${n} holds out the bracelet. The friend's eyes go wide. "You made this?" A wrist offered. ${n} ties it on. Two matching smiles. NOT bedtime. Outdoors.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. Every bead on a friendship bracelet is a day you're glad happened. Echo the jar of beads. Warm, strung, unbreakable.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'mirror_friend',
    name: 'The Mirror Friend',
    synopsis: 'The child\'s reflection steps out of the mirror — same face, same clothes, but with different ideas. They spend the day disagreeing, then discovering that the best ideas come from two versions of you.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'REFLECTION_MOVES',  description: `${n} is brushing teeth when the reflection winks — on its own. Then it waves. Then it steps right out of the mirror and stands on the bathroom tile. Bathroom.`, wordTarget: wt },
        { spread: 2,  beat: 'MEETING_YOURSELF',  description: `${n} stares. The mirror-friend stares back. Same face, same pajamas, same messy hair. But the mirror-friend's eyes have a spark of mischief. "Let's go." Bathroom.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_DISAGREEMENT', description: `Breakfast: ${n} wants cereal. Mirror-friend wants toast. "But I'm you!" "No — I'm the you who does things differently." The first clash. Kitchen.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'DIFFERENT_PLAY',    description: `Outside: ${n} heads left, mirror-friend heads right. ${n} climbs a tree, mirror-friend digs a hole. Both watch each other with confused curiosity. Garden.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'COMPETING',         description: `They race. They argue about who's faster. They both try to tell the same joke and talk over each other. Being friends with yourself is harder than it looks. Garden.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'THE_SURPRISE',      description: `The mirror-friend does something ${n} would never do — talks to a stranger, jumps from higher, sings out loud. ${n} watches, amazed. "I could do that?" Outdoors.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'LEARNING',          description: `${n} shows the mirror-friend something too — patience, careful looking, quiet noticing. They teach each other the parts of themselves they didn't know. Outdoors.`, wordTarget: wt + 2 },
        { spread: 8,  beat: 'WORKING_TOGETHER',  description: `A problem neither can solve alone. Two heads — even if they're the same head — are better than one. They combine ideas and crack it. Outdoors.`, wordTarget: wt },
        { spread: 9,  beat: 'MIRROR_MOMENT',     description: `Sitting face to face, identical and different. The mirror-friend says: "You're braver than you think." ${n} says: "You're kinder than you know." Outdoors.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'SUN_SETS',          description: `The mirror-friend starts to shimmer as the light changes. It's fading, returning to the mirror. One last game, one last laugh, one last matching grin. Outdoors.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'BACK_TO_MIRROR',    description: `Inside, the mirror-friend steps back into the mirror and becomes a reflection again. But it winks once more — as if to say: "I'm always in here." Bathroom.`, wordTarget: wt },
        { spread: 12, beat: 'LOOKING_IN',        description: `${n} looks in the mirror. Same face. But somehow, after today, the face looks a little braver, a little more interesting. NOT bedtime. Bathroom.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. The friend you've had all along was always looking back at you. Echo the first wink. Warm, mirrored, complete.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
];
