/**
 * Top-level V3 workflow (writer + NATIVE illustrator — the only pipeline
 * since the 2026-07-15 cutover; the legacy illustrator adapter is deleted).
 *
 * Stages (docs/PIPELINE_V3_DESIGN.md §4):
 *   input    — age band + profile (reuses v2's derivation incl. the age=0 fix)
 *   planning — W0 creativeBrief → W1 conceptRoom ×3 (parallel) → W2 editorialSelection
 *              (A0 identity kit runs in PARALLEL with the whole writing chain)
 *   writing  — W3 two manuscripts in parallel (prompt-variant diversity — the
 *              anthropic family rejects temperature)
 *   writerQa — W4 mechanical gate per manuscript (hard fails → one surgical
 *              fix → re-gate) → W5 blind cross-family judge panel →
 *              W6 ≤2 targeted revision rounds → exhaustion ladder:
 *              other draft → fresh manuscript from runner-up concept →
 *              V3ExhaustionError (mapped to PipelineError judge_panel_exhausted)
 *              → post-panel polish pass on the accepted manuscript
 *   illustrating — native illustrator A1–A4 (art direction with unstageable
 *              bounces back to the writer, parallel renders, spread QA
 *              cascade, book pass), see illustrator/index.js
 *   bookWideQa / layout — panel scores attached, toLayoutPayload
 *
 * No ship-anyway (design decision D6): a manuscript that cannot pass the
 * panel fails the book with the judge history attached as needs_review.
 * Escape hatch for smoke tests that need a completed book regardless:
 * BOOK_PIPELINE_V3_SHIP_ON_EXHAUSTION=1.
 */

const { createWorkflowContext } = require('../workflowEngine');
const { createArtifactStore } = require('../../artifactStore');
const { getAgeProfile } = require('../../ageProfiles');
const { deriveAgeBandFromRequest, applyEmbeddedLayoutBudget } = require('../../ageProfiles');
const { buildNeedsReviewPayload } = require('../../reviewQueue/payload');
const { TOTAL_SPREADS } = require('../../contract/constants');

const { creativeBriefActivity } = require('../activities/creativeBrief');
const { coverImageryActivity } = require('../activities/coverImagery');
const { conceptRoomActivity, CONCEPT_ANGLES } = require('../activities/conceptRoom');
const { editorialSelectionActivity } = require('../activities/editorialSelection');
const { manuscriptWriterActivity } = require('../activities/manuscriptWriter');
const { mechanicalGateActivity } = require('../activities/mechanicalGate');
const { judgePanelActivity } = require('../activities/judgePanel');
const { manuscriptRevisionActivity, mergeTargets } = require('../activities/manuscriptRevision');
const { runNativeIllustrator } = require('../../illustrator');
const { resolveIllustratorVersion } = require('../../illustrator/config');
const { buildIdentityKit } = require('../../illustrator/identityKit');
const { resolveCoverAnchor } = require('../../illustrator/coverPreflight');
const { validatePanelFamilies } = require('../../llm/modelRouter');

const MAX_REVISION_ROUNDS = 2;

class V3ExhaustionError extends Error {
  constructor(message, { issues, needsReview, stage } = {}) {
    super(message);
    this.name = 'V3ExhaustionError';
    this.issues = issues || [];
    this.needsReview = needsReview || null;
    this.stage = stage || 'writerQa';
  }
}

/**
 * Token/cost ledger. USD rates are only recorded where we know them —
 * anthropic per docs; other families log tokens only (estUsd null) so the
 * summary never invents numbers.
 */
const USD_PER_MTOK = {
  'claude-opus-4-8': { input: 5, output: 25 },
};

function createCostLedger() {
  const rows = [];
  return {
    add(stage, artifact) {
      const usage = artifact?._usage;
      if (!usage) return;
      const model = artifact._model || artifact.model || 'unknown';
      const rate = USD_PER_MTOK[model];
      rows.push({
        stage,
        model,
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        estUsd: rate
          ? Number((((usage.inputTokens || 0) * rate.input + (usage.outputTokens || 0) * rate.output) / 1e6).toFixed(4))
          : null,
      });
    },
    addJudgeUsage(stage, usageByJudge) {
      for (const [judge, entry] of Object.entries(usageByJudge || {})) {
        rows.push({
          stage: `${stage}.${judge}`,
          model: entry.model || 'unknown',
          inputTokens: entry.inputTokens || 0,
          outputTokens: entry.outputTokens || 0,
          estUsd: USD_PER_MTOK[entry.model]
            ? Number((((entry.inputTokens || 0) * USD_PER_MTOK[entry.model].input + (entry.outputTokens || 0) * USD_PER_MTOK[entry.model].output) / 1e6).toFixed(4))
            : null,
        });
      }
    },
    summary() {
      const totalIn = rows.reduce((a, r) => a + r.inputTokens, 0);
      const totalOut = rows.reduce((a, r) => a + r.outputTokens, 0);
      const knownUsd = rows.reduce((a, r) => a + (r.estUsd || 0), 0);
      return { calls: rows.length, inputTokens: totalIn, outputTokens: totalOut, knownEstUsd: Number(knownUsd.toFixed(4)), rows };
    },
  };
}

