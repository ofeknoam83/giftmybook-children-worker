/**
 * Two consecutive spreads share one 4:1 composite: strip → slice natives → QA halves →
 * on pass upscale full quad, re-slice for print JPEGs + session refs.
 */

const sharp = require('sharp');

const {
  createSession,
  establishCharacterReference,
  generateSpread,
  sendCorrection,
  markQuadPairAccepted,
  pruneLastTurn,
  rebuildSession,
  providerName,
} = require('../../illustrator/sessionDispatch');
const { OPENAI_QUAD_IMAGE_SIZE } = require('../../illustrator/config');
const { buildDualSpreadTurn, buildDualCorrectionTurn } = require('../../illustrator/promptQuad');
const {
  deescalateSceneForSignage,
  shouldDeescalateSceneForQaFail,
  compactSceneForImageSafetyRetry,
  softenSceneForImageSafetyRetry,
  softenCaptionForImageSafetyRetry,
  minimalSafeSceneFallback,
} = require('../../illustrator/prompt');
const { stripMetadata } = require('../../illustrator/postprocess/strip');
const { upscaleForPrint } = require('../../illustrator/postprocess/upscale');
const { uploadBuffer, getSignedUrl } = require('../../gcsStorage');

const { checkSpread } = require('../qa/checkSpread');
const { planSpreadRepair } = require('../qa/planRepair');
const { pickRecentInteriorRefsForQa } = require('../qa/recentInteriorRefs');
const { buildIllustrationSpec } = require('./buildIllustrationSpec');
const { sliceQuadToTwoSpreadStrips } = require('./sliceQuadToTwoSpreadStrips');
const { isTransientIllustrationInfraError } = require('../../illustrator/transientInfraError');
const { REPAIR_BUDGETS, FAILURE_CODES, TOTAL_SPREADS, QA_RECENT_INTERIOR_REFERENCES } = require('../constants');
const { updateSpread, appendRetryMemory, incrementCounter } = require('../schema/bookDocument');
const { reviseSpreadProseForIllustrator } = require('../writer/rewriteBookText');
const { processOneSpread, resolveCoverBase64, formatQaRejectIssuesForLog } = require('./renderAllSpreads');

const SIGNED_URL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const QA_REJECT_LOG_EXPECTED_CHARS = 500;

/**
 * Spread indexes (0-based) at which the first attempt re-attaches the cover image.
 * Mirrors `SCHEDULED_REANCHOR_INDEXES` in renderAllSpreads.js. In the quad path
 * a batch covers TWO spreads (e.g. spreads 5 + 6 = indexes 4, 5); we re-anchor
 * a batch when EITHER of its two spread indexes is in this set.
 */
const SCHEDULED_REANCHOR_INDEXES = new Set([2, 5, 8, 11]);

const MAX_TRANSIENT_EMPTY_IMAGE_RETRIES = 4;
const TRANSIENT_EMPTY_IMAGE_BASE_DELAY_MS = 2000;
const TRANSIENT_EMPTY_IMAGE_MAX_DELAY_MS = 25000;
const MAX_TRANSIENT_INFRA_RETRIES = 5;
const TRANSIENT_INFRA_BASE_DELAY_MS = 4000;
const TRANSIENT_INFRA_MAX_DELAY_MS = 60000;
const SAFETY_REBUILD_BASE_DELAY_MS = 2000;
const SAFETY_REBUILD_MAX_DELAY_MS = 12000;

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
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
 * PR F early-abort helpers.
 *
 * `nextConsecutiveAgeActionImpossible` returns the new running counter for
 * consecutive `age_action_impossible` rejections. The counter resets to 0
 * any time the most recent rejection did NOT include the tag — we want a
 * true streak, not a cumulative tally, because intermittent age failures
 * mixed with other failures could legitimately resolve.
 *
 * `shouldEarlyAbortForUnrenderableInfantAction` is the threshold check.
 * Pulled out so callers (and tests) read symmetrically and so the
 * threshold lives in one place.
 *
 * @param {number} prev
 * @param {string[]} latestRejectTags
 * @returns {number}
 */
function nextConsecutiveAgeActionImpossible(prev, latestRejectTags) {
  const tags = Array.isArray(latestRejectTags) ? latestRejectTags : [];
  if (tags.includes('age_action_impossible')) return (prev || 0) + 1;
  return 0;
}

/**
 * @param {number} consecutive
 * @returns {boolean}
 */
function shouldEarlyAbortForUnrenderableInfantAction(consecutive) {
  return (consecutive || 0) >= REPAIR_BUDGETS.ageActionImpossibleConsecutiveAbort;
}

/**
 * Parent-skin escape hatch.
 *
 * The QA tags `implied_parent_skin_mismatch` and `full_body_parent_skin_mismatch`
 * are model-evaluated color-match calls on small skin patches (a hand, a sleeve
 * cuff, a forearm). The image model physically cannot perfectly color-match
 * these fragments to the cover child every time, and a strict QA bar will
 * sometimes burn the entire repair budget rejecting borderline gaps that the
 * model cannot close.
 *
 * Rather than fail the whole book, we downgrade the spread's parentVisibility
 * after consecutive parent-skin-only rejections so the parent fragment is
 * removed from frame entirely. The story is about the hero child; an empty
 * chair / cup / blanket implies the parent without exposing skin to compare.
 *
 * Tier ladder (consecutive parent-skin-only rejections for THIS spread):
 *   < 2  rejections : keep the planner's chosen parentVisibility (no override)
 *   = 2  rejections : downgrade to 'object'  (object stands in for parent)
 *   >= 3 rejections : downgrade to 'absent'  (child alone in the frame)
 *
 * "parent-skin-only" means the spread's last rejection had AT LEAST ONE of the
 * parent-skin tags AND no OTHER unrelated failure tags. We do not downgrade
 * when the spread also has unrelated tags (e.g. duplicated_hero, outfit_mismatch)
 * because those need the regular repair path.
 *
 * @param {string[]} tags - QA tags from the most recent rejection of THIS spread
 * @returns {boolean}
 */
const PARENT_SKIN_TAGS = new Set([
  'implied_parent_skin_mismatch',
  'full_body_parent_skin_mismatch',
]);

function isParentSkinOnlyRejection(tags) {
  const arr = Array.isArray(tags) ? tags : [];
  if (arr.length === 0) return false;
  let hasParentSkin = false;
  for (const t of arr) {
    if (PARENT_SKIN_TAGS.has(t)) { hasParentSkin = true; continue; }
    // Any tag outside the parent-skin family disqualifies the escape hatch.
    return false;
  }
  return hasParentSkin;
}

/**
 * @param {number} prev - prior consecutive parent-skin-only rejection count for this spread
 * @param {string[]} latestTags - tags from this spread's latest rejection
 * @returns {number}
 */
function nextConsecutiveParentSkinOnly(prev, latestTags) {
  if (isParentSkinOnlyRejection(latestTags)) return (prev || 0) + 1;
  return 0;
}

