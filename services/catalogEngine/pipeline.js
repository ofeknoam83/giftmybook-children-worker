/**
 * Full-book pipeline for the catalog engine: chosen story → 12 renders →
 * interior PDF → cover PDF. The server owns HTTP/callbacks/checkpoint
 * storage; this module owns the run.
 *
 * Resume model: the story rides the checkpoint; renders replay from their
 * deterministic GCS cache; the PDF stages are cheap and always re-run.
 */

const { assemblePdf, OVERLAY } = require('../layoutEngine');
const { generateCover } = require('../coverGenerator');
const { computeCoverPdfMetadata } = require('../coverMetadata');
const { uploadBuffer, getSignedUrl } = require('../gcsStorage');
const { getBook } = require('./catalog');
const { normalizeProfile } = require('./profile');
const { generateStory } = require('./writer');
const { validateStoryResponse } = require('./storyValidation');
const { illustrateStory } = require('./illustrator');

const SIGNED_URL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FORMAT = 'PICTURE_BOOK';

class PipelineError extends Error {
  constructor(message, failureCode, details) {
    super(message);
    this.name = 'PipelineError';
    this.failureCode = failureCode || null;
    this.details = details || null;
  }
}

/**
 * Resolve the story to illustrate:
 *  - a stored {request, response} pair from /v13/generate-stories (re-validated
 *    against its own pinned request — never trusted blindly), or
 *  - checkpoint story from a previous run, or
 *  - a fresh generation for the requested book id.
 * @returns {Promise<{request: object, response: object, generated: boolean}>}
 */
async function resolveStory({ storyPair, checkpointStory, bookDefinitionId, profile, sessionId, log }) {
  const candidate = storyPair || checkpointStory;
  if (candidate) {
    const { request, response } = candidate;
    const hit = getBook(request?.book_id);
    if (!hit) throw new PipelineError(`stored story references unknown book_id '${request?.book_id}'`, 'invalid_story');
    // Re-run the deterministic checks against the SAME pinned request so a
    // corrupted/edited blob can't reach print. Evidence legality needs the
    // book's approved map; if it was withdrawn since generation, keep the
    // already-accepted story but say so loudly rather than bricking the book.
    const { augmentsFor } = require('./augments');
    const evCount = (response.personalization_evidence || []).length;
    const map = augmentsFor(request.book_id).personalizationMap;
    if (evCount > 0 && !map) {
      log('warn', `stored story for ${request.book_id} carries ${evCount} evidence record(s) but the approved map is gone — skipping evidence re-validation`);
      if (!Array.isArray(response.spreads) || response.spreads.length !== 12 || !response.title) {
        throw new PipelineError('stored story is structurally invalid (needs 12 spreads and a title)', 'invalid_story');
      }
    } else {
      const { ok, errors } = validateStoryResponse({
        response, request, book: hit.book, ageBand: hit.ageBand, map: evCount > 0 ? map : null,
      });
      if (!ok) {
        throw new PipelineError(`stored story failed re-validation: ${errors.slice(0, 4).join('; ')}`, 'invalid_story', { errors });
      }
    }
    log('info', `Using stored story for ${request.book_id} (${storyPair ? 'request' : 'checkpoint'})`);
    return { request, response, generated: false };
  }
  if (!bookDefinitionId) {
    throw new PipelineError('no story and no bookDefinitionId — nothing to render', 'missing_book_definition');
  }
  log('info', `No stored story — generating fresh for ${bookDefinitionId}`);
  const story = await generateStory({ bookId: bookDefinitionId, profile, sessionId });
  return { request: story.request, response: story.response, generated: true };
}

/**
 * Run the full book pipeline.
 *
 * @param {object} params
 * @param {string} params.bookId main-app book id
 * @param {string|null} params.bookDefinitionId chosen catalog id (fallback when no story)
 * @param {object} params.profile raw profile (normalized here)
 * @param {string} params.sessionId
 * @param {{request: object, response: object}|null} params.storyPair chosen story from the main app
 * @param {object|null} params.checkpoint previously saved checkpoint (or null)
 * @param {(cp: object) => Promise<void>} params.saveCheckpoint
 * @param {string|null} params.approvedCoverUrl
 * @param {string|null} params.childPhotoUrl
 * @param {string|null} params.characterDescription
 * @param {string} params.textLayout
 * @param {string|null} params.heartfeltNote
 * @param {string|null} params.bookFrom
 * @param {string|null} params.bindingType
 * @param {boolean} params.forceRerender
 * @param {object} params.costTracker
 * @param {(stage: string, frac: number, message: string) => void} params.onProgress
 * @param {(level: string, msg: string) => void} params.log
 * @returns {Promise<object>} completion payload (callback-shaped, minus transport fields)
 */
