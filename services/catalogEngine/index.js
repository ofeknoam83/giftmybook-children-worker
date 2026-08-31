/**
 * Catalog Engine — the V1.3 fixed-catalog children's-book system.
 *
 * Public API:
 *   selectBooks(...)     — deterministic 3-candidate selection (no LLM)
 *   generateStory(...)   — one validated 12-spread story for one book id
 *   generateStories(...) — N candidates in parallel, per-candidate retry
 *   catalog helpers      — themes, book lookup, age-band routing
 *   coverageReport()     — sidecar authoring coverage (admin/release gate)
 *
 * The illustrator lives in ./illustrator (renders a CHOSEN story only).
 */

const catalog = require('./catalog');
const catalogOverlay = require('./catalogOverlay');
const augments = require('./augments');
const { normalizeProfile, usableDetails, ProfileError } = require('./profile');
const { selectBooks } = require('./selection');
const { generateStory, StoryGenerationError, validateTuningInput } = require('./writer');
const { validateArtTuningInput } = require('./illustrator/tuning');
const { validateStoryResponse } = require('./storyValidation');
const flags = require('./flags');
const versions = require('./versions');

/**
 * Generate stories for several candidate books in parallel. Each candidate
 * succeeds or fails independently (a failed candidate reports its errors;
 * it never blocks or replaces the others).
 *
 * @param {object} params
 * @param {string[]} params.bookIds candidate catalog ids
 * @param {object} params.profile raw child profile
 * @param {string} params.sessionId
 * @param {string} [params.locale]
 * @param {object} [params.tuning] raw writerTuning overlay (validated/normalized in the writer)
 * @param {(candidate: {bookId: string, status: string}) => void} [params.onProgress]
 * @returns {Promise<{stories: object[], failures: Array<{bookId, message, errors}>}>}
 */
async function generateStories({ bookIds, profile, sessionId, locale, tuning, onProgress }) {
  const results = await Promise.allSettled(bookIds.map(async bookId => {
    onProgress?.({ bookId, status: 'generating' });
    const story = await generateStory({ bookId, profile, sessionId, locale, tuning });
    onProgress?.({ bookId, status: 'done' });
    return story;
  }));
  const stories = [];
  const failures = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') stories.push(r.value);
    else {
      const err = r.reason;
      onProgress?.({ bookId: bookIds[i], status: 'failed' });
      failures.push({
        bookId: bookIds[i],
        message: err?.message || String(err),
        errors: err?.validationErrors || [],
      });
    }
  });
  return { stories, failures };
}

/**
 * Boot-time assertion: catalog + approved sidecars load and validate.
 * Called from server bootstrap so a broken data file fails the deploy's
 * health check instead of the first customer book.
 */
function assertCatalogEngine() {
  catalog.loadCatalog();
  catalog.loadAgeEngines();
  augments.loadAugments();
  const report = augments.coverageReport();
  // Full sidecar coverage is a HARD deploy invariant, not a log line: a
  // deleted sidecar would otherwise boot fine and silently ship that book
  // name-only. (CATALOG_PERSONALIZATION_MAPS=0 is the intentional off-switch.)
  if (report.booksWithMap !== report.totalBooks || report.booksWithSelectionProfile !== report.totalBooks) {
    throw new Error(`[catalogEngine] sidecar coverage incomplete: ${report.booksWithMap}/${report.totalBooks} maps, `
      + `${report.booksWithSelectionProfile}/${report.totalBooks} selection profiles — every catalog book must carry an approved sidecar`);
  }
  console.log(`[catalogEngine] ready: ${report.totalBooks} books, ${report.booksWithMap} approved map(s), `
    + `fitRanking=${flags.fitRankingEnabled()} maps=${flags.personalizationMapsEnabled()} evidenceRequired=${flags.evidenceRequired()}`);
  return report;
}

/**
 * Boot-time overlay restore: load the active pointer + blob from GCS and
 * swap the live catalog to base+overlay. Fail-safe by design — ANY failure
 * (flag off, no pointer, missing blob, shape or invariant errors) logs
 * loudly and serves the frozen base catalog; overlay problems must never
 * brick a revision.
 * @returns {Promise<{active: string|null, tag: string}>}
 */
