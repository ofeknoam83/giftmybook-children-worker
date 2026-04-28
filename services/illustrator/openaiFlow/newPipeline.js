/**
 * OpenAI flow — bookPipeline (`doc`-driven) renderAllSpreads.
 *
 * Replacement for `services/bookPipeline/illustrator/renderAllSpreads.js` when
 * `MODELS.SPREAD_RENDER` is `gpt-image-2`. Same input (canonical book document)
 * and same output (mutated document with each spread's `illustration` block
 * filled in) so downstream stages (validateAllIllustrations, layout, cover
 * harmonize) work without changes.
 *
 * Compared to the Gemini doc-pipeline orchestrator this drops:
 *   - createSession / establishCharacterReference / rebuildSession
 *   - LATE_SPREAD_COVER_REANCHOR_INDEX and per-attempt re-anchor toggles
 *   - transient empty-image retries with backoff (gpt-image-2 doesn't have IMAGE_OTHER)
 *   - extra-session-rounds escalation
 *
 * What it keeps:
 *   - the spread spec builder (`buildIllustrationSpec`) — unchanged
 *   - the QA pipeline (`checkSpread`) — unchanged
 *   - retry-memory + per-spread doc updates via `updateSpread / appendRetryMemory`
 *   - acceptedWithRisk gate behind `ILLUSTRATION_QA_ACCEPT_ON_EXHAUSTION=1`
 */

'use strict';

const sharp = require('sharp');

const { processSpread } = require('./processSpread');
const { uploadBuffer, getSignedUrl, downloadBuffer } = require('../../gcsStorage');
const { checkSpread } = require('../../bookPipeline/qa/checkSpread');
const { planSpreadRepair } = require('../../bookPipeline/qa/planRepair');
const { buildIllustrationSpec } = require('../../bookPipeline/illustrator/buildIllustrationSpec');
const { REPAIR_BUDGETS, FAILURE_CODES } = require('../../bookPipeline/constants');
const { updateSpread, appendRetryMemory } = require('../../bookPipeline/schema/bookDocument');

const SIGNED_URL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Last-resort accept gate (mirrors Gemini path). Off by default; set
 * `ILLUSTRATION_QA_ACCEPT_ON_EXHAUSTION=1` to allow soft-failure spreads to
 * complete the book rather than hard-fail.
 *
 * @param {object} qa
 */
function canAcceptSpreadAfterExhaustionGate(qa) {
  const v = process.env.ILLUSTRATION_QA_ACCEPT_ON_EXHAUSTION;
  if (v !== '1' && v !== 'true') return false;
  if (!qa || qa.pass) return false;
  const tags = qa.tags || [];
  const forbidden = [
    'style_drift', 'split_panel', 'duplicated_hero', 'body_disconnected',
    'bath_modesty', 'unexpected_person', 'disembodied_limb', 'parent_turned_away',
    'recurring_item_drift', 'qa_unavailable', 'hero_mismatch', 'outfit_mismatch',
    'implied_parent_skin_mismatch',
  ];
  if (forbidden.some((t) => tags.includes(t))) return false;
  if (qa.consistency?.artStyleIs3DPixar !== true) return false;
  return true;
}

/**
 * Resolve the cover as base64 — accepts either an inlined payload, a GCS key,
 * or an image URL. Resized to 1024px to match the Gemini path's "enough detail
 * to lock face features without bloating tokens" rule.
 */
