/**
 * OpenAI flow — single-spread render + QA loop.
 *
 * Stateless contract: every render is one HTTP call. There is no chat history
 * to poison and no "session rebuild" — when QA rejects, we just rebuild the
 * prompt with correction directives and POST again. When OpenAI moderation
 * blocks, we soften the scene/caption (using the same helpers as the Gemini
 * path) and retry up to 2 times before giving up.
 *
 * Returns `{accepted, imageBuffer, imageBase64, attempts, qa, scene, caption,
 *           safetyMitigated, lastError}` so the caller can upload the image,
 * update its book document, and emit progress.
 */

'use strict';

const { renderSpread } = require('./render');
const { buildRulesBlock } = require('./rulesBlock');
const {
  buildSpreadTurn,
  buildCorrectionTurn,
  deescalateSceneForSignage,
  shouldDeescalateSceneForQaFail,
  compactSceneForImageSafetyRetry,
  softenSceneForImageSafetyRetry,
  softenCaptionForImageSafetyRetry,
  minimalSafeSceneFallback,
} = require('../prompt');
const { stripMetadata } = require('../postprocess/strip');
const { upscaleForPrint } = require('../postprocess/upscale');

/**
 * Per-spread retry budget. With Gemini we used 1 + 6 corrections + 2 session
 * rebuilds (≈21 attempts worst case) to compensate for chat-history fragility.
 * Stateless gpt-image-2 doesn't have that fragility, so 1 + 4 QA corrections
 * + 2 safety softens (≤7 total) is plenty.
 */
const MAX_QA_CORRECTIONS = 4;
const MAX_SAFETY_RETRIES = 2;

/**
 * @typedef {Object} ProcessSpreadOpts
 * @property {string} apiKey
 * @property {string} coverBase64
 * @property {string} [coverMime]
 * @property {string} [previousSpreadBase64] - Most recently accepted interior spread (continuity).
 * @property {string} [previousSpreadMime]
 * @property {object} rulesOpts - Forwarded to buildRulesBlock (theme, locationPalette, childAge, ...).
 * @property {object} spreadCtx - Forwarded to buildSpreadTurn (spreadIndex, scene, text, textSide, textCorner, theme, childAge).
 * @property {function} runQa - async ({imageBase64, expected, spreadIndex}) => qaResult
 *   The caller wires this to either checkSpread (new pipeline) or the legacy
 *   parallel verifySpreadText + checkSpreadConsistency setup.
 * @property {AbortSignal} [abortSignal]
 * @property {string} [logTag]
 */

/**
 * @param {ProcessSpreadOpts} opts
 * @returns {Promise<{
 *   accepted: boolean,
 *   imageBuffer: Buffer,
 *   imageBase64: string,
 *   printable: Buffer,
 *   printableBase64: string,
 *   attempts: number,
 *   qa: object,
 *   scene: string,
 *   caption: string,
 *   safetyMitigated: boolean,
 *   lastError: Error|null,
 * }>}
 */
