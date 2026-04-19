/**
 * Father's Day plot templates — 12 structurally distinct story arcs.
 *
 * Each template returns 13 spreads in 4-scene (A/B/C/D) grouping.
 * opts: { child, isYoung, wt, parentName, book, theme }
 *
 * PARENT THEME: Dad is a visible character in every spread.
 */

module.exports = [
  {
    id: 'classic_adventure',
    name: 'Classic Adventure',
    synopsis: 'Dad and child share a morning ritual, head out on an adventure together, hit a peak moment of shared triumph, and return home glowing.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      const p = opts.parentName || 'Daddy';
      return [
        { spread: 1,  beat: 'HOME_RITUAL',        description: `${n} and ${p} have a morning thing — a handshake, a song, a race to the kitchen. Show it vivid and particular. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'GEARING_UP',         description: `Packing for the adventure. ${p} grabs the big backpack, ${n} grabs the small one. They check each other's gear. Ready. At home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SETTING_OUT',        description: `Out the door, side by side. ${p}'s long stride, ${n}'s quick steps. The world opens up ahead of them. Leaving home.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'FIRST_CHALLENGE',    description: `The first obstacle — a steep path, a wide puddle, a tangled fence. ${p} shows the way, ${n} follows boldly. Outdoors.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'EXPLORING',          description: `Deeper into the adventure — discovering tracks, climbing rocks, crossing a stream. ${p} lifts ${n} over the hard parts. Outdoors.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'TEAMWORK',           description: `Something requires both of them — ${n}'s small hands fit where ${p}'s big ones can't, or ${p}'s height reaches what ${n} can't. Teamwork. Outdoors.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'PEAK_MOMENT',        description: `The summit, the clearing, the waterfall — they reach it together. ${p} swings ${n} onto shoulders. The view is everything. Outdoors.`, wordTarget: wt },
        { spread: 8,  beat: 'QUIET_BEAT',         description: `Sitting together at the top. Catching breath, sharing water. The world is huge and they are small and that's perfect. Fewest words. Outdoors.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 9,  beat: 'DOWNHILL_FUN',       description: `Heading back — racing, sliding, taking the fun route. ${p} pretends ${n} is too fast to catch. ${n} pretends to believe it. Outdoors.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'SURPRISE_FIND',      description: `On the way home, they discover something together — a cool stick, a hidden path, a frog on a rock. Shared excitement. Outdoors.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'HOMEWARD',           description: `Walking home as the light changes. ${n}'s steps are slower now. ${p} matches the pace. The adventure winds down gently. Heading home.`, wordTarget: wt },
        { spread: 12, beat: 'HOME_TOGETHER',      description: `Back home, boots off, trophy from the adventure on the table. ${n} and ${p} look at each other: "Same time next week?" NOT bedtime. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. Echo the morning ritual. The best adventures end where they begin — at home, together. Warm, bold, returned.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'builder',
    name: 'Building Together',
    synopsis: 'Dad and child build something epic — a treehouse, a go-kart, a model rocket. Sawdust, patience, a few mistakes, and one magnificent creation.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      const p = opts.parentName || 'Daddy';
      return [
        { spread: 1,  beat: 'THE_BLUEPRINT',      description: `${p} and ${n} unroll a plan on the workshop floor. It's ambitious. It's messy. It's perfect. "We're building this," ${p} says. Workshop.`, wordTarget: wt },
        { spread: 2,  beat: 'MATERIALS',          description: `Gathering supplies — wood, nails, rope, paint. ${n} carries the light things, ${p} carries the heavy things. The pile grows. Workshop.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_CUT',          description: `${p} measures twice, cuts once. ${n} holds the tape. Sawdust flies and smells like possibility. The first piece is ready. Workshop.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'HAMMERING',          description: `${n} holds a nail steady. ${p} swings the hammer — BANG. Together, piece by piece, the thing begins to take shape. Workshop.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'MISTAKE',            description: `A board goes on backward. A wheel comes off. ${p} scratches head. ${n} tilts head. They stare at it, then fix it with something unexpected. Workshop.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'CREATIVE_ADDITION',  description: `${n} suggests something wild — a flag, a secret hatch, a racing stripe. ${p} considers it seriously. "Brilliant." They add it. Workshop.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'HARD_PART',          description: `The trickiest step. Both concentrating. ${p}'s big hands and ${n}'s small ones working on the same bolt, the same knot. Breathing together. Workshop.`, wordTarget: wt },
        { spread: 8,  beat: 'SAWDUST_PAUSE',      description: `A break. Sitting on upturned buckets, drinking something cold. The half-built thing stands between them, proud and unfinished. Fewest words. Workshop.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 9,  beat: 'FINAL_PUSH',         description: `Last pieces going on. Energy renewed. ${p} and ${n} work in sync now — hand me that, hold this, perfect. Workshop.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'DONE',               description: `They step back. It's finished. It's glorious. It leans slightly to the left and that makes it better. ${p} and ${n} high-five hard. Workshop.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'TEST_DRIVE',         description: `The first test — riding it, launching it, climbing into it. It works! ${p} cheers, ${n} cheers, the creation stands strong. Outdoors.`, wordTarget: wt },
        { spread: 12, beat: 'ADMIRING',           description: `Side by side, arms folded, admiring what they made. Sawdust in both hair, paint on both hands. The builders and the built. NOT bedtime. Outdoors.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. The things you build with your hands remember the hands that built them. Echo the blueprint. Warm, built, standing.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'role_reversal',
    name: 'The Role Reversal',
    synopsis: 'The child "becomes" Dad for the day — wearing big shoes, "driving" the car, making coffee. Hilarious attempts and a new appreciation for what Dad does.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      const p = opts.parentName || 'Daddy';
      return [
        { spread: 1,  beat: 'BIG_SHOES',          description: `${n} clomps into the kitchen wearing ${p}'s shoes — enormous, flopping. "I'm ${p} today." Stands tall (still very short). Kitchen.`, wordTarget: wt },
        { spread: 2,  beat: 'COFFEE_ATTEMPT',     description: `${n} "makes coffee" — fills a mug with milk, stirs it very seriously, adds a spoonful of sugar. Hands it to ${p}. "${p}'s coffee." Kitchen.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'NEWSPAPER',          description: `${n} sits in ${p}'s chair and holds a newspaper upside down. Nods wisely. "Hmm, very interesting." ${p} hides behind a cushion, shaking with laughter. Living room.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'FIX_IT',             description: `${n} grabs a toy wrench and "fixes" things — tightens the table leg, adjusts the doorknob, inspects the toaster. Very professional. At home.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'DRIVING',            description: `In the car (not moving), ${n} sits in the driver's seat. Hands on the wheel. "VROOM. BEEP BEEP." Checks the mirrors (can't reach them). Driveway.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'CARRYING',           description: `${n} tries to carry everything ${p} normally carries — bags, tools, a chair. Staggers under the weight. ${p} steadies the tower. Outside.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'DAD_VOICE',          description: `${n} uses the deep "Dad voice": "Time to clean up." "Did you brush your teeth?" ${p} obeys immediately, trying not to crack up. At home.`, wordTarget: wt },
        { spread: 8,  beat: 'EXHAUSTED',          description: `${n} collapses. "Being ${p} is SO much work." ${p} nods knowingly. They sit together. A beat of mutual respect. Fewest words. Living room.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 9,  beat: 'COOKING',            description: `${n} tries to make dinner — puts bread on a plate, adds cheese, calls it done. "Chef's special." ${p} eats it with great ceremony. Kitchen.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'STORY_TIME',         description: `${n} reads ${p} a bedtime story (it's afternoon). Does silly voices. Gets the ending wrong on purpose. ${p} pretends to be riveted. Living room.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'SHOES_OFF',          description: `${n} finally kicks off the big shoes. "You can be ${p} again." Wiggles free toes. ${p} puts the shoes back on and they both laugh. Living room.`, wordTarget: wt },
        { spread: 12, beat: 'REAL_HUG',           description: `${n} wraps arms around ${p}. "You're a good ${p}." ${p} wraps arms around ${n}. "You'll be a great one someday." NOT bedtime. Living room.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. The biggest shoes are the ones filled with love. Echo the clomp. Warm, hilarious, understood.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'fix_it',
    name: 'The Fix-It Day',
    synopsis: 'Something breaks. Dad and child fix it together — with creativity, duct tape, and determination. The fix is better than the original.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      const p = opts.parentName || 'Daddy';
      return [
        { spread: 1,  beat: 'THE_BREAK',          description: `CRASH. Something breaks — a shelf, a bike chain, a toy, a fence board. ${n} and ${p} stare at the pieces. "We can fix this." At home.`, wordTarget: wt },
        { spread: 2,  beat: 'ASSESSMENT',         description: `${p} kneels down and examines the damage. ${n} kneels beside. They poke, prod, and turn it over. "Hmm," says ${p}. "Hmm," says ${n}. At home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'TOOL_GATHERING',     description: `The toolbox opens — screwdrivers, pliers, duct tape, something mysterious. ${n} hands tools to ${p} like a surgeon's assistant. Workshop or garage.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'FIRST_ATTEMPT',      description: `They try the obvious fix. It doesn't work. The thing wobbles, or pops apart, or makes a funny sound. Back to square one. Same spot.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'CREATIVE_IDEA',      description: `${n} suggests something unexpected — "What if we use this?" It's unconventional. ${p} considers it. "Let's try it." Excitement builds. Same spot.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'DUCT_TAPE',          description: `Duct tape makes an appearance. ${p} rips strips, ${n} places them. They add more than necessary. The thing starts looking like a mummy. Same spot.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'ALMOST',             description: `Almost there — one more turn, one more piece. ${p} holds it steady, ${n} adds the final element. They both hold their breath. Same spot.`, wordTarget: wt },
        { spread: 8,  beat: 'TESTING',            description: `The moment of truth. They test it. It holds. It works. It's actually BETTER than before. Both hands in the air. Fewest words. Same spot.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 9,  beat: 'CELEBRATION',        description: `Victory lap. ${p} hoists ${n} up. They dance around the fixed thing. The repair is their shared trophy. Maximum joy. Same spot.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'ANOTHER_BREAK',      description: `Something else needs fixing — something small, easy. ${p} looks at ${n}. "You do this one." ${n}'s eyes light up. Empowerment. At home.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'SOLO_FIX',           description: `${n} fixes the small thing, ${p} watching proudly with arms folded. It's not perfect, but it works. Skill passed down. At home.`, wordTarget: wt },
        { spread: 12, beat: 'TOOL_PUT_AWAY',      description: `Closing the toolbox together. ${p} and ${n}'s hands are both a little dirty, a little calloused. The best kind of hands. NOT bedtime. Workshop.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. Broken things are just adventures waiting for the right hands. Echo the crash. Warm, fixed, stronger.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'camping_trip',
    name: 'The Camping Trip',
    synopsis: 'Dad and child camp out — setting up the tent, building a fire, telling stories under the stars. Morning pancakes make it perfect.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      const p = opts.parentName || 'Daddy';
      return [
        { spread: 1,  beat: 'ARRIVAL',            description: `${p} and ${n} arrive at the campsite — packs on backs, ground soft under boots. Trees tall, sky wide. "This is the spot." Campsite.`, wordTarget: wt },
        { spread: 2,  beat: 'TENT_SETUP',         description: `Setting up the tent — poles that don't fit, fabric that billows, ${n} holding one end while ${p} stakes the other. It takes three tries. Campsite.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'CAMP_EXPLORATION',   description: `Exploring the surroundings — a stream nearby, interesting trees, animal tracks in the mud. ${p} and ${n} claim the territory together. Near campsite.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'FIRE_BUILDING',      description: `Building a campfire. ${n} gathers sticks, ${p} arranges them. The first match goes out. The second catches. Flames lick and grow. Campsite.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'CAMPFIRE_COOKING',   description: `Cooking over the fire — marshmallows on sticks, something in tin foil. ${n}'s marshmallow catches fire. ${p} rescues it. Both laugh. Campfire.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'STORIES',            description: `${p} tells a story by firelight — voices changing, hands waving, shadows dancing. ${n} listens with wide eyes and a sticky face. Campfire.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'NS_STORY',           description: `${n}'s turn to tell a story. It's wild, it makes no sense, it's the best story ${p} has ever heard. ${p} claps at the end. Campfire.`, wordTarget: wt },
        { spread: 8,  beat: 'STARGAZING',         description: `Lying on their backs. Stars everywhere — thick, bright, more than either has ever seen. ${p} points out shapes. ${n} invents new ones. Fewest words. Campsite.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 9,  beat: 'NIGHT_SOUNDS',       description: `Zipped in the tent. Sounds of the forest — crickets, an owl, something rustling. ${n} grabs ${p}'s arm. ${p} whispers: "That's just a hedgehog." Tent.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'MORNING_LIGHT',      description: `Dawn light through the tent canvas. ${n} wakes first, peeks outside. The world is dewy, golden, quiet. Shakes ${p}'s shoulder. "Wake up." Tent.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'PANCAKES',           description: `Campfire pancakes. ${p} flips them (one lands on the ground, picked up, brushed off, eaten anyway). The best breakfast ever. Campsite.`, wordTarget: wt },
        { spread: 12, beat: 'PACKING_UP',         description: `Packing up the campsite. ${p} and ${n} take one last look at their spot. They'll be back. Fist bump. NOT bedtime. Campsite.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. The best ceilings are the ones made of stars. Echo the arrival. Warm, smoky, wild.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'race_day',
    name: 'The Race Day',
    synopsis: 'A day of friendly competition — who runs fastest, jumps highest, eats the most pancakes. Every contest ends in laughter and a tie.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      const p = opts.parentName || 'Daddy';
      return [
        { spread: 1,  beat: 'CHALLENGE_ISSUED',   description: `${n} looks at ${p}. "Race you." ${p} looks at ${n}. "You're on." They shake hands solemnly. The competition begins. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_RACE',         description: `Sprint to the tree and back! ${p} runs with exaggerated slowness. ${n} runs full tilt. ${n} wins by a mile. Victory dance. Garden.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'JUMP_CONTEST',       description: `Who can jump the highest? ${p} does a huge jump. ${n} does a smaller jump but with better form. They measure with a stick. "Tie!" Garden.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'BALANCE_CHALLENGE',  description: `Standing on one foot. ${p} wobbles immediately. ${n} stands steady as a flamingo. ${p} topples. ${n} wins balance. Garden.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'SILLY_CONTEST',      description: `Silliest face contest. ${p} pulls a monster face. ${n} pulls a face so silly that ${p} can't stop laughing. No one wins because everyone is crying with laughter. Garden.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'EATING_CONTEST',     description: `Pancake-eating contest at the table. Stack them up. Ready, set, EAT. ${p} chews like a machine. ${n} chews very seriously. Syrup everywhere. Kitchen.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'REST_ROUND',         description: `Both lying on the grass, full of pancakes, breathing hard. A brief ceasefire. Clouds pass overhead. The competitive spirit rests. Fewest words. Garden.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'OBSTACLE_COURSE',    description: `An obstacle course — over the bush, under the rope, around the tree, through the sprinkler. ${p} and ${n} run it side by side. Garden.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'PHOTO_FINISH',       description: `The final race — the big one. Down the sidewalk and back. They run together, stride for stride. A photo finish. Too close to call. The street.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'THE_VERDICT',        description: `They declare it a perfect tie. Handshake. Then ${p} hoists ${n} up on shoulders — the real champion. Victory parade around the yard. Garden.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'TROPHY_MAKING',      description: `${n} makes a trophy from cardboard and foil. Writes "BEST DAD" on it. Hands it to ${p} with ceremony. ${p} holds it like gold. At home.`, wordTarget: wt },
        { spread: 12, beat: 'COOLING_DOWN',       description: `On the porch, sharing a cold drink. Muscles sore, smiles permanent. ${p} and ${n} clink glasses. "Rematch tomorrow?" NOT bedtime. Porch.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. The best competitions end in a tie and a hug. Echo the handshake. Warm, breathless, evenly matched.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'teaching_moment',
    name: 'The Teaching Moment',
    synopsis: 'Dad teaches a skill — riding a bike, casting a line, skipping stones. Patient instruction, spectacular failure, and the moment everything clicks.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      const p = opts.parentName || 'Daddy';
      return [
        { spread: 1,  beat: 'THE_SKILL',          description: `${p} holds the thing — a bike, a fishing rod, a flat stone. "Today's the day, ${n}." ${n} looks at it with a mix of thrill and doubt. Outdoors.`, wordTarget: wt },
        { spread: 2,  beat: 'DEMONSTRATION',      description: `${p} demonstrates. Makes it look effortless. The cast is perfect, the stone skips five times, the bike glides. "See? Easy." ${n} gulps. Outdoors.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_TRY',          description: `${n} tries. Complete disaster — wobble, splash, plonk. ${p} catches ${n} or catches the thing. "Great first try!" (It was not great.) Outdoors.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'ADJUSTMENTS',        description: `${p} kneels beside ${n}. Adjusts the grip, the stance, the angle. Gentle hands repositioning. "Like this. Feel that?" Outdoors.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'PRACTICE_MONTAGE',   description: `Try after try. Some better, some worse. ${p} retrieves, resets, encourages. ${n}'s jaw sets harder each time. Determination. Outdoors.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'FRUSTRATION',        description: `${n} throws hands up. "I'll NEVER get it." Sits down hard. ${p} sits beside. No lecture. Just a shoulder bump and silence. Outdoors.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'DADS_SECRET',        description: `${p} tells a secret: "It took me a whole summer. I cried once." ${n} looks up, disbelieving. "${p} cried?" "Big old tears." Outdoors.`, wordTarget: wt },
        { spread: 8,  beat: 'THE_CLICK',          description: `${n} tries one more time. And it happens — the bike balances, the stone skips, the cast flies. The moment everything connects. Fewest words. Outdoors.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 9,  beat: 'EXPLOSION',          description: `${p} erupts. Fist pump, shout, scoop-up. ${n} does it again, laughing. Then again. It's real. It's learned. Maximum celebration. Outdoors.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'MASTERY',            description: `${n} gets bolder — going further, casting longer, riding faster. ${p} watches with crossed arms and the biggest smile in the world. Outdoors.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'SIDE_BY_SIDE',       description: `They do it together — riding side by side, casting into the same water, skipping stones in rhythm. Equals now. Outdoors.`, wordTarget: wt },
        { spread: 12, beat: 'HEADING_HOME',       description: `Walking home. ${n} carries the thing like a trophy. ${p} walks with hands in pockets, pride radiating off every step. NOT bedtime. Heading home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. The best skills pass from big hands to small ones and back again. Echo the first demonstration. Warm, learned, shared.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'surprise_breakfast',
    name: 'The Surprise Breakfast',
    synopsis: 'The child wakes early to make breakfast for Dad. Kitchen chaos, creative pancakes, a teetering tray, and the best morning Dad ever had.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      const p = opts.parentName || 'Daddy';
      return [
        { spread: 1,  beat: 'EARLY_WAKING',       description: `${n} wakes before the sun. Tiptoes past ${p}'s door — snoring inside. Mission: the greatest breakfast ever made. Hallway.`, wordTarget: wt },
        { spread: 2,  beat: 'KITCHEN_SURVEY',     description: `In the kitchen, ${n} surveys the territory. Pans, eggs, flour. This should be simple. (It will not be simple.) Kitchen.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'PANCAKE_ATTEMPT',    description: `Pancake batter: too thick, add water. Too thin, add flour. ${n}'s arms get tired stirring. Batter splashes on the ceiling. Kitchen.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'COOKING',            description: `Pancakes in the pan — some shaped like circles, one shaped like a boot, one shaped like ${p}'s head (sort of). The kitchen smells amazing. Kitchen.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'ORANGE_JUICE',       description: `Squeezing orange juice with maximum effort. Seeds everywhere. ${n} filters them out with fingers (mostly). Pours into ${p}'s favorite mug. Kitchen.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'THE_MESS',           description: `The kitchen is a disaster zone — flour footprints, a trail of syrup, a tower of dirty dishes. But the plate looks beautiful. Kitchen.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'TRAY_ASSEMBLY',      description: `Loading the tray: plate of pancakes, juice, a flower from the garden (with some dirt still attached). ${n} draws a quick card: "For the best ${p}." Kitchen.`, wordTarget: wt },
        { spread: 8,  beat: 'THE_CARRY',          description: `Carrying the tray down the hall. It wobbles. The juice slides. ${n} walks in slow motion, tongue out in concentration. Fewest words. Hallway.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 9,  beat: 'DELIVERY',           description: `${n} pushes open ${p}'s door. "SURPRISE!" ${p} sits up, blinking. Sees the tray, the card, the flower, ${n}'s flour-covered face. ${p}'s bedroom.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'FIRST_BITE',         description: `${p} takes a bite. The pancake is lumpy and perfect. "${n}, this is the best breakfast I've ever had." Means every word. ${p}'s bedroom.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'SHARING',            description: `${n} climbs onto the bed. They share the pancakes, passing the fork back and forth. Crumbs on the sheets. Neither cares. ${p}'s bedroom.`, wordTarget: wt },
        { spread: 12, beat: 'KITCHEN_REVEAL',     description: `${p} sees the kitchen. A beat of wide eyes. Then ${p} laughs and says, "Let's clean up together." Side by side at the sink. NOT bedtime. Kitchen.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. The messiest kitchens make the most love. Echo the tiptoe. Warm, flour-dusted, delicious.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'workshop',
    name: 'The Workshop Day',
    synopsis: 'In Dad\'s workshop, everything is possible — sawdust and accomplishment, tinkering and inventing. The child learns that making things with your hands is magic.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      const p = opts.parentName || 'Daddy';
      return [
        { spread: 1,  beat: 'WORKSHOP_DOOR',      description: `${p} opens the workshop door. The smell hits — sawdust, oil, something metallic. Tools on every wall. ${n}'s eyes go wide. Workshop.`, wordTarget: wt },
        { spread: 2,  beat: 'TOOL_TOUR',          description: `${p} shows ${n} the tools — "This sands, this cuts, this holds." ${n} touches each one carefully. The workshop is a treasure chest. Workshop.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_PROJECT',      description: `A small project — sanding a block of wood until it's smooth as glass. ${n} rubs back and forth, watching the grain appear. Workshop.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'MEASURING',          description: `${p} shows ${n} how to measure. Pencil behind the ear. "Measure twice, cut once." ${n} measures three times, just to be safe. Workshop.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'TINKERING',          description: `They take something apart to see how it works — gears, springs, screws. ${n} lines up every piece. The inside of things is fascinating. Workshop.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'INVENTION',          description: `${n} invents something from the parts — it's weird, it's wonderful, it might not work. ${p} helps make it real. Glue, wire, imagination. Workshop.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'SAWDUST_MOMENT',     description: `A beam of light through the workshop window catches sawdust floating in the air. ${n} and ${p} stand in the golden dust, breathing it in. Fewest words. Workshop.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'BIGGER_BUILD',       description: `They tackle something bigger — a shelf, a box, a stool. ${p} guides, ${n} executes. The thing takes shape under four hands. Workshop.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'PAINTING',           description: `Painting the finished piece. ${n} chooses the color. ${p} does the edges, ${n} does the big strokes. It gleams when done. Workshop.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'NAME_CARVING',       description: `${p} helps ${n} carve both their initials into the bottom of the thing. Tiny letters in wood. Their mark. Workshop.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'CLEAN_UP',           description: `Sweeping sawdust, hanging tools, wiping the bench. The workshop returns to order. ${n} knows where everything goes now. Workshop.`, wordTarget: wt },
        { spread: 12, beat: 'CARRYING_IT_IN',     description: `${p} and ${n} carry their creation into the house. Find the perfect spot. Step back and admire. Sawdust in both their hair. NOT bedtime. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. The workshop is where hands learn to think. Echo the door opening. Warm, sawdust-golden, made.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'sports_day',
    name: 'The Sports Day',
    synopsis: 'Dad and child play every sport they can think of — catch, kickball, racing, wrestling. Physical joy, breathless laughter, and the purest kind of fun.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      const p = opts.parentName || 'Daddy';
      return [
        { spread: 1,  beat: 'GRABBING_GEAR',      description: `${p} and ${n} raid the garage — a ball, a bat, a frisbee, a jump rope. Arms full, they head to the yard. "Sports day!" Garden.`, wordTarget: wt },
        { spread: 2,  beat: 'WARM_UP',            description: `Stretching together — ${p}'s stretches are stiff, ${n}'s are bendy. Jumping jacks in sync. ${n} does twice as many. Garden.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'CATCH',              description: `Playing catch. ${p} throws easy. ${n} catches, throws back hard. The ball goes over ${p}'s head. Both run for it. Garden.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'KICKBALL',           description: `${p} rolls the ball. ${n} kicks it — WHAM — past ${p}, past the fence, into the neighbor's yard. High five. Stunned silence. Then cheering. Garden.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'WRESTLING',          description: `Grass wrestling. ${n} climbs on ${p}'s back. ${p} pretends to collapse. ${n} pins ${p} down. Referee counts to three. Champion crowned. Garden.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'FRISBEE',            description: `Frisbee throw — it curves, dips, sails into the bushes. They fish it out. Try again. This time: a perfect arc between them. Garden.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'WATER_BREAK',        description: `Collapsed on the grass, passing a water bottle between them. Hearts pounding, grass stains on everything. The best tired. Fewest words. Garden.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'NEW_GAME',           description: `They invent a new sport — rules made up on the spot, equipment improvised. It involves a bucket, a tennis ball, and spinning. It makes no sense. It's perfect. Garden.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'SPRINKLER_RUN',      description: `The sprinkler comes on. They run through it screaming. ${p} slides on the wet grass. ${n} slides on purpose. Maximum chaos and joy. Garden.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'LAST_PLAY',          description: `One more game — a slow, careful game of catch as the sun lowers. Throw, catch, throw, catch. The rhythm of it is its own kind of music. Garden.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'HEADING_IN',         description: `Carrying all the gear back inside, dripping and grass-stained. ${p}'s legs are sore. ${n} is still bouncing. Garden to home.`, wordTarget: wt },
        { spread: 12, beat: 'VICTORY_POSE',       description: `On the couch, both triumphantly exhausted. ${n} flexes a tiny muscle. ${p} flexes a bigger one. Then they fist-bump. NOT bedtime. Living room.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. The best games don't need a score — just two people who show up and play hard. Echo the gear grab. Warm, breathless, played out.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'treasure_hunt',
    name: 'The Treasure Hunt',
    synopsis: 'Dad hides clues all over the house and yard. The child solves each one, following the trail to a surprise that was worth every riddle.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      const p = opts.parentName || 'Daddy';
      return [
        { spread: 1,  beat: 'FIRST_CLUE',         description: `${n} finds a note on the pillow. ${p}'s handwriting: "Look where we keep the cold things." ${n} leaps out of bed. The hunt is on. Bedroom.`, wordTarget: wt },
        { spread: 2,  beat: 'FRIDGE_CLUE',        description: `In the fridge, between the milk and the cheese: another note. "Check the place where feet get clean." ${n} races to the bathroom. Kitchen.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'BATHROOM_CLUE',      description: `Taped to the bathtub: "Now go where the books live." ${n} tears through the house. ${p} watches from behind a newspaper, pretending innocence. Bathroom.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'BOOKSHELF_CLUE',     description: `Behind a book: a clue with a drawing — a wobbly picture of a tree. ${n} knows which tree. Sprints outside. Bookshelf to garden.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'TREE_CLUE',          description: `In the crook of the tree: a note and a tiny toy. "Getting warmer! Check under the flower pot." ${n} collects the toy and runs. Garden.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'FLOWER_POT_CLUE',    description: `Under the flower pot: a riddle. "${n} reads it twice, mutters, thinks. ${p} offers no help. Hands in pockets, whistling. Garden.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'SOLVING',            description: `The answer clicks. ${n}'s face lights up. "THE MAILBOX!" Takes off running. ${p} tries to keep up. Fewest words. Garden.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'MAILBOX_CLUE',       description: `In the mailbox: "Almost there! The last clue is where ${p} keeps the secret snacks." ${n} gasps — knows exactly where. Front yard.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'SECRET_SPOT',        description: `${n} opens the cabinet, the drawer, the box — and there it is. The treasure. Something wonderful, wrapped in ${p}'s terrible wrapping job. At home.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'UNWRAPPING',         description: `${n} unwraps the treasure. Eyes go wide. It's exactly right — something connected to ${n}'s interests, chosen with thought and love. At home.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'THE_REVEAL',         description: `${n} looks at ${p}. "You did all this?" ${p} shrugs, grinning. ${n} tackles ${p} with a hug that knocks them both onto the couch. Living room.`, wordTarget: wt },
        { spread: 12, beat: 'CLUE_COLLECTION',    description: `${n} gathers all the notes and clues and pins them on the wall. The trail told a story. ${p}'s story. NOT bedtime. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. The real treasure is always the trail that gets you there. Echo the first note on the pillow. Warm, hunted, found.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'fort_day',
    name: 'The Fort Day',
    synopsis: 'Dad and child build the ultimate indoor fort — couch cushions, blankets, flashlights — and defend it from imaginary invaders all day.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      const p = opts.parentName || 'Daddy';
      return [
        { spread: 1,  beat: 'BATTLE_CRY',         description: `${n} stands on the couch and declares: "We need a fort!" ${p} salutes. "Reporting for duty." The mission begins. Living room.`, wordTarget: wt },
        { spread: 2,  beat: 'CONSTRUCTION',        description: `Cushions pulled from every couch. Blankets stripped from every bed. Chairs repositioned as walls. ${p} is the engineer, ${n} is the foreman. Living room.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'ARCHITECTURE',        description: `The fort grows — tunnels, rooms, a lookout tower (a chair with a blanket on top). ${p} crawls through checking structural integrity. Living room.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'FORTIFICATION',       description: `Defenses installed — pillow barricades, stuffed animal guards, a cardboard drawbridge. ${n} draws a flag and plants it on top. Living room.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'MOVING_IN',           description: `Inside the fort: flashlights, snacks, books, ${n}'s favorite blanket. It's a proper home. ${p} can barely fit but squeezes in. Fort.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'FIRST_ATTACK',        description: `"INVADERS!" (The cat walks by.) ${n} and ${p} defend the fort with pillow launches. The cat is unimpressed but the fort holds. Fort.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'PEACE_TIME',          description: `No invaders. ${p} and ${n} lie in the fort, flashlight making shadows on the blanket ceiling. Whispering secrets. Fewest words. Fort.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'SNACK_TIME',          description: `Fort snacks: crackers, cheese, apples cut into swords. ${p} and ${n} eat like medieval royalty in their blanket castle. Fort.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'BIG_BATTLE',          description: `The biggest imaginary battle — dragons, robots, aliens, all at once. ${p} and ${n} fight them off with pillow swords and battle cries. Fort.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'VICTORY',             description: `The invaders retreat! ${p} and ${n} raise the flag higher. The fort stands victorious. Chest bumps and war cries of celebration. Fort.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'EXHAUSTED_HEROES',   description: `Lying in the fort, exhausted from battle. The flashlight dims. The blanket walls breathe. Heroes at rest. Fort.`, wordTarget: wt },
        { spread: 12, beat: 'FORT_FOREVER',       description: `${n} declares the fort is never coming down. ${p} agrees (knowing it will, but not today). They bump fists in the fort light. NOT bedtime. Fort.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. The bravest forts are built from blankets and defended by love. Echo the battle cry. Warm, cushioned, undefeated.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
];
