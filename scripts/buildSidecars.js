/**
 * Full-catalog sidecar builder — authors `selection_profile` +
 * `personalization_map` sidecars for EVERY catalog book that doesn't
 * already have an approved one (the 12 hand-tuned reference files are
 * kept as-is and skipped).
 *
 * Deterministic, no LLM: the catalog's 20 archetypes share fixed beat
 * skeletons, so each archetype gets a reviewed slot scaffold placed on the
 * beats that actually support it (trait where the child already acts,
 * habit on a pause/reaction beat, food ONLY on an explicit
 * celebration/snack/payoff beat in a theme where human food is plausible).
 * Selection tags combine theme vocabulary, archetype experience tags, and
 * nouns actually present in the book's own beats.
 *
 * Output: services/catalogEngine/data/augments/approved/{book_id}.json,
 * then the whole set is re-validated by loadAugments() (throws on any
 * schema/cross-check failure).
 *
 * Rerun after editing a spec: node scripts/buildSidecars.js
 */

const fs = require('fs');
const path = require('path');
const { loadCatalog } = require('../services/catalogEngine/catalog');

const OUT = path.join(__dirname, '..', 'services', 'catalogEngine', 'data', 'augments', 'approved');

// ── Theme vocabulary (what a parent would type) ─────────────────────────────
const THEME_TAGS = {
  farm: { primary: ['animals', 'farm animals', 'tractors'], activities: ['animal care', 'visiting farms'] },
  dinosaur: { primary: ['dinosaurs', 't-rex', 'fossils'], activities: ['dinosaur games', 'exploring'] },
  space: { primary: ['space', 'rockets', 'planets', 'astronauts'], activities: ['stargazing', 'building rockets'] },
  under_the_sea: { primary: ['ocean', 'fish', 'sea creatures', 'mermaids'], activities: ['swimming', 'beach days'] },
  jungle: { primary: ['jungle animals', 'monkeys', 'animals'], activities: ['climbing', 'exploring'] },
  safari: { primary: ['safari animals', 'lions', 'giraffes', 'animals'], activities: ['animal watching', 'exploring'] },
  enchanted_forest: { primary: ['magic', 'fairies', 'fairy tales'], activities: ['pretend play', 'storytime'] },
  pirate: { primary: ['pirates', 'treasure', 'boats'], activities: ['treasure hunts', 'swimming'] },
  construction: { primary: ['trucks', 'building', 'construction', 'machines'], activities: ['building', 'stacking blocks'] },
  dream: { primary: ['stars', 'bedtime', 'dreams', 'moon'], activities: ['stargazing', 'storytime'] },
  christmas: { primary: ['christmas', 'presents', 'holidays', 'santa'], activities: ['decorating', 'baking'] },
  thanksgiving: { primary: ['thanksgiving', 'holidays', 'family meals'], activities: ['helping', 'cooking', 'decorating'] },
};

// Themes where a PERSONAL snack is plausible on a celebration beat.
// Excluded on purpose: under_the_sea (underwater), dream (sleep-adjacent),
// jungle + safari (the ANIMALS' food is the plot's clue system — a personal
// snack would blur it), space (suited/mission scenes), dinosaur, pirate.
const FOOD_OK_THEMES = new Set(['farm', 'enchanted_forest', 'construction', 'christmas', 'thanksgiving']);

// Nouns worth surfacing as selection tags when a book's own beats mention them.
const KEYWORD_NOUNS = [
  'chicken', 'chickens', 'sheep', 'pony', 'cow', 'goat', 'duck', 'tractor', 'hay',
  'triceratops', 'stegosaurus', 'brachiosaurus', 'ankylosaurus', 'pterosaur', 'nest', 'eggs',
  'rover', 'robot', 'robots', 'comet', 'crater', 'moon rock', 'solar panel', 'telescope',
  'turtle', 'octopus', 'dolphin', 'seahorse', 'starfish', 'crab', 'seagrass', 'coral',
  'monkey', 'monkeys', 'sloth', 'frog', 'parrot', 'toucan', 'butterfly', 'butterflies',
  'elephant', 'elephants', 'giraffe', 'zebra', 'meerkat', 'lion', 'hippo',
  'lantern', 'signpost', 'moonflower', 'ribbon', 'glow', 'fireflies',
  'map', 'treasure', 'chest', 'flag', 'ship', 'compass',
  'crane', 'digger', 'cone', 'bricks', 'blocks', 'truck', 'bulldozer',
  'star', 'stars', 'cloud', 'clouds', 'pillow', 'moonbeam',
  'present', 'presents', 'sleigh', 'bell', 'snow', 'reindeer', 'elf', 'ornament',
  'pumpkin', 'turkey', 'leaves', 'acorn', 'napkin', 'pie', 'harvest',
  'counting', 'footprints', 'tracks', 'parade', 'picnic', 'waterwheel',
];

