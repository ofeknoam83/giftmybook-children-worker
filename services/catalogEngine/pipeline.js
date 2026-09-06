/**
 * Full-book pipeline for the catalog engine: chosen story → 12 renders →
 * interior PDF → cover PDF. The server owns HTTP/callbacks/checkpoint
 * storage; this module owns the run.
 *
 * Resume model: the story rides the checkpoint; renders replay from their
 * deterministic GCS cache; the PDF stages are cheap and always re-run.
 */

const { assemblePdf, OVERLAY } = require('../layoutEngine');
const { generateCover, generateUpsellCovers } = require('../coverGenerator');
const { uploadBuffer, getSignedUrl, downloadBuffer } = require('../gcsStorage');
const { getBook, getBookForTag } = require('./catalog');
const { normalizeProfile } = require('./profile');
const { generateStory } = require('./writer');
const { validateStoryResponse } = require('./storyValidation');
const { illustrateStory } = require('./illustrator');
const { PDFDocument } = require('pdf-lib');
const { backCoverSynopsis } = require('./backCoverSynopsis');

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
 * @returns {Promise<{request: object, response: object, generated: boolean,
 *   repaired: boolean, polished: boolean}>} provenance flags come from the
 *   fresh generation OR are restored from the stored/checkpoint candidate
 *   that carried them (absent on old blobs ⇒ false)
 */
