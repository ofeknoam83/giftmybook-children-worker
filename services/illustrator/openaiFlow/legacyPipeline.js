/**
 * OpenAI flow — entries-array (legacy) generateBookIllustrations + regenerateSpreadIllustration.
 *
 * Replacement for the public functions in `services/illustrator/index.js` when
 * `MODELS.SPREAD_RENDER` is `gpt-image-2`. Same call signature, same return
 * shape (entries with `spreadIllustrationUrl` set on every spread; regen
 * returns `{imageBuffer}`), so server.js callers don't need to change.
 *
 * Differences from the Gemini path:
 *   - no chat session, no establishCharacterReference
 *   - no sliding-window of 3 accepted spreads — only the cover + the most
 *     recently accepted spread travel as references on the next render
 *   - no session rebuilds — safety blocks are mitigated by softening the
 *     scene/caption (same helpers as Gemini) inside processSpread
 */

'use strict';

const { processSpread } = require('./processSpread');
const { uploadBuffer, getSignedUrl } = require('../../gcsStorage');
const { verifySpreadText } = require('../textQa');
const { checkSpreadConsistency } = require('../consistencyQa');
const { TOTAL_SPREADS, defaultTextSide } = require('../config');

const SIGNED_URL_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Stitch legacy left/right halves into the new single-passage form. Mirrors
 * the helper of the same name in the Gemini `services/illustrator/index.js`.
 */
