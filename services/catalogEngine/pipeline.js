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
const { computeCoverPdfMetadata } = require('../coverMetadata');
const { uploadBuffer, getSignedUrl, downloadBuffer } = require('../gcsStorage');
const { getBook } = require('./catalog');
const { normalizeProfile } = require('./profile');
const { generateStory, evidenceTextAligned } = require('./writer');
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
 * @returns {Promise<{request: object, response: object, generated: boolean,
 *   repaired: boolean, polished: boolean}>} provenance flags come from the
 *   fresh generation OR are restored from the stored/checkpoint candidate
 *   that carried them (absent on old blobs ⇒ false)
 */
async function resolveStory({ storyPair, checkpointStory, bookDefinitionId, profile, sessionId, writerTuning, log }) {
  const candidate = storyPair || checkpointStory;
  if (candidate) {
    const { request, response } = candidate;
    const hit = getBook(request?.book_id);
    if (!hit) throw new PipelineError(`stored story references unknown book_id '${request?.book_id}'`, 'invalid_story');
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
    });
    if (!ok) {
      throw new PipelineError(`stored story failed re-validation: ${errors.slice(0, 4).join('; ')}`, 'invalid_story', { errors });
    }
    // The second-pass alignment invariant holds for stored pairs too: an
    // edited blob declaring evidence for text that sits on another spread
    // must not reach print (skipped with the other evidence checks when the
    // pinned map is gone — alignment is meaningless without the map's mode).
    if (!mapUnavailable) {
      const alignErrors = evidenceTextAligned(response);
      if (alignErrors.length > 0) {
        throw new PipelineError(`stored story failed re-validation: ${alignErrors.slice(0, 4).join('; ')}`, 'invalid_story', { errors: alignErrors });
      }
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
    profile, sessionId, writerTuning: params.writerTuning || null, log,
  });
  const bookDef = getBook(story.request.book_id);
  const bookTitle = story.response.title;
  await saveCheckpoint({
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
    story: {
      request: story.request,
      response: story.response,
      ...(story.repaired ? { repaired: true } : {}),
      ...(story.polished ? { polished: true } : {}),
    },
    renderKeys: art.entries.map(e => e.spreadIllustrationStorageKey),
  });

  // ── Upsell covers (baked into the interior; non-blocking, 4-min cap) ─────
  let upsellWithBuffers = [];
  if (approvedCoverUrl) {
    try {
      onProgress('assembly', 0.85, 'Generating next-story covers...');
      const coverAbort = new AbortController();
      const coverTimer = setTimeout(() => coverAbort.abort(), 30000);
      const coverResp = await fetch(approvedCoverUrl, { signal: coverAbort.signal }).finally(() => clearTimeout(coverTimer));
      if (!coverResp.ok) throw new Error(`cover fetch HTTP ${coverResp.status}`);
      const frontCoverBuffer = Buffer.from(await coverResp.arrayBuffer());
      const gender = profile.pronouns.subject === 'he' ? 'male' : profile.pronouns.subject === 'she' ? 'female' : 'neutral';
      const upsellPromise = generateUpsellCovers(
        bookId,
        { name: profile.name, childName: profile.name, age: profile.age, childAge: profile.age, gender, childGender: gender },
        frontCoverBuffer,
        bookTitle,
        { costTracker, characterDescription: characterDescription || null, theme: getBook(story.request.book_id).themeId },
      ).catch(e => { log('warn', `Upsell covers failed (non-blocking): ${e.message}`); return []; });
      const raced = await Promise.race([upsellPromise, new Promise(r => setTimeout(() => r(null), 4 * 60 * 1000))]);
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
      ...(story.repaired ? { repaired: true } : {}),
      ...(story.polished ? { polished: true } : {}),
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
    upsellCovers: upsellWithBuffers.map(uc => ({ index: uc.index, coverUrl: uc.coverUrl, gcsPath: uc.gcsPath, style: uc.style, label: uc.label })),
    qaAdvisories: qaAdvisories.slice(0, 40),
    warnings,
  };
}

module.exports = { runBookPipeline, PipelineError };
