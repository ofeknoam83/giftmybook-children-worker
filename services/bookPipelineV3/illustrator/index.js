/**
 * Native V3 illustrator — entry point ("Art Studio", milestone 2).
 *
 * Stages (docs/ILLUSTRATOR_V3_MILESTONE2_PLAN.md §2-3):
 *   identityKit/    A0 — likeness brief + judged character model sheet (W4)
 *   render/         A2 — parallel per-spread 1:1 candidates, fixed refs (W5)
 *   qa/             A3 — deterministic → vision judge → cross-family
 *                        likeness → selection + one repair wave (W6)
 *   artDirection/   A1 — shot budget, zones, plates, bounce-back (W7/W8)
 *   bookPass/       A4 — contact-sheet review (W9)
 *
 * Contract mirrors the legacy adapter activity: consumes V3 artifacts,
 * returns a rendered v1-shape document (spreads with illustration slots
 * filled) so toLegacyStoryPlan and the layout engine stay untouched. The
 * native path lays out in the proven caption mode (typeset verso + 1:1
 * art recto) — no text in pixels, ever (D5).
 *
 * No ship-anyway: any spread whose candidates exhaust the QA budget turns
 * the book into needs_review with ALL candidates attached.
 */

const { createBookDocument } = require('../contract/bookDocument');
const {
  buildVisualBible,
  buildSpreadSpecs,
  buildStoryBible,
} = require('../orchestration/activities/illustrationDirector');
const { buildSpreadsForLegacyIllustrator } = require('../orchestration/activities/illustrationAdapterHelpers');
const { buildBookReferencePack } = require('./render/referencePack');
const { renderAllSpreadsNative } = require('./render/renderAllSpreads');
const { selectSpreadWinner, buildSpreadQaNeedsReview } = require('./qa/select');
const { getSignedUrl } = require('../../gcsStorage');
const { buildSpreadRenderPrompt } = require('./render/renderSpread');

const IMPLEMENTED_PHASES = ['identityKit (W4)', 'render (W5)', 'qa+selection (W6)'];
const PENDING_PHASES = ['artDirection (W7/W8)', 'bookPass (W9)', 'zone typesetting (W9, caption mode ships meanwhile)'];

/**
 * Run the native illustrator over a written manuscript.
 *
 * @param {object} input - { identityKit, rawRequest, brief, ageProfile, concept, manuscript, coverImageUrl, coverTitle, operationalContext }
 * @param {object} ctx - workflow context ({ log, bookId, reportProgress })
 * @returns {Promise<object>} rendered v1-shape document
 */
