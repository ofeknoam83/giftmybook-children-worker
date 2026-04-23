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
 *                     -> after N corrections, rebuildSession (once per book)
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
} = require('../../illustrator/session');
const {
  buildSpreadTurn,
  buildCorrectionTurn,
  deescalateSceneForSignage,
  shouldDeescalateSceneForQaFail,
} = require('../../illustrator/prompt');
const { stripMetadata } = require('../../illustrator/postprocess/strip');
const { upscaleForPrint } = require('../../illustrator/postprocess/upscale');
const { uploadBuffer, getSignedUrl } = require('../../gcsStorage');

const { checkSpread } = require('../qa/checkSpread');
const { planSpreadRepair } = require('../qa/planRepair');
const { buildIllustrationSpec } = require('./buildIllustrationSpec');
const { REPAIR_BUDGETS, FAILURE_CODES } = require('../constants');
const { updateSpread, appendRetryMemory } = require('../schema/bookDocument');

const SIGNED_URL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
  if (!cover.imageUrl) throw new Error('cover missing both imageBase64 and imageUrl');

  const resp = await fetch(cover.imageUrl);
  if (!resp.ok) throw new Error(`cover fetch failed: HTTP ${resp.status}`);
  const arrayBuffer = await resp.arrayBuffer();
  const buf = Buffer.from(arrayBuffer);
  const resized = await sharp(buf)
    .resize({ width: 512, withoutEnlargement: true })
    .jpeg({ quality: 85 })
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
  let currentDoc = doc;
  let currentSession = session;

  const spec = buildIllustrationSpec(currentDoc, spread);
  const expected = { text: spec.text, side: spec.textSide };
  const hero = currentDoc.visualBible?.hero?.physicalDescription || '';

  let scene = spec.scene;
  let correctionNote = null;
  let attempt = 0;

  while (attempt <= REPAIR_BUDGETS.perSpreadInSessionCorrections + REPAIR_BUDGETS.perSpreadPromptRepairs) {
    attempt += 1;
    const isFirstAttempt = attempt === 1;

    let image;
    try {
      if (isFirstAttempt) {
        const turn = buildSpreadTurn({
          spreadIndex: spec.spreadIndex,
          scene,
          text: spec.text,
          textSide: spec.textSide,
          theme: spec.theme,
        });
        image = await generateSpread(currentSession, turn, spec.spreadIndex);
      } else {
        const correction = buildCorrectionTurn({
          spreadIndex: spec.spreadIndex,
          scene,
          text: spec.text,
          textSide: spec.textSide,
          issues: [correctionNote || 'Fix the previous attempt.'],
          tags: [],
        });
        image = await sendCorrection(currentSession, correction, spec.spreadIndex);
      }
    } catch (err) {
      // Safety or transient block: try one session rebuild if the budget allows
      const isSafety = /safety|prohibited|blocked/i.test(err?.message || '');
      if (isSafety && currentSession.rebuilds < REPAIR_BUDGETS.perSpreadEscalations) {
        currentSession = await rebuildSession(currentSession);
        continue;
      }
      return { accepted: false, doc: currentDoc, session: currentSession, issues: [err.message], tags: ['render_error'] };
    }

    const stripped = await stripMetadata(image.imageBuffer);
    const printable = await upscaleForPrint(stripped);
    const printableBase64 = printable.toString('base64');

    const qa = await checkSpread({
      imageBase64: printableBase64,
      expected,
      coverRef: { base64: cover.base64, mime: cover.mime },
      hero,
      additionalCoverCharacters: currentDoc.visualBible?.supportingCast?.filter(c => c?.description).map(c => c.description).join('; ') || null,
      coverParentPresent: false,
      spreadIndex: spec.spreadIndex,
      abortSignal: currentDoc.operationalContext?.abortSignal,
    });

    if (qa.pass) {
      markSpreadAccepted(currentSession, spec.spreadIndex, image.imageBase64);

      const destination = `books/${bookId || currentDoc.request.bookId || 'nobookid'}/spreads/spread-${spread.spreadNumber}.jpg`;
      await uploadBuffer(printable, destination, 'image/jpeg');
      const imageUrl = await getSignedUrl(destination, SIGNED_URL_TTL_MS);

      const nextDoc = updateSpread(currentDoc, spread.spreadNumber, s => ({
        ...s,
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

    // Failure path — prune the bad image, plan a repair, and try again.
    pruneLastTurn(currentSession);

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
      scene = deescalateSceneForSignage(scene);
    }

    if (attempt > REPAIR_BUDGETS.perSpreadInSessionCorrections &&
        currentSession.rebuilds < REPAIR_BUDGETS.perSpreadEscalations) {
      currentSession = await rebuildSession(currentSession);
    }
  }

  return { accepted: false, doc: currentDoc, session: currentSession, issues: ['spread exhausted repair budget'], tags: ['spread_unresolvable'] };
}

/**
 * Orchestrate all spreads in order.
 *
 * @param {object} doc - the canonical book document
 * @returns {Promise<object>}
 */
async function renderAllSpreads(doc) {
  const cover = await resolveCoverBase64(doc.cover);

  let session = createSession({
    coverBase64: cover.base64,
    coverMime: cover.mime,
    theme: doc.request.theme,
    childAppearance: doc.visualBible?.hero?.physicalDescription || '',
    hasParentOnCover: false,
    hasSecondaryOnCover: Array.isArray(doc.visualBible?.supportingCast) && doc.visualBible.supportingCast.length > 0,
    additionalCoverCharacters: doc.visualBible?.supportingCast?.filter(c => c?.description).map(c => c.description).join('; ') || null,
    abortSignal: doc.operationalContext?.abortSignal,
  });
  await establishCharacterReference(session);

  let current = doc;
  const bookId = doc.operationalContext?.bookId || doc.request.bookId;

  for (const spread of current.spreads) {
    if (!spread.spec) {
      const err = new Error(`spread ${spread.spreadNumber}: spec missing`);
      err.failureCode = FAILURE_CODES.SPREAD_UNRESOLVABLE;
      throw err;
    }

    const fn = doc.operationalContext?.onProgress;
    if (typeof fn === 'function') {
      try { fn({ step: 'illustrating', message: `Rendering spread ${spread.spreadNumber}` }); } catch { /* ignore */ }
    }

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
  }

  return current;
}

module.exports = { renderAllSpreads };
