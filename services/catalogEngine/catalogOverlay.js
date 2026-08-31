/**
 * Catalog Overlay — admin-authored PROSE patches over the frozen catalog.
 *
 * The base catalog.json stays frozen in git ("never edit plots" still holds
 * for the file). An overlay is a versioned, validated patch document that
 * may touch ONLY the allowlisted prose fields below — theme naming, book
 * premise/title/refrain wording, and beat text. Structure is untouchable:
 * theme/book ids, age bands, archetypes, the 12/228/12 counts, slot
 * references. The MERGED catalog must still pass every boot invariant
 * before an overlay can activate, and activation is an explicit admin
 * action from the main app — never a runtime/LLM side effect.
 *
 * Persistence: GCS blobs keyed by content hash plus an active pointer, so
 * an activated overlay survives restarts and rollback is one pointer write.
 * Every generated story pins `versions.catalog = <base>+<hash8>`, and
 * stored stories re-validate/illustrate against their PINNED definitions
 * (loadOverlayByHash) — reshaping a theme never breaks earlier stories.
 */

const crypto = require('crypto');
const { saveJson, loadJson } = require('../gcsStorage');
const { countWords, BAND_BOUNDS, EXACT_AGE_BOUNDS } = require('./ageBounds');

// Overlay documents arrive as parsed JSON from an authenticated admin call,
// but keys like '__proto__' or 'constructor' would resolve through the
// prototype chain in plain `obj[key]` / `key in obj` checks — letting a
// crafted patch pass "existing theme" validation and then write onto
// Object.prototype in the merge. Every key membership test here MUST be an
// own-property check.
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

const OVERLAY_PREFIX = 'catalog-overlays';
const ACTIVE_POINTER = `${OVERLAY_PREFIX}/active.json`;

// Reject control characters anywhere in patched text — patches are data,
// never instructions, and never terminal noise.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Allowlisted fields and their length caps. Anything else is rejected. */
const THEME_FIELDS = { display_name: 200, world_name: 120 };
const COMPANION_FIELDS = { name: 80, type: 200 };
const BOOK_FIELDS = { title_template: 120, premise: 500 };
const BEAT_TEXT_CAP = 500;
const REFRAIN_TEXT_CAP = 160;
const MAX_REFRAIN_SPREADS = 6;

/**
 * @param {*} v
 * @param {number} cap
 * @param {string} label
 * @param {string[]} errors
 * @returns {string|null} the trimmed string, or null when invalid
 */
function checkString(v, cap, label, errors) {
  if (typeof v !== 'string' || !v.trim()) {
    errors.push(`${label} must be a non-empty string`);
    return null;
  }
  if (CONTROL_CHARS_RE.test(v)) {
    errors.push(`${label} contains control characters`);
    return null;
  }
  if (v.trim().length > cap) {
    errors.push(`${label} exceeds ${cap} characters`);
    return null;
  }
  return v.trim();
}

/**
 * Validate an overlay document against the allowlist and the base catalog.
 * @param {object} overlay {base_version, patches: {themes?, books?}}
 * @param {object} baseCatalog the frozen catalog.json object
 * @returns {string[]} errors (empty = shape-valid; merged invariants are a
 *   separate, additional gate)
 */
