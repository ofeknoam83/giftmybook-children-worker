/**
 * Illustrator — Picture-book Illustration Module (PUBLIC API)
 *
 * Orchestrates generation of the 13 spread illustrations for a children's
 * picture book. This is the single entry point the rest of the codebase
 * should use for picture-book illustrations.
 *
 * Flow (per book):
 *   1. createSession + establishCharacterReference from the approved cover.
 *   2. For each spread in order:
 *      a. generateSpread with the per-spread prompt.
 *      b. stripMetadata + upscaleForPrint.
 *      c. Run text QA + consistency QA (stateless, in parallel).
 *      d. If both pass → markSpreadAccepted + upload to GCS.
 *      e. If any fails → sendCorrection with the issues (up to MAX_SPREAD_CORRECTIONS in-session retries per session).
 *      f. If a safety block fires and we haven't rebuilt yet → rebuildSession, retry once.
 *      g. If we exhaust the budget → hard fail the book.
 *
 * Return: the input `entries` array with `spreadIllustrationUrl` attached to
 * every spread entry (matching the previous engine contract).
 */

const {
  TOTAL_SPREADS,
  MAX_SPREAD_CORRECTIONS,
  MAX_SESSION_REBUILDS,
  PARENT_THEMES,
  defaultTextSide,
  SAFETY_STRIKES_BEFORE_SCENE_DEESCAL,
} = require('./config');
const {
  createSession,
  establishCharacterReference,
  generateSpread,
  sendCorrection,
  markSpreadAccepted,
  pruneLastTurn,
  rebuildSession,
  seedHistoryFromAccepted,
} = require('./session');
const {
  buildSpreadTurn,
  buildCorrectionTurn,
  deescalateSceneForSignage,
  shouldDeescalateSceneForQaFail,
} = require('./prompt');
const { verifySpreadText } = require('./textQa');
const { checkSpreadConsistency } = require('./consistencyQa');
const { stripMetadata } = require('./postprocess/strip');
const { upscaleForPrint } = require('./postprocess/upscale');
const { uploadBuffer, getSignedUrl } = require('../gcsStorage');

const SIGNED_URL_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * @typedef {Object} SpreadEntry
 * @property {string} type - 'spread' for spreads; anything else is passed through untouched.
 * @property {number} [spread] - 1-based spread index in the story.
 * @property {string} [spread_image_prompt] - Scene description for the illustration.
 * @property {{text?: string}} [left]
 * @property {{text?: string}} [right]
 * @property {string} [spreadIllustrationUrl] - Set by this module on success.
 */

/**
 * @typedef {Object} GenerateBookIllustrationsOpts
 * @property {Array<SpreadEntry>} entries - Story plan entries (this module only generates for entries of type 'spread').
 * @property {object} storyPlan - Full story plan (reads theme-level locks: parentOutfit, characterOutfit).
 * @property {string} coverBase64 - Approved cover (character + style ground truth). REQUIRED.
 * @property {string} [coverMime='image/jpeg']
 * @property {string} [theme]
 * @property {boolean} coverParentPresent - True if the themed parent is on the cover.
 * @property {string} [additionalCoverCharacters] - Description of any non-child person on the cover.
 * @property {string} [childAppearance]
 * @property {string} [bookId]
 * @property {object} [bookContext] - Must expose .log(level, msg, meta?) and .checkAbort() + .abortController.signal.
 * @property {object} [costTracker] - Optional cost tracker with .addIllustration() and similar — this module logs turn counts.
 * @property {Array<SpreadEntry>} [existingIllustrations] - Checkpoint data — spreads already generated are skipped.
 * @property {function(number, string):void} [onProgress] - Optional progress callback: (fraction0to1, message).
 * @property {AbortSignal} [abortSignal]
 * @property {string} [childPhotoBase64] - Optional real child photo (JPEG base64) for consistency QA disambiguation only.
 * @property {number|string|null} [childAge] - Under 3: top-only caption corners + infant margins; 3–8: compact tier; inferred from storyPlan when omitted.
 */

