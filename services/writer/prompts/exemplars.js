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
    'board-book': {
      description: 'Board book (ages 0-2): Simple couplets, bouncy rhythm, one idea per spread.',
      spreads: [
        '{parent_name} holds me up so high,\nI can almost touch the sky.',
        '{parent_name} pours my cup with care,\nMilk and love are always there.',
        'We splash and play, we stomp and spin,\n{parent_name} always lets me win.',
        '{parent_name} reads me one more book,\nSee the bear? Come take a look.',
        'When I cry she holds me near,\n"{parent_name}\'s here," is all I hear.',
        'Stars come out, the moon shines bright,\n{parent_name} whispers, "Sweet goodnight."',
      ],
    },

    'early-picture': {
      description: 'Early picture book (ages 2-3): AABB couplets, iambic tetrameter, pattern with variation.',
      spreads: [
        'When morning comes and light peeks through,\n{parent_name}\'s first hello is just for you.',
        'She pours the milk, she cuts the pear,\nShe finds the socks you hid somewhere.',
        'At story time she holds you near,\nAnd does the voices you can hear.',
        'She knows the game you like the best,\nThe one you play before you rest.',
        'She sees the things nobody sees—\nYour quiet smile, your scraped-up knees.',
        '{parent_name} knows without a word\nThe saddest sigh you ever heard.',
        'And even when the day goes wrong,\nHer arms are where you still belong.',
        'When thunder makes the windows shake,\nShe holds your hand for your own sake.',
        'The house grows still, the clock ticks slow,\nShe hums the song you always know.',
        'She tucks you in without a sound,\nAnd all the world feels safe and round.',
        'She checks the light, she checks the door,\nThen checks on you just one time more.',
        'And if you asked her, "Why do you?"\nShe\'d say, "Because the world made you."',
      ],
    },

    'picture-book': {
      description: 'Picture book (ages 3-5): Full narrative arc, AABB iambic tetrameter, emotional progression.',
      spreads: [
        'The sun came up on {name}\'s street,\nWhere puddles waited for bare feet.\n{parent_name} stood at the open door—\n"Today," she said, "let\'s go explore."',
        'She packed the bag with snacks and string,\nA jar for bugs, a bell to ring.\n{name} grabbed the hat with the floppy brim—\nThe one that always looked like him.',
        'They walked the path beside the creek,\nWhere willows bent as if to peek.\n{parent_name} found a feather, white and long,\nAnd {name} made up a marching song.',
        'She knew which rocks were good to throw,\nAnd where the tiny strawberries grow.\nShe let him lead the way back down,\nThe bravest explorer in the town.',
        'She noticed when he stopped to stare\nAt something small caught in the air—\nA seed that drifted, soft and slow.\nShe waited. {parent_name} always seemed to know.',
        'She knew the laugh that meant "I\'m done,"\nThe quiet after too much fun.\nShe pulled him close without a word—\nThe safest place he ever heard.',
        'And even when he spilled the juice,\nAnd let the neighbor\'s rabbit loose,\nAnd said the thing he shouldn\'t say—\nShe loved him just the same that day.',
        'She didn\'t say it. Didn\'t need to.\nHe felt it in the things she\'d do—\nThe extra squeeze, the patient wait,\nThe way she never made him late.',
        '"Why do you always come?" he asked,\nOne evening when the day had passed.\nShe smiled the way she always could—\n"Because you\'re you. And you are good."',
        'The stars blinked on. The house grew still.\nA nightlight glowed on the windowsill.',
        'She tucked the blanket, checked the light,\nAnd whispered "{name}" into the night.\nHe heard her footsteps down the hall—\nThe surest sound he knew at all.',
        'And in his dream the world was wide,\nWith {parent_name} forever at his side.\nNot because he had to ask—\nBut because she chose him, first and last.',
        'The morning came. The sun shone through.\nAnd {parent_name}\'s first hello was just for you.',
      ],
    },
  },
};

/**
 * Get exemplars for a given theme and age tier.
 * @param {string} theme - e.g. 'mothers_day'
 * @param {string} tierName - e.g. 'board-book', 'early-picture', 'picture-book'
 * @returns {object|null} - { description, spreads: string[] }
 */
function getExemplars(theme, tierName) {
  return EXEMPLARS[theme]?.[tierName] || null;
}

module.exports = { EXEMPLARS, getExemplars };
