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
const { renderAllSpreadsNative, createLimiter } = require('./render/renderAllSpreads');
const { renderSpreadCandidates, buildSpreadRenderPrompt } = require('./render/renderSpread');
const { selectSpreadWinner, buildSpreadQaNeedsReview, pickLeastBad } = require('./qa/select');
const { runArtDirection, restageSpread } = require('./artDirection/artDirector');
const { renderWorldPlates } = require('./artDirection/worldPlates');
const { renderPropPlate } = require('./artDirection/propPlate');
const { runBookPass, buildBookPassNeedsReview } = require('./bookPass/contactSheet');
const { buildNeedsReviewPayload } = require('../reviewQueue/payload');
const { getSignedUrl, uploadBuffer } = require('../../gcsStorage');
const { candidatePath } = require('./render/renderAllSpreads');
const { downloadPhotoAsBase64 } = require('../../illustrationGenerator');
const { BOOK_PASS_REGEN_WAVES, BOOK_PASS_SHIP_ON_EXHAUSTION, CANDIDATES_PER_SPREAD, SPREAD_RECOVERY_ENABLED, SPREAD_RENDERER_MODEL } = require('./config');

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
    coverImageUrl, coverTitle, coverPreflight = null, operationalContext, allowBounce = true,
    textLayout = 'caption',
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
  // The identity kit's ranked distinguishing features (freckles, dimples, gap
  // teeth, glasses…). Restated as a per-spread MUST-INCLUDE line in every
  // render prompt — the renderer repeatedly drops these (fail@likeness),
  // exhausting candidate budgets. Derived, never hardcoded: an empty list
  // omits the line entirely.
  const mustIncludeFeatures = Array.isArray(identityKit.brief?.fields?.distinguishingFeatures)
    ? identityKit.brief.fields.distinguishingFeatures.filter(Boolean)
    : [];
  if (mustIncludeFeatures.length) {
    log(`likeness MUST-INCLUDE features on every spread: ${mustIncludeFeatures.join('; ')}`);
  }
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
    textLayout,
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

  // Locked supporting-character designs (continuityLocks.cast) ride every
  // render prompt + the book pass (2026-07-28: Mom/Dad had no ground truth).
  const castLocks = Array.isArray(direction.continuityLocks?.cast) ? direction.continuityLocks.cast : null;

  // ── A1: world plates ──
  // Plates are style-anchored on the book pack (sheet + approved cover):
  // a plate rendered from prose alone can drift flat/desaturated and drag
  // every spread that shares its location into a book-pass style break.
  // Each plate is also medium-checked (plateStyleQa) — a plate dropped after
  // failing twice surfaces here as an artDirection advisory.
  const plateAdvisories = [];
  // Cover pre-flight outcome (workflow-resolved): a harmonized or unfixable
  // anchor is book-visible, never silent.
  if (coverPreflight?.advisory) {
    plateAdvisories.push({ stage: 'artDirection', spread: 'cover', note: coverPreflight.advisory });
  }
  const platesByLocation = await renderWorldPlates({
    plates: direction.worldPlates,
    paletteArc: direction.paletteArc,
    textLayout,
    styleReferences: bookPack,
    onAdvisory: (note) => plateAdvisories.push({ stage: 'artDirection', spread: null, note }),
    abortSignal,
    log,
  });

  // ── A1: prop plate ──
  // The director's LOCKED prop designs render once and ride every spread's
  // reference pack, so a recurring prop (the map, the lamp) cannot morph
  // into a different object between spreads (2026-07-18 print audit).
  const propPlate = await renderPropPlate({
    continuityLocks: direction.continuityLocks,
    styleReferences: bookPack,
    onAdvisory: (note) => plateAdvisories.push({ stage: 'artDirection', spread: null, note }),
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
        continuity_notes: [s.scene_contract?.continuity_notes, `ADMIN NOTE (apply within the locked premium-3D signature style): ${resolution.note}`].filter(Boolean).join(' | '),
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
    propPlate,
    bookPack,
    briefText,
    textLayout,
    mustIncludeFeatures,
    castLocks,
    forceSpreads,
    abortSignal,
    log,
    onSpreadDone: (done, total) => ctx.reportProgress?.({
      step: 'illustrating',
      message: `Rendering spreads ${done}/${total}`,
    }),
  });

  // ── A3: QA cascade + selection — spreads judged in PARALLEL ──
  // The serial version cost 30-60s per spread × 13 spreads (~7-13 min of
  // wall clock) while renders were already parallel. Object mutations
  // below (selections/failures/qaTagCounts) are single-threaded-safe.
  ctx.reportProgress?.({ step: 'illustrating', message: 'Judging candidates (QA cascade)' });
  const qaTagCounts = {};
  const failures = [];
  const selections = new Map();
  const qaLimit = createLimiter(Number(process.env.BOOK_PIPELINE_V3_QA_CONCURRENCY) >= 1
    ? Number(process.env.BOOK_PIPELINE_V3_QA_CONCURRENCY) : 4);

  await Promise.all(rendered.map((entry) => qaLimit(async () => {
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
        return;
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
      propPlate,
      // Likeness is judged against the APPROVED reference art (model sheet
      // + cover = the bookPack), NOT the raw photo — the parent approved
      // the cover character, and that character is the book's ground truth.
      referenceImages: bookPack,
      briefText,
      textLayout,
      mustIncludeFeatures,
      castLocks,
      qaTagCounts,
      abortSignal,
      log,
    });
    if (result.selected) selections.set(entry.spread, result);
    else failures.push({ spread: entry.spread, evaluations: result.evaluations, allCandidates: result.allCandidates });
  })));

  // ── Spread recovery ladder (2026-07-17) ──
  // A book needs all 13 spreads to pass AT ONCE — at ~95% per-spread success
  // one unlucky page still kills ~half of books. Before giving up, each
  // exhausted spread gets a RESTAGED scene (a 4x-rejected staging is often
  // wrong, not unlucky) plus one fresh full round. Extra tries cost cents;
  // a needs_review costs a human.
  if (failures.length > 0 && SPREAD_RECOVERY_ENABLED) {
    failures.sort((a, b) => a.spread - b.spread);
    const remaining = [];
    for (const failure of failures) {
      const spreadNumber = failure.spread;
      const spread = manuscriptSpreads.find((s) => s.spread === spreadNumber);
      const priorDefects = [...new Set(failure.evaluations.flatMap((e) => e.defects || []))];
      log(`spread ${spreadNumber} exhausted first budget — entering recovery (restage + fresh round)`);

      try {
        const row = direction.directionBySpread.get(spreadNumber) || {};
        const restaged = await restageSpread({
          spread,
          direction: row,
          defects: priorDefects,
          ageYears: Number(rawRequest?.child?.age) || null,
          ageBand: ageProfile?.ageBand || ageProfile?.band,
          textLayout,
          abortSignal,
        });
        direction.directionBySpread.set(spreadNumber, {
          ...row,
          moment: restaged.moment || row.moment || null,
          poseHint: restaged.poseHint ?? row.poseHint ?? null,
          continuityNotes: [
            row.continuityNotes,
            restaged.continuityNotes,
            priorDefects.length ? `RESTAGED after QA exhaustion — avoid: ${priorDefects.slice(0, 4).join('; ')}` : 'RESTAGED after QA exhaustion',
          ].filter(Boolean).join(' | '),
        });
        log(`spread ${spreadNumber} restaged${restaged.moment ? `: moment='${String(restaged.moment).slice(0, 90)}'` : ' (no new moment returned)'}`);
      } catch (restageErr) {
        // The fresh round still runs — new dice alone recover most spreads.
        log(`spread ${spreadNumber} restage failed (fresh round proceeds unrestaged): ${restageErr.message}`);
      }

      // Fresh full round: 2 new candidates + the normal repair wave, with
      // candidate indices continuing past the first round's (GCS paths and
      // review payloads stay unambiguous).
      const baseIndex = Math.max(0, ...failure.allCandidates.map((c) => c.candidateIndex));
      const freshImgs = await renderSpreadCandidates({
        spread,
        direction: direction.directionBySpread.get(spreadNumber) || null,
        bookPack,
        plate: platesByLocation.get(spread.scene_contract?.setting) || null,
        propPlate,
        briefText,
        textLayout,
        mustIncludeFeatures,
        castLocks,
        count: CANDIDATES_PER_SPREAD,
        abortSignal,
        log,
      });
      const freshCandidates = [];
      for (const [i, img] of freshImgs.entries()) {
        const candidateIndex = baseIndex + i + 1;
        const path = candidatePath(bookId, spreadNumber, candidateIndex, 'png', textLayout);
        await uploadBuffer(img.buffer, path, img.mimeType || 'image/png');
        freshCandidates.push({ path, base64: img.buffer.toString('base64'), mimeType: img.mimeType || 'image/png', candidateIndex, rendererModel: img.model || null });
      }
      const rerun = await selectSpreadWinner({
        bookId,
        spread,
        candidates: freshCandidates,
        direction: direction.directionBySpread.get(spreadNumber) || null,
        bookPack,
        plate: platesByLocation.get(spread.scene_contract?.setting) || null,
        propPlate,
        referenceImages: bookPack,
        briefText,
        textLayout,
        qaTagCounts,
        abortSignal,
        log,
      });
      if (rerun.selected) {
        rerun.allCandidates = [...failure.allCandidates, ...rerun.allCandidates];
        selections.set(spreadNumber, rerun);
        log(`spread ${spreadNumber} RECOVERED on the fresh round (candidate ${rerun.selected.candidateIndex})`);
      } else {
        remaining.push({
          spread: spreadNumber,
          evaluations: [...failure.evaluations, ...rerun.evaluations],
          allCandidates: [...failure.allCandidates, ...rerun.allCandidates],
        });
      }
    }
    failures.length = 0;
    failures.push(...remaining);
  }

  // Residual review payload from a spreadQa ship-on-exhaustion (mirrors the
  // bookPass ship path below; both funnel into doc.bookPassReview downstream).
  let spreadQaReview = null;
  if (failures.length > 0) {
    failures.sort((a, b) => a.spread - b.spread); // stable payloads regardless of completion order
    if (!BOOK_PASS_SHIP_ON_EXHAUSTION) {
      throw await spreadQaFailure(failures);
    }
    // Loud escape hatch: instead of dead-ending the whole book on needs_review
    // because one (or a few) spread(s) never converged, ship the least-bad
    // candidate for each and flag the book for admin review. The pipeline then
    // CONTINUES to the book pass + PDF assembly, so the book reaches a
    // completed-but-flagged state.
    spreadQaReview = await shipExhaustedSpreads(failures);
  }

  // ── A4: book pass + one targeted regen wave ──
  // Closed-gate architecture (2026-07-16): only CRITICAL flags trigger regen
  // or needs_review; minor flags become advisories on the document — the
  // book ships and the admin can regen-spread post-hoc.
  ctx.reportProgress?.({ step: 'illustrating', message: 'Book pass (contact-sheet review)' });
  let residualFlags = [];
  let bookPassMinors = [];
  let coverNeedsReharmonize = null; // P2: cover↔interior parity break, forces cover re-harmonize downstream
  for (let wave = 0; wave <= BOOK_PASS_REGEN_WAVES; wave += 1) {
    const winners = [...selections.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([spreadNumber, result]) => {
        const c = result.allCandidates.find((x) => x.candidateIndex === result.selected.candidateIndex);
        return { spread: spreadNumber, base64: c.base64, mimeType: c.mimeType };
      });
    // The prop plate rides as a reference so prop identity is judged
    // against the LOCKED designs, not spread-vs-spread impressions
    // (2026-07-19: spread-vs-spread prop judging could not converge).
    const pass = await runBookPass({ manuscript, direction, winners, cover: coverImage, propPlate, abortSignal, log });
    bookPassMinors = pass.minorFlags; // latest whole-book review wins
    // P2 (2026-07-23 audit): the cover itself read as 2D over 3D interiors.
    // The interior pipeline can't re-harmonize the cover (it is generated in a
    // later step), so record the parity break on the document — server.js forces
    // a cover re-harmonize from this flag. Latest wave's verdict wins.
    if (pass.coverStyleBreak?.broke) {
      coverNeedsReharmonize = pass.coverStyleBreak;
    }
    log(`book pass${wave ? ` (post-regen)` : ''}: ${pass.pass ? 'PASS' : `critical=[${pass.criticalFlags.map((f) => `${f.spread}: ${f.issue}`).join('; ')}]`}${pass.minorFlags.length ? ` advisories=${pass.minorFlags.length}` : ''} — ${pass.notes}`);
    if (pass.pass) { residualFlags = []; break; }
    residualFlags = pass.criticalFlags;
    if (wave >= BOOK_PASS_REGEN_WAVES) break;

    // Targeted regen: fresh candidates for CRITICALLY flagged spreads with the issue named.
    for (const flag of pass.criticalFlags) {
      const spread = manuscriptSpreads.find((s) => s.spread === flag.spread);
      if (!spread) continue;
      // Style-break flags get the concrete repair template on top of the raw
      // judge prose — "Jarring style break" alone doesn't tell the renderer
      // WHAT to paint like; naming the cover's style attributes does (same
      // pattern as the lettering/color-drift templates in the repair wave).
      const isStyleBreak = /style|flat|desaturat|painterly|watercolor|cel[- ]?shad|hand[- ]?drawn|2d |line[- ]?art|line ?weight|vector|live[- ]?action|photograph/i.test(flag.issue);
      // Prop-identity flags get the LOCKED design spelled out — "the compass
      // looks different" alone sends the renderer guessing; its plate design
      // is the fix target (2026-07-19 convergence fix).
      const flaggedProps = (direction.continuityLocks?.props || []).filter((p) => p?.name && p.design
        && new RegExp(`\\b${String(p.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(flag.issue));
      // Cast-lock flags (critical class 8) get the same treatment: quote the
      // flagged character's locked design in the regen prompt.
      const flaggedCast = (direction.continuityLocks?.cast || []).filter((c) => c?.name && c.design
        && new RegExp(`\\b${String(c.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(flag.issue));
      const flaggedSpread = {
        ...spread,
        scene_contract: {
          ...spread.scene_contract,
          continuity_notes: [
            spread.scene_contract?.continuity_notes,
            `BOOK-PASS FIX REQUIRED: ${flag.issue}`,
            isStyleBreak
              ? 'CRITICAL REPAIR: match the APPROVED COVER reference\'s rendering style EXACTLY — the same premium 3D CGI animated-film medium: dimensional character geometry, physically based materials, rich saturated cinematic lighting. NOT a flat 2D illustration, NOT painterly/watercolor/line-art, NOT desaturated.'
              : null,
            flaggedProps.length
              ? `CRITICAL REPAIR: render each prop EXACTLY as its locked design on the PROP PLATE reference — ${flaggedProps.map((p) => `${p.name}: ${p.design}`).join('; ')}. Same kind of object, same shape, same colors, every time.`
              : null,
            flaggedCast.length
              ? `CRITICAL REPAIR: render each supporting character EXACTLY as their locked design — ${flaggedCast.map((c) => `${c.name}: ${c.design}`).join('; ')}. The same person: same hair, same skin tone, same outfit, every time they appear.`
              : null,
          ].filter(Boolean).join(' | '),
        },
      };
      const freshImgs = await renderSpreadCandidates({
        spread: flaggedSpread,
        direction: direction.directionBySpread.get(flag.spread) || null,
        bookPack,
        plate: platesByLocation.get(spread.scene_contract?.setting) || null,
        propPlate,
        briefText,
        textLayout,
        mustIncludeFeatures,
        castLocks,
        count: CANDIDATES_PER_SPREAD,
        abortSignal,
        log,
      });
      const prior = selections.get(flag.spread);
      const baseIndex = Math.max(0, ...prior.allCandidates.map((c) => c.candidateIndex));
      const freshCandidates = [];
      for (const [i, img] of freshImgs.entries()) {
        const candidateIndex = baseIndex + i + 1;
        const path = candidatePath(bookId, flag.spread, candidateIndex, 'png', textLayout);
        await uploadBuffer(img.buffer, path, img.mimeType || 'image/png');
        freshCandidates.push({ path, base64: img.buffer.toString('base64'), mimeType: img.mimeType || 'image/png', candidateIndex, rendererModel: img.model || null });
      }
      const rerun = await selectSpreadWinner({
        bookId,
        spread: flaggedSpread,
        candidates: freshCandidates,
        direction: direction.directionBySpread.get(flag.spread) || null,
        bookPack,
        plate: platesByLocation.get(spread.scene_contract?.setting) || null,
        propPlate,
        // Same likeness references as the main QA pass: model sheet + cover
        // (a stale `photos:` param here — dead since the cover-relative QA
        // rewiring — left referenceImages undefined and crashed every book
        // whose book pass flagged a spread).
        referenceImages: bookPack,
        briefText,
        textLayout,
        qaTagCounts,
        abortSignal,
        log,
      });
      if (rerun.selected) {
        rerun.allCandidates = [...prior.allCandidates, ...rerun.allCandidates.filter((c) => c.candidateIndex > baseIndex)];
        selections.set(flag.spread, rerun);
        log(`book-pass regen spread ${flag.spread}: NEW winner c${rerun.selected.candidateIndex} replaces the flagged image`);
      } else {
        // Every fresh candidate failed the spread QA cascade (fold_collision,
        // wrong prop color, missing likeness marks…). The old FLAGGED image is
        // kept unchanged, so the next book-pass wave re-reviews the identical
        // pixels and re-flags it with certainty. Do NOT let this pass silently
        // — name the spread and each candidate's failure so the true cause
        // (not a vague "book pass still flags") is visible in the logs.
        const reasons = rerun.evaluations
          .filter((e) => e.candidateIndex > baseIndex)
          .map((e) => `c${e.candidateIndex}@${e.stage}${e.defects?.[0] ? `:${e.defects[0]}` : ''}`)
          .join(' | ');
        log(`WARNING: book-pass regen for spread ${flag.spread} produced NO passing candidate — keeping the flagged image. Failures: ${reasons || 'none recorded'}`);
      }
    }
  }

  let bookPassReview = null;
  if (residualFlags.length > 0) {
    const urls = await Promise.all(residualFlags.map(async (f) => {
      const sel = selections.get(f.spread);
      const paths = sel ? sel.allCandidates.map((c) => c.path) : [];
      return Promise.all(paths.map((p) => getSignedUrl(p).catch(() => p)));
    }));
    const needsReview = buildBookPassNeedsReview(residualFlags, urls.flat());
    if (BOOK_PASS_SHIP_ON_EXHAUSTION) {
      // Loud escape hatch: ship the book with the residual issues attached as
      // review metadata (surfaced downstream so the book is still flagged for
      // admin review) instead of dead-ending the whole book on needs_review.
      log(`WARNING: BOOK_PASS_SHIP_ON_EXHAUSTION set — shipping despite ${residualFlags.length} residual book-pass flag(s): ${residualFlags.map((f) => `spread ${f.spread}: ${f.issue}`).join('; ')}. Book flagged for admin review.`);
      bookPassReview = needsReview;
    } else {
      const err = new Error(`book pass still flags ${residualFlags.length} spread(s) after the targeted regen wave`);
      err.needsReview = needsReview;
      throw err;
    }
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
        textLayout,
        mustIncludeFeatures,
        castLocks,
      }),
      candidateIndex: winner.candidateIndex,
      likeness: winner.likeness ?? null,
      repairWaves: result.repairWaves,
      // The art director's quiet zone — the embedded text layout typesets
      // the caption over this zone at PDF time, so it must survive on the
      // document (the in-memory direction map dies with this run).
      textZone: direction.directionBySpread.get(docSpread.spreadNumber)?.textZone || null,
      // The QA judge's boxes on the WINNING render — layout relocates the
      // caption when the planned zone contains the child (2026-07-18 audit:
      // captions across the hero's face) or ANY character (2026-07-19 audit
      // #2: a caption across two aliens' faces). Null for admin-picked
      // candidates (they bypass the judge).
      heroBox: winner.heroBox || null,
      figuresBox: winner.figuresBox || null,
    };
    docSpread.qa.spreadChecks.push({
      source: 'native-v3',
      // false for a spread shipped on QA exhaustion (winner.pass === false) —
      // the residual defects ride doc.qaAdvisories + doc.bookPassReview.
      pass: winner.pass !== false,
      likeness: winner.likeness ?? null,
      scores: winner.spreadScores || null,
    });
  }

  // ── qa advisories: minor observations that never block (closed-gate) ──
  // Winner-level minors from the spread judge + minor book-pass flags, so
  // the completion callback and the admin dashboard see exactly what the
  // judges noticed on the SHIPPED images. Capped — this is a digest, not
  // a transcript.
  const qaAdvisories = [...plateAdvisories];
  for (const [spreadNumber, result] of [...selections.entries()].sort((a, b) => a[0] - b[0])) {
    for (const note of result.selected?.minorDefects || []) {
      qaAdvisories.push({ stage: 'spreadQa', spread: spreadNumber, note });
    }
  }
  for (const f of bookPassMinors) {
    qaAdvisories.push({ stage: 'bookPass', spread: f.spread, note: f.issue });
  }
  // Ship-on-exhaustion residual issues (bookPass AND/OR spreadQa): surface them
  // as advisories so the completion callback + admin dashboard see the
  // unresolved defects, and attach the needs_review payload(s) to the doc so
  // downstream marks the shipped book for admin review (mirrors the bookPass
  // ship path #246 introduced; the spreadQa ship path reuses the same slot).
  if (bookPassReview) {
    for (const f of residualFlags) {
      qaAdvisories.push({ stage: 'bookPass', spread: f.spread, note: `UNRESOLVED (shipped on exhaustion): ${f.issue}` });
    }
  }
  if (spreadQaReview) {
    for (const [spreadNumber, result] of [...selections.entries()].sort((a, b) => a[0] - b[0])) {
      if (!result.selected?.shippedWithDefects) continue;
      const note = (result.selected.defects || [])[0] || `fail@${result.selected.stage}`;
      qaAdvisories.push({ stage: 'spreadQa', spread: spreadNumber, note: `UNRESOLVED (shipped on spreadQa exhaustion): ${note}` });
    }
  }
  const shipReviews = [spreadQaReview, bookPassReview].filter(Boolean);
  if (shipReviews.length === 1) {
    doc.bookPassReview = shipReviews[0];
  } else if (shipReviews.length > 1) {
    // Both stages shipped-on-exhaustion — merge into the single doc.bookPassReview
    // slot server.js reads, so every residual defect + candidate URL survives.
    // Primary = the earlier stage (spreadQa); `stages` records both.
    doc.bookPassReview = {
      ...shipReviews[0],
      stages: shipReviews.map((r) => r.stage),
      defects: shipReviews.flatMap((r) => r.defects || []).slice(0, 50),
      candidateUrls: shipReviews.flatMap((r) => r.candidateUrls || []).slice(0, 20),
    };
  }
  // P2: signal a cover re-harmonize when the book pass judged the cover itself
  // off-style versus the 3D interiors (server.js consumes this before building
  // the cover PDF).
  if (coverNeedsReharmonize) {
    doc.coverNeedsReharmonize = true;
    qaAdvisories.push({ stage: 'bookPass', spread: 'cover', note: `cover↔interior style parity break: ${coverNeedsReharmonize.reason} — cover re-harmonized to 3D` });
  }
  // Renderer-model audit (2026-07-28): imageClient's flash fallback on a
  // 404'd configured id used to be console-only — a "poisoned" instance
  // rendered whole books on flash indistinguishably from pro ones. The
  // winners now carry the model that ACTUALLY rendered them; a mismatch vs
  // the configured id becomes a book-level advisory + doc.rendererModels.
  {
    const usedModels = new Set();
    const downgradedSpreads = [];
    for (const [spreadNumber, result] of [...selections.entries()].sort((a, b) => a[0] - b[0])) {
      const winner = result.allCandidates?.find((c) => c.candidateIndex === result.selected?.candidateIndex);
      const model = winner?.rendererModel;
      if (!model) continue; // reused-from-GCS candidates carry no live model id
      usedModels.add(model);
      if (model !== SPREAD_RENDERER_MODEL) downgradedSpreads.push(spreadNumber);
    }
    doc.rendererModels = { configured: SPREAD_RENDERER_MODEL, used: [...usedModels] };
    if (downgradedSpreads.length > 0) {
      log(`WARNING: renderer model downgrade — configured '${SPREAD_RENDERER_MODEL}' but spreads [${downgradedSpreads.join(', ')}] rendered on [${[...usedModels].filter((m) => m !== SPREAD_RENDERER_MODEL).join(', ')}] (invalid configured id? see imageClient fallback logs)`);
      qaAdvisories.push({
        stage: 'render',
        spread: null,
        note: `renderer model downgrade: configured '${SPREAD_RENDERER_MODEL}', spreads [${downgradedSpreads.join(', ')}] rendered on the fallback model — fix BOOK_PIPELINE_V3_SPREAD_RENDERER_MODEL to a ListModels-confirmed id`,
      });
    }
  }
  doc.qaAdvisories = qaAdvisories.slice(0, 40);
  if (doc.qaAdvisories.length > 0) {
    log(`qa advisories: ${doc.qaAdvisories.length} (spreads ${[...new Set(doc.qaAdvisories.map((a) => a.spread))].join(', ')}) — shipped, not blocking`);
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
    // The tag distribution is the fastest diagnostic for a systematic
    // exhaustion — log it and ride it on the payload BEFORE throwing
    // (previously it was attached to the doc only on the success path
    // and died with the exhaustion).
    log(`spread QA exhausted — qaTagCounts: ${JSON.stringify(qaTagCounts)}`);
    const urls = await Promise.all(
      failedSpreads.flatMap((f) => f.allCandidates.map(async (c) => [c.path, await getSignedUrl(c.path).catch(() => c.path)])),
    );
    const urlByPath = new Map(urls);
    const err = new Error(
      `${failedSpreads.length} spread(s) exhausted the QA budget (spreads ${failedSpreads.map((f) => f.spread).join(', ')}) — needs human review with all candidates attached`,
    );
    err.needsReview = buildSpreadQaNeedsReview(failedSpreads, (p) => urlByPath.get(p) || p);
    if (err.needsReview.judgeScores) err.needsReview.judgeScores.qaTagCounts = qaTagCounts;
    return err;
  }

  // Ship-on-exhaustion for the spreadQa stage (BOOK_PASS_SHIP_ON_EXHAUSTION):
  // keep the least-bad candidate for each exhausted spread as its selection so
  // the book completes, log a loud WARNING per shipped-with-defects spread, and
  // return the needs_review payload (same shape spreadQaFailure builds) for the
  // doc so downstream flags the book for admin review.
  async function shipExhaustedSpreads(failedSpreads) {
    log(`WARNING: BOOK_PASS_SHIP_ON_EXHAUSTION set — ${failedSpreads.length} spread(s) exhausted spread QA (${failedSpreads.map((f) => f.spread).join(', ')}); shipping the least-bad candidate each and flagging for admin review. qaTagCounts: ${JSON.stringify(qaTagCounts)}`);
    for (const failure of failedSpreads) {
      const best = pickLeastBad(failure.evaluations)
        || { candidateIndex: failure.allCandidates[failure.allCandidates.length - 1]?.candidateIndex, stage: 'unknown', defects: [], likeness: null };
      const candidate = failure.allCandidates.find((c) => c.candidateIndex === best.candidateIndex)
        || failure.allCandidates[failure.allCandidates.length - 1];
      const residual = [...new Set(failure.evaluations.flatMap((e) => e.defects || []))].slice(0, 6);
      selections.set(failure.spread, {
        selected: {
          candidateIndex: candidate.candidateIndex,
          path: candidate.path,
          pass: false,
          stage: best.stage,
          likeness: best.likeness ?? null,
          defects: best.defects || [],
          minorDefects: best.minorDefects || [],
          heroBox: best.heroBox || null,
          figuresBox: best.figuresBox || null,
          spreadScores: best.spreadScores || null,
          shippedWithDefects: true,
        },
        evaluations: failure.evaluations,
        repairWaves: 0,
        allCandidates: failure.allCandidates,
      });
      log(`WARNING: spread ${failure.spread} SHIPPED WITH DEFECTS (candidate c${candidate.candidateIndex}, fail@${best.stage}) — residual: ${residual.join('; ') || 'none recorded'}`);
    }
    const urls = await Promise.all(
      failedSpreads.flatMap((f) => f.allCandidates.map(async (c) => [c.path, await getSignedUrl(c.path).catch(() => c.path)])),
    );
    const urlByPath = new Map(urls);
    const review = buildSpreadQaNeedsReview(failedSpreads, (p) => urlByPath.get(p) || p);
    if (review.judgeScores) review.judgeScores.qaTagCounts = qaTagCounts;
    review.shipped = true;
    return review;
  }
}

module.exports = {
  runNativeIllustrator,
  ArtDirectionBounceError,
  IMPLEMENTED_PHASES,
  PENDING_PHASES,
};