/**
 * Gate a manuscript; if hard failures remain, one surgical fix from the
 * gate notes, then re-gate. Returns { manuscript, gate, eligible }.
 */
async function prepareCandidate({ ctx, manuscript, ageProfile, brief, roundTag, ledger }) {
  let current = manuscript;
  let gate = await ctx.execute(
    `gate.${current.id}.${roundTag}`,
    mechanicalGateActivity,
    { manuscript: current, ageProfile, brief },
    { retries: 0 },
  );

  if (gate.hardFailureCount > 0) {
    // Soft book lints piggyback the surgical fix — they never trigger one.
    const targets = mergeTargets([], gate.perSpread, gate.softLints || []);
    ctx.log('warn', `[v3] manuscript ${current.id} has ${gate.hardFailureCount} hard gate failures — one surgical fix on spreads [${targets.map((t) => t.spread).join(',')}]`);
    try {
      current = await ctx.execute(
        `gatefix.${current.id}.${roundTag}`,
        manuscriptRevisionActivity,
        { brief, ageProfile, manuscript: current, targets },
        { retries: 1 },
      );
      ledger.add(`gatefix.${current.id}.${roundTag}`, current);
      gate = await ctx.execute(
        `gate.${current.id}.${roundTag}.post`,
        mechanicalGateActivity,
        { manuscript: current, ageProfile, brief },
        { retries: 0 },
      );
    } catch (err) {
      ctx.log('warn', `[v3] gate fix for ${current.id} failed: ${err.message}`);
    }
  }

  return { manuscript: current, gate, eligible: gate.hardFailureCount === 0 };
}

/**
 * Judge candidates and, if none passes, run ≤MAX_REVISION_ROUNDS targeted
 * revision rounds on the panel winner. Returns
 * { accepted, manuscript, gate, panel, rounds, panelHistory } — accepted=false
 * means this branch is out of options.
 */
async function panelLoop({ ctx, candidates, ageProfile, brief, tag, ledger }) {
  const panelHistory = [];
  let round = 0;

  let panel = await ctx.execute(
    `panel.${tag}.r0`,
    judgePanelActivity,
    { brief, ageProfile, manuscripts: candidates.map((c) => c.manuscript) },
    { retries: 1 },
  );
  ledger.addJudgeUsage(`panel.${tag}.r0`, panel.usageByJudge);
  panelHistory.push(panel);

  const pick = (p) => {
    const passing = candidates
      .map((c) => ({ c, agg: p.perManuscript[c.manuscript.id] }))
      .filter((x) => x.agg && x.agg.pass)
      .sort((a, b) => b.agg.sumMedians - a.agg.sumMedians);
    return passing[0] || null;
  };

  let winner = pick(panel);
  if (winner) {
    return { accepted: true, manuscript: winner.c.manuscript, gate: winner.c.gate, panel, rounds: 0, panelHistory };
  }

  // No candidate passed — revise the panel's preferred manuscript.
  let bestId = panel.winnerId;
  let best = candidates.find((c) => c.manuscript.id === bestId) || candidates[0];

  for (round = 1; round <= MAX_REVISION_ROUNDS; round += 1) {
    const agg = panel.perManuscript[best.manuscript.id];
    const targets = mergeTargets(agg?.flaggedSpreads || [], best.gate?.perSpread || [], best.gate?.softLints || []);
    if (targets.length === 0) {
      // Panel failed on book-wide medians with no spread-level flags —
      // revision has nothing to grab onto; further rounds are pointless.
      ctx.log('warn', `[v3] panel.${tag} round ${round}: no spread-level targets despite failing medians — abandoning revision loop`);
      break;
    }
    ctx.log('info', `[v3] panel.${tag} round ${round}: revising ${best.manuscript.id} spreads [${targets.map((t) => t.spread).join(',')}]`);

    let revised;
    try {
      revised = await ctx.execute(
        `revision.${tag}.r${round}`,
        manuscriptRevisionActivity,
        { brief, ageProfile, manuscript: best.manuscript, targets },
        { retries: 1 },
      );
      ledger.add(`revision.${tag}.r${round}`, revised);
    } catch (err) {
      ctx.log('warn', `[v3] revision round ${round} failed: ${err.message}`);
      break;
    }

    const prepared = await prepareCandidate({
      ctx, manuscript: revised, ageProfile, brief, roundTag: `${tag}.r${round}`, ledger,
    });
    if (!prepared.eligible) {
      ctx.log('warn', `[v3] revised manuscript still has hard gate failures at round ${round}`);
      best = prepared; // keep the latest for reporting
      continue;
    }
    best = prepared;

    panel = await ctx.execute(
      `panel.${tag}.r${round}`,
      judgePanelActivity,
      { brief, ageProfile, manuscripts: [best.manuscript] },
      { retries: 1 },
    );
    ledger.addJudgeUsage(`panel.${tag}.r${round}`, panel.usageByJudge);
    panelHistory.push(panel);

    const aggAfter = panel.perManuscript[best.manuscript.id];
    if (aggAfter?.pass) {
      return { accepted: true, manuscript: best.manuscript, gate: best.gate, panel, rounds: round, panelHistory };
    }
  }

  return { accepted: false, manuscript: best.manuscript, gate: best.gate, panel, rounds: round, panelHistory };
}