function validateOverlayShape(overlay, baseCatalog) {
  const errors = [];
  if (!overlay || typeof overlay !== 'object') return ['overlay must be an object'];
  const knownTop = new Set(['base_version', 'patches']);
  for (const k of Object.keys(overlay)) {
    if (!knownTop.has(k)) errors.push(`unknown overlay key '${k}'`);
  }
  if (String(overlay.base_version) !== String(baseCatalog.version)) {
    errors.push(`base_version '${overlay.base_version}' does not match the deployed catalog '${baseCatalog.version}'`);
  }
  const patches = overlay.patches;
  if (!patches || typeof patches !== 'object') return [...errors, 'patches must be an object'];
  const knownPatch = new Set(['themes', 'books']);
  for (const k of Object.keys(patches)) {
    if (!knownPatch.has(k)) errors.push(`unknown patches key '${k}'`);
  }

  const bookIndex = new Map();
  for (const [themeId, theme] of Object.entries(baseCatalog.themes || {})) {
    for (const [band, books] of Object.entries(theme.age_bands || {})) {
      for (const b of books) bookIndex.set(b.id, { themeId, band, book: b });
    }
  }

  for (const [themeId, patch] of Object.entries(patches.themes || {})) {
    if (!hasOwn(baseCatalog.themes, themeId)) {
      errors.push(`unknown theme '${themeId}'`);
      continue;
    }
    for (const [field, value] of Object.entries(patch || {})) {
      if (field === 'companion') {
        for (const [cf, cv] of Object.entries(value || {})) {
          if (!hasOwn(COMPANION_FIELDS, cf)) errors.push(`${themeId}.companion.${cf} is not an editable field`);
          else checkString(cv, COMPANION_FIELDS[cf], `${themeId}.companion.${cf}`, errors);
        }
      } else if (hasOwn(THEME_FIELDS, field)) {
        checkString(value, THEME_FIELDS[field], `${themeId}.${field}`, errors);
      } else {
        errors.push(`${themeId}.${field} is not an editable theme field (structure is frozen)`);
      }
    }
  }

  for (const [bookId, patch] of Object.entries(patches.books || {})) {
    if (!bookIndex.has(bookId)) {
      errors.push(`unknown book '${bookId}'`);
      continue;
    }
    for (const [field, value] of Object.entries(patch || {})) {
      if (hasOwn(BOOK_FIELDS, field)) {
        const s = checkString(value, BOOK_FIELDS[field], `${bookId}.${field}`, errors);
        if (field === 'title_template' && s) {
          // Exactly one {name}, no other placeholders: repeated tokens can
          // render past the runtime schema's title length with a long child
          // name, and unknown tokens would survive renderTitle as literals.
          const placeholders = s.match(/\{[^{}]*\}/g) || [];
          if (placeholders.length !== 1 || placeholders[0] !== '{name}') {
            errors.push(`${bookId}.title_template must contain exactly one {name} and no other placeholders`);
          }
        }
      } else if (field === 'retired') {
        // Retirement = removed from SELECTION forever, definition kept so
        // already-sold stories still validate and print. The merged-catalog
        // gate additionally enforces that every theme/band keeps a full
        // slate of active books.
        if (typeof value !== 'boolean') errors.push(`${bookId}.retired must be true or false`);
      } else if (field === 'refrain') {
        const base = bookIndex.get(bookId).book;
        if (!base.refrain && value != null) {
          // Adding a refrain to a refrain-less book changes validation
          // structure for it — allowed, but must be complete.
          if (!value.text || !Array.isArray(value.spreads)) {
            errors.push(`${bookId}.refrain: a new refrain needs both text and spreads`);
            continue;
          }
        }
        for (const [rf, rv] of Object.entries(value || {})) {
          if (rf === 'text') {
            const s = checkString(rv, REFRAIN_TEXT_CAP, `${bookId}.refrain.text`, errors);
            if (s) {
              // The refrain must fit inside a single spread for EVERY exact
              // age the book's band serves — a 26-word refrain on a 1-3 book
              // can never pass an age-1 spread's 25-word max, so every
              // generation for that profile would fail. Gate it here.
              const band = bookIndex.get(bookId).band;
              const spreadMax = band === '1-3'
                ? Math.min(...Object.values(EXACT_AGE_BOUNDS).map(b => b.perSpread[1]))
                : BAND_BOUNDS[band].perSpread[1];
              const words = countWords(s);
              if (words > spreadMax) {
                errors.push(`${bookId}.refrain.text is ${words} words but a band ${band} spread holds at most ${spreadMax} — it could never validate`);
              }
            }
          } else if (rf === 'spreads') {
            const ok = Array.isArray(rv) && rv.length >= 1 && rv.length <= MAX_REFRAIN_SPREADS
              && rv.every(n => Number.isInteger(n) && n >= 1 && n <= 12)
              && new Set(rv).size === rv.length;
            if (!ok) errors.push(`${bookId}.refrain.spreads must be 1-${MAX_REFRAIN_SPREADS} unique spread numbers (1-12)`);
          } else errors.push(`${bookId}.refrain.${rf} is not an editable field`);
        }
      } else if (field === 'beats') {
        for (const [spreadKey, text] of Object.entries(value || {})) {
          const n = Number(spreadKey);
          if (!Number.isInteger(n) || n < 1 || n > 12) {
            errors.push(`${bookId}.beats key '${spreadKey}' must be a spread number 1-12`);
            continue;
          }
          checkString(text, BEAT_TEXT_CAP, `${bookId}.beats.${spreadKey}`, errors);
        }
      } else {
        errors.push(`${bookId}.${field} is not an editable book field (structure is frozen)`);
      }
    }
  }
  return errors;
}

