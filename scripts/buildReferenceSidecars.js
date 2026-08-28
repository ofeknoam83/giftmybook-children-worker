/**
 * One-off builder for the 12 hand-authored REFERENCE sidecars (one per
 * theme, 4–5 band). Encodes each book's slots explicitly — reviewed
 * content, not runtime generation. Output: services/catalogEngine/data/
 * augments/approved/{book_id}.json, then validated by loadAugments().
 *
 * Rerun after editing a spec: node scripts/buildReferenceSidecars.js
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'services', 'catalogEngine', 'data', 'augments', 'approved');

/** Shared slot factories — each returns a schema-shaped slot. */
const slot = (id, spread, types, fields, priority, instruction, visual, extra = {}) => ({
  slot_id: id,
  spread,
  allowed_moment_types: types,
  allowed_profile_fields: fields,
  priority,
  max_uses: 1,
  instruction,
  visual_alignment: visual,
  ...extra,
});
const NO_VISUAL = { mode: 'none' };
const OPTIONAL_VISUAL = { mode: 'optional' };
const vis = id => ({ mode: 'required_if_used', visual_slot_id: id });

function objectIntro(worldEntry) {
  return slot('s01_object_intro', 1, ['object_presence'], ['object'], 'preferred',
    `A small supplied portable object may be carried, held, or tucked under the child's arm on arrival. It is decorative and comforting only — it does not affect ${worldEntry}.`,
    vis('spread_01_object_near_child'));
}
function placeCompare(spread, sceneNote) {
  return slot(`s0${spread}_place_compare`, spread, ['place_reference', 'interest_comparison'], ['place', 'interests'], 'optional',
    `One light, age-appropriate comparison or memory may color the child's reaction to ${sceneNote}. The fixed setting never changes and the comparison never adds a clue.`,
    NO_VISUAL);
}
function traitBehavior(spread, actionNote) {
  return slot(`s0${spread}_trait`, spread, ['trait_behavior'], ['trait'], 'preferred',
    `A supplied temperament may show through HOW the child ${actionNote} — never named as a label, never granting knowledge or changing the fixed solution.`,
    NO_VISUAL);
}
function habitMoment(spread, sceneNote) {
  return slot(`s0${spread}_habit`, spread, ['habit_behavior'], ['habit'], 'preferred',
    `A supplied endearing habit may appear once, briefly and affectionately, while the child ${sceneNote}. It must stay small and never solve or delay the fixed plot.`,
    OPTIONAL_VISUAL);
}
function interestReaction(spread, sceneNote) {
  return slot(`s0${spread}_interest`, spread, ['interest_reaction', 'interest_comparison'], ['interests', 'activities'], 'preferred',
    `The child may notice or react to ${sceneNote} through a supplied interest or activity — attention and delight only, never expertise beyond age and never the answer.`,
    NO_VISUAL);
}
function foodCelebration(spread, sceneNote) {
  return slot(`s${String(spread).padStart(2, '0')}_food`, spread, ['food_celebration'], ['food'], 'optional',
    `A supplied favorite food may appear as one small item during ${sceneNote} — food is already plausible here. No allergy, diet, or health claims; never called out repeatedly.`,
    vis(`spread_${String(spread).padStart(2, '0')}_food`));
}
function objectClose(worldName) {
  return slot('s12_object_close', 12, ['object_callback', 'closing_callback'], ['object'], 'preferred',
    `The object introduced on spread 1 may return softly in the goodbye image or sentence as the child leaves ${worldName}. The fixed ending never changes.`,
    vis('spread_12_object_near_child'),
    { requires_prior_detail_use: true });
}

const TARGETS = { min_moments: 4, ideal_moments: 5, max_moments: 6, min_details: 2, max_details: 4 };

/** The MIXUP family: see 3 things → 3 corrections (spreads 5/6/10), count on 7, study on 9, payoff on 11. */
function mixupSlots({ worldEntry, seeNote, studyNote, worldName, food }) {
  const slots = [
    objectIntro(worldEntry),
    placeCompare(2, seeNote),
    traitBehavior(5, 'makes the first correction — checking, comparing, or working gently'),
    habitMoment(7, 'counts the two finished corrections and checks the scene'),
    interestReaction(9, `${studyNote} before deciding the final correct place`),
    objectClose(worldName),
  ];
  if (food) slots.splice(5, 0, foodCelebration(11, 'the playful payoff when everything is correct again'));
  return slots;
}

/** The JOBS family: 3 jobs shown on 2, done on 3/5/10, think-finished on 7, notice on 8, all visible on 11. */
function jobsSlots({ worldEntry, jobsNote, worldName, food }) {
  const slots = [
    objectIntro(worldEntry),
    placeCompare(2, jobsNote),
    traitBehavior(3, 'completes the first job — careful hands, patient steps, or cheerful energy'),
    habitMoment(7, 'pauses with the companion, briefly thinking the work is done'),
    interestReaction(9, 'checking the remaining item and identifying the final job'),
    objectClose(worldName),
  ];
  if (food) slots.splice(5, 0, foodCelebration(11, 'the calm moment when all three finished jobs are visible together'));
  return slots;
}

