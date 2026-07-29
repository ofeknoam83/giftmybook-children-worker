/**
 * W5 — Judge Panel.
 *
 * Three judges from three DIFFERENT model families score the candidate
 * manuscript(s) blind against the bookstore-standard rubric. Aggregation
 * is deterministic code, not another LLM call:
 *
 *   - median score per dimension per manuscript (median of 3 defeats one
 *     outlier judge; with a degraded 2-judge panel the median of 2 means
 *     BOTH must be at the bar)
 *   - PASS = median >= PANEL_PASS_MEDIAN on every dimension AND no judge
 *     raised meaning_sanity_fail
 *   - winner = higher sum of medians
 *
 * Robustness: each judge is jsonMode + schema-validated with one
 * in-activity retry; a judge that still returns garbage is dropped and
 * the panel degrades to 2 with a loud warning. Fewer than 2 valid judges
 * fails the activity (the engine retries once, then ActivityFailedError).
 *
 * Blindness: judges receive manuscripts with neutral labels and no
 * authorship/variant/model info; presentation order rotates per judge so
 * primacy bias can't systematically favor one draft.
 */

const fs = require('fs');
const path = require('path');
const { callWithRole, modelFor, JUDGE_ROLES } = require('../../llm/modelRouter');
const { normalizeJudgeReport, JUDGE_DIMENSIONS } = require('../../schema/document');

const SYSTEM = fs.readFileSync(
  path.join(__dirname, '../../llm/prompts/judgePanel.system.md'),
  'utf8',
);

// The quality bar. Uncalibrated pre-shadow-phase (design doc §11) — if
// exhaustion rates on admin test books run hot, this single constant is
// the tuning knob.
const PANEL_PASS_MEDIAN = 4;

// Judge-facing labels are ALWAYS these neutral positional letters, never the
// manuscript ids. Two reasons (book fff0c611, 2026-07-28): (1) blindness —
// ids like 'fresh' leak provenance ("this is a regenerated attempt") to a
// panel that must not know it; (2) robustness — the judge prompt's schema
// example anchors hard on "A"/"B", so a manuscript labeled 'fresh' made
// judges echo label 'A', fail schema validation twice, and get DROPPED —
// every fresh-branch panel ran degraded (both survivors must clear the bar).
const BLIND_LABELS = ['A', 'B'];

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Strip authorship/provenance before a manuscript goes in front of a judge.
 */
function blindManuscript(manuscript, label) {
  return {
    label,
    title: manuscript.title,
    form: manuscript.form,
    refrain: manuscript.refrain,
    spreads: manuscript.spreads.map((s) => ({
      spread: s.spread,
      lines: s.lines,
      refrain_here: s.refrain_here,
      scene_contract: s.scene_contract,
    })),
  };
}

async function callOneJudge({ role, brief, ageProfile, blinded, judgeIndex }) {
  const { family, model } = modelFor(role);
  // Rotate presentation order per judge (primacy-bias defense).
  const ordered = judgeIndex % 2 === 0 ? blinded : blinded.slice().reverse();
  const userPrompt = JSON.stringify({
    brief: {
      gift_intent: brief?.gift_intent,
      child_as_character: brief?.child_as_character,
      constraints: brief?.constraints,
      // Raw interests + the brief's world sentence go to judges directly —
      // a brief that under-weighted a stated interest must still be caught
      // by personalization_depth, not laundered through its own ranking.
      interests: brief?.interests || [],
      story_world: brief?.story_world || null,
      themes: brief?.themes || null,
      storyRoles: brief?.storyRoles || null,
    },
    ageProfile: {
      band: ageProfile?.ageBand || ageProfile?.band,
      narrativeConstraints: ageProfile?.narrativeConstraints,
    },
    manuscripts: ordered,
  });

  const resp = await callWithRole(role, {
    systemPrompt: SYSTEM,
    userPrompt,
    jsonMode: true,
    temperature: 0.2,
    // 8000, not 4000: gemini-2.5-pro truncated at 4000 on every observed
    // run, burning a ~30s attempt before the retry bumped it here anyway.
    maxTokens: 8000,
    label: `v3.judge.${role.toLowerCase()}`,
  });

  const report = normalizeJudgeReport(resp.json, {
    judge: role,
    family,
    model: resp.model,
    expectedLabels: blinded.map((m) => m.label),
  });
  return { report, usage: resp.usage, model: resp.model };
}

/**
 * Deterministic aggregation of validated reports.
 */