// ── Archetype experience tags ───────────────────────────────────────────────
const ARCH_TAGS = {
  '2-3_hello': { primary: ['first visits', 'animals'], activities: ['pointing and naming', 'counting'], traits: ['curious', 'gentle', 'happy', 'shy'] },
  '2-3_jobs': { primary: ['helping'], activities: ['helping', 'feeding animals', 'little chores'], traits: ['helpful', 'kind', 'busy', 'gentle'] },
  '2-3_movement': { primary: ['rides', 'vehicles'], activities: ['riding', 'dancing', 'moving to music'], traits: ['energetic', 'giggly', 'brave', 'happy'] },
  '2-3_sensory': { primary: ['discovering', 'sounds'], activities: ['pointing and naming', 'peekaboo', 'copying sounds'], traits: ['curious', 'observant', 'giggly', 'gentle'] },
  '4-5_clue_search': { primary: ['hide and seek', 'baby animals'], activities: ['searching', 'listening'], traits: ['gentle', 'patient', 'caring', 'kind'] },
  '4-5_delivery': { primary: ['helping', 'deliveries'], activities: ['helping', 'chores', 'delivering'], traits: ['helpful', 'responsible', 'attentive', 'kind'] },
  '4-5_sort': { primary: ['puzzles', 'matching', 'patterns'], activities: ['sorting', 'matching games', 'tidying'], traits: ['careful', 'observant', 'curious', 'orderly'] },
  '4-5_parade': { primary: ['parades', 'music'], activities: ['marching', 'dancing', 'singing'], traits: ['cheerful', 'energetic', 'helpful', 'funny'] },
  '4-5_spatial': { primary: ['puzzles', 'problem solving'], activities: ['puzzles', 'building', 'climbing'], traits: ['thoughtful', 'patient', 'determined', 'careful'] },
  '4-5_route': { primary: ['maps', 'exploring'], activities: ['exploring', 'hiking', 'riding'], traits: ['careful', 'thoughtful', 'brave', 'calm'] },
  '6-7_clue': { primary: ['mysteries', 'detective stories', 'clues'], activities: ['solving mysteries', 'exploring'], traits: ['curious', 'observant', 'logical', 'persistent'] },
  '6-7_detour': { primary: ['maps', 'routes', 'exploring'], activities: ['hiking', 'biking', 'exploring'], traits: ['thoughtful', 'calm', 'careful', 'decisive'] },
  '6-7_observation': { primary: ['how things work', 'nature', 'science'], activities: ['experiments', 'watching animals', 'asking questions'], traits: ['observant', 'patient', 'curious', 'logical'] },
  '6-7_sequence': { primary: ['planning', 'organizing'], activities: ['organizing', 'helping', 'building'], traits: ['organized', 'patient', 'thoughtful', 'helpful'] },
  '6-7_marker': { primary: ['patterns', 'puzzles', 'trails'], activities: ['exploring', 'puzzles', 'measuring'], traits: ['observant', 'precise', 'patient', 'curious'] },
  '8-10_mystery': { primary: ['mysteries', 'detective stories', 'evidence'], activities: ['solving mysteries', 'reading', 'investigating'], traits: ['logical', 'observant', 'skeptical', 'curious'] },
  '8-10_system': { primary: ['how things work', 'machines', 'science'], activities: ['experiments', 'building', 'fixing things'], traits: ['analytical', 'patient', 'curious', 'methodical'] },
  '8-10_map': { primary: ['maps', 'orienteering', 'geography'], activities: ['map reading', 'hiking', 'exploring'], traits: ['precise', 'logical', 'observant', 'adventurous'] },
  '8-10_planning': { primary: ['planning', 'strategy', 'organizing'], activities: ['organizing', 'strategy games', 'projects'], traits: ['organized', 'strategic', 'thoughtful', 'responsible'] },
  '8-10_guide': { primary: ['facts', 'collecting', 'field guides'], activities: ['collecting', 'reading', 'identifying animals'], traits: ['knowledgeable', 'observant', 'methodical', 'curious'] },
};

