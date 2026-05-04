/**
 * Love to mom plot templates — 12 structurally distinct story arcs.
 *
 * SCOPE (important): These plot templates are consumed ONLY by `WriterEngine`
 * (services/writer/engine.js), which today is invoked exclusively from the
 * `POST /qa/generate-story` SSE endpoint in server.js (admin / QA tool).
 * The customer-facing book generation pipeline goes through
 * `services/bookPipeline/*` and does NOT consume these templates — see
 * `services/bookPipeline/planner/themeDirectives.js` for the parent-theme
 * guidance the production planner actually reads (qualityBar +
 * peakMomentPatterns landed there in Workstream E).
 *
 * If you want a change to affect customer books, edit themeDirectives.js, not
 * this file. If you want a change to affect the QA streaming preview only,
 * edit here.
 *
 * Each template returns 13 spreads in 4-scene (A/B/C/D) grouping.
 * opts: { child, isYoung, wt, parentName, book, theme }
 *
 * PARENT THEME: Mom is a visible character in every spread.
 */

module.exports = [
  {
    id: 'classic_journey',
    name: 'Classic Journey',
    synopsis: 'Mom and child set out on a small but specific shared mission — to deliver, fetch, plant, or place one particular thing at one particular spot — and the day turns the errand into a love letter, with the child leading them home and giving Mom a small surprise that lives on the windowsill afterward.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      const p = opts.parentName || 'Mama';
      return [
        // 1. HOME_OPENING — name the SHARED MISSION + a parent-specific morning ritual (anecdote slot).
        { spread: 1,  beat: 'HOME_OPENING_RITUAL', description: `Morning at home. ${p} is doing the small ritual only this pair shares (humming a specific tune, setting down a particular mug, tying shoes a particular way — pull from the questionnaire). ${p} looks up: "Today's the day we go." The day has a clear shared mission — name a SPECIFIC small errand they're heading out to do together (carry the loaf to the bench by the river, plant the seed in the windowsill pot at home, deliver the drawing to a neighbor, pick the right flower for the kitchen jar). Vivid, sensory, the opener echoes again at spread 13. At home.`, wordTarget: wt, parentVisibility: 'full' },
        // 2. SETTING_OUT — mission tools in hand; the world greets them.
        { spread: 2,  beat: 'SETTING_OUT_TOGETHER', description: `${n} and ${p} step out the front door, mission tools in hand (the basket, the thermos, the folded note, the small map, the seed packet). Same shared mission as spread 1 — they're not just "going somewhere", they're going to do that ONE thing. The street greets them. Leaving home.`, wordTarget: wt + 2, parentVisibility: 'full' },
        // 3. JOURNEY_DETAIL — the in-joke / shared eye (anecdote slot).
        { spread: 3,  beat: 'JOURNEY_INJOKE',     description: `Walking together — sidewalk, shops, trees. ${n} points at the thing only this pair notices (the cracked tile they always step over, the curtain in the upstairs window, the dog they always wave at). ${p} laughs the laugh they share. The bond is being SHOWN, not stated.`, wordTarget: wt + 2, parentVisibility: 'shoulder-back' },
        // 4. SMALL HITCH — rising stakes that matter to the bond.
        { spread: 4,  beat: 'SMALL_HITCH',        description: `A small thing goes wrong with the mission — the bakery line is long, the bench they were heading for is taken, the seed packet got crinkled, the flower they wanted is wilted. ${p} catches ${n}'s eye and raises an eyebrow. Real (small) stakes — will they still pull this off?`, wordTarget: wt + 2, parentVisibility: 'full' },
        // 5. PIVOT TOGETHER — they solve it together with a parent-specific twist.
        { spread: 5,  beat: 'PIVOT_TOGETHER',     description: `They pivot together. ${n} suggests something only ${n} would suggest (the silly route, the second flower, the workaround ${p} would never think of). ${p}'s grin says "yes, that". They take the new way. Hands at work — tucking the note, picking the better flower, choosing the next street.`, wordTarget: wt + 2, parentVisibility: 'hand' },
        // 6. BOND-MIRROR BEAT — the world recognizes the pair.
        { spread: 6,  beat: 'WORLD_KNOWS_THEM',   description: `On the way, the world recognizes them. Pick ONE: the regular bus driver waves like always, the corner cat finds her usual spot between their feet, the bakery owner already has the small treat ready in a paper bag, the breeze tugs both their scarves the same way. The pair is part of this neighborhood and the neighborhood knows them. One beat, not pervasive.`, wordTarget: wt + 2, parentVisibility: 'shoulder-back' },
        // 7. DESTINATION REACHED — quiet, smaller than the build-up.
        { spread: 7,  beat: 'DESTINATION_REACHED', description: `They arrive at the specific spot named in spread 1. It is smaller and simpler than the build-up suggested — one bench, one gate, one baker's counter, one sunny patch of windowsill. ${p} kneels or sits; ${n} mirrors. The mission is right here.`, wordTarget: wt, parentVisibility: 'full' },
        // 8. BOND_PEAK — the WONDER beat, image-led, fewest words. Quiet recognition pattern.
        { spread: 8,  beat: 'BOND_PEAK',          description: `The quietest beat in the book — and the most beautiful image. Choose ONE single visual that crystallizes the bond: ${n}'s and ${p}'s silhouettes overlap on a sunlit wall as they lean toward each other; both hands rest on the same flower / loaf / drawing at the same moment; their two reflections hold one shape in a window; one shoelace and one apron tie meet in the same knot in the lap. Image-led. Fewest words. The whole day fits inside this picture. Same place as spread 7.`, wordTarget: opts.isYoung ? 12 : 15, parentVisibility: 'shadow' },
        // 9. CHILD_LEADS_BACK — the agency turn. Child uses what they know about the parent.
        { spread: 9,  beat: 'CHILD_LEADS_BACK',   description: `${n} takes ${p}'s hand and announces the way home — and chooses the route ${p} loves (the long way past the bookshop window, the back path under the maple, the shortcut through the school yard). ${n} is leading because ${n} knows ${p}. The day's emotional weight pivots: ${n} becomes the one carrying ${p}.`, wordTarget: wt + 2, parentVisibility: 'hand' },
        // 10. THE GIVING / REVEAL — payoff of the secret tucked in the child's pocket since spread 2.
        { spread: 10, beat: 'THE_GIVING',         description: `At the doorstep — or the kitchen window, the bench, the bedroom shelf — ${n} reveals the small secret they have been carrying since this morning: a folded drawing, a flower picked back at the corner, the receipt slipped into ${p}'s pocket, the photo ${n} took with the phone earlier. Held out with both hands. The mission's real payoff lands here.`, wordTarget: wt + 2, parentVisibility: 'full' },
        // 11. PARENT'S FACE CHANGES — visible reception. Works whether parent is on cover or implied.
        { spread: 11, beat: 'PARENT_RESPONSE',    description: `${p}'s response. If ${p} is on the cover, render the face: eyes shining, hand to heart, the breath that catches before words. If ${p} is implied, render the same beat through what we CAN see — ${p}'s hand pressed to chest, the cardigan rising and falling, ${n} watching their face glow. Either way, ${n} sees that they landed. This is the emotional climax.`, wordTarget: wt, parentVisibility: 'full' },
        // 12. TOGETHER IN THE AFTERGLOW — the gift placed where it will live.
        { spread: 12, beat: 'TOGETHER_AFTERGLOW',  description: `They're together in the afterglow of the giving. The flower is in the jar on the windowsill, the drawing is on the fridge, the seed is in the pot, the photo is in the frame on the shelf. ${n} and ${p} look at it side by side, shoulders touching. The mission's tangible payoff is now part of the home. NOT bedtime. At home.`, wordTarget: wt, parentVisibility: 'full' },
        // 13. ECHO TRANSFORMED — same morning ritual as spread 1, but now child initiates it.
        { spread: 13, beat: 'ECHO_TRANSFORMED',   description: `The closing image. Echo the spread-1 morning ritual — but transformed: ${n} now does the thing ${p} did this morning (hums the tune, sets the mug down, ties the shoe the way ${p} does), and ${p} watches with the expression ${n} woke up to. The ritual passed between them today and now belongs to both. The most beautiful sentence. Daylight or warm lamp glow. NOT bedtime.`, wordTarget: opts.isYoung ? 12 : 15, parentVisibility: 'full' },
      ];
    },
  },
  {
    id: 'builder',
    name: 'Building Together',
    synopsis: 'Mom and child build something together — a fort, a birdhouse, a garden box. The process is messy, funny, and triumphant.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      const p = opts.parentName || 'Mama';
      return [
        { spread: 1,  beat: 'THE_IDEA',           description: `${p} and ${n} stand in the yard with a pile of supplies — wood, fabric, string, paint. "Let's build something," ${p} says. Garden.`, wordTarget: wt },
        { spread: 2,  beat: 'PLANNING',           description: `They draw plans on the ground with a stick. ${n} adds wings and a tower. ${p} adds a door. The plan grows wilder. Garden.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_PIECES',       description: `Building begins. ${p} holds boards while ${n} hammers (carefully). Something wobbles. They brace it together. Teamwork. Garden.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'FIRST_MISTAKE',      description: `Something falls over. ${p} and ${n} look at each other — then burst out laughing. They start that part again, better this time. Garden.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'TAKING_SHAPE',       description: `The structure takes shape — walls, a roof, a window. ${n} runs inside to test it. "It's perfect!" ${p} peeks through the window. Garden.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'DECORATING',         description: `Painting time. ${p} paints one wall, ${n} paints another. Colors everywhere — some on the walls, some on each other. Garden.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'PAINT_BATTLE',       description: `${n} dabs paint on ${p}'s nose. ${p} stripes ${n}'s cheek. A brief, glorious paint war. Both covered, both laughing. Garden.`, wordTarget: wt },
        { spread: 8,  beat: 'QUIET_WORK',         description: `Working on a small detail together — a nameplate, a flag, a carved initial. Side by side, focused, breathing in rhythm. Fewest words. Garden.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 9,  beat: 'FINISHED',           description: `They step back. It's done. Crooked, colorful, and absolutely magnificent. ${p} puts an arm around ${n}. Maximum pride. Garden.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'FIRST_USE',          description: `Testing it out — sitting inside, hanging the flag, inviting the first guest (a stuffed animal, a bird, the cat). It works. Garden.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'ADMIRING',           description: `From a distance, they look at what they built together. ${p} and ${n}'s creation, standing in the yard. It's theirs. Garden.`, wordTarget: wt },
        { spread: 12, beat: 'RESTING',            description: `${p} and ${n} sit inside their creation, paint-stained and tired and proud. ${n} leans into ${p}. "We built this." NOT bedtime. Garden.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. The things you build together stand the longest. Echo the supply pile. Warm, built, shared.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'role_reversal',
    name: 'The Role Reversal',
    synopsis: 'The child "becomes" Mom for a day — making breakfast, reading stories, organizing the house. Hilarious attempts, tender moments, and a new understanding.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      const p = opts.parentName || 'Mama';
      return [
        { spread: 1,  beat: 'ANNOUNCEMENT',       description: `${n} stands at ${p}'s door and declares: "Today I'm the ${p}." Wearing ${p}'s cardigan, holding a spatula like a scepter. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'BREAKFAST_ATTEMPT',  description: `${n} makes breakfast — cereal first (easy), then toast (slightly burned), then an egg (very dramatic). ${p} watches from the table, hiding a smile. Kitchen.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SERVING',            description: `Breakfast is served with great ceremony. The toast is wonky, the juice is spilled, but ${n} presents it with a bow. ${p} eats every bite. Kitchen.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'TIDYING_UP',         description: `${n} tries to tidy up. Puts things in wrong drawers. Folds laundry into balls. Sweeps dust under the rug. Very serious about it. At home.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'READING_STORY',      description: `${n} reads ${p} a story — holding the book the way ${p} does, doing all the voices (badly but with heart). ${p} listens, enchanted. Living room.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'PROBLEM_SOLVING',    description: `A small crisis — the cat knocks something over, a drawer gets stuck. ${n} handles it with exaggerated seriousness. ${p} stifles laughter. At home.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'SNACK_TIME',         description: `${n} prepares a snack for ${p} — crackers arranged in a heart shape, apple slices in a fan. "You need to eat, ${p}." Adorable authority. Kitchen.`, wordTarget: wt },
        { spread: 8,  beat: 'TIRED_MOM',          description: `${n} flops on the couch. "Being ${p} is HARD." ${p} sits beside ${n} and nods knowingly. A beat of mutual understanding. Fewest words. Living room.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 9,  beat: 'SECOND_WIND',        description: `${n} jumps up — there's more to do! Organizes the shoes (by color, not size), waters the plants (too much), sings while working. At home.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'FINAL_ACT',          description: `${n}'s last duty: tucking ${p} in on the couch with a blanket. Placing a pillow just so. A pat on the head. Role reversal perfected. Living room.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'BREAKING_CHARACTER', description: `${n} can't hold it anymore — jumps on the couch and cuddles ${p}. The role reversal dissolves into giggles. Back to being ${n}. Living room.`, wordTarget: wt },
        { spread: 12, beat: 'TOGETHER',           description: `${p} and ${n} sit together, ${p}'s cardigan still on ${n}'s shoulders. "You were the best ${p} ever." "You're the best ${n}." NOT bedtime. Living room.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. The hardest job in the world is the one that makes everyone's day better. Echo the spatula scepter. Warm, funny, understood.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'recipe_together',
    name: 'The Recipe Together',
    synopsis: 'Mom and child cook a special dish together — measuring, mixing, tasting, burning one thing, rescuing another. The messiest, most delicious day.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      const p = opts.parentName || 'Mama';
      return [
        { spread: 1,  beat: 'RECIPE_CARD',        description: `${p} pulls out a recipe card — old, stained, with handwriting from someone who came before. "${n}, let's make this together." Kitchen.`, wordTarget: wt },
        { spread: 2,  beat: 'GATHERING',          description: `Ingredients pile up on the counter. ${p} reads the list, ${n} fetches each one. Flour, eggs, something fragrant. Kitchen.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'MEASURING',          description: `${n} pours carefully — too much flour poofs into a cloud. ${p} wipes a white streak off ${n}'s face. Both grinning. Kitchen.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'MIXING',             description: `Stirring together — ${p}'s big hand over ${n}'s small one on the spoon. The batter turns smooth and golden. Teamwork at its simplest. Kitchen.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'TASTE_TEST',         description: `"Let's test it." ${p} holds out the spoon. ${n} tastes — eyes go wide. "More sugar?" "More sugar." They add a pinch and taste again. Kitchen.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'COOKING',            description: `Into the oven or onto the stove. ${p} handles the heat, ${n} watches through the glass. The smell starts to fill the house. Kitchen.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'SMALL_DISASTER',     description: `Something goes slightly wrong — a bubble over, a timer missed, a bit too brown. ${p} rescues it with a quick move. ${n} cheers. Kitchen.`, wordTarget: wt },
        { spread: 8,  beat: 'WAITING',            description: `Sitting on the kitchen floor together while the dish cooks. ${p} tells ${n} about the first time this recipe was made. Fewest words. Kitchen.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 9,  beat: 'ITS_READY',          description: `The dish comes out. Steam rises. ${p} and ${n} lean in and inhale. It smells like home, like always, like theirs now. Kitchen.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'FIRST_BITE',         description: `Plates served. They sit across from each other. First bite at the same time. Eyes meet. It's perfect. The best meal ever made. Dining table.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'MESSY_KITCHEN',      description: `The kitchen is a disaster — flour on every surface, dishes piled, something sticky on the ceiling. But the food was worth it. Kitchen.`, wordTarget: wt },
        { spread: 12, beat: 'CLEANING_TOGETHER',  description: `${p} washes, ${n} dries. Suds fly. ${n} puts the recipe card back, now with a new stain. Their stain. NOT bedtime. Kitchen.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. The best recipes pass through hands before they pass through pages. Echo the old card. Warm, flour-dusted, delicious.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'rainy_day_in',
    name: 'The Rainy Day In',
    synopsis: 'Stuck inside on a rainy day, Mom and child transform the house into a world of imagination — blanket forts, paper boats, shadow puppets, and couch-cushion mountains.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      const p = opts.parentName || 'Mama';
      return [
        { spread: 1,  beat: 'RAIN_STARTS',        description: `Rain hammers the windows. ${n} presses a face against the glass. "We're stuck inside." ${p} grins. "No. We're free inside." At home.`, wordTarget: wt },
        { spread: 2,  beat: 'FORT_BUILDING',      description: `Blankets yanked from every bed. Chairs overturned. ${p} and ${n} build the most magnificent blanket fort the living room has ever seen. Living room.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'INSIDE_THE_FORT',    description: `Inside the fort: flashlights, pillows, stuffed animals. ${p} and ${n} lie face to face, voices echoing. A secret world for two. Fort.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'PAPER_BOATS',        description: `${p} folds paper boats. ${n} folds paper boats (less boat-shaped, more blob-shaped). They launch them in the bathtub — a regatta. Bathroom.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'CUSHION_MOUNTAINS',  description: `Couch cushions become mountains. ${n} and ${p} climb them, plant a flag (a sock on a ruler), declare the summit reached. Living room.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'SHADOW_PUPPETS',     description: `Flashlight against the wall: ${p} makes a rabbit, ${n} makes a... something. They perform a story — the rabbit meets the something. Living room.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'DANCE_BREAK',        description: `Music on. ${p} and ${n} dance in the living room — silly dances, spinning dances, a slow dance standing on ${p}'s feet. Living room.`, wordTarget: wt },
        { spread: 8,  beat: 'RAIN_LISTENING',     description: `They pause, lying on the floor, listening to the rain on the roof. The sound wraps around them. The coziest moment. Fewest words. Living room.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 9,  beat: 'ART_SESSION',        description: `Paper and crayons spread on the floor. ${p} draws ${n}. ${n} draws ${p}. They swap and laugh at the results. Living room.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'SNACK_PICNIC',       description: `Indoor picnic on the fort floor — crackers, cheese, apple slices. A candle in the middle (flameless). The fanciest rainy-day meal. Fort.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'RAIN_STOPS',         description: `The rain eases. Light creeps in. But neither ${p} nor ${n} moves. Inside is still better today. At home.`, wordTarget: wt },
        { spread: 12, beat: 'COZY_TOGETHER',      description: `In the fort, ${p} and ${n} lean together, the house a happy wreck around them. The rain was the best thing that happened. NOT bedtime. Fort.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. The best adventures don't need a door — just a blanket, a flashlight, and each other. Echo the rain. Warm, inside, infinite.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'teaching_moment',
    name: 'The Teaching Moment',
    synopsis: 'Mom teaches the child a new skill — riding a bike, tying a knot, painting, swimming. The failures are funny, the patience is real, and the triumph belongs to both of them.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      const p = opts.parentName || 'Mama';
      return [
        { spread: 1,  beat: 'THE_CHALLENGE',      description: `${p} shows ${n} something to learn. It looks easy when ${p} does it. ${n} watches, memorizing every move. "Ready to try?" Outside or at home.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_TRY',          description: `${n} tries. It goes wrong immediately — wobble, tangle, splash. ${p} catches ${n} or catches the thing. "That's okay. Again." Same spot.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SECOND_TRY',         description: `Try two. Better! But still not right. ${p} adjusts ${n}'s grip, shifts a foot, tilts a wrist. Patient hands guiding. Same spot.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'FRUSTRATION',        description: `Try five. ${n} sits down, arms crossed. "I can't." ${p} sits beside ${n}. No words of correction — just presence. A quiet pause. Same spot.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'MOMS_STORY',         description: `${p} tells ${n} about the first time ${p} tried this. "I fell thirteen times." ${n} looks up. "Really?" "Really." Same spot.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'TRYING_AGAIN',       description: `${n} stands up. New determination. ${p} steps back just a little further this time. Room to succeed or fail on one's own. Same spot.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'ALMOST',             description: `SO close. ${n} almost has it — for one glorious second, it works. Then it doesn't. But that second was real. Same spot.`, wordTarget: wt },
        { spread: 8,  beat: 'THE_MOMENT',         description: `${n} does it. Fully. Perfectly. The world holds its breath. ${p}'s hands are at the mouth. ${n}'s eyes go wide. Fewest words. Same spot.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 9,  beat: 'CELEBRATION',        description: `${p} scoops ${n} up or cheers or dances. ${n} does it again to prove it wasn't luck. It wasn't. Triumph. Same spot.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'SHOWING_OFF',        description: `${n} does it again and again — faster, braver, with a grin that could light a city. ${p} watches with the proudest face in the world. Same spot.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'WALKING_BACK',       description: `Heading home together, ${n} buzzing with accomplishment. ${p} walks a little taller too. The skill belongs to ${n} now. Heading home.`, wordTarget: wt },
        { spread: 12, beat: 'GRATITUDE',          description: `${n} looks at ${p}. "Will you teach me something else tomorrow?" ${p} smiles. "Always." NOT bedtime. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. The best teachers are the ones who remember what falling felt like. Echo the first wobble. Warm, patient, triumphant.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'memory_walk',
    name: 'The Memory Walk',
    synopsis: 'Mom and child visit places that matter — the park where they first played, the shop where they always get a treat, the bench where they sat in the rain. A map of love.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      const p = opts.parentName || 'Mama';
      return [
        { spread: 1,  beat: 'SETTING_OUT',        description: `${p} and ${n} step outside. "Let's go visiting," ${p} says. Not visiting people — visiting places. Their places. Front door.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_PLACE',        description: `The park where ${p} first pushed ${n} on the swings. ${n} runs to the swings and pumps. ${p} watches from the same spot as always. The park.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SECOND_PLACE',       description: `The shop where they always share a treat. Same counter, same choice. ${p} and ${n} sit on the step outside and eat. The shop.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'THIRD_PLACE',        description: `The bench where they once sat in the rain, waiting for it to stop, singing songs to pass the time. They sit again now, in sunshine. The bench.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'DISCOVERY_PLACE',    description: `The spot where ${n} first saw a butterfly, or found a coin, or said a new word. ${p} remembers every detail. ${n} is amazed. A significant spot.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'FUNNY_PLACE',        description: `A place where something hilarious happened — they both start laughing remembering it. The story gets retold, better each time. A street or corner.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'QUIET_PLACE',        description: `A place that's just theirs — a tree they always touch, a wall they always look over. No story needed. Just being there together. Fewest words. Their spot.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'NEW_PLACE',          description: `They discover somewhere new — a garden they never noticed, a mural around a corner. "This is ours now too," ${p} says. New spot.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'MARKING_IT',         description: `${n} and ${p} do something to mark the new place — scratch initials in dirt, balance a stone, tie a ribbon. Claiming it. New spot.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'BIG_VIEW',           description: `From a high point, they look out over the neighborhood. All their places are down there — a map of everywhere they've been together. Hilltop or overlook.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'HEADING_HOME',       description: `Walking home slowly. Every street holds something. ${p} and ${n} point out places as they pass. "Remember that?" "And that?" Heading home.`, wordTarget: wt },
        { spread: 12, beat: 'HOME_IS_BEST',       description: `Inside the front door, ${n} looks around. Home is the first place, the last place, the best place. ${p} is already making tea. NOT bedtime. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. The whole world is a map of places you've loved in. Echo the first step out. Warm, remembered, walked together.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'surprise_gift',
    name: 'The Surprise Gift',
    synopsis: 'The child secretly makes something special for Mom — gathering materials, crafting it with care, hiding it, and revealing it at the perfect moment.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      const p = opts.parentName || 'Mama';
      return [
        { spread: 1,  beat: 'THE_PLAN',           description: `${n} has a secret plan. While ${p} is busy, ${n} gathers supplies — paper, ribbons, flowers from the garden, glue. Stealth mode. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'GATHERING',          description: `In the garden: the prettiest flower, the smoothest stone, a perfect leaf. ${n} collects each piece with purpose. ${p} is inside, unsuspecting. Garden.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'CRAFTING',           description: `Hidden behind a closed door, ${n} works. Cutting, gluing, arranging. Tongue sticking out in concentration. This has to be perfect. ${n}'s room.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'CLOSE_CALL',         description: `${p} knocks on the door. "What are you doing?" ${n} throws a blanket over everything. "NOTHING!" ${p} smiles and walks away. ${n}'s room.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'ADDING_DETAILS',     description: `The finishing touches — a drawn heart, a sprinkle of glitter, a personal message in careful handwriting. Every detail matters. ${n}'s room.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'WRAPPING',           description: `Wrapping it — too much tape, the paper tears, ${n} starts over. The wrapping is part of the love. A crooked bow on top. ${n}'s room.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'HIDING_SPOT',        description: `${n} hides the gift — under a pillow, behind a door, in a special place only ${n} would think of. The anticipation builds. Fewest words. At home.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'WAITING',            description: `The hardest part: waiting for the right moment. ${n} watches ${p}, bursting with the secret. Can't stop smiling. Almost gives it away twice. At home.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'THE_MOMENT',         description: `${n} brings the gift out. "This is for you." Hands it to ${p} with both hands. Holding breath. ${p} takes it, surprised. At home.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'OPENING',            description: `${p} unwraps it slowly — peeling tape, unfolding paper. Sees what's inside. ${p}'s face changes. Eyes shine. A hand goes to the heart. At home.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'THE_HUG',            description: `${p} pulls ${n} into the biggest hug. Holds on. "${n}, this is the most beautiful thing." The room is full of love. At home.`, wordTarget: wt },
        { spread: 12, beat: 'DISPLAY',            description: `${p} puts the gift in a place of honor — on the mantel, by the bed, on the fridge. Where it can be seen every day. NOT bedtime. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. The gifts that take the longest to make are the ones that last forever. Echo the secret gathering. Warm, handmade, treasured.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'dance_party',
    name: 'The Dance Party',
    synopsis: 'Music fills the house and Mom and child dance through every room — silly dances, wild dances, made-up dances, and one tender slow dance at the end.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      const p = opts.parentName || 'Mama';
      return [
        { spread: 1,  beat: 'MUSIC_ON',           description: `${p} turns on the music. A beat fills the kitchen. ${p}'s foot starts tapping. ${n}'s head starts bobbing. It's happening. Kitchen.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_DANCE',        description: `The first dance — silly, wiggly, arms flailing. ${p} and ${n} face each other and mirror every ridiculous move. Kitchen.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'KITCHEN_GROOVE',     description: `Dancing around the kitchen table — sliding on socks, spinning past the fridge, using wooden spoons as microphones. Kitchen.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'LIVING_ROOM',        description: `The dance moves to the living room. Bigger space, bigger moves. ${n} and ${p} jump on the couch (just this once), leap off, keep dancing. Living room.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'SIGNATURE_MOVES',    description: `${p} shows a signature move. ${n} copies it (differently). ${n} invents one. ${p} tries it (hilariously). They name each move. Living room.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'HALLWAY_CONGA',      description: `A conga line through the hallway — just two people, but it feels like a parade. Past bedrooms, past the bathroom, loop back to the kitchen. Hallway.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'SPIN_OUT',           description: `${p} spins ${n} under an arm. ${n} spins ${p} back. They spin together until the room tilts and they collapse, dizzy and laughing. Living room.`, wordTarget: wt },
        { spread: 8,  beat: 'SLOW_SONG',          description: `A slow song comes on. ${n} stands on ${p}'s feet. They sway together, barely moving. The room goes still around them. Fewest words. Living room.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 9,  beat: 'FAST_AGAIN',         description: `A fast song blasts back. They leap apart and go wild — jumping, clapping, stomping. The floor shakes. Maximum energy. Living room.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'FINALE',             description: `The last song. They give it everything — the biggest, most ridiculous, most joyful dance. Arms up, voices singing, feet flying. Living room.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'MUSIC_STOPS',        description: `The music ends. The silence is enormous. ${p} and ${n} stand in the quiet, chests heaving, hair wild, smiles infinite. Living room.`, wordTarget: wt },
        { spread: 12, beat: 'COOL_DOWN',          description: `Flopped on the floor together, still catching breath. ${n} reaches over and holds ${p}'s hand. The best kind of exhausted. NOT bedtime. Living room.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. The best music doesn't come from speakers — it comes from feet that dance together. Echo the first beat. Warm, breathless, dancing.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'garden_day',
    name: 'The Garden Day',
    synopsis: 'Mom and child plant a garden together — digging, planting, getting gloriously muddy. Seeds go in the ground and the future grows between them.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      const p = opts.parentName || 'Mama';
      return [
        { spread: 1,  beat: 'SEED_PACKETS',       description: `${p} spreads seed packets on the table. Tiny pictures of flowers and vegetables on each one. ${n} picks favorites. "Let's grow these." At home.`, wordTarget: wt },
        { spread: 2,  beat: 'DIGGING',            description: `Outside with shovels. ${p} digs the first hole. ${n} digs the second (shallower, wider). Dirt flies everywhere. The earth smells alive. Garden.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'PLANTING',           description: `${n}'s small fingers drop seeds into soil. ${p} covers them gently. Pat, pat, pat. "Grow well," ${n} whispers to the dirt. Garden.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'MUDDY_FUN',          description: `The hose comes on. Mud happens — on knees, on elbows, on faces. ${p} has mud in ${p}'s hair. ${n} has mud everywhere. Both are delighted. Garden.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'WORM_DISCOVERY',     description: `${n} finds a worm! Holds it up proudly. ${p} admires it. They set it gently near the new plants — a garden helper. Garden.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'BIGGER_PLANTING',    description: `Something bigger — a bush, a small tree. ${p} and ${n} dig a hole together, lower it in, pack the soil. A team effort for something that will last. Garden.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'WATERING',           description: `${n} waters everything — a gentle rain from the watering can. Each plant gets a drink. The water seeps into the soil. Fewest words. Garden.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'RESTING',            description: `Sitting on the grass, surveying the work. Rows of seeds, mounds of soil, a small tree standing tall. ${p} and ${n} lean into each other. Garden.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'IMAGINING',          description: `${n} imagines the garden in full bloom — flowers as tall as ${n}, vegetables ripe and heavy. ${p} imagines it too. They describe it to each other. Garden.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'GARDEN_MARKER',      description: `${n} makes a garden sign — painted rock or a stick with a label. Plants it in the soil. "Our garden." ${p} adds a second sign. Garden.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'CLEANING_UP',        description: `Hose over muddy boots, muddy hands, muddy faces. The water runs brown, then clear. Clean hands, dirty knees. Garden.`, wordTarget: wt },
        { spread: 12, beat: 'WINDOW_WATCHING',    description: `Inside, ${p} and ${n} look out at their new garden. Nothing visible yet, but everything is there underground, beginning. NOT bedtime. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. The things you plant together grow in two places — the ground and the heart. Echo the seed packets. Warm, muddy, growing.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'adventure_outing',
    name: 'The Adventure Outing',
    synopsis: 'Mom and child go on an outdoor adventure — hiking, biking, or exploring. They push each other forward, share discoveries, and come home tired and happy.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      const p = opts.parentName || 'Mama';
      return [
        { spread: 1,  beat: 'PACKING_UP',         description: `Backpack on, shoes laced. ${p} checks the snacks, ${n} checks the water bottle. They high-five at the door. Adventure starts. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'TRAIL_START',         description: `The trail begins — wide, easy, dappled sunlight. ${p} and ${n} walk side by side. The air smells like trees and morning. Trail.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_FIND',          description: `${n} spots something — a feather, a cool rock, a mushroom shaped like a hat. Shows ${p}. They examine it together like scientists. Trail.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'UPHILL',              description: `The trail gets steeper. ${p} leads the way, turning back to encourage. ${n} pushes on, determined. Legs burning, heart pumping. Trail.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'WATER_CROSSING',      description: `A stream crosses the path. ${p} goes first, testing rocks. ${n} follows, wobbling. A hand reaches back. They cross together. Stream.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'PEAK_VIEW',           description: `They reach the top — or the clearing, or the lookout. The view opens up. ${p} and ${n} stand together, the world spread below them. Peak.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'SNACK_BREAK',         description: `Sitting on a rock, sharing snacks. Everything tastes better outdoors. ${p} passes an apple slice, ${n} passes a cracker. Peak.`, wordTarget: wt },
        { spread: 8,  beat: 'STILL_MOMENT',        description: `Neither speaks. Wind in the trees, a bird calling. ${p} and ${n} sit in the same silence, breathing the same air. Fewest words. Peak.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 9,  beat: 'DOWNHILL_JOY',        description: `Heading down — faster, lighter. ${n} runs ahead, ${p} jogs to keep up. Laughter echoes through the trees. Trail.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'WILD_DISCOVERY',      description: `On the way back: something amazing — a deer watching from the trees, a waterfall they missed, a rainbow through the canopy. Shared wonder. Trail.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'TRAIL_END',           description: `Back where they started. ${n}'s legs are tired, ${p}'s shoulders are sore. They look at each other and grin. They did it. Trailhead.`, wordTarget: wt },
        { spread: 12, beat: 'TIRED_HAPPY',         description: `In the car or walking home, ${n} leans against ${p}. Mud on both boots, sun on both faces. The best kind of tired. NOT bedtime. Heading home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',             description: `The last line. The best paths are the ones you walk with someone who matches your pace. Echo the high-five. Warm, adventured, together.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'matching_day',
    name: 'The Matching Day',
    synopsis: 'Mom and child decide to match everything — outfits, meals, faces, dances. A day of mirroring each other turns into a celebration of being alike and different.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      const p = opts.parentName || 'Mama';
      return [
        { spread: 1,  beat: 'THE_DECISION',       description: `${n} looks at ${p}. ${p} looks at ${n}. "Let's match today." Same clothes, same hair, same everything. The matching day begins. Bedroom.`, wordTarget: wt },
        { spread: 2,  beat: 'OUTFIT_MATCH',        description: `Matching outfits — same color shirt, same kind of socks. ${n} tucks in the shirt exactly like ${p}. They stand in the mirror, twinsies. Bedroom.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'WALK_MATCH',          description: `Walking in sync down the sidewalk — left foot, right foot, same pace, same stride. When one stops, both stop. Pedestrians stare. The street.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'FOOD_MATCH',          description: `At the café: same order. Same drink, same snack, same napkin fold. They eat at the same speed, sip at the same time. A café.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'FACE_MATCH',          description: `Making the same face — surprised face, silly face, serious face, sleepy face. ${n} copies ${p}. ${p} copies ${n}. They dissolve into giggles. A bench.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'DANCE_MATCH',         description: `Matching dance moves in the park. ${p} does a move, ${n} mirrors it. ${n} invents one, ${p} follows. They're a two-person show. The park.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'SYNC_MOMENT',         description: `The most perfect sync — they say the same word at the same time. Pause. Stare. Burst out laughing. Fewest words. The park.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'DIFFERENT_MOMENT',   description: `One thing they can't match — ${n} likes one thing, ${p} likes another. And that's okay. The differences are just as special. Walking.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'PHOTO',               description: `They pose for a photo — matching outfits, matching smiles, matching stance. The best picture ever taken. Click. A nice spot.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'MATCHING_KINDNESS',  description: `They do a matching kind act — wave at the same person, hold a door together, share something. Kindness looks good doubled. The street.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'HEADING_HOME',       description: `Walking home in step, matching shadows stretching behind them. The day is winding down but the matching continues. Heading home.`, wordTarget: wt },
        { spread: 12, beat: 'MIRROR_HUG',         description: `At home, facing the mirror one last time. Same outfit, same smile. Then the mirror disappears into a hug. NOT bedtime. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. Being alike is wonderful; being together is everything. Echo the first mirror. Warm, matched, one-of-a-kind.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
];
