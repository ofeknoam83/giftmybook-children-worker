/**
 * Fantasy plot templates — 12 structurally distinct story arcs.
 *
 * Each template returns 13 spreads in 4-scene (A/B/C/D) grouping.
 * opts: { child, isYoung, wt, parentName, book, theme }
 */

module.exports = [
  {
    id: 'classic_fantasy',
    name: 'Classic Fantasy Quest',
    synopsis: 'A shimmer past the wardrobe reveals a magical world. The child explores, faces a challenge with cleverness, and returns home with a gift from the realm.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'HOOK',            description: `${n} discovers something that calls them toward a world that shimmers just past the wardrobe. Vivid, sensory, immediate. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'DISCOVERY',       description: `The new world opens up. Colors, sounds, textures. Wonder fills the scene. The threshold crossing into a fantasy realm.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'RISING_1',        description: `${n} ventures deeper. A companion or guide may appear. Use child's interests. Same fantasy world.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'RISING_2',        description: `A second discovery, stranger and more wonderful. The world reveals its rules. Same fantasy world.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'DEEP_EXPLORE',    description: `The heart of the fantasy world. ${n} is fully immersed, confident, curious. Same location.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'CHALLENGE',       description: `Something goes wrong or gets tricky. A puzzle, a blockage, a moment of doubt. Same fantasy world.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'CLEVERNESS',      description: `${n} uses something they know, something from home, to solve it. Resourcefulness. Same location.`, wordTarget: wt + 2 },
        { spread: 8,  beat: 'TRIUMPH',         description: `The problem is solved. Joy, relief, pride. The fantasy world responds, celebrates. Same world.`, wordTarget: wt },
        { spread: 9,  beat: 'WONDER',          description: `A quiet beat of pure wonder. The most beautiful image in the book. Fewest words. Still in the fantasy world.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'GIFT',            description: `The world gives ${n} something to carry home — a token, a memory. The farewell.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'HOMECOMING',      description: `Returning home. The familiar world looks a little different now.`, wordTarget: wt },
        { spread: 12, beat: 'REFLECTION',      description: `Safe at home, but changed. The adventure lives inside. Echo of the opening.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. A whisper of the fantasy world still waiting. Echo the opening image.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'invisible_crown',
    name: 'The Invisible Crown',
    synopsis: 'The child discovers an invisible crown that only animals and magical creatures can see — and they all start bowing, following, and serving the "hidden ruler."',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'STRANGE_MORNING',  description: `${n} wakes up feeling normal, but the cat bows when ${n} walks past. The bird on the fence dips its head. Something is different. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'MORE_BOWING',      description: `Outside, a squirrel curtsies. A dog sits at attention. A butterfly circles ${n}'s head like a tiny attendant. The animals know something. Yard.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'DISCOVERY',        description: `${n} catches a reflection in a puddle — a shimmering, invisible crown floating above. Only magical eyes can see it. By a puddle.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'ROYAL_PROCESSION', description: `Animals fall in line behind ${n} — a parade of creatures forming a royal court. Birds fly in formation overhead. The neighborhood path.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'SUBJECTS',         description: `Magical creatures emerge — a hedgehog carrying a tiny scroll, a toad with a miniature trumpet, a fox dragging a velvet cape. The park.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'ROYAL_DUTY',       description: `A dispute among the animals! Two squirrels arguing over a nut, a bird upset about a nest. The ruler must settle it. ${n} judges wisely. The park.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'QUIET_THRONE',     description: `${n} sits on a mossy stump — the nature throne. The court gathers silently. A moment of peace and power. Fewest words. Forest clearing.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'ROYAL_FEAST',      description: `The animals bring gifts — berries, flowers, shiny stones. A feast fit for a hidden ruler. Maximum richness and color. Forest clearing.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'WISE_DECREE',      description: `${n} makes a final decree: "Be kind to each other." Simple and powerful. The animals cheer in their animal ways. Forest clearing.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'CROWN_FADES',      description: `The invisible crown begins to shimmer and dissolve. The animals still watch with respect, but the magic is passing. Clearing.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'FAREWELL_COURT',   description: `One by one, the animals and creatures bow a final time and return to their lives. The toad trumpets a farewell. Heading home.`, wordTarget: wt },
        { spread: 12, beat: 'CROWN_GONE',       description: `At home, no crown in any reflection. But the cat still bows, just slightly, when ${n} walks past. At home. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',          description: `The last line. Some crowns are invisible because they're earned, not worn. Echo the first bow. Warm, regal, gentle.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'toy_kingdom',
    name: 'The Toy Kingdom',
    synopsis: 'At midnight, the child\'s toys come alive and need help — the teddy bear\'s button eye is lost, the doll\'s hat blew away. The child embarks on a mission to fix everything.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'TOYS_WAKE',       description: `A sound in the dark — ${n}'s toys are moving! The teddy waves, the blocks stack themselves, the doll curtsies. Toy kingdom comes alive. Bedroom.`, wordTarget: wt },
        { spread: 2,  beat: 'TROUBLE',         description: `But something is wrong: Teddy's button eye is missing, the toy car has a broken wheel, the puzzle is missing a piece. The toys need help. Bedroom.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'MISSION_ACCEPTED', description: `${n} agrees to help. The toys cheer in tiny voices. First mission: find Teddy's button eye. It rolled under something. Bedroom floor.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'UNDER_THE_BED',   description: `The space under the bed is a vast, dusty kingdom. Lost toys, forgotten socks, dust bunnies that sneeze. The button glints in the back. Under the bed.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'BUTTON_FOUND',    description: `${n} retrieves the button and sews it back on (with help from a helpful toy). Teddy hugs ${n} with stuffed arms. Bedroom.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'NEXT_MISSION',    description: `The toy car's wheel — found in the toy box under a pile. Fixed with tape and teamwork. The car zooms triumphantly. Bedroom.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'PUZZLE_PIECE',    description: `The puzzle piece is the trickiest — it's on the bookshelf, behind the tallest book. A tower of toys helps ${n} reach it. Teamwork. Bedroom.`, wordTarget: wt },
        { spread: 8,  beat: 'ALL_FIXED',       description: `Every toy is whole again. The kingdom celebrates — building block fireworks, toy car parades, stuffed animal dancing. Maximum toy joy. Bedroom.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'TOY_FEAST',       description: `A tiny feast from the play kitchen — pretend cookies, invisible tea. ${n} sits at the small table with toy friends. Fewest words, most warmth.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'THANK_YOU',       description: `The teddy gives ${n} a tiny toy crown. The toys sing a wobbly song of thanks. ${n} is their hero. Bedroom.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'TOYS_SETTLE',     description: `One by one, the toys return to their spots. The car parks. The blocks stack. Teddy finds his place. The kingdom sleeps. Bedroom.`, wordTarget: wt },
        { spread: 12, beat: 'MORNING_PROOF',   description: `${n} in the morning light — was it real? But Teddy's button is on tight, the car rolls perfectly, and a tiny crown sits on the pillow. NOT bedtime. Bedroom.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. Take care of your toys and they'll take care of you. Echo the first movement in the dark. Warm, tiny, beloved.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'painting_world',
    name: 'The Painting World',
    synopsis: 'The child steps into a painting on the wall and finds a living watercolor world — everything is painted, the rivers are brushstrokes, and the child can add to the scene.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'THE_PAINTING',    description: `A painting on the wall starts to glow. ${n} touches it — the hand goes through! The painted world is real and warm. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'STEPPING_IN',     description: `${n} steps fully into the painting. Everything is watercolor — soft edges, flowing colors, the sky painted with visible brushstrokes. Painting world.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'PAINTED_RIVER',   description: `A river of blue brushstrokes flows by. ${n} dips a toe — it's cool and wet but made of paint. Fish are quick brushstrokes swimming. Painting world.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'PAINTED_FOREST',  description: `A forest of green daubs. Trees sway like someone is still painting them. Birds are splashes of red and yellow. Moving through them. Painting world.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'ADDING_TO_IT',    description: `${n} discovers a paintbrush in the grass. Paints a flower — it grows! A butterfly — it flies! ${n} can add to this world. Painting world.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'CREATION',        description: `${n} paints something connected to their interests — it appears in the painting world, alive and colorful. The best creation yet. Painting world.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'UNFINISHED_SPOT', description: `A blank white spot — unpainted. Empty and bare. ${n} considers what to put here. The most important choice. Fewest words. Painting world.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'MASTERPIECE',     description: `${n} paints the blank spot into something beautiful and personal. The whole painting world responds — colors brighten, everything glows. Maximum beauty. Painting world.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'RUNNING_THROUGH', description: `${n} runs through the world, leaving color footprints. Everything touched by ${n} becomes more vivid. Joy and movement. Painting world.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'EDGES_GLOW',      description: `The frame of the painting appears — the edges of the world. Time to go back. ${n} takes a last look at this beautiful place. Painting world edge.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'STEPPING_OUT',    description: `${n} steps back through the frame into the house. Paint-stained fingers, color on one cheek. The painting on the wall now includes ${n}'s additions. At home.`, wordTarget: wt },
        { spread: 12, beat: 'NEW_PAINTING',    description: `${n} looks at the painting — there, in the corner, a tiny painted figure of ${n} still walking through the world. It waves. At home. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. Every painting is a door if you look closely enough. Echo the first glow. Warm, colorful, alive.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'cloud_castle',
    name: 'The Cloud Castle',
    synopsis: 'The child climbs a vine to a castle in the clouds — not a giant\'s castle, but one made entirely for children, with pillow rooms and cookie kitchens.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'VINE_FOUND',      description: `A thick, sparkling vine growing from the garden reaches up past the clouds. ${n} grabs hold and starts climbing. Garden.`, wordTarget: wt },
        { spread: 2,  beat: 'CLIMBING',        description: `Up through the clouds — the air gets softer, the light gets warmer. ${n}'s hands grip the vine. Above the clouds, a shape appears. Climbing.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'CASTLE_APPEARS',  description: `A castle made of clouds! But child-sized — low doors, round windows, soft fluffy walls. ${n} steps off the vine onto a cloudy drawbridge. Cloud castle.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'PILLOW_ROOM',     description: `The first room: pillows everywhere. Bouncing, diving, sinking. The softest place in the world. ${n} jumps and floats. Cloud castle.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'COOKIE_KITCHEN',  description: `A kitchen where everything is edible — cookie walls, juice fountains, fruit that grows on the ceiling. ${n} tastes everything. Cloud castle.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'GAME_ROOM',       description: `A room filled with the best games and toys — use child's interests. Everything ${n} would dream of. Maximum fun. Cloud castle.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'QUIET_TOWER',     description: `A tower with a window overlooking everything below — the world is small and beautiful from up here. ${n} sits in the window. Fewest words. Cloud castle tower.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'THRONE_ROOM',     description: `A throne room where ${n} sits on a cloud throne. The castle seems to respond to wishes — walls change color, music plays. Cloud castle.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'CLOUD_GARDEN',    description: `Outside the castle: a garden where flowers are made of rainbows and butterflies are made of mist. ${n} plants a cloud seed. Cloud garden.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'RAIN_BELOW',      description: `The cloud darkens slightly — it's raining below! ${n} looks through the floor of the cloud and sees the rain falling on home. Connected to earth. Cloud castle.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'SLIDING_DOWN',    description: `Time to go home. ${n} slides down a rainbow that arcs from the castle to the ground. The most thrilling ride. Sliding down.`, wordTarget: wt },
        { spread: 12, beat: 'SOFT_LANDING',    description: `Landing on the wet grass. Looking up — the castle is just a cloud now. But ${n}'s pockets are full of cookie crumbs. NOT bedtime. Garden.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. The fluffiest castles are always overhead. Echo the vine discovery. Warm, soft, sky-high.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'shadow_friend',
    name: 'The Shadow Friend',
    synopsis: 'The child\'s shadow comes alive and has its own ideas — it dances when the child walks, builds when the child sits, and leads the child on a shadow-world adventure.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'SHADOW_WAKES',    description: `${n}'s shadow does something unexpected — waves when ${n} stands still. Then stretches, yawns, and winks. The shadow is alive. Sunny spot at home.`, wordTarget: wt },
        { spread: 2,  beat: 'SHADOW_PLAYS',    description: `The shadow starts doing its own thing — making bunny ears, doing cartwheels, building shadow towers. ${n} watches, delighted. Sunny yard.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FOLLOWING',       description: `${n} copies the shadow's moves. Then the shadow copies ${n}. A game of mirror, leader, follow. Laughter and silliness. Sunny yard.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'SHADOW_LEADS',    description: `The shadow beckons — follow me! It stretches toward the fence, through the gate, along the path. ${n} follows. Leaving the yard.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'SHADOW_WORLD',    description: `The shadow leads to a place where shadows are thick — under big trees, by a wall. Here, shadows of other things are alive too. Shadow-rich area.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'SHADOW_FRIENDS',  description: `Shadow animals play with ${n}'s shadow — a shadow dog, a shadow bird, a shadow cat. They chase and tumble. Shadow community. Same area.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'SHADOW_GIFT',     description: `${n}'s shadow makes something — a shadow flower, a shadow crown — and offers it to ${n}. It can't be held, but it's beautiful. Fewest words.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'SHADOW_DANCE',    description: `A shadow dance party! All the shadows dance, and ${n} dances with them. The most joyful, physical spread. Maximum energy. Shadow area.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'CLOUD_COMES',     description: `A cloud covers the sun. All shadows vanish. ${n} is alone. A moment of stillness. Where did everyone go? Same area, now grey.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'SUN_RETURNS',     description: `The cloud passes. The sun returns. Every shadow springs back to life. ${n}'s shadow waves hello again. Relief and joy. Same area.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'WALKING_HOME',    description: `${n} and the shadow walk home together — side by side, step by step. Two friends heading the same direction. Heading home.`, wordTarget: wt },
        { spread: 12, beat: 'HOME_TOGETHER',   description: `At the doorstep, ${n}'s shadow does one last wave before becoming normal again. But ${n} knows — it's still in there, ready to play. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. Your shadow is the friend who never leaves your side. Echo the first wink. Warm, bright, inseparable.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'wishing_well',
    name: 'The Wishing Well',
    synopsis: 'The child discovers a well in the garden that grants wishes — but each wish comes true in unexpected, delightful ways that are better than what was imagined.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'WELL_FOUND',      description: `${n} finds a small stone well in the garden that wasn't there before. It glows faintly. A coin appears on the edge. Garden.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_WISH',      description: `${n} tosses the coin in and wishes for something sweet. Instead of candy, a bush sprouts honey-berries. Different but even better! Garden.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SECOND_WISH',     description: `Another coin appears. ${n} wishes for a friend to play with. A clever fox cub walks out from behind the well. Garden.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'PLAYING',         description: `${n} and the fox play together — chasing, hiding, rolling in the grass. The wish came true sideways but perfectly. Garden.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'THIRD_WISH',      description: `Another coin. ${n} wishes for something connected to their interests. It arrives in the most creative, unexpected form. Garden.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'PATTERN',         description: `${n} realizes: the well doesn't give what you ask for — it gives what you need, wrapped in a surprise. The magic has its own wisdom. Garden.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'BEST_WISH',       description: `The biggest wish yet. ${n} thinks carefully, then whispers it. The well glows brighter than before. A moment of suspense. Fewest words. Garden.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'SURPRISE_RESULT', description: `The wish comes true in the most wonderful unexpected way — something ${n} never would have thought to ask for. Maximum delight. Garden.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'LAST_COIN',       description: `One final coin appears. ${n} holds it, thinking. What's the perfect last wish? The fox cub watches. The garden waits. Garden.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'SELFLESS_WISH',   description: `${n} wishes for something for someone else — or for the well itself, or for the fox. The most generous wish. The well blazes with light. Garden.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'WELL_THANKS',     description: `The well sends up a shower of golden sparks. The fox nuzzles ${n}'s hand. The garden has never been more beautiful. Garden.`, wordTarget: wt },
        { spread: 12, beat: 'WELL_SLEEPS',     description: `The glow fades. The well looks like an ordinary stone circle again. But the berries, the fox prints, the magic — all still here. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. The best wishes are the ones that surprise you. Echo the first coin. Warm, golden, generous.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'flying_carpet',
    name: 'The Flying Carpet',
    synopsis: 'A rug in the living room lifts off the floor — the child climbs on and soars over rooftops, meadows, and mountains, seeing the world from a magical height.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'CARPET_RISES',    description: `The old rug in the living room ripples, then lifts off the floor. It hovers, waiting. ${n} steps on. Living room.`, wordTarget: wt },
        { spread: 2,  beat: 'LIFT_OFF',        description: `The carpet floats out the window and up — gently, smoothly. ${n} holds the tassels. The house shrinks below. Into the air.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'OVER_ROOFTOPS',   description: `Gliding over the neighborhood. ${n} can see everyone's backyard, the school from above, the park like a green stamp. Over the town.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'OVER_MEADOWS',    description: `The carpet soars over open meadows. Flowers are dots of color, rivers are silver ribbons. ${n} reaches down to touch a treetop. Over countryside.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'OVER_MOUNTAINS',  description: `Snow-capped mountains rise up. The carpet weaves between peaks. Cold air, bright sun, the world spread below like a map. Mountain heights.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'CLOUD_DIVE',      description: `The carpet dives through a cloud — cool, wet, can't see a thing. Then bursts out the other side into golden sunlight. Thrilling! Through clouds.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'STILL_AIR',       description: `The carpet stops, hovering in midair. Complete silence. ${n} and the sky, nothing else. The most peaceful moment. Fewest words. High sky.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'LOOP_DE_LOOP',    description: `The carpet does a loop! ${n} whoops, holds tight, upside down for one wild second. The most exciting, physical moment. Maximum joy. Sky.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'SUNSET_RIDE',     description: `Flying toward the sunset. The sky is painted orange and pink. The carpet's edges glow gold. The most beautiful view in the book. Sky.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'HEADING_HOME',    description: `The carpet banks and turns toward home. ${n} recognizes the landmarks getting closer — the water tower, the school, the big tree. Returning.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'LANDING',         description: `Gently, gently, the carpet floats back through the window and settles on the living room floor. Perfect landing. Living room.`, wordTarget: wt },
        { spread: 12, beat: 'JUST_A_RUG',      description: `${n} steps off. The rug lies flat, ordinary. But there's a cloud puff caught in its fringe and wind in ${n}'s hair. NOT bedtime. Living room.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. Home looks different when you've seen it from the sky. Echo the first ripple. Warm, wind-touched, free.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'enchanted_garden',
    name: 'The Enchanted Garden',
    synopsis: 'Behind a hidden gate, the child discovers a garden where everything is alive — the flowers whisper, the trees tell stories, and the pond shows visions.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'HIDDEN_GATE',     description: `${n} pushes through overgrown ivy and finds a small gate, half-hidden. It swings open with a sigh. Behind it: a garden like no other. Garden entrance.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_WHISPER',   description: `The flowers whisper. Not wind — actual voices. "Welcome, welcome." They lean toward ${n}, colors brightening. The enchanted garden.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'TALKING_TREE',    description: `A gnarled old tree speaks in a slow, deep voice. It tells ${n} the garden has been waiting for a visitor. It knows ${n}'s name. The garden.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'EXPLORING',       description: `Deeper into the garden. Mushrooms that glow, a path made of smooth warm stones, butterflies that leave trails of sparkle. The garden.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'POND_VISION',     description: `A still pond that shows not reflections but visions — something from ${n}'s interests or memories. ${n} kneels, watching. The garden pond.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'GARDEN_TASK',     description: `The garden needs help — a flower is wilting, a path is blocked, a fountain has stopped. ${n} knows what to do. Working in the garden.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'FIXING',          description: `${n} tends the garden — waters the flower, clears the path, unblocks the fountain. The garden hums gratitude. Fewest words. Same spot.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'GARDEN_BLOOMS',   description: `The whole garden explodes into full bloom — colors, scents, sounds, light. ${n}'s care made it flourish. Maximum beauty and wonder. The garden.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'GARDEN_PLAY',     description: `Playing in the enchanted garden — swinging from a vine, chasing a glowing beetle, making flower crowns. Joy in a magical place. The garden.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'GARDEN_GIFT',     description: `The garden offers a gift — a seed that glows, a flower that never wilts, a smooth stone from the pond. Something to take home. The garden.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'GATE_GOODBYE',    description: `At the gate, the flowers wave, the tree bows. "Come back anytime." ${n} steps through, looking back once. The gate.`, wordTarget: wt },
        { spread: 12, beat: 'PLANTING',        description: `At home, ${n} plants the glowing seed in the yard. A tiny sprout appears immediately. The enchanted garden is spreading. NOT bedtime. Home garden.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. Gardens grow where someone cares enough to look. Echo the hidden gate. Warm, blooming, alive.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'dragon_egg',
    name: 'The Dragon Egg',
    synopsis: 'The child finds a warm, spotted egg in the garden. It hatches into a tiny, friendly dragon that follows the child around, learning the world together.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'EGG_FOUND',       description: `${n} finds a large, warm, speckled egg in the garden — too big for a bird, too warm for a stone. It wobbles. Garden.`, wordTarget: wt },
        { spread: 2,  beat: 'NURTURING',       description: `${n} wraps the egg in a blanket, carries it inside, keeps it warm near the window. Checking on it constantly. At home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'HATCHING',        description: `A CRACK! Then another. A tiny snout pokes through. A baby dragon blinks up at ${n}. It's the size of a kitten and warm to touch. At home.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'FIRST_STEPS',     description: `The baby dragon stumbles around — knocking things over, sneezing tiny sparks, chasing its own tail. ${n} laughs and guides it. At home.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'FEEDING',         description: `What does a baby dragon eat? ${n} tries everything — it likes warm things, spicy things, cinnamon toast. It purrs when it eats. Kitchen.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'PLAYING_OUTSIDE', description: `${n} takes the dragon to the garden. It discovers grass, chases a butterfly, tries to fly (can't yet — too small). Pure play. Garden.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'FIRST_FLIGHT',    description: `The dragon flaps hard and lifts off — just for a second, just an inch. But it flew! ${n} cheers. The dragon beams. Fewest words, most pride. Garden.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'SHOWING_OFF',     description: `The dragon gets bolder — longer flights, tiny fire-burps (just warm air), a somersault. ${n} claps for every trick. Maximum joy. Garden.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'NESTING',         description: `The dragon curls up in ${n}'s lap. Warm, heavy, trusting. The bond between them is strong. A tender, quiet moment. Garden or home.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'GROWING',         description: `${n} notices the dragon is bigger than yesterday. It's growing fast. Soon it won't fit in the house. A bittersweet realization. At home.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'LETTING_GO',      description: `The dragon looks toward the sky — it knows where it belongs. ${n} opens both arms. The dragon nuzzles once, then rises. Garden.`, wordTarget: wt },
        { spread: 12, beat: 'FLYING_AWAY',     description: `The dragon circles once overhead, breathes one warm puff down at ${n}, then flies toward the mountains. ${n} waves until it's a speck. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. Some friends only stay a little while, but the warmth they leave lasts forever. Echo the egg discovery. Warm, brave, free.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'magic_book',
    name: 'The Magic Book',
    synopsis: 'The child opens a blank book and whatever is written or drawn in it becomes real — a drawn cat meows, a written word "sunshine" makes the room glow.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'BLANK_BOOK',      description: `${n} finds a beautiful book with blank pages. A note inside: "What you write comes true." A crayon sits beside it. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_WORD',      description: `${n} writes "SUN" and the room fills with golden light. It works! The word glows on the page. At home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_DRAWING',   description: `${n} draws a cat. It peels off the page and meows! A real, purring, crayon-colored cat. It rubs against ${n}'s legs. At home.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'BIGGER_CREATIONS', description: `Getting bolder: "FLOWERS" fills the room with blooms. A drawn bird flies around the ceiling. ${n} is a creator. At home.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'PLAYGROUND',      description: `${n} writes "PLAYGROUND" and the living room transforms — a slide appears, a swing hangs from nothing. Use child's interests. At home, transformed.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'OOPS',            description: `An accidental scribble becomes something silly — a wobbly creature, a backwards rainstorm, a purple puddle on the ceiling. Funny chaos. At home.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'FIXING',          description: `${n} learns to erase too — cross out the chaos, calm the scribble-creature. The power includes undo. Same room.`, wordTarget: wt },
        { spread: 8,  beat: 'BEST_CREATION',   description: `${n} draws or writes the best thing yet — something deeply personal and beautiful. It fills the room with wonder. Maximum magic. At home.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'QUIET_PAGE',      description: `${n} turns to a new page and writes one quiet word — "LOVE" or "HOME" or "SAFE." Nothing visible happens, but everything feels warmer. Fewest words.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'LAST_PAGE',       description: `Only one blank page left. ${n} thinks carefully about what to create. The most important thing. Same room.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'FINAL_CREATION',  description: `${n} writes or draws something for tomorrow — a seed, a sunrise, a promise. The page glows, then the book gently closes itself. At home.`, wordTarget: wt },
        { spread: 12, beat: 'BOOK_RESTS',      description: `The book sits on the shelf, glowing faintly. The crayon cat purrs on the windowsill. The creations are still here. NOT bedtime. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',         description: `The last line. Words become real when you write them with your heart. Echo the blank book. Warm, created, alive.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
];