function summarizePanel(panel, manuscriptId) {
  const agg = panel?.perManuscript?.[manuscriptId];
  if (!agg) return null;
  return {
    pass: agg.pass,
    medians: agg.medians,
    sumMedians: agg.sumMedians,
    failingDimensions: agg.failingDimensions,
    meaningSanityVetoes: agg.meaningSanityVetoes,
    degraded: panel.degraded,
  };
}

/** Bounded writer-revision rounds for art-director bounces. */
const MAX_BOUNCE_REVISIONS = 2;

/**
 * Native illustration with the art director's bounce-back edge (A1):
 * unstageable scene contracts get targeted writer revision rounds (the
 * feedback loop v1/v2 never had — problems fixed before pixels), bounded
 * at MAX_BOUNCE_REVISIONS. A spread newly flagged on a later pass gets its
 * own revision chance (the director is a model; pass 1 can miss a spread
 * pass 2 catches), but a spread RE-flagged after its revision short-circuits
 * to needs_review — revision demonstrably can't fix it.
 */
async function runNativeWithBounce({ ctx, illustrationInput, brief, ageProfile, ledger }) {
  const opts = { retries: 2, baseDelayMs: 4000, isRetryable: (err) => Boolean(err?.isTransient) };
  let manuscript = illustrationInput.manuscript;
  const revisedSpreads = new Set();

  for (let round = 0; ; round += 1) {
    const allowBounce = round < MAX_BOUNCE_REVISIONS; // final pass converts bounces to needs_review itself
    const passLabel = round === 0 ? 'illustrations.native' : `illustrations.native.r${round + 1}`;
    try {
      return await ctx.execute(passLabel, runNativeIllustrator, { ...illustrationInput, manuscript, allowBounce }, opts);
    } catch (err) {
      const bounce = err?.name === 'ArtDirectionBounceError' ? err : (err?.cause?.name === 'ArtDirectionBounceError' ? err.cause : null);
      if (!bounce) throw err;

      const reflagged = bounce.bounces.filter((b) => revisedSpreads.has(b.spread));
      if (reflagged.length > 0) {
        // The writer already revised these spreads and the director still
        // can't stage them — more rounds won't converge. Human review.
        const reviewErr = new Error(`art director still cannot stage spread(s) [${reflagged.map((b) => b.spread).join(', ')}] after a writer revision round`);
        reviewErr.needsReview = buildNeedsReviewPayload({
          stage: 'artDirection',
          reason: 'art_direction_unstageable',
          spread: reflagged[0].spread,
          defects: bounce.bounces.map((b) => `spread ${b.spread}: ${b.problem} (suggested: ${b.suggestion})`),
        });
        throw reviewErr;
      }

      ctx.log('warn', `[v3] art director bounced spreads [${bounce.bounces.map((b) => b.spread).join(', ')}] (revision round ${round + 1}/${MAX_BOUNCE_REVISIONS}) — targeted writer revision before any rendering`);
      const targets = bounce.bounces.map((b) => ({
        spread: b.spread,
        // Scene-level flags: the revision MUST change the scene_contract —
        // the art director stages from the contract, not the prose.
        requireContractChange: true,
        notes: [`unstageable for the illustrator: ${b.problem}`, `suggested fix: ${b.suggestion}`].filter(Boolean),
      }));
      const fixLabel = round === 0 ? 'manuscript.bounceFix' : `manuscript.bounceFix.r${round + 1}`;
      const revised = await ctx.execute(fixLabel, manuscriptRevisionActivity, {
        brief,
        ageProfile,
        manuscript,
        targets,
      }, { retries: 1 });
      ledger.add(fixLabel, revised);
      for (const b of bounce.bounces) revisedSpreads.add(b.spread);
      manuscript = revised;
    }
  }
}

