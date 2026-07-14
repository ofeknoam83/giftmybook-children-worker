/**
 * Top-level V3 workflow (milestone 1 — writer + v1 illustrator adapter).
 *
 * Stages (docs/PIPELINE_V3_DESIGN.md §4):
 *   input    — age band + profile (reuses v2's derivation incl. the age=0 fix)
 *   planning — W0 creativeBrief → W1 conceptRoom ×3 (parallel) → W2 editorialSelection
 *   writing  — W3 two manuscripts in parallel (prompt-variant diversity — the
 *              anthropic family rejects temperature)
 *   writerQa — W4 mechanical gate per manuscript (hard fails → one surgical
 *              fix → re-gate) → W5 blind cross-family judge panel →
 *              W6 ≤2 targeted revision rounds → exhaustion ladder:
 *              other draft → fresh manuscript from runner-up concept →
 *              V3ExhaustionError (mapped to PipelineError judge_panel_exhausted)
 *   illustrating / bookWideQa / layout — v1 illustrator via the adapter,
 *              panel scores attached, toLayoutPayload
 *
 * No ship-anyway: a manuscript that cannot pass the panel fails the book
 * with the judge history attached (admin-only traffic in milestone 1 —
 * design decision D6 interim). Escape hatch for smoke tests that need a
 * completed book regardless: BOOK_PIPELINE_V3_SHIP_ON_EXHAUSTION=1.
 */

const { createWorkflowContext } = require('../workflowEngine');
const { createArtifactStore } = require('../../artifactStore');
const { getAgeProfile } = require('../../ageProfiles');
const { deriveAgeBandFromRequest } = require('../../ageProfiles');
const { buildNeedsReviewPayload } = require('../../reviewQueue/payload');
const { TOTAL_SPREADS } = require('../../contract/constants');

const { creativeBriefActivity } = require('../activities/creativeBrief');
const { conceptRoomActivity, CONCEPT_ANGLES } = require('../activities/conceptRoom');
const { editorialSelectionActivity } = require('../activities/editorialSelection');
const { manuscriptWriterActivity } = require('../activities/manuscriptWriter');
const { mechanicalGateActivity } = require('../activities/mechanicalGate');
const { judgePanelActivity } = require('../activities/judgePanel');
const { manuscriptRevisionActivity, mergeTargets } = require('../activities/manuscriptRevision');
const { illustrationDirectorActivity } = require('../activities/illustrationDirector');
const { runNativeIllustrator } = require('../../illustrator');
const { resolveIllustratorVersion } = require('../../illustrator/config');
const { buildIdentityKit } = require('../../illustrator/identityKit');
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
    const targets = mergeTargets([], gate.perSpread);
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
    const targets = mergeTargets(agg?.flaggedSpreads || [], best.gate?.perSpread || []);
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

  // Milestone-2 flag: native "Art Studio" vs the legacy v1 quad adapter.
  // Resolved once per run (checkpoint → request → env → default) and
  // reported in doc.v3 + pipeline callbacks so A/B stays auditable.
  const illustrator = resolveIllustratorVersion({
    requestedVersion: rawRequest?.illustratorVersion || null,
    checkpointVersion: rawRequest?.checkpointIllustratorVersion || null,
    log: (msg) => ctx.log('warn', `[v3] ${msg}`),
  });
  ctx.log('info', `[v3] illustrator: ${illustrator.version} (source=${illustrator.source})`);

  // A0 identity kit runs in PARALLEL with the writer (native path only) —
  // photos → likeness brief → judged character model sheet, GCS-cached.
  // Joined before rendering; a kit failure surfaces there.
  const kitPhotoUrls = rawRequest?.child?.photoUrls || [];
  let identityKitPromise = null;
  if (illustrator.version === 'native' && kitPhotoUrls.length > 0) {
    ctx.log('info', `[v3] identity kit: starting in parallel with the writer (${kitPhotoUrls.length} photo(s))`);
    identityKitPromise = buildIdentityKit({
      photoUrls: kitPhotoUrls,
      ageBand,
      childDetails: { name: rawRequest?.child?.name, gender: rawRequest?.child?.gender },
      abortSignal: signals?.abortSignal,
      log: (m) => ctx.log('info', `[v3] [identityKit] ${m}`),
    });
    identityKitPromise.catch(() => {}); // defused here; the real await rethrows at the join
  }

  // ── planning ──
  ctx.reportProgress({ step: 'planning', message: 'Building creative brief' });
  const brief = await ctx.execute('brief', creativeBriefActivity, { rawRequest, ageProfile }, { retries: 1 });
  ledger.add('brief', brief);

  const concepts = await Promise.all(CONCEPT_ANGLES.map((angle) =>
    ctx.execute(`concept.${angle.id}`, conceptRoomActivity,
      { brief, ageProfile, theme, spreadCount, angle }, { retries: 1 })));
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

  const { manuscript, gate, panel } = outcome;
  const panelSummary = summarizePanel(panel, manuscript.id);

  // ── illustrating ──
  ctx.checkAbort();
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
    concept: outcome.manuscript.concept_id === runnerUpConcept?.id ? runnerUpConcept : winnerConcept,
    manuscript,
    coverImageUrl: rawRequest?.cover?.imageUrl || null,
    coverTitle: rawRequest?.cover?.title || null,
    operationalContext: signals,
  };
  let renderedDoc;
  try {
    renderedDoc = illustrator.version === 'native'
      ? await ctx.execute('illustrations.native', runNativeIllustrator, illustrationInput, {
        retries: 2,
        baseDelayMs: 4000,
        isRetryable: (err) => Boolean(err?.isTransient),
      })
      : await ctx.execute('illustrations', illustrationDirectorActivity, illustrationInput, {
        retries: 2,
        baseDelayMs: 4000,
        isRetryable: (err) => Boolean(err?.isTransient),
      });
  } catch (err) {
    // Spread-QA exhaustion is a review item, not a plain failure (D6).
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