/**
 * Generate illustrations for every spread in the book.
 *
 * @param {GenerateBookIllustrationsOpts} opts
 * @returns {Promise<Array<SpreadEntry>>} Same entries, with spreadIllustrationUrl set on every spread.
 */
async function generateBookIllustrations(opts) {
  const {
    entries,
    storyPlan,
    coverBase64,
    coverMime = 'image/jpeg',
    theme,
    coverParentPresent,
    additionalCoverCharacters,
    childAppearance,
    bookId,
    bookContext,
    existingIllustrations = [],
    onProgress,
    abortSignal,
    childPhotoBase64: childPhotoFromOpts,
    childAge: childAgeFromOpts,
  } = opts;

  const childAge = childAgeFromOpts ?? storyPlan?.childAge ?? storyPlan?.age ?? null;

  if (!coverBase64) {
    throw new Error('generateBookIllustrations: coverBase64 (approved cover) is required');
  }
  if (!Array.isArray(entries)) {
    throw new Error('generateBookIllustrations: entries array is required');
  }

  const log = (level, msg, meta) => {
    if (bookContext?.log) bookContext.log(level, `[illustrator] ${msg}`, meta);
    else console.log(`[illustrator] ${msg}`);
  };

  const spreadEntries = entries.filter(e => e.type === 'spread');
  log('info', `Starting illustration generation for ${spreadEntries.length} spreads (book=${bookId || '?'})`);

  const hasSecondaryOnCover = !!coverParentPresent || !!(additionalCoverCharacters && String(additionalCoverCharacters).trim());
  const qaAllowedHumansNote = typeof storyPlan?.illustrationPolicy?.qaAllowedHumansNote === 'string'
    ? storyPlan.illustrationPolicy.qaAllowedHumansNote.trim()
    : '';
  const session = await _openSession({
    coverBase64,
    coverMime,
    theme,
    hasParentOnCover: coverParentPresent === true,
    hasSecondaryOnCover,
    additionalCoverCharacters,
    parentOutfit: storyPlan?.parentOutfit,
    childAppearance,
    childAge,
    locationPalette: storyPlan?.locationPalette,
    abortSignal: abortSignal || bookContext?.abortController?.signal || null,
  });
  let activeSession = session;

  const existingByIndex = new Map();
  for (const ex of existingIllustrations || []) {
    if (ex?.type === 'spread' && ex.spread && ex.spreadIllustrationUrl) {
      existingByIndex.set(ex.spread, ex.spreadIllustrationUrl);
    }
  }

  // Checkpoint resume continuity: if prior spreads are already approved, fetch
  // the last few images and seed them into the session history so the sliding
  // window still has real continuity references. Best-effort — failures just
  // fall back to "cover only" continuity.
  if (existingByIndex.size > 0) {
    const totalSpreadCount = spreadEntries.length;
    const priorSpreadNumbers = [...existingByIndex.keys()].sort((a, b) => a - b);
    const tail = priorSpreadNumbers.slice(-3); // matches SLIDING_WINDOW_ACCEPTED_SPREADS
    const seeds = [];
    for (const spreadNumber of tail) {
      const url = existingByIndex.get(spreadNumber);
      try {
        const resp = await fetch(url, { signal: abortSignal || bookContext?.abortController?.signal || undefined });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());
        seeds.push({ index: spreadNumber - 1, imageBase64: buf.toString('base64') });
      } catch (e) {
        log('warn', `Could not seed continuity for spread ${spreadNumber} (${e.message}) — skipping`);
      }
    }
    if (seeds.length > 0) {
      seedHistoryFromAccepted(activeSession, seeds);
      for (const s of seeds) markSpreadAccepted(activeSession, s.index, s.imageBase64);
      log('info', `Resumed from checkpoint: seeded ${seeds.length}/${tail.length} prior spread(s) of ${existingByIndex.size} accepted, out of ${totalSpreadCount} total`);
    }
  }

  const updatedEntries = entries.map(e => ({ ...e }));
  const reportProgress = (fraction, msg) => {
    if (typeof onProgress === 'function') {
      try { onProgress(fraction, msg); } catch (_) { /* callback errors must not break generation */ }
    }
  };

  let completedSpreadCount = 0;
  const totalForProgress = spreadEntries.length;

  for (let i = 0; i < updatedEntries.length; i++) {
    bookContext?.checkAbort?.();
    const entry = updatedEntries[i];
    if (entry.type !== 'spread') continue;

    const spreadNumber = entry.spread || (spreadEntries.indexOf(entry) + 1);
    const spreadIndex = spreadNumber - 1; // 0-based for prompts + QA

    // Skip spreads that already have an illustration from a prior run (checkpoint).
    const existingUrl = existingByIndex.get(spreadNumber);
    if (existingUrl) {
      log('info', `Spread ${spreadNumber} already illustrated (checkpoint) — skipping`);
      entry.spreadIllustrationUrl = existingUrl;
      completedSpreadCount++;
      reportProgress(completedSpreadCount / totalForProgress, `Spread ${spreadNumber}/${totalForProgress} (from checkpoint)`);
      continue;
    }

    reportProgress(completedSpreadCount / totalForProgress, `Generating spread ${spreadNumber}/${totalForProgress}`);

    const scene = entry.spread_image_prompt || entry.spreadImagePrompt || '';
    // Merge legacy left/right halves into a SINGLE caption — the new flow
    // renders one block on one side. entry.textSide wins if explicitly set.
    const text = mergeSpreadText(entry);
    const textSide = (entry.textSide === 'left' || entry.textSide === 'right')
      ? entry.textSide
      : defaultTextSide(spreadIndex);

    try {
      const { imageBuffer, imageBase64 } = await _generateSpreadWithQa(
        { getSession: () => activeSession, setSession: (s) => { activeSession = s; } },
        {
          spreadIndex,
          totalSpreads: TOTAL_SPREADS,
          scene,
          text,
          textSide,
          coverBase64,
          hasSecondaryOnCover,
          theme,
          characterOutfit: storyPlan?.characterOutfit,
          characterDescription: storyPlan?.characterDescription,
          childPhotoBase64: childPhotoFromOpts || null,
          coverParentPresent,
          additionalCoverCharacters,
          qaAllowedHumansNote,
          childAge,
          abortSignal: abortSignal || bookContext?.abortController?.signal || null,
          log,
        },
      );

      // Post-process + upload
      const printBuf = await upscaleForPrint(await stripMetadata(imageBuffer));
      const gcsPath = `children-jobs/${bookId || 'unknown'}/illustrations/spread-${spreadIndex}-${Date.now()}.png`;
      await uploadBuffer(printBuf, gcsPath, 'image/png');
      const url = await getSignedUrl(gcsPath, SIGNED_URL_TTL_MS);
      entry.spreadIllustrationUrl = url;

      // Mark accepted so the session sliding window keeps this spread as a
      // continuity reference for subsequent spreads.
      markSpreadAccepted(activeSession, spreadIndex, imageBase64);
      completedSpreadCount++;
      log('info', `Spread ${spreadNumber}/${spreadEntries.length} complete`);
      reportProgress(completedSpreadCount / totalForProgress, `Spread ${spreadNumber}/${totalForProgress} complete`);
    } catch (err) {
      log('error', `Spread ${spreadNumber} failed permanently: ${err.message}`);
      throw new Error(`Illustrator: spread ${spreadNumber} failed — ${err.message}`);
    }
  }

  log('info', `All ${spreadEntries.length} spreads generated. Session turns used: ${activeSession.turnsUsed}, rebuilds: ${activeSession.rebuilds}`);
  return updatedEntries;
}

