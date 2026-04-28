/**
 * Orchestrates interior spread rendering for the new pipeline.
 *
 * One Gemini chat session anchored on the approved cover:
 *   - establishCharacterReference(cover) once
 *   - per-spread loop:
 *       1. build illustration spec from new schema
 *       2. buildSpreadTurn + generateSpread
 *       3. stripMetadata + upscaleForPrint
 *       4. per-spread QA (text + consistency) in parallel
 *       5. if pass:   markSpreadAccepted, upload to GCS, record on doc
 *          if fail:   planSpreadRepair -> sendCorrection (in-session)
 *                     -> after N corrections, rebuildSession (once per spread phase)
 *                     -> if budget exhausted: up to REPAIR_BUDGETS.perSpreadExtraSessionRounds
 *                        fresh session + full attempt budget again
 *                     -> escalate by failing the spread
 *
 * All schema reads come from the new book document. No legacy
 * storyPlan/entries shapes are touched here.
 */

const sharp = require('sharp');

const {
  createSession,
  establishCharacterReference,
  generateSpread,
  sendCorrection,
  markSpreadAccepted,
  pruneLastTurn,
  rebuildSession,
  providerName,
} = require('../../illustrator/sessionDispatch');
const {
  buildSpreadTurn,
  buildCorrectionTurn,
  deescalateSceneForSignage,
  shouldDeescalateSceneForQaFail,
  compactSceneForImageSafetyRetry,
  softenSceneForImageSafetyRetry,
  softenCaptionForImageSafetyRetry,
  minimalSafeSceneFallback,
} = require('../../illustrator/prompt');
const { stripMetadata } = require('../../illustrator/postprocess/strip');
const { upscaleForPrint } = require('../../illustrator/postprocess/upscale');
const { uploadBuffer, getSignedUrl, downloadBuffer } = require('../../gcsStorage');

const { checkSpread } = require('../qa/checkSpread');
const { planSpreadRepair } = require('../qa/planRepair');
const { buildIllustrationSpec } = require('./buildIllustrationSpec');
const { REPAIR_BUDGETS, FAILURE_CODES, MODELS } = require('../constants');
const { updateSpread, appendRetryMemory } = require('../schema/bookDocument');
const { LATE_SPREAD_COVER_REANCHOR_INDEX } = require('../../illustrator/config');

/** True when `MODELS.SPREAD_RENDER` selects an OpenAI image model. */
function isOpenAIImageProvider() {
  const m = String(MODELS?.SPREAD_RENDER || '').toLowerCase();
  return m.startsWith('gpt-image') || m.startsWith('openai-image');
}

const SIGNED_URL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** When not "0", first interior spread (index 0) inlines the cover on first generate to reduce early hair drift. */
const REANCHOR_FIRST_INTERIOR_SPREAD = process.env.ILLUSTRATION_REANCHOR_FIRST_INTERIOR !== '0';

/**
 * Last-resort: accept a spread after repair budget exhausted — only if Pixar medium
 * still holds and failures are "soft" (e.g. OCR). Set ILLUSTRATION_QA_ACCEPT_ON_EXHAUSTION=1.
 *
 * @param {object} qa - merged checkSpread result
 * @returns {boolean}
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
 * Load the prior spread's uploaded JPEG from GCS for continuity QA (cover + previous).
 *
 * @param {object} doc
 * @param {number} spreadNumber - 1-based
 * @param {string} logTag
 * @returns {Promise<{ base64: string, mime: string }|null>}
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
    console.warn(`[${logTag}] previous-spread QA ref download failed: ${e.message}`);
    return null;
  }
}

/** QA reject logs: keep Cloud Logging lines useful but bounded. */
const QA_REJECT_LOG_MAX_ISSUE_CHARS = 3500;
const QA_REJECT_LOG_MAX_ISSUES_JSON_CHARS = 24000;
const QA_REJECT_LOG_OCR_CHARS = 600;
const QA_REJECT_LOG_EXPECTED_CHARS = 500;

