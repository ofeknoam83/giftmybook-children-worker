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
