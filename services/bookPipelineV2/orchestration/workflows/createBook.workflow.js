/**
 * Top-level v2 workflow: create a picture book from a normalized request.
 *
 * Stages (per design doc §2):
 *   1.  personalizationInterpreter  → PersonalizationBrief
 *   2.  ageAdaptation               → AgeProfile (band-tuned)
 *   3.  storyIntent                 → StoryIntent
 *   4.  storyPlanner                → StoryBible (compact)
 *   5.  characterBible              → CharacterBible[]
 *   6.  worldBible                  → WorldBible
 *   7.  beatSheet                   → BeatSheet (one beat per spread)
 *   8-11. per-spread: writer → det gate → critic → revision (≤3 rounds)
 *   12. bookWideCritic              → BookWideCriticReport
 *   13. illustrationDirector        → renders all spreads (v1 illustrator for tonight)
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
const { pageWriterActivity } = require('../activities/pageWriter');
const { deterministicGateActivity } = require('../activities/deterministicGate');
const { spreadCriticActivity } = require('../activities/spreadCritic');
const { revisionEngineActivity } = require('../activities/revisionEngine');
const { bookWideCriticActivity } = require('../activities/bookWideCritic');
const { illustrationDirectorActivity } = require('../activities/illustrationDirector');
const { summarizeSpread, recentSummaries } = require('../../memory/rollingSummary');

const MAX_REVISION_ROUNDS = 3;
// Critic acceptance thresholds (per design doc §5).
const ACCEPT_SCORE = 4;        // average of all numeric scores
const BEAT_FIDELITY_MIN = 4;   // hard floor on beat_fidelity

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

function isAcceptableCritic(report) {
  if (!report) return false;
  if (report.meaning_sanity?.passed === false) return false;
  if (report.prohibited_respected?.passed === false) return false;
  if (report.bible_consistency?.passed === false) return false;
  const beatFidelity = report.scores?.beat_fidelity ?? 0;
  if (beatFidelity < BEAT_FIDELITY_MIN) return false;
  if (avgScore(report.scores) < ACCEPT_SCORE) return false;
  return Boolean(report.accept_recommendation || true);
}

// Gate-failure codes that must NEVER ship — even after revision rounds
// are exhausted. These are the structural breaks that destroy the
// reading experience: a non-rhyme rhyme, banned dialogue, past tense
// in a present-tense band, the same word starting every line, beat
// rules ignored. "Soft" failures (line length window, imperfect rhyme
// when it's an eye-rhyme not a non-rhyme, filler phrases) are tolerated
// on exhaustion because they're a matter of degree.
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
 * Score a candidate draft for best-of-N selection. Lower is better.
 * Hard failures count 100 each; soft failures count 1.
 */
function draftPenalty(gateResult) {
  if (!gateResult || gateResult.passed) return 0;
  const fails = Array.isArray(gateResult.failures) ? gateResult.failures : [];
  let p = 0;
  for (const f of fails) p += HARD_GATE_CODES.has(f.code) ? 100 : 1;
  return p;
}

/**
 * Run the per-spread writer/gate/critic/revision loop for ONE beat.
 * Returns the best draft we could produce (may carry warnings).
 *
 * Best-of-N: track every candidate draft we generate, score by gate
 * penalty (hard failures cost 100 each, soft cost 1). On exhaustion,
 * ship the lowest-penalty draft — not necessarily the last one. This
 * stops the loop from "correcting" a clean draft into a worse one.
 */
