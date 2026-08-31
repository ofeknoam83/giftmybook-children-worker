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

/** Catalog Overlay state (see catalogOverlay.js): the frozen base plus an
 * optional admin-activated prose overlay. `_catalog`/`_bookIndex` always
 * hold the MERGED view; the base stays available for diffing and reset. */
let _baseCatalog = null;
let _baseBookIndex = null;
let _overlayHash8 = null;
// Small LRU of merged catalogs for PINNED tags (stored-story resolution).
const _pinnedCache = new Map(); // hash8 -> {catalog, bookIndex}
const PINNED_CACHE_MAX = 4;

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
/** Build a bookId index for any catalog object. */
function buildIndex(catalog) {
  const index = new Map();
  for (const [themeId, theme] of Object.entries(catalog.themes)) {
    for (const [ageBand, books] of Object.entries(theme.age_bands)) {
      for (const book of books) {
        index.set(book.id, { book, themeId, ageBand });
      }
    }
  }
  return index;
}

function loadCatalog() {
  if (_catalog) return _catalog;
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const errors = validateCatalog(catalog);
  if (errors.length > 0) {
    throw new Error(`[catalogEngine] CATALOG INVALID:\n- ${errors.join('\n- ')}`);
  }
  _baseCatalog = catalog;
  _baseBookIndex = buildIndex(catalog);
  _catalog = catalog;
  _bookIndex = _baseBookIndex;
  console.log(`[catalogEngine] catalog v${catalog.version} loaded: ${Object.keys(catalog.themes).length} themes, ${_bookIndex.size} books`);
  return _catalog;
}

/** @returns {object} the frozen base catalog (never overlay-patched). */
function baseCatalog() {
  loadCatalog();
  return _baseCatalog;
}

/**
 * Swap the live catalog to base + overlay. The caller (server activation or
 * boot init) has already shape-validated the overlay; the merged invariants
 * are re-checked HERE as the last gate before anything serves from it.
 * @param {object} overlay a shape-valid overlay document
 * @param {string} hash8 the overlay's content hash prefix
 * @returns {string} the new catalog tag
 */
function applyCatalogOverlay(overlay, hash8) {
  loadCatalog();
  const { applyOverlay, overlayTag } = require('./catalogOverlay');
  const merged = applyOverlay(_baseCatalog, overlay);
  const errors = validateCatalog(merged);
  if (errors.length > 0) {
    throw new Error(`merged catalog fails boot invariants:\n- ${errors.join('\n- ')}`);
  }
  _catalog = merged;
  _bookIndex = buildIndex(merged);
  _overlayHash8 = hash8;
  _pinnedCache.set(hash8, { catalog: merged, bookIndex: _bookIndex });
  trimPinnedCache();
  console.log(`[catalogEngine] catalog overlay ${hash8} ACTIVE (tag ${overlayTag(_baseCatalog.version, hash8)})`);
  return overlayTag(_baseCatalog.version, hash8);
}

/** Drop any active overlay — the live catalog is the frozen base again. */
function resetCatalogOverlay() {
  loadCatalog();
  _catalog = _baseCatalog;
  _bookIndex = _baseBookIndex;
  _overlayHash8 = null;
  console.log('[catalogEngine] catalog overlay deactivated — serving the base catalog');
  return String(_baseCatalog.version);
}

/** @returns {string|null} the active overlay hash8 (null = base). */
function activeOverlayHash() {
  return _overlayHash8;
}

function trimPinnedCache() {
  while (_pinnedCache.size > PINNED_CACHE_MAX) {
    _pinnedCache.delete(_pinnedCache.keys().next().value);
  }
}

/**
 * Resolve a book definition AS PINNED by a stored story's catalog tag —
 * `<base>` (the frozen file) or `<base>+<hash8>` (base + that overlay,
 * fetched from GCS when it is not the active one). Returns null when the
 * tag names an overlay that no longer exists anywhere; the caller decides
 * how loudly to fall back to the current catalog.
 * @param {string} bookId
 * @param {string} catalogTag the story's pinned versions.catalog
 * @returns {Promise<{book, themeId, ageBand, theme}|null>}
 */
async function getBookForTag(bookId, catalogTag) {
  loadCatalog();
  const tag = String(catalogTag || '');
  const current = catalogVersion();
  if (!tag || tag === current) return getBook(bookId);
  const [base, hash8] = tag.split('+');
  if (String(base) !== String(_baseCatalog.version)) return null; // different base deploy
  if (!hash8) {
    const hit = _baseBookIndex.get(bookId);
    return hit ? { ...hit, theme: _baseCatalog.themes[hit.themeId] } : null;
  }
  if (!_pinnedCache.has(hash8)) {
    const { loadOverlayByHash, applyOverlay } = require('./catalogOverlay');
    const overlay = await loadOverlayByHash(hash8);
    if (!overlay) return null;
    const merged = applyOverlay(_baseCatalog, overlay);
    _pinnedCache.set(hash8, { catalog: merged, bookIndex: buildIndex(merged) });
    trimPinnedCache();
  }
  const { catalog, bookIndex } = _pinnedCache.get(hash8);
  const hit = bookIndex.get(bookId);
  return hit ? { ...hit, theme: catalog.themes[hit.themeId] } : null;
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

/** @returns {string} the catalog tag: '1.3' bare, '1.3+<hash8>' with an
 * active overlay — pinned on every story request for permanent provenance. */
function catalogVersion() {
  loadCatalog();
  return _overlayHash8 ? `${_baseCatalog.version}+${_overlayHash8}` : String(_baseCatalog.version);
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
  getBookForTag,
  eligibleBooks,
  renderTitle,
  listThemes,
  baseCatalog,
  applyCatalogOverlay,
  resetCatalogOverlay,
  activeOverlayHash,
  EXPECTED_BANDS,
};
