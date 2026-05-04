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
const { updateSpread, appendRetryMemory } = require('../schema/bookDocument');
const { processOneSpread, resolveCoverBase64, formatQaRejectIssuesForLog } = require('./renderAllSpreads');

const SIGNED_URL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const QA_REJECT_LOG_EXPECTED_CHARS = 500;

/**
 * Spread indexes (0-based) at which the first attempt re-attaches the cover image.
 * Mirrors `SCHEDULED_REANCHOR_INDEXES` in renderAllSpreads.js. In the quad path
 * a batch covers TWO spreads (e.g. spreads 5 + 6 = indexes 4, 5); we re-anchor
 * a batch when EITHER of its two spread indexes is in this set.
 */
const SCHEDULED_REANCHOR_INDEXES = new Set([4, 8, 11]);

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
  const baselineCaptionA = specA.text;
  const baselineCaptionB = specB.text;
  let renderCaptionA = baselineCaptionA;
  let renderCaptionB = baselineCaptionB;
  let expectedA = { text: renderCaptionA, side: specA.textSide };
  let expectedB = { text: renderCaptionB, side: specB.textSide };

  let sceneA = specA.scene;
  let sceneB = specB.scene;

  const totalBudget = REPAIR_BUDGETS.perSpreadInSessionCorrections + REPAIR_BUDGETS.perSpreadPromptRepairs;
  let currentDoc = doc;
  let currentSession = session;
  const hero = currentDoc.visualBible?.hero?.physicalDescription || '';
  let extraRoundsRemaining = REPAIR_BUDGETS.perSpreadExtraSessionRounds;

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

    while (attempt < totalBudget) {
      attempt += 1;
      const isFirstAttempt = attempt === 1;
      const attemptStart = Date.now();

      const needsReanchor = !isFirstAttempt && (
        lastTags.includes('hero_mismatch')
        || lastTags.includes('outfit_mismatch')
        || lastTags.includes('hair_continuity_drift')
        || lastTags.includes('outfit_continuity_drift')
        || lastTags.includes('implied_parent_skin_mismatch')
        || lastTags.includes('implied_parent_outfit_drift'));
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
            parentVisibilityA: specA.parentVisibility,
            parentVisibilityB: specB.parentVisibility,
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
            parentVisibilityA: specA.parentVisibility,
            parentVisibilityB: specB.parentVisibility,
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
      const [qaA, qaB] = await Promise.all([
        checkSpread({
          imageBase64: nativeLeftB64,
          expected: expectedA,
          coverRef: { base64: cover.base64, mime: cover.mime },
          hero,
          additionalCoverCharacters,
          coverParentPresent,
          spreadIndex: specA.spreadIndex,
          recentInteriorRefs,
          abortSignal: currentDoc.operationalContext?.abortSignal,
        }),
        checkSpread({
          imageBase64: nativeRightB64,
          expected: expectedB,
          coverRef: { base64: cover.base64, mime: cover.mime },
          hero,
          additionalCoverCharacters,
          coverParentPresent,
          spreadIndex: specB.spreadIndex,
          recentInteriorRefs,
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

      if (qaA.pass && qaB.pass) {
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
          `[${logTagQuad}] ACCEPTED pair spreadNumbers=[${spreadNumbers.join(', ')}] attempt ${attempt}/${totalBudget} (qa=${qaMs}ms)`,
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

      const planA = planSpreadRepair({
        spreadNumber: spreadA.spreadNumber,
        attemptNumber: attempt,
        issues: qaA.issues,
        tags: qaA.tags,
      });
      const planB = planSpreadRepair({
        spreadNumber: spreadB.spreadNumber,
        attemptNumber: attempt,
        issues: qaB.issues,
        tags: qaB.tags,
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

module.exports = { renderAllSpreadsQuad, processQuadPair };