function aggregateReports(reports, labels) {
  const perManuscript = {};
  for (const label of labels) {
    const medians = {};
    for (const dim of JUDGE_DIMENSIONS) {
      medians[dim] = median(reports.map((r) => r.manuscripts.get(label).scores[dim].score));
    }
    const meaningSanityVetoes = reports
      .filter((r) => r.manuscripts.get(label).meaning_sanity_fail)
      .map((r) => r.judge);
    const flaggedSpreads = reports.flatMap((r) =>
      r.manuscripts.get(label).flagged_spreads.map((f) => ({ ...f, judge: r.judge })));
    const failingDimensions = JUDGE_DIMENSIONS.filter((dim) => medians[dim] < PANEL_PASS_MEDIAN);
    perManuscript[label] = {
      medians,
      sumMedians: JUDGE_DIMENSIONS.reduce((acc, dim) => acc + medians[dim], 0),
      failingDimensions,
      meaningSanityVetoes,
      pass: failingDimensions.length === 0 && meaningSanityVetoes.length === 0,
      flaggedSpreads,
    };
  }
  const winnerId = labels.slice().sort((a, b) => perManuscript[b].sumMedians - perManuscript[a].sumMedians)[0];
  return { perManuscript, winnerId };
}

/**
 * @param {{ brief: object, ageProfile: object, manuscripts: object[] }} input
 *   manuscripts — 1 or 2 candidates, each already normalized (schema/document).
 */
async function judgePanelActivity(input, ctx) {
  const { brief, ageProfile, manuscripts } = input;
  if (!Array.isArray(manuscripts) || manuscripts.length < 1 || manuscripts.length > 2) {
    throw new Error(`judgePanel: expected 1-2 manuscripts, got ${manuscripts?.length || 0}`);
  }
  const labels = manuscripts.map((_, i) => BLIND_LABELS[i]);
  const idByLabel = new Map(manuscripts.map((m, i) => [labels[i], m.id]));
  const blinded = manuscripts.map((m, i) => blindManuscript(m, labels[i]));

  const reports = [];
  const failedJudges = [];
  const usageByJudge = {};
  await Promise.all(JUDGE_ROLES.map(async (role, judgeIndex) => {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const { report, usage, model } = await callOneJudge({ role, brief, ageProfile, blinded, judgeIndex });
        reports.push(report);
        usageByJudge[role] = { model, inputTokens: usage?.inputTokens || 0, outputTokens: usage?.outputTokens || 0 };
        return;
      } catch (err) {
        if (attempt === 2) {
          ctx.log('warn', `[v3] judge ${role} DROPPED after 2 attempts: ${err.message}`);
          failedJudges.push({ role, error: String(err.message).slice(0, 300) });
          return;
        }
        ctx.log('warn', `[v3] judge ${role} attempt ${attempt} failed (${err.message}); retrying`);
      }
    }
  }));

  if (reports.length < 2) {
    throw new Error(`judgePanel: only ${reports.length}/3 judges returned valid reports (${failedJudges.map((f) => `${f.role}: ${f.error}`).join(' | ')})`);
  }
  const degraded = reports.length < JUDGE_ROLES.length;
  if (degraded) {
    ctx.log('warn', `[v3] JUDGE PANEL DEGRADED to ${reports.length} judges — median of 2 means both must clear the bar`);
  }

  const { perManuscript, winnerId } = aggregateReports(reports, labels);

  // Un-blind for callers: everything downstream (panelLoop, review payloads,
  // checkpoints) is keyed by the real manuscript ids, not the blind labels.
  const perManuscriptById = {};
  for (const label of labels) {
    const id = idByLabel.get(label);
    const agg = perManuscript[label];
    perManuscriptById[id] = agg;
    ctx.log('info', `[v3] panel ${id}: pass=${agg.pass} sumMedians=${agg.sumMedians.toFixed(1)} failing=[${agg.failingDimensions.join(',')}] sanityVetoes=[${agg.meaningSanityVetoes.join(',')}] flags=${agg.flaggedSpreads.length}`);
  }

  return {
    reports: reports.map((r) => ({
      judge: r.judge,
      family: r.family,
      model: r.model,
      manuscripts: Object.fromEntries(
        [...r.manuscripts].map(([label, m]) => [idByLabel.get(label), m]),
      ),
    })),
    perManuscript: perManuscriptById,
    winnerId: idByLabel.get(winnerId),
    degraded,
    failedJudges,
    usageByJudge,
    passMedian: PANEL_PASS_MEDIAN,
  };
}

module.exports = {
  judgePanelActivity,
  aggregateReports,
  blindManuscript,
  median,
  PANEL_PASS_MEDIAN,
};