async function resolveStory({ storyPair, checkpointStory, bookDefinitionId, profile, sessionId, writerTuning, log }) {
  const candidate = storyPair || checkpointStory;
  if (candidate) {
    const { request, response } = candidate;
    // Resolve the definition AS PINNED by the story's catalog tag: a story
    // written under an admin catalog overlay must re-validate (and later
    // illustrate) against THAT overlay's beats/refrain, not whatever is
    // active now. A pinned tag that no longer resolves is a HARD failure —
    // a beat-only overlay would pass text re-validation against the current
    // definition and then illustrate different scenes, so falling back
    // silently prints a book whose art disagrees with its provenance.
    const hit = await getBookForTag(request?.book_id, request?.versions?.catalog);
    if (!hit) {
      if (getBook(request?.book_id)) {
        throw new PipelineError(
          `stored story pinned catalog '${request?.versions?.catalog}' which is no longer resolvable — its exact definitions cannot be re-validated or illustrated; regenerate the story`,
          'missing_book_definition',
        );
      }
      throw new PipelineError(`stored story references unknown book_id '${request?.book_id}'`, 'invalid_story');
    }
    // Bind the pair to the CURRENT inputs: same requested definition (when
    // one is named) and the same child (name + age + pronoun set) — internal
    // consistency alone would let another child's story be typeset here.
    if (bookDefinitionId && request.book_id !== bookDefinitionId) {
      throw new PipelineError(`stored story is for '${request.book_id}' but this dispatch requested '${bookDefinitionId}'`, 'invalid_story');
    }
    const { matchKey } = require('./profile');
    const p = request.profile || {};
    const pronounsMatch = ['subject', 'object', 'possessive_adjective']
      .every(k => matchKey(p.pronouns?.[k] || '') === matchKey(profile.pronouns[k]));
    if (matchKey(p.name || '') !== matchKey(profile.name)
      || Number(p.age) !== profile.age
      || !pronounsMatch) {
      throw new PipelineError(
        `stored story was written for '${p.name}' (age ${p.age}, ${p.pronouns?.subject}/${p.pronouns?.object}/${p.pronouns?.possessive_adjective}) but this dispatch is for '${profile.name}' (age ${profile.age}, ${profile.pronouns.subject}/${profile.pronouns.object}/${profile.pronouns.possessive_adjective}) — regenerate the stories`,
        'invalid_story',
      );
    }
    // Re-run the deterministic checks against the SAME pinned request so a
    // corrupted/edited blob can't reach print. The validation MODE comes from
    // the pinned request (versions.personalization_map), never from the
    // response — stripping the evidence array must not buy a laxer pass. If
    // the pinned map has been withdrawn or revised since generation, keep the
    // already-accepted story but skip ONLY the map-dependent evidence steps
    // (loudly) — every text check still runs.
    const { augmentsFor } = require('./augments');
    const pinnedMapVersion = request.versions?.personalization_map || 'none';
    const nameOnly = pinnedMapVersion === 'none';
    const currentMap = augmentsFor(request.book_id).personalizationMap;
    const mapUnavailable = !nameOnly && (!currentMap || currentMap.map_version !== pinnedMapVersion);
    if (mapUnavailable) {
      log('warn', `stored story for ${request.book_id} was written with map ${pinnedMapVersion} but the approved map is ${currentMap ? `now ${currentMap.map_version}` : 'gone'} — skipping evidence re-validation only`);
    }
    const { ok, errors } = validateStoryResponse({
      response, request, book: hit.book, ageBand: hit.ageBand,
      map: nameOnly ? null : currentMap, theme: hit.theme,
      skipEvidenceChecks: mapUnavailable,
      // The doubled-word check (5c) postdates many accepted stories — an
      // already-sold book must keep printing; only fresh generation,
      // repair, and polish enforce it.
      skipDoubledWordCheck: true,
    });
    if (!ok) {
      throw new PipelineError(`stored story failed re-validation: ${errors.slice(0, 4).join('; ')}`, 'invalid_story', { errors });
    }
    log('info', `Using stored story for ${request.book_id} (${storyPair ? 'request' : 'checkpoint'})`);
    // A checkpoint story carries the provenance flags of the generation it
    // snapshotted — a resume after an illustration/PDF failure must still
    // report them, since no earlier success callback ever did.
    return {
      request,
      response,
      generated: false,
      repaired: !!candidate.repaired,
      polished: !!candidate.polished,
    };
  }
  if (!bookDefinitionId) {
    throw new PipelineError('no story and no bookDefinitionId — nothing to render', 'missing_book_definition');
  }
  log('info', `No stored story — generating fresh for ${bookDefinitionId}`);
  // A stored pair above keeps its own pinned tuning tag; the overlay applies
  // only to a FRESH generation.
  const story = await generateStory({ bookId: bookDefinitionId, profile, sessionId, tuning: writerTuning || null });
  return {
    request: story.request,
    response: story.response,
    generated: true,
    repaired: !!story.repaired,
    polished: !!story.polished,
  };
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
 * @param {object|null} [params.writerTuning] Style Tuning Layer overlay — applied to a FRESH generation only
 * @param {object|null} [params.illustrationTuning] Art Tuning Layer overlay — applied to every render
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
 * @param {boolean} [params.identityKeyed] probe-compat render cache keying —
 *   the Art Bench "create final book" dispatch sends the same identityKeyed
 *   (and seed) it probed with so the approved probe renders REPLAY into the
 *   final book instead of re-rendering; customer books omit both and keep
 *   the legacy un-salted keys
 * @param {number|null} [params.seed] probe-compat render seed (cache-keyed;
 *   applying it stays env-gated in the renderer)
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
    forceRerender = false, reviewedOnly = false, costTracker, onProgress = () => {}, log,
  } = params;
  const profile = normalizeProfile(params.profile);

  // ── Story ────────────────────────────────────────────────────────────────
  onProgress('story', 0.1, 'Resolving story...');
  const story = await resolveStory({
    storyPair,
    checkpointStory: checkpoint?.story || null,
    bookDefinitionId: bookDefinitionId || checkpoint?.story?.request?.book_id || null,
    profile, sessionId, writerTuning: params.writerTuning || null, log,
  });
  // Illustration scenes come from the BEATS — resolve them as pinned by the
  // story's catalog tag so a reshaped theme never mismatches older text.
  // resolveStory already resolved this same tag, so a miss here means the
  // overlay blob vanished mid-run: fail rather than draw unpinned scenes.
  const bookDef = await getBookForTag(story.request.book_id, story.request?.versions?.catalog);
  if (!bookDef) {
    throw new PipelineError(
      `catalog '${story.request?.versions?.catalog}' became unresolvable before illustration — regenerate the story`,
      'missing_book_definition',
    );
  }
  const bookTitle = story.response.title;
  const resumeArtwork = !forceRerender && checkpoint?.completedStage === 'illustration'
    && checkpoint.textLayout === textLayout
    && JSON.stringify(checkpoint.story?.request) === JSON.stringify(story.request)
    && JSON.stringify(checkpoint.story?.response) === JSON.stringify(story.response);
  // A retry must not erase the more advanced checkpoint before loading art.
  if (!resumeArtwork) await saveCheckpoint({
    engine: 'catalog-v13',
    completedStage: 'story',
    textLayout,
    story: {
      request: story.request,
      response: story.response,
      ...(story.repaired ? { repaired: true } : {}),
      ...(story.polished ? { polished: true } : {}),
    },
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
    tuning: params.illustrationTuning || null,
    identityKeyed: !!params.identityKeyed,
    seed: Number.isInteger(params.seed) ? params.seed : null,
    costTracker,
    forceRerender,
    // A previous run already reached PDF assembly. Resume from its saved
    // artwork even when the retry came through the ordinary generation URL.
    reviewedOnly: reviewedOnly || resumeArtwork,
    onProgress: (frac, message) => onProgress('illustration', 0.2 + frac * 0.6, message),
    log,
  });
  const qaAdvisories = [...art.qaAdvisories];
  const warnings = [...art.warnings];
  const synopsis = backCoverSynopsis(story.response, { cached: resumeArtwork ? checkpoint?.backCoverSynopsis : null });
  const illustrationCheckpoint = {
    engine: 'catalog-v13',
    completedStage: 'illustration',
    textLayout,
    story: {
      request: story.request,
      response: story.response,
      ...(story.repaired ? { repaired: true } : {}),
      ...(story.polished ? { polished: true } : {}),
    },
    renderKeys: art.entries.map(e => e.spreadIllustrationStorageKey),
    backCoverSynopsis: synopsis,
    ...(resumeArtwork && Array.isArray(checkpoint.upsellCovers) ? { upsellCovers: checkpoint.upsellCovers } : {}),
  };
  await saveCheckpoint(illustrationCheckpoint);

  // ── The approved cover's bytes: the printed front cover AND the upsell
  // reference (downloaded once; a failed download degrades each consumer
  // separately, never the book).
  let approvedCoverBuffer = null;
  if (approvedCoverUrl) {
    try {
      // Storage SDK reads still work when the approved image's signed URL
      // has expired; do not replace that artwork just because its link aged.
      approvedCoverBuffer = await downloadBuffer(approvedCoverUrl);
    } catch (coverErr) {
      log('warn', `approved cover could not be downloaded (${coverErr.message}) — the wrap cover falls back to a re-render anchored on its URL and the upsell spread is skipped`);
      qaAdvisories.push({ stage: 'cover', spread: 'cover', note: `approved cover download failed (${coverErr.message}); the printed cover was re-rendered from the anchor instead of using the approved pixels` });
    }
  }

  // ── Upsell covers (baked into the interior; non-blocking, 4-min cap) ─────
  let upsellWithBuffers = [];
  const savedUpsells = illustrationCheckpoint.upsellCovers;
  if (Array.isArray(savedUpsells)) {
    for (const uc of savedUpsells) {
      try { upsellWithBuffers.push({ ...uc, coverBuffer: await downloadBuffer(uc.gcsPath) }); }
      catch (err) { log('warn', `Saved next-story cover is unavailable (${uc.gcsPath}): ${err.message}`); }
    }
  } else if (approvedCoverBuffer && !reviewedOnly && !resumeArtwork) {
    try {
      onProgress('assembly', 0.85, 'Generating next-story covers...');
      const frontCoverBuffer = approvedCoverBuffer;
      const gender = profile.pronouns.subject === 'he' ? 'male' : profile.pronouns.subject === 'she' ? 'female' : 'neutral';
      const upsellPromise = generateUpsellCovers(
        bookId,
        { name: profile.name, childName: profile.name, age: profile.age, childAge: profile.age, gender, childGender: gender },
        frontCoverBuffer,
        bookTitle,
        {
          costTracker, characterDescription: characterDescription || null, theme: getBook(story.request.book_id).themeId,
          // ce-9: the upsell spread prints INSIDE the same book — its four
          // renders wear the book's locked outfit and anchor on the character
          // model sheet, not on a 256px cover thumbnail alone.
          characterOutfit: art.bible?.outfit?.outfit || null,
          characterSheet: art.bible?.sheet ? { base64: art.bible.sheet.base64, mimeType: art.bible.sheet.mimeType || 'image/png' } : null,
        },
      ).catch(e => { log('warn', `Upsell covers failed (non-blocking): ${e.message}`); return []; });
      let upsellTimer;
      let raced;
      try {
        raced = await Promise.race([upsellPromise, new Promise(r => { upsellTimer = setTimeout(() => r(null), 4 * 60 * 1000); })]);
      } finally {
        clearTimeout(upsellTimer);
      }
      const upsellCovers = raced === null ? [] : raced;
      if (raced === null) log('warn', 'Upsell cover generation timed out after 4 min — continuing without the upsell spread');
      for (const uc of upsellCovers) {
        try {
          upsellWithBuffers.push({ ...uc, coverBuffer: await downloadBuffer(uc.gcsPath) });
        } catch (e) {
          log('warn', `Upsell cover buffer download failed (${uc.gcsPath}): ${e.message}`);
        }
      }
      if (upsellWithBuffers.length > 0) log('info', `Upsell covers ready: ${upsellWithBuffers.length}/4`);
    } catch (upsellErr) {
      log('warn', `Upsell covers skipped (non-blocking): ${upsellErr.message}`);
    }
  }

  // Persist the optional marketing art too: a PDF retry must not buy four
  // fresh illustrations or wait on their generation a second time.
  illustrationCheckpoint.upsellCovers = upsellWithBuffers.map(({ coverBuffer, ...cover }) => cover);
  await saveCheckpoint(illustrationCheckpoint);

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
    upsellCovers: upsellWithBuffers,
  });
  const pageCount = (await PDFDocument.load(interiorPdf)).getPageCount();
  if (pageCount < 32 || pageCount % 2 !== 0) {
    throw new PipelineError('Interior PDF has an invalid page count', 'interior_pdf_failed');
  }
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
  let coverError = null;
  for (let attempt = 0; attempt < 2 && !coverPdfUrl; attempt++) {
    try {
      if (!coverData) {
        const candidate = await generateCover(bookTitle, { name: profile.name, childName: profile.name, age: profile.age }, approvedCoverUrl, FORMAT, {
          costTracker, bookId, pageCount, synopsis,
          heartfeltNote, bookFrom, bindingType,
          requireCompleteCover: true,
          // A second assembly attempt uses the approved front and the existing
          // typeset, color-matched back/spine fallback, without another AI render.
          ...(attempt > 0 || reviewedOnly || resumeArtwork ? { reuseApprovedArtworkOnly: true } : {}),
          coverSourceUrl: approvedCoverUrl || '',
          // ce-9: the PRINTED front cover is the parent-approved cover's own
          // pixels (harmonized only when the source is not provably 3D). Before
          // ce-9 the wrap rendered a fresh, title-less, un-anchored cover here —
          // generateFrontCoverImage received no photo bytes, so the physical
          // cover showed a different child than the one the parent approved.
          ...(approvedCoverBuffer ? { preGeneratedCoverBuffer: approvedCoverBuffer } : {}),
          // The worker's own probe-anchor covers (/v13/generate-cover-image →
          // children-covers/{bookId}/anchor-cover-*.png) are rendered through
          // the pixar_premium path and carry no path marker — say so, or the
          // wrap would img2img-"harmonize" (re-render) the approved pixels.
          ...(/\/anchor-cover-[^/]*\.png(\?|$)/.test(String(approvedCoverUrl || '')) ? { coverSourceIs3D: true } : {}),
          // Fallback (download failed): at least anchor the re-render on the
          // approved cover URL instead of rendering an undescribed child.
          ...(!approvedCoverBuffer && approvedCoverUrl ? { childPhotoUrl: approvedCoverUrl } : {}),
        });
        if (!candidate?.coverPdfBuffer?.length) throw new Error('Full cover PDF buffer was not produced');
        const coverDocument = await PDFDocument.load(candidate.coverPdfBuffer);
        const coverPage = coverDocument.getPages()[0];
        if (coverDocument.getPageCount() !== 1 || coverPage.getWidth() <= 2 * 612 || coverPage.getHeight() < 612) {
          throw new Error('Full cover PDF was not produced as one wraparound page');
        }
        coverData = candidate;
      }
      const coverPath = `children-jobs/${bookId}/cover.pdf`;
      await uploadBuffer(coverData.coverPdfBuffer, coverPath, 'application/pdf');
      coverPdfUrl = await getSignedUrl(coverPath, SIGNED_URL_TTL_MS);
      if (!coverPdfUrl) throw new Error('Cover PDF download link was not produced');
      if (attempt > 0) warnings.push('Cover PDF recovered automatically using saved artwork.');
      if (coverData.coverAnatomyAdvisory) qaAdvisories.push({ stage: 'cover', spread: 'cover', note: coverData.coverAnatomyAdvisory });
    } catch (coverErr) {
      coverError = coverErr;
      log('warn', `Cover PDF attempt ${attempt + 1} failed: ${coverErr.message}${attempt === 0 ? ' — retrying automatically with saved artwork' : ''}`);
    }
  }
  if (!coverPdfUrl) {
    const err = new PipelineError(`Full cover PDF could not be completed: ${coverError?.message || 'missing cover PDF'}. The interior PDF and illustrations are saved for retry.`, 'cover_pdf_failed');
    Object.assign(err, { interiorPdfUrl, pageCount, previewImageUrls: art.previewImageUrls, bookBible: art.bookBible, qaAdvisories });
    throw err;
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
      // The app replays these entries into /v13/preview/embedded-overlay and
      // /finalize-book — art with Gemini-painted text must keep saying so,
      // or a later layout pass would typeset the caption over it again.
      ...(e.textEmbeddedInArt ? { textEmbeddedInArt: true } : {}),
    })),
    characterDescription: characterDescription || null,
    characterAnchor: characterDescription || null,
    synopsis,
    catalog: {
      bookDefinitionId: story.request.book_id,
      themeId: bookDef.themeId,
      ageBand: bookDef.ageBand,
      archetype: bookDef.book.archetype,
      versions: story.request.versions,
      // Pinned at RENDER time (the story's versions echo is pinned at story
      // time and its schema is frozen) — which Art Tuning version painted
      // this book's spreads, or 'none'.
      illustrationTuning: art.illustrationTuningUsed,
      personalizationEvidence: story.response.personalization_evidence || [],
      omittedProfileFields: story.response.omitted_profile_fields || [],
      ...(story.repaired ? { repaired: true } : {}),
      ...(story.polished ? { polished: true } : {}),
    },
  };

  return {
    interiorPdfUrl,
    coverPdfUrl,
    pageCount,
    backCoverImageUrl: coverData?.backCoverImageUrl || null,
    previewImageUrls: art.previewImageUrls,
    title: bookTitle,
    spreadCount: art.entries.length,
    illustrationTuningUsed: art.illustrationTuningUsed,
    // Which outfit-lock spec (content hash) the renders were pinned to, or
    // 'none' — a lock-less book also carries a stage 'outfitLock' advisory.
    outfitLockUsed: art.outfitLockUsed || 'none',
    // ce-15: the typography anchor the embedded spreads were held to, or 'none'.
    typographyAnchorUsed: art.typographyAnchorUsed || 'none',
    // ce-18: the book-level ink verdict — always present (null when the
    // gate did not run: kill-switch, non-embedded layout, or <2 measured).
    textInkQa: art.textInkQa || null,
    // Book-level world-consistency verdict — ALWAYS present: null when the
    // gate did not run (kill-switch, <2 renders), so callback consumers get
    // one stable shape. Per-spread world findings already ride qaAdvisories
    // (stage 'worldQa').
    worldQa: art.worldQa || null,
    // ce-9: the contact-sheet gate verdict (same stable-shape rule) and the
    // Book Bible summary (character sheet / outfit spec / prop sheets /
    // hashes) the renders were pinned to — the app persists it as
    // storyContent.bookBible and the bench shows it.
    contactQa: art.contactQa || null,
    bookBible: art.bookBible || null,
    storyContent,
    upsellCovers: upsellWithBuffers.map(({ coverBuffer, ...cover }) => cover),
    // ce-9: blocking-class findings first, then the rest, capped at 80 (a
    // 12-spread book with candidates, set gates and layout notes can exceed
    // the old 40 — the drift findings must never be the ones dropped).
    qaAdvisories: [...qaAdvisories.filter(a => /BLOCKING|consistency|identity|outfit|prop /i.test(String(a.note))), ...qaAdvisories.filter(a => !/BLOCKING|consistency|identity|outfit|prop /i.test(String(a.note)))].slice(0, 80),
    warnings,
  };
}

module.exports = { runBookPipeline, resolveStory, PipelineError };