/**
 * Regenerate a single spread. Used by the /regenerate-illustration endpoint.
 * Spins up a short-lived session so the cover is still used as the reference.
 *
 * @param {object} opts
 * @param {string} opts.scenePrompt
 * @param {string} [opts.text] - Full caption for the spread (preferred).
 * @param {'left'|'right'} [opts.textSide] - Side to render on. Defaults to alternation by spreadIndex.
 * @param {string} [opts.leftText] - LEGACY. Concatenated with rightText if text not given.
 * @param {string} [opts.rightText] - LEGACY. Concatenated with leftText if text not given.
 * @param {string} opts.coverBase64 - REQUIRED for the reference lock.
 * @param {string} [opts.coverMime]
 * @param {string} [opts.theme]
 * @param {boolean} [opts.coverParentPresent]
 * @param {string} [opts.additionalCoverCharacters]
 * @param {string} [opts.parentOutfit]
 * @param {string} [opts.childAppearance]
 * @param {string} [opts.characterOutfit] - From story plan; improves QA retry directives.
 * @param {string} [opts.characterDescription]
 * @param {number|string|null} [opts.childAge]
 * @param {number} opts.spreadIndex - 0-based
 * @param {number} [opts.totalSpreads]
 * @returns {Promise<{imageBuffer: Buffer}>}
 */
