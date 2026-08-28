/**
 * Catalog loader — the fixed 12-theme / 228-book / 12-beat V1.3 catalog.
 *
 * The catalog is the single source of truth for what stories exist. The
 * writer never invents or selects a plot; application code routes on the
 * catalog's age-band KEYS (never by parsing book ids — legacy ids keep
 * `2_3` even though the youngest band is now 1–3).
 *
 * Loaded once at require time and validated; an invalid catalog throws at
 * boot (failing loudly beats serving 202s that can never complete).
 */

const fs = require('fs');
const path = require('path');

const CATALOG_PATH = path.join(__dirname, 'data', 'catalog.json');
const AGE_ENGINES_PATH = path.join(__dirname, 'data', 'ageEngines.json');

const EXPECTED_BANDS = ['1-3', '4-5', '6-7', '8-10'];
const EXPECTED_THEMES = 12;
const EXPECTED_BOOKS = 228;

/** Internal caches (populated on first load). */
let _catalog = null;
let _ageEngines = null;
let _bookIndex = null; // bookId -> { book, themeId, ageBand }

/**
 * Validate catalog invariants (ported from the handoff's validate_release.py).
 * @param {object} catalog
 * @returns {string[]} errors (empty = valid)
 */
function validateCatalog(catalog) {
  const errors = [];
  const themes = catalog.themes || {};
  if (Object.keys(themes).length !== EXPECTED_THEMES) {
    errors.push(`catalog must contain exactly ${EXPECTED_THEMES} themes (found ${Object.keys(themes).length})`);
  }
  const seen = new Set();
  let count = 0;
  for (const [themeId, theme] of Object.entries(themes)) {
    const bands = theme.age_bands || {};
    const bandKeys = Object.keys(bands).sort();
    if (JSON.stringify(bandKeys) !== JSON.stringify([...EXPECTED_BANDS].sort())) {
      errors.push(`${themeId}: wrong age bands [${bandKeys.join(',')}]`);
    }
    for (const books of Object.values(bands)) {
      for (const book of books) {
        count += 1;
        if (!book.id || seen.has(book.id)) errors.push(`duplicate or missing book id: ${book.id}`);
        seen.add(book.id);
        const beats = book.beats;
        if (!Array.isArray(beats) || beats.length !== 12) {
          errors.push(`${book.id}: expected exactly 12 beats`);
          continue;
        }
        const spreads = beats.map(b => b.spread);
        if (JSON.stringify(spreads) !== JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])) {
          errors.push(`${book.id}: beats must be ordered 1-12`);
        }
        if (!book.title_template || !book.title_template.includes('{name}')) {
          errors.push(`${book.id}: title_template must contain {name}`);
        }
        if (book.refrain) {
          if (!book.refrain.text || !Array.isArray(book.refrain.spreads) || book.refrain.spreads.length === 0) {
            errors.push(`${book.id}: refrain must have text and spreads`);
          }
        }
      }
    }
  }
  if (count !== EXPECTED_BOOKS) errors.push(`counted ${count} books instead of ${EXPECTED_BOOKS}`);
  return errors;
}

/**
 * Load (and cache) the catalog; throws on invariant violations.
 * @returns {object} the raw catalog object
 */
function loadCatalog() {
  if (_catalog) return _catalog;
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const errors = validateCatalog(catalog);
  if (errors.length > 0) {
    throw new Error(`[catalogEngine] CATALOG INVALID:\n- ${errors.join('\n- ')}`);
  }
  _catalog = catalog;
  _bookIndex = new Map();
  for (const [themeId, theme] of Object.entries(catalog.themes)) {
    for (const [ageBand, books] of Object.entries(theme.age_bands)) {
      for (const book of books) {
        _bookIndex.set(book.id, { book, themeId, ageBand });
      }
    }
  }
  console.log(`[catalogEngine] catalog v${catalog.version} loaded: ${Object.keys(catalog.themes).length} themes, ${_bookIndex.size} books`);
  return _catalog;
}

/** @returns {object} age engines keyed by band ('1-3', '4-5', '6-7', '8-10') */
function loadAgeEngines() {
  if (_ageEngines) return _ageEngines;
  _ageEngines = JSON.parse(fs.readFileSync(AGE_ENGINES_PATH, 'utf8'));
  const bands = Object.keys(_ageEngines).sort();
  if (JSON.stringify(bands) !== JSON.stringify([...EXPECTED_BANDS].sort())) {
    throw new Error(`[catalogEngine] age engines must cover ${EXPECTED_BANDS.join('/')}, found ${bands.join('/')}`);
  }
  return _ageEngines;
}

/** @returns {string} the catalog version string (e.g. '1.3') */
function catalogVersion() {
  return String(loadCatalog().version);
}

/**
 * Map an exact age (1–10) to a catalog age-band key.
 * @param {number} age
 * @returns {string} one of '1-3' | '4-5' | '6-7' | '8-10'
 */
function ageBandForAge(age) {
  const a = Number(age);
  if (!Number.isInteger(a) || a < 1 || a > 10) {
    throw new Error(`ageBandForAge: age must be an integer 1-10, got ${age}`);
  }
  if (a <= 3) return '1-3';
  if (a <= 5) return '4-5';
  if (a <= 7) return '6-7';
  return '8-10';
}

/** Convert a catalog band key ('1-3') to the wire enum ('1_3') and back. */
function toWireBand(band) {
  return String(band).replace(/-/g, '_');
}
function fromWireBand(band) {
  return String(band).replace(/_/g, '-');
}

/**
 * Look up one book by id.
 * @param {string} bookId
 * @returns {{book: object, themeId: string, ageBand: string, theme: object}|null}
 */
function getBook(bookId) {
  loadCatalog();
  const hit = _bookIndex.get(bookId);
  if (!hit) return null;
  return { ...hit, theme: _catalog.themes[hit.themeId] };
}

/**
 * All eligible books for a theme + age band (routing by catalog keys only).
 * @param {string} themeId
 * @param {string} ageBand catalog key ('1-3' etc.; wire '1_3' accepted)
 * @returns {object[]} book definitions
 */
function eligibleBooks(themeId, ageBand) {
  const catalog = loadCatalog();
  const theme = catalog.themes[themeId];
  if (!theme) throw new Error(`eligibleBooks: unknown theme '${themeId}'`);
  const band = fromWireBand(ageBand);
  const books = theme.age_bands[band];
  if (!books) throw new Error(`eligibleBooks: unknown age band '${ageBand}' for theme '${themeId}'`);
  return books;
}

/**
 * Render a book's title template for a child. The writer must echo this
 * exactly; only approved placeholders are replaced.
 * @param {object} book
 * @param {string} childName
 * @returns {string}
 */
function renderTitle(book, childName) {
  return String(book.title_template).replace(/\{name\}/g, childName);
}

/**
 * Theme metadata for pickers/prompts.
 * @returns {Array<{themeId: string, displayName: string, worldName: string, companion: object, bandCounts: object}>}
 */
function listThemes() {
  const catalog = loadCatalog();
  return Object.entries(catalog.themes).map(([themeId, t]) => ({
    themeId,
    displayName: t.display_name,
    worldName: t.world_name,
    companion: t.companion,
    bandCounts: Object.fromEntries(Object.entries(t.age_bands).map(([b, books]) => [b, books.length])),
  }));
}

module.exports = {
  loadCatalog,
  loadAgeEngines,
  validateCatalog,
  catalogVersion,
  ageBandForAge,
  toWireBand,
  fromWireBand,
  getBook,
  eligibleBooks,
  renderTitle,
  listThemes,
  EXPECTED_BANDS,
};
