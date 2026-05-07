/**
 * Top-level v2 workflow: create a picture book from a normalized request.
 *
 * Manuscript-level architecture (post-refactor):
 *   1.  personalizationInterpreter  → PersonalizationBrief
 *   2.  ageAdaptation               → AgeProfile (band-tuned)
 *   3.  storyIntent                 → StoryIntent
 *   4.  storyPlanner                → StoryBible (compact)
 *   5.  characterBible              → CharacterBible[]
 *   6.  worldBible                  → WorldBible
 *   7.  beatSheet                   → BeatSheet (one beat per spread)
 *   8.  manuscriptWriter            → entire manuscript in ONE call
 *   9.  manuscriptGate              → sync checks across all spreads + ONE combined rhyme-judge call
 *   10. manuscriptCritic            → grades whole book + per-spread; emits targeted_revisions
 *   11. manuscriptRevision          → ONE call to rewrite only flagged spreads (≤ MAX_REVISION_ROUNDS)
 *   12. illustrationDirector        → renders all spreads (v1 illustrator adapter)
 *
 * Why one-shot: gpt-5.4 sees the whole book at once. Continuity, arc,
 * callbacks, and book-wide non-repetition emerge from a single mind
 * writing everything together — no rolling summaries, no per-spread
 * critic loop. The single critic call sees all 13 spreads at once and
 * catches arc/voice/repetition issues a per-spread critic literally
 * cannot see.
 *
 * Every stage's output is persisted to the artifact store. Replays from
 * any stage are free.
 */

const { createWorkflowContext } = require('../workflowEngine');
const { createArtifactStore } = require('../../artifactStore');
const { getAgeProfile, deriveAgeBandFromAge } = require('../../ageProfiles');

const { personalizationInterpreterActivity } = require('../activities/personalizationInterpreter');
const { ageAdaptationActivity } = require('../activities/ageAdaptation');
const { storyIntentActivity } = require('../activities/storyIntent');
const { storyPlannerActivity } = require('../activities/storyPlanner');
const { characterBibleActivity } = require('../activities/characterBible');
const { worldBibleActivity } = require('../activities/worldBible');
const { beatSheetActivity } = require('../activities/beatSheet');
const { manuscriptWriterActivity } = require('../activities/manuscriptWriter');
const { manuscriptGateActivity } = require('../activities/manuscriptGate');
const { manuscriptCriticActivity } = require('../activities/manuscriptCritic');
const { manuscriptRevisionActivity } = require('../activities/manuscriptRevision');
const { illustrationDirectorActivity } = require('../activities/illustrationDirector');

const MAX_REVISION_ROUNDS = 3;

function deriveAgeBandFromRequest(rawRequest) {
  const child = rawRequest?.child || {};
  const ageMonths = child.ageMonths || child.age_months || null;
  const ageYears = child.age || child.ageYears || null;
  return deriveAgeBandFromAge({ ageMonths, ageYears: typeof ageYears === 'number' ? ageYears : null });
}