async function regenerateSpreadIllustration(opts) {
  const {
    scenePrompt,
    text: explicitText,
    textSide: explicitSide,
    leftText = '',
    rightText = '',
    coverBase64,
    coverMime = 'image/jpeg',
    theme,
    coverParentPresent,
    additionalCoverCharacters,
    qaAllowedHumansNote = '',
    parentOutfit,
    childAppearance,
    characterOutfit,
    characterDescription,
    locationPalette,
    childAge,
    spreadIndex,
    totalSpreads = TOTAL_SPREADS,
  } = opts;

  if (!coverBase64) throw new Error('regenerateSpreadIllustration: coverBase64 is required');
  if (!scenePrompt) throw new Error('regenerateSpreadIllustration: scenePrompt is required');

  const text = (typeof explicitText === 'string' && explicitText.trim())
    ? explicitText.trim()
    : mergeSpreadText({ left: { text: leftText }, right: { text: rightText } });
  const textSide = (explicitSide === 'left' || explicitSide === 'right')
    ? explicitSide
    : defaultTextSide(spreadIndex);

  const hasSecondaryOnCover = !!coverParentPresent || !!(additionalCoverCharacters && String(additionalCoverCharacters).trim());
  let session = await _openSession({
    coverBase64,
    coverMime,
    theme,
    hasParentOnCover: coverParentPresent === true,
    hasSecondaryOnCover,
    additionalCoverCharacters,
    parentOutfit,
    childAppearance,
    childAge: childAge != null ? childAge : null,
    locationPalette,
  });

  const log = (level, msg) => console.log(`[illustrator][regen] ${msg}`);
  const { imageBuffer } = await _generateSpreadWithQa(
    { getSession: () => session, setSession: (s) => { session = s; } },
    {
      spreadIndex,
      totalSpreads,
      scene: scenePrompt,
      text,
      textSide,
      coverBase64,
      hasSecondaryOnCover,
      theme,
      characterOutfit,
      characterDescription,
      childPhotoBase64: null,
      coverParentPresent,
      additionalCoverCharacters,
      qaAllowedHumansNote: typeof qaAllowedHumansNote === 'string' ? qaAllowedHumansNote.trim() : '',
      childAge: childAge != null ? childAge : null,
      abortSignal: null,
      log,
    },
  );

  const printBuf = await upscaleForPrint(await stripMetadata(imageBuffer));
  return { imageBuffer: printBuf };
}

/**
 * Concatenate legacy left + right halves into a single caption passage.
 * Strips empty halves and collapses whitespace so the model gets a clean string.
 */