async function initCatalogOverlay() {
  const baseTag = String(catalog.baseCatalog().version);
  if (!flags.catalogOverlayEnabled()) {
    console.log('[catalogEngine] CATALOG_OVERLAY=0 — overlays disabled, serving the base catalog');
    return { active: null, tag: baseTag };
  }
  try {
    const hash8 = await catalogOverlay.loadActivePointer();
    if (!hash8) return { active: null, tag: baseTag };
    const overlay = await catalogOverlay.loadOverlayByHash(hash8);
    if (!overlay) {
      console.error(`[catalogEngine] active catalog overlay ${hash8} is missing from GCS — serving the base catalog`);
      return { active: null, tag: baseTag };
    }
    const shapeErrors = catalogOverlay.validateOverlayShape(overlay, catalog.baseCatalog());
    if (shapeErrors.length > 0) {
      console.error(`[catalogEngine] active catalog overlay ${hash8} is invalid (${shapeErrors[0]}) — serving the base catalog`);
      return { active: null, tag: baseTag };
    }
    const tag = catalog.applyCatalogOverlay(overlay, hash8);
    return { active: hash8, tag };
  } catch (err) {
    console.error(`[catalogEngine] catalog overlay init failed: ${err.message} — serving the base catalog`);
    return { active: null, tag: baseTag };
  }
}

/**
 * One reconciliation pass: read the GCS active pointer and converge THIS
 * instance's live catalog to it. Cloud Run runs many warm instances; only
 * the one that served /v13/catalog-overlay/activate hot-swaps immediately,
 * so every instance polls the pointer and converges within the interval.
 * Fail-safe like boot restore: errors propagate to the caller (the watch
 * logs them) and the current catalog keeps serving.
 * @returns {Promise<{changed: boolean, tag: string}>}
 */
async function syncCatalogOverlayFromPointer() {
  const currentHash = catalog.activeOverlayHash();
  const pointerHash = await catalogOverlay.loadActivePointer();
  if ((pointerHash || null) === (currentHash || null)) {
    return { changed: false, tag: catalog.catalogVersion() };
  }
  if (!pointerHash) {
    const tag = catalog.resetCatalogOverlay();
    console.log('[catalogEngine] overlay pointer cleared on another instance — back to the base catalog');
    return { changed: true, tag };
  }
  const overlay = await catalogOverlay.loadOverlayByHash(pointerHash);
  if (!overlay) throw new Error(`active overlay ${pointerHash} is missing from GCS`);
  const shapeErrors = catalogOverlay.validateOverlayShape(overlay, catalog.baseCatalog());
  if (shapeErrors.length > 0) throw new Error(`active overlay ${pointerHash} is invalid: ${shapeErrors[0]}`);
  const tag = catalog.applyCatalogOverlay(overlay, pointerHash);
  console.log(`[catalogEngine] converged to overlay ${pointerHash} activated on another instance (tag ${tag})`);
  return { changed: true, tag };
}

let _overlayWatch = null;
/**
 * Start the periodic pointer watch (CATALOG_OVERLAY_POLL_SECONDS, default
 * 60; 0 disables). Idempotent; the timer is unref'd so it never holds the
 * process open. A failed pass logs loudly and the next tick retries.
 * @returns {NodeJS.Timeout|null}
 */
function startCatalogOverlayWatch() {
  const seconds = Number(process.env.CATALOG_OVERLAY_POLL_SECONDS ?? 60);
  if (!flags.catalogOverlayEnabled() || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (_overlayWatch) return _overlayWatch;
  let inFlight = false;
  _overlayWatch = setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await syncCatalogOverlayFromPointer();
    } catch (err) {
      console.error(`[catalogEngine] overlay pointer sync failed: ${err.message} — keeping the current catalog`);
    } finally {
      inFlight = false;
    }
  }, seconds * 1000);
  _overlayWatch.unref?.();
  console.log(`[catalogEngine] catalog overlay pointer watch every ${seconds}s (multi-instance convergence)`);
  return _overlayWatch;
}

module.exports = {
  // selection + generation
  selectBooks,
  generateStory,
  generateStories,
  validateStoryResponse,
  validateTuningInput,
  validateArtTuningInput,
  StoryGenerationError,
  ProfileError,
  // profile
  normalizeProfile,
  usableDetails,
  // catalog
  listThemes: catalog.listThemes,
  getBook: catalog.getBook,
  getBookForTag: catalog.getBookForTag,
  eligibleBooks: catalog.eligibleBooks,
  ageBandForAge: catalog.ageBandForAge,
  renderTitle: catalog.renderTitle,
  catalogVersion: catalog.catalogVersion,
  // catalog overlay (admin plot editing)
  mergedCatalog: catalog.loadCatalog,
  baseCatalog: catalog.baseCatalog,
  applyCatalogOverlay: catalog.applyCatalogOverlay,
  resetCatalogOverlay: catalog.resetCatalogOverlay,
  activeOverlayHash: catalog.activeOverlayHash,
  catalogOverlay,
  initCatalogOverlay,
  syncCatalogOverlayFromPointer,
  startCatalogOverlayWatch,
  // sidecars
  coverageReport: augments.coverageReport,
  // ops
  assertCatalogEngine,
  flags,
  versions,
};