async function runSpreadLoop({ ctx, beat, ageProfile, intent, characterBible, worldBible, summaries }) {
  const protagonistName = (characterBible?.characters || [])[0]?.name || 'the child';
  const stageBase = `spread_${beat.spread}`;
  const candidates = []; // { draft, gate, critic|null }

  // Initial draft.
  let draft = await ctx.execute(
    `${stageBase}.draft.r0`,
    pageWriterActivity,
    { beat, ageProfile, intent, characterBible, worldBible, recentSummaries: summaries },
    { retries: 1 },
  );

  let lastCritic = null;
  for (let round = 0; round < MAX_REVISION_ROUNDS; round += 1) {
    // Deterministic gate.
    const gate = await ctx.execute(
      `${stageBase}.gate.r${round}`,
      deterministicGateActivity,
      { draft, beat, ageProfile, protagonistName },
      { retries: 0 },
    );
    candidates.push({ draft, gate, critic: null });

    if (!gate.passed) {
      ctx.log('warn', `[v2] spread ${beat.spread} det gate failed (round ${round}): ${gate.failures.map(f => f.code).join(', ')}; revising`);
      draft = await ctx.execute(
        `${stageBase}.draft.r${round + 1}`,
        revisionEngineActivity,
        { draft, beat, ageProfile, characterBible, worldBible, recentSummaries: summaries, failures: gate.failures, mode: 'deterministic' },
        { retries: 1 },
      );
      continue; // re-run gate next iteration
    }

    // Det gate passed → cross-family critic.
    lastCritic = await ctx.execute(
      `${stageBase}.critic.r${round}`,
      spreadCriticActivity,
      { draft, beat, ageProfile, intent, characterBible, previousSummary: summaries[summaries.length - 1] || null },
      { retries: 1 },
    );
    // Update the latest candidate with the critic verdict.
    candidates[candidates.length - 1].critic = lastCritic;

    if (isAcceptableCritic(lastCritic)) {
      ctx.log('info', `[v2] spread ${beat.spread} ACCEPTED at round ${round}`);
      return { draft, critic: lastCritic, rounds: round };
    }

    if (round >= MAX_REVISION_ROUNDS - 1) break;

    // Critic rejected → critic-driven revision.
    ctx.log('info', `[v2] spread ${beat.spread} critic rejected at round ${round}; revising`);
    draft = await ctx.execute(
      `${stageBase}.draft.r${round + 1}.critic`,
      revisionEngineActivity,
      { draft, beat, ageProfile, characterBible, worldBible, recentSummaries: summaries, failures: lastCritic.suggested_fixes, mode: 'critic' },
      { retries: 1 },
    );
  }

  // Exhausted. Pick the candidate with the lowest penalty (best gate result).
  // If multiple tie at the minimum, prefer the one with a passing critic.
  candidates.sort((a, b) => {
    const pa = draftPenalty(a.gate);
    const pb = draftPenalty(b.gate);
    if (pa !== pb) return pa - pb;
    const ca = a.critic && isAcceptableCritic(a.critic) ? 0 : 1;
    const cb = b.critic && isAcceptableCritic(b.critic) ? 0 : 1;
    return ca - cb;
  });
  const best = candidates[0] || { draft, gate: null, critic: lastCritic };
  const bestHardFails = hardFailures(best.gate?.failures);
  if (bestHardFails.length > 0) {
    // No clean candidate exists. Try ONE more fresh write from scratch —
    // a structurally new draft is more likely to clear hard failures than
    // another surgical revision of a stuck one.
    ctx.log('warn', `[v2] spread ${beat.spread} all ${candidates.length} candidates have hard failures (${bestHardFails.map(f => f.code).join(', ')}); attempting one fresh rewrite`);
    try {
      const freshDraft = await ctx.execute(
        `${stageBase}.draft.fresh`,
        pageWriterActivity,
        { beat, ageProfile, intent, characterBible, worldBible, recentSummaries: summaries, freshAttempt: true },
        { retries: 1 },
      );
      const freshGate = await ctx.execute(
        `${stageBase}.gate.fresh`,
        deterministicGateActivity,
        { draft: freshDraft, beat, ageProfile, protagonistName },
        { retries: 0 },
      );
      const freshHard = hardFailures(freshGate.failures);
      if (freshHard.length < bestHardFails.length) {
        ctx.log('warn', `[v2] spread ${beat.spread} fresh rewrite is cleaner (${freshHard.length} hard fails vs ${bestHardFails.length}); using it`);
        return {
          draft: freshDraft,
          critic: null,
          rounds: MAX_REVISION_ROUNDS + 1,
          warning: freshHard.length === 0 ? 'fresh_rewrite_clean' : 'fresh_rewrite_partial',
        };
      }
    } catch (err) {
      ctx.log('warn', `[v2] spread ${beat.spread} fresh rewrite failed: ${err.message}`);
    }
  }
  const warning = bestHardFails.length > 0
    ? `max_rounds_exhausted_with_hard_failures:${bestHardFails.map(f => f.code).join(',')}`
    : 'max_rounds_exhausted';
  ctx.log('warn', `[v2] spread ${beat.spread} EXHAUSTED; shipping best-of-${candidates.length} (penalty=${draftPenalty(best.gate)})`);
  return { draft: best.draft, critic: best.critic || lastCritic, rounds: MAX_REVISION_ROUNDS, warning };
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
  // Belt-and-suspenders: every JSON profile already carries `ageBand`,
  // but some downstream code reads `band` — set both for safety.
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

  // Stages 8-11 per spread
  const accepted = [];
  const summaries = [];
  for (const beat of beatSheet.spreads) {
    ctx.checkAbort();
    const recent = recentSummaries(summaries, beat.spread, 2);
    const { draft, critic, rounds, warning } = await runSpreadLoop({
      ctx, beat, ageProfile, intent, characterBible, worldBible, summaries: recent,
    });
    accepted.push({ beat, draft, critic, rounds, warning: warning || null });
    // Tiny rolling summary for the next spread.
    try {
      const summary = await summarizeSpread({ spread: beat.spread, beat, draft, intent });
      summaries.push(summary);
    } catch (err) {
      ctx.log('warn', `[v2] summarizer failed for spread ${beat.spread}: ${err.message} (continuing)`);
    }
  }

  // Stage 12 — book-wide critic (advisory tonight; we log targeted_revisions but don't loop)
  let bookWide = null;
  try {
    bookWide = await ctx.execute('bookWide', bookWideCriticActivity,
      { intent, beatSheet, drafts: accepted.map((a) => a.draft), characterBible, worldBible },
      { retries: 0 });
  } catch (err) {
    ctx.log('warn', `[v2] bookWideCritic failed: ${err.message} (continuing without book-wide grade)`);
  }

  // Stage 13 — illustration director (adapter to v1 illustrator for tonight)
  const renderedDoc = await ctx.execute('illustrations', illustrationDirectorActivity, {
    rawRequest,
    brief,
    ageProfile,
    intent,
    storyBible,
    characterBible,
    worldBible,
    beatSheet,
    drafts: accepted.map((a) => a.draft),
    coverImageUrl: rawRequest?.cover?.imageUrl || null,
    coverTitle: rawRequest?.cover?.title || null,
    operationalContext: signals,
  }, {
    // 2 retries (3 total attempts) gated on transient infra errors.
    // Gemini Session API 503/UNAVAILABLE shows up sporadically during
    // peak demand; a couple of retries with backoff usually clears it.
    // Non-transient errors (deploy bugs, schema mismatches) still fail
    // immediately on first attempt.
    retries: 2,
    baseDelayMs: 4000,
    isRetryable: (err) => Boolean(err?.isTransient),
  });

  // Persist v2-side QA fields onto the doc so server's incremental
  // storyContent push reads sensible writerQa/bookWideQa booleans.
  renderedDoc.writerQa = {
    pass: accepted.every((a) => !a.warning),
    rounds: accepted.map((a) => ({ spread: a.beat.spread, rounds: a.rounds, warning: a.warning, scores: a.critic?.scores || {} })),
  };
  renderedDoc.bookWideQa = bookWide
    ? { pass: bookWide.accept_recommendation, scores: bookWide.scores, targeted_revisions: bookWide.targeted_revisions }
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
  isAcceptableCritic,
  avgScore,
  runSpreadLoop,
  HARD_GATE_CODES,
  hardFailures,
  draftPenalty,
};
