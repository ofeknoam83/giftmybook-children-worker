/**
 * Per-theme, per-age-tier exemplar stories.
 *
 * Exemplars demonstrate the craft principles from the research:
 * - AABB couplets with concrete nouns
 * - Actions over declarations
 * - Proper refrains
 * - Emotional arc progression
 *
 * Each exemplar uses {name} and {parent_name} as placeholders.
 */

const EXEMPLARS = {
  mothers_day: {
    'young-picture': {
      description: 'Young picture book (ages 0-3): AABB couplets, iambic tetrameter, simpler vocabulary, musical rhythm. 13 spreads.',
      spreads: [
        'When morning comes and light peeks through,\n{parent_name}\'s first hello is just for you.',
        'She pours the milk, she cuts the pear,\nShe finds the socks you hid somewhere.',
        'At story time she holds you near,\nAnd does the voices you can hear.',
        'She knows the game you like the best,\nThe one you play before you rest.',
        'She sees the things nobody sees,\nYour quiet smile, your scraped up knees.',
        '{parent_name} knows without a word\nThe saddest sigh you ever heard.',
        'And even when the day goes wrong,\nHer arms are where you still belong.',
        'When thunder makes the windows shake,\nShe holds your hand for your own sake.',
        'The house grows still, the clock ticks slow,\nShe hums the song you always know.',
        'She tucks you in without a sound,\nAnd all the world feels safe and round.',
        'She checks the light, she checks the door,\nThen checks on you just one time more.',
        'And if you asked her, "Why do you?"\nShe\'d say, "Because the world made you."',
        'The morning came. The sun shone through.\nAnd {parent_name}\'s first hello was just for you.',
      ],
    },

    'picture-book': {
      description: 'Picture book (ages 4-6): Full narrative arc, AABB iambic tetrameter, richer vocabulary, emotional progression. 13 spreads.',
      spreads: [
        'The sun came up on {name}\'s street,\nWhere puddles waited for bare feet.\n{parent_name} stood at the open door,\n"Today," she said, "let\'s go explore."',
        'She packed the bag with snacks and string,\nA jar for bugs, a bell to ring.\n{name} grabbed the hat with the floppy brim,\nThe one that always looked like him.',
        'They walked the path beside the creek,\nWhere willows bent as if to peek.\n{parent_name} found a feather, white and long,\nAnd {name} made up a marching song.',
        'She knew which rocks were good to throw,\nAnd where the tiny strawberries grow.\nShe let him lead the way back down,\nThe bravest explorer in the town.',
        'She noticed when he stopped to stare\nAt something small caught in the air,\nA seed that drifted, soft and slow.\nShe waited. {parent_name} always seemed to know.',
        'She knew the laugh that meant "I\'m done,"\nThe quiet after too much fun.\nShe pulled him close without a word,\nThe safest place he ever heard.',
        'And even when he spilled the juice,\nAnd let the neighbor\'s rabbit loose,\nAnd said the thing he shouldn\'t say,\nShe loved him just the same that day.',
        'She didn\'t say it. Didn\'t need to.\nHe felt it in the things she\'d do,\nThe extra squeeze, the patient wait,\nThe way she never made him late.',
        '"Why do you always come?" he asked,\nOne evening when the day had passed.\nShe smiled the way she always could,\n"Because you\'re you. And you are good."',
        'The stars blinked on. The house grew still.\nA nightlight glowed on the windowsill.',
        'She tucked the blanket, checked the light,\nAnd whispered "{name}" into the night.\nHe heard her footsteps down the hall,\nThe surest sound he knew at all.',
        'And in his dream the world was wide,\nWith {parent_name} forever at his side.\nNot because he had to ask,\nBut because she chose him, first and last.',
        'The morning came. The sun shone through.\nAnd {parent_name}\'s first hello was just for you.',
      ],
    },
  },
  fathers_day: {
    'young-picture': {
      description: 'Young picture book (ages 0-3): AABB couplets, iambic tetrameter, simpler vocabulary, musical rhythm. 13 spreads.',
      spreads: [
        'The sun peeks in across the floor,\n{parent_name} is at the door.\nHe scoops you up, still warm from sleep,\nAnd holds you close without a peep.',
        'He makes the eggs, he pours the juice,\nHe finds your shoe that wriggled loose.\n{parent_name} hums a morning song,\nAnd you just hum and tag along.',
        'He lifts you up above his head,\nYou touch the sky from where he said.\nThe world below is far and small,\nBut {parent_name} will never let you fall.',
        'He holds your hand across the hill,\nYou race him down and feel the thrill.\nHe lets you win by half a stride,\nAnd grins the widest grin with pride.',
        'He cuts the paper, folds the crown,\nYou wear it backwards, upside down.\n{parent_name} says it suits you best,\nThe finest crown above the rest.',
        '{parent_name} knows your little ways,\nThe scrunched up nose on rainy days,\nThe song you sing below your breath,\nThe way you sigh before you rest.',
        'He sees the things nobody sees,\nYour tangled hair, your muddy knees.\nHe knows the look that means "I\'m done,"\nAnd gathers you before you run.',
        'And even when the blocks fall down,\nAnd all you want to do is frown,\nHe sits beside you on the floor,\nAnd builds the tower up once more.',
        'He reads the book, he does the bear,\nHe growls so loud you gasp for air.\nThen whispers soft and tucks you tight,\nAnd checks the room for too much light.',
        '{parent_name} stays beside the bed.\nHe rests his hand upon your head.',
        'The stars blink on, the house sits still,\nA nightlight glows upon the sill.\nHe hears your breathing soft and deep,\nThe surest sound before his sleep.',
        'And if you asked him, "Why do you?"\nHe\'d say, "The world is best with you."\n{parent_name} is here. He\'ll always be.\nAs close as breath, as sure as sea.',
        'The morning came. The sun shone through.\n{parent_name} was right there next to you.',
      ],
    },

    'picture-book': {
      description: 'Picture book (ages 4-6): Full narrative arc, AABB iambic tetrameter, richer vocabulary, emotional progression. 13 spreads.',
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
        'Two shadows walked the lamplight hall.\nOne big. One brave. One strong. One small.',
        'He tucked the blanket, checked the shelf,\nThe one they built there by themself.\n{name} touched the wood and felt the groove,\nThe surest proof of how things move.',
        'And in the dream the world grew wide,\nWith {parent_name} forever at their side.\nNot asked for, never having to,\nBut choosing this, and choosing you.',
        'The morning came. The sun shone through.\nThe red toolbox was waiting, too.',
      ],
    },
  },

  birthday: {
    'young-picture': {
      description: 'Young picture book (ages 0-3): Birthday celebration arc, AABB couplets, simpler vocabulary, 13 spreads.',
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
        '{name} held a toy up to the light,\nThe favorite one to hold at night.',
        'The sun went down. The stars came through.\nThe best day yet was made for you.',
      ],
    },
    'picture-book': {
      description: 'Picture book (ages 4-6): Birthday celebration arc, AABB iambic tetrameter, richer vocabulary, 13 spreads.',
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
        'Upstairs the new gifts caught the light,\nA book, a ball, a lantern bright.\nBut best of all the thing to keep\nWas how it felt before the sleep.',
        'The sun went down. The stars came through.\nThe best day yet was made for you.',
      ],
    },
  },

  adventure: {
    'young-picture': {
      description: 'Young picture book (ages 0-3): Adventure exploration arc, AABB couplets, simpler vocabulary, 13 spreads.',
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
        'And sometimes, when the wind blows wide,\nThe gate still opens from inside.',
      ],
    },
  },
};

/**
 * Get exemplars for a given theme and age tier.
 * @param {string} theme - e.g. 'mothers_day'
 * @param {string} tierName - e.g. 'young-picture', 'picture-book'
 * @returns {object|null} - { description, spreads: string[] }
 */
function getExemplars(theme, tierName) {
  return EXEMPLARS[theme]?.[tierName] || null;
}

module.exports = { EXEMPLARS, getExemplars };