async function resolveCoverBase64(cover) {
  if (cover.imageBase64) {
    return { base64: cover.imageBase64, mime: cover.coverMime || 'image/jpeg' };
  }
  const storageKey = cover.imageStorageKey || cover.gcsPath;
  let buf;
  if (storageKey) {
    try {
      buf = await downloadBuffer(storageKey);
    } catch (e) {
      throw new Error(`cover GCS download failed (${storageKey.slice(0, 80)}): ${e.message}`);
    }
  } else if (cover.imageUrl) {
    try {
      buf = await downloadBuffer(cover.imageUrl);
    } catch (e) {
      throw new Error(`cover fetch failed: ${e.message}`);
    }
  } else {
    throw new Error('cover missing imageBase64, imageUrl, and imageStorageKey/gcsPath');
  }
  const resized = await sharp(buf)
    .resize({ width: 1024, withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
  return { base64: resized.toString('base64'), mime: 'image/jpeg' };
}

/**
 * Pull the immediately-prior accepted spread for continuity QA + render
 * reference. Best-effort: a missed download falls back to "cover only".
 */
async function resolvePreviousSpreadImageRef(doc, spreadNumber, logTag) {
  if (spreadNumber <= 1) return null;
  const prev = doc.spreads.find((s) => s.spreadNumber === spreadNumber - 1);
  const key = prev?.illustration?.imageStorageKey;
  if (!key) return null;
  try {
    const buf = await downloadBuffer(key);
    return { base64: buf.toString('base64'), mime: 'image/jpeg' };
  } catch (e) {
    console.warn(`[${logTag}] previous-spread ref download failed: ${e.message}`);
    return null;
  }
}

/**
 * Render-and-QA one spread, with up to two retry rounds (mirrors the Gemini
 * `extraSessionRounds` budget but without rebuilding a session — each round
 * is just a fresh `processSpread` call).
 */
async function processOneSpread({ doc, cover, spread, bookId, apiKey }) {
  const logTag = `bookPipeline:${bookId || 'n/a'}:spread${spread.spreadNumber}:openaiFlow`;
  const spec = buildIllustrationSpec(doc, spread);
  const baselineCaption = spec.text;
  const baselineScene = spec.scene;
  const supportingCast = Array.isArray(doc.visualBible?.supportingCast)
    ? doc.visualBible.supportingCast
    : [];
  const additionalCoverCharacters = supportingCast
    .filter((c) => c?.description)
    .map((c) => `${c.role || 'person'}${c.name ? ` (${c.name})` : ''}: ${c.description}`)
    .join('; ') || null;

  const previousSpreadRef = await resolvePreviousSpreadImageRef(doc, spread.spreadNumber, logTag);

  const rulesOpts = {
    theme: spec.theme,
    hasParentOnCover: false,
    hasSecondaryOnCover: false,
    additionalCoverCharacters,
    childAppearance: doc.visualBible?.hero?.physicalDescription || '',
    locationPalette: doc.storyBible?.locationPalette || doc.visualBible?.locationPalette || null,
    childAge: doc.brief?.child?.age ?? null,
  };

  const spreadCtx = {
    spreadIndex: spec.spreadIndex,
    scene: baselineScene,
    text: baselineCaption,
    textSide: spec.textSide,
    textCorner: spec.textCorner,
    theme: spec.theme,
    hasSecondaryOnCover: false,
    coverParentPresent: false,
    additionalCoverCharacters,
    childAge: doc.brief?.child?.age ?? null,
    characterDescription: doc.visualBible?.hero?.physicalDescription || '',
  };

  const runQa = async ({ imageBase64, expected, spreadIndex }) => checkSpread({
    imageBase64,
    expected,
    coverRef: { base64: cover.base64, mime: cover.mime },
    hero: doc.visualBible?.hero?.physicalDescription || '',
    additionalCoverCharacters,
    coverParentPresent: false,
    spreadIndex,
    previousSpreadRef: previousSpreadRef || undefined,
    abortSignal: doc.operationalContext?.abortSignal,
  });

  const totalRounds = 1 + Math.max(0, REPAIR_BUDGETS.perSpreadExtraSessionRounds || 0);
  let lastResult = null;
  let currentDoc = doc;

  for (let round = 1; round <= totalRounds; round++) {
    if (round > 1) {
      console.log(`[${logTag}] starting fresh round ${round}/${totalRounds} after exhausting QA corrections`);
    }
    let attemptResult;
    try {
      attemptResult = await processSpread({
        apiKey,
        coverBase64: cover.base64,
        coverMime: cover.mime,
        previousSpreadBase64: previousSpreadRef?.base64,
        previousSpreadMime: previousSpreadRef?.mime,
        rulesOpts,
        spreadCtx,
        runQa,
        abortSignal: doc.operationalContext?.abortSignal,
        logTag,
      });
    } catch (err) {
      // Abort propagates; everything else falls through as a failure result.
      if (err?.name === 'AbortError') throw err;
      console.error(`[${logTag}] render error during round ${round}: ${err.message}`);
      return {
        accepted: false,
        doc: currentDoc,
        issues: [err.message],
        tags: ['render_error'],
      };
    }

    lastResult = attemptResult;

    // Record the QA verdict as a spread check on the doc.
    currentDoc = updateSpread(currentDoc, spread.spreadNumber, (s) => ({
      ...s,
      qa: {
        ...s.qa,
        spreadChecks: [
          ...s.qa.spreadChecks,
          {
            attempt: attemptResult.attempts,
            pass: attemptResult.accepted,
            issues: attemptResult.qa?.issues || [],
            tags: attemptResult.qa?.tags || [],
          },
        ],
      },
    }));

    if (attemptResult.accepted) {
      const destination = `books/${bookId || currentDoc.request.bookId || 'nobookid'}/spreads/spread-${spread.spreadNumber}.jpg`;
      await uploadBuffer(attemptResult.printable, destination, 'image/jpeg');
      const imageUrl = await getSignedUrl(destination, SIGNED_URL_TTL_MS);

      const captionChanged = attemptResult.caption !== baselineCaption;
      const nextDoc = updateSpread(currentDoc, spread.spreadNumber, (s) => ({
        ...s,
        manuscript: s.manuscript && captionChanged
          ? { ...s.manuscript, text: attemptResult.caption }
          : s.manuscript,
        illustration: {
          prompt: attemptResult.scene,
          imageUrl,
          imageStorageKey: destination,
          accepted: true,
          attempts: attemptResult.attempts,
        },
      }));
      return {
        accepted: true,
        doc: nextDoc,
        issues: [],
        tags: [],
        imageUrl,
      };
    }

    // Failed this round → record planSpreadRepair memory before re-running.
    const plan = planSpreadRepair({
      spreadNumber: spread.spreadNumber,
      attemptNumber: attemptResult.attempts,
      issues: attemptResult.qa?.issues || [],
      tags: attemptResult.qa?.tags || [],
    });
    currentDoc = appendRetryMemory(currentDoc, plan.retryEntry);
  }

  // Exhausted all rounds. Optionally accept-with-risk if the env gate is on.
  if (lastResult && canAcceptSpreadAfterExhaustionGate(lastResult.qa)) {
    console.warn(
      `[${logTag}] ACCEPT WITH RISK — exhausted ${totalRounds} round(s); ` +
      'ILLUSTRATION_QA_ACCEPT_ON_EXHAUSTION allows completion (no identity/style hard-fails)',
    );
    const destination = `books/${bookId || currentDoc.request.bookId || 'nobookid'}/spreads/spread-${spread.spreadNumber}.jpg`;
    await uploadBuffer(lastResult.printable, destination, 'image/jpeg');
    const imageUrl = await getSignedUrl(destination, SIGNED_URL_TTL_MS);
    const captionChanged = lastResult.caption !== baselineCaption;
    const nextDoc = updateSpread(currentDoc, spread.spreadNumber, (s) => ({
      ...s,
      manuscript: s.manuscript && captionChanged
        ? { ...s.manuscript, text: lastResult.caption }
        : s.manuscript,
      illustration: {
        prompt: lastResult.scene,
        imageUrl,
        imageStorageKey: destination,
        accepted: true,
        acceptedWithRisk: true,
        attempts: lastResult.attempts,
      },
    }));
    return { accepted: true, doc: nextDoc, issues: [], tags: ['accepted_with_risk'], imageUrl };
  }

  console.error(`[${logTag}] EXHAUSTED budget — spread unresolvable`);
  return {
    accepted: false,
    doc: currentDoc,
    issues: ['spread exhausted repair budget'],
    tags: ['spread_unresolvable'],
  };
}

/**
 * Render every spread in the canonical book document.
 *
 * @param {object} doc
 * @returns {Promise<object>}
 */
async function renderAllSpreads(doc) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('renderAllSpreads (openaiFlow): OPENAI_API_KEY missing — required for gpt-image-2');
  }

  const cover = await resolveCoverBase64(doc.cover);
  console.log('[bookPipeline/renderAllSpreads] Using illustrator provider: openai-gpt-image-2');

  const totalSpreads = doc.spreads.length;
  const bookId = doc.operationalContext?.bookId || doc.request.bookId;
  const emit = (event) => {
    try {
      doc.operationalContext?.touchActivity?.();
    } catch {
      /* ignore */
    }
    const fn = doc.operationalContext?.onProgress;
    if (typeof fn === 'function') {
      try { fn(event); } catch { /* ignore */ }
    }
  };

  let current = doc;
  for (let i = 0; i < current.spreads.length; i++) {
    const spread = current.spreads[i];
    if (!spread.spec) {
      const err = new Error(`spread ${spread.spreadNumber}: spec missing`);
      err.failureCode = FAILURE_CODES.SPREAD_UNRESOLVABLE;
      throw err;
    }

    emit({
      step: 'illustrating',
      message: `Rendering spread ${spread.spreadNumber} of ${totalSpreads}`,
      spreadIndex: i,
      spreadNumber: spread.spreadNumber,
      totalSpreads,
      subProgress: i / totalSpreads,
    });

    const result = await processOneSpread({
      doc: current,
      cover,
      spread,
      bookId,
      apiKey,
    });

    current = result.doc;
    if (!result.accepted) {
      const err = new Error(`spread ${spread.spreadNumber}: ${(result.issues || []).join('; ') || 'unaccepted'}`);
      err.failureCode = FAILURE_CODES.SPREAD_UNRESOLVABLE;
      throw err;
    }

    emit({
      step: 'illustrating',
      message: `Spread ${spread.spreadNumber} of ${totalSpreads} accepted`,
      spreadIndex: i,
      spreadNumber: spread.spreadNumber,
      totalSpreads,
      subProgress: (i + 1) / totalSpreads,
      document: current,
    });
  }

  return current;
}

module.exports = {
  renderAllSpreads,
  processOneSpread,
  canAcceptSpreadAfterExhaustionGate,
};
