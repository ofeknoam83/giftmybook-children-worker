/**
 * Per-theme, per-age-tier exemplar stories.
 *
 * Exemplars demonstrate the craft principles from the research:
 * - AABB couplets with concrete nouns
 * - Actions over declarations
 * - Proper refrains (lines marked with [REFRAIN] inline so the LLM sees
 *   exactly where the same wording returns and how the surrounding context
 *   shifts on each repeat)
 * - Emotional arc progression
 *
 * Each exemplar uses {name} and {parent_name} as placeholders.
 *
 * The `[REFRAIN]` tag is a signal for the LLM only — it must NOT appear in
 * the model's output. The system prompt that injects these exemplars
 * explicitly tells the writer to treat tagged lines as "the refrain you
 * would also pick" without copying the marker into its own draft.
 */

const EXEMPLARS = {
  mothers_day: {
    'young-picture': {
      description: 'Young picture book (ages 0-3): AABB couplets, iambic tetrameter, simpler vocabulary, musical rhythm. Warm and celebratory — NO bedtime, NO tantrums. 13 spreads.',
      refrainDiscipline:
        'Refrain choreography: Pick ONE repeatable line ≤8 words that clearly includes `{parent_name}`. Repeat that exact line verbatim on exactly THREE spreads, not back-to-back, with at least one repeat falling in spreads 10–13. Each time it returns, surrounding context shifts so meaning deepens.',
      spreads: [
        'When morning comes and light peeks through,\n{parent_name}\'s first hello is just for you.',
        'She pours the milk, she cuts the pear,\nShe finds the socks you hid somewhere.',
        'At story time she holds you near,\nAnd does the voices you can hear.',
        'She knows the game you like the best,\nThe block tower crowned with a royal crest.',
        'She sees the things nobody sees,\nThe way you talk to birds and bees.',
        '{parent_name} knows the face you make,\nThe scrunchy grin for chocolate cake.',
        'You pour pretend tea, cup by cup,\nAnd {parent_name} drinks every last drop up.',
        'A puddle on the path below,\nYou splash and call it "pirate snow."\n{parent_name} stomps beside you, boot by boot,\nThe bravest pirate in a raincoat suit.',
        'You pick a flower from the ground,\nThe wobbliest, most lopsided one you found.\nYou hold it up for all to see,\n"This one is pretty, just like me."',
        '{parent_name} laughs and holds you tight.\nThe flower bends. The day feels bright.',
        'She swings you up above the floor,\nYou both pretend that you can soar.',
        'And if you asked her, "Why do you?"\nShe\'d say, "Because the world made you."',
        '[REFRAIN] The sun is warm. The sky is wide.\nAnd {parent_name} is right here, by your side.',
      ],
    },

    'picture-book': {
      description: 'Picture book (ages 4-6): Full narrative arc, AABB iambic tetrameter, richer vocabulary, emotional progression. Warm and celebratory — NO bedtime, NO tantrums. 13 spreads.',
      refrainDiscipline:
        'Refrain choreography: Same as young-picture — one identical refrain line (≤8 words, includes `{parent_name}`), exactly THREE appearances spaced apart with one in spreads 10–13; rhyme other spreads toward different end-sounds so the refrain end-word does not eat the whole book.',
      spreads: [
        'The sun came up on {name}\'s street,\nWhere puddles waited for bare feet.\n{parent_name} stood at the open door,\n"Today," she said, "let\'s go explore."',
        'She packed the bag with snacks and string,\nA jar for bugs, a bell to ring.\n{name} grabbed the hat with the floppy brim,\nThe one that always looked like him.',
        'They walked the path beside the creek,\nWhere willows bent as if to peek.\n{parent_name} found a feather, white and long,\nAnd {name} made up a marching song.',
        'She knew which rocks were good to throw,\nAnd where the tiny strawberries grow.\nShe let him lead the way back down,\nThe bravest explorer in the town.',
        'She noticed when he stopped to stare\nAt something small caught in the air,\nA seed that drifted, soft and slow.\nShe waited. {parent_name} always seemed to know.',
        '{name} held a stick up to the sky\nAnd called it "magic wand, stand by!"\nHe turned the creek into a sea,\nAnd {parent_name} became a queen with {name} the key.',
        'She didn\'t say it. Didn\'t need to.\nHe felt it in the things she\'d do,\nThe extra squeeze, the patient wait,\nThe way she always held the gate.',
        '{name} pulled a dandelion free\nAnd blew the seeds across her knee.\n"I wished for you," he said, and grinned.\nThe last seed tumbled on the wind.',
        '"Why do you always come?" he asked,\nAs afternoon went golden, vast.\nShe smiled the way she always could,\n"Because you\'re you. And you are good."',
        'They raced the last hill, toe to toe.\nShe let him win. He didn\'t know.',
        '{name} climbed up on the garden wall\nAnd spread his arms to span it all.\n"Look what I see from up this high!"\n{parent_name} saw the world through {name}\'s own eye.',
        'He jumped. She caught him, spinning round.\nTheir laughter was the only sound.\nNot because he had to ask,\nBut because she chose him, first and last.',
        '[REFRAIN] The sun is warm. The sky is wide.\nAnd {parent_name} is right here, by {name}\'s side.',
      ],
    },
  },
  fathers_day: {
    'young-picture': {
      description: 'Young picture book (ages 0-3): AABB couplets, iambic tetrameter, simpler vocabulary, musical rhythm. 13 spreads.',
      refrainDiscipline:
        'Refrain choreography: ONE line ≤8 words including `{parent_name}`, repeated verbatim THREE times across the book — never consecutive spreads — with at least one repeat in spreads 10–13. Context changes; wording does not.',
      spreads: [
        'The sun peeks in across the floor,\n{parent_name} is at the door.\nHe scoops you up, still warm from sleep,\nAnd holds you close without a peep.',
        'He makes the eggs, he pours the juice,\nHe finds your shoe that wriggled loose.\n{parent_name} hums a morning song,\nAnd you just hum and tag along.',
        'He lifts you up above his head,\nYou touch the sky from where he said.\nThe world below is far and small,\nBut {parent_name} will never let you fall.',
        'He holds your hand across the hill,\nYou race him down and feel the thrill.\nHe lets you win by half a stride,\nAnd grins the widest grin with pride.',
        'He cuts the paper, folds the crown,\nYou wear it backwards, upside down.\n{parent_name} says it suits you best,\nThe finest crown above the rest.',
        '{parent_name} knows your little ways,\nThe scrunched up nose on rainy days,\nThe song you sing below your breath,\nThe way you sigh before you rest.',
        'He sees the things nobody sees,\nYour tangled hair, your muddy knees.\nHe knows the look that means "I\'m done,"\nAnd gathers you before you run.',
        'And even when the blocks fall down,\nAnd all you want to do is frown,\nHe sits beside you on the floor,\nAnd builds the tower up once more.',
        'He reads the book, he does the bear,\nHe growls so loud you gasp for air.\nYou growl right back and start to play,\nThe silliest game of all the day.',
        'He stacks the blocks up, tall and wide,\nYou knock them down with so much pride.\n{parent_name} pretends to shake his fist,\nThen builds again — he can\'t resist.',
        'He swings you round, you touch the sky,\nThe trees spin past, the birds fly by.\nYour laughter fills the afternoon,\nA bright and bouncing, golden tune.',
        'And if you asked him, "Why do you?"\nHe\'d say, "The world is best with you."\n{parent_name} is here. He\'ll always be.\nAs close as breath, as sure as sea.',
        '[REFRAIN] The sun is warm, the day shines through.\n{parent_name} is right here next to you.',
      ],
    },

    'picture-book': {
      description: 'Picture book (ages 4-6): Full narrative arc, AABB iambic tetrameter, richer vocabulary, emotional progression. 13 spreads.',
      refrainDiscipline:
        'Refrain choreography: Lock one `{parent_name}` refrain (≤8 words), hit it THREE times at spaced spreads (one touch in 10–13). Keep rhyme variety on non-refrain spreads so one end-sound cannot dominate.',
      spreads: [
        'A red toolbox beneath the shelf,\n{parent_name} said, "Let\'s build it ourself."\n{name} grabbed the wood, the nails, the glue,\nAnd said, "I know what we should do."',
        'They drew the plan on paper white,\nA shelf for books to hold at night.\n{parent_name} held the plank up straight,\n{name} tapped the nail and said, "It\'s great."',
        'They marched outside with sticks for swords,\nThe lawn became a land of lords.\n{parent_name} fell when {name} struck true,\nAnd lay there laughing at the blue.',
        'The bike stood tall beside the tree,\n{name} said, "{parent_name}, will you hold me?"\nHe held the seat and walked behind,\nThen let it go. {name} didn\'t mind.',
        'The wind pushed back, the pedals spun,\n{name} kept on going toward the sun.\n{parent_name} stood still beside the gate,\nAnd watched, and smiled, and chose to wait.',
        'He knew which laugh meant "one more round,"\nAnd which meant "please sit on the ground."\nHe knew the frown that hid a grin,\nThe quiet look that let him in.',
        'He never said he understood.\nHe showed it in the way he would\nJust wait until the storm had passed,\nAnd hold {name}\'s hand at last.',
        'And even when the paint went wide,\nAnd stained the floor on every side,\nHe shrugged and dipped his finger, too,\nAnd drew a star in red and blue.',
        '"Why do you always fix the things\nThat break?" asked {name} on the swings.\n{parent_name} pushed the swing up high\nAnd said, "Because I love to try."',
        'Two shadows stretched across the lawn.\nOne big. One brave. One still. One drawn.',
        'They sat together on the step,\nThe shelf they built was worth the sweat.\n{name} touched the wood and felt the groove,\nThe surest proof of how things move.',
        '{parent_name} put his arm around\nThe bravest builder in the town.\nNot asked for, never having to,\nBut choosing this, and choosing you.',
        '[REFRAIN] The sun shone on. The tools shone, too.\nThe red toolbox was waiting, new.',
      ],
    },
  },

  birthday: {
    'young-picture': {
      description: 'Young picture book (ages 0-3): Birthday celebration arc, AABB couplets, simpler vocabulary, 13 spreads.',
      refrainDiscipline:
        'Refrain choreography: One short celebratory line ≤8 words ("The best day yet was made for you."). Use it on the closing spread, and at one early/middle spread to plant it; aim for 2–3 total appearances. Each return should land after a new beat (banner, candles, gifts) so the meaning shifts from anticipation → climax → afterglow.',
      spreads: [
        'The sun came up, the birds sang too,\nToday the world was made for you.',
        'A banner hung across the hall,\nWith {name} written big and tall.',
        'The kitchen smelled of sugar sweet,\nOf frosting swirls and batter beat.',
        'A crown of paper, gold and bright,\n{name} wore it left and right.',
        'The doorbell rang, the friends came in,\nWith laughing eyes and happy din.',
        'They played the game with hoops and rings,\nAnd traded turns on all the swings.',
        'The candles lit, the room grew warm,\nEach tiny flame a golden charm.',
        'One breath, one wish, one little glow.\nThe candles flickered soft and low.',
        'The room erupted, cheers and song,\nThe kind of joy that lasts so long.',
        'A piece of cake on every plate,\nThe frosting smudged, the hour late.',
        'The guests went home, the streamers fell,\nThe house still held that birthday smell.',
        '{name} held a toy up to the light,\nThe favorite one, the red and white.',
        '[REFRAIN] The cake was gone. The crown still new.\nThe best day yet was made for you.',
      ],
    },
    'picture-book': {
      description: 'Picture book (ages 4-6): Birthday celebration arc, AABB iambic tetrameter, richer vocabulary, 13 spreads.',
      refrainDiscipline:
        'Refrain choreography: One celebratory line of 4–8 words used three times — once early to set the day\'s promise, once at the cake/wish climax to deliver it, and once on the closing spread as the afterglow. Same wording each time; surrounding context shifts (anticipation → fulfillment → memory).',
      spreads: [
        '{name} woke before the alarm could ring,\nAnd felt the world was listening.\nThe calendar beside the bed\nHad one red circle, like it said, "Today."',
        'Downstairs the kitchen hummed and clanked,\nThe counter dusted, the oven thanked.\nA bowl of batter, creamy white,\nWas turning into something right.',
        '{name} chose the sprinkles, blue and gold,\nAnd licked the spoon before being told.\nThe frosting went on thick and sweet,\nA little crooked, but complete.',
        'The living room was wrapped in light,\nWith streamers twisted green and white.\nA tower made of cups and plates\nWaited for the birthday guests.',
        'The doorbell rang at half past two,\nAnd in came friends {name} always knew.\nThey brought their laughter, brought their noise,\nAnd boxes wrapped with bows and poise.',
        'They raced around the backyard trees,\nThey caught the bubbles on the breeze.\n{name} won the race and lost the next,\nAnd no one cared who finished best.',
        'Then someone dimmed the kitchen light,\nAnd carried in a golden sight.\nThe cake aglow with tiny flame,\nAnd everyone sang out {name}\'s name.',
        'Eyes closed. A wish.\nThe room held still.\nA breath of hope on the windowsill.',
        'The candles out, the cheering loud,\n{name} grinned into the happy crowd.\nThe wish was secret, tucked away,\nSafe inside that perfect day.',
        'They sat in circles, plates in hand,\nWith frosting fingers, crumbs on land.\nThe kind of mess that no one minds,\nThe kind that happiness designs.',
        'One by one the friends said, "Bye,"\nBeneath a watercolor sky.\n{name} waved them off and turned around,\nThe quietest and sweetest sound.',
        'The new gifts caught the golden light,\nA book, a ball, a lantern bright.\nBut best of all the thing to keep\nWas how it felt, that joy so deep.',
        '[REFRAIN] The streamers curled. The crown still new.\nThe best day yet was made for you.',
      ],
    },
  },

  adventure: {
    'young-picture': {
      description: 'Young picture book (ages 0-3): Adventure exploration arc, AABB couplets, simpler vocabulary, 13 spreads.',
      refrainDiscipline:
        'Refrain choreography: A line about the discovered place, treasure, or guide that returns. Use it 3 times — early when the discovery is named, at the mid-book worry / wonder beat, and in the closing spread. Same wording; the world has changed around it each time.',
      spreads: [
        '{name} found a door behind the tree,\nToo small for grown ups, just for me.',
        'It opened to a field of green,\nThe strangest place you ever seen.',
        'A frog sat on a spotted stone,\nAnd waved as if {name} were known.',
        'The path went left, the path went right,\nOne was dark, and one was bright.',
        '{name} chose the bright one, brave and true,\nAnd walked beneath a sky of blue.',
        'A bridge of vines hung over wide,\n{name} crossed it to the other side.',
        'But then the path began to twist,\nAnd wrapped the woods in silver mist.',
        '{name} remembered something small,\nA song from home that fixed it all.',
        'The mist pulled back, the sun broke through,\nAnd all the world felt bright and new.',
        'A feather fell from who knows where,\nAnd landed softly in the air.',
        '{name} picked it up and held it tight,\nA treasure from the land of light.',
        'Back through the door, back past the tree,\nBack home for supper, milk, and tea.',
        'But in one pocket, safe and small,\nThe feather whispered, "Come back, y\'all."',
      ],
    },
    'picture-book': {
      description: 'Picture book (ages 4-6): Adventure exploration arc, AABB iambic tetrameter, richer vocabulary, 13 spreads.',
      refrainDiscipline:
        'Refrain choreography: One short line tied to the journey\'s gift / discovery, used three times — once when the threshold is crossed, once at the mid-book turn, once at the close. Same wording each time. The closing repeat carries the memory back into ordinary life.',
      spreads: [
        'Behind the shed where ivy grew,\n{name} found a gate nobody knew.\nThe hinges creaked, the rust flaked red,\nAnd something glittered up ahead.',
        'A meadow stretched in every shade,\nWhere sunlight danced and shadows played.\nThe grass was warm beneath bare toes,\nAnd smelled like rain and wild primrose.',
        'A bird with feathers, teal and bright,\nLanded on a branch in sight.\nIt cocked its head as if to say,\n"Well, are you coming? This way."',
        'They crossed a stream on stepping stones,\nThrough archways made of mossy bones.\n{name} counted every stone they crossed,\nAnd never slipped, and never lost.',
        'The forest opened to a cave\nWith painted walls, both old and brave.\nA map of creatures, stars, and seas,\nAnd letters carved in ancient trees.',
        'But deeper in, the torch went out,\nAnd shadows wrapped the walls about.\nThe bird was gone, the map went dark,\nAnd {name} could barely find the mark.',
        'Then {name} remembered something true,\nA trick that only {name} knew.\nA whistle, sharp and clear and strong,\nThe one that always fixed what\'s wrong.',
        'The echo rang from wall to wall,\nAnd tiny lights began to fall.\nLike fireflies in jars of blue,\nThey lit the way completely through.',
        'Beyond the cave a valley shone\nWith flowers made of colored stone.\n{name} stood and breathed the golden air.\nThe quietest, most wondrous prayer.',
        'A fox sat by a silver brook,\nAnd gave {name} one long, gentle look.\nIt dropped a pebble, smooth and round,\nThe only gift that could be found.',
        '{name} pocketed the little stone\nAnd walked the winding path back home.\nThe gate swung shut without a sound,\nThe ivy wrapped the fence back round.',
        'At dinner, sitting in the chair,\n{name} felt the pebble resting there.\nThe world outside looked just the same,\nBut {name} had learned the forest\'s name.',
        '[REFRAIN] And sometimes, when the wind blows wide,\nThe gate still opens from inside.',
      ],
    },
  },

  bedtime: {
    'young-picture': {
      description: 'Young picture book (ages 0-3): Wind-down bedtime arc, AABB couplets, hushed musical rhythm. End with the child cozy and safe — sleep is the ONLY theme where a sleep-image close is allowed. 13 spreads.',
      refrainDiscipline:
        'Refrain choreography: ONE soft line ≤8 words ("The night is soft and true.") repeated three times across the book — once when dusk starts, once at the worry-or-wonder mid-beat, once on the closing spread as the child is tucked in. Same wording; surrounding context moves from outside light → indoor lamp → tucked-in dark.',
      spreads: [
        'The harbor lit a lantern row,\nThe boats came home, the tide rolled slow.',
        'A whale hummed once across the deep,\nThe stars climbed up, the shore would sleep.',
        '[REFRAIN] The night is soft and true.\nThe sky is closing slow for you.',
        'A pebble warmed inside your palm,\nA cricket sang the evening calm.',
        'The lighthouse turned, the gulls flew west,\nThe whole world breathed and chose to rest.',
        'A worry tugged your blanket tight,\nA shadow grew, a sound, a fright.',
        '{parent_name} hummed the worry small,\nThe shadow shrank against the wall.',
        '[REFRAIN] The night is soft and true.\nThe room is keeping watch with you.',
        'The teacup steam rose, slow and white,\nThe lamp went amber, low, just right.',
        'A storybook lay on the floor,\nA last page turned, then one page more.',
        'The pillow puffed, the sheets pulled up,\nA sip of milk inside a cup.',
        'You yawned. The dog yawned too. The sky\nwas full of moths and lullaby.',
        '[REFRAIN] The night is soft and true.\nAnd morning, soon, will come for you.',
      ],
    },
    'picture-book': {
      description: 'Picture book (ages 4-6): Bedtime arc with one tiny worry resolved through a small concrete action. Closing spread shows the child asleep or on the edge of sleep — bedtime is the ONLY exception to the no-sleep-ending rule. 13 spreads.',
      refrainDiscipline:
        'Refrain choreography: One quiet line of 4–8 words returns three times — early to mark the wind-down, mid-book to soften a small fear, late to seal the night. Wording stays the same; light and proximity tighten with each repeat (open sky → bedroom lamp → close-up pillow).',
      spreads: [
        'The hot-air balloon dipped low at dusk,\nA basket light, a sky like husk.\n{name} watched the meadows turn to gold,\nThe far hills folding, soft and old.',
        'They drifted past the lighthouse beam,\nA stitched-up cloud, a half-told dream.\nThe sea below began to hush,\nThe gulls turned home in one slow rush.',
        '[REFRAIN] The night is soft and true.\nThe whole wide world is tucking you.',
        'A worry climbed into the basket,\nQuiet as a folded jacket.\n"What if morning never comes?"\n{name} asked the sky, the hum, the drums.',
        '{parent_name} pointed past the rope,\nA pinprick light, a working hope.\n"That lighthouse keeps the boats ashore,\nAnd morning has done this before."',
        'They sailed across the rooftop town,\nThe streetlamps wearing copper crowns.\nA window glowed where someone read,\nA cat curled small on someone\'s bed.',
        'The basket lowered to the lawn,\nThe stars that watched would still be on.\n{name} climbed out and held the line,\nThe rope still warm, the night still kind.',
        '[REFRAIN] The night is soft and true.\nThe lamp is keeping watch with you.',
        'Inside, the teacup steamed and sighed,\nThe bath was warm, the towel wide.\nA storybook on top of stack,\nA small stuffed fox without a track.',
        'Pajamas soft, a tucked-in sheet,\nThe pillow cool against the cheek.\n{parent_name} read one chapter slow,\nThe lamp turned down, the moon turned low.',
        'A whisper. Then a smaller one.\nThe day was finished, the worry done.\nA single firefly, just outside,\nBlinked twice, then settled down beside.',
        '{name} closed both eyes. The world stayed there,\nThe lighthouse, balloon, the rooftop air.\nThey waited inside the hush of head,\nThe whole soft night beneath the bed.',
        '[REFRAIN] The night is soft and true.\nAnd morning, soon, will come for you.',
      ],
    },
  },

  anxiety: {
    'picture-book': {
      description: 'Picture book (ages 4-6): A small worry is named early, dramatized at its worst around the middle, and resolved through a concrete coping action (a breath, a touched object, a counted thing) — never through "you are brave" declaration. The fear is real and respected; the resolution is a tool the child can keep. 13 spreads.',
      refrainDiscipline:
        'Refrain choreography: One short coping line ≤8 words ("Breathe, and start again.") repeated exactly three times — first when the worry surfaces, second at the worst moment as the child uses the tool, third on the closing spread as a kept-forever resource. The wording does not deepen — the child\'s mastery does.',
      spreads: [
        'The cliff-top observatory hummed,\nThe telescope already drummed.\n{name} held the ticket, edges curled,\nA paper key into the world.',
        'A line of stars stitched up the night,\nA planet flickered into sight.\nThe astronomer waved {name} near,\n"Come look — the rings of Saturn, here."',
        '{name} stepped up close, then stepped away,\nA tightness pinching, hard to say.\n"What if I look and lose my place,\nAnd everyone can see my face?"',
        '[REFRAIN] Breathe, and start again.\nThe worry will not win.',
        'Three slow breaths beside the dome,\nThe paper ticket like a home.\n{name} counted: one, the floor; two, hands;\nThree, the railing where {name} stands.',
        'The eyepiece warmed against the brow,\nThe rings appeared — a perfect bow.\nA tiny gasp, then one bright laugh,\nA night cracked open like a graph.',
        'The line moved on. {name} took the shelf,\nA seat for resting with oneself.\nThe worry crept back in like fog,\nAround the moon, around the dog.',
        'A hand reached over, warm and small —\nA cousin {name} had met that fall.\n"I felt it too. I almost left.\nI counted four, I caught my breath."',
        '[REFRAIN] Breathe, and start again.\nThe worry will not win.',
        'They sat together on the bench,\nThe cold air sharp, the railing French.\n{name} watched the stars walk slowly past,\nThe dome turned gently, not so fast.',
        'The astronomer offered a chart,\nA pencil thin, an open heart.\n{name} drew the rings in steady ink,\nThe hand had stopped its little shrink.',
        'They walked down where the path was lit,\nThe pebbles knew where each foot fit.\nThe worry, smaller than a star,\nStill came along — but not so far.',
        '[REFRAIN] Breathe, and start again.\nThe worry will not win.',
      ],
    },
  },

  grief: {
    'picture-book': {
      description: 'Picture book (ages 4-6): A child carries a missing person through a real day. The story honors absence concretely (an object, a smell, a habit) and ends with the child holding both the missing AND the present world — never with a "they\'re still with you" platitude. The resolution is the child finding a way to carry the love forward. 13 spreads.',
      refrainDiscipline:
        'Refrain choreography: One line about carrying ≤8 words ("I carry them with me.") repeated three times — first when the absence is named, second at the hardest beat as the child holds the object, third at the close as a chosen practice the child keeps. Wording is identical; on the third repeat the child says it instead of the narrator.',
      spreads: [
        'The lighthouse rocks were warm at dawn,\nThe gulls already up and gone.\n{name} held a smooth grey stone {parent_name} found\nThe summer everything was sound.',
        'The keeper waved from up the stair,\n"She loved this view. She brought you here."\nThe wind picked up. The harbor shone.\nA boat went out. {name} stood alone.',
        'The pocket weight, the cold, the salt,\nThe missing wasn\'t {name}\'s own fault.\nIt sat like sand inside the shoe,\nA grain that everything went through.',
        '[REFRAIN] I carry them with me.\nA stone, a name, a sea.',
        '{name} climbed the steps, count one to nine,\nThe iron rail in morning shine.\nThe lamp room glassed the whole horizon,\nA ship, a cloud, a curious bison.',
        'The keeper opened {parent_name}\'s old book,\nA pressed-flat flower, a careful look.\n"She marked her spots. She wrote them down.\nShe walked these rocks. She knew this town."',
        'A page said "watch the grey-back gull",\nA page said "morning fog is full".\n{name} traced the words with one slow thumb,\nThe missing turned to something hum.',
        'Outside, a grey-back gull swept by,\nExactly when the page said why.\n{name} laughed once, sharp, before the cry,\nThe sound a wing makes meeting sky.',
        '[REFRAIN] I carry them with me.\nA stone, a name, a sea.',
        'They climbed back down. The keeper smiled,\n"You walk like her. You always did."\n{name} held the stone, the book, the air,\nThe absence and the morning there.',
        'On the rocks, a pool of lit-up green,\nA hermit crab, a weed unseen.\n{name} crouched and watched the small world move,\nThe day still had a thing to prove.',
        'The boat came in, the gulls came down,\nThe lighthouse held its rusted crown.\n{name} pressed the stone into a pocket,\nA promise tucked beside a locket.',
        '[REFRAIN] I carry them with me.\nA stone, a name, a sea.',
      ],
    },
  },

  friendship: {
    'picture-book': {
      description: 'Picture book (ages 4-6): A peer-to-peer bond shown through doing things side by side — never through advice, never through the friend "saving" the hero. The friend is an equal, not a teacher. End on a small shared object or gesture that proves the bond. 13 spreads.',
      refrainDiscipline:
        'Refrain choreography: One short line ≤8 words ("Side by side, just right.") repeats three times — once when the friend appears, once at the obstacle when they choose each other, once at the close as the kept truth of the day. Wording does not change; the closeness implied by "side by side" tightens (next to each other → shoulder to shoulder → laps touching).',
      spreads: [
        'The treetop walk swung high and thin,\nA rope bridge daring {name} to begin.\nA friend named Ren stood at the start,\nA paper map, a beating heart.',
        'They counted planks: a-one, a-two,\nThe canopy a green-gold blue.\nA squirrel watched from up a vine,\nThe forest smelled of bark and pine.',
        '[REFRAIN] Side by side, just right.\nThe rope bridge held them, light.',
        'A gap in planks, a missing board,\n{name} stopped, the worry like a chord.\nRen reached a hand. {name} did not take.\n"Together," Ren said. "For the brake."',
        'They sat. They breathed. They looked below,\nA river silver, slow, and slow.\n{name} took the hand. They crossed the gap,\nOne foot, one foot, no time to map.',
        'A platform held a tin lunch box,\nA shared tomato, two bread blocks.\nThey ate and laughed about a bee,\nThat dipped, then climbed, the canopy.',
        'A heron stood across the limb,\nIts neck a question, calm and slim.\nThey watched without a single word,\nThe slowest, smartest kind of bird.',
        'A storm cloud bumped the western sky,\nThey started back, the rope held high.\nThe wind got bossy at the rail,\n{name}\'s hand inside Ren\'s did not fail.',
        '[REFRAIN] Side by side, just right.\nThe canopy went silver-bright.',
        'The platform shook, the board went creak,\nRen laughed; {name} laughed; the storm was meek.\nBy the time they reached the trail,\nThe rain had stopped. The trees told tales.',
        'They split a pebble, two halves smooth,\nOne for each pocket, one to soothe.\n"This means we crossed," Ren said, "with you."\n{name} nodded once, the day was true.',
        'They walked the trail beside the stream,\nThe whole walk lit up, beam by beam.\nA different friend would draw a map;\nThis friend just walked, no time-trap.',
        '[REFRAIN] Side by side, just right.\nA pebble each, a kept-good night.',
      ],
    },
  },

  self_worth: {
    'picture-book': {
      description: 'Picture book (ages 4-6): The child\'s value emerges from action and attention — never from declarations like "you are special". Show the child noticing, choosing, helping, persisting. End on the child carrying a small evidence of their own self into the next day. 13 spreads.',
      refrainDiscipline:
        'Refrain choreography: One short line ≤8 words ("There is only one of you.") returns three times — once near the open, once at the comparison-trap mid-beat, once at the close as a fact the child has earned, not been told. Wording does not change; the child\'s ownership of it does.',
      spreads: [
        'The marble ruins stood in sun,\nA crumbled arch, a floor half-done.\n{name} found a coin, a chip of blue,\nA tile someone before once knew.',
        'A class of kids ran past in pairs,\nThe teacher counting up the stairs.\nThey held up coins, all gold and bright,\n{name}\'s coin was small, and grey, and light.',
        '[REFRAIN] There is only one of you.\nAnd one of every thing you do.',
        'A girl said "mine\'s the biggest one."\nA boy said "mine caught all the sun."\n{name} closed a fist around the blue,\nThe finder\'s feeling, small and true.',
        'Behind a column, in the shade,\nA museum lady stopped to trade.\n"That tile," she said, "is ancient stuff —\nHand-glazed. So small. And rare enough."',
        'She held it up against the light,\nThe blue went deep, the blue went bright.\n"Most people walk and miss this kind.\nYou stopped. You looked. You used your mind."',
        '{name} took the tile back to the class,\nNot to compare, just to walk past.\nThe loud ones counted, claimed the rest;\n{name} held the noticing, the best.',
        'A bird flew over, stitched the sky,\nA cricket started, low and shy.\n{name} sat down on a marble stair,\nThe noticing was not a dare.',
        '[REFRAIN] There is only one of you.\nAnd one of every thing you do.',
        'A younger kid had lost a shoe;\n{name} crouched and helped them tie it through.\nNo one watched. No one applauded.\nThe knot held. The afternoon nodded.',
        'The class moved on, the bus pulled out;\n{name} stayed a beat without a doubt.\nThe coin, the tile, the helping hand —\nA small museum {name} could stand.',
        'The marble felt warm under foot,\nThe blue tile cool in pocket-soot.\nThe ruins kept their broken arch;\n{name}\'s noticing now had a march.',
        '[REFRAIN] There is only one of you.\nAnd one of every thing you do.',
      ],
    },
  },

  family_change: {
    'picture-book': {
      description: 'Picture book (ages 4-6): A change in the family shape (move, separation, new sibling, new home). The story does NOT pretend the change is easy — it shows the child sitting with the loss AND finding a continuity (a habit, an object, a phrase) that travels with them. End with the child claiming a piece of the new shape. 13 spreads.',
      refrainDiscipline:
        'Refrain choreography: One short line ≤8 words ("We are still a we.") repeats three times — once when the change is named, once at the lonely middle, once at the close in the new place / new shape. Wording does not change; on the last repeat the child says it (not the narrator).',
      spreads: [
        'The harbor ferry coughed and rolled,\nThe morning mist still mostly cold.\n{name} stood with a duffel, blue and worn,\nThe city shrinking, almost gone.',
        'A gull surveyed the railing pole,\nA seal arched up and made its hole.\nThe old house glowed across the bay,\nA window where {name} used to play.',
        '[REFRAIN] We are still a we.\nA bridge, a boat, a key.',
        'Below deck, {parent_name} held a bag\nOf things to bring across the gap.\nA quilt, a mug, a tin of tea,\nA folded picture, three or three.',
        'The new house was a stitched-up shape,\nA porch, a yard, a paint-bare drape.\n{name} stood inside the empty room,\nThe quiet wider than a tomb.',
        'The mug came out. The kettle clicked.\nThe quilt unfolded, edges flicked.\n{parent_name} pinned the picture by the door,\nThe same one as the house before.',
        'At dinner, soup was the same soup,\nThe bowl was new, the spoon was loop.\n{name} chewed and watched the new wood floor,\nThe missing ached, but not the door.',
        'A neighbor knocked, a kid named Joe,\nWho asked if {name} would like to go\nAnd see the dock where boats came in.\n{name} said maybe. Joe just grinned.',
        '[REFRAIN] We are still a we.\nA bridge, a boat, a key.',
        'The dock was loud, the ropes were thick,\nA fisherman untied a slip.\n{name} watched the waves, the going-out,\nThe coming-back, the sound of route.',
        'Back home, {parent_name} read a book on the rug,\nA blanket softly, like a hug.\nThe ferry crossed again outside,\nThe quilt was wide, the day was wide.',
        'A drawing taped above the bed,\nA bridge, a boat, a thing {name} said.\nThe room had walls. The walls had paint.\nThe new place wore its small new saint.',
        '[REFRAIN] We are still a we.\nSays {name}, says everything.',
      ],
    },
  },
};