// ── Archetype slot scaffolds ────────────────────────────────────────────────
// {place, trait, habit, interest} = spread numbers chosen from the beat
// skeleton (child action supports the moment); notes describe the fixed
// action the moment attaches to. foodSpread only where the beat celebrates.
const ARCH_SLOTS = {
  '2-3_hello': { place: 2, trait: [4, 'shares the playful hello moment — gently, giggling, or boldly'], habit: [8, 'joins the simple movement or imitation game'], interest: [9, 'the funny little discovery moment'], foodSpread: 11 },
  '2-3_jobs': { place: 2, trait: [3, 'starts the first little job — with gentle hands, busy energy, or great focus'], habit: [6, 'enjoys the playful payoff of the second job'], interest: [9, 'proudly counting the finished jobs'], foodSpread: 11 },
  '2-3_movement': { place: 2, trait: [8, 'copies or joins the simple movement'], habit: [6, 'the funny small reaction while moving'], interest: [4, 'the first friendly sight they pass'], foodSpread: null },
  '2-3_sensory': { place: 2, trait: [5, 'follows the second clue to its friendly source'], habit: [8, 'imitates or reacts to the discoveries'], interest: [3, 'noticing the first clue'], foodSpread: null },
  '4-5_clue_search': { place: 2, trait: [7, 'chooses where to look and searches — gently, patiently, or bravely'], habit: [8, 'stops rushing and listens closely'], interest: [9, 'the safe, happy find'], foodSpread: 11 },
  '4-5_delivery': { place: 2, trait: [3, 'completes the first job — careful hands, patient steps, or cheerful energy'], habit: [7, 'pauses with the companion, briefly thinking the work is done'], interest: [9, 'checking the remaining item and identifying the final job'], foodSpread: 11 },
  '4-5_sort': { place: 2, trait: [5, 'makes the first correction — checking, comparing, or working gently'], habit: [7, 'counts the two finished corrections and checks the scene'], interest: [9, 'studying the fixed clues before deciding the final correct place'], foodSpread: 11 },
  '4-5_parade': { place: 2, trait: [3, 'gathers the first group — calmly, cheerfully, or with great care'], habit: [6, 'enjoys counting the three ready groups'], interest: [9, 'rebuilding the order one group at a time'], foodSpread: 11 },
  '4-5_spatial': { place: 3, trait: [7, 'stops and studies the surroundings instead of forcing the first approach'], habit: [4, 'the playful moment in the nearby area'], interest: [9, 'following the safe way through'], foodSpread: 11 },
  '4-5_route': { place: 3, trait: [8, 'notices and chooses the safe way'], habit: [6, 'stops and looks at the wider area instead of forcing the first idea'], interest: [9, 'testing the chosen way with the companion'], foodSpread: 11 },
  '6-7_clue': { place: 3, trait: [7, 'returns to the evidence and chooses what to check next'], habit: [5, 'follows or tests the first idea'], interest: [8, 'spotting the clearer second clue'], foodSpread: 11 },
  '6-7_detour': { place: 3, trait: [7, 'compares the possible routes using the fixed landmarks'], habit: [6, 'stops and studies the wider layout'], interest: [9, 'the small detail that confirms the plan'], foodSpread: null },
  '6-7_observation': { place: 3, trait: [6, 'looks again at the surroundings after the obvious cause falls short'], habit: [8, 'predicting what should happen if the real cause is right'], interest: [9, 'testing the prediction safely'], foodSpread: null },
  '6-7_sequence': { place: 2, trait: [5, 'pauses rather than forcing the plan'], habit: [6, 'compares what each remaining task needs'], interest: [9, 'seeing the right order unlock the next task'], foodSpread: 11 },
  '6-7_marker': { place: 2, trait: [6, 'accepts that the first guess does not fit and keeps working'], habit: [7, 'studies the repeating pattern closely'], interest: [8, 'the second clue narrowing the answer'], foodSpread: null },
  '8-10_mystery': { place: 3, trait: [7, 'separates reliable clues from misleading ones'], habit: [5, 'testing the first theory against one clue'], interest: [9, 'comparing the revised idea against all remaining evidence'], foodSpread: null },
  '8-10_system': { place: 3, trait: [7, 'looks earlier and upstream in the process'], habit: [5, 'testing the suspected cause safely'], interest: [9, 'predicting what should change once corrected'], foodSpread: null },
  '8-10_map': { place: 2, trait: [6, 'identifies the reliable landmarks'], habit: [7, 'reorients the map with the first landmark'], interest: [8, 'the second landmark removing the ambiguity'], foodSpread: null },
  '8-10_planning': { place: 2, trait: [5, 'checks whether simply reversing the order solves it'], habit: [6, 'spotting the key dependency'], interest: [7, 'comparing the two possible sequences'], foodSpread: null },
  '8-10_guide': { place: 2, trait: [6, 'looks for a different distinguishing clue'], habit: [4, 'comparing the remaining two side by side'], interest: [9, 'verifying the final match by safe observation'], foodSpread: null },
};