function mergeSpreadText(entry) {
  const parts = [entry?.left?.text, entry?.right?.text]
    .filter((s) => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.trim());
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Build the QA runner for the legacy entries pipeline. Runs textQa and
 * consistencyQa in parallel (same shape the Gemini path uses) and merges
 * verdicts into the `{pass, issues, tags}` envelope `processSpread` expects.
 */
function makeLegacyRunQa({
  coverBase64,
  hasSecondaryOnCover,
  characterDescription,
  childPhotoBase64,
  qaAllowedHumansNote,
  previousSpreadBase64,
  previousSpreadMime,
  abortSignal,
}) {
  return async ({ imageBase64, expected, spreadIndex }) => {
    const [textResult, consistencyResult] = await Promise.all([
      verifySpreadText(imageBase64, expected, { spreadIndex, abortSignal }),
      checkSpreadConsistency(imageBase64, coverBase64, {
        hasSecondaryOnCover,
        abortSignal,
        characterDescription,
        childPhotoBase64: childPhotoBase64 || null,
        qaAllowedHumansNote,
        previousSpreadBase64: previousSpreadBase64 || null,
        previousSpreadMime: previousSpreadMime || null,
      }),
    ]);

    const issues = [
      ...(textResult.issues || []),
      ...(consistencyResult.issues || []),
    ];
    const tags = [
      ...(textResult.tags || []),
      ...(consistencyResult.tags || []),
    ];
    const infra = !!(textResult.infra || consistencyResult.infra);
    return {
      pass: issues.length === 0,
      issues,
      tags: [...new Set(tags)],
      infra,
      text: textResult,
      consistency: consistencyResult,
    };
  };
}

/**
 * Public entry — generate illustrations for a story-plan entries array.
 *
 * @param {object} opts - Identical to the Gemini path's generateBookIllustrations.
 * @returns {Promise<Array<object>>}
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

  if (!coverBase64) {
    throw new Error('generateBookIllustrations (openaiFlow): coverBase64 is required');
  }
  if (!Array.isArray(entries)) {
    throw new Error('generateBookIllustrations (openaiFlow): entries array is required');
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('generateBookIllustrations (openaiFlow): OPENAI_API_KEY is required for gpt-image-2');
  }

  const childAge = childAgeFromOpts ?? storyPlan?.childAge ?? storyPlan?.age ?? null;
  const log = (level, msg, meta) => {
    if (bookContext?.log) bookContext.log(level, `[illustrator/openaiFlow] ${msg}`, meta);
    else console.log(`[illustrator/openaiFlow] ${msg}`);
  };

  const spreadEntries = entries.filter((e) => e.type === 'spread');
  log('info', `Starting illustration generation for ${spreadEntries.length} spreads (book=${bookId || '?'})`);

  const hasSecondaryOnCover = !!coverParentPresent || !!(additionalCoverCharacters && String(additionalCoverCharacters).trim());
  const qaAllowedHumansNote = typeof storyPlan?.illustrationPolicy?.qaAllowedHumansNote === 'string'
    ? storyPlan.illustrationPolicy.qaAllowedHumansNote.trim()
    : '';

  const existingByIndex = new Map();
  for (const ex of existingIllustrations || []) {
    if (ex?.type === 'spread' && ex.spread && ex.spreadIllustrationUrl) {
      existingByIndex.set(ex.spread, ex.spreadIllustrationUrl);
    }
  }

  const updatedEntries = entries.map((e) => ({ ...e }));
  const reportProgress = (fraction, msg) => {
    if (typeof onProgress === 'function') {
      try { onProgress(fraction, msg); } catch (_) { /* swallow */ }
    }
  };

  let completedSpreadCount = 0;
  const totalForProgress = spreadEntries.length;
  let previousSpreadBase64 = null;
  let previousSpreadMime = 'image/jpeg';
  let spreadEntryCount = 0;

  // Checkpoint resume: hydrate the previous-spread reference from the most
  // recent existing illustration so the very next render still has continuity.
  if (existingByIndex.size > 0) {
    const priorSpreadNumbers = [...existingByIndex.keys()].sort((a, b) => a - b);
    const lastNumber = priorSpreadNumbers[priorSpreadNumbers.length - 1];
    const url = existingByIndex.get(lastNumber);
    try {
      const resp = await fetch(url, { signal: abortSignal || bookContext?.abortController?.signal || undefined });
      if (resp.ok) {
        const buf = Buffer.from(await resp.arrayBuffer());
        previousSpreadBase64 = buf.toString('base64');
        const ct = (resp.headers.get('content-type') || '').toLowerCase();
        previousSpreadMime = ct.includes('png') ? 'image/png' : 'image/jpeg';
        log('info', `Checkpoint resume: hydrated continuity reference from spread ${lastNumber}`);
      }
    } catch (e) {
      log('warn', `Checkpoint resume: could not hydrate prior spread (${e.message})`);
    }
  }

  for (let i = 0; i < updatedEntries.length; i++) {
    bookContext?.checkAbort?.();
    const entry = updatedEntries[i];
    if (entry.type !== 'spread') continue;

    spreadEntryCount += 1;
    const spreadNumber = Number.isInteger(entry.spread) ? entry.spread : spreadEntryCount;
    const spreadIndex = spreadNumber - 1;

    const existingUrl = existingByIndex.get(spreadNumber);
    if (existingUrl) {
      log('info', `Spread ${spreadNumber} already illustrated (checkpoint) — skipping`);
      entry.spreadIllustrationUrl = existingUrl;
      completedSpreadCount += 1;
      reportProgress(completedSpreadCount / totalForProgress, `Spread ${spreadNumber}/${totalForProgress} (from checkpoint)`);
      continue;
    }

    reportProgress(completedSpreadCount / totalForProgress, `Generating spread ${spreadNumber}/${totalForProgress}`);

    const scene = entry.spread_image_prompt || entry.spreadImagePrompt || '';
    const text = mergeSpreadText(entry);
    const textSide = (entry.textSide === 'left' || entry.textSide === 'right')
      ? entry.textSide
      : defaultTextSide(spreadIndex);

    const rulesOpts = {
      theme,
      hasParentOnCover: coverParentPresent === true,
      hasSecondaryOnCover,
      additionalCoverCharacters,
      parentOutfit: storyPlan?.parentOutfit || null,
      childAppearance,
      locationPalette: storyPlan?.locationPalette || null,
      childAge,
    };

    const spreadCtx = {
      spreadIndex,
      totalSpreads: TOTAL_SPREADS,
      scene,
      text,
      textSide,
      theme,
      hasSecondaryOnCover,
      coverParentPresent: coverParentPresent === true,
      additionalCoverCharacters,
      characterOutfit: storyPlan?.characterOutfit,
      characterDescription: storyPlan?.characterDescription,
      childAge,
    };

    const runQa = makeLegacyRunQa({
      coverBase64,
      hasSecondaryOnCover,
      characterDescription: storyPlan?.characterDescription,
      childPhotoBase64: childPhotoFromOpts || null,
      qaAllowedHumansNote,
      previousSpreadBase64,
      previousSpreadMime,
      abortSignal: abortSignal || bookContext?.abortController?.signal || null,
    });

    let result;
    try {
      result = await processSpread({
        apiKey,
        coverBase64,
        coverMime,
        previousSpreadBase64,
        previousSpreadMime,
        rulesOpts,
        spreadCtx,
        runQa,
        abortSignal: abortSignal || bookContext?.abortController?.signal || null,
        logTag: `illustrator/openaiFlow:${bookId || '?'}:spread${spreadNumber}`,
      });
    } catch (err) {
      log('error', `Spread ${spreadNumber} failed permanently: ${err.message}`);
      throw new Error(`Illustrator (openaiFlow): spread ${spreadNumber} failed — ${err.message}`);
    }

    if (!result.accepted) {
      const tags = (result.qa?.tags || []).join(',');
      throw new Error(`Illustrator (openaiFlow): spread ${spreadNumber} unresolvable (tags=[${tags}])`);
    }

    const gcsPath = `children-jobs/${bookId || 'unknown'}/illustrations/spread-${spreadIndex}-${Date.now()}.png`;
    await uploadBuffer(result.printable, gcsPath, 'image/png');
    const url = await getSignedUrl(gcsPath, SIGNED_URL_TTL_MS);
    entry.spreadIllustrationUrl = url;

    // Roll the continuity reference forward using the accepted/stored printable output.
    previousSpreadBase64 =
      typeof result.printableBase64 === 'string' && result.printableBase64.length > 0
        ? result.printableBase64
        : result.printable.toString('base64');
    previousSpreadMime = 'image/png';

    completedSpreadCount += 1;
    log('info', `Spread ${spreadNumber}/${spreadEntries.length} complete (attempts=${result.attempts})`);
    reportProgress(completedSpreadCount / totalForProgress, `Spread ${spreadNumber}/${totalForProgress} complete`);
  }

  log('info', `All ${spreadEntries.length} spreads generated via openaiFlow.`);
  return updatedEntries;
}