/**
 * Anti-exemplars — concrete examples of common AI-flatness failures alongside
 * the fixed version. Injected into the writer prompt so "do not write greeting-
 * card text" is illustrated, not just declared. Two pairs is enough; more
 * dilutes the signal.
 */
const ANTI_EXEMPLARS = [
  {
    label: 'Greeting-card abstraction → concrete action',
    bad: 'You are so loved, you are so kind,\nA gift to all of humankind.\n{parent_name} is proud beyond compare,\nA love so deep, beyond all care.',
    good: '{parent_name} saved the last warm slice\nOf morning toast with cinnamon-spice.\n"For {name}," she said, and pushed the plate,\nThe day already running late.',
    why: 'BAD: declares emotion ("you are loved"), uses adjective stacking ("deep, beyond all care"), and says nothing the illustrator can paint. GOOD: shows love through a specific saved object (toast slice) and a specific action (pushing the plate). The illustration is obvious; the meaning is shown, not stated.',
  },
  {
    label: 'Mundane home opener → striking outdoor opener',
    bad: '{name} woke up in the cozy bed,\nThe sun was peeking in, it said.\nThe kitchen smelled like apple toast,\nA breakfast {name} loved most.',
    good: 'The lighthouse rocks were warm at dawn,\nThe gulls already up and gone.\n{name} stood beside the iron stair,\nThe whole sea breathing, salt and air.',
    why: 'BAD: opens with waking + breakfast (banned mundane defaults). The first page sets the visual stakes for the entire book; "kitchen toast" is a wasted cover-promise. GOOD: opens at a specific named landmark (lighthouse rocks) with concrete sensory anchors (iron stair, salt, air) and a named time-of-day cue (dawn).',
  },
  {
    label: 'Refrain that vanishes → refrain that returns at the close',
    bad: '(Spread 3) The night is soft and true.\n(Spread 5) The night is soft and true.\n(Spread 7) The night is soft and true.\n(Spreads 8–13) … never returns.',
    good: '(Spread 3) The night is soft and true.\n(Spread 8) The night is soft and true.\n(Spread 13) The night is soft and true.',
    why: 'BAD: a refrain front-loaded into the early-middle abandons the reader. The closing spread feels unrelated to the rhythm the book taught. GOOD: at least one repeat lands in spreads 10–13 so the refrain pays off the emotional arc — the closing spread feels earned because the book promised this beat back in spread 3.',
  },
];

/**
 * Get exemplars for a given theme and age tier.
 * @param {string} theme - e.g. 'mothers_day'
 * @param {string} tierName - e.g. 'young-picture', 'picture-book'
 * @returns {object|null} - { description, spreads: string[], refrainDiscipline?: string }
 */
function getExemplars(theme, tierName) {
  return EXEMPLARS[theme]?.[tierName] || null;
}

/**
 * Get the anti-exemplar pairs (BAD vs FIXED) for the writer prompt.
 * @returns {Array<{label: string, bad: string, good: string, why: string}>}
 */
function getAntiExemplars() {
  return ANTI_EXEMPLARS.slice();
}

module.exports = { EXEMPLARS, ANTI_EXEMPLARS, getExemplars, getAntiExemplars };
