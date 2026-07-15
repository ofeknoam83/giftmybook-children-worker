/**
 * Native V3 illustrator — entry point ("Art Studio", milestone 2).
 *
 * Full flow (docs/ILLUSTRATOR_V3_MILESTONE2_PLAN.md):
 *   A0 identityKit (built by the workflow, parallel with the writer)
 *   A1 artDirection — shot budget, zones, palette arc, world plates,
 *      BOUNCES (unstageable contracts → writer, before any pixels)
 *   A2 render — per-spread parallel candidates from fixed references
 *   A3 qa/selection — deterministic → vision judge → cross-family
 *      likeness; one repair wave; exhaustion → needs_review
 *   A4 bookPass — contact-sheet review; one targeted regen wave;
 *      residual flags → needs_review
 *
 * Contract mirrors the legacy adapter activity: returns a rendered
 * v1-shape document so toLegacyStoryPlan + the layout engine stay
 * untouched. Native books lay out in the proven caption mode (typeset
 * verso + 1:1 art recto) — no text in pixels, ever (D5).
 *
 * Admin review resolutions (W10) honored from rawRequest.reviewResolution:
 *   pick_candidate — select the named candidate for a spread, bypassing QA
 *   regen_spread   — force fresh renders for a spread (note fed to prompt)
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
const { renderSpreadCandidates, buildSpreadRenderPrompt } = require('./render/renderSpread');
const { selectSpreadWinner, buildSpreadQaNeedsReview } = require('./qa/select');
const { runArtDirection } = require('./artDirection/artDirector');
const { renderWorldPlates } = require('./artDirection/worldPlates');
const { runBookPass, buildBookPassNeedsReview } = require('./bookPass/contactSheet');
const { buildNeedsReviewPayload } = require('../reviewQueue/payload');
const { getSignedUrl, uploadBuffer } = require('../../gcsStorage');
const { candidatePath } = require('./render/renderAllSpreads');
const { downloadPhotoAsBase64 } = require('../../illustrationGenerator');
const { BOOK_PASS_REGEN_WAVES, CANDIDATES_PER_SPREAD } = require('./config');

const IMPLEMENTED_PHASES = [
  'identityKit (W4)', 'render (W5)', 'qa+selection (W6)',
  'artDirection+plates+bounce (W7/W8)', 'bookPass (W9, caption-mode layout)', 'review resolutions (W10)',
];
const PENDING_PHASES = ['wide-art zone typesetting (post-cutover enhancement)'];

/** Bounce signal the workflow converts into one manuscriptRevision round. */
class ArtDirectionBounceError extends Error {
  constructor(bounces) {
    super(`art director bounced ${bounces.length} unstageable spread(s): ${bounces.map((b) => b.spread).join(', ')}`);
    this.name = 'ArtDirectionBounceError';
    this.bounces = bounces;
  }
}

/**
 * @param {object} input - { identityKit, rawRequest, brief, ageProfile, concept, manuscript,
 *                           coverImageUrl, coverTitle, operationalContext, allowBounce }
 * @param {object} ctx - workflow context ({ log, bookId, reportProgress })
 * @returns {Promise<object>} rendered v1-shape document
 */