/**
 * Apply a shape-valid overlay to a deep clone of the base catalog.
 * @param {object} baseCatalog
 * @param {object} overlay
 * @returns {object} the merged catalog (base is never mutated)
 */
function applyOverlay(baseCatalog, overlay) {
  const merged = JSON.parse(JSON.stringify(baseCatalog));
  const patches = overlay?.patches || {};
  for (const [themeId, patch] of Object.entries(patches.themes || {})) {
    // Own-property guard (defense in depth behind validateOverlayShape):
    // '__proto__'/'constructor' keys must never resolve to a target here.
    if (!hasOwn(merged.themes, themeId)) continue;
    const theme = merged.themes[themeId];
    for (const field of Object.keys(THEME_FIELDS)) {
      if (typeof patch[field] === 'string') theme[field] = patch[field].trim();
    }
    if (patch.companion && theme.companion) {
      for (const cf of Object.keys(COMPANION_FIELDS)) {
        if (typeof patch.companion[cf] === 'string') theme.companion[cf] = patch.companion[cf].trim();
      }
    }
  }
  const bookPatches = patches.books || {};
  for (const theme of Object.values(merged.themes)) {
    for (const books of Object.values(theme.age_bands || {})) {
      for (const book of books) {
        const patch = hasOwn(bookPatches, book.id) ? bookPatches[book.id] : null;
        if (!patch) continue;
        for (const field of Object.keys(BOOK_FIELDS)) {
          if (typeof patch[field] === 'string') book[field] = patch[field].trim();
        }
        if (typeof patch.retired === 'boolean') {
          if (patch.retired) book.retired = true;
          else delete book.retired;
        }
        if (patch.refrain) {
          book.refrain = book.refrain || {};
          if (typeof patch.refrain.text === 'string') book.refrain.text = patch.refrain.text.trim();
          if (Array.isArray(patch.refrain.spreads)) book.refrain.spreads = [...patch.refrain.spreads].sort((a, b) => a - b);
        }
        if (patch.beats) {
          for (const beat of book.beats || []) {
            const text = patch.beats[String(beat.spread)];
            if (typeof text === 'string') beat.beat = text.trim();
          }
        }
      }
    }
  }
  return merged;
}

/** sha256 of the canonical overlay JSON — the overlay's identity. */
function overlayHash(overlay) {
  return crypto.createHash('sha256').update(JSON.stringify(overlay || {})).digest('hex');
}

/** The catalog tag a merged catalog carries: `<base>+<hash8>`. */
function overlayTag(baseVersion, hash) {
  return `${baseVersion}+${hash.slice(0, 8)}`;
}

/** Count what an overlay touches, for the admin's diff summary. */
function overlaySummary(overlay) {
  const patches = overlay?.patches || {};
  const books = Object.entries(patches.books || {});
  return {
    themes: Object.keys(patches.themes || {}).length,
    books: books.length,
    beats: books.reduce((n, [, p]) => n + Object.keys(p?.beats || {}).length, 0),
    retired: books.filter(([, p]) => p?.retired === true).length,
  };
}

/** Persist an overlay blob by hash8; returns the hash8. Idempotent. */
async function saveOverlayBlob(overlay) {
  const hash8 = overlayHash(overlay).slice(0, 8);
  await saveJson(overlay, `${OVERLAY_PREFIX}/${hash8}.json`);
  return hash8;
}

/** @param {string} hash8 @returns {Promise<object|null>} */
async function loadOverlayByHash(hash8) {
  if (!/^[a-f0-9]{8}$/.test(String(hash8))) return null;
  try {
    return await loadJson(`${OVERLAY_PREFIX}/${hash8}.json`);
  } catch {
    return null;
  }
}

/** Point the active overlay at hash8 (null = base catalog). */
async function setActivePointer(hash8) {
  await saveJson({ hash8: hash8 || null, at: new Date().toISOString() }, ACTIVE_POINTER);
}

/** @returns {Promise<string|null>} the active overlay hash8, or null */
async function loadActivePointer() {
  try {
    const pointer = await loadJson(ACTIVE_POINTER);
    return pointer?.hash8 || null;
  } catch {
    return null;
  }
}

module.exports = {
  validateOverlayShape,
  applyOverlay,
  overlayHash,
  overlayTag,
  overlaySummary,
  saveOverlayBlob,
  loadOverlayByHash,
  setActivePointer,
  loadActivePointer,
  THEME_FIELDS,
  BOOK_FIELDS,
};
