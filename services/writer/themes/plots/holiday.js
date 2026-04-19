/**
 * Holiday plot templates — 12 structurally distinct story arcs.
 *
 * Each template returns 13 spreads in 4-scene (A/B/C/D) grouping.
 * opts: { child, isYoung, wt, parentName, book, theme }
 */

module.exports = [
  {
    id: 'classic_holiday',
    name: 'Classic Holiday Celebration',
    synopsis: 'Festive morning sparkles with anticipation. The child prepares, celebrates, connects with the season, and ends the day glowing with holiday warmth.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'FESTIVE_MORNING',    description: `${n} wakes to a house that smells different — cinnamon, pine, something baking. Frost on the window, warmth inside. Holiday morning. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'DISCOVERY',           description: `Something new in the house — a wreath on the door, stockings hung, a garland trailing the banister. The holiday has arrived overnight. At home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'PREPARATIONS',        description: `${n} helps prepare — setting the table, folding napkins into shapes, arranging pinecones. Each small task builds the excitement. Kitchen.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'OUTSIDE_MAGIC',       description: `Stepping outside: the neighborhood is transformed. Lights on porches, snow on rooftops, a wreath on every door. The world celebrates too. The street.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'GATHERING',           description: `Back inside, traces of family everywhere — a packed lunch on the counter with a note, extra chairs set out, a pie cooling on the sill. The house is ready. At home.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'CELEBRATION',         description: `The feast: plates piled high, candles flickering, the best dishes. ${n} sits at the center of it all, tasting everything. Dining room.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'GIFT_MOMENT',         description: `A wrapped gift appears — tied with a ribbon, a handwritten tag. ${n} unwraps it slowly, savoring. The gift connects to something ${n} loves. At home.`, wordTarget: wt + 2 },
        { spread: 8,  beat: 'CONNECTION',          description: `${n} holds the gift close and feels the invisible warmth of whoever left it. A note inside the wrapping, familiar handwriting. Tender. At home.`, wordTarget: wt },
        { spread: 9,  beat: 'QUIET_WONDER',        description: `The house is still for a moment. Candles glow, the tree sparkles, snow falls outside the window. Pure holiday peace. Fewest words. At home.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'GIVING_BACK',         description: `${n} places something under the tree — a drawing, a handmade card, a found treasure. Giving is the best part. At home.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'EVENING_GLOW',        description: `The house glows golden from within. ${n} presses a nose to the cold window — the world outside is silver and blue, the world inside is warm and gold. At home.`, wordTarget: wt },
        { spread: 12, beat: 'HOLDING_WARMTH',      description: `${n} sits with the gift, a mug of something warm, and the feeling that the holiday lives inside, not just on the calendar. NOT bedtime. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',             description: `The last line. The best holidays are the ones that keep glowing after the candles go out. Echo the morning smell. Warm, bright, held.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'decoration_quest',
    name: 'The Decoration Quest',
    synopsis: 'Each decoration has a story — the star from last year, the paper chain from a rainy afternoon, the ornament that always hangs crooked. The child hangs them all and builds a memory tree.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'BOX_OPENS',          description: `${n} opens the big decoration box. Tissue paper, bubble wrap, the smell of last year. Each item is a memory waiting to be hung. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_ORNAMENT',     description: `The first ornament — a glittery star, slightly bent. ${n} remembers making it. It still sparkles. Onto the tree it goes. Living room.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'PAPER_CHAIN',        description: `A paper chain, long and colorful, made on a rainy day. Some links are crooked, some are perfect. ${n} drapes it across the mantel. Living room.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'OUTSIDE_DECORATING', description: `${n} carries lights outside. Wrapping them around the porch railing, the mailbox, a small bush. The yard begins to glow. Front yard.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'SPECIAL_ORNAMENT',   description: `The most special decoration — fragile, beautiful, wrapped in extra tissue. A note tucked beside it in careful handwriting. ${n} holds it gently. Living room.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'WINDOW_ART',         description: `${n} paints snowflakes and stars on the windows with white paste. From outside, the house looks magical. From inside, the world looks frosted. Windows.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'WREATH_HANGING',     description: `Hanging the wreath on the front door. It's heavy and crooked and perfect. ${n} steps back to admire it. The door looks like it's wearing a crown. Front door.`, wordTarget: wt },
        { spread: 8,  beat: 'LIGHTS_ON',          description: `The moment: ${n} plugs in all the lights at once. The house erupts in color. Every window, every corner glows. The most spectacular beat. At home.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'QUIET_GAZE',         description: `${n} sits in the glow, looking at every decoration. Each one a story, each one a year. The tree holds time. Fewest words. Living room.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'LAST_TOUCH',         description: `One final decoration — something ${n} made today. A new memory for the box. Hung in the perfect spot. Living room.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'STEPPING_OUTSIDE',   description: `${n} walks to the sidewalk and turns around. The whole house glows — a warm jewel in the winter dark. Pride and wonder. Front yard.`, wordTarget: wt },
        { spread: 12, beat: 'NEIGHBORHOOD_GLOW',  description: `Every house on the street has its own glow. The whole neighborhood sparkles. ${n} waves at the lights as if they're waving back. NOT bedtime. The street.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. A decorated house is a story told in lights and glitter. Echo the opened box. Warm, sparkling, layered with years.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'cookie_baking',
    name: 'The Cookie Baking',
    synopsis: 'Each cookie shape holds a wish — a star for courage, a heart for love, a tree for growth. The child bakes a whole tray of wishes and shares them with the world.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'RECIPE_FOUND',       description: `${n} finds a recipe card on the counter — smudged with butter, edges soft. Flour, sugar, magic. Time to bake. Kitchen.`, wordTarget: wt },
        { spread: 2,  beat: 'MIXING',             description: `Measuring cups, a whisk, butter melting. ${n} stirs the dough — thick, golden, sweet-smelling. The kitchen clouds with flour dust. Kitchen.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'ROLLING',            description: `Rolling the dough flat — pressing hard, rolling even. The counter dusted white. The dough stretches like a golden blanket. Kitchen.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'FIRST_SHAPE',        description: `The first cookie cutter: a star. ${n} presses it in and lifts — a perfect star. A wish for courage. This star will be brave. Kitchen.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'MORE_SHAPES',        description: `A heart for love, a tree for growth, a moon for dreams. Each shape ${n} cuts tells a wish. The tray fills up. Kitchen.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'INTO_THE_OVEN',      description: `The tray slides in. The oven glows orange. ${n} sits on the floor and watches through the glass — the cookies rise, golden, slow. Kitchen.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'WAITING',            description: `The smell fills the house — warm, sweet, buttery. ${n} breathes deep. The best part of baking is the waiting. Fewest words. Kitchen.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'OUT_THEY_COME',      description: `Timer dings! The cookies come out golden and puffed. ${n} lines them up on the rack. A parade of wishes cooling in the kitchen air. Kitchen.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'DECORATING',         description: `Icing in every color — red, green, white, blue. ${n} decorates each cookie with focus and flair. Sprinkles rain down like confetti. Kitchen.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'TASTING',            description: `The first bite: warm, sweet, crumbly. ${n} closes eyes and grins. The star tastes like courage. The heart tastes like love. Kitchen.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'SHARING',            description: `${n} arranges cookies on a plate, wraps them in cloth. Carries them to the neighbors' doors, the mailbox, a bench. Wishes delivered. The street.`, wordTarget: wt },
        { spread: 12, beat: 'LAST_COOKIE',        description: `One cookie left — ${n}'s own wish cookie, saved for last. A bite, a smile, flour still in ${n}'s hair. NOT bedtime. Kitchen.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. The sweetest wishes are baked at home and shared with the world. Echo the butter-smudged recipe. Warm, golden, crumbly.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'snow_day',
    name: 'The Snow Day',
    synopsis: 'Fresh snow transforms the neighborhood into a winter wonderland. The child explores a new white world — building, sliding, discovering — until the familiar becomes magical.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'WHITE_MORNING',      description: `${n} pulls back the curtain — everything is white. The street, the cars, the trees. Snow fell all night and covered the world. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'BUNDLING_UP',        description: `Boots, coat, scarf, mittens, hat. ${n} is a walking marshmallow. Steps outside into the crunch. The first footprints in fresh snow. Front door.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_CRUNCH',       description: `Every step: CRUNCH. ${n} walks in a circle, making patterns. Then falls backward — arms and legs sweep. A snow angel. Front yard.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'SNOWBALL_BUILD',     description: `Rolling snow into a ball — small, then big, then enormous. A snowperson takes shape: round body, stick arms, a stone smile. Front yard.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'HILL_DISCOVERY',     description: `The hill in the park is a glacier now. ${n} climbs to the top and looks out — the whole world is a snow globe. The park.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'SLIDING',            description: `Down the hill! Feet first, then belly, then spinning. Snow sprays everywhere. The hill gets faster each run. The park.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'SNOW_SILENCE',       description: `${n} lies in the snow, looking up. Snowflakes drift down, each one landing on eyelashes, cheeks, mittens. Complete silence. Fewest words. The park.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'DISCOVERY',          description: `Animal tracks in the snow — a rabbit's zigzag, a bird's tiny forks, a cat's neat line. The snow tells stories of everyone who passed. The park.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'SNOW_FORT',          description: `Building a fort — walls packed tight, a door cut through, a window to peek out. ${n}'s own castle of snow. Maximum effort, maximum pride. The park.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'CATCHING_FLAKES',    description: `${n} catches snowflakes on a dark mitten. Each one is different — stars, hexagons, lace. Tiny miracles melting on wool. The park.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'HEADING_HOME',       description: `Cheeks red, nose dripping, mittens soaked. ${n} trudges home through the white world, leaving a trail of footprints. Heading home.`, wordTarget: wt },
        { spread: 12, beat: 'WARMING_UP',         description: `Inside, boots steaming on the mat. ${n} wraps both hands around a warm mug and watches the snow still falling outside. NOT bedtime. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. Snow turns the whole world into a blank page and lets you write on it with your boots. Echo the white curtain. Warm, white, hushed.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'gift_making',
    name: 'The Gift Maker',
    synopsis: 'The child makes gifts by hand for everyone — each one personal, imperfect, and full of love. The making is the real gift.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'IDEA_SPARKS',        description: `${n} sits with paper, glue, paint, and string. A list of names, a head full of ideas. Today is for making, not buying. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_GIFT',         description: `The first gift: a painted stone with a heart. ${n} holds it up — not perfect, but warm. Wraps it in tissue paper with care. At home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SECOND_GIFT',        description: `A bookmark made from pressed leaves and ribbon. ${n} presses it flat in a heavy book, then pulls it out: beautiful. At home.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'MESSY_MIDDLE',       description: `The table is chaos — glitter everywhere, paint on elbows, scraps of paper floating. ${n} works in the middle of the beautiful mess. At home.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'TRICKY_GIFT',        description: `One gift is hard — the yarn tangles, the clay cracks, the drawing smudges. ${n} starts over twice, frowning then determined. At home.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'BREAKTHROUGH',        description: `The tricky gift works on the third try. ${n} holds it up, grinning. The imperfections make it better. At home.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'SECRET_GIFT',        description: `The most special gift — for someone ${n} loves most. Made with the greatest care, the most time, the quietest hands. Fewest words. At home.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'WRAPPING',           description: `Wrapping each gift — mismatched paper, too much tape, bows that won't stay. Every package looks handmade because it is. At home.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'TAGS_AND_NOTES',     description: `Writing a tag for each one. Careful letters, a small drawing. "For you, from ${n}." Every name gets its own message. At home.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'HIDING',             description: `${n} hides the gifts around the house — under a pillow, behind a door, inside a shoe. Each one a surprise waiting to happen. At home.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'CLEAN_UP',           description: `Cleaning up the craft table. Glitter will be found for weeks. ${n} washes paint from fingers and surveys the work with pride. At home.`, wordTarget: wt },
        { spread: 12, beat: 'ANTICIPATION',       description: `${n} sits among the hidden gifts, hugging the last one. The giving hasn't happened yet, but the joy already has. NOT bedtime. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. The best gifts are the ones with fingerprints still on them. Echo the paper and glue. Warm, handmade, given.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'holiday_market',
    name: 'The Holiday Market',
    synopsis: 'A bustling market appears in the town square — stalls of gingerbread, handmade toys, singing carolers. The child wanders through a world of holiday wonder.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'MARKET_APPEARS',     description: `${n} turns the corner and there it is — a holiday market filling the square. Lights strung between stalls, music floating, steam rising from mugs. Town square.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_STALL',        description: `Gingerbread! A stall piled with cookies shaped like houses, stars, and people. The baker offers ${n} a warm one. It snaps between teeth. Market.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'TOY_STALL',          description: `A stall of handmade toys — carved animals, knitted dolls, painted tops. ${n} picks up a tiny wooden something and turns it over. Market.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'MUSIC_CORNER',       description: `Carolers sing in the corner, their breath making clouds. The song is old and warm. ${n} hums along without knowing all the words. Market.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'CANDLE_STALL',       description: `A stall of candles — every color, every scent. Beeswax, cinnamon, pine. ${n} holds one to each nostril: one smells like home, one like adventure. Market.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'HOT_DRINK',          description: `A mug of something warm pressed into ${n}'s mittened hands. Steam curls up. The first sip is too hot; the second is perfect. Market.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'LANTERN_WALK',       description: `Someone hands ${n} a paper lantern on a stick. It glows orange, swaying. ${n} walks through the market carrying light. Fewest words. Market.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'SURPRISE_STALL',     description: `A stall ${n} almost missed — tucked in the back. Something special inside, connected to ${n}'s interests. The best find is always hidden. Market.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'CHOOSING_A_GIFT',    description: `${n} picks out a gift for someone — carefully chosen, carefully wrapped by the stall keeper. A small treasure with big meaning. Market.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'SNOW_FALLS',         description: `Snow begins to fall on the market. Flakes land on the stalls, the lights, the gingerbread. Everything gets quieter and more beautiful. Market.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'LEAVING',            description: `${n} walks out of the market, looking back once. The lights glow through the falling snow like a painting. Leaving the market.`, wordTarget: wt },
        { spread: 12, beat: 'TREASURES_HOME',     description: `At home, ${n} sets out the market treasures — the wooden toy, the candle, the wrapped gift. The market lives on the shelf now. NOT bedtime. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. The best markets sell things you didn't know you needed. Echo the first corner turned. Warm, bustling, snow-dusted.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'caroling',
    name: 'The Caroling Walk',
    synopsis: 'Door to door, song by song — each house adds something to the journey. A cookie here, a harmony there, a candle in a window. By the end, the whole street is singing.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'SONG_BOOK',          description: `${n} holds a song book, breath making clouds in the cold air. Scarf wrapped tight, cheeks already pink. The first house is just ahead. The street.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_DOOR',         description: `${n} sings at the first door — wobbly voice, big heart. The door opens and a face appears, smiling wide. A warm cookie is pressed into ${n}'s hand. First house.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SECOND_DOOR',        description: `The second house: an old person hums along, remembering the words. They tap a foot and join in for the last verse. Second house.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'GROWING_COURAGE',    description: `${n}'s voice gets stronger with each door. The songs grow louder, bolder. The cold doesn't matter anymore. The street.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'SPECIAL_HOUSE',      description: `One house has a candle in every window. The door opens before ${n} even knocks. They were waiting for the singing. A cup of something warm appears. Special house.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'HARMONY',            description: `A neighbor joins the walk. Then another. Now there are voices blending — high and low, wobbly and steady. The song fills the street. The street.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'QUIET_HOUSE',        description: `One house is dark. ${n} sings softly anyway. A curtain moves. A hand waves from inside. The song reached someone who needed it. Fewest words. Dark house.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'LANTERN_PATH',       description: `Someone brings lanterns. The walking singers become a river of light flowing down the street. The whole neighborhood glows. The street.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'BEST_SONG',          description: `The last song — the best one, the one everyone knows. All voices together, filling the cold air with warmth. The sound carries to every window. The street.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'ECHOES',             description: `The singing stops. For a moment, the echo lingers in the frosty air. Then quiet. But the windows are all glowing now. The street.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'WALKING_HOME',       description: `${n} walks home, still humming. Pockets full of cookies, heart full of faces. The street is quieter but warmer than before. Heading home.`, wordTarget: wt },
        { spread: 12, beat: 'HOME_HUMMING',       description: `Inside, ${n} hums the last carol while warming cold fingers. The songs are inside now, playing on repeat. NOT bedtime. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. A song sung in the cold warms every house it touches. Echo the first wobbly note. Warm, carried, shared.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'holiday_lights',
    name: 'The Holiday Lights Trail',
    synopsis: 'A trail of holiday lights appears in the neighborhood, leading the child from house to house, through the park, to a spectacular finale of light and wonder.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'FIRST_LIGHT',        description: `${n} spots a single light glowing in the garden — small, blue, blinking. It leads to another, then another. A trail. Garden.`, wordTarget: wt },
        { spread: 2,  beat: 'FOLLOWING',           description: `The lights lead down the path — red, green, gold, white. ${n} follows them like breadcrumbs, each one a step into the evening. The path.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_DISPLAY',      description: `A house wrapped entirely in lights — roof, windows, bushes. Reindeer made of wire and white lights gallop across the lawn. ${n} stares. The street.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'TUNNEL_OF_LIGHTS',   description: `The trail leads through an archway of lights — walking through a tunnel of color, every direction sparkling. ${n} reaches out to touch them. The path.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'PARK_DISPLAY',       description: `The park is alive with light — trees wrapped in white, a glowing snowman, stars hanging from branches. The ordinary park is extraordinary. The park.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'REFLECTION',         description: `A pond reflects every light, doubling the display. ${n} kneels at the edge — the water holds a mirror universe of color. The park.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'FAVORITE_LIGHT',     description: `${n} finds a favorite — one single light among thousands. Something about its color, its flicker. ${n} watches it pulse. Fewest words. The park.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'GRAND_DISPLAY',      description: `The trail leads to the biggest display — a tree so tall and so bright it makes ${n} tilt all the way back. The star on top touches the sky. Town center.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'MUSIC_AND_LIGHTS',   description: `Music plays and the lights dance in time — blinking, chasing, swelling with the melody. ${n} claps along, spinning in the glow. Town center.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'OWN_LIGHT',          description: `Someone hands ${n} a small lantern — ${n}'s own light to carry. It glows warm in small hands, joining the display. Town center.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'TRAIL_HOME',         description: `The trail of lights leads home. Following them back, each one feels like an old friend now. The walk home is never dark. Heading home.`, wordTarget: wt },
        { spread: 12, beat: 'WINDOW_VIEW',        description: `At home, ${n} looks out the window at the glowing world. The lantern sits on the sill, still burning. NOT bedtime. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. One small light is enough to start a trail — and a trail is enough to light a world. Echo the first blue blink. Warm, glowing, connected.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'advent_countdown',
    name: 'The Advent Countdown',
    synopsis: 'Each day reveals a surprise — a tiny toy, a chocolate, a folded note, a seed. The countdown builds excitement until the big celebration arrives, already rich with small joys.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'CALENDAR_FOUND',     description: `${n} discovers a mysterious calendar on the wall — tiny numbered doors, each one sealed tight. Door number one waits. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_DOOR',         description: `${n} opens the first door. Inside: a tiny chocolate wrapped in gold foil. It tastes like the beginning of something wonderful. At home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'EARLY_DAYS',         description: `Day after day, new surprises — a miniature toy, a sticker, a paper snowflake. ${n} lines them up on the windowsill, a growing collection. At home.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'SPECIAL_FIND',       description: `One door holds something unexpected — a folded note with a riddle, a tiny key, a hand-drawn map. Not candy, but a mystery. At home.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'HALFWAY',            description: `The calendar is half empty. ${n} counts the remaining doors, then counts the treasures found so far. The anticipation builds like a wave. At home.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'SHARING_DAY',        description: `One door says "Share today." ${n} takes the surprise — a handful of wrapped candies — and gives them away. The giving door. At home and outside.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'SEED_DOOR',          description: `A door holds a single seed and a note: "Plant me." ${n} pushes it into a pot of soil on the windowsill. The tiniest beginning. Fewest words. At home.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'STORY_DOOR',         description: `A door holds a tiny folded story — a fairy tale in miniature, handwritten. ${n} reads it three times, marveling at the small pages. At home.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'ALMOST_THERE',       description: `Only a few doors left. The excitement is almost unbearable. ${n} shakes the calendar gently — something rattles behind the last door. At home.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'LAST_DOOR',          description: `The final door. ${n} opens it slowly. Inside: something that connects all the other gifts together — a string to hang them, a box to keep them, a frame for the notes. At home.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'DISPLAY',            description: `${n} arranges every treasure from every door. Together, they tell the story of waiting — and waiting well. A shelf of small wonders. At home.`, wordTarget: wt },
        { spread: 12, beat: 'CELEBRATION_READY',  description: `The holiday has arrived, but it's been here all along — in every tiny door, every surprise, every morning of counting. NOT bedtime. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. The best celebrations don't start with a bang — they start with a tiny door and a chocolate wrapped in gold. Echo the first door. Warm, counted, savored.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'holiday_helper',
    name: 'The Holiday Helper',
    synopsis: 'The child helps the whole community prepare for the big celebration — hanging banners, setting tables, carrying lanterns. By the time it starts, the child has touched every part of it.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'EARLY_ARRIVAL',      description: `${n} arrives at the community hall early. Chairs stacked, tables bare, the room echoing and cold. There's so much to do. Community hall.`, wordTarget: wt },
        { spread: 2,  beat: 'TABLE_SETTING',      description: `${n} unfolds tablecloths — white, crisp, longer than ${n} is tall. Smoothing them flat, placing centerpieces of pine branches and candles. Hall.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'BANNER_HANGING',     description: `A banner needs hanging. ${n} climbs a stepladder, reaches high, tapes one end. It sags in the middle and ${n} fixes it. Not perfect, but festive. Hall.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'KITCHEN_HELP',       description: `In the kitchen: trays of food arriving, pots steaming. ${n} carries bread baskets, arranges cookies on plates, sneaks one (just to test). Kitchen.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'LIGHTS_STRUNG',      description: `String lights draped across the ceiling. ${n} holds one end while the other is attached. The lights come on — the room transforms. Hall.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'OUTSIDE_PREP',       description: `Outside, lanterns line the path. ${n} lights each one carefully — a match, a flame, a glow. The path to the hall becomes a golden road. Outside.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'QUIET_MOMENT',       description: `${n} sits alone in the finished room. Every table set, every light on, every lantern lit. The empty room is perfect, waiting. Fewest words. Hall.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'PEOPLE_ARRIVE',      description: `The doors open and people stream in — gasping at the decorations, smiling at the lights. ${n} watches from the side, bursting with pride. Hall.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'CELEBRATION',        description: `The hall is full of noise, laughter, clinking glasses. Music plays. ${n} moves through the crowd, seeing every detail they helped create. Hall.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'RECOGNITION',        description: `Someone squeezes ${n}'s shoulder. "You made this happen." A small moment of being seen. The best feeling in the hall. Hall.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'WINDING_DOWN',       description: `The celebration eases. People drift out past the lanterns, carrying leftovers. The hall grows quiet again, but different now — warm from use. Hall.`, wordTarget: wt },
        { spread: 12, beat: 'LAST_LOOK',          description: `${n} takes one last look at the hall — crumbs on tables, a balloon on the floor, lights still twinkling. The best messes are made by joy. NOT bedtime. Hall.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. The ones who set the table always feast the most. Echo the early empty room. Warm, earned, celebrated.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'winter_solstice',
    name: 'The Winter Solstice',
    synopsis: 'The shortest day, the longest night — the child watches the sun set early and waits for the light to return, discovering that darkness holds its own beauty.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'SHORT_DAY',          description: `The sun is already low and it's barely afternoon. ${n} watches it sink, orange and huge, through bare branches. The shortest day is here. Garden.`, wordTarget: wt },
        { spread: 2,  beat: 'SUNSET_WALK',        description: `${n} walks toward the setting sun. The sky is painted — pink, purple, gold. Shadows stretch long. Every step chases the last light. The path.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'DARKNESS_ARRIVES',   description: `The sun disappears. The air changes — colder, stiller. Stars begin to prick through the blue-black sky. ${n} stands at the edge of night. Open field.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'FIRST_STAR',         description: `The first star appears — bright and alone. ${n} makes a wish on it. Then a second star, a third. The sky fills slowly. Open field.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'NIGHT_BEAUTY',       description: `The longest night is beautiful — frost glitters, moonlight makes shadows blue, an owl calls from somewhere high. Darkness has its own colors. Near the woods.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'CANDLE_LIT',         description: `${n} lights a candle — just one, small and brave. It pushes back the dark in a tiny golden circle. A protest and a promise. Near the woods.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'VIGIL',              description: `Sitting with the candle, watching the flame. The world is vast and dark and the flame is small and warm. This is what hope looks like. Fewest words.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'OTHER_LIGHTS',       description: `In the distance, other candles appear — in windows, on porches, in hands. Everyone is holding light tonight. The darkness is dotted with gold. The landscape.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'DEEPEST_DARK',       description: `The middle of the night — the deepest dark. But ${n} isn't afraid. The candle holds. The stars hold. The world holds. Open field.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'FIRST_LIGHT',        description: `The horizon changes — a thin line of grey, then pink, then gold. The sun is coming back. ${n}'s candle flickers as if welcoming it home. Open field.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'SUNRISE',            description: `The sun rises — slow, enormous, golden. It spills warmth across the frosty world. ${n} blows out the candle. The light has returned. Open field.`, wordTarget: wt },
        { spread: 12, beat: 'WALKING_HOME',       description: `${n} walks home in new morning light. The longest night is over. Tomorrow will be one minute longer. Everything is beginning again. NOT bedtime. Heading home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. The darkest night always carries the brightest morning in its pocket. Echo the low sun. Warm, turning, renewed.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'holiday_letter',
    name: 'The Holiday Wish Letter',
    synopsis: 'The child writes a holiday letter — but every wish is for someone else. A warm coat for the neighbor, a friend for the shy kid, snow for the dog. Giving becomes the truest wish.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'BLANK_PAGE',         description: `${n} sits with a blank page and a pencil. "Dear Holiday..." The cursor blinks. What to wish for? The pencil hovers. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_WISH',         description: `The first wish isn't for ${n} — it's for the neighbor who always waves: "A warm coat that fits perfectly." ${n} writes it down with care. At home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SECOND_WISH',        description: `A wish for the shy kid at the park: "A friend who likes the same things." ${n} thinks about what it means to be lonely, then writes it gently. At home.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'ANIMAL_WISH',        description: `A wish for the dog: "Snow deep enough to disappear in." ${n} giggles imagining it. The list is getting longer. At home.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'WALKING_WISH',       description: `${n} walks through the neighborhood, looking at everyone with wishing eyes. What does the baker need? The crossing guard? The cat on the wall? The street.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'BIG_WISH',           description: `A bigger wish — for the whole street, or the school, or the park. Something that would make everyone's day better. ${n} writes it in the biggest letters. A bench outside.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'HARDEST_WISH',       description: `The hardest wish to write — for someone ${n} doesn't always get along with. But the holiday letter is for everyone. ${n} writes it anyway. Fewest words. At home.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'DECORATING_LETTER',  description: `${n} decorates the letter — drawings in the margins, stickers, a border of stars. The wishes deserve to look beautiful. At home.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'READING_ALOUD',      description: `${n} reads the whole letter aloud, alone in the room. Every wish sounds real when spoken. The words float in the air like promises. At home.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'FOLDING',            description: `The letter is folded carefully, sealed with a sticker. ${n} writes "To the Holiday" on the front in the neatest handwriting. At home.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'SENDING',            description: `${n} places the letter somewhere special — on the windowsill, in a tree hollow, under a stone. Wherever wishes go to be heard. Outside.`, wordTarget: wt },
        { spread: 12, beat: 'FEELING',            description: `Walking home, ${n} feels lighter. Wishing for others fills you up instead of emptying you. The best surprise of the whole letter. NOT bedtime. Heading home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',            description: `The last line. The truest wish is the one you make for someone else. Echo the blank page. Warm, generous, full.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
];