function mergeSpreadText(entry) {
  const parts = [entry?.left?.text, entry?.right?.text]
    .filter(s => typeof s === 'string' && s.trim().length > 0)
    .map(s => s.trim());
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

async function _openSession(opts) {
  const session = createSession(opts);
  await establishCharacterReference(session);
  return session;
}

/**
 * Generate ONE spread through the full retry + QA loop. Mutates the active
 * session via the provided getter/setter so session rebuilds can swap it.
 *
 * @returns {Promise<{imageBuffer: Buffer, imageBase64: string}>}
 */
async function _generateSpreadWithQa(sessionRef, ctx) {
  const {
    spreadIndex,
    totalSpreads,
    scene,
    text,
    textSide,
    coverBase64,
    hasSecondaryOnCover,
    theme,
    characterOutfit,
    characterDescription,
    childPhotoBase64,
    coverParentPresent,
    additionalCoverCharacters,
    qaAllowedHumansNote = '',
    childAge,
    abortSignal,
    log,
  } = ctx;

  let rebuildsUsed = 0;
  let issues = [];
  let tags = [];
  let lastError = null;
  let activeScene = scene;
  let mixedStagedStep = 0;
  let safetyStrikesForSpread = 0;

  // Attempts per spread: 1 initial + MAX_SPREAD_CORRECTIONS corrections.
  const MAX_ATTEMPTS = 1 + MAX_SPREAD_CORRECTIONS;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const isFirst = attempt === 1;
    const session = sessionRef.getSession();

    let generated;
    try {
      const spreadCtx = {
        spreadIndex,
        totalSpreads,
        scene: activeScene,
        text,
        textSide,
        characterOutfit,
        characterDescription,
        theme,
        hasSecondaryOnCover,
        coverParentPresent,
        additionalCoverCharacters,
        childAge,
      };
      const promptText = isFirst
        ? buildSpreadTurn(spreadCtx)
        : buildCorrectionTurn({ ...spreadCtx, issues, tags });
      generated = isFirst
        ? await generateSpread(session, promptText, spreadIndex)
        : await sendCorrection(session, promptText, spreadIndex);
      safetyStrikesForSpread = 0;
    } catch (err) {
      lastError = err;
      // Safety block → rebuild session once, then retry without consuming an attempt budget.
      if (err.isSafetyBlock && rebuildsUsed < MAX_SESSION_REBUILDS) {
        safetyStrikesForSpread += 1;
        log('warn', `Spread ${spreadIndex + 1} attempt ${attempt}: safety block → rebuilding session`, {
          finishReason: err.finishReason,
          blockReason: err.blockReason,
          safetyRatings: err.safetyRatings,
          scenePreview: (activeScene || '').slice(0, 220),
          safetyStrikesForSpread,
        });
        if (safetyStrikesForSpread >= SAFETY_STRIKES_BEFORE_SCENE_DEESCAL) {
          activeScene = deescalateSceneForSignage(activeScene);
        }
        const newSession = await rebuildSession(session);
        sessionRef.setSession(newSession);
        rebuildsUsed++;
        // Treat as "retry attempt 1" — we want the initial prompt again after rebuild.
        attempt = 0; // the loop increments to 1 on the next iteration
        issues = [];
        tags = [];
        mixedStagedStep = 0;
        continue;
      }
      log('warn', `Spread ${spreadIndex + 1} attempt ${attempt} failed: ${err.message}`);
      if (attempt === MAX_ATTEMPTS) {
        // Exhausted in-session attempts on a generation error — refresh session and try again if budget remains.
        if (rebuildsUsed < MAX_SESSION_REBUILDS) {
          log('warn', `Spread ${spreadIndex + 1}: generation error on final attempt — rebuilding session and retrying`, {
            finishReason: err.finishReason,
            blockReason: err.blockReason,
            scenePreview: (activeScene || '').slice(0, 220),
          });
          if (err.isSafetyBlock) {
            activeScene = deescalateSceneForSignage(activeScene);
          }
          const newSession = await rebuildSession(session);
          sessionRef.setSession(newSession);
          rebuildsUsed++;
          attempt = 0;
          issues = [];
          tags = [];
          mixedStagedStep = 0;
          continue;
        }
        throw err;
      }
      // Empty/other non-safety errors → retry as a correction with a soft note.
      issues = [err.message];
      continue;
    }

    // ── QA (both checks in parallel) ──
    const [textResult, consistencyResult] = await Promise.all([
      verifySpreadText(generated.imageBase64, { text, side: textSide }, { spreadIndex, abortSignal }),
      checkSpreadConsistency(generated.imageBase64, coverBase64, {
        hasSecondaryOnCover,
        abortSignal,
        characterDescription,
        childPhotoBase64: childPhotoBase64 || null,
        qaAllowedHumansNote,
      }),
    ]);

    const qaInfraFailure = !!(textResult.infra || consistencyResult.infra);
    const bothPass = textResult.pass && consistencyResult.pass;

    if (bothPass) {
      log('info', `Spread ${spreadIndex + 1} attempt ${attempt}: QA passed`);
      return generated;
    }

    // Fail-open on infra errors so we don't kill the book over a QA outage — but only once all rebuild budget is spent.
    if (qaInfraFailure && attempt === MAX_ATTEMPTS && rebuildsUsed >= MAX_SESSION_REBUILDS) {
      log('warn', `Spread ${spreadIndex + 1}: QA infra error on final attempt — accepting generated image (${[textResult, consistencyResult].filter(r => r.infra).map(r => r.issues[0]).join('; ')})`);
      return generated;
    }

    const textFailed = !textResult.pass;
    const charFailed = !consistencyResult.pass;
    if (textFailed && charFailed && mixedStagedStep === 0) {
      issues = [...(textResult.issues || [])];
      tags = [...(textResult.tags || [])];
      mixedStagedStep = 1;
    } else {
      issues = [...(textResult.issues || []), ...(consistencyResult.issues || [])];
      tags = [...(textResult.tags || []), ...(consistencyResult.tags || [])];
    }

    if (shouldDeescalateSceneForQaFail(tags, activeScene)) {
      const next = deescalateSceneForSignage(activeScene);
      if (next !== activeScene) {
        log('info', `Spread ${spreadIndex + 1}: de-escalating scene (stricter in-world text ban for next attempt)`);
        activeScene = next;
      }
    }

    log('warn', `Spread ${spreadIndex + 1} attempt ${attempt} QA failed (tags=${tags.join(',')}): ${issues.slice(0, 3).join(' | ')}`);
    lastError = new Error(`QA failed: ${issues.slice(0, 2).join(' | ')}`);

    // Prune the rejected user+model exchange from history before the next
    // correction attempt. Otherwise the bad image remains as the most-recent
    // model turn and Gemini treats it as the canonical prior render — so
    // artifacts like stray "I LOVE MAMA" text bleed forward into retries.
    // This enforces the contract stated at session.js:11-13.
    pruneLastTurn(sessionRef.getSession());

    // QA exhausted all in-session attempts → refresh the session and try again with a fresh round (1 + MAX_SPREAD_CORRECTIONS attempts).
    if (attempt === MAX_ATTEMPTS && rebuildsUsed < MAX_SESSION_REBUILDS) {
      log('warn', `Spread ${spreadIndex + 1}: QA exhausted after ${MAX_ATTEMPTS} attempts — rebuilding session and retrying`);
      const newSession = await rebuildSession(sessionRef.getSession());
      sessionRef.setSession(newSession);
      rebuildsUsed++;
      attempt = 0;
      issues = [];
      tags = [];
      mixedStagedStep = 0;
      continue;
    }
  }

  throw lastError || new Error(`Spread ${spreadIndex + 1} exhausted retry budget`);
}

module.exports = {
  generateBookIllustrations,
  regenerateSpreadIllustration,
  PARENT_THEMES,
};