async function processSpread(opts) {
  const {
    apiKey,
    coverBase64,
    coverMime,
    previousSpreadBase64,
    previousSpreadMime,
    rulesOpts,
    spreadCtx,
    runQa,
    abortSignal,
    logTag = 'openaiFlow',
  } = opts;

  const baselineCaption = typeof spreadCtx.text === 'string' ? spreadCtx.text : '';
  const baselineScene = String(spreadCtx.scene || '');
  let scene = baselineScene;
  let renderCaption = baselineCaption;
  let safetyRetries = 0;
  let qaCorrections = 0;
  let attempts = 0;
  let lastQa = null;
  let lastImage = null;
  let lastPrintable = null;
  let lastError = null;
  let safetyMitigated = false;

  while (true) {
    if (abortSignal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    attempts += 1;

    const isFirst = qaCorrections === 0;
    const promptBody = isFirst
      ? buildSpreadTurn({
        ...spreadCtx,
        scene,
        text: renderCaption,
      })
      : buildCorrectionTurn({
        ...spreadCtx,
        scene,
        text: renderCaption,
        issues: lastQa?.issues || ['Fix the previous attempt.'],
        tags: lastQa?.tags || [],
      });

    const promptText = composePrompt({
      rulesBlock: buildRulesBlock(rulesOpts),
      spreadBody: promptBody,
      hasPreviousSpread: !!previousSpreadBase64,
    });

    let rendered;
    try {
      rendered = await renderSpread({
        apiKey,
        promptText,
        refs: {
          coverBase64,
          coverMime,
          previousSpreadBase64,
          previousSpreadMime,
        },
        signal: abortSignal,
        spreadIndex: spreadCtx.spreadIndex,
      });
    } catch (err) {
      lastError = err;
      if (err.isSafetyBlock && safetyRetries < MAX_SAFETY_RETRIES) {
        safetyRetries += 1;
        safetyMitigated = true;
        scene = applySafetySoftening(scene, baselineScene, safetyRetries, spreadCtx);
        if (safetyRetries === MAX_SAFETY_RETRIES) {
          renderCaption = softenCaptionForImageSafetyRetry(baselineCaption);
        }
        console.warn(
          `[${logTag}] safety block — softening (pass ${safetyRetries}/${MAX_SAFETY_RETRIES}): ${err.message.slice(0, 140)}`,
        );
        continue;
      }
      // Non-safety render error → bubble up; orchestrator decides whether to retry the whole spread.
      console.error(`[${logTag}] render error on attempt ${attempts}: ${err.message}`);
      throw err;
    }

    const stripped = await stripMetadata(rendered.imageBuffer);
    const printable = await upscaleForPrint(stripped);
    const printableBase64 = printable.toString('base64');
    lastImage = rendered;
    lastPrintable = { buffer: printable, base64: printableBase64 };

    const qa = await runQa({
      imageBase64: printableBase64,
      expected: { text: renderCaption, side: spreadCtx.textSide },
      spreadIndex: spreadCtx.spreadIndex,
    });
    lastQa = qa;

    if (qa.pass) {
      console.log(
        `[${logTag}] ACCEPTED spread ${spreadCtx.spreadIndex + 1} on attempt ${attempts} ` +
        `(qaCorrections=${qaCorrections}, safetyRetries=${safetyRetries})`,
      );
      return {
        accepted: true,
        imageBuffer: rendered.imageBuffer,
        imageBase64: rendered.imageBase64,
        printable,
        printableBase64,
        attempts,
        qa,
        scene,
        caption: renderCaption,
        safetyMitigated,
        lastError: null,
      };
    }

    if (qaCorrections >= MAX_QA_CORRECTIONS) {
      console.warn(
        `[${logTag}] EXHAUSTED ${MAX_QA_CORRECTIONS} QA corrections on spread ${spreadCtx.spreadIndex + 1} ` +
        `(tags=[${(qa.tags || []).join(',')}])`,
      );
      return {
        accepted: false,
        imageBuffer: rendered.imageBuffer,
        imageBase64: rendered.imageBase64,
        printable,
        printableBase64,
        attempts,
        qa,
        scene,
        caption: renderCaption,
        safetyMitigated,
        lastError: null,
      };
    }

    qaCorrections += 1;
    if (shouldDeescalateSceneForQaFail(qa.tags, scene)) {
      const next = deescalateSceneForSignage(scene);
      if (next !== scene) {
        console.log(`[${logTag}] de-escalating scene for next attempt (signage tags)`);
        scene = next;
      }
    }
    console.warn(
      `[${logTag}] REJECTED spread ${spreadCtx.spreadIndex + 1} attempt ${attempts}: ` +
      `tags=[${(qa.tags || []).join(',')}] issues=${(qa.issues || []).slice(0, 2).join(' | ').slice(0, 240)}`,
    );
  }
}

/**
 * Layered safety softening, mirroring the Gemini path's `safetyMitigationPass`
 * tiers in `bookPipeline/illustrator/renderAllSpreads.js` but compressed since
 * we can't rebuild a session here.
 *   - pass 1: strip duplicate policy from the scene + phrase soften
 *   - pass 2: minimal-safe scene fallback (last resort before giving up)
 */
function applySafetySoftening(currentScene, baselineScene, pass, spreadCtx) {
  if (pass === 1) {
    const compacted = compactSceneForImageSafetyRetry(baselineScene);
    return compacted !== baselineScene.trim()
      ? compacted
      : softenSceneForImageSafetyRetry(currentScene);
  }
  return minimalSafeSceneFallback(spreadCtx.spreadIndex, spreadCtx.theme);
}

/**
 * Combine the slim rules block and per-spread prompt body. The reference-
 * image labels match what gpt-image-2 sees in the `image[]` payload.
 */
function composePrompt({ rulesBlock, spreadBody, hasPreviousSpread }) {
  const refsNote = hasPreviousSpread
    ? 'REFERENCE 1 = approved BOOK COVER (canonical hero face/hair/skin/outfit + Pixar 3D style). REFERENCE 2 = previously approved interior spread from this same book (continuity for outfit, palette, lighting). Match both exactly.'
    : 'REFERENCE 1 = approved BOOK COVER (canonical hero face/hair/skin/outfit + Pixar 3D style). Match it exactly.';

  return [
    '=== REFERENCES ===',
    refsNote,
    '',
    '=== RULES ===',
    rulesBlock,
    '',
    '=== THIS SPREAD ===',
    spreadBody,
  ].join('\n');
}

module.exports = {
  processSpread,
  MAX_QA_CORRECTIONS,
  MAX_SAFETY_RETRIES,
};
