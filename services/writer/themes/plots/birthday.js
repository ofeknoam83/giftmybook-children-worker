/**
 * Birthday plot templates — 12 structurally distinct story arcs.
 *
 * Each template returns 13 spreads in 4-scene (A/B/C/D) grouping.
 * opts: { child, isYoung, wt, parentName, book, theme }
 */

module.exports = [
  {
    id: 'classic_party',
    name: 'Classic Party',
    synopsis: 'The morning buzzes with excitement, preparations build toward the party, the big cake-and-wish moment lands, and the afterglow lingers.',
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
        { spread: 12, beat: 'GLOW',          description: `${n} at home, still buzzing from the day. A favorite gift examined, a balloon still floating, frosting on a finger. NOT bedtime, NOT sleepy.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',       description: `The last line. A wish fulfilled, or a secret smile. Echo the morning. Warm, bright, joyful. NOT a goodnight, NOT asleep.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'surprise_party',
    name: 'The Surprise Party',
    synopsis: 'Everyone is acting strange today — whispers, closed doors, secret smiles. The child follows the clues until the big reveal: a surprise party just for them.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'ORDINARY_START',    description: `${n} wakes up thinking it is a regular day. Morning routine, nothing special. But something feels off.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_CLUE',        description: `A door closes too fast. A whisper dies when ${n} walks in. The first hint that something is up. At home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SECOND_CLUE',       description: `Another oddity — a hidden bag, a ribbon peeking from behind a cushion, a parent's phone face-down. ${n} grows curious. Still at home.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'SENT_AWAY',         description: `${n} is sent on an errand or outing. "Go play outside" or "Let's visit the park." The distraction begins. Leaving home.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'WONDERING',         description: `While out, ${n} keeps thinking about the clues. What could it be? Imagination runs wild. At the outing location.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'MORE_CLUES',        description: `Even here, clues appear — a familiar car parked nearby, balloons in a shop window, a friend who waves and disappears. Same outing location.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'HEADING_BACK',      description: `Time to go home. ${n} walks back, heart thumping with anticipation. The house looks dark and quiet.`, wordTarget: wt },
        { spread: 8,  beat: 'THE_REVEAL',        description: `The door opens — SURPRISE! Decorations, faces, cheering. The most explosive, joyful spread. Maximum energy.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'OVERWHELM_JOY',     description: `${n} takes it all in — the cake, the streamers, the people who kept the secret. Pure happiness. Same party space.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'PARTY_PEAK',        description: `The best part of the party — games, laughter, dancing, the cake moment. Use child's interests. Same location.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'QUIET_GLOW',        description: `A tender moment amid the party. ${n} realizes everyone planned this out of love. The emotional peak. Same location.`, wordTarget: wt },
        { spread: 12, beat: 'CELEBRATION_FADES',  description: `The party winds down but the glow remains. ${n} holds a party favor, a balloon, a memory. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. The best surprises are the ones made with love. Echo the quiet morning. Warm, bright, joyful.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'birthday_quest',
    name: 'The Birthday Quest',
    synopsis: 'A treasure map appears on the doorstep. Each clue leads to a new spot and a small birthday surprise, building toward the final treasure.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'MAP_ARRIVES',       description: `${n} finds a mysterious rolled-up map on the doorstep, tied with a ribbon. Birthday morning, excitement. At the front door.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_CLUE',        description: `The map shows the first stop — somewhere familiar (mailbox, garden gate, big tree). ${n} runs to find the clue. Near home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_TREASURE',    description: `A small surprise at the first stop — a favorite treat, a tiny toy, a note with a riddle pointing to the next place. Near home.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'SECOND_STOP',       description: `The riddle leads further — a neighbor's fence, the park bench, the funny-shaped rock. ${n} is getting the hang of treasure hunting. New location.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'SECOND_TREASURE',   description: `Another surprise and another clue. This one is trickier — ${n} has to think. Use child's interests in the clue. Same second location.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'THIRD_STOP',        description: `The trail leads to the most unexpected place. ${n} is deep into the quest, fully focused and determined. New location.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'TRICKY_MOMENT',     description: `A clue that stumps ${n} for a moment. Looking around, thinking hard. Then the aha! moment. Same third location.`, wordTarget: wt },
        { spread: 8,  beat: 'FINAL_CLUE',        description: `The last clue points back toward home. ${n} races back, treasures in hand, heart pounding with excitement.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'BIG_TREASURE',      description: `The final treasure — something wonderful waiting at home. The culmination of the whole quest. Maximum joy. At home.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'CELEBRATING',       description: `${n} surrounded by all the little treasures from the quest, plus the big one. A moment of pure birthday happiness. At home.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'MAP_MEMORY',        description: `${n} traces a finger along the map, remembering each stop. The journey was the real treasure. At home.`, wordTarget: wt },
        { spread: 12, beat: 'KEEPER',            description: `The map gets folded carefully and kept somewhere special. ${n} already imagining next year's quest. At home, NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. The best birthdays are the ones you earn, one clue at a time. Echo the doorstep discovery. Warm, joyful.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'birthday_baker',
    name: 'The Birthday Baker',
    synopsis: 'The child decides to bake their own birthday cake. Flour flies, eggs crack, frosting gets everywhere — but the lopsided result is the best cake ever.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'BIG_IDEA',         description: `${n} announces the plan: "I'm baking my OWN cake this year." Determination in a small body. Kitchen at home.`, wordTarget: wt },
        { spread: 2,  beat: 'GATHERING',         description: `Pulling out bowls, spoons, ingredients. Everything is too high, too heavy, too slippery. But ${n} is undaunted. Kitchen.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'MEASURING',         description: `Flour measured with great seriousness (and great inaccuracy). Sugar spills. An egg cracks on the counter. Kitchen, same scene.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'MIXING_CHAOS',      description: `The mixer goes too fast. Batter splatters on the ceiling. ${n} is covered in flour but grinning. Pure physical comedy. Kitchen.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'INTO_THE_OVEN',     description: `The lumpy batter goes into the oven. ${n} watches through the glass, face pressed close, waiting. Kitchen.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'WAITING',           description: `The hardest part — waiting. ${n} tries to be patient. The kitchen smells like magic. Time crawls. Kitchen.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'ITS_READY',         description: `The timer dings. The cake comes out — lopsided, cracked, imperfect. ${n} stares. A beat of uncertainty.`, wordTarget: wt },
        { spread: 8,  beat: 'FROSTING_TIME',     description: `Frosting covers everything — the cake, the counter, ${n}'s nose. Sprinkles go on in wild handfuls. Maximum mess, maximum joy.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'MASTERPIECE',       description: `The finished cake: gloriously lopsided, wildly decorated, utterly unique. ${n} steps back to admire it. Pride. Kitchen.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'CANDLES_LIT',       description: `Candles stuck at angles, flames flickering. Faces glow. The homemade cake is more beautiful than any store cake.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'THE_WISH',          description: `Eyes closed, a wish forming. The quietest moment. Then the blow — candles out, cheering. Kitchen.`, wordTarget: wt },
        { spread: 12, beat: 'FIRST_BITE',        description: `Everyone takes a bite. It's a little crunchy, a little lopsided — and absolutely delicious. Laughter and crumbs. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. The best cakes are the ones made with your own hands. Echo the first spread's determination. Warm, flour-dusted, joyful.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'runaway_balloon',
    name: 'The Runaway Balloon',
    synopsis: 'A birthday balloon slips free and floats across town. The child chases it through the neighborhood, collecting birthday moments along the way.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'BALLOON_GIFT',      description: `${n} receives a big, bright birthday balloon. Holding the string tight, admiring the color. At home on birthday morning.`, wordTarget: wt },
        { spread: 2,  beat: 'SLIP_AWAY',         description: `A gust of wind, a loosened grip — the balloon floats free! ${n} watches it drift upward, then starts to chase. Leaving home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_CHASE',       description: `Running down the street after the balloon. It dips low, then rises again just out of reach. The neighborhood opens up.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'FIRST_STOP',        description: `The balloon catches on a tree near a neighbor's yard. While reaching for it, ${n} gets a "happy birthday!" and a small treat. Neighborhood.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'FLOATS_AGAIN',      description: `The balloon frees itself and drifts on. ${n} chases it past the shop, the playground, a garden. The world is full of birthday color. Moving through town.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'SECOND_STOP',       description: `The balloon pauses at another spot. Another birthday moment happens — a friend waves, a dog dances, flowers bloom. ${n} collects joy. Same neighborhood.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'HIGH_ABOVE',        description: `The balloon rises really high. ${n} stops, looking up. For a moment, it seems gone. A beat of quiet. Looking up at the sky.`, wordTarget: wt },
        { spread: 8,  beat: 'IT_RETURNS',        description: `A breeze pushes it back down. The balloon dips into the park, bouncing between trees. ${n} sprints. The chase is back on. Park.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'CAUGHT',            description: `${n} catches the string at last! A jump, a grab, a triumphant squeeze. The balloon is back. Maximum joy. Park.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'REALIZING',         description: `Holding the balloon tight, ${n} looks back at the path traveled — all those stops, all those moments. The chase was the gift. Park.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'WALKING_HOME',      description: `${n} walks home, balloon string wrapped twice around the wrist this time. The neighborhood glows in birthday light. Heading home.`, wordTarget: wt },
        { spread: 12, beat: 'HOME_AGAIN',        description: `Back home, the balloon bobs in the corner. ${n} sits with all the little birthday moments collected along the way. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. Some birthdays come to you; this one ${n} had to chase. Echo the first moment with the balloon. Warm, bright, free.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'birthday_parade',
    name: 'The Birthday Parade',
    synopsis: 'The child starts a one-person birthday parade that grows as neighbors, animals, and friends join in — marching, drumming, and celebrating through the streets.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'SOLO_START',        description: `${n} steps outside with a homemade crown and a wooden spoon for a drumstick. A one-person birthday parade begins. Front yard.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_MARCHER',     description: `A neighbor's cat falls in line. Then a dog from down the street. The parade has its first followers. The sidewalk.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'GROWING',           description: `A friend hears the noise and runs out with a pot lid cymbal. A toddler toddles along. The parade grows. Same street.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'INSTRUMENTS',       description: `Everyone finds something to make noise with — a whistle, a shaker, a squeaky toy. The music is terrible and wonderful. Marching on.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'AROUND_THE_BLOCK',  description: `The parade turns the corner. More people wave from windows, some join in. Confetti from a balcony. The next block.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'THE_BANNER',        description: `Someone runs out with a bedsheet banner: HAPPY BIRTHDAY ${n}! The crowd cheers. The parade has a proper sign now. Same street.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'SONG_BEGINS',       description: `The birthday song starts — messy, loud, out of tune, and absolutely perfect. Everyone singing. The emotional warm-up. Marching.`, wordTarget: wt },
        { spread: 8,  beat: 'GRAND_PROCESSION',  description: `The parade at full size — the noisiest, most colorful scene in the book. ${n} at the front, crown on, leading it all. Maximum energy.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'DESTINATION',       description: `The parade arrives at the park (or back home). A table is set. The cake appears. The parade becomes a party.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'WISH_BLOW',         description: `Candles, a wish, a blow. The crowd counts down together. Joy erupts. Everyone who marched is here. Same celebration spot.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'TOGETHER',          description: `${n} looks at all the faces — some expected, some surprises. The feeling of a whole street celebrating you. Warm glow.`, wordTarget: wt },
        { spread: 12, beat: 'MARCH_HOME',        description: `The last march — a small, happy group walking ${n} home. The crown is tilted, the spoon is sticky. NOT bedtime. Heading home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. The best parades start with one brave step. Echo the solo beginning. Warm, bright, triumphant.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'upside_down_birthday',
    name: 'The Upside-Down Birthday',
    synopsis: 'Everything goes hilariously wrong — the cake falls, the balloons pop, the rain comes. But each mishap turns into something even better than planned.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'PERFECT_PLAN',     description: `${n} has the perfect birthday planned. Everything is set. Today will be AMAZING. At home, birthday morning.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_MISHAP',     description: `The first thing goes wrong — the cake slides off the counter, the dog eats the streamers, paint spills. Oh no! At home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'MAKING_IT_WORK',   description: `But wait — the squished cake tastes better with fingers. The paint makes accidental art. ${n} finds the silver lining. At home.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'SECOND_MISHAP',    description: `Outside for the party — and it starts raining. Balloons pop on a branch. The piñata falls apart. Outdoor spot.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'PUDDLE_PARTY',     description: `But rain puddles become splash zones. The broken piñata scatters candy everywhere. Rain + birthday = perfection. Same spot, now wet.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'THIRD_MISHAP',     description: `The present wrapping rips, revealing the gift too early. The candles won't light. Another comical disaster. Same rainy spot.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'LAUGHTER',         description: `${n} starts laughing. Everyone starts laughing. The whole day is so ridiculous it's wonderful. A moment of surrender. Same spot.`, wordTarget: wt },
        { spread: 8,  beat: 'EMBRACE_THE_MESS', description: `Now everyone leans into the chaos. Frosting fight. Dancing in the rain. The "worst" birthday becomes the wildest. Maximum energy.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'UNEXPECTED_MAGIC', description: `Something genuinely magical happens — a rainbow appears, a butterfly lands on the cake, the sun breaks through. Awe. Same spot.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'BEST_BIRTHDAY',    description: `${n} realizes this is the best birthday EVER. Not despite the mishaps — because of them. The emotional peak.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'MUDDY_HAPPY',      description: `Everyone is soaked, frosted, muddy, and beaming. Group hug or group collapse on the grass. Total happy mess.`, wordTarget: wt },
        { spread: 12, beat: 'SOUVENIRS',        description: `${n} at home with souvenirs of the chaos — muddy shoes, a frosting handprint, a half-popped balloon. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',          description: `The last line. Perfect is boring; messy is magic. Echo the "perfect plan" from the first spread. Warm, wild, joyful.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'birthday_time_traveler',
    name: 'The Birthday Time Traveler',
    synopsis: 'The child discovers a box of photos and keepsakes from every birthday so far — baby shoes, first drawings, candle stubs — each one a window into who they were becoming.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'THE_BOX',          description: `${n} finds a dusty box in the closet on birthday morning. It is labeled with their name. Curiosity pulls the lid open. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'BABY_THINGS',      description: `Tiny shoes, a rattle, a onesie. ${n} can't believe they were ever that small. Giggles at the baby photo. At home, same room.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'TODDLER_MEMORIES', description: `A scribble drawing, a favorite blanket corner, a first birthday candle stub. Memories of wobbling and falling and getting back up. Same room.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'GROWING_UP',       description: `Each layer in the box shows a bigger ${n}. A crayon drawing becomes a real picture. The shoes get larger. Moving through the box.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'FAVORITE_THING',   description: `${n} finds something they still love — a toy, a book, a photo with a pet. The bridge between then and now. Same room with the box.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'FUNNY_DISCOVERY',  description: `Something hilarious — a costume, a photo mid-tantrum, a cake-smeared face. ${n} laughs out loud. Physical comedy. Same room.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'QUIET_FIND',       description: `Something tender — a handprint card, a lock of hair, a note in wobbly letters. The quietest spread. Fewest words. Same room.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'LAST_YEAR',        description: `Last year's birthday photo. ${n} remembers that day — what they wore, what they wished for, how it felt. Almost to the present. Same room.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'NOW',              description: `${n} looks up from the box and into a mirror. This is who they are today. Bigger, braver, still the same. The present moment.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'ADDING_TO_BOX',    description: `${n} puts something new in the box — a drawing, a lost tooth, today's birthday candle. Becoming part of the collection. At home.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'CLOSING_THE_LID',  description: `The lid goes back on. The box holds every version of ${n}. All of them led to today. At home, warm.`, wordTarget: wt },
        { spread: 12, beat: 'TODAY_BEGINS',      description: `${n} runs out of the room, ready for today's birthday. The past is safe in the box; the present is waiting. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. Every birthday makes you more of who you already are. Echo the box opening. Warm, glowing, wonder-filled.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'birthday_garden',
    name: 'The Birthday Garden',
    synopsis: 'The child plants a birthday tree and imagines watching it grow year after year — a living marker of birthdays past and birthdays still to come.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'THE_SAPLING',      description: `${n} holds a tiny sapling on birthday morning. Today's gift is alive and green and fits in two hands. Garden or yard.`, wordTarget: wt },
        { spread: 2,  beat: 'CHOOSING_THE_SPOT', description: `Walking the yard, searching for the perfect place. Too shady here, too rocky there. The right spot matters. Garden.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'DIGGING',           description: `Hands in dirt, digging the hole. Worms discovered, rocks collected, soil between fingers. Physical, sensory work. Garden.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'PLANTING',          description: `The sapling goes in. Patting soil around it, watering from a big can. ${n} talks to the little tree. Garden.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'IMAGINING_YEAR_1',  description: `${n} imagines the tree next birthday — a little taller, first leaves. A bird sits on a branch. Daydream, still in garden.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'IMAGINING_YEAR_3',  description: `The tree in the imagination grows bigger — shade appears, a swing hangs from a branch. ${n} reads under it. Daydream grows.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'IMAGINING_BIG',     description: `The tree is enormous now — a treehouse, fruit, a whole world in its branches. The biggest dream. Fewest words needed.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'BACK_TO_NOW',       description: `${n} blinks back to the present. The sapling is still tiny, barely taller than a hand. But it's real. Garden, present moment.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'DECORATING',        description: `${n} decorates the little tree — a tiny ribbon, a painted rock at its base, a handmade sign. Making it special. Garden.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'FIRST_VISITOR',     description: `A butterfly or bird visits the tiny tree. ${n} watches, perfectly still. The tree's first guest. A moment of magic. Garden.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'WATERING_PROMISE',  description: `${n} waters the tree one more time and makes a promise to come back every birthday. The pact between child and tree.`, wordTarget: wt },
        { spread: 12, beat: 'STANDING_TOGETHER', description: `${n} stands next to the sapling — same height, both growing. The afternoon sun warms them both. NOT bedtime. Garden.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. Two small things growing side by side. Echo the morning with the sapling. Warm, rooted, alive.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'birthday_mailbox',
    name: 'The Birthday Mailbox',
    synopsis: 'Cards keep arriving in the mailbox all day — from a cloud, a squirrel, the moon, a puddle — each one with a silly, loving birthday message.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'FIRST_CARD',       description: `${n} checks the mailbox on birthday morning. One card — from the sun. "Happy birthday! I shone extra bright for you." At the mailbox.`, wordTarget: wt },
        { spread: 2,  beat: 'SECOND_CARD',      description: `Another trip to the mailbox. A card from a squirrel. A nutshell drawing inside. ${n} giggles. At the mailbox.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'THIRD_CARD',       description: `A card from the wind — the envelope blows around before ${n} catches it. The message is written in swirls. At the mailbox.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'PATTERN_BUILDS',   description: `${n} starts running to check the mailbox every few minutes. A card from a puddle, a card from an old tree. A collection grows. Between house and mailbox.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'FAVORITE_CARD',    description: `The funniest card yet — from ${n}'s own shoes ("We've walked everywhere together!") or from the fridge. Use child's interests. At home, reading cards.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'SURPRISING_CARD',  description: `A card from something unexpected — the moon, a cloud shaped like a cake, a ladybug. The world is paying attention. At the mailbox.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'TENDER_CARD',      description: `A quiet card — from the house itself, or from ${n}'s pillow. "I keep your dreams safe." The sweetest moment. Fewest words. At home.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'OVERFLOWING',      description: `The mailbox is stuffed. Cards spilling out. ${n} carries armfuls inside. The whole world sent birthday wishes. At the mailbox.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'READING_THEM_ALL', description: `${n} spreads all the cards on the floor. A carpet of birthday wishes from every corner of the world. Maximum visual joy. At home.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'WRITING_BACK',     description: `${n} decides to write back — a thank-you to the sun, a drawing for the squirrel. Pen in hand, tongue out, concentrating. At home.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'LAST_CARD',        description: `One final trip to the mailbox. One last card — no sender listed. It just says "You." The simplest and most powerful. At the mailbox.`, wordTarget: wt },
        { spread: 12, beat: 'CARD_WALL',        description: `${n} tapes all the cards to the bedroom wall. A gallery of the world's birthday love. Standing back to admire. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',          description: `The last line. When you look closely, everything is wishing you happy birthday. Echo the first card from the sun. Warm, whimsical.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'birthday_crown',
    name: 'The Birthday Crown',
    synopsis: 'The child finds a golden crown and becomes ruler for the day — decreeing silly laws, knighting the cat, and throwing a royal feast.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'CROWN_FOUND',      description: `${n} finds a golden crown on the pillow on birthday morning. It fits perfectly. A royal decree: today, ${n} rules. Bedroom.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_DECREE',     description: `The first royal order: breakfast shall be cake! ${n} marches to the kitchen with regal seriousness. At home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'KNIGHTING',        description: `${n} knights the cat (or dog, or stuffed animal) with a wooden spoon. "Rise, Sir Whiskers." The royal court is assembled. At home.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'ROYAL_TOUR',       description: `The ruler tours the kingdom — the backyard is the royal garden, the sandbox is the royal beach. Everything looks grander with a crown. Backyard.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'SILLY_LAWS',       description: `More decrees: "No vegetables! Pajamas all day! Tickling is mandatory!" ${n} waves the scepter (a stick). Backyard.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'ROYAL_CHALLENGE',  description: `A challenge to the throne — a puddle to cross, a hill to climb, a dragon (the garden hose) to tame. The ruler must prove worthy. Backyard.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'VICTORY',          description: `${n} conquers the challenge with creativity and bravery. The kingdom cheers (birds, bugs, the wind). Triumphant. Backyard.`, wordTarget: wt },
        { spread: 8,  beat: 'ROYAL_FEAST',      description: `The birthday feast is served — a picnic blanket becomes a banquet table. Crown slightly tilted, cake front and center. Maximum celebration.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'WISH_DECREE',      description: `The royal wish — candles lit, the ruler closes royal eyes. A wish spoken to the crown. Then the blow. Birthday magic.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'BEST_DECREE',      description: `The final royal decree, whispered: "Everyone I love gets a hug." The silliness melts into warmth. The emotional peak.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'CROWN_TILTS',      description: `The crown slips sideways. ${n} straightens it with sticky, frosting-covered fingers. Being a ruler is hard work. At home.`, wordTarget: wt },
        { spread: 12, beat: 'STEPPING_DOWN',    description: `${n} places the crown on a shelf — until next birthday. Today was the best reign ever. NOT bedtime. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',          description: `The last line. Every birthday, the crown fits a little better. Echo the morning discovery. Warm, regal, joyful.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'birthday_picnic',
    name: 'The Birthday Picnic',
    synopsis: 'An outdoor birthday picnic where the local animals keep showing up — birds steal crumbs, a squirrel wants cake, a butterfly joins the party.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'PACKING_UP',       description: `${n} helps pack the birthday picnic basket — blanket, cake, plates, juice boxes. Excitement for an outdoor party. Kitchen.`, wordTarget: wt },
        { spread: 2,  beat: 'FINDING_THE_SPOT',  description: `Walking to the perfect picnic spot — under the big tree, by the pond, on the sunny hill. Searching and choosing. Park or meadow.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SETTING_UP',        description: `Blanket spread, food arranged, paper plates weighted with rocks. ${n} surveys the feast. The birthday table is nature. Same spot.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'FIRST_GUEST',       description: `A bird lands on the blanket edge. Then another. They want crumbs. ${n} shares a little piece. The animal guests have arrived. Same spot.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'MORE_GUESTS',       description: `A squirrel inches closer. A butterfly circles the cake. A ladybug walks across a plate. The picnic is now a party. Same spot.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'CAKE_THIEF',        description: `A bold squirrel (or bird) grabs a piece of cake and runs! ${n} chases for a moment, then laughs. Physical comedy. Near the spot.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'SHARING',           description: `${n} decides to share on purpose. A crumb trail for the ants, seeds for the birds, a flower for the butterfly. Generosity. Same spot.`, wordTarget: wt },
        { spread: 8,  beat: 'BIRTHDAY_SONG',     description: `${n} imagines the animals singing happy birthday — the birds tweet it, the frogs croak it, the crickets chirp it. A nature chorus. Maximum joy.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'CANDLE_MOMENT',     description: `The cake candles flicker in the breeze. ${n} shields them, makes a wish, blows. A leaf swirls up as if celebrating. Same spot.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'FULL_PARTY',        description: `The scene pulled wide — ${n} on the blanket, animals all around, cake half-eaten, sun warm. A birthday shared with the whole outdoors.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'PACKING_UP_HAPPY',  description: `Time to pack. ${n} leaves a few crumbs on purpose for the cleanup crew (ants). The blanket folds up. Same spot.`, wordTarget: wt },
        { spread: 12, beat: 'WALKING_HOME',      description: `${n} walks home, basket lighter, heart full. A bird follows for half a block, then peels away. Heading home. NOT bedtime.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. The best guests don't need invitations. Echo the picnic setup. Warm, wild, sun-dappled.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
];