const TARGETS = { min_moments: 4, ideal_moments: 5, max_moments: 6, min_details: 2, max_details: 4 };

const sid = (spread, name) => `s${String(spread).padStart(2, '0')}_${name}`;
const NO_VISUAL = { mode: 'none' };
const OPTIONAL_VISUAL = { mode: 'optional' };
const vis = (spread, name) => ({ mode: 'required_if_used', visual_slot_id: `spread_${String(spread).padStart(2, '0')}_${name}` });

function buildSlots(book, theme, arch) {
  const spec = ARCH_SLOTS[arch];
  if (!spec) throw new Error(`no slot scaffold for archetype '${arch}' (book ${book.id})`);
  const world = theme.world_name;
  const slots = [];

  slots.push({
    slot_id: sid(1, 'object_intro'), spread: 1,
    allowed_moment_types: ['object_presence'], allowed_profile_fields: ['object'],
    priority: 'preferred', max_uses: 1,
    instruction: `A small supplied portable object may be carried, held, or tucked under the child's arm on arrival in ${world}. Decorative and comforting only — it never becomes a tool, a clue, or part of the fixed plot.`,
    visual_alignment: vis(1, 'object_near_child'),
  });
  slots.push({
    slot_id: sid(spec.place, 'place_compare'), spread: spec.place,
    allowed_moment_types: ['place_reference', 'interest_comparison'], allowed_profile_fields: ['place', 'interests'],
    priority: 'optional', max_uses: 1,
    instruction: `One light, age-appropriate comparison or memory may color the child's reaction to the scene here. The fixed setting of ${world} never changes and the comparison never adds a clue or answer.`,
    visual_alignment: NO_VISUAL,
  });
  slots.push({
    slot_id: sid(spec.trait[0], 'trait'), spread: spec.trait[0],
    allowed_moment_types: ['trait_behavior'], allowed_profile_fields: ['trait'],
    priority: 'preferred', max_uses: 1,
    instruction: `A supplied temperament may show through HOW the child ${spec.trait[1]} — never named as a label, never granting knowledge, and never changing the fixed solution.`,
    visual_alignment: NO_VISUAL,
  });
  slots.push({
    slot_id: sid(spec.habit[0], 'habit'), spread: spec.habit[0],
    allowed_moment_types: ['habit_behavior'], allowed_profile_fields: ['habit'],
    priority: 'preferred', max_uses: 1,
    instruction: `A supplied endearing habit may appear once, briefly and affectionately, while the child ${spec.habit[1]}. It stays small and never solves, delays, or disrupts the fixed plot.`,
    visual_alignment: OPTIONAL_VISUAL,
  });
  slots.push({
    slot_id: sid(spec.interest[0], 'interest'), spread: spec.interest[0],
    allowed_moment_types: ['interest_reaction', 'interest_comparison'], allowed_profile_fields: ['interests', 'activities'],
    priority: 'preferred', max_uses: 1,
    instruction: `The child may notice or react through a supplied interest or activity during ${spec.interest[1]} — attention and delight only, never expertise beyond age and never the answer.`,
    visual_alignment: NO_VISUAL,
  });
  if (spec.foodSpread && FOOD_OK_THEMES.has(themeIdOf(book))) {
    slots.push({
      slot_id: sid(spec.foodSpread, 'food'), spread: spec.foodSpread,
      allowed_moment_types: ['food_celebration'], allowed_profile_fields: ['food'],
      priority: 'optional', max_uses: 1,
      instruction: 'A supplied favorite food may appear as one small item in the celebration/rest moment here — food is already plausible in this beat. No allergy, diet, or health claims; mentioned once, never repeated.',
      visual_alignment: vis(spec.foodSpread, 'food'),
    });
  }
  slots.push({
    slot_id: sid(12, 'object_close'), spread: 12,
    allowed_moment_types: ['object_callback', 'closing_callback'], allowed_profile_fields: ['object'],
    priority: 'preferred', max_uses: 1, requires_prior_detail_use: true,
    instruction: `The object introduced on spread 1 may return softly in the goodbye image or sentence as the child leaves ${world}. The fixed ending never changes.`,
    visual_alignment: vis(12, 'object_near_child'),
  });
  return slots;
}

