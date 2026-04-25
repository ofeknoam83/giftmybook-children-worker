/**
 * Cover Metadata — shared helpers for computing the pageCount + synopsis
 * used when building the Lulu wrap-around cover PDF.
 *
 * These helpers are the single source of truth for spine width + back-cover
 * synopsis so that the main book generation pipeline and the admin
 * /rebuild-cover-pdf flow always produce identical cover PDFs for the same
 * book + binding.
 *
 * The source object can be either:
 *   - A live storyPlan (during initial generation) — has storyBible,
 *     allPanels, entries, chapters, synopsis, tagline, etc.
 *   - A persisted storyContent (when rebuilding later) — has scenes,
 *     chapters, entries, tagline (graphic novel only).
 *
 * Both shapes are supported; when a storyPlan-only field is missing we fall
 * back to the equivalent derivation from storyContent.
 */

/**
 * Round up to next even number, enforce a minimum of 32 pages (Lulu minimum
 * for our supported formats).
 */
function normalizePageCount(raw) {
  const evened = raw % 2 === 0 ? raw : raw + 1;
  return Math.max(32, evened);
}

/**
 * Count total panels across all scenes when `allPanels` is not available
 * (i.e. when working from the persisted storyContent).
 */
function countPanelsFromScenes(scenes) {
  if (!Array.isArray(scenes)) return 0;
  return scenes.reduce((sum, s) => sum + (Array.isArray(s?.panels) ? s.panels.length : 0), 0);
}

/**
 * Compute the interior page count the same way the main generation pipeline
 * does (so spine width matches exactly).
 *
 * @param {object} source - storyPlan or storyContent
 * @param {object} [flags] - explicit book-type flags (isChapterBook, isGraphicNovel)
 * @returns {number}
 */
function computePageCount(source = {}, flags = {}) {
  const isGraphicNovel = !!(flags.isGraphicNovel || source.isGraphicNovel);
  const isChapterBook  = !!(flags.isChapterBook  || source.isChapterBook);

  if (isGraphicNovel) {
    // Graphic novel: title + dedication + scene pages (panel-count driven) + end page
    const panelCount = Array.isArray(source.allPanels)
      ? source.allPanels.length
      : countPanelsFromScenes(source.scenes);
    return normalizePageCount(2 + Math.ceil(panelCount / 2) + 1);
  }

  if (isChapterBook) {
    // Chapter book: title + dedication + chapters * 4 + end page
    const chapterCount = Array.isArray(source.chapters) ? source.chapters.length : 0;
    return normalizePageCount(2 + chapterCount * 4 + 1);
  }

  // Picture book / early reader: 2pp per spread, 1pp per single
  const entries = Array.isArray(source.entries) ? source.entries : [];
  let count = 0;
  for (const entry of entries) {
    if (entry?.type === 'spread') count += 2;
    else count += 1;
  }
  return normalizePageCount(count);
}

/**
 * Compute the back-cover synopsis the same way the main generation pipeline
 * does.
 *
 * @param {object} source - storyPlan or storyContent
 * @param {object} childDetails - used for fallback text
 * @param {object} [flags] - explicit book-type flags (isChapterBook, isGraphicNovel)
 * @returns {string}
 */
function computeSynopsis(source = {}, childDetails = {}, flags = {}) {
  const isGraphicNovel = !!(flags.isGraphicNovel || source.isGraphicNovel);
  const isChapterBook  = !!(flags.isChapterBook  || source.isChapterBook);
  const name = childDetails.name || childDetails.childName || 'a special child';

  if (isGraphicNovel) {
    const blueprint = Array.isArray(source.storyBible?.sceneBlueprints)
      && source.storyBible.sceneBlueprints.length >= 2
      ? source.storyBible.sceneBlueprints.slice(0, 3).map(s => s.purpose || s.sceneTitle || '').filter(Boolean).join(' ')
      : null;
    return source.synopsis
      || source.storyBible?.logline
      || source.storyBible?.audiencePromise
      || blueprint
      || source.tagline
      || `A personalized graphic novel for ${name}`;
  }

  if (isChapterBook) {
    const joined = Array.isArray(source.chapters)
      ? source.chapters.slice(0, 2).map(ch => ch?.synopsis).filter(Boolean).join(' ')
      : '';
    return joined || `A personalized chapter book for ${name}`;
  }

  // Picture book / early reader: never use raw spread text as a "synopsis" (it
  // is story narration, not a back-cover blurb). Prefer explicit synopsis + book
  // bible + tagline, then a generic line.
  const fromBible = (source.storyBible?.narrativeSpine
    || source.storyBible?.logline
    || source.storyBible?.audiencePromise
    || '')
    .toString()
    .trim();

  return source.synopsis
    || fromBible
    || source.tagline
    || source.plotSynopsis
    || `A personalized bedtime story for ${name}`;
}

/**
 * Convenience wrapper returning both values.
 */
function computeCoverPdfMetadata(source, childDetails, flags) {
  return {
    pageCount: computePageCount(source, flags),
    synopsis:  computeSynopsis(source, childDetails, flags),
  };
}

module.exports = {
  normalizePageCount,
  computePageCount,
  computeSynopsis,
  computeCoverPdfMetadata,
};