async function runNativeIllustrator(input, ctx) {
  const {
    identityKit, rawRequest, brief, ageProfile, concept, manuscript,
    coverImageUrl, coverTitle, operationalContext,
  } = input;
  const log = (m) => ctx.log('info', `[v3-illustrator] ${m}`);
  const abortSignal = operationalContext?.abortSignal;
  const bookId = ctx.bookId || rawRequest?.bookId;

  if (!identityKit) {
    const err = new Error('native illustrator requires an identity kit (child photos missing or kit stage skipped)');
    err.code = 'ILLUSTRATOR_NATIVE_NO_IDENTITY_KIT';
    throw err;
  }

  // ── document skeleton (same builders as the legacy adapter) ──
  const visualBible = buildVisualBible({ rawRequest, brief, concept, manuscript });
  visualBible.textRendering = { policy: 'typeset-by-layout-engine' }; // D5
  const spreadSpecs = buildSpreadSpecs({ manuscript, ageProfile });
  const storyBible = buildStoryBible({ concept, manuscript });
  const draftBySpread = new Map(manuscript.spreads.map((s) => [s.spread, { text: s.text, lines: s.lines }]));

  const doc = createBookDocument({
    request: { ...rawRequest, bookId, ageBand: ageProfile?.ageBand || ageProfile?.band },
    brief: rawRequest || {},
    cover: {
      title: manuscript.title || coverTitle || rawRequest?.cover?.title || 'My Story',
      imageUrl: coverImageUrl || rawRequest?.cover?.imageUrl || null,
      characterLocks: {},
      outfitLocks: {},
    },
  });
  doc.storyBible = storyBible;
  doc.visualBible = visualBible;
  doc.spreadSpecs = spreadSpecs;
  doc.spreads = buildSpreadsForLegacyIllustrator({ spreadSpecs, draftBySpread });
  doc.operationalContext = operationalContext || {};

  // ── A2: render every spread's candidates, fully parallel ──
  ctx.reportProgress?.({ step: 'illustrating', message: 'Rendering spreads (native, parallel candidates)' });
  const bookPack = await buildBookReferencePack({ identityKit, coverImageUrl, log });
  const briefText = identityKit.brief?.briefText || identityKit.brief?.brief?.briefText || '';
  log(`rendering ${manuscript.spreads.length} spreads (refs=${bookPack.length}, kitFromCache=${identityKit.fromCache})`);

  const rendered = await renderAllSpreadsNative({
    bookId,
    spreads: manuscript.spreads,
    bookPack,
    briefText,
    abortSignal,
    log,
    onSpreadDone: (done, total) => ctx.reportProgress?.({
      step: 'illustrating',
      message: `Rendering spreads ${done}/${total}`,
    }),
  });

  // ── A3: QA cascade + selection per spread ──
  ctx.reportProgress?.({ step: 'illustrating', message: 'Judging candidates (QA cascade)' });
  const qaTagCounts = {};
  const failures = [];
  const selections = new Map();

  for (const entry of rendered) {
    const spread = manuscript.spreads.find((s) => s.spread === entry.spread);
    const result = await selectSpreadWinner({
      bookId,
      spread,
      candidates: entry.candidates,
      bookPack,
      photos: identityKit.photos || [],
      briefText,
      qaTagCounts,
      abortSignal,
      log,
    });
    if (result.selected) {
      selections.set(entry.spread, result);
    } else {
      failures.push({ spread: entry.spread, evaluations: result.evaluations, allCandidates: result.allCandidates });
    }
  }

  if (failures.length > 0) {
    const urls = await Promise.all(
      failures.flatMap((f) => f.allCandidates.map(async (c) => [c.path, await getSignedUrl(c.path).catch(() => c.path)])),
    );
    const urlByPath = new Map(urls);
    const err = new Error(
      `${failures.length} spread(s) exhausted the QA budget (spreads ${failures.map((f) => f.spread).join(', ')}) — needs human review with all candidates attached`,
    );
    err.needsReview = buildSpreadQaNeedsReview(failures, (p) => urlByPath.get(p) || p);
    throw err;
  }

  // ── fill the document's illustration slots from the winners ──
  for (const docSpread of doc.spreads) {
    const result = selections.get(docSpread.spreadNumber);
    const winner = result.selected;
    const candidate = result.allCandidates.find((c) => c.candidateIndex === winner.candidateIndex);
    const spread = manuscript.spreads.find((s) => s.spread === docSpread.spreadNumber);
    const imageUrl = await getSignedUrl(candidate.path).catch(() => null);
    docSpread.illustration = {
      imageUrl,
      imageStorageKey: candidate.path,
      scenePrompt: buildSpreadRenderPrompt({ spread, briefText }),
      candidateIndex: winner.candidateIndex,
      likeness: winner.likeness,
      repairWaves: result.repairWaves,
    };
    docSpread.qa.spreadChecks.push({
      source: 'native-v3',
      pass: true,
      likeness: winner.likeness,
      scores: winner.spreadScores || null,
    });
  }

  doc.qaTagCounts = qaTagCounts;
  log(`selection complete: ${selections.size}/${doc.spreads.length} spreads, tags=${JSON.stringify(qaTagCounts)}`);
  return doc;
}

module.exports = {
  runNativeIllustrator,
  IMPLEMENTED_PHASES,
  PENDING_PHASES,
};