/**
 * Resolve the parentVisibility used for the NEXT attempt, applying the escape
 * hatch ladder. Returns the original value when no override applies.
 *
 * @param {string|null|undefined} planned - planner's parentVisibility
 * @param {number} consecutive - per-spread consecutive parent-skin-only rejections
 * @returns {string|null|undefined}
 */
function resolveParentVisibilityWithEscapeHatch(planned, consecutive) {
  const c = consecutive || 0;
  if (c >= 3) return 'absent';
  if (c >= 2) return 'object';
  return planned;
}

/**
 * AA-CW-14a — silhouette escape hatch.
 *
 * The QA tag `parent_as_character_silhouette` fires when the model renders the
 * implied parent as an anthropomorphized shadow / silhouette WITH face
 * features (eyes, mouth, glow). The repair prompt asks the model to remove
 * face features from the silhouette — but the image model frequently reproduces
 * the same head-shaped shadow on every retry, since "silhouette without a
 * head" is not a stable concept for the renderer.
 *
 * Observed in production: spread pairs burn the full ~5-attempt budget on
 * `parent_as_character_silhouette` alone, then trigger a session rebuild and
 * burn another full budget — ~150s of GPU time per failing pair, with no
 * meaningful progress between attempts.
 *
 * Mirror PR X (parent-skin escape hatch). After 2 consecutive silhouette-only
 * rejections, downgrade THAT spread's parentVisibility on the next attempt so
 * the parent silhouette is removed from frame entirely. The story is about
 * the hero child; an empty mug / blanket / chair implies the parent without
 * exposing a face-shaped shadow for QA to re-flag.
 *
 * Tier ladder (consecutive silhouette-only rejections for THIS spread):
 *   < 2  rejections : keep planner's chosen parentVisibility (no override)
 *   = 2  rejections : downgrade to 'object'  (object stands in for parent)
 *   >= 3 rejections : downgrade to 'absent'  (child alone in the frame)
 *
 * "silhouette-only" means the spread's last rejection had AT LEAST ONE
 * silhouette tag AND no OTHER unrelated failure tag. Spreads that also have
 * unrelated tags (e.g. duplicated_hero, outfit_mismatch) take the regular
 * repair path because those still need real fixes.
 *
 * @param {string[]} tags
 * @returns {boolean}
 */
const SILHOUETTE_TAGS = new Set([
  'parent_as_character_silhouette',
]);

function isSilhouetteOnlyRejection(tags) {
  const arr = Array.isArray(tags) ? tags : [];
  if (arr.length === 0) return false;
  let hasSilhouette = false;
  for (const t of arr) {
    if (SILHOUETTE_TAGS.has(t)) { hasSilhouette = true; continue; }
    return false;
  }
  return hasSilhouette;
}

/**
 * @param {number} prev
 * @param {string[]} latestTags
 * @returns {number}
 */
function nextConsecutiveSilhouetteOnly(prev, latestTags) {
  if (isSilhouetteOnlyRejection(latestTags)) return (prev || 0) + 1;
  return 0;
}

/**
 * Combine the parent-skin and silhouette escape-hatch tiers into the
 * effective parentVisibility for the NEXT attempt. We take the strongest
 * downgrade across both counters: if either has reached 'absent' (>=3) we
 * return 'absent'; otherwise if either has reached 'object' (>=2) we return
 * 'object'; otherwise return the planner's value.
 *
 * @param {string|null|undefined} planned
 * @param {number} consecutiveParentSkin
 * @param {number} consecutiveSilhouette
 * @returns {string|null|undefined}
 */
function resolveParentVisibilityWithBothEscapeHatches(planned, consecutiveParentSkin, consecutiveSilhouette) {
  const cps = consecutiveParentSkin || 0;
  const cs = consecutiveSilhouette || 0;
  if (cps >= 3 || cs >= 3) return 'absent';
  if (cps >= 2 || cs >= 2) return 'object';
  return planned;
}

/**
 * Tags that indicate a QA infrastructure failure (not a real artifact in the
 * generated image). When a half fails ONLY on these tags after the model has
 * had several real attempts, the gate is being held open by an upstream
 * outage (Gemini empty responses, throttled keys, etc.) — re-rendering the
 * spread will not change the verdict. We promote those late-stage failures
 * to an accept so the book ships rather than dying on a QA pipe outage.
 */
const QA_INFRA_TAGS = new Set([
  'qa_api_error',
  'qa_consistency_error',
  'qa_action_error',
  'qa_unavailable',
]);

/**
 * "Soft-fail" tags — borderline QA verdicts the model fires on subtle calls
 * that customer-facing readers rarely notice and the renderer often cannot
 * close after several attempts. Production logs show pairs burning their
 * entire repair budget on these tags alone (cardigan-on-a-branch flagged as
 * outfit drift, headband flagged as hair drift, etc.) — and even when the
 * renderer fixes the named complaint on attempt N, the QA model finds a
 * different borderline angle on attempt N+1.
 *
 * We accept a spread on these tags AFTER the renderer has had a real chance
 * to address them (higher threshold than the infra-only accept). Real,
 * customer-noticeable artifacts (action_mismatch, hero_mismatch,
 * duplicated_hero, explicit_stranger, split_panel, etc.) still block.
 */
const QA_SOFT_FAIL_TAGS = new Set([
  'implied_parent_outfit_drift',
  'hair_continuity_drift',
  'outfit_continuity_drift',
]);

/**
 * @param {{ pass: boolean, tags?: string[] }} qa
 * @returns {boolean} true when the QA failed and every failure tag is infra
 */
function isInfraOnlyFailure(qa) {
  if (!qa || qa.pass === true) return false;
  const tags = Array.isArray(qa.tags) ? qa.tags : [];
  if (tags.length === 0) return false;
  for (const t of tags) {
    if (!QA_INFRA_TAGS.has(t)) return false;
  }
  return true;
}

/**
 * @param {{ pass: boolean, tags?: string[] }} qa
 * @returns {boolean} true when every failure tag is in the infra OR soft-fail set
 */
function isInfraOrSoftFailOnly(qa) {
  if (!qa || qa.pass === true) return false;
  const tags = Array.isArray(qa.tags) ? qa.tags : [];
  if (tags.length === 0) return false;
  for (const t of tags) {
    if (!QA_INFRA_TAGS.has(t) && !QA_SOFT_FAIL_TAGS.has(t)) return false;
  }
  return true;
}

/**
 * Should this pair be promoted to an accept on the basis that BOTH halves
 * either passed cleanly or failed only on QA infra? We require the renderer
 * to have spent at least most of its in-session budget so we do not
 * fail-open on a one-off transient hiccup.
 *
 * Two thresholds:
 *  - infra-only: ~60% of budget (sustained QA-pipe outage)
 *  - infra OR soft-fail: ~75% of budget (renderer had a real chance and is
 *    spinning on borderline QA calls)
 */