/**
 * Public entry — single-spread regenerate (admin endpoint).
 *
 * @param {object} opts - Same shape as the Gemini path's regenerateSpreadIllustration.
 * @returns {Promise<{ imageBuffer: Buffer }>}
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

  if (!coverBase64) throw new Error('regenerateSpreadIllustration (openaiFlow): coverBase64 is required');
  if (!scenePrompt) throw new Error('regenerateSpreadIllustration (openaiFlow): scenePrompt is required');

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('regenerateSpreadIllustration (openaiFlow): OPENAI_API_KEY is required');

  const text = (typeof explicitText === 'string' && explicitText.trim())
    ? explicitText.trim()
    : [leftText, rightText].filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()).join(' ').replace(/\s+/g, ' ').trim();
  const textSide = (explicitSide === 'left' || explicitSide === 'right') ? explicitSide : defaultTextSide(spreadIndex);
  const hasSecondaryOnCover = !!coverParentPresent || !!(additionalCoverCharacters && String(additionalCoverCharacters).trim());

  const rulesOpts = {
    theme,
    hasParentOnCover: coverParentPresent === true,
    hasSecondaryOnCover,
    additionalCoverCharacters,
    parentOutfit,
    childAppearance,
    locationPalette,
    childAge: childAge != null ? childAge : null,
  };

  const spreadCtx = {
    spreadIndex,
    totalSpreads,
    scene: scenePrompt,
    text,
    textSide,
    theme,
    hasSecondaryOnCover,
    coverParentPresent: coverParentPresent === true,
    additionalCoverCharacters,
    characterOutfit,
    characterDescription,
    childAge: childAge != null ? childAge : null,
  };

  const runQa = makeLegacyRunQa({
    coverBase64,
    hasSecondaryOnCover,
    characterDescription,
    childPhotoBase64: null,
    qaAllowedHumansNote: typeof qaAllowedHumansNote === 'string' ? qaAllowedHumansNote.trim() : '',
    previousSpreadBase64: null,
    previousSpreadMime: null,
    abortSignal: null,
  });

  const result = await processSpread({
    apiKey,
    coverBase64,
    coverMime,
    previousSpreadBase64: null,
    previousSpreadMime: null,
    rulesOpts,
    spreadCtx,
    runQa,
    abortSignal: null,
    logTag: `illustrator/openaiFlow:regen:spread${(spreadIndex || 0) + 1}`,
  });

  if (!result.accepted) {
    const tags = (result.qa?.tags || []).join(',');
    throw new Error(`regenerateSpreadIllustration (openaiFlow): unresolvable (tags=[${tags}])`);
  }
  return { imageBuffer: result.printable };
}

module.exports = {
  generateBookIllustrations,
  regenerateSpreadIllustration,
};
