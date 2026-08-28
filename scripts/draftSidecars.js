/**
 * Sidecar drafting tool — machine-drafts `selection_profile` +
 * `personalization_map` sidecars for catalog books that don't have an
 * approved one yet.
 *
 * Drafts land in services/catalogEngine/data/augments/drafts/ and are NEVER
 * loaded at runtime. Promotion is a human act: review a draft, move it to
 * augments/approved/, commit. loadAugments() re-validates on boot either way.
 *
 * Usage:
 *   node scripts/draftSidecars.js                 # draft every book without an approved sidecar
 *   node scripts/draftSidecars.js farm            # one theme
 *   node scripts/draftSidecars.js farm_2_3_hello_farm   # one book
 *   DRAFT_LIMIT=20 node scripts/draftSidecars.js  # cap a batch
 *
 * Every draft is schema-validated and cross-checked against its book before
 * being written; invalid model output is retried once with the errors.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv/dist/2020');
const { loadCatalog, getBook } = require('../services/catalogEngine/catalog');
const { loadAugments, crossCheckMap, checkSelectionProfile } = require('../services/catalogEngine/augments');
const { callText } = require('../services/shared/llm/openaiClient');

const DRAFTS_DIR = path.join(__dirname, '..', 'services', 'catalogEngine', 'data', 'augments', 'drafts');
const APPROVED_DIR = path.join(__dirname, '..', 'services', 'catalogEngine', 'data', 'augments', 'approved');
const MAP_SCHEMA = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'services', 'catalogEngine', 'data', 'schemas', 'personalization-map.schema.json'), 'utf8'));

const MODEL = process.env.CATALOG_WRITER_MODEL || 'gpt-5.4';

const SYSTEM = `You author personalization sidecars for a FIXED catalog of children's picture books.
Each book has 12 immutable beats. You produce two JSON sidecar objects:

1. "selection_profile": tags describing the APPROVED PLOT EXPERIENCE (what the
   story is actually about and the temperament it rewards) — never keywords
   copied from the title. Shape:
   {"primary_tags": [...], "activity_tags": [...], "trait_affinities": [...], "contraindications": []}
   Tags are lowercase noun/gerund phrases a parent might type (interests →
   primary_tags, activities → activity_tags, temperament words → trait_affinities).

2. "personalization_map": 5-8 slots marking WHERE a child's supplied details
   may safely appear WITHOUT touching causality. Rules:
   - slot_id pattern s<2-digit spread>_<snake_name>, spread must match the prefix;
   - allowed_moment_types from: object_presence, object_callback, habit_behavior,
     trait_behavior, interest_reaction, interest_comparison, place_reference,
     food_celebration, closing_callback, visual_prop;
   - allowed_profile_fields from: object, interests, activities, food, place, habit, trait;
   - priority "preferred" or "optional"; max_uses always 1;
   - include one EARLY object introduction (spread 1-2, object_presence, visual
     required_if_used with visual_slot_id like spread_01_object_near_child) and one
     LATE callback slot (spread 11-12, object_callback/closing_callback,
     requires_prior_detail_use: true, visual required_if_used);
   - a food_celebration slot ONLY where food is already plausible in that exact
     beat (never underwater, never sleep/search/danger beats, never where food
     for ANIMALS is the plot's clue system — a personal snack would blur it);
   - every instruction states what MAY change and what MUST stay fixed (20-500 chars);
   - trait slots sit where the existing action already supports the behavior;
   - nothing may reveal an answer, replace a clue/tool, change the setting, or
     alter the fixed ending;
   - targets: {"min_moments": 4, "ideal_moments": 5, "max_moments": 6, "min_details": 2, "max_details": 4},
     detail_repeat_limit: 3, schema_version "1.3.0", map_version "1.0.0".

Return ONE JSON object: {"selection_profile": {...}, "personalization_map": {...}}.`;

function exampleBlock() {
  const ref = JSON.parse(fs.readFileSync(path.join(APPROVED_DIR, 'enchanted_4_5_signpost_mixup.json'), 'utf8'));
  return `## APPROVED REFERENCE EXAMPLE (book enchanted_4_5_signpost_mixup)\n\`\`\`json\n${JSON.stringify({ selection_profile: ref.selection_profile, personalization_map: ref.personalization_map }, null, 1)}\n\`\`\``;
}

async function draftOne(bookId, exampleJson, validateMap) {
  const { book, themeId, ageBand, theme } = getBook(bookId);
  let errors = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const userPrompt = [
      exampleJson,
      `## BOOK TO AUGMENT (theme ${themeId} — world "${theme.world_name}", companion ${theme.companion.name}; age band ${ageBand})`,
      '```json\n' + JSON.stringify(book, null, 1) + '\n```',
      `The map's book_id must be exactly "${bookId}".`,
      errors ? `## PREVIOUS ATTEMPT FAILED VALIDATION — fix all of:\n- ${errors.join('\n- ')}` : '',
    ].filter(Boolean).join('\n\n');
    const result = await callText({
      model: MODEL,
      systemPrompt: SYSTEM,
      userPrompt,
      jsonMode: true,
      temperature: attempt === 1 ? 0.6 : 0.3,
      maxTokens: 4000,
      allowGeminiFallback: false,
      label: `draftSidecar:${bookId}`,
    });
    const draft = result.json;
    errors = [];
    if (!draft?.selection_profile || !draft?.personalization_map) {
      errors.push('response must contain selection_profile and personalization_map');
    } else {
      errors.push(...checkSelectionProfile(draft.selection_profile));
      if (!validateMap(draft.personalization_map)) {
        errors.push(...(validateMap.errors || []).slice(0, 8).map(e => `map schema: ${e.instancePath} ${e.message}`));
      } else {
        errors.push(...crossCheckMap(draft.personalization_map, book));
      }
    }
    if (errors.length === 0) return draft;
    console.warn(`  [${bookId}] attempt ${attempt} invalid: ${errors.slice(0, 3).join('; ')}`);
  }
  throw new Error(`draft for ${bookId} failed validation twice: ${errors.join('; ')}`);
}

async function main() {
  const filter = process.argv[2] || null;
  const limit = Number(process.env.DRAFT_LIMIT || Infinity);
  const catalog = loadCatalog();
  const approved = loadAugments();
  fs.mkdirSync(DRAFTS_DIR, { recursive: true });

  const targets = [];
  for (const [themeId, theme] of Object.entries(catalog.themes)) {
    for (const books of Object.values(theme.age_bands)) {
      for (const book of books) {
        if (approved.has(book.id)) continue;
        if (filter && filter !== themeId && filter !== book.id) continue;
        if (fs.existsSync(path.join(DRAFTS_DIR, `${book.id}.json`))) continue;
        targets.push(book.id);
      }
    }
  }
  console.log(`${targets.length} book(s) to draft${Number.isFinite(limit) ? ` (capped at ${limit})` : ''}`);

  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateMap = ajv.compile(MAP_SCHEMA);
  const exampleJson = exampleBlock();

  let done = 0;
  let failed = 0;
  for (const bookId of targets.slice(0, limit)) {
    try {
      const draft = await draftOne(bookId, exampleJson, validateMap);
      const sidecar = {
        book_id: bookId,
        authored: `draft-${new Date().toISOString().slice(0, 10)}`,
        status: 'DRAFT_NEEDS_EDITORIAL_REVIEW',
        ...draft,
      };
      fs.writeFileSync(path.join(DRAFTS_DIR, `${bookId}.json`), JSON.stringify(sidecar, null, 2) + '\n');
      done += 1;
      console.log(`✓ drafted ${bookId} (${done}/${Math.min(targets.length, limit)})`);
    } catch (err) {
      failed += 1;
      console.error(`✗ ${bookId}: ${err.message}`);
    }
  }
  console.log(`\ndone: ${done} drafted, ${failed} failed. Review drafts in data/augments/drafts/, then move approved files to data/augments/approved/ and commit.`);
}

main().catch(err => { console.error(err); process.exit(1); });