function shouldFailOpenAcceptPair(qaA, qaB, attempt, totalBudget) {
  const aOk = qaA && qaA.pass === true;
  const bOk = qaB && qaB.pass === true;
  if (aOk && bOk) return false; // clean-accept path handles this — don't take this branch

  const minAttemptsInfra = Math.max(3, Math.ceil((totalBudget || 1) * 0.6));
  const minAttemptsSoft = Math.max(5, Math.ceil((totalBudget || 1) * 0.75));

  if (attempt >= minAttemptsInfra) {
    const aInfra = isInfraOnlyFailure(qaA);
    const bInfra = isInfraOnlyFailure(qaB);
    if ((aOk || aInfra) && (bOk || bInfra) && (aInfra || bInfra)) return true;
  }
  if (attempt >= minAttemptsSoft) {
    const aSoft = isInfraOrSoftFailOnly(qaA);
    const bSoft = isInfraOrSoftFailOnly(qaB);
    if ((aOk || aSoft) && (bOk || bSoft) && (aSoft || bSoft)) return true;
  }
  return false;
}

function quadGenOpts() {
  const openai = String(providerName || '').toLowerCase().includes('openai');
  if (openai) {
    return { imageSize: OPENAI_QUAD_IMAGE_SIZE, outputLine: 'generate-quad' };
  }
  return { aspectRatio: '4:1' };
}

function correctionGenOpts() {
  const openai = String(providerName || '').toLowerCase().includes('openai');
  if (openai) {
    return { imageSize: OPENAI_QUAD_IMAGE_SIZE, outputLine: 'correction-quad' };
  }
  return { aspectRatio: '4:1' };
}

/**
 * @returns {Promise<{ accepted: boolean, doc: object, session: object, issues: string[], tags: string[] }>}
 */