/**
 * @param {{ rawRequest: object, signals?: object, log?: function }} opts
 */
async function runCreateBookWorkflow({ rawRequest, signals = {}, log }) {
  const bookId = rawRequest?.bookId || `book_${Date.now()}`;
  const store = createArtifactStore({ bookId });
  const ctx = createWorkflowContext({ bookId, store, signals, log });
  const ledger = createCostLedger();
  const spreadCount = TOTAL_SPREADS;

  ctx.log('info', `[v3] workflow start bookId=${bookId} child=${rawRequest?.child?.name || 'n/a'} spreads=${spreadCount}`);
  validatePanelFamilies((msg) => ctx.log('warn', msg));
  ctx.reportProgress({ step: 'input', message: 'Preparing request' });

  // ── input ──
  const ageBand = deriveAgeBandFromRequest(rawRequest);
  const ageProfile = getAgeProfile(ageBand);
  ageProfile.ageBand = ageBand;
  ageProfile.band = ageBand;
  const theme = rawRequest?.theme || 'adventure';

  // Always native since the cutover — resolution survives for provenance
  // (doc.v3 + callbacks) and for LOUD handling of pre-cutover 'legacy' state.
  const illustrator = resolveIllustratorVersion({
    requestedVersion: rawRequest?.illustratorVersion || null,
    checkpointVersion: rawRequest?.checkpointIllustratorVersion || null,
    log: (msg) => ctx.log('warn', `[v3] ${msg}`),
  });
  ctx.log('info', `[v3] illustrator: ${illustrator.version} (source=${illustrator.source})`);

  // Text layout (2026-07-17, admin-selectable): 'caption' = typeset text on
  // white verso pages + square art recto (default); 'embedded' = one wide
  // illustration spanning both pages with the caption typeset OVER the quiet
  // zone. Checkpoint wins so resumed books finish on the mode they started.
  const textLayout = rawRequest?.checkpointTextLayout || rawRequest?.textLayout || 'caption';
  ctx.log('info', `[v3] text layout: ${textLayout}`);
  // Text-only (admin writing test, 2026-08-06): run the full WRITING chain —
  // brief → concepts → drafts → gate → judge panel → polish — then return the
  // accepted manuscript as the document, with NO identity kit, NO cover
  // pre-flight vision calls, NO art direction, and NO renders. Per-dispatch
  // (never checkpoint-pinned): a later full dispatch regenerates fresh.
  const textOnly = rawRequest?.textOnly === true;
  if (textOnly) ctx.log('info', '[v3] TEXT-ONLY run — illustration stages will be skipped');
  // Embedded captions share the page with the art — clamp the band's word
  // budget ONCE here so the writer prompt, mechanical gate, and every other
  // consumer of the profile agree (2026-07-28 audit: 55-75-word captions
  // scrimmed over 30-45% of the art in embedded book 4c8daf08).
  applyEmbeddedLayoutBudget(ageProfile, textLayout);

  // Cover pre-flight (2026-07-28): resolve ONE verified cover anchor before
  // anything consumes it. The approved cover is the style ground truth for
  // the sheet, every spread render, the plates AND the spread judge — a 2D
  // cover inverted every guard, and harmonization used to run only at
  // cover-PDF time (after the interiors). Never blocks: failure keeps the
  // original URL with an advisory.
  const coverAnchor = textOnly
    // No pixels will be anchored on the cover — skip the pre-flight vision
    // check/harmonization entirely (the URL may also be absent).
    ? { url: rawRequest?.cover?.imageUrl || null, harmonized: false, advisory: null }
    : await resolveCoverAnchor({
      bookId,
      coverImageUrl: rawRequest?.cover?.imageUrl || null,
      abortSignal: signals?.abortSignal,
      log: (m) => ctx.log('info', `[v3] ${m}`),
    });
  const resolvedCoverUrl = coverAnchor.url;

  // A0 identity kit runs in PARALLEL with the writer —
  // photos → likeness brief → judged character model sheet, GCS-cached.
  // Joined before rendering; a kit failure surfaces there. Text-only runs
  // never render, so the kit (and its vision/image spend) is skipped.
  const kitPhotoUrls = rawRequest?.child?.photoUrls || [];
  let identityKitPromise = null;
  if (!textOnly && kitPhotoUrls.length > 0) {
    ctx.log('info', `[v3] identity kit: starting in parallel with the writer (${kitPhotoUrls.length} photo(s))`);
    identityKitPromise = buildIdentityKit({
      photoUrls: kitPhotoUrls,
      ageBand,
      childDetails: { name: rawRequest?.child?.name, gender: rawRequest?.child?.gender },
      // The parent-approved cover anchors sheet generation (it's an
      // illustration, so attaching it is PROHIBITED_CONTENT-safe).
      coverImageUrl: resolvedCoverUrl,
      bookId,
      // pick_sheet resolution (admin picked a rejected candidate) bypasses
      // generation + judging on the re-dispatch.
      reviewResolution: rawRequest?.reviewResolution || null,
      abortSignal: signals?.abortSignal,
      log: (m) => ctx.log('info', `[v3] [identityKit] ${m}`),
    });
    identityKitPromise.catch(() => {}); // defused here; the real await rethrows at the join
  }

  // ── planning ──
  ctx.reportProgress({ step: 'planning', message: 'Building creative brief' });
  // P4 (audit 2026-07-15): describe what the parent-approved cover depicts
  // so the writer chain honors its imagery. Non-fatal — degrades to null.
  // (the activity catches its own errors and returns null — engine-level
  // errors like aborts still propagate)
  const coverImagery = await ctx.execute('coverImagery', coverImageryActivity,
    { coverImageUrl: resolvedCoverUrl }, { retries: 1 });
  const brief = await ctx.execute('brief', creativeBriefActivity, { rawRequest, ageProfile, coverImagery }, { retries: 1 });
  ledger.add('brief', brief);

  const concepts = await Promise.all(CONCEPT_ANGLES.map((angle) =>
    ctx.execute(`concept.${angle.id}`, conceptRoomActivity,
      { brief, ageProfile, theme, spreadCount, angle, coverImagery }, { retries: 1 })));
  concepts.forEach((c) => ledger.add(`concept.${c.id}`, c));

  const selection = await ctx.execute('selection', editorialSelectionActivity,
    { brief, ageProfile, concepts }, { retries: 1 });
  ledger.add('selection', selection);

  const winnerConcept = concepts.find((c) => c.id === selection.winner_id);
  const runnerUpConcept = concepts.find((c) => c.id === selection.runner_up_id);

  // ── writing — best-of-2 from the winning concept ──
  ctx.checkAbort();
  ctx.reportProgress({ step: 'writing', message: 'Writing manuscripts' });
  const [draftA, draftB] = await Promise.all([
    ctx.execute('manuscript.A', manuscriptWriterActivity,
      { brief, ageProfile, concept: winnerConcept, selection, spreadCount, variant: 'A' }, { retries: 1 }),
    ctx.execute('manuscript.B', manuscriptWriterActivity,
      { brief, ageProfile, concept: winnerConcept, selection, spreadCount, variant: 'B' }, { retries: 1 }),
  ]);
  ledger.add('manuscript.A', draftA);
  ledger.add('manuscript.B', draftB);

  // ── writerQa — gate, panel, revision loop, exhaustion ladder ──
  ctx.checkAbort();
  ctx.reportProgress({ step: 'writerQa', message: 'Quality panel reviewing manuscripts' });

  const prepared = [];
  for (const draft of [draftA, draftB]) {
    prepared.push(await prepareCandidate({ ctx, manuscript: draft, ageProfile, brief, roundTag: 'r0', ledger }));
  }
  let candidates = prepared.filter((p) => p.eligible);
  if (candidates.length === 0) {
    ctx.log('warn', '[v3] both drafts ineligible after gate fixes — proceeding with least-broken for panel targeting');
    candidates = [prepared.sort((a, b) => a.gate.hardFailureCount - b.gate.hardFailureCount)[0]];
  }

  let outcome = await panelLoop({ ctx, candidates, ageProfile, brief, tag: 'main', ledger });
  const panelHistory = [...outcome.panelHistory];

  // Exhaustion ladder step 2: one fresh manuscript from the runner-up concept.
  if (!outcome.accepted && runnerUpConcept) {
    ctx.log('warn', `[v3] main branch exhausted — fresh manuscript from runner-up concept '${runnerUpConcept.id}'`);
    try {
      const fresh = await ctx.execute('manuscript.fresh', manuscriptWriterActivity,
        { brief, ageProfile, concept: runnerUpConcept, selection, spreadCount, variant: 'fresh' }, { retries: 1 });
      ledger.add('manuscript.fresh', fresh);
      const freshPrepared = await prepareCandidate({ ctx, manuscript: fresh, ageProfile, brief, roundTag: 'fresh', ledger });
      if (freshPrepared.eligible) {
        const freshOutcome = await panelLoop({ ctx, candidates: [freshPrepared], ageProfile, brief, tag: 'fresh', ledger });
        panelHistory.push(...freshOutcome.panelHistory);
        if (freshOutcome.accepted) outcome = freshOutcome;
        else if (!outcome.accepted) {
          // keep whichever scored higher for reporting
          const mainSum = outcome.panel?.perManuscript?.[outcome.manuscript.id]?.sumMedians || 0;
          const freshSum = freshOutcome.panel?.perManuscript?.[freshOutcome.manuscript.id]?.sumMedians || 0;
          if (freshSum > mainSum) outcome = freshOutcome;
        }
      }
    } catch (err) {
      ctx.log('warn', `[v3] fresh-manuscript branch failed: ${err.message}`);
    }
  }

  if (!outcome.accepted) {
    const finalSummary = summarizePanel(outcome.panel, outcome.manuscript.id);
    const issues = [
      `Final panel verdict for '${outcome.manuscript.title}': failing dimensions [${finalSummary?.failingDimensions?.join(', ') || 'n/a'}], meaning-sanity vetoes [${finalSummary?.meaningSanityVetoes?.join(', ') || 'none'}]`,
      ...panelHistory.slice(-2).flatMap((p) => Object.entries(p.perManuscript).map(
        ([id, agg]) => `${id}: sumMedians=${agg.sumMedians.toFixed(1)} failing=[${agg.failingDimensions.join(',')}]`,
      )),
    ];
    const reviewResolution = rawRequest?.reviewResolution || null;
    if (process.env.BOOK_PIPELINE_V3_SHIP_ON_EXHAUSTION === '1') {
      ctx.log('warn', '[v3] SHIP_ON_EXHAUSTION=1 — shipping best-scoring manuscript with writerQa.pass=false');
    } else if (reviewResolution?.action === 'ship_best') {
      ctx.log('warn', `[v3] review approval (${reviewResolution.admin || 'admin'}) — shipping best-scoring manuscript with writerQa.pass=false`);
    } else {
      throw new V3ExhaustionError(
        'manuscript failed the bookstore-standard judge panel after revision rounds, the second draft, and a fresh attempt from the runner-up concept',
        {
          issues,
          needsReview: buildNeedsReviewPayload({
            stage: 'writerQa',
            reason: 'judge_panel_exhausted',
            defects: issues,
            judgeScores: finalSummary || null,
            manuscriptHistory: [outcome.manuscript && {
              id: outcome.manuscript.id,
              title: outcome.manuscript.title,
              conceptId: outcome.manuscript.concept_id || null,
            }].filter(Boolean),
            judgeHistory: panelHistory.map((p) => p.perManuscript),
          }),
        },
      );
    }
  }

  let { manuscript, gate } = outcome;
  const { panel } = outcome;
  const panelSummary = summarizePanel(panel, manuscript.id);

  // ── polish pass (2026-07-28) ──
  // A PASSING panel still leaves per-spread judge flags and soft lints
  // behind — previously detected and then discarded, so an accepted-first-try
  // book shipped its weakest spreads untouched. One craft pass on the 2-3
  // weakest spreads (flagged by 2+ judges, or lint-targeted: overused words,
  // formulaic hooks), then a re-gate; if the polish breaks the gate the
  // pre-polish manuscript ships unchanged. Kill-switch:
  // BOOK_PIPELINE_V3_POLISH_PASS=0.
  if (process.env.BOOK_PIPELINE_V3_POLISH_PASS !== '0' && outcome.accepted) {
    const flaggedSpreads = panel?.perManuscript?.[manuscript.id]?.flaggedSpreads || [];
    const flagCounts = new Map();
    for (const f of flaggedSpreads) {
      if (Number.isFinite(f?.spread)) flagCounts.set(f.spread, (flagCounts.get(f.spread) || 0) + 1);
    }
    const lintTargets = new Set((gate?.softLints || []).flatMap((l) => l.targetSpreads || []));
    const polishSet = new Set([
      ...[...flagCounts.entries()].filter(([, n]) => n >= 2).map(([s]) => s),
      ...lintTargets,
    ]);
    const targets = mergeTargets(flaggedSpreads, [], gate?.softLints || [])
      .filter((t) => polishSet.has(t.spread))
      .sort((a, b) => b.notes.length - a.notes.length)
      .slice(0, 3)
      .sort((a, b) => a.spread - b.spread);
    if (targets.length > 0) {
      ctx.reportProgress({ step: 'writerQa', message: 'Polish pass on the weakest spreads' });
      ctx.log('info', `[v3] polish pass: spreads [${targets.map((t) => t.spread).join(',')}] (${flaggedSpreads.length} judge flags, ${lintTargets.size} lint-targeted)`);
      try {
        const polished = await ctx.execute(
          'polish.main',
          manuscriptRevisionActivity,
          { brief, ageProfile, manuscript, targets, mode: 'polish' },
          { retries: 0 },
        );
        ledger.add('polish.main', polished);
        const check = await prepareCandidate({ ctx, manuscript: polished, ageProfile, brief, roundTag: 'polish', ledger });
        if (check.eligible) {
          manuscript = check.manuscript;
          gate = check.gate;
        } else {
          ctx.log('warn', `[v3] polish pass broke the gate (${check.gate.hardFailureCount} hard failures after fix) — REVERTING to the pre-polish manuscript`);
        }
      } catch (err) {
        ctx.log('warn', `[v3] polish pass failed (${err.message}) — shipping the pre-polish manuscript`);
      }
    }
  }

  // ── illustrating ──
  ctx.checkAbort();
  const acceptedConcept = outcome.manuscript.concept_id === runnerUpConcept?.id ? runnerUpConcept : winnerConcept;
  let renderedDoc;
  if (textOnly) {
    // Build the same v1-shape document skeleton the illustrator would —
    // spreads carry the manuscript text with `illustration: null`
    // (toLegacyStoryPlan and toLayoutPayload are null-safe on it) — so
    // server.js's document consumption works unchanged.
    ctx.log('info', '[v3] TEXT-ONLY — skipping identity kit join, art direction, and rendering');
    const { createBookDocument } = require('../../contract/bookDocument');
    const { buildVisualBible, buildSpreadSpecs, buildStoryBible } = require('../activities/illustrationDirector');
    const { buildSpreadsForLegacyIllustrator } = require('../activities/illustrationAdapterHelpers');
    const visualBible = buildVisualBible({ rawRequest, brief, concept: acceptedConcept, manuscript });
    visualBible.textRendering = { policy: 'typeset-by-layout-engine' }; // D5
    const spreadSpecs = buildSpreadSpecs({ manuscript, ageProfile });
    const draftBySpread = new Map(manuscript.spreads.map((s) => [s.spread, { text: s.text, lines: s.lines }]));
    renderedDoc = createBookDocument({
      request: { ...rawRequest, bookId, ageBand },
      brief: rawRequest || {},
      cover: {
        title: manuscript.title || rawRequest?.cover?.title || 'My Story',
        imageUrl: resolvedCoverUrl || null,
        characterLocks: {},
        outfitLocks: {},
      },
    });
    renderedDoc.storyBible = buildStoryBible({ concept: acceptedConcept, manuscript });
    renderedDoc.visualBible = visualBible;
    renderedDoc.spreadSpecs = spreadSpecs;
    renderedDoc.spreads = buildSpreadsForLegacyIllustrator({ spreadSpecs, draftBySpread });
    renderedDoc.textOnly = true;
  } else {
    // Join the identity kit (native path): exhaustion becomes a stage-tagged
    // needs_review, infra errors propagate as ordinary failures.
    let identityKit = null;
    if (identityKitPromise) {
      try {
        identityKit = await identityKitPromise;
        ctx.log('info', `[v3] identity kit ready (fromCache=${identityKit.fromCache}, minLikeness=${identityKit.judgeScores?.minLikeness ?? 'n/a'})`);
      } catch (err) {
        if (err?.needsReview) {
          throw new V3ExhaustionError(err.message, {
            issues: err.needsReview.defects || [],
            needsReview: err.needsReview,
            stage: 'identityKit',
          });
        }
        throw err;
      }
    }

    const illustrationInput = {
      identityKit,
      rawRequest,
      brief,
      ageProfile,
      concept: acceptedConcept,
      manuscript,
      coverImageUrl: resolvedCoverUrl,
      coverTitle: rawRequest?.cover?.title || null,
      // Pre-flight outcome — the illustrator records the advisory (if any) as
      // an artDirection qaAdvisory so a harmonized/unfixable anchor is visible.
      coverPreflight: coverAnchor,
      operationalContext: signals,
      textLayout,
    };
    try {
      renderedDoc = await runNativeWithBounce({ ctx, illustrationInput, brief, ageProfile, ledger });
    } catch (err) {
      // QA/art-direction exhaustion is a review item, not a plain failure (D6).
      const payload = err?.needsReview || err?.cause?.needsReview;
      if (payload) {
        throw new V3ExhaustionError(err.cause?.message || err.message, {
          issues: payload.defects || [],
          needsReview: payload,
          stage: payload.stage || 'spreadQa',
        });
      }
      throw err;
    }
  }
  // ── bookWideQa / layout ──
  ctx.reportProgress({ step: 'bookWideQa', message: 'Attaching quality report' });
  renderedDoc.writerQa = {
    pass: outcome.accepted,
    rounds: outcome.rounds,
    warnings: outcome.accepted ? [] : [
      rawRequest?.reviewResolution?.action === 'ship_best'
        ? 'judge_panel_exhausted_shipped_by_review_approval'
        : 'judge_panel_exhausted_shipped_by_env_flag',
    ],
    gate: gate ? {
      passed: gate.passed,
      hardFailureCount: gate.hardFailureCount,
      perSpread: gate.perSpread.map((e) => ({ spread: e.spread, passed: e.passed, failureCount: e.failures.length })),
      // Soft lints were previously logged and lost — persisting them lets the
      // admin dashboard see the craft observations on the SHIPPED manuscript.
      softLints: (gate.softLints || []).map((l) => ({ code: l.code, message: l.message, targetSpreads: l.targetSpreads || [] })),
    } : null,
    panel: panelSummary,
  };
  renderedDoc.bookWideQa = {
    pass: outcome.accepted,
    scores: panelSummary?.medians || null,
    judges: (panel?.reports || []).map((r) => ({ judge: r.judge, family: r.family, model: r.model })),
  };
  renderedDoc.v3 = {
    illustrator: { version: illustrator.version, source: illustrator.source },
    textLayout,
    ...(textOnly ? { textOnly: true } : {}),
    coverImagery: coverImagery || null,
    concepts,
    selection,
    manuscriptMeta: {
      winnerId: manuscript.id,
      conceptId: manuscript.concept_id,
      form: manuscript.form,
      refrain: manuscript.refrain,
      title: manuscript.title,
      roundsUsed: outcome.rounds,
    },
    sceneContracts: manuscript.spreads.map((s) => ({ spread: s.spread, ...s.scene_contract, refrain_here: s.refrain_here })),
    judgeReports: panelHistory.map((p) => ({
      perManuscript: p.perManuscript,
      degraded: p.degraded,
      failedJudges: p.failedJudges,
    })),
    costs: ledger.summary(),
  };

  const costs = renderedDoc.v3.costs;
  ctx.log('info', `[bookPipelineV3] cost summary calls=${costs.calls} in=${costs.inputTokens} out=${costs.outputTokens} knownEstUsd=$${costs.knownEstUsd}`);

  ctx.reportProgress({ step: 'layout', message: 'Preparing layout' });
  const { toLayoutPayload } = require('../../contract/toLayoutPayload');
  let layout;
  try {
    layout = toLayoutPayload(renderedDoc);
  } catch (err) {
    ctx.log('warn', `[v3] toLayoutPayload threw: ${err.message} — returning empty layout`);
    layout = { entries: [] };
  }

  ctx.log('info', `[v3] workflow complete bookId=${bookId} spreads=${renderedDoc.spreads.length} form=${manuscript.form} rounds=${outcome.rounds}`);
  return {
    document: renderedDoc,
    layout,
    artifacts: await store.snapshot(),
  };
}

module.exports = {
  runCreateBookWorkflow,
  V3ExhaustionError,
  MAX_REVISION_ROUNDS,
  // exported for tests
  prepareCandidate,
  panelLoop,
  createCostLedger,
  summarizePanel,
};