function avgScore(scores) {
  const values = Object.values(scores || {}).filter((v) => typeof v === 'number');
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Gate-failure codes that must NEVER ship — even after revision rounds
// are exhausted. Structural breaks: a non-rhyme rhyme, banned dialogue,
// past tense in a present-tense band, the same word starting every line,
// beat rules ignored. "Soft" failures (line length window, imperfect
// rhyme as eye-rhyme not non-rhyme, filler phrases) are tolerated on
// exhaustion because they're a matter of degree.
const HARD_GATE_CODES = new Set([
  'identity_rhyme',
  'dialogue_quoted_speech',
  'dialogue_single_quoted',
  'dialogue_tag_verb',
  'past_tense_irregular',
  'past_tense_regular',
  'line_starter_repeat',
  'headline_noun_repeat',
  'beat_prohibited',
  'protagonist_anti_verb',
  'moralising_phrase',
]);

function hardFailures(failures) {
  if (!Array.isArray(failures)) return [];
  return failures.filter((f) => HARD_GATE_CODES.has(f.code));
}

/**
 * Merge a revision patch (only flagged spreads) into the current
 * manuscript. Returns a fresh array.
 */
function mergeRevision(currentManuscript, patchSpreads) {
  if (!Array.isArray(patchSpreads) || patchSpreads.length === 0) return currentManuscript.slice();
  const bySpread = new Map(patchSpreads.map((s) => [s.spread, s]));
  return currentManuscript.map((s) => bySpread.get(s.spread) || s);
}

/**
 * Build a targeted_revisions list from a manuscriptGate result.
 * Each entry: { spread, failures: [...], reasons: [...] }.
 */
function targetedFromGate(gateResult) {
  if (!gateResult || !Array.isArray(gateResult.perSpread)) return [];
  return gateResult.perSpread
    .filter((e) => !e.passed)
    .map((e) => ({
      spread: e.spread,
      failures: e.failures,
      reasons: e.failures.map((f) => f.message || f.code || f.check),
    }));
}

/**
 * Build a targeted_revisions list from a manuscriptCritic report.
 * Includes both `targeted_revisions[]` and per-spread issues to give
 * the revisor the full picture.
 */
function targetedFromCritic(criticReport) {
  if (!criticReport) return [];
  const tr = Array.isArray(criticReport.targeted_revisions) ? criticReport.targeted_revisions : [];
  const perSpread = Array.isArray(criticReport.per_spread) ? criticReport.per_spread : [];
  const targetSet = new Set(tr.map((t) => t.spread));
  // If targeted_revisions is empty but per_spread has issues with hard codes, include those.
  if (targetSet.size === 0) return [];
  return Array.from(targetSet).map((spread) => {
    const trEntry = tr.find((t) => t.spread === spread) || {};
    const psEntry = perSpread.find((e) => e.spread === spread) || {};
    const reasons = [];
    if (trEntry.reason) reasons.push(trEntry.reason);
    if (Array.isArray(psEntry.issues)) {
      for (const iss of psEntry.issues) {
        const r = [iss.kind, iss.line_index != null ? `L${iss.line_index + 1}` : null, iss.quote ? `"${iss.quote}"` : null, iss.direction]
          .filter(Boolean).join(' — ');
        if (r) reasons.push(r);
      }
    }
    return { spread, failures: psEntry.issues || [], reasons };
  });
}

/**
 * Merge gate-targeted and critic-targeted lists into a single list per spread.
 */
function mergeTargeted(...lists) {
  const bySpread = new Map();
  for (const list of lists) {
    for (const t of list || []) {
      const existing = bySpread.get(t.spread);
      if (existing) {
        existing.failures = (existing.failures || []).concat(t.failures || []);
        existing.reasons = (existing.reasons || []).concat(t.reasons || []);
      } else {
        bySpread.set(t.spread, { spread: t.spread, failures: t.failures || [], reasons: t.reasons || [] });
      }
    }
  }
  return Array.from(bySpread.values()).sort((a, b) => a.spread - b.spread);
}

/**
 * Run the manuscript-level loop: write → gate → critic → revise (≤ MAX_REVISION_ROUNDS).
 * Returns: { manuscript, lastGate, lastCritic, rounds, warnings }.
 */
async function runManuscriptLoop({ ctx, beatSheet, ageProfile, intent, characterBible, worldBible }) {
  const protagonistName = (characterBible?.characters || [])[0]?.name || 'the child';
  const warnings = [];

  // Initial manuscript draft.
  let writerOut = await ctx.execute(
    'manuscript.r0',
    manuscriptWriterActivity,
    { beatSheet, ageProfile, intent, characterBible, worldBible },
    { retries: 1 },
  );
  let manuscript = writerOut.spreads;

  let lastGate = null;
  let lastCritic = null;
  let round = 0;

  for (round = 0; round < MAX_REVISION_ROUNDS; round += 1) {
    // Gate (sync per-spread + 1 combined rhyme-judge LLM call).
    lastGate = await ctx.execute(
      `manuscript.gate.r${round}`,
      manuscriptGateActivity,
      { drafts: manuscript, beatSheet, ageProfile, protagonistName },
      { retries: 0 },
    );

    // Critic (sees current manuscript regardless of gate state).
    lastCritic = await ctx.execute(
      `manuscript.critic.r${round}`,
      manuscriptCriticActivity,
      { intent, beatSheet, drafts: manuscript, ageProfile, characterBible, worldBible },
      { retries: 1 },
    );

    const gateTargets = targetedFromGate(lastGate);
    const criticTargets = targetedFromCritic(lastCritic);
    const merged = mergeTargeted(gateTargets, criticTargets);

    if (merged.length === 0) {
      ctx.log('info', `[v2] manuscript ACCEPTED at round ${round}`);
      return { manuscript, lastGate, lastCritic, rounds: round, warnings };
    }

    if (round >= MAX_REVISION_ROUNDS - 1) {
      // Last allowed round already used; break and report.
      ctx.log('warn', `[v2] manuscript rounds exhausted with ${merged.length} targeted spreads`);
      break;
    }

    // Revise the flagged spreads in ONE call.
    ctx.log('info', `[v2] manuscript round ${round} revising ${merged.length} spreads: ${merged.map((t) => t.spread).join(',')}`);
    const mode = gateTargets.length && criticTargets.length ? 'mixed'
      : gateTargets.length ? 'gate' : 'critic';
    const revOut = await ctx.execute(
      `manuscript.revision.r${round + 1}`,
      manuscriptRevisionActivity,
      {
        currentManuscript: manuscript.map((d) => ({ spread: d.spread, lines: d.lines })),
        beatSheet, ageProfile, intent, characterBible, worldBible,
        targetedRevisions: merged.map((t) => ({ spread: t.spread, failures: t.failures, reasons: t.reasons })),
        mode,
      },
      { retries: 1 },
    );
    manuscript = mergeRevision(manuscript, revOut.spreads);
  }

  // Exhausted. Compute warnings: any spread with hard failures still standing.
  const finalGateTargets = targetedFromGate(lastGate);
  const hardStillStanding = finalGateTargets
    .map((t) => ({ spread: t.spread, hard: hardFailures(t.failures) }))
    .filter((x) => x.hard.length > 0);

  if (hardStillStanding.length > 0) {
    // One last fresh rewrite — sometimes a structurally new draft clears
    // hard failures that surgical revision can't.
    ctx.log('warn', `[v2] manuscript ${hardStillStanding.length} spreads still have hard failures (${hardStillStanding.map((x) => x.spread + ':' + x.hard.map(h => h.code).join('|')).join(' ')}); attempting one fresh rewrite`);
    try {
      const freshOut = await ctx.execute(
        'manuscript.fresh',
        manuscriptWriterActivity,
        { beatSheet, ageProfile, intent, characterBible, worldBible, freshAttempt: true },
        { retries: 1 },
      );
      const freshGate = await ctx.execute(
        'manuscript.gate.fresh',
        manuscriptGateActivity,
        { drafts: freshOut.spreads, beatSheet, ageProfile, protagonistName },
        { retries: 0 },
      );
      const freshHardCount = freshGate.perSpread
        .reduce((acc, e) => acc + hardFailures(e.failures).length, 0);
      const oldHardCount = hardStillStanding.reduce((acc, x) => acc + x.hard.length, 0);
      if (freshHardCount < oldHardCount) {
        ctx.log('warn', `[v2] fresh rewrite cleaner (${freshHardCount} vs ${oldHardCount} hard fails); using it`);
        manuscript = freshOut.spreads;
        lastGate = freshGate;
        warnings.push(freshHardCount === 0 ? 'fresh_rewrite_clean' : 'fresh_rewrite_partial');
      } else {
        warnings.push(`max_rounds_exhausted_with_hard_failures:${hardStillStanding.map((x) => x.spread).join(',')}`);
      }
    } catch (err) {
      ctx.log('warn', `[v2] fresh rewrite failed: ${err.message}`);
      warnings.push(`max_rounds_exhausted_with_hard_failures:${hardStillStanding.map((x) => x.spread).join(',')}`);
    }
  } else {
    warnings.push('max_rounds_exhausted_soft_failures_only');
  }

  ctx.log('warn', `[v2] manuscript EXHAUSTED at round ${round}; shipping`);
  return { manuscript, lastGate, lastCritic, rounds: round, warnings };
}

/**
 * Run the whole workflow.
 *
 * @param {object} rawRequest         — server.js's pipelineRequest shape
 * @param {object} signals            — { abortSignal, touchActivity, onProgress }
 * @param {function} log              — (level, msg, meta?) => void
 * @returns {{ document: object, layout: object, artifacts: object }}
 */
async function runCreateBookWorkflow({ rawRequest, signals = {}, log }) {
  const bookId = rawRequest?.bookId || `book_${Date.now()}`;
  const store = createArtifactStore({ bookId });
  const ctx = createWorkflowContext({ bookId, store, signals, log });

  ctx.log('info', `[v2] workflow start bookId=${bookId} child=${rawRequest?.child?.name || 'n/a'}`);

  // Stage 1
  const ageBand = deriveAgeBandFromRequest(rawRequest);
  const seedAgeProfile = getAgeProfile(ageBand);

  const brief = await ctx.execute('brief', personalizationInterpreterActivity,
    { rawRequest, ageProfile: seedAgeProfile }, { retries: 1 });

  // Stage 2
  const ageProfile = await ctx.execute('ageProfile', ageAdaptationActivity,
    { ageBand, brief }, { retries: 0 });
  ageProfile.ageBand = ageBand;
  ageProfile.band = ageBand;

  // Stage 3
  const intent = await ctx.execute('intent', storyIntentActivity,
    { brief, ageProfile }, { retries: 1 });

  // Stage 4
  const storyBible = await ctx.execute('storyBible', storyPlannerActivity,
    { intent, ageProfile }, { retries: 1 });

  // Stage 5
  const characterBible = await ctx.execute('characterBible', characterBibleActivity,
    { rawRequest, brief, ageProfile, intent, coverImageUrl: rawRequest?.cover?.imageUrl || null }, { retries: 1 });

  // Stage 6
  const worldBible = await ctx.execute('worldBible', worldBibleActivity,
    { rawRequest, intent, ageProfile, characterBible, coverImageUrl: rawRequest?.cover?.imageUrl || null }, { retries: 1 });

  // Stage 7
  const beatSheet = await ctx.execute('beatSheet', beatSheetActivity,
    { intent, storyBible, ageProfile, characterBible, worldBible }, { retries: 1 });

  // Stages 8-11 — manuscript-level loop
  ctx.checkAbort();
  const { manuscript, lastGate, lastCritic, rounds, warnings } = await runManuscriptLoop({
    ctx, beatSheet, ageProfile, intent, characterBible, worldBible,
  });

  // Stage 12 — illustration director
  const renderedDoc = await ctx.execute('illustrations', illustrationDirectorActivity, {
    rawRequest,
    brief,
    ageProfile,
    intent,
    storyBible,
    characterBible,
    worldBible,
    beatSheet,
    drafts: manuscript,
    coverImageUrl: rawRequest?.cover?.imageUrl || null,
    coverTitle: rawRequest?.cover?.title || null,
    operationalContext: signals,
  }, {
    retries: 2,
    baseDelayMs: 4000,
    isRetryable: (err) => Boolean(err?.isTransient),
  });

  // Persist v2-side QA fields onto the doc so server's incremental
  // storyContent push reads sensible writerQa/bookWideQa booleans.
  renderedDoc.writerQa = {
    pass: warnings.length === 0,
    rounds,
    warnings,
    gate: lastGate ? {
      passed: lastGate.passed,
      perSpread: lastGate.perSpread.map((e) => ({ spread: e.spread, passed: e.passed, failureCount: e.failures.length })),
    } : null,
  };
  renderedDoc.bookWideQa = lastCritic
    ? {
      pass: lastCritic.accept_recommendation,
      scores: lastCritic.scores,
      targeted_revisions: lastCritic.targeted_revisions,
      hard_checks: {
        meaning: lastCritic.meaning_sanity_book_wide?.passed,
        bible: lastCritic.bible_consistency_book_wide?.passed,
        prohibited: lastCritic.prohibited_respected_book_wide?.passed,
      },
    }
    : { pass: true, skipped: true };

  // Build the layout payload via the existing v1 layout adapter so the
  // server's downstream PDF code is untouched.
  const { toLayoutPayload } = require('../../../bookPipeline/adapters/toLayoutPayload');
  let layout;
  try {
    layout = toLayoutPayload(renderedDoc);
  } catch (err) {
    ctx.log('warn', `[v2] toLayoutPayload threw: ${err.message} — returning empty layout`);
    layout = { entries: [] };
  }

  ctx.log('info', `[v2] workflow complete bookId=${bookId} spreads=${renderedDoc.spreads.length}`);
  return {
    document: renderedDoc,
    layout,
    artifacts: await store.snapshot(),
  };
}

module.exports = {
  runCreateBookWorkflow,
  // exported for tests
  avgScore,
  runManuscriptLoop,
  HARD_GATE_CODES,
  hardFailures,
  mergeRevision,
  targetedFromGate,
  targetedFromCritic,
  mergeTargeted,
};