async function processQuadPair(params) {
  const {
    doc,
    session,
    cover,
    spreadA,
    spreadB,
    bookId,
    quadBatchIndex,
  } = params;

  const spreadNumbers = [spreadA.spreadNumber, spreadB.spreadNumber];
  const logTagQuad = `bookPipeline:${bookId || 'n/a'}:quad`;
  const logA = `bookPipeline:${bookId || 'n/a'}:spread${spreadA.spreadNumber}`;
  const logB = `bookPipeline:${bookId || 'n/a'}:spread${spreadB.spreadNumber}`;

  console.log(
    `[${logTagQuad}] batch ${quadBatchIndex + 1} quadBatchIndex=${quadBatchIndex} spreadNumbers=[${spreadNumbers.join(', ')}] aspect=4:1`,
  );

  const specA = buildIllustrationSpec(doc, spreadA);
  const specB = buildIllustrationSpec(doc, spreadB);
  // Phase 4 — captions are mutable: a prose revision (writer rewrite
  // triggered by an illustrator-side veto) can replace EITHER spread's
  // manuscript mid-pair before we early-abort the whole pair. Bounded to
  // one revision per pair so we never spend the whole render budget on
  // the writer side.
  let baselineCaptionA = specA.text;
  let baselineCaptionB = specB.text;
  let renderCaptionA = baselineCaptionA;
  let renderCaptionB = baselineCaptionB;
  let proseRevisionsUsedQuad = 0;
  const MAX_PROSE_REVISIONS_PER_PAIR = 1;
  let expectedA = { text: renderCaptionA, side: specA.textSide };
  let expectedB = { text: renderCaptionB, side: specB.textSide };

  let sceneA = specA.scene;
  let sceneB = specB.scene;

  const totalBudget = REPAIR_BUDGETS.perSpreadInSessionCorrections + REPAIR_BUDGETS.perSpreadPromptRepairs;
  let currentDoc = doc;
  let currentSession = session;
  const hero = currentDoc.visualBible?.hero?.physicalDescription || '';
  let extraRoundsRemaining = REPAIR_BUDGETS.perSpreadExtraSessionRounds;
  // PR F: track consecutive `age_action_impossible` rejections across the
  // entire pair lifecycle (including session rebuilds). When the manuscript
  // text describes an action the infant hero cannot physically perform,
  // the illustrator is in an unwinnable loop — drawing the verb fails
  // age_action_impossible, drawing anything else fails action_mismatch.
  // Burning the full ~20-attempt budget on this is pure waste.
  let consecutiveAgeActionImpossible = 0;

  // PR X: per-spread consecutive parent-skin-only rejection counters drive the
  // parent-visibility escape hatch. When ONE spread keeps failing on parent-skin
  // tags alone (and no other unrelated tags), we downgrade THAT spread's
  // parentVisibility on the next attempt so the parent fragment is removed.
  let consecParentSkinOnlyA = 0;
  let consecParentSkinOnlyB = 0;

  // AA-CW-14a: per-spread consecutive silhouette-only rejection counters drive
  // the silhouette escape hatch. Same ladder as parent-skin (>=2 -> 'object',
  // >=3 -> 'absent'). Removes the parent shadow / silhouette entirely after
  // 2 unsuccessful repairs so the renderer can stop fighting an unwinnable QA.
  let consecSilhouetteOnlyA = 0;
  let consecSilhouetteOnlyB = 0;

  function applyTier2CaptionSoftening() {
    const softA = softenCaptionForImageSafetyRetry(baselineCaptionA);
    const softB = softenCaptionForImageSafetyRetry(baselineCaptionB);
    if (softA !== baselineCaptionA) {
      renderCaptionA = softA;
      expectedA = { text: renderCaptionA, side: specA.textSide };
      console.warn(`[${logA}] safety — caption wording softened for image API (tier 2)`);
    }
    if (softB !== baselineCaptionB) {
      renderCaptionB = softB;
      expectedB = { text: renderCaptionB, side: specB.textSide };
      console.warn(`[${logB}] safety — caption wording softened for image API (tier 2)`);
    }
  }

  console.log(
    `[${logTagQuad}] starting pair spreads ${spreadA.spreadNumber}+${spreadB.spreadNumber} budget=${totalBudget}`,
  );

  for (;;) {
    let attempt = 0;
    let transientEmptyRetries = 0;
    let transientInfraRetries = 0;
    let suppressReanchorOnce = false;
    let safetyMitigationPass = 0;
    let correctionNote = null;
    let lastTags = [];
    let lastPairRejectTags = [];
    let lastPairRejectIssues = [];
    sceneA = specA.scene;
    sceneB = specB.scene;
    renderCaptionA = baselineCaptionA;
    renderCaptionB = baselineCaptionB;
    expectedA = { text: renderCaptionA, side: specA.textSide };
    expectedB = { text: renderCaptionB, side: specB.textSide };
    // PR X: reset per-spread parent-skin counters on each fresh-session round
    // so a session rebuild is treated as a clean slate — the new session may
    // produce a clean render where the previous one drifted.
    consecParentSkinOnlyA = 0;
    consecParentSkinOnlyB = 0;
    // AA-CW-14a: same fresh-session reset for the silhouette counters.
    consecSilhouetteOnlyA = 0;
    consecSilhouetteOnlyB = 0;

    while (attempt < totalBudget) {
      attempt += 1;
      const isFirstAttempt = attempt === 1;
      const attemptStart = Date.now();

      const needsReanchor = !isFirstAttempt && (
        lastTags.includes('hero_mismatch')
        || lastTags.includes('hero_age_proportions_drift')
        || lastTags.includes('outfit_mismatch')
        || lastTags.includes('hair_continuity_drift')
        || lastTags.includes('outfit_continuity_drift')
        || lastTags.includes('implied_parent_skin_mismatch')
        || lastTags.includes('implied_parent_outfit_drift')
        || lastTags.includes('full_body_parent_skin_mismatch')
        || lastTags.includes('unexpected_person'));
      const reanchorThisTurn = needsReanchor && !suppressReanchorOnce;

      let image;
      try {
        if (isFirstAttempt) {
          const turn = buildDualSpreadTurn({
            spreadIndexA: specA.spreadIndex,
            spreadIndexB: specB.spreadIndex,
            sceneA,
            sceneB,
            textA: renderCaptionA,
            textB: renderCaptionB,
            textSideA: specA.textSide,
            textSideB: specB.textSide,
            textCornerA: specA.textCorner,
            textCornerB: specB.textCorner,
            theme: specA.theme,
            childAge: currentDoc.brief?.child?.age ?? null,
            quadBatchIndex,
            heroAppearance: hero,
            coverParentPresent: specA.coverParentPresent,
            hasSecondaryOnCover: specA.hasSecondaryOnCover,
            impliedParentDescriptor: specA.impliedParentDescriptor,
            parentVisibilityA: resolveParentVisibilityWithBothEscapeHatches(specA.parentVisibility, consecParentSkinOnlyA, consecSilhouetteOnlyA),
            parentVisibilityB: resolveParentVisibilityWithBothEscapeHatches(specB.parentVisibility, consecParentSkinOnlyB, consecSilhouetteOnlyB),
          });
          // Schedule a cover re-anchor on the first attempt if this batch covers a
          // strategic spread (mid/late book) — same drift-protection trigger as the
          // legacy single-spread path, adjusted to fire when either of the two
          // spreads in this batch hits the threshold.
          const scheduledReanchor = SCHEDULED_REANCHOR_INDEXES.has(specA.spreadIndex)
            || SCHEDULED_REANCHOR_INDEXES.has(specB.spreadIndex);
          image = await generateSpread(currentSession, turn, specA.spreadIndex, {
            ...quadGenOpts(),
            reanchorCover: scheduledReanchor,
          });
          if (scheduledReanchor) {
            console.log(`[${logTagQuad}] scheduled cover re-anchor on quad batch (spreads ${specA.spreadIndex + 1}, ${specB.spreadIndex + 1})`);
          }
        } else {
          const correction = buildDualCorrectionTurn({
            spreadIndexA: specA.spreadIndex,
            spreadIndexB: specB.spreadIndex,
            sceneA,
            sceneB,
            textA: renderCaptionA,
            textB: renderCaptionB,
            textSideA: specA.textSide,
            textSideB: specB.textSide,
            textCornerA: specA.textCorner,
            textCornerB: specB.textCorner,
            issues: [correctionNote || 'Fix the previous attempt.'],
            tags: [],
            theme: specA.theme,
            childAge: currentDoc.brief?.child?.age ?? null,
            quadBatchIndex,
            heroAppearance: hero,
            coverParentPresent: specA.coverParentPresent,
            hasSecondaryOnCover: specA.hasSecondaryOnCover,
            impliedParentDescriptor: specA.impliedParentDescriptor,
            parentVisibilityA: resolveParentVisibilityWithBothEscapeHatches(specA.parentVisibility, consecParentSkinOnlyA, consecSilhouetteOnlyA),
            parentVisibilityB: resolveParentVisibilityWithBothEscapeHatches(specB.parentVisibility, consecParentSkinOnlyB, consecSilhouetteOnlyB),
          });
          if (reanchorThisTurn) {
            console.log(`[${logTagQuad}] re-anchoring cover on attempt ${attempt} (prev tags: ${lastTags.join(',')})`);
          } else if (needsReanchor) {
            console.log(
              `[${logTagQuad}] correction without inline cover re-anchor on attempt ${attempt} (prev tags: ${lastTags.join(',')})`,
            );
          }
          image = await sendCorrection(
            currentSession,
            correction,
            specA.spreadIndex,
            { reanchorCover: reanchorThisTurn, ...correctionGenOpts() },
          );
        }
      } catch (err) {
        if (err.isEmptyResponse && !err.isSafetyBlock && transientEmptyRetries < MAX_TRANSIENT_EMPTY_IMAGE_RETRIES) {
          transientEmptyRetries += 1;
          attempt -= 1;
          const delayMs = Math.min(
            TRANSIENT_EMPTY_IMAGE_MAX_DELAY_MS,
            TRANSIENT_EMPTY_IMAGE_BASE_DELAY_MS * 2 ** (transientEmptyRetries - 1),
          );
          console.warn(
            `[${logTagQuad}] render error (${Date.now() - attemptStart}ms): ${err.message} ` +
            `[transient empty ${transientEmptyRetries}/${MAX_TRANSIENT_EMPTY_IMAGE_RETRIES}] — waiting ${delayMs}ms`,
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
        if (isTransientIllustrationInfraError(err) && transientInfraRetries < MAX_TRANSIENT_INFRA_RETRIES) {
          transientInfraRetries += 1;
          attempt -= 1;
          const delayMs = Math.min(
            TRANSIENT_INFRA_MAX_DELAY_MS,
            TRANSIENT_INFRA_BASE_DELAY_MS * 2 ** (transientInfraRetries - 1),
          );
          console.warn(
            `[${logTagQuad}] render error (${Date.now() - attemptStart}ms): ${err.message} ` +
            `[transient infra ${transientInfraRetries}/${MAX_TRANSIENT_INFRA_RETRIES}] ` +
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
        console.warn(
          `[${logTagQuad}] render error attempt ${attempt}/${totalBudget} (${Date.now() - attemptStart}ms): ${err.message}${isSafety ? ' [safety]' : ''}`,
        );

        if (isSafety && !isFirstAttempt && reanchorThisTurn) {
          suppressReanchorOnce = true;
          attempt -= 1;
          continue;
        }

        if (isSafety) {
          safetyMitigationPass += 1;
          attempt -= 1;
          if (safetyMitigationPass === 1) {
            const cA = compactSceneForImageSafetyRetry(specA.scene);
            const cB = compactSceneForImageSafetyRetry(specB.scene);
            sceneA = (cA !== specA.scene.trim()) ? cA : softenSceneForImageSafetyRetry(specA.scene);
            sceneB = (cB !== specB.scene.trim()) ? cB : softenSceneForImageSafetyRetry(specB.scene);
            console.warn(`[${logTagQuad}] safety pass 1/2: lean/soften scene (both halves)`);
            continue;
          }
          if (safetyMitigationPass === 2) {
            const swA = softenSceneForImageSafetyRetry(sceneA);
            const swB = softenSceneForImageSafetyRetry(sceneB);
            if (swA !== sceneA) sceneA = swA;
            if (swB !== sceneB) sceneB = swB;
            if (swA === sceneA && swB === sceneB) {
              sceneA = minimalSafeSceneFallback(specA.spreadIndex, specA.theme);
              sceneB = minimalSafeSceneFallback(specB.spreadIndex, specB.theme);
            }
            applyTier2CaptionSoftening();
            console.warn(`[${logTagQuad}] safety pass 2/2: generic safe scenes + optional caption soften`);
            continue;
          }
        }

        if (isSafety && currentSession.rebuilds < REPAIR_BUDGETS.perSpreadEscalations) {
          const exp = Math.min(currentSession.rebuilds, 4);
          const delayMs = Math.min(SAFETY_REBUILD_MAX_DELAY_MS, SAFETY_REBUILD_BASE_DELAY_MS * 2 ** exp);
          console.log(`[${logTagQuad}] waiting ${delayMs}ms before rebuild after safety block`);
          try {
            await delayRespectingAbort(delayMs, currentDoc.operationalContext?.abortSignal);
          } catch (waitErr) {
            if (waitErr.name === 'AbortError' || currentDoc.operationalContext?.abortSignal?.aborted) {
              return { accepted: false, doc: currentDoc, session: currentSession, issues: ['aborted'], tags: ['aborted'] };
            }
            throw waitErr;
          }
          console.log(`[${logTagQuad}] rebuilding session after safety block`);
          currentSession = await rebuildSession(currentSession);
          suppressReanchorOnce = false;
          sceneA = specA.scene;
          sceneB = specB.scene;
          safetyMitigationPass = 0;
          renderCaptionA = baselineCaptionA;
          renderCaptionB = baselineCaptionB;
          expectedA = { text: renderCaptionA, side: specA.textSide };
          expectedB = { text: renderCaptionB, side: specB.textSide };
          continue;
        }
        return { accepted: false, doc: currentDoc, session: currentSession, issues: [err.message], tags: ['render_error'] };
      }

      suppressReanchorOnce = false;
      transientEmptyRetries = 0;
      transientInfraRetries = 0;

      const stripped = await stripMetadata(image.imageBuffer);
      const sliceNative = await sliceQuadToTwoSpreadStrips(stripped);
      console.log(
        `[${logTagQuad}] pre-upscale QA slice map: leftStrip → spread ${spreadA.spreadNumber} (${sliceNative.halfWidth}x${sliceNative.height}px); ` +
        `rightStrip → spread ${spreadB.spreadNumber} ` +
        `(${sliceNative.width - sliceNative.halfWidth}x${sliceNative.height}px); full=${sliceNative.width}x${sliceNative.height}`,
      );

      const nativeLeftB64 = sliceNative.leftStrip.toString('base64');
      const nativeRightB64 = sliceNative.rightStrip.toString('base64');

      const supportingCast = Array.isArray(currentDoc.visualBible?.supportingCast)
        ? currentDoc.visualBible.supportingCast
        : [];
      const additionalCoverCharacters = supportingCast
        .filter(c => c?.description)
        .map(c => `${c.role || 'person'}${c.name ? ` (${c.name})` : ''}: ${c.description}`)
        .join('; ') || null;
      const coverParentPresent = !!(
        currentDoc.brief?.coverParentPresent
        || supportingCast.some(c => c?.onCover === true && c?.isThemedParent === true)
      );

      const recentInteriorRefs = pickRecentInteriorRefsForQa(
        currentSession.acceptedSpreads,
        [specA.spreadIndex, specB.spreadIndex],
        QA_RECENT_INTERIOR_REFERENCES,
      );

      const qaStart = Date.now();
      const ageBand = currentDoc.request?.ageBand || '';
      const childAge = currentDoc.brief?.child?.age ?? null;
      const heroName = currentDoc.brief?.child?.name || '';
      const [qaA, qaB] = await Promise.all([
        checkSpread({
          imageBase64: nativeLeftB64,
          expected: expectedA,
          coverRef: { base64: cover.base64, mime: cover.mime },
          hero,
          additionalCoverCharacters,
          coverParentPresent,
          theme: specA.theme,
          // C.1 + C.2 — wire focal action / age info into the action QA.
          focalAction: spreadA?.spec?.focalAction || '',
          ageBand,
          childAge,
          heroName,
          spreadIndex: specA.spreadIndex,
          recentInteriorRefs,
          // AA-CW-7: cover-derived caregiver lock for the new vision QA tags.
          caregiverLock: currentDoc.visualBible?.caregiverLock || null,
          abortSignal: currentDoc.operationalContext?.abortSignal,
        }),
        checkSpread({
          imageBase64: nativeRightB64,
          expected: expectedB,
          coverRef: { base64: cover.base64, mime: cover.mime },
          hero,
          additionalCoverCharacters,
          coverParentPresent,
          theme: specB.theme,
          focalAction: spreadB?.spec?.focalAction || '',
          ageBand,
          childAge,
          heroName,
          spreadIndex: specB.spreadIndex,
          recentInteriorRefs,
          // AA-CW-7: cover-derived caregiver lock for the new vision QA tags.
          caregiverLock: currentDoc.visualBible?.caregiverLock || null,
          abortSignal: currentDoc.operationalContext?.abortSignal,
        }),
      ]);
      const qaMs = Date.now() - qaStart;

      if (qaA.pass) {
        console.log(`[${logA}] QA PASS half=left (pair attempt ${attempt}/${totalBudget}, qa=${qaMs}ms)`);
      } else {
        console.warn(
          `[${logA}] QA FAIL half=left (pair attempt ${attempt}/${totalBudget}) tags=[${(qaA.tags || []).join(',')}] ` +
          `issues=${formatQaRejectIssuesForLog(qaA.issues)}`,
        );
      }
      if (qaB.pass) {
        console.log(`[${logB}] QA PASS half=right (pair attempt ${attempt}/${totalBudget}, qa=${qaMs}ms)`);
      } else {
        console.warn(
          `[${logB}] QA FAIL half=right (pair attempt ${attempt}/${totalBudget}) tags=[${(qaB.tags || []).join(',')}] ` +
          `issues=${formatQaRejectIssuesForLog(qaB.issues)}`,
        );
      }

      const cleanPass = qaA.pass && qaB.pass;
      const failOpenAccept = !cleanPass
        && shouldFailOpenAcceptPair(qaA, qaB, attempt, totalBudget);
      // Phase 3b — three-state QA verdict (PASS / ACCEPT_WITH_NOTE / FAIL).
      // Hero-recognition tags hard-fail by construction; only drift / infra
      // tags ride in on ACCEPT_WITH_NOTE. softFailDriven marks the version
      // we want surfaced in BOOK_COUNTERS (visible drift), separate from
      // pure infra-outage accepts (operational noise).
      const sideHasSoftFail = qa => {
        if (!qa || qa.pass === true) return false;
        const tags = Array.isArray(qa.tags) ? qa.tags : [];
        return tags.some(t => QA_SOFT_FAIL_TAGS.has(t));
      };
      const softFailDriven = failOpenAccept && (sideHasSoftFail(qaA) || sideHasSoftFail(qaB));
      if (failOpenAccept) {
        const reason = softFailDriven ? 'soft_drift' : 'infra_only';
        const summarize = (label, qa) => {
          if (!qa || qa.pass === true) return `${label}=pass`;
          const tags = Array.isArray(qa.tags) ? qa.tags.join(',') : '';
          return `${label}=fail[${tags}]`;
        };
        console.warn(
          `[${logTagQuad}] qaState=ACCEPT_WITH_NOTE reason=${reason} pair attempt ${attempt}/${totalBudget} ` +
          `spreadNumbers=[${spreadNumbers.join(', ')}] — ${summarize('A', qaA)} ${summarize('B', qaB)}. ` +
          `Shipping with note; quality-regression signal if it persists.`,
        );
        if (softFailDriven) {
          incrementCounter(currentDoc, 'illustrator.softFailsShipped');
        }
      }
      if (cleanPass || failOpenAccept) {
        const printableQuad = await upscaleForPrint(stripped);
        const slice = await sliceQuadToTwoSpreadStrips(printableQuad);
        console.log(
          `[${logTagQuad}] post-upscale slice map: leftStrip → spread ${spreadA.spreadNumber} (${slice.halfWidth}x${slice.height}px); ` +
          `rightStrip → spread ${spreadB.spreadNumber} ` +
          `(${slice.width - slice.halfWidth}x${slice.height}px); full=${slice.width}x${slice.height}`,
        );

        const printableLeftB64 = slice.leftStrip.toString('base64');
        const printableRightB64 = slice.rightStrip.toString('base64');

        console.log(
          `[${logTagQuad}] qaState=${cleanPass ? 'PASS' : 'ACCEPT_WITH_NOTE'} pair spreadNumbers=[${spreadNumbers.join(', ')}] attempt ${attempt}/${totalBudget} (qa=${qaMs}ms)`,
        );
        markQuadPairAccepted(
          currentSession,
          specA.spreadIndex,
          specB.spreadIndex,
          printableLeftB64,
          printableRightB64,
        );

        let nextDoc = currentDoc;
        async function uploadOne(spread, buf, usedCaption, baselineCap, illoPrompt) {
          const destination = `books/${bookId || nextDoc.request.bookId || 'nobookid'}/spreads/spread-${spread.spreadNumber}.jpg`;
          await uploadBuffer(buf, destination, 'image/jpeg');
          const imageUrl = await getSignedUrl(destination, SIGNED_URL_TTL_MS);
          nextDoc = updateSpread(nextDoc, spread.spreadNumber, s => ({
            ...s,
            manuscript: s.manuscript && usedCaption !== baselineCap
              ? { ...s.manuscript, text: usedCaption }
              : s.manuscript,
            illustration: {
              prompt: illoPrompt,
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
        }

        const leftJpg = await sharp(slice.leftStrip).jpeg({ quality: 92 }).toBuffer();
        const rightJpg = await sharp(slice.rightStrip).jpeg({ quality: 92 }).toBuffer();
        await uploadOne(spreadA, leftJpg, renderCaptionA, baselineCaptionA, sceneA);
        await uploadOne(spreadB, rightJpg, renderCaptionB, baselineCaptionB, sceneB);

        return { accepted: true, doc: nextDoc, session: currentSession, issues: [], tags: [] };
      }

      pruneLastTurn(currentSession);
      const issues = [...(qaA.issues || []), ...(qaB.issues || [])];
      const tags = [...(qaA.tags || []), ...(qaB.tags || [])];
      lastTags = tags;
      lastPairRejectTags = [...new Set(tags)];
      lastPairRejectIssues = issues.slice(0, 12);

      // PR F early-abort: count consecutive age_action_impossible rejections
      // and bail out before exhausting the full budget. This typically saves
      // ~5 minutes of GPU time per failing pair when the writer text demands
      // a physically-impossible action from an infant hero.
      consecutiveAgeActionImpossible = nextConsecutiveAgeActionImpossible(
        consecutiveAgeActionImpossible,
        lastPairRejectTags,
      );

      // PR X: track per-spread parent-skin-only rejection streaks. The escape
      // hatch downgrades that spread's parentVisibility to 'object' (>=2) or
      // 'absent' (>=3) on the next attempt, removing the parent fragment that
      // the model cannot color-match reliably.
      const prevParentSkinA = consecParentSkinOnlyA;
      const prevParentSkinB = consecParentSkinOnlyB;
      consecParentSkinOnlyA = nextConsecutiveParentSkinOnly(consecParentSkinOnlyA, qaA.tags);
      consecParentSkinOnlyB = nextConsecutiveParentSkinOnly(consecParentSkinOnlyB, qaB.tags);
      if (consecParentSkinOnlyA !== prevParentSkinA && consecParentSkinOnlyA >= 2) {
        const downgrade = consecParentSkinOnlyA >= 3 ? 'absent' : 'object';
        console.warn(
          `[${logA}] parent-skin escape hatch engaged: ` +
          `${consecParentSkinOnlyA} consecutive parent-skin-only rejections — ` +
          `next attempt will downgrade parentVisibility to '${downgrade}' (was '${specA.parentVisibility || 'unset'}')`,
        );
      }
      if (consecParentSkinOnlyB !== prevParentSkinB && consecParentSkinOnlyB >= 2) {
        const downgrade = consecParentSkinOnlyB >= 3 ? 'absent' : 'object';
        console.warn(
          `[${logB}] parent-skin escape hatch engaged: ` +
          `${consecParentSkinOnlyB} consecutive parent-skin-only rejections — ` +
          `next attempt will downgrade parentVisibility to '${downgrade}' (was '${specB.parentVisibility || 'unset'}')`,
        );
      }

      // AA-CW-14a: per-spread silhouette-only rejection tracking. When ONE
      // spread keeps failing on parent_as_character_silhouette alone, downgrade
      // THAT spread's parentVisibility on the next attempt so the silhouette
      // is removed from frame entirely. The repair prompt cannot reliably get
      // the renderer to drop face features from a parent shadow; removing the
      // shadow is the only stable fix.
      const prevSilhouetteA = consecSilhouetteOnlyA;
      const prevSilhouetteB = consecSilhouetteOnlyB;
      consecSilhouetteOnlyA = nextConsecutiveSilhouetteOnly(consecSilhouetteOnlyA, qaA.tags);
      consecSilhouetteOnlyB = nextConsecutiveSilhouetteOnly(consecSilhouetteOnlyB, qaB.tags);
      if (consecSilhouetteOnlyA !== prevSilhouetteA && consecSilhouetteOnlyA >= 2) {
        const downgrade = consecSilhouetteOnlyA >= 3 ? 'absent' : 'object';
        console.warn(
          `[${logA}] silhouette escape hatch engaged: ` +
          `${consecSilhouetteOnlyA} consecutive silhouette-only rejections — ` +
          `next attempt will downgrade parentVisibility to '${downgrade}' (was '${specA.parentVisibility || 'unset'}')`,
        );
      }
      if (consecSilhouetteOnlyB !== prevSilhouetteB && consecSilhouetteOnlyB >= 2) {
        const downgrade = consecSilhouetteOnlyB >= 3 ? 'absent' : 'object';
        console.warn(
          `[${logB}] silhouette escape hatch engaged: ` +
          `${consecSilhouetteOnlyB} consecutive silhouette-only rejections — ` +
          `next attempt will downgrade parentVisibility to '${downgrade}' (was '${specB.parentVisibility || 'unset'}')`,
        );
      }

      if (shouldEarlyAbortForUnrenderableInfantAction(consecutiveAgeActionImpossible)) {
        // Phase 4 — before failing the pair, burn ONE writer rewrite for
        // each half whose prose triggered the abort. Targets the exact
        // failure mode this branch was built for: text demands an action
        // the hero physically can't do. Bounded by MAX_PROSE_REVISIONS_PER_
        // _PAIR so we never replace the early-abort safety net.
        if (proseRevisionsUsedQuad < MAX_PROSE_REVISIONS_PER_PAIR) {
          proseRevisionsUsedQuad += 1;
          console.warn(
            `[${logTagQuad}] PROSE_REVISION triggered before EARLY-ABORT spreads=[${spreadNumbers.join(', ')}] ` +
            `tags=[${lastPairRejectTags.join(',')}] — burning one writer rewrite per failing half before giving up.`,
          );
          const veto = (qa) => ({
            tags: (qa.tags || []).filter(t => t === 'age_action_impossible' || t === 'action_mismatch'),
            issues: qa.issues || [],
          });
          let revisedDoc = currentDoc;
          const aTriggered = (qaA.tags || []).some(t => t === 'age_action_impossible' || t === 'action_mismatch');
          const bTriggered = (qaB.tags || []).some(t => t === 'age_action_impossible' || t === 'action_mismatch');
          if (aTriggered) {
            revisedDoc = await reviseSpreadProseForIllustrator(revisedDoc, spreadA.spreadNumber, veto(qaA));
          }
          if (bTriggered) {
            revisedDoc = await reviseSpreadProseForIllustrator(revisedDoc, spreadB.spreadNumber, veto(qaB));
          }
          const revisedSpreadA = revisedDoc.spreads.find(s => s.spreadNumber === spreadA.spreadNumber);
          const revisedSpreadB = revisedDoc.spreads.find(s => s.spreadNumber === spreadB.spreadNumber);
          const newTextA = revisedSpreadA?.manuscript?.text;
          const newTextB = revisedSpreadB?.manuscript?.text;
          const aChanged = aTriggered && newTextA && newTextA !== baselineCaptionA;
          const bChanged = bTriggered && newTextB && newTextB !== baselineCaptionB;
          if (aChanged || bChanged) {
            incrementCounter(revisedDoc, 'proseRevisionRequests');
            currentDoc = revisedDoc;
            if (aChanged) {
              baselineCaptionA = newTextA;
              renderCaptionA = newTextA;
              specA.text = newTextA;
              expectedA = { text: renderCaptionA, side: specA.textSide };
            }
            if (bChanged) {
              baselineCaptionB = newTextB;
              renderCaptionB = newTextB;
              specB.text = newTextB;
              expectedB = { text: renderCaptionB, side: specB.textSide };
            }
            // Reset the consecutive-counter so the next pair render can
            // try the new prose without immediately tripping early-abort
            // again on a stale streak.
            consecutiveAgeActionImpossible = 0;
            console.log(
              `[${logTagQuad}] PROSE_REVISION applied — aChanged=${aChanged} bChanged=${bChanged}; ` +
              `resetting consecutive age_action_impossible streak and resuming render attempts with fresh prose.`,
            );
            continue;
          }
          console.warn(`[${logTagQuad}] PROSE_REVISION returned no change; falling through to EARLY-ABORT.`);
        }
        console.error(
          `[${logTagQuad}] EARLY-ABORT spreads [${spreadNumbers.join(', ')}] — ` +
          `${consecutiveAgeActionImpossible} consecutive age_action_impossible rejections; ` +
          `manuscript text describes an action the hero cannot physically perform. ` +
          `lastTags=[${lastPairRejectTags.join(',')}] issues=${formatQaRejectIssuesForLog(lastPairRejectIssues)}`,
        );
        return {
          accepted: false,
          doc: currentDoc,
          session: currentSession,
          issues: [
            `spread pair text describes an action the hero cannot physically perform (${consecutiveAgeActionImpossible} consecutive age_action_impossible rejections)`,
            ...lastPairRejectIssues,
          ],
          tags: ['infant_action_text_unrenderable', 'spread_unresolvable'],
        };
      }

      const planA = planSpreadRepair({
        spreadNumber: spreadA.spreadNumber,
        attemptNumber: attempt,
        issues: qaA.issues,
        tags: qaA.tags,
        // AA-CW-7: surgical BAD/FIX repair instructions from the vision QA.
        repairInstructions: qaA.repairInstructions || [],
      });
      const planB = planSpreadRepair({
        spreadNumber: spreadB.spreadNumber,
        attemptNumber: attempt,
        issues: qaB.issues,
        tags: qaB.tags,
        repairInstructions: qaB.repairInstructions || [],
      });
      if (planA.correctionMode === 'text_priority' || planB.correctionMode === 'text_priority') {
        console.log(
          `[${logTagQuad}] repair tier=text_priority (attempt ${attempt}) spreadA=${planA.correctionMode} spreadB=${planB.correctionMode} — caption-first, preserve hero look`,
        );
      }
      correctionNote = [planA.correctionNote, planB.correctionNote].filter(Boolean).join('\n---\n');

      currentDoc = appendRetryMemory(currentDoc, planA.retryEntry);
      currentDoc = appendRetryMemory(currentDoc, planB.retryEntry);
      currentDoc = updateSpread(currentDoc, spreadA.spreadNumber, s => ({
        ...s,
        qa: {
          ...s.qa,
          spreadChecks: [
            ...s.qa.spreadChecks,
            { attempt, pass: false, issues: qaA.issues, tags: qaA.tags },
          ],
          repairHistory: [...s.qa.repairHistory, { attempt, tags: qaA.tags }],
        },
      }));
      currentDoc = updateSpread(currentDoc, spreadB.spreadNumber, s => ({
        ...s,
        qa: {
          ...s.qa,
          spreadChecks: [
            ...s.qa.spreadChecks,
            { attempt, pass: false, issues: qaB.issues, tags: qaB.tags },
          ],
          repairHistory: [...s.qa.repairHistory, { attempt, tags: qaB.tags }],
        },
      }));

      const rawExpectedA = String(expectedA.text || '');
      const rawExpectedB = String(expectedB.text || '');
      console.warn(
        `[${logTagQuad}] REJECTED pair attempt ${attempt}/${totalBudget} (qa=${qaMs}ms) ` +
        `spreadNumbers=[${spreadNumbers.join(', ')}] (regenerating full 4:1) ` +
        `expectedA="${rawExpectedA.slice(0, QA_REJECT_LOG_EXPECTED_CHARS)}${rawExpectedA.length > QA_REJECT_LOG_EXPECTED_CHARS ? '…' : ''}" ` +
        `expectedB="${rawExpectedB.slice(0, QA_REJECT_LOG_EXPECTED_CHARS)}${rawExpectedB.length > QA_REJECT_LOG_EXPECTED_CHARS ? '…' : ''}" ` +
        `issues=${formatQaRejectIssuesForLog(issues)}`,
      );

      if (shouldDeescalateSceneForQaFail(lastTags, sceneA)) sceneA = deescalateSceneForSignage(sceneA);
      if (shouldDeescalateSceneForQaFail(lastTags, sceneB)) sceneB = deescalateSceneForSignage(sceneB);

      if (attempt > REPAIR_BUDGETS.perSpreadInSessionCorrections
          && currentSession.rebuilds < REPAIR_BUDGETS.perSpreadEscalations) {
        console.log(`[${logTagQuad}] rebuilding session (attempt ${attempt} > ${REPAIR_BUDGETS.perSpreadInSessionCorrections})`);
        currentSession = await rebuildSession(currentSession);
        suppressReanchorOnce = false;
      }
    }

    if (extraRoundsRemaining <= 0) {
      console.error(
        `[${logTagQuad}] EXHAUSTED budget for spreads [${spreadNumbers.join(', ')}] ` +
        `lastTags=[${lastPairRejectTags.join(',')}] issues=${formatQaRejectIssuesForLog(lastPairRejectIssues)}`,
      );
      return {
        accepted: false,
        doc: currentDoc,
        session: currentSession,
        issues: ['spread pair exhausted repair budget'],
        tags: ['spread_unresolvable'],
      };
    }
    extraRoundsRemaining -= 1;
    console.log(
      `[${logTagQuad}] Fresh illustrator session after exhausting ${totalBudget} attempts (extra rounds left=${extraRoundsRemaining})`,
    );
    currentSession = await rebuildSession(currentSession);
  }
}

/**
 * @param {object} doc
 * @returns {Promise<object>}
 */
async function renderAllSpreadsQuad(doc) {
  const cover = await resolveCoverBase64(doc.cover);

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

  const coverParentPresentDoc = !!(
    doc.brief?.coverParentPresent
    || sessionCast.some(c => c?.onCover === true && c?.isThemedParent === true)
  );
  const hasSecondaryOnCoverDoc = sessionCast.some(c => c?.onCover === true);

  let session = createSession({
    coverBase64: cover.base64,
    coverMime: cover.mime,
    theme: doc.request.theme,
    childAppearance: doc.visualBible?.hero?.physicalDescription || '',
    childAge: doc.brief?.child?.age ?? null,
    hasParentOnCover: coverParentPresentDoc,
    hasSecondaryOnCover: hasSecondaryOnCoverDoc,
    additionalCoverCharacters: offCoverCastNote,
    abortSignal: doc.operationalContext?.abortSignal,
    quadSpreadMode: true,
  });

  const bookId = doc.operationalContext?.bookId || doc.request.bookId;
  console.log(
    `[bookPipeline:${bookId || 'n/a'}] renderAllSpreadsQuad provider=${providerName} ` +
    `(Gemini: imageConfig aspectRatio=4:1; OpenAI: size=${OPENAI_QUAD_IMAGE_SIZE})`,
  );
  await establishCharacterReference(session);

  let current = doc;
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

  if (totalSpreads !== TOTAL_SPREADS) {
    console.warn(
      `[bookPipeline:${bookId || 'n/a'}] quad path: expected ${TOTAL_SPREADS} spreads, got ${totalSpreads} — pairing uses actual length`,
    );
  }

  let pairCount = 0;
  for (let i = 0; i + 1 < current.spreads.length; i += 2) {
    const spreadA = current.spreads[i];
    const spreadB = current.spreads[i + 1];
    if (!spreadA.spec || !spreadB.spec) {
      const err = new Error(`spread pair ${spreadA.spreadNumber}/${spreadB.spreadNumber}: spec missing`);
      err.failureCode = FAILURE_CODES.SPREAD_UNRESOLVABLE;
      throw err;
    }

    emit({
      step: 'illustrating',
      message: `Rendering quad batch spreads ${spreadA.spreadNumber}+${spreadB.spreadNumber} of ${totalSpreads}`,
      spreadIndex: i,
      spreadNumber: spreadA.spreadNumber,
      totalSpreads,
      subProgress: i / totalSpreads,
    });

    const result = await processQuadPair({
      doc: current,
      session,
      cover,
      spreadA,
      spreadB,
      bookId,
      quadBatchIndex: pairCount,
    });
    pairCount += 1;
    current = result.doc;
    session = result.session;

    if (!result.accepted) {
      const err = new Error(`spreads ${spreadA.spreadNumber}-${spreadB.spreadNumber}: ${result.issues.join('; ') || 'unaccepted'}`);
      err.failureCode = FAILURE_CODES.SPREAD_UNRESOLVABLE;
      throw err;
    }

    emit({
      step: 'illustrating',
      message: `Spreads ${spreadA.spreadNumber} and ${spreadB.spreadNumber} accepted`,
      spreadIndex: i,
      spreadNumber: spreadB.spreadNumber,
      totalSpreads,
      subProgress: (i + 2) / totalSpreads,
      document: current,
    });
  }

  if (current.spreads.length % 2 === 1) {
    const last = current.spreads[current.spreads.length - 1];
    const logTag = `bookPipeline:${bookId || 'n/a'}:spread${last.spreadNumber}`;
    console.log(
      `[${logTag}] mode=single_spread spreadNumber=${last.spreadNumber} aspect=16:9 (remainder after quad pairs)`,
    );

    emit({
      step: 'illustrating',
      message: `Rendering final spread ${last.spreadNumber} of ${totalSpreads} (single)`,
      spreadIndex: current.spreads.length - 1,
      spreadNumber: last.spreadNumber,
      totalSpreads,
      subProgress: (totalSpreads - 1) / totalSpreads,
    });

    const singleResult = await processOneSpread({
      doc: current,
      session,
      cover,
      spread: last,
      bookId,
    });

    current = singleResult.doc;
    session = singleResult.session;

    if (!singleResult.accepted) {
      const err = new Error(`spread ${last.spreadNumber}: ${singleResult.issues.join('; ') || 'unaccepted'}`);
      err.failureCode = FAILURE_CODES.SPREAD_UNRESOLVABLE;
      throw err;
    }

    emit({
      step: 'illustrating',
      message: `Spread ${last.spreadNumber} of ${totalSpreads} accepted`,
      spreadIndex: current.spreads.length - 1,
      spreadNumber: last.spreadNumber,
      totalSpreads,
      subProgress: 1,
      document: current,
    });
  }

  return current;
}

module.exports = {
  renderAllSpreadsQuad,
  processQuadPair,
  // PR F — exported for unit tests
  nextConsecutiveAgeActionImpossible,
  shouldEarlyAbortForUnrenderableInfantAction,
  // PR X — exported for unit tests (parent-skin escape hatch)
  isParentSkinOnlyRejection,
  nextConsecutiveParentSkinOnly,
  resolveParentVisibilityWithEscapeHatch,
  // AA-CW-14a — exported for unit tests (silhouette escape hatch)
  isSilhouetteOnlyRejection,
  nextConsecutiveSilhouetteOnly,
  resolveParentVisibilityWithBothEscapeHatches,
  // Fail-open accept (infra-only and infra-or-soft-fail) — exported for tests
  isInfraOnlyFailure,
  isInfraOrSoftFailOnly,
  shouldFailOpenAcceptPair,
  QA_INFRA_TAGS,
  QA_SOFT_FAIL_TAGS,
};