/** The ROUTE/SPATIAL family: problem on 4-5, pause+study 6-7, choose 8, test 9, payoff 11. */
function routeSlots({ worldEntry, studyNote, worldName, food }) {
  const slots = [
    objectIntro(worldEntry),
    placeCompare(3, 'the nearby landmarks along the way'),
    habitMoment(6, 'stops and looks at the wider area instead of forcing the first idea'),
    traitBehavior(8, `notices the safe way — ${studyNote}`),
    interestReaction(9, 'testing the chosen way with the companion'),
    objectClose(worldName),
  ];
  if (food) slots.splice(5, 0, foodCelebration(11, 'the calm or funny payoff at the destination'));
  return slots;
}

const BOOKS = {
  farm_4_5_little_chick: {
    selection_profile: {
      primary_tags: ['animals', 'baby animals', 'chickens', 'farm animals', 'hide and seek'],
      activity_tags: ['searching', 'listening', 'caring for pets', 'animal care'],
      trait_affinities: ['gentle', 'patient', 'caring', 'kind', 'attentive'],
      contraindications: [],
    },
    slots: [
      objectIntro('the farm visit'),
      placeCompare(2, 'the lively farmyard reveal'),
      traitBehavior(7, 'chooses where to look and searches — gently, patiently, or bravely'),
      habitMoment(8, 'stops rushing and listens for the quiet peep'),
      interestReaction(9, 'finding the chick safe beside the wooden basket'),
      foodCelebration(11, "the low-key celebration with all three chicks together (the beat's optional snack)"),
      objectClose('Sunnybrook Farm'),
    ],
  },
  dinosaur_4_5_mixed_footprints: {
    selection_profile: {
      primary_tags: ['dinosaurs', 'puzzles', 'matching', 'patterns', 'tracks'],
      activity_tags: ['sorting', 'matching games', 'puzzles', 'exploring'],
      trait_affinities: ['observant', 'curious', 'careful', 'logical'],
      contraindications: [],
    },
    slots: mixupSlots({
      worldEntry: 'entry into Dino Valley',
      seeNote: 'seeing the three kinds of dinosaur tracks',
      studyNote: 'studying track shape and size',
      worldName: 'Dino Valley',
      food: false,
    }),
  },
  space_4_5_rover_route: {
    selection_profile: {
      primary_tags: ['space', 'rockets', 'rovers', 'maps', 'exploring'],
      activity_tags: ['exploring', 'building', 'hiking', 'riding'],
      trait_affinities: ['careful', 'thoughtful', 'brave', 'calm'],
      contraindications: [],
    },
    slots: routeSlots({
      worldEntry: 'the walk through Star Station',
      studyNote: 'the wider flat path away from the crater edge',
      worldName: 'Star Station',
      food: false,
    }),
  },
  sea_4_5_fish_school: {
    selection_profile: {
      primary_tags: ['ocean', 'fish', 'sea creatures', 'patterns', 'matching'],
      activity_tags: ['swimming', 'sorting', 'matching games'],
      trait_affinities: ['observant', 'gentle', 'curious', 'careful'],
      contraindications: [],
    },
    // Underwater: no food slot (implausible beat), per the authoring constraints.
    slots: mixupSlots({
      worldEntry: 'the arrival in Coral Cove',
      seeNote: 'seeing the striped, spotted, and silver fish',
      studyNote: 'studying the visible patterns and usual areas',
      worldName: 'Coral Cove',
      food: false,
    }),
  },
  jungle_4_5_fruit_mixup: {
    selection_profile: {
      primary_tags: ['jungle animals', 'animals', 'monkeys', 'matching', 'food for animals'],
      activity_tags: ['feeding animals', 'sorting', 'helping'],
      trait_affinities: ['helpful', 'observant', 'kind', 'careful'],
      contraindications: [],
    },
    slots: mixupSlots({
      worldEntry: 'the arrival in Rainforest Valley',
      seeNote: 'seeing the three snack baskets for the animals',
      studyNote: 'studying what each animal is already eating',
      worldName: 'Rainforest Valley',
      food: false, // the baskets are the ANIMALS' food — a personal favorite food would blur the fixed clue system
    }),
  },
  safari_4_5_giraffe_lunch: {
    selection_profile: {
      primary_tags: ['safari animals', 'animals', 'giraffes', 'helping', 'feeding animals'],
      activity_tags: ['helping', 'chores', 'delivering', 'animal care'],
      trait_affinities: ['helpful', 'responsible', 'attentive', 'kind'],
      contraindications: [],
    },
    slots: jobsSlots({
      worldEntry: 'the arrival in Sunny Savanna',
      jobsNote: 'seeing the three feeding jobs laid out',
      worldName: 'Sunny Savanna',
      food: false, // the bundles are animal feed — same clue-blur rule as the jungle book
    }),
  },
  enchanted_4_5_signpost_mixup: {
    selection_profile: {
      primary_tags: ['puzzles', 'patterns', 'maps', 'magic', 'fairy tales'],
      activity_tags: ['sorting', 'building', 'matching games'],
      trait_affinities: ['careful', 'curious', 'observant'],
      contraindications: [],
    },
    slots: mixupSlots({
      worldEntry: 'entry into Whispering Wood',
      seeNote: 'seeing the three picture signs',
      studyNote: 'studying the picture symbols and landmarks',
      worldName: 'Whispering Wood',
      food: true, // spread 11's playful payoff is a small festival moment — one treat is plausible
    }),
  },
  pirate_4_5_map_piece: {
    selection_profile: {
      primary_tags: ['pirates', 'treasure', 'maps', 'puzzles', 'boats'],
      activity_tags: ['puzzles', 'building', 'exploring', 'climbing'],
      trait_affinities: ['thoughtful', 'patient', 'brave', 'careful'],
      contraindications: [],
    },
    slots: routeSlots({
      worldEntry: 'the arrival in Coral Compass Isles',
      studyNote: 'the open path around the supply chest',
      worldName: 'Coral Compass Isles',
      food: false,
    }),
  },
  construction_4_5_site_helper: {
    selection_profile: {
      primary_tags: ['trucks', 'building', 'construction', 'machines', 'tools'],
      activity_tags: ['building', 'helping', 'stacking', 'delivering'],
      trait_affinities: ['helpful', 'responsible', 'careful', 'energetic'],
      contraindications: [],
    },
    slots: jobsSlots({
      worldEntry: 'the arrival in Build-It Yard',
      jobsNote: 'seeing the three delivery jobs laid out',
      worldName: 'Build-It Yard',
      food: true, // spread 11: work done, a small snack break beside Builder Sam is plausible
    }),
  },
  dream_4_5_star_cards: {
    selection_profile: {
      primary_tags: ['stars', 'bedtime', 'dreams', 'matching', 'pictures'],
      activity_tags: ['drawing', 'matching games', 'stargazing'],
      trait_affinities: ['calm', 'gentle', 'observant', 'imaginative'],
      contraindications: [],
    },
    // Dreamworld/sleep-adjacent: no food slot, per the authoring constraints.
    slots: mixupSlots({
      worldEntry: 'the arrival in Cloudlight',
      seeNote: 'seeing the moon, star, and cloud cards',
      studyNote: 'matching the pictures to the glowing markers',
      worldName: 'Cloudlight',
      food: false,
    }),
  },
  christmas_4_5_present_mixup: {
    selection_profile: {
      primary_tags: ['christmas', 'presents', 'holidays', 'matching', 'symbols'],
      activity_tags: ['wrapping presents', 'sorting', 'decorating', 'helping'],
      trait_affinities: ['helpful', 'careful', 'cheerful', 'observant'],
      contraindications: [],
    },
    slots: mixupSlots({
      worldEntry: 'the arrival in Snowberry Village',
      seeNote: 'seeing the three symbol-marked parcels',
      studyNote: 'studying the symbols and shelf colors',
      worldName: 'Snowberry Village',
      food: true, // spread 11's payoff in a Christmas village — one festive treat is plausible
    }),
  },
  thanksgiving_4_5_table_helper: {
    selection_profile: {
      primary_tags: ['thanksgiving', 'family meals', 'holidays', 'helping', 'decorating'],
      activity_tags: ['helping', 'setting the table', 'decorating', 'cooking'],
      trait_affinities: ['helpful', 'kind', 'responsible', 'cheerful'],
      contraindications: [],
    },
    slots: jobsSlots({
      worldEntry: 'the arrival in Maple Harvest Hall',
      jobsNote: 'seeing the three table jobs laid out',
      worldName: 'Maple Harvest Hall',
      food: true, // a harvest-meal hall — the beat's payoff plausibly includes one favorite dish detail
    }),
  },
};

fs.mkdirSync(OUT, { recursive: true });
for (const [bookId, spec] of Object.entries(BOOKS)) {
  const sidecar = {
    book_id: bookId,
    authored: 'reference-set-2026-08-28',
    selection_profile: spec.selection_profile,
    personalization_map: {
      schema_version: '1.3.0',
      map_version: '1.0.0',
      book_id: bookId,
      targets: TARGETS,
      detail_repeat_limit: 3,
      slots: spec.slots,
    },
  };
  fs.writeFileSync(path.join(OUT, `${bookId}.json`), JSON.stringify(sidecar, null, 2) + '\n');
  console.log(`wrote ${bookId}.json (${spec.slots.length} slots)`);
}
console.log('\nValidating via loadAugments...');
const { loadAugments, coverageReport } = require('../services/catalogEngine/augments');
loadAugments();
console.log(JSON.stringify(coverageReport(), null, 1).slice(0, 400));
