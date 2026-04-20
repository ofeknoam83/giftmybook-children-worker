/**
 * Birthday plot templates — 12 structurally distinct story arcs.
 *
 * Every arc pulses with happiness and excitement and climaxes with the CAKE
 * at the very end. Cake, candles, wish, blow, frosting and first bite are
 * confined to spreads 10-13. Spreads 1-9 are pure anticipation and joy.
 *
 * Each template returns 13 spreads in 4-scene (A/B/C/D) grouping.
 * opts: { child, isYoung, wt, parentName, book, theme }
 */

module.exports = [
  {
    id: 'classic_party',
    name: 'Classic Party',
    synopsis: 'Birthday morning zings with excitement, the party builds all day through games and laughter, and the whole day erupts at the end when the cake finally appears.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'MORNING_SPARK',    description: `${n} pops awake on a special day. Morning light, a zing of excitement, a sensory detail. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'BUILDING',         description: `Something wonderful is coming — streamers going up, a parent humming, a secret smile. ${n} buzzes with anticipation. Still at home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_JOY',        description: `Decorations, party outfit, balloons puffed up. ${n} giggles and spins. Use favorite_toys or interests if available. Still at home.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'PARTY_BEGINS',     description: `Doorbell rings! Friends and family pour in with cheers and hugs. Noise, color, whoosh of energy. Show where the party is.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'GAMES',            description: `Party games in full swing — tag, musical chairs, a dance-off. ${n} laughs so hard their cheeks hurt. Same party location.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'PRESENTS_AND_PLAY', description: `Ribbons fly, wrapping paper crackles, small treasures revealed. Use favorite_toys or interests. Same location.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'PEAK_EXCITEMENT',  description: `The loudest, happiest moment of the party so far — everyone dancing, confetti flying, pure joy. Same location.`, wordTarget: wt },
        { spread: 8,  beat: 'QUICK_BREATH',     description: `A tiny pause between songs. ${n} looks around at all the faces, heart thumping happy. Still the party.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'QUIET_WONDER',     description: `The quietest spread. ${n} closes eyes for a second and feels how good today is. Fewest words.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'WHISPER_OF_CAKE',  description: `A delicious smell drifts from the kitchen. Whispers. Someone counts candles. ${n}'s eyes go wide. Same party location.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'CAKE_ARRIVES',     description: `The cake is carried in, candles glowing! Faces light up in warm flicker. Use favorite_cake_flavor if available. Same location.`, wordTarget: wt },
        { spread: 12, beat: 'WISH_AND_BLOW',    description: `Eyes squeezed shut, a big wish made, a huge breath — candles out! Cheering explodes. The climax moment.`, wordTarget: wt + 2 },
        { spread: 13, beat: 'FIRST_BITE_JOY',   description: `First gooey bite, frosting on a cheek, ${n} grinning ear to ear. Pure, bouncing birthday joy. Echo the morning spark. NOT bedtime.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'surprise_party',
    name: 'The Surprise Party',
    synopsis: 'Everyone is acting strange today — whispers, closed doors, secret smiles. The clues keep piling up, the house explodes with SURPRISE, and the day crescendos when the cake finally rolls out at the very end.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'MORNING_SPARK',    description: `${n} wakes thinking it is a regular day. Morning routine, but something feels oddly exciting in the air. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_CLUE',       description: `A door closes too fast. A whisper dies when ${n} walks in. A ribbon pokes from behind a cushion. ${n} grins — something is up. At home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'MORE_CLUES',       description: `A hidden bag, a parent's phone face-down, faint laughter from the basement. ${n}'s excitement buzzes higher. Still at home.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'SENT_AWAY',        description: `"Go play outside!" ${n} is nudged out on a fake errand. Leaving home, glancing back with sparkly suspicion.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'WONDERING',        description: `While out, ${n}'s imagination races. Balloons? A puppy? The world shimmers with what-if. At the outing location.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'MORE_SIGNS',       description: `Even here, clues — a familiar car, a friend who waves and vanishes, a sparkly gift bag in a shop. Same outing location.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'HEADING_BACK',     description: `Time to go home. ${n} walks back, heart thumping. The house looks dark and quiet. The anticipation is ENORMOUS.`, wordTarget: wt },
        { spread: 8,  beat: 'THE_REVEAL',       description: `The door opens — SURPRISE! Decorations, faces, cheering, streamers everywhere. The most explosive, joyful spread.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'QUIET_WONDER',     description: `${n} stops in the middle of it all, eyes shining, taking in every face. The quietest moment. Fewest words.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'WHISPER_OF_CAKE',  description: `Games, laughter, dancing — and then a delicious smell from the kitchen. Someone winks. Another surprise is coming. Same party space.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'CAKE_ARRIVES',     description: `The secret cake rolls out with candles glowing! Even bigger surprise on the cake. Faces glow warm. Use favorite_cake_flavor.`, wordTarget: wt },
        { spread: 12, beat: 'WISH_AND_BLOW',    description: `${n} closes eyes, makes the best wish ever, and blows — candles OUT! The room erupts. The climax moment.`, wordTarget: wt + 2 },
        { spread: 13, beat: 'FIRST_BITE_JOY',   description: `Frosting on noses, cake on plates, the best surprise was saved for the end. Echo the quiet morning. NOT bedtime.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'birthday_quest',
    name: 'The Birthday Quest',
    synopsis: 'A treasure map on the doorstep sends the child on a day-long hunt across the yard and town. Each clue leads somewhere more exciting, and the final X at the end of the quest is the most glorious treasure of all: the birthday cake.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'MORNING_SPARK',    description: `${n} finds a mysterious rolled-up map on the doorstep, tied with a ribbon. Birthday morning zing. At the front door.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_CLUE',       description: `The map points to somewhere familiar (mailbox, garden gate, big tree). ${n} races to find the first riddle. Near home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_TREASURE',   description: `A tiny surprise tucked at the first stop — a ribbon, a toy, a note with the next clue. ${n} is HOOKED. Near home.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'SECOND_STOP',      description: `The riddle leads farther — the park bench, the funny-shaped rock. ${n} is a proper treasure hunter now. New location.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'SECOND_TREASURE',  description: `Another surprise, another clue. This one takes real thinking. Use child's interests in the clue. Same second location.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'THIRD_STOP',       description: `The trail leads to the most unexpected place yet. ${n} is deep in the quest, fully focused, tongue out. New location.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'PEAK_DISCOVERY',   description: `The biggest trail moment — ${n} solves a tricky clue with a proud AHA! Fist-pump. Same third location.`, wordTarget: wt },
        { spread: 8,  beat: 'HEADING_HOME',     description: `The final clue points back home. ${n} sprints, pockets stuffed with little treasures, heart pounding. Heading home.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'QUIET_WONDER',     description: `On the way back, ${n} pauses just once. All those clues, all those stops, all leading somewhere. Fewest words.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'WHISPER_OF_CAKE',  description: `Home in sight. A delicious smell drifts out. The last clue reads: "The biggest treasure is waiting inside." ${n}'s eyes go huge.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'CAKE_ARRIVES',     description: `${n} bursts through the door — there it is! The final treasure: the birthday cake, candles glowing. Use favorite_cake_flavor. At home.`, wordTarget: wt },
        { spread: 12, beat: 'WISH_AND_BLOW',    description: `Eyes closed tight, the quest-earned wish, a huge breath — candles out! Treasure claimed. Everyone cheers. The climax.`, wordTarget: wt + 2 },
        { spread: 13, beat: 'FIRST_BITE_JOY',   description: `Cake, frosting, grinning faces, the map still warm in ${n}'s hand. The best treasures you earn clue by clue. Echo the doorstep map. NOT bedtime.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'birthday_baker',
    name: 'The Birthday Baker',
    synopsis: 'The child decides to bake their own birthday cake. Flour flies, batter splatters, frosting goes everywhere — and the whole happy, messy day builds to the final glorious moment when the lopsided cake is crowned with candles and blown out.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'MORNING_SPARK',    description: `${n} announces the plan with a grin: "I'm baking my OWN birthday cake this year!" Determination and sparkle. Kitchen at home.`, wordTarget: wt },
        { spread: 2,  beat: 'GATHERING',        description: `Pulling out bowls, spoons, ingredients. Everything is too high, too heavy, too slippery — but ${n} is unstoppable. Kitchen.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'MEASURING',        description: `Flour measured with great seriousness (and great inaccuracy). Sugar spills. Giggles. Kitchen, same scene.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'MIXING_CHAOS',     description: `The mixer goes too fast. Batter splatters on the ceiling. ${n} is covered in flour but beaming. Pure physical comedy. Kitchen.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'INTO_THE_OVEN',    description: `The lumpy batter slides into the oven. ${n} presses nose to the glass, watching it rise. Kitchen.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'WAITING_DANCE',    description: `Waiting is the hardest part — so ${n} dances around the kitchen to pass the time. The room smells like magic. Kitchen.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'ITS_BAKED',        description: `DING! The timer. ${n} peers in — the cake is lopsided, cracked, perfectly imperfect. A proud gasp.`, wordTarget: wt },
        { spread: 8,  beat: 'FROSTING_SWIRLS',  description: `Frosting goes on in wild swoops. It covers the cake, the counter, ${n}'s nose. Maximum mess, maximum happiness. Kitchen.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'QUIET_WONDER',     description: `${n} steps back to look at the finished cake. The quietest, proudest moment. Fewest words. Kitchen.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'WHISPER_OF_CAKE',  description: `Sprinkles rain on like confetti. ${n} counts out the candles one by one, whispering the right number. Kitchen.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'CAKE_ARRIVES',     description: `${n} carries the homemade masterpiece out to the table, candles flickering. Faces glow. It is the most beautiful cake ever. Use favorite_cake_flavor.`, wordTarget: wt },
        { spread: 12, beat: 'WISH_AND_BLOW',    description: `The biggest wish — eyes closed, a deep breath, candles OUT in one blow! Whoops, claps, cheers. The climax.`, wordTarget: wt + 2 },
        { spread: 13, beat: 'FIRST_BITE_JOY',   description: `Everyone takes a bite — it's a little crunchy, a little lopsided, and absolutely delicious. The best cakes are made with your own hands. NOT bedtime.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'runaway_balloon',
    name: 'The Runaway Balloon',
    synopsis: 'A birthday balloon slips free and floats across town. The child chases it through the whole neighborhood, collecting joyful moments along the way — and the great chase ends back home where the cake is waiting.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'MORNING_SPARK',    description: `${n} receives a big, bright birthday balloon. Holding the string tight, admiring the color, buzzing with birthday joy. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'SLIP_AWAY',        description: `A gust of wind, a loosened grip — the balloon floats free! ${n} watches it drift up, then bursts into a chase. Leaving home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_CHASE',      description: `Running down the street. The balloon dips low, then rises just out of reach. The neighborhood opens up wide.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'FIRST_STOP',       description: `The balloon catches on a tree. A neighbor cheers "happy birthday!" and hands ${n} a little treat. Neighborhood.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'FLOATS_AGAIN',     description: `Free again! Past the shop, the playground, a garden. The world is full of birthday color. Moving through town.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'SECOND_STOP',      description: `The balloon bobs at a friend's window. More waves, more smiles, a paper hat tossed down from above. Same neighborhood.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'PEAK_CHASE',       description: `The balloon zips into the park. ${n} sprints full tilt, laughing, almost flying. The chase is at max energy.`, wordTarget: wt },
        { spread: 8,  beat: 'CAUGHT',           description: `A jump, a grab, a triumphant squeeze — the balloon is caught! ${n} whoops into the sky. Park.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'QUIET_WONDER',     description: `Holding the balloon tight, ${n} looks back at the path traveled. So many little moments. Fewest words.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'WHISPER_OF_CAKE',  description: `${n} walks home, balloon string wrapped twice around the wrist. A delicious smell drifts from the front door. Something is waiting.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'CAKE_ARRIVES',     description: `Inside — SURPRISE! A birthday cake glowing with candles, everyone cheering the balloon-chaser's return. Use favorite_cake_flavor. At home.`, wordTarget: wt },
        { spread: 12, beat: 'WISH_AND_BLOW',    description: `Balloon in one hand, eyes closed, a huge wish, a huge breath — candles OUT! The balloon bobs as everyone cheers. Climax.`, wordTarget: wt + 2 },
        { spread: 13, beat: 'FIRST_BITE_JOY',   description: `Cake on a plate, balloon floating above, ${n} beaming. Some birthdays come to you; this one ${n} had to chase. NOT bedtime.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'birthday_parade',
    name: 'The Birthday Parade',
    synopsis: 'The child starts a one-person birthday parade that grows as neighbors, pets, and friends join in. The whole marching, drumming, cheering crowd leads through the streets and finally arrives at the grandest cake moment of all.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'MORNING_SPARK',    description: `${n} steps outside with a homemade crown and a wooden spoon for a drumstick. A one-person birthday parade begins. Front yard.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_MARCHER',    description: `A neighbor's cat falls in line. Then a dog from down the street. ${n} giggles — the parade has its first followers. Sidewalk.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'GROWING',          description: `A friend hears the noise and runs out with a pot-lid cymbal. A toddler toddles along. The parade grows. Same street.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'INSTRUMENTS',      description: `Everyone grabs something to make noise with — a whistle, a shaker, a squeaky toy. The music is terrible and wonderful. Marching on.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'AROUND_THE_BLOCK', description: `The parade turns the corner. More people wave from windows, some join in. Confetti flutters down from a balcony. Next block.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'THE_BANNER',       description: `Someone runs out with a bedsheet banner: HAPPY BIRTHDAY ${n}! The crowd whoops. The parade has a proper sign now. Same street.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'PEAK_SONG',        description: `The birthday song starts — messy, loud, out of tune, and absolutely perfect. Everyone singing at full volume. Marching.`, wordTarget: wt },
        { spread: 8,  beat: 'GRAND_PROCESSION', description: `The parade at full size — the noisiest, most colorful scene in the book. ${n} at the front, crown on, leading it all.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'QUIET_WONDER',     description: `For just a second, ${n} looks at all the faces marching along. The quietest beat. Fewest words.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'WHISPER_OF_CAKE',  description: `The parade turns the final corner. A table is set. A delicious smell. The whole crowd sniffs in unison. Destination in sight.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'CAKE_ARRIVES',     description: `The parade arrives — and THERE IT IS. The birthday cake, candles glowing, waiting for the whole marching crowd. Use favorite_cake_flavor.`, wordTarget: wt },
        { spread: 12, beat: 'WISH_AND_BLOW',    description: `The crowd counts down. ${n} closes eyes, makes the biggest wish, takes the biggest breath — candles OUT! The street erupts. Climax.`, wordTarget: wt + 2 },
        { spread: 13, beat: 'FIRST_BITE_JOY',   description: `Cake handed around to every marcher. Crown tilted, spoon sticky, whole street grinning. Best parades start with one brave step. NOT bedtime.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'upside_down_birthday',
    name: 'The Upside-Down Birthday',
    synopsis: 'Everything goes hilariously wrong — the streamers fall, the rain comes, the piñata bursts early. But each mishap turns into something even better, and the whole wild, laughing day crowns itself with the most magnificent cake moment at the end.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'MORNING_SPARK',    description: `${n} has the perfect birthday planned. Everything is set. Today will be AMAZING. At home, birthday morning zing.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_MISHAP',     description: `The first thing goes wrong — the streamers all unroll at once, the dog eats a party hat, paint spills. ${n} gasps, then giggles. At home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'MAKING_IT_WORK',   description: `But wait — the spilled paint makes accidental art, the wild streamers look like a rainbow jungle. Silver linings everywhere. At home.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'SECOND_MISHAP',    description: `Outside for the party — and it starts raining! Balloons pop on a branch. The piñata bursts too early. Outdoor spot.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'PUDDLE_PARTY',     description: `Rain puddles become splash zones. Scattered piñata candy becomes a scavenger hunt. Rain + birthday = magic. Same spot, now wet.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'THIRD_MISHAP',     description: `Wrapping paper rips, the bounce house tilts sideways, a present ends up in a puddle. ${n} doubles over laughing. Same spot.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'PEAK_LAUGHTER',    description: `Everyone is laughing so hard they can't breathe. The whole day is so ridiculous it's wonderful. Same spot.`, wordTarget: wt },
        { spread: 8,  beat: 'EMBRACE_THE_MESS', description: `The "worst" birthday becomes the wildest — dancing in the rain, muddy tag, a giant group splash. Max energy.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'QUIET_WONDER',     description: `A rainbow breaks through the clouds. ${n} stops, muddy and bright-eyed, just to look. Fewest words.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'WHISPER_OF_CAKE',  description: `Someone races inside — "the cake survived!" A delicious smell sneaks out the kitchen window. ${n}'s eyes light up.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'CAKE_ARRIVES',     description: `The cake comes out — a little slanted, a little rescued, and UTTERLY perfect. Candles glow. Everyone cheers the survivor cake. Use favorite_cake_flavor.`, wordTarget: wt },
        { spread: 12, beat: 'WISH_AND_BLOW',    description: `Eyes closed, the wildest wish, a huge breath — candles OUT! The soggy, happy crowd erupts. The climax of the most chaotic day.`, wordTarget: wt + 2 },
        { spread: 13, beat: 'FIRST_BITE_JOY',   description: `Muddy shoes, frosting smiles, the best cake of any birthday ever. Perfect is boring; messy is magic. NOT bedtime.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'birthday_time_traveler',
    name: 'The Birthday Time Traveler',
    synopsis: 'The child discovers a box of photos and keepsakes from every birthday so far — tiny shoes, first drawings, old birthday hats. After travelling back through every year, the journey lands right at today\'s cake.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'MORNING_SPARK',    description: `${n} finds a dusty box in the closet on birthday morning. It is labeled with their name. Curiosity sparkles. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'BABY_THINGS',      description: `Tiny shoes, a rattle, a onesie. ${n} can't believe they were ever that small. Giggles at the baby photo. Same room.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'TODDLER_MEMORIES', description: `A scribble drawing, a favorite blanket corner, a first birthday hat. Memories of wobbling and laughing. Same room.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'GROWING_UP',       description: `Each layer in the box shows a bigger ${n}. The shoes get larger, the drawings get bolder. Moving through time. Same room.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'FAVORITE_THING',   description: `${n} finds something they still love — a toy, a book, a photo with a pet. The bridge between then and now. Same room.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'FUNNY_DISCOVERY',  description: `Something hilarious — a costume, a photo mid-tantrum, a party hat stuck on sideways. ${n} laughs out loud. Same room.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'TENDER_FIND',      description: `A handprint card, a lock of hair, a note in wobbly letters. ${n}'s heart goes soft and warm. Same room.`, wordTarget: wt },
        { spread: 8,  beat: 'LAST_YEAR',        description: `Last year's birthday photo — the party, the friends, the joy. Almost caught up to today. Same room.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'QUIET_WONDER',     description: `${n} looks up from the box and into a mirror. This is who they are today. Fewest words. Same room.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'WHISPER_OF_CAKE',  description: `A delicious smell floats in from the kitchen. Today is waiting. ${n} puts the lid back on the box and follows the smell. At home.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'CAKE_ARRIVES',     description: `There it is — today's birthday cake, candles glowing, adding another year to the story. Family gathered round. Use favorite_cake_flavor.`, wordTarget: wt },
        { spread: 12, beat: 'WISH_AND_BLOW',    description: `Eyes closed, all those past birthdays twinkling behind them, ${n} makes the biggest wish yet — and blows. Candles OUT. Everyone cheers. Climax.`, wordTarget: wt + 2 },
        { spread: 13, beat: 'FIRST_BITE_JOY',   description: `First bite, frosting on a finger, a new photo taken to add to the box someday. Every birthday makes you more of who you already are. NOT bedtime.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'birthday_garden',
    name: 'The Birthday Garden',
    synopsis: 'The child plants a birthday tree and imagines watching it grow year after year. The whole sunny, bright day of digging and dreaming ends with a garden picnic and the best cake of all right beside the little sapling.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'MORNING_SPARK',    description: `${n} holds a tiny sapling on birthday morning. Today's surprise is alive and green and fits in two hands. Garden.`, wordTarget: wt },
        { spread: 2,  beat: 'CHOOSING_SPOT',    description: `Walking the yard, searching for the perfect place. Too shady here, too rocky there. ${n} buzzes with importance. Garden.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'DIGGING',          description: `Hands in dirt, digging the hole. Worms discovered, rocks collected, soil between fingers. Giggly, sensory work. Garden.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'PLANTING',         description: `The sapling goes in. Patting soil around it, watering from a big can. ${n} whispers a welcome to the little tree. Garden.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'IMAGINING_Y1',     description: `${n} imagines the tree next birthday — a little taller, first leaves, a bird on a branch. Daydream, still in garden.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'IMAGINING_Y3',     description: `The tree in imagination grows bigger — shade appears, a swing hangs, ${n} reads under it. The daydream grows.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'IMAGINING_BIG',    description: `The tree is enormous — a treehouse, fruit, a whole world in its branches. The biggest happy dream.`, wordTarget: wt },
        { spread: 8,  beat: 'BACK_TO_NOW',      description: `${n} blinks back to the present. The sapling is still tiny, barely taller than a hand. But it's real and perfect. Garden.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'QUIET_WONDER',     description: `A butterfly lands on the tiny tree. ${n} holds very still. The quietest, brightest moment. Fewest words.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'WHISPER_OF_CAKE',  description: `A parent calls from the back door. A picnic blanket is being spread on the grass right beside the sapling. A delicious smell drifts over. Garden.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'CAKE_ARRIVES',     description: `A birthday cake is placed on the blanket, candles glowing beside the brand-new tree. The whole garden cheers. Use favorite_cake_flavor.`, wordTarget: wt },
        { spread: 12, beat: 'WISH_AND_BLOW',    description: `Eyes closed, hand touching the little sapling for luck, ${n} wishes and blows — candles OUT! Leaves rustle like applause. Climax.`, wordTarget: wt + 2 },
        { spread: 13, beat: 'FIRST_BITE_JOY',   description: `Cake on a blanket, crumbs for the birds, ${n} sitting beside the sapling — two small things growing side by side. NOT bedtime.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'birthday_mailbox',
    name: 'The Birthday Mailbox',
    synopsis: 'Cards keep arriving in the mailbox all day — from a cloud, a squirrel, the moon, a puddle — each one with a silly, loving birthday message. And the very last delivery of the day is the grandest: a cake wheeled right up to the door.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'MORNING_SPARK',    description: `${n} checks the mailbox on birthday morning. One card — from the sun. "Happy birthday! I shone extra bright for you." At the mailbox.`, wordTarget: wt },
        { spread: 2,  beat: 'SECOND_CARD',      description: `Another trip to the mailbox. A card from a squirrel. A nutshell drawing inside. ${n} giggles. At the mailbox.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'THIRD_CARD',       description: `A card from the wind — the envelope blows around before ${n} catches it. The message is written in swirls. At the mailbox.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'PATTERN_BUILDS',   description: `${n} runs to check the mailbox every few minutes. A card from a puddle, a card from an old tree. A collection grows. Between house and mailbox.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'FAVORITE_CARD',    description: `The funniest card yet — from ${n}'s own shoes ("we've walked everywhere together!") or from the fridge. Use child's interests. At home, reading cards.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'SURPRISING_CARD',  description: `A card from something unexpected — the moon, a cloud shaped like a heart, a ladybug. The world is paying attention. At the mailbox.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'TENDER_CARD',      description: `A quiet card — from the house itself, or from ${n}'s pillow: "I keep your dreams safe." Fewest words. At home.`, wordTarget: wt },
        { spread: 8,  beat: 'OVERFLOWING',      description: `The mailbox is stuffed. Cards spilling out. ${n} carries armfuls inside. The whole world sent birthday wishes. At the mailbox.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'QUIET_WONDER',     description: `${n} spreads every card across the floor — a carpet of birthday love. The quietest, warmest moment. Fewest words.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'WHISPER_OF_CAKE',  description: `A knock at the door! One last card, bigger than the rest, signed "Everyone who loves you." A delicious smell seeps out of the envelope. At home.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'CAKE_ARRIVES',     description: `The door swings open — behind the card is a birthday cake on a cart, candles glowing! Family and friends behind it cheering. Use favorite_cake_flavor.`, wordTarget: wt },
        { spread: 12, beat: 'WISH_AND_BLOW',    description: `Surrounded by cards and loved ones, ${n} makes the biggest wish, takes the biggest breath — candles OUT! The front room explodes with joy. Climax.`, wordTarget: wt + 2 },
        { spread: 13, beat: 'FIRST_BITE_JOY',   description: `Cake on a plate, cards taped to the wall, ${n} grinning. When you look closely, everything is wishing you happy birthday. NOT bedtime.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'birthday_crown',
    name: 'The Birthday Crown',
    synopsis: 'The child finds a golden crown and becomes ruler for the day — decreeing silly laws, knighting the cat, leading a royal tour. The whole regal, giggly day culminates in the grand royal feast and the most magnificent cake of the kingdom.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'MORNING_SPARK',    description: `${n} finds a golden crown on the pillow on birthday morning. It fits perfectly. A royal decree: today, ${n} rules. Bedroom.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_DECREE',     description: `The first royal order: pajamas all day! ${n} marches through the house with regal seriousness. At home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'KNIGHTING',        description: `${n} knights the cat (or dog, or stuffed animal) with a wooden spoon. "Rise, Sir Whiskers." The royal court is assembled. At home.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'ROYAL_TOUR',       description: `The ruler tours the kingdom — the backyard is the royal garden, the sandbox is the royal beach. Everything looks grander with a crown. Backyard.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'SILLY_LAWS',       description: `More decrees: "No vegetables! Tickling is mandatory! Dancing in puddles is the law!" ${n} waves the scepter (a stick). Backyard.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'ROYAL_CHALLENGE',  description: `A challenge to the throne — a puddle to cross, a hill to climb, a dragon (the garden hose) to tame. The ruler proves worthy. Backyard.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'VICTORY',          description: `${n} conquers the challenge with creativity and bravery. The kingdom cheers (birds, bugs, the wind). Crown sparkling.`, wordTarget: wt },
        { spread: 8,  beat: 'COURT_GATHERS',    description: `The royal court assembles — family, friends, the cat, the dog. All bow (some more than others). Max giggly pageantry. Backyard.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'QUIET_WONDER',     description: `${n} sits on the "throne" (a garden chair) and looks out at the kingdom. The quietest, proudest moment. Fewest words.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'WHISPER_OF_CAKE',  description: `A royal herald (a little sibling) announces: "The feast is READY!" A delicious smell floats from the kitchen. Excitement hums. Backyard.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'CAKE_ARRIVES',     description: `The royal birthday cake is paraded in on a platter, candles glowing like tiny torches. The court cheers. Use favorite_cake_flavor.`, wordTarget: wt },
        { spread: 12, beat: 'WISH_AND_BLOW',    description: `The royal wish: eyes closed, crown slightly tilted, a mighty breath — candles OUT! The kingdom erupts. The climax of the reign.`, wordTarget: wt + 2 },
        { spread: 13, beat: 'FIRST_BITE_JOY',   description: `Royal cake, royal frosting fingers, royal beam. Every birthday, the crown fits a little better. NOT bedtime.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'birthday_picnic',
    name: 'The Birthday Picnic',
    synopsis: 'An outdoor birthday picnic where the local animals keep joining in — birds, squirrels, butterflies, ladybugs. The whole sunny, shared day builds and builds until the grand cake moment under the open sky.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'MORNING_SPARK',    description: `${n} helps pack the birthday picnic basket — blanket, plates, juice boxes, a special hidden surprise. Excitement for an outdoor party. Kitchen.`, wordTarget: wt },
        { spread: 2,  beat: 'FINDING_SPOT',     description: `Walking to the perfect picnic spot — under the big tree, by the pond, on the sunny hill. ${n} chooses solemnly. Park or meadow.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SETTING_UP',       description: `Blanket spread, food arranged, paper plates weighted with rocks. ${n} surveys the spread. The birthday table is nature itself. Same spot.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'FIRST_GUEST',      description: `A bird lands on the blanket edge. Then another. They want crumbs. ${n} shares a little piece. The animal guests arrive. Same spot.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'MORE_GUESTS',      description: `A squirrel inches closer. A butterfly circles overhead. A ladybug walks across a plate. The picnic is now a party. Same spot.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'GAMES_OUTSIDE',    description: `${n} invents picnic games — daisy chains, stone skipping, chasing shadows with the animal friends. Maximum sunny joy. Same spot.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'PEAK_SUN',         description: `${n} lies back on the blanket, arms wide, soaking in the sun. Animals gathered round. The happiest stillness. Same spot.`, wordTarget: wt },
        { spread: 8,  beat: 'NATURE_SONG',      description: `The birds tweet, the frogs croak, the crickets chirp — a whole nature chorus for ${n}. Max shared joy. Same spot.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'QUIET_WONDER',     description: `${n} watches a leaf spin down from a branch. The whole world paused just for this second. Fewest words.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'WHISPER_OF_CAKE',  description: `A parent lifts the surprise from the basket. A delicious smell spreads through the meadow. Every animal sniffs the air. Same spot.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'CAKE_ARRIVES',     description: `The birthday cake comes out, candles shielded from the breeze, glowing under open sky. Use favorite_cake_flavor. The whole meadow leans in.`, wordTarget: wt },
        { spread: 12, beat: 'WISH_AND_BLOW',    description: `${n} cups hands around the flames, closes eyes, wishes, and blows — candles OUT! A leaf swirls up as if celebrating. The climax.`, wordTarget: wt + 2 },
        { spread: 13, beat: 'FIRST_BITE_JOY',   description: `Cake shared with family and a crumb trail for the ants. Best guests don't need invitations, best cakes are eaten under the sky. NOT bedtime.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
];