/**
 * @param {unknown[]} issues
 * @returns {string}
 */
function formatQaRejectIssuesForLog(issues) {
  if (!Array.isArray(issues) || issues.length === 0) return '[]';
  const parts = issues.map((issue) => {
    const s = typeof issue === 'string' ? issue : JSON.stringify(issue);
    if (s.length <= QA_REJECT_LOG_MAX_ISSUE_CHARS) return s;
    return `${s.slice(0, QA_REJECT_LOG_MAX_ISSUE_CHARS)}…`;
  });
  let out = JSON.stringify(parts);
  if (out.length > QA_REJECT_LOG_MAX_ISSUES_JSON_CHARS) {
    out = `${out.slice(0, QA_REJECT_LOG_MAX_ISSUES_JSON_CHARS)}…`;
  }
  return out;
}

/** When Gemini returns 0 content parts (e.g. finishReason=IMAGE_OTHER), wait + retry before failing the spread. */
const MAX_TRANSIENT_EMPTY_IMAGE_RETRIES = 4;
const TRANSIENT_EMPTY_IMAGE_BASE_DELAY_MS = 2000;
const TRANSIENT_EMPTY_IMAGE_MAX_DELAY_MS = 25000;

/** Backoff before rebuildSession on safety blocks (bursty OTHER). */
const SAFETY_REBUILD_BASE_DELAY_MS = 2000;
const SAFETY_REBUILD_MAX_DELAY_MS = 12000;

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function delayRespectingAbort(ms, signal) {
  if (signal?.aborted) {
    return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  }
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Resolve the cover image as base64. Accepts either a pre-supplied base64
 * payload on `cover.imageBase64` or downloads `cover.imageUrl` and converts.
 *
 * @param {object} cover
 * @returns {Promise<{ base64: string, mime: string }>}
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
  // 1024px gives the vision model enough detail to lock skin tone, hair
  // texture, and face features. 512px was too low-detail — the identity kept
  // drifting and every correction turn made it worse.
  const resized = await sharp(buf)
    .resize({ width: 1024, withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
  return { base64: resized.toString('base64'), mime: 'image/jpeg' };
}

/**
 * Generate, QA, and upload a single spread with layered repair escalation.
 *
 * @param {object} params
 * @returns {Promise<{ accepted: boolean, doc: object, session: object, issues: string[], tags: string[], imageBase64?: string, imageUrl?: string }>}
 */
async function processOneSpread(params) {
  const { doc, session, cover, spread, bookId } = params;
  const logTag = `bookPipeline:${bookId || 'n/a'}:spread${spread.spreadNumber}`;
  const totalBudget = REPAIR_BUDGETS.perSpreadInSessionCorrections + REPAIR_BUDGETS.perSpreadPromptRepairs;
  let currentDoc = doc;
  let currentSession = session;

  const spec = buildIllustrationSpec(currentDoc, spread);
  const baselineCaption = spec.text;
  let renderCaption = baselineCaption;
  let expected = { text: renderCaption, side: spec.textSide };
  const hero = currentDoc.visualBible?.hero?.physicalDescription || '';

  /** Tier-2 safety: soften caption tripwires for the image API; syncs QA + manuscript on accept. */
  function applyTier2CaptionSoftening() {
    const softCap = softenCaptionForImageSafetyRetry(baselineCaption);
    if (softCap !== baselineCaption) {
      renderCaption = softCap;
      expected = { text: renderCaption, side: spec.textSide };
      console.warn(`[${logTag}] safety — caption wording softened for image API (tier 2; may affect rhyme)`);
    }
  }

  console.log(`[${logTag}] starting (budget=${totalBudget}, textSide=${spec.textSide}, textCorner=${spec.textCorner}, textLen=${(baselineCaption || '').length})`);

  let scene = spec.scene;
  let correctionNote = null;
  let lastTags = [];
  let extraRoundsRemaining = REPAIR_BUDGETS.perSpreadExtraSessionRounds;

  for (;;) {
    let attempt = 0;
    let transientEmptyRetries = 0;
    let suppressReanchorOnce = false;
    let suppressGenerateReanchorOnce = false;
    let suppressFirstInteriorReanchorOnce = false;
    /** Image-safety mitigations before rebuild: 1 = lean scene, 2 = soften or generic+caption. */
    let safetyMitigationPass = 0;
    correctionNote = null;
    lastTags = [];
    scene = spec.scene;
    renderCaption = baselineCaption;
    expected = { text: renderCaption, side: spec.textSide };
    let lastRiskBundle = null;

    while (attempt < totalBudget) {
      attempt += 1;
      const isFirstAttempt = attempt === 1;
      const attemptStart = Date.now();

      const needsReanchor = !isFirstAttempt && (
        lastTags.includes('hero_mismatch')
        || lastTags.includes('outfit_mismatch')
        || lastTags.includes('implied_parent_skin_mismatch')
        || lastTags.includes('style_drift'));
      const reanchorThisTurn = needsReanchor && !suppressReanchorOnce;

      let image;
      try {
        if (isFirstAttempt) {
          const turn = buildSpreadTurn({
            spreadIndex: spec.spreadIndex,
            scene,
            text: renderCaption,
            textSide: spec.textSide,
            textCorner: spec.textCorner,
            theme: spec.theme,
            childAge: currentDoc.brief?.child?.age ?? null,
          });
          const wantsLateReanchor =
            spec.spreadIndex >= LATE_SPREAD_COVER_REANCHOR_INDEX && !suppressGenerateReanchorOnce;
          const wantsFirstInteriorReanchor =
            REANCHOR_FIRST_INTERIOR_SPREAD && spec.spreadIndex === 0 && !suppressFirstInteriorReanchorOnce;
          image = await generateSpread(currentSession, turn, spec.spreadIndex, {
            reanchorCover: wantsLateReanchor || wantsFirstInteriorReanchor,
          });
        } else {
          const correction = buildCorrectionTurn({
            spreadIndex: spec.spreadIndex,
            scene,
            text: renderCaption,
            textSide: spec.textSide,
            textCorner: spec.textCorner,
            issues: [correctionNote || 'Fix the previous attempt.'],
            tags: [],
            childAge: currentDoc.brief?.child?.age ?? null,
          });
          // Re-anchor the cover image on the correction turn whenever the last
          // attempt drifted on hero identity, outfit, OR art style toward non-Pixar.
          // If Gemini safety-blocks that turn (common with a second inline child
          // reference), we retry once without re-anchoring (see catch block).
          if (reanchorThisTurn) {
            console.log(`[${logTag}] re-anchoring cover on attempt ${attempt} (prev tags: ${lastTags.join(',')})`);
          } else if (needsReanchor) {
            console.log(
              `[${logTag}] correction without inline cover re-anchor on attempt ${attempt} (prev tags: ${lastTags.join(',')})`,
            );
          }
          image = await sendCorrection(currentSession, correction, spec.spreadIndex, { reanchorCover: reanchorThisTurn });
        }
      } catch (err) {
        // Model sometimes returns no image (e.g. IMAGE_OTHER, 0 parts) — treat as transient and
        // re-run the same logical attempt (decrement so isFirstAttempt / correction path stay correct).
        if (err.isEmptyResponse && !err.isSafetyBlock && transientEmptyRetries < MAX_TRANSIENT_EMPTY_IMAGE_RETRIES) {
          transientEmptyRetries += 1;
          attempt -= 1;
          const delayMs = Math.min(
            TRANSIENT_EMPTY_IMAGE_MAX_DELAY_MS,
            TRANSIENT_EMPTY_IMAGE_BASE_DELAY_MS * 2 ** (transientEmptyRetries - 1),
          );
          console.warn(
            `[${logTag}] render error (${Date.now() - attemptStart}ms): ${err.message} ` +
            `[transient empty image ${transientEmptyRetries}/${MAX_TRANSIENT_EMPTY_IMAGE_RETRIES}, finishReason=${err.finishReason || 'n/a'}] ` +
            `— waiting ${delayMs}ms then retrying`,
          );
          try {
            await delayRespectingAbort(delayMs, currentDoc.operationalContext?.abortSignal);
          } catch (waitErr) {
            if (waitErr.name === 'AbortError' || currentDoc.operationalContext?.abortSignal?.aborted) {
              return { accepted: false, doc: currentDoc, session: currentSession, issues: ['aborted'], tags: ['aborted'] };
            }
            throw waitErr;
          }
          continue;
        }
        const isSafety = Boolean(err.isSafetyBlock) || /safety|prohibited|blocked/i.test(err?.message || '');
        const meta = [];
        if (err.finishReason) meta.push(`finishReason=${err.finishReason}`);
        if (err.blockReason) meta.push(`blockReason=${err.blockReason}`);
        if (err.safetyRatings != null) {
          let sr = err.safetyRatings;
          try {
            sr = JSON.stringify(sr);
          } catch {
            sr = String(sr);
          }
          if (sr.length > 800) sr = `${sr.slice(0, 800)}…`;
          meta.push(`safetyRatings=${sr}`);
        }
        const metaStr = meta.length ? ` (${meta.join('; ')})` : '';
        console.warn(
          `[${logTag}] render error on attempt ${attempt}/${totalBudget} (${Date.now() - attemptStart}ms): ${err.message}` +
          `${metaStr}${isSafety ? ' [safety]' : ''}`,
        );

        if (isSafety && !isFirstAttempt && reanchorThisTurn) {
          console.warn(`[${logTag}] safety after re-anchor — retrying correction without inline cover reference`);
          suppressReanchorOnce = true;
          attempt -= 1;
          continue;
        }

        if (
          isSafety
          && isFirstAttempt
          && spec.spreadIndex >= LATE_SPREAD_COVER_REANCHOR_INDEX
          && !suppressGenerateReanchorOnce
        ) {
          console.warn(
            `[${logTag}] safety on late-spread first attempt with cover re-anchor — retrying generate without inline cover`,
          );
          suppressGenerateReanchorOnce = true;
          attempt -= 1;
          continue;
        }

        if (
          isSafety
          && isFirstAttempt
          && REANCHOR_FIRST_INTERIOR_SPREAD
          && spec.spreadIndex === 0
          && !suppressFirstInteriorReanchorOnce
        ) {
          console.warn(
            `[${logTag}] safety on first-interior spread first attempt with cover re-anchor — retrying generate without inline cover`,
          );
          suppressFirstInteriorReanchorOnce = true;
          attempt -= 1;
          continue;
        }

        if (isSafety) {
          safetyMitigationPass += 1;
          attempt -= 1;
          if (safetyMitigationPass === 1) {
            const compacted = compactSceneForImageSafetyRetry(spec.scene);
            scene = (compacted !== spec.scene.trim())
              ? compacted
              : softenSceneForImageSafetyRetry(spec.scene);
            console.warn(`[${logTag}] safety pass 1/2: lean scene (strip duplicate policy) or phrase soften`);
            continue;
          }
          if (safetyMitigationPass === 2) {
            const sw = softenSceneForImageSafetyRetry(scene);
            if (sw !== scene) {
              scene = sw;
              console.warn(`[${logTag}] safety pass 2/2: phrase soften on current scene`);
              continue;
            }
            scene = minimalSafeSceneFallback(spec.spreadIndex, spec.theme);
            applyTier2CaptionSoftening();
            console.warn(`[${logTag}] safety pass 2/2: generic safe scene + optional caption soften`);
            continue;
          }
        }

        if (isSafety && currentSession.rebuilds < REPAIR_BUDGETS.perSpreadEscalations) {
          const exp = Math.min(currentSession.rebuilds, 4);
          const delayMs = Math.min(
            SAFETY_REBUILD_MAX_DELAY_MS,
            SAFETY_REBUILD_BASE_DELAY_MS * 2 ** exp,
          );
          console.log(`[${logTag}] waiting ${delayMs}ms before rebuild after safety block`);
          try {
            await delayRespectingAbort(delayMs, currentDoc.operationalContext?.abortSignal);
          } catch (waitErr) {
            if (waitErr.name === 'AbortError' || currentDoc.operationalContext?.abortSignal?.aborted) {
              return { accepted: false, doc: currentDoc, session: currentSession, issues: ['aborted'], tags: ['aborted'] };
            }
            throw waitErr;
          }
          console.log(`[${logTag}] rebuilding session after safety block`);
          currentSession = await rebuildSession(currentSession);
          suppressReanchorOnce = false;
          scene = spec.scene;
          safetyMitigationPass = 0;
          renderCaption = baselineCaption;
          expected = { text: renderCaption, side: spec.textSide };
          continue;
        }
        return { accepted: false, doc: currentDoc, session: currentSession, issues: [err.message], tags: ['render_error'] };
      }

      suppressReanchorOnce = false;
      transientEmptyRetries = 0;

      const stripped = await stripMetadata(image.imageBuffer);
      const printable = await upscaleForPrint(stripped);
      const printableBase64 = printable.toString('base64');

      const supportingCast = Array.isArray(currentDoc.visualBible?.supportingCast)
        ? currentDoc.visualBible.supportingCast
        : [];
      const additionalCoverCharacters = supportingCast
        .filter(c => c?.description)
        .map(c => `${c.role || 'person'}${c.name ? ` (${c.name})` : ''}: ${c.description}`)
        .join('; ') || null;
      // Being declared in the brief does NOT put someone on the cover.
      // Without cover vision, default to false; declared off-cover family is
      // still allowed to appear via `additionalCoverCharacters` (QA policy note).
      const coverParentPresent = false;

      const previousSpreadRef = await resolvePreviousSpreadImageRef(
        currentDoc,
        spread.spreadNumber,
        logTag,
      );

      const qaStart = Date.now();
      const qa = await checkSpread({
        imageBase64: printableBase64,
        expected,
        coverRef: { base64: cover.base64, mime: cover.mime },
        hero,
        additionalCoverCharacters,
        coverParentPresent,
        spreadIndex: spec.spreadIndex,
        previousSpreadRef: previousSpreadRef || undefined,
        abortSignal: currentDoc.operationalContext?.abortSignal,
      });
      const qaMs = Date.now() - qaStart;

      console.log(
        `[${logTag}] spreadQaHistogram spreadIndex=${spec.spreadIndex} pass=${qa.pass} tags=[${(qa.tags || []).join(',')}]`,
      );

      if (qa.pass) {
        console.log(`[${logTag}] ACCEPTED on attempt ${attempt}/${totalBudget} (render+qa=${Date.now() - attemptStart}ms, qa=${qaMs}ms)`);
        markSpreadAccepted(currentSession, spec.spreadIndex, image.imageBase64);

        const destination = `books/${bookId || currentDoc.request.bookId || 'nobookid'}/spreads/spread-${spread.spreadNumber}.jpg`;
        await uploadBuffer(printable, destination, 'image/jpeg');
        const imageUrl = await getSignedUrl(destination, SIGNED_URL_TTL_MS);

        const nextDoc = updateSpread(currentDoc, spread.spreadNumber, s => ({
          ...s,
          manuscript: s.manuscript && renderCaption !== baselineCaption
            ? { ...s.manuscript, text: renderCaption }
            : s.manuscript,
          illustration: {
            prompt: scene,
            imageUrl,
            imageStorageKey: destination,
            accepted: true,
            attempts: attempt,
          },
          qa: {
            ...s.qa,
            spreadChecks: [
              ...s.qa.spreadChecks,
              { attempt, pass: true, issues: [], tags: [] },
            ],
          },
        }));
        return { accepted: true, doc: nextDoc, session: currentSession, issues: [], tags: [], imageBase64: image.imageBase64, imageUrl };
      }

      const rawExpected = String(expected.text || '');
      const expectedPreview = rawExpected.replace(/\s+/g, ' ').slice(0, QA_REJECT_LOG_EXPECTED_CHARS);
      const rawOcr = qa.ocrText != null ? String(qa.ocrText) : '';
      const ocrPreview = rawOcr.replace(/\s+/g, ' ').slice(0, QA_REJECT_LOG_OCR_CHARS);
      console.warn(
        `[${logTag}] REJECTED on attempt ${attempt}/${totalBudget} (render+qa=${Date.now() - attemptStart}ms, qa=${qaMs}ms) ` +
        `textSide=${spec.textSide} textCorner=${spec.textCorner} ` +
        `tags=[${(qa.tags || []).join(',')}] ` +
        `expectedPreview="${expectedPreview}${rawExpected.length > QA_REJECT_LOG_EXPECTED_CHARS ? '…' : ''}" ` +
        (rawOcr
          ? `ocrPreview="${ocrPreview}${rawOcr.length > QA_REJECT_LOG_OCR_CHARS ? '…' : ''}" `
          : '') +
        `issues=${formatQaRejectIssuesForLog(qa.issues)}`,
      );

      lastRiskBundle = {
        printable,
        imageBase64: image.imageBase64,
        qa,
        attempt,
        scene,
        renderCaption,
      };

      pruneLastTurn(currentSession);

      lastTags = Array.isArray(qa.tags) ? qa.tags : [];

      const plan = planSpreadRepair({
        spreadNumber: spread.spreadNumber,
        attemptNumber: attempt,
        issues: qa.issues,
        tags: qa.tags,
      });
      correctionNote = plan.correctionNote;
      currentDoc = appendRetryMemory(currentDoc, plan.retryEntry);
      currentDoc = updateSpread(currentDoc, spread.spreadNumber, s => ({
        ...s,
        qa: {
          ...s.qa,
          spreadChecks: [
            ...s.qa.spreadChecks,
            { attempt, pass: false, issues: qa.issues, tags: qa.tags },
          ],
          repairHistory: [...s.qa.repairHistory, { attempt, tags: qa.tags }],
        },
      }));

      if (shouldDeescalateSceneForQaFail(qa.tags, scene)) {
        console.log(`[${logTag}] de-escalating scene for next attempt`);
        scene = deescalateSceneForSignage(scene);
      }

      if (attempt > REPAIR_BUDGETS.perSpreadInSessionCorrections &&
          currentSession.rebuilds < REPAIR_BUDGETS.perSpreadEscalations) {
        console.log(`[${logTag}] rebuilding session (attempt ${attempt} > ${REPAIR_BUDGETS.perSpreadInSessionCorrections})`);
        currentSession = await rebuildSession(currentSession);
        suppressReanchorOnce = false;
      }
    }

    if (extraRoundsRemaining <= 0) {
      if (lastRiskBundle && canAcceptSpreadAfterExhaustionGate(lastRiskBundle.qa)) {
        const rb = lastRiskBundle;
        console.warn(
          `[${logTag}] ACCEPT WITH RISK — repair budget exhausted; ` +
          'ILLUSTRATION_QA_ACCEPT_ON_EXHAUSTION allows completion (Pixar medium OK; no identity/style hard-fails)',
        );
        markSpreadAccepted(currentSession, spec.spreadIndex, rb.imageBase64);

        const destination = `books/${bookId || currentDoc.request.bookId || 'nobookid'}/spreads/spread-${spread.spreadNumber}.jpg`;
        await uploadBuffer(rb.printable, destination, 'image/jpeg');
        const imageUrl = await getSignedUrl(destination, SIGNED_URL_TTL_MS);

        const riskIssues = Array.isArray(rb.qa?.issues) ? rb.qa.issues : [];
        const nextDoc = updateSpread(currentDoc, spread.spreadNumber, (s) => ({
          ...s,
          manuscript: s.manuscript && rb.renderCaption !== baselineCaption
            ? { ...s.manuscript, text: rb.renderCaption }
            : s.manuscript,
          illustration: {
            prompt: rb.scene,
            imageUrl,
            imageStorageKey: destination,
            accepted: true,
            acceptedWithRisk: true,
            attempts: rb.attempt,
          },
          qa: {
            ...s.qa,
            spreadChecks: [
              ...s.qa.spreadChecks,
              {
                attempt: rb.attempt,
                pass: true,
                acceptedWithRisk: true,
                issues: riskIssues,
                tags: rb.qa.tags || [],
                note: 'Accepted after exhaustion gate (ILLUSTRATION_QA_ACCEPT_ON_EXHAUSTION)',
              },
            ],
          },
        }));
        return {
          accepted: true,
          doc: nextDoc,
          session: currentSession,
          issues: [],
          tags: ['accepted_with_risk'],
          imageBase64: rb.imageBase64,
          imageUrl,
        };
      }
      console.error(
        `[${logTag}] EXHAUSTED budget (${totalBudget} attempts/session) and ` +
        `${REPAIR_BUDGETS.perSpreadExtraSessionRounds} extra session round(s) — spread unresolvable`,
      );
      return {
        accepted: false,
        doc: currentDoc,
        session: currentSession,
        issues: ['spread exhausted repair budget'],
        tags: ['spread_unresolvable'],
      };
    }
    extraRoundsRemaining -= 1;
    console.log(
      `[${logTag}] Fresh illustrator session after exhausting ${totalBudget} attempts ` +
      `(extra round ${REPAIR_BUDGETS.perSpreadExtraSessionRounds - extraRoundsRemaining}/${REPAIR_BUDGETS.perSpreadExtraSessionRounds})`,
    );
    currentSession = await rebuildSession(currentSession);
  }
}

/**
 * Orchestrate all spreads in order.
 *
 * @param {object} doc - the canonical book document
 * @returns {Promise<object>}
 */
async function renderAllSpreads(doc) {
  if (isOpenAIImageProvider()) {
    // Stateless OpenAI flow — no chat session, no rebuilds, slim rules block,
    // cover + last-accepted spread as the only references. Defined in
    // services/illustrator/openaiFlow/newPipeline.js.
    return require('../../illustrator/openaiFlow').renderAllSpreads(doc);
  }
  const cover = await resolveCoverBase64(doc.cover);

  // Cover is the full visual cast. Declared characters in the brief who are
  // NOT on the cover are story-only — allowed as partial presence (hand,
  // shoulder, silhouette, back-of-head, distant unfocused figure) but never
  // as a full face or full body figure. The string we send into the session
  // is explicit about that so every interior turn inherits the same rule.
  const sessionCast = Array.isArray(doc.visualBible?.supportingCast) ? doc.visualBible.supportingCast : [];
  const offCoverSessionCast = sessionCast.filter(c => (c?.description || c?.name || c?.role) && c?.onCover !== true);
  const renderSessionLock = (c) => {
    const lock = c?.partialPresenceLock || {};
    const parts = [
      lock.skinTone ? `skin=${lock.skinTone}` : '',
      lock.hand ? `hand=${lock.hand}` : '',
      lock.sleeve ? `sleeve=${lock.sleeve}` : '',
      lock.signatureProp ? `signature=${lock.signatureProp}` : '',
    ].filter(Boolean).join('; ');
    return parts ? `    LOCK (must match every spread where this character is implied): ${parts}` : '';
  };
  const offCoverCastNote = offCoverSessionCast.length > 0
    ? [
      'OFF-COVER CAST (story-only; partial presence only — never full face or full body):',
      ...offCoverSessionCast.flatMap(c => {
        const label = [c.role, c.name ? `(${c.name})` : ''].filter(Boolean).join(' ') || 'supporting character';
        return [
          `  - ${label}: may appear only as a hand, arm, shoulder, back-of-head, silhouette, distant unfocused figure, or a personal object that stands in for them. Never a full face. Never a full body.`,
          renderSessionLock(c),
        ].filter(Boolean);
      }),
      'Skin tone of every implied family member must plausibly match the hero on the cover; no unexplained ethnicity mismatch.',
      'Parent–child orientation (HARD — for any parent in frame, full figure OR partial presence):',
      '  - The parent must be visibly engaged with the hero child: oriented toward them, eyes on them, sharing their focus, leaning in, holding hands, or walking alongside.',
      '  - Never turn the parent\'s back to the child with no narrative reason. No walking away, no ignoring, no parent looking off into empty space while the child is behind them.',
      '  - For partial presence: the implied hand/arm must reach TOWARD the child (offering, holding, steadying, pointing at a shared focus) — not away from the child.',
      '  - Allowed exceptions: parent in profile leading the child by the hand, both facing a shared focus (fireworks, sunset, cake), parent kneeling beside the child reaching for something for them — in all of these the body language still reads as connected to the child.',
      'Partial-presence anatomy (HARD — natural, never uncanny):',
      '  - Any visible limb must enter from a clear frame edge (or behind a foreground object) and continue plausibly off-screen. NEVER a hand or arm floating in mid-frame with no path to a body.',
      '  - The off-frame body must be physically plausible for the staging (seated beside, kneeling above, leaning in from a railing). The viewer must instantly read where the rest of the body is.',
      '  - Show enough of the limb (wrist + forearm + start of elbow or sleeve continuing off-frame) that it is clearly attached to a real body. Bare disembodied hands are forbidden.',
      '  - Silhouettes and back-of-head views must sit at a believable depth and scale relative to the hero. No floating ghosts, no double silhouettes, no pasted look.',
      '  - Never add extra or duplicated limbs. One implied character contributes one set of limbs per spread.',
      '  - If a clean partial presence cannot be staged naturally, prefer the signature object from the lock instead of a limb.',
    ].join('\n')
    : null;
  let session = createSession({
    coverBase64: cover.base64,
    coverMime: cover.mime,
    theme: doc.request.theme,
    childAppearance: doc.visualBible?.hero?.physicalDescription || '',
    childAge: doc.brief?.child?.age ?? null,
    hasParentOnCover: false,
    hasSecondaryOnCover: false,
    additionalCoverCharacters: offCoverCastNote,
    abortSignal: doc.operationalContext?.abortSignal,
  });
  console.log(`[bookPipeline/renderAllSpreads] Using illustrator provider: ${providerName}`);
  await establishCharacterReference(session);

  let current = doc;
  const bookId = doc.operationalContext?.bookId || doc.request.bookId;

  const totalSpreads = current.spreads.length;
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
      session,
      cover,
      spread,
      bookId,
    });

    current = result.doc;
    session = result.session;

    if (!result.accepted) {
      const err = new Error(`spread ${spread.spreadNumber}: ${result.issues.join('; ') || 'unaccepted'}`);
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
      // Attach the latest document so the server can push an incremental
      // storyContent update to the admin content tab — lets the user watch
      // hasImage flags flip to true one spread at a time while the rest
      // keep rendering.
      document: current,
    });
  }

  return current;
}

module.exports = {
  renderAllSpreads,
  processOneSpread,
  canAcceptSpreadAfterExhaustionGate,
  REANCHOR_FIRST_INTERIOR_SPREAD,
};