async function runNativeIllustrator(input, ctx) {
  const {
    identityKit, rawRequest, brief, ageProfile, concept, manuscript,
    coverImageUrl, coverTitle, operationalContext, allowBounce = true,
  } = input;
  const log = (m) => ctx.log('info', `[v3-illustrator] ${m}`);
  const abortSignal = operationalContext?.abortSignal;
  const bookId = ctx.bookId || rawRequest?.bookId;
  const resolution = rawRequest?.reviewResolution || null;

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

  // ── references ──
  const bookPack = await buildBookReferencePack({ identityKit, coverImageUrl, log });
  const briefText = identityKit.brief?.briefText || '';
  let coverImage = null;
  if (coverImageUrl) {
    coverImage = await downloadPhotoAsBase64(coverImageUrl).catch(() => null);
  }

  // ── A1: art direction (sees sheet + cover) ──
  ctx.reportProgress?.({ step: 'illustrating', message: 'Art direction (shots, zones, palette, plates)' });
  const directorRefs = [bookPack[0], ...(coverImage ? [coverImage] : [])];
  const direction = await runArtDirection({
    manuscript,
    ageBand: ageProfile?.ageBand || ageProfile?.band,
    ageYears: Number(rawRequest?.child?.age) || null,
    referenceImages: directorRefs,
    abortSignal,
    log,
  });
  log(`art direction: shots=${[...new Set([...direction.directionBySpread.values()].map((d) => d.shot))].join(',')} plates=${direction.worldPlates.length} bounces=${direction.bounces.length}${direction.shotBudget.reassigned ? ' (deterministic shot repair applied)' : ''}`);

  if (direction.bounces.length > 0) {
    if (allowBounce) throw new ArtDirectionBounceError(direction.bounces);
    // Second pass (post-revision) still unstageable → human review.
    const err = new Error(`art director still cannot stage ${direction.bounces.length} spread(s) after the writer revision round`);
    err.needsReview = buildNeedsReviewPayload({
      stage: 'artDirection',
      reason: 'art_direction_unstageable',
      spread: direction.bounces[0]?.spread ?? null,
      defects: direction.bounces.map((b) => `spread ${b.spread}: ${b.problem} (suggested: ${b.suggestion})`),
    });
    throw err;
  }

  // ── A1: world plates ──
  const platesByLocation = await renderWorldPlates({
    plates: direction.worldPlates,
    paletteArc: direction.paletteArc,
    abortSignal,
    log,
  });

  // ── W10 regen_spread resolution: force fresh renders for the named spread ──
  const forceSpreads = new Set();
  if (resolution?.action === 'regen_spread' && Number.isFinite(resolution.spread)) {
    forceSpreads.add(resolution.spread);
    log(`review resolution: regen spread ${resolution.spread}${resolution.note ? ` (note: ${resolution.note})` : ''}`);
  }
  const manuscriptSpreads = manuscript.spreads.map((s) => {
    if (!forceSpreads.has(s.spread) || !resolution?.note) return s;
    return {
      ...s,
      scene_contract: {
        ...s.scene_contract,
        continuity_notes: [s.scene_contract?.continuity_notes, `ADMIN NOTE: ${resolution.note}`].filter(Boolean).join(' | '),
      },
    };
  });

  // ── A2: render every spread's candidates, fully parallel ──
  ctx.reportProgress?.({ step: 'illustrating', message: 'Rendering spreads (native, parallel candidates)' });
  log(`rendering ${manuscriptSpreads.length} spreads (refs=${bookPack.length}, kitFromCache=${identityKit.fromCache})`);
  const rendered = await renderAllSpreadsNative({
    bookId,
    spreads: manuscriptSpreads,
    directionBySpread: direction.directionBySpread,
    platesByLocation,
    bookPack,
    briefText,
    forceSpreads,
    abortSignal,
    log,
    onSpreadDone: (done, total) => ctx.reportProgress?.({
      step: 'illustrating',
      message: `Rendering spreads ${done}/${total}`,
    }),
  });

  // ── A3: QA cascade + selection ──
  ctx.reportProgress?.({ step: 'illustrating', message: 'Judging candidates (QA cascade)' });
  const qaTagCounts = {};
  const failures = [];
  const selections = new Map();

  for (const entry of rendered) {
    const spread = manuscriptSpreads.find((s) => s.spread === entry.spread);

    // W10 pick_candidate resolution: admin picked one — bypass QA for it.
    if (resolution?.action === 'pick_candidate' && resolution.spread === entry.spread && resolution.candidateUrl) {
      const picked = entry.candidates.find((c) => resolution.candidateUrl.includes(c.path) || c.path.includes(resolution.candidateUrl));
      if (picked) {
        log(`review resolution: candidate ${picked.candidateIndex} picked by admin for spread ${entry.spread}`);
        selections.set(entry.spread, {
          selected: { candidateIndex: picked.candidateIndex, path: picked.path, pass: true, stage: 'admin_pick', likeness: null, defects: [] },
          evaluations: [],
          repairWaves: 0,
          allCandidates: entry.candidates,
        });
        continue;
      }
      log(`review resolution: pick_candidate URL did not match any candidate of spread ${entry.spread} — falling through to QA`);
    }

    const result = await selectSpreadWinner({
      bookId,
      spread,
      candidates: entry.candidates,
      direction: direction.directionBySpread.get(entry.spread) || null,
      bookPack,
      plate: platesByLocation.get(spread.scene_contract?.setting) || null,
      // Likeness is judged against the APPROVED reference art (model sheet
      // + cover = the bookPack), NOT the raw photo — the parent approved
      // the cover character, and that character is the book's ground truth.
      referenceImages: bookPack,
      briefText,
      qaTagCounts,
      abortSignal,
      log,
    });
    if (result.selected) selections.set(entry.spread, result);
    else failures.push({ spread: entry.spread, evaluations: result.evaluations, allCandidates: result.allCandidates });
  }

  if (failures.length > 0) {
    throw await spreadQaFailure(failures);
  }

  // ── A4: book pass + one targeted regen wave ──
  ctx.reportProgress?.({ step: 'illustrating', message: 'Book pass (contact-sheet review)' });
  let residualFlags = [];
  for (let wave = 0; wave <= BOOK_PASS_REGEN_WAVES; wave += 1) {
    const winners = [...selections.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([spreadNumber, result]) => {
        const c = result.allCandidates.find((x) => x.candidateIndex === result.selected.candidateIndex);
        return { spread: spreadNumber, base64: c.base64, mimeType: c.mimeType };
      });
    const pass = await runBookPass({ manuscript, direction, winners, cover: coverImage, abortSignal });
    log(`book pass${wave ? ` (post-regen)` : ''}: ${pass.pass ? 'PASS' : `flags=[${pass.flags.map((f) => `${f.spread}: ${f.issue}`).join('; ')}]`} — ${pass.notes}`);
    if (pass.pass) { residualFlags = []; break; }
    residualFlags = pass.flags;
    if (wave >= BOOK_PASS_REGEN_WAVES) break;

    // Targeted regen: fresh candidates for flagged spreads with the issue named.
    for (const flag of pass.flags) {
      const spread = manuscriptSpreads.find((s) => s.spread === flag.spread);
      if (!spread) continue;
      const flaggedSpread = {
        ...spread,
        scene_contract: {
          ...spread.scene_contract,
          continuity_notes: [spread.scene_contract?.continuity_notes, `BOOK-PASS FIX REQUIRED: ${flag.issue}`].filter(Boolean).join(' | '),
        },
      };
      const freshImgs = await renderSpreadCandidates({
        spread: flaggedSpread,
        direction: direction.directionBySpread.get(flag.spread) || null,
        bookPack,
        plate: platesByLocation.get(spread.scene_contract?.setting) || null,
        briefText,
        count: CANDIDATES_PER_SPREAD,
        abortSignal,
        log,
      });
      const prior = selections.get(flag.spread);
      const baseIndex = Math.max(0, ...prior.allCandidates.map((c) => c.candidateIndex));
      const freshCandidates = [];
      for (const [i, img] of freshImgs.entries()) {
        const candidateIndex = baseIndex + i + 1;
        const path = candidatePath(bookId, flag.spread, candidateIndex);
        await uploadBuffer(img.buffer, path, img.mimeType || 'image/png');
        freshCandidates.push({ path, base64: img.buffer.toString('base64'), mimeType: img.mimeType || 'image/png', candidateIndex });
      }
      const rerun = await selectSpreadWinner({
        bookId,
        spread: flaggedSpread,
        candidates: freshCandidates,
        direction: direction.directionBySpread.get(flag.spread) || null,
        bookPack,
        plate: platesByLocation.get(spread.scene_contract?.setting) || null,
        photos: identityKit.photos || [],
        briefText,
        qaTagCounts,
        abortSignal,
        log,
      });
      if (rerun.selected) {
        rerun.allCandidates = [...prior.allCandidates, ...rerun.allCandidates.filter((c) => c.candidateIndex > baseIndex)];
        selections.set(flag.spread, rerun);
      }
    }
  }

  if (residualFlags.length > 0) {
    const urls = await Promise.all(residualFlags.map(async (f) => {
      const sel = selections.get(f.spread);
      const paths = sel ? sel.allCandidates.map((c) => c.path) : [];
      return Promise.all(paths.map((p) => getSignedUrl(p).catch(() => p)));
    }));
    const err = new Error(`book pass still flags ${residualFlags.length} spread(s) after the targeted regen wave`);
    err.needsReview = buildBookPassNeedsReview(residualFlags, urls.flat());
    throw err;
  }

  // ── fill the document's illustration slots from the winners ──
  for (const docSpread of doc.spreads) {
    const result = selections.get(docSpread.spreadNumber);
    const winner = result.selected;
    const candidate = result.allCandidates.find((c) => c.candidateIndex === winner.candidateIndex);
    const spread = manuscriptSpreads.find((s) => s.spread === docSpread.spreadNumber);
    const imageUrl = await getSignedUrl(candidate.path).catch(() => null);
    docSpread.illustration = {
      imageUrl,
      imageStorageKey: candidate.path,
      scenePrompt: buildSpreadRenderPrompt({
        spread,
        direction: direction.directionBySpread.get(docSpread.spreadNumber) || null,
        briefText,
      }),
      candidateIndex: winner.candidateIndex,
      likeness: winner.likeness ?? null,
      repairWaves: result.repairWaves,
    };
    docSpread.qa.spreadChecks.push({
      source: 'native-v3',
      pass: true,
      likeness: winner.likeness ?? null,
      scores: winner.spreadScores || null,
    });
  }

  doc.qaTagCounts = qaTagCounts;
  doc.artDirection = {
    paletteArc: direction.paletteArc,
    continuityLocks: direction.continuityLocks,
    shotBudget: direction.shotBudget,
    plates: direction.worldPlates,
  };
  log(`native illustration complete: ${selections.size}/${doc.spreads.length} spreads, tags=${JSON.stringify(qaTagCounts)}`);
  return doc;

  async function spreadQaFailure(failedSpreads) {
    const urls = await Promise.all(
      failedSpreads.flatMap((f) => f.allCandidates.map(async (c) => [c.path, await getSignedUrl(c.path).catch(() => c.path)])),
    );
    const urlByPath = new Map(urls);
    const err = new Error(
      `${failedSpreads.length} spread(s) exhausted the QA budget (spreads ${failedSpreads.map((f) => f.spread).join(', ')}) — needs human review with all candidates attached`,
    );
    err.needsReview = buildSpreadQaNeedsReview(failedSpreads, (p) => urlByPath.get(p) || p);
    return err;
  }
}

module.exports = {
  runNativeIllustrator,
  ArtDirectionBounceError,
  IMPLEMENTED_PHASES,
  PENDING_PHASES,
};
