/**
 * Sidecar augments — per-book `selection_profile` + `personalization_map`.
 *
 * The 228 plots are frozen; personalization data lives BESIDE them as
 * versioned sidecar files joined by exact `book_id` at load time
 * (the handoff's augmentation-table pattern):
 *
 *   data/augments/approved/{book_id}.json   — editorially approved, loaded
 *   data/augments/drafts/{book_id}.json     — machine drafts, NEVER loaded
 *
 * A book without an approved map generates name-only. Maps are never
 * fabricated at runtime. Every approved file is schema-validated and
 * cross-checked against its book definition at load; a broken approved
 * sidecar fails the boot loudly.
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv/dist/2020');
const { getBook } = require('./catalog');

const APPROVED_DIR = path.join(__dirname, 'data', 'augments', 'approved');
const MAP_SCHEMA_PATH = path.join(__dirname, 'data', 'schemas', 'personalization-map.schema.json');

/** Moment types that can introduce a detail (callbacks require one earlier). */
const INTRO_CAPABLE_TYPES = new Set([
  'object_presence', 'habit_behavior', 'trait_behavior', 'interest_reaction',
  'interest_comparison', 'place_reference', 'food_celebration', 'visual_prop',
]);

let _augments = null; // bookId -> {selectionProfile, personalizationMap}
let _validateMap = null;

function mapValidator() {
  if (_validateMap) return _validateMap;
  const ajv = new Ajv({ allErrors: true, strict: false });
  const schema = JSON.parse(fs.readFileSync(MAP_SCHEMA_PATH, 'utf8'));
  _validateMap = ajv.compile(schema);
  return _validateMap;
}

/**
 * Structural cross-checks a schema-valid map still needs against its book.
 * @param {object} map
 * @param {object} book catalog book definition
 * @returns {string[]} errors
 */
function crossCheckMap(map, book) {
  const errors = [];
  if (map.book_id !== book.id) errors.push(`map book_id '${map.book_id}' != '${book.id}'`);
  const t = map.targets;
  if (t.max_moments < t.min_moments) errors.push('targets: max_moments < min_moments');
  if (t.max_details < t.min_details) errors.push('targets: max_details < min_details');
  if (t.ideal_moments < t.min_moments || t.ideal_moments > t.max_moments) {
    errors.push('targets: ideal_moments outside [min,max]');
  }
  const slotIds = new Set();
  for (const slot of map.slots) {
    if (slotIds.has(slot.slot_id)) errors.push(`duplicate slot_id ${slot.slot_id}`);
    slotIds.add(slot.slot_id);
    const declaredSpread = Number(slot.slot_id.slice(1, 3));
    if (declaredSpread !== slot.spread) {
      errors.push(`slot ${slot.slot_id}: id prefix says spread ${declaredSpread} but spread=${slot.spread}`);
    }
    if (slot.requires_prior_detail_use) {
      const hasIntro = map.slots.some(other =>
        other.spread < slot.spread
        && other.allowed_moment_types.some(m => INTRO_CAPABLE_TYPES.has(m))
        && other.allowed_profile_fields.some(f => slot.allowed_profile_fields.includes(f)));
      if (!hasIntro) errors.push(`slot ${slot.slot_id}: requires_prior_detail_use but no earlier intro-capable slot shares a profile field`);
    }
    const va = slot.visual_alignment;
    if (va.mode === 'required_if_used' && !va.visual_slot_id) {
      errors.push(`slot ${slot.slot_id}: required_if_used without visual_slot_id`);
    }
  }
  return errors;
}

/**
 * Validate one selection profile object (no JSON schema in the handoff —
 * shape follows the augmentation guide).
 * @param {object} sp
 * @returns {string[]} errors
 */
function checkSelectionProfile(sp) {
  const errors = [];
  const listKeys = ['primary_tags', 'activity_tags', 'trait_affinities', 'contraindications'];
  for (const k of listKeys) {
    if (!Array.isArray(sp[k])) { errors.push(`selection_profile.${k} must be an array`); continue; }
    for (const v of sp[k]) {
      if (typeof v !== 'string' || !v.trim()) errors.push(`selection_profile.${k} entries must be non-empty strings`);
    }
  }
  const unknown = Object.keys(sp).filter(k => !listKeys.includes(k));
  if (unknown.length) errors.push(`selection_profile unknown keys: ${unknown.join(',')}`);
  return errors;
}