async function runBookPipeline(params) {
  const {
    bookId, bookDefinitionId, sessionId, storyPair, checkpoint, saveCheckpoint,
    approvedCoverUrl, childPhotoUrl, characterDescription,
    textLayout = 'caption', heartfeltNote, bookFrom, bindingType,
    forceRerender = false, costTracker, onProgress = () => {}, log,
  } = params;
  const profile = normalizeProfile(params.profile);

  // ── Story ────────────────────────────────────────────────────────────────
  onProgress('story', 0.1, 'Resolving story...');
  const story = await resolveStory({
    storyPair,
    checkpointStory: checkpoint?.story || null,
    bookDefinitionId: bookDefinitionId || checkpoint?.story?.request?.book_id || null,
    profile, sessionId, log,
  });
  const bookDef = getBook(story.request.book_id);
  const bookTitle = story.response.title;
  await saveCheckpoint({
    engine: 'catalog-v13',
    completedStage: 'story',
    textLayout,
    story: { request: story.request, response: story.response },
  });

  // ── Illustration ─────────────────────────────────────────────────────────
  onProgress('illustration', 0.2, 'Illustrating spreads...');
  const art = await illustrateStory({
    bookId,
    story: story.response,
    bookDef,
    profile,
    approvedCoverUrl,
    childPhotoUrl,
    characterDescription,
    textLayout,
    costTracker,
    forceRerender,
    onProgress: (frac, message) => onProgress('illustration', 0.2 + frac * 0.6, message),
    log,
  });
  const qaAdvisories = [...art.qaAdvisories];
  const warnings = [...art.warnings];
  await saveCheckpoint({
    engine: 'catalog-v13',
    completedStage: 'illustration',
    textLayout,
    story: { request: story.request, response: story.response },
    renderKeys: art.entries.map(e => e.spreadIllustrationStorageKey),
  });

  // ── Interior PDF ─────────────────────────────────────────────────────────
  onProgress('assembly', 0.88, 'Assembling interior PDF...');
  const overlayReport = [];
  const interiorPdf = await assemblePdf(art.entries, FORMAT, {
    title: bookTitle,
    childName: profile.name,
    dedication: heartfeltNote || null,
    bookFrom: bookFrom || null,
    year: new Date().getFullYear(),
    bookId,
    minPages: 32,
    overlayReport,
  });
  for (const r of overlayReport.filter(x => x.belowContrast)) {
    qaAdvisories.push({ stage: 'layout', spread: r.spread, note: `embedded overlay contrast ${r.contrastRatio}:1 below ${OVERLAY.MIN_CONTRAST}:1` });
  }

  onProgress('upload', 0.92, 'Uploading interior PDF...');
  const interiorPath = `children-jobs/${bookId}/interior.pdf`;
  await uploadBuffer(interiorPdf, interiorPath, 'application/pdf');
  const interiorPdfUrl = await getSignedUrl(interiorPath, SIGNED_URL_TTL_MS);

  // ── Cover PDF ────────────────────────────────────────────────────────────
  onProgress('cover', 0.95, 'Building cover PDF...');
  let coverPdfUrl = null;
  let coverData = null;
  try {
    const { pageCount, synopsis } = computeCoverPdfMetadata(
      { entries: art.entries, synopsis: bookDef.book.premise },
      { name: profile.name, childName: profile.name, age: profile.age },
      {},
    );
    coverData = await generateCover(bookTitle, { name: profile.name, childName: profile.name, age: profile.age }, approvedCoverUrl, FORMAT, {
      costTracker, bookId, pageCount, synopsis,
      heartfeltNote, bookFrom, bindingType,
      coverSourceUrl: approvedCoverUrl || '',
    });
    if (coverData?.coverPdfBuffer) {
      const coverPath = `children-jobs/${bookId}/cover.pdf`;
      await uploadBuffer(coverData.coverPdfBuffer, coverPath, 'application/pdf');
      coverPdfUrl = await getSignedUrl(coverPath, SIGNED_URL_TTL_MS);
    }
  } catch (coverErr) {
    // A coverless book must never report silently clean (2026-07-28 lesson).
    qaAdvisories.push({ stage: 'cover', spread: 'cover', note: `Cover PDF generation failed: ${coverErr.message}` });
    warnings.push(`Cover PDF failed: ${coverErr.message} — rebuild via /rebuild-cover-pdf.`);
    log('error', `Cover PDF failed (non-blocking): ${coverErr.message}`);
  }

  // ── storyContent (persisted by the main app; feeds coloring books/admin) ─
  const storyContent = {
    title: bookTitle,
    entries: art.entries.map(e => ({
      type: 'spread',
      spread: e.spread,
      captionText: e.captionText,
      hasImage: !!e.spreadIllustrationUrl,
      textLayout: e.textLayout,
      ...(e.spreadIllustrationUrl ? { spreadIllustrationUrl: e.spreadIllustrationUrl } : {}),
      ...(e.spreadIllustrationStorageKey ? { spreadIllustrationStorageKey: e.spreadIllustrationStorageKey } : {}),
    })),
    characterDescription: characterDescription || null,
    characterAnchor: characterDescription || null,
    synopsis: bookDef.book.premise,
    catalog: {
      bookDefinitionId: story.request.book_id,
      themeId: bookDef.themeId,
      ageBand: bookDef.ageBand,
      archetype: bookDef.book.archetype,
      versions: story.request.versions,
      personalizationEvidence: story.response.personalization_evidence || [],
      omittedProfileFields: story.response.omitted_profile_fields || [],
    },
  };

  return {
    interiorPdfUrl,
    coverPdfUrl,
    backCoverImageUrl: coverData?.backCoverImageUrl || null,
    previewImageUrls: art.previewImageUrls,
    title: bookTitle,
    spreadCount: art.entries.length,
    storyContent,
    qaAdvisories: qaAdvisories.slice(0, 40),
    warnings,
  };
}

module.exports = { runBookPipeline, PipelineError };
