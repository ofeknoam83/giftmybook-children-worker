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
  eligibleBooks: catalog.eligibleBooks,
  ageBandForAge: catalog.ageBandForAge,
  renderTitle: catalog.renderTitle,
  catalogVersion: catalog.catalogVersion,
  // sidecars
  coverageReport: augments.coverageReport,
  // ops
  assertCatalogEngine,
  flags,
  versions,
};