/**
 * Load (and cache) all approved sidecars. Throws when any approved file is
 * invalid — a bad approved map must never silently degrade to name-only.
 * @returns {Map<string, {selectionProfile: object|null, personalizationMap: object|null}>}
 */
function loadAugments() {
  if (_augments) return _augments;
  const augments = new Map();
  const errors = [];
  const files = fs.existsSync(APPROVED_DIR)
    ? fs.readdirSync(APPROVED_DIR).filter(f => f.endsWith('.json'))
    : [];
  const validate = mapValidator();
  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(APPROVED_DIR, file), 'utf8'));
    const bookId = raw.book_id;
    const hit = bookId ? getBook(bookId) : null;
    if (!hit) { errors.push(`${file}: unknown book_id '${bookId}'`); continue; }
    if (path.basename(file, '.json') !== bookId) {
      errors.push(`${file}: filename must equal book_id '${bookId}'`);
    }
    if (augments.has(bookId)) { errors.push(`${file}: duplicate sidecar for '${bookId}'`); continue; }
    const entry = { selectionProfile: null, personalizationMap: null };
    if (raw.selection_profile) {
      const spErrors = checkSelectionProfile(raw.selection_profile);
      if (spErrors.length) errors.push(`${file}: ${spErrors.join('; ')}`);
      else entry.selectionProfile = raw.selection_profile;
    }
    if (raw.personalization_map) {
      if (!validate(raw.personalization_map)) {
        errors.push(`${file}: map schema errors: ${JSON.stringify(validate.errors?.slice(0, 5))}`);
      } else {
        const xErrors = crossCheckMap(raw.personalization_map, hit.book);
        if (xErrors.length) errors.push(`${file}: ${xErrors.join('; ')}`);
        else entry.personalizationMap = raw.personalization_map;
      }
    }
    augments.set(bookId, entry);
  }
  if (errors.length > 0) {
    throw new Error(`[catalogEngine] APPROVED SIDECARS INVALID:\n- ${errors.join('\n- ')}`);
  }
  _augments = augments;
  console.log(`[catalogEngine] augments loaded: ${augments.size} approved sidecar(s)`);
  return _augments;
}

/**
 * @param {string} bookId
 * @returns {{selectionProfile: object|null, personalizationMap: object|null}}
 */
function augmentsFor(bookId) {
  const hit = loadAugments().get(bookId);
  return hit || { selectionProfile: null, personalizationMap: null };
}

/**
 * Coverage report by theme/band for the release gate and the admin screen.
 * @returns {object}
 */
function coverageReport() {
  const { loadCatalog } = require('./catalog');
  const catalog = loadCatalog();
  const augments = loadAugments();
  const byTheme = {};
  let withMap = 0;
  let withProfile = 0;
  let total = 0;
  for (const [themeId, theme] of Object.entries(catalog.themes)) {
    const row = { books: 0, maps: 0, selectionProfiles: 0 };
    for (const books of Object.values(theme.age_bands)) {
      for (const book of books) {
        total += 1;
        row.books += 1;
        const a = augments.get(book.id);
        if (a?.personalizationMap) { row.maps += 1; withMap += 1; }
        if (a?.selectionProfile) { row.selectionProfiles += 1; withProfile += 1; }
      }
    }
    byTheme[themeId] = row;
  }
  return { totalBooks: total, booksWithMap: withMap, booksWithSelectionProfile: withProfile, byTheme };
}

/** Test hook — clears caches so fixtures can swap the approved dir. */
function _resetForTests() {
  _augments = null;
}

module.exports = {
  loadAugments,
  augmentsFor,
  coverageReport,
  crossCheckMap,
  checkSelectionProfile,
  INTRO_CAPABLE_TYPES,
  _resetForTests,
};