let _bookTheme = null;
function themeIdOf(book) {
  return _bookTheme.get(book.id);
}

function keywordTags(book) {
  // Whole-word/phrase match on normalized word boundaries — a plain substring
  // test invents tags ('star' from "starting", 'pie' from "copies", 'elf'
  // from "itself"), and exact interest tags are worth 5 selection points.
  const normalize = (s) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const text = normalize(`${book.premise} ${book.beats.map(b => b.beat).join(' ')}`);
  const found = [];
  for (const noun of KEYWORD_NOUNS) {
    if (found.length >= 4) break;
    if (text.includes(normalize(noun)) && !found.includes(noun)) found.push(noun);
  }
  return found;
}

function buildSelectionProfile(book, themeId, arch) {
  const theme = THEME_TAGS[themeId];
  const archT = ARCH_TAGS[arch];
  const dedupe = (arr) => [...new Set(arr)];
  return {
    primary_tags: dedupe([...archT.primary, ...theme.primary, ...keywordTags(book)]).slice(0, 10),
    activity_tags: dedupe([...archT.activities, ...theme.activities]).slice(0, 8),
    trait_affinities: dedupe(archT.traits).slice(0, 6),
    contraindications: [],
  };
}

function main() {
  const catalog = loadCatalog();
  _bookTheme = new Map();
  const all = [];
  for (const [themeId, theme] of Object.entries(catalog.themes)) {
    for (const books of Object.values(theme.age_bands)) {
      for (const book of books) {
        _bookTheme.set(book.id, themeId);
        all.push({ book, themeId, theme });
      }
    }
  }

  fs.mkdirSync(OUT, { recursive: true });
  let written = 0;
  let skipped = 0;
  for (const { book, themeId, theme } of all) {
    const outPath = path.join(OUT, `${book.id}.json`);
    if (fs.existsSync(outPath)) { skipped += 1; continue; } // hand-tuned reference files win
    const sidecar = {
      book_id: book.id,
      authored: `archetype-scaffold-${new Date().toISOString().slice(0, 10)}`,
      selection_profile: buildSelectionProfile(book, themeId, book.archetype),
      personalization_map: {
        schema_version: '1.3.0',
        map_version: '1.0.0',
        book_id: book.id,
        targets: TARGETS,
        detail_repeat_limit: 3,
        slots: buildSlots(book, theme, book.archetype),
      },
    };
    fs.writeFileSync(outPath, JSON.stringify(sidecar, null, 2) + '\n');
    written += 1;
  }
  console.log(`wrote ${written} sidecar(s), kept ${skipped} existing`);

  console.log('Validating the complete approved set...');
  const { _resetForTests, loadAugments, coverageReport } = require('../services/catalogEngine/augments');
  _resetForTests();
  loadAugments();
  const report = coverageReport();
  console.log(`coverage: ${report.booksWithMap}/${report.totalBooks} maps, ${report.booksWithSelectionProfile}/${report.totalBooks} selection profiles`);
  if (report.booksWithMap !== report.totalBooks) {
    throw new Error('coverage incomplete — some books have no approved map');
  }
}

main();
