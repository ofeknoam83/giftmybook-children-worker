/**
 * Stage 10 — Manuscript Critic (whole-book, single call)
 *
 * Replaces both the per-spread `spreadCritic` AND the prior
 * `bookWideCritic`. Sees the entire manuscript and grades:
 *  - whole-book: arc, callbacks, theme, ending, repetition, rhythm
 *  - per-spread: beat fidelity, meaning, surgical issues per spread
 *
 * Returns a `ManuscriptCriticReport` with `targeted_revisions[]`
 * naming exactly which spreads need another pass.
 *
 * Routed to CRITIC role (gpt-5.4 strong; cross-family rule dropped).
 */

const fs = require('fs');
const path = require('path');
const { callWithRole } = require('../../llm/modelRouter');

const SYSTEM = fs.readFileSync(
  path.join(__dirname, '../../llm/prompts/manuscriptCritic.system.md'),
  'utf8',
);

async function manuscriptCriticActivity(input, ctx) {
  const { intent, beatSheet, drafts, ageProfile, characterBible, worldBible } = input;

  const userPrompt = JSON.stringify({
    instructions: 'Grade the full manuscript per the schema. Return ManuscriptCriticReport JSON. Include one per_spread entry per spread; targeted_revisions lists exactly the spreads that need another pass.',
    intent: {
      logline: intent?.logline,
      arc: intent?.arc,
      theme_delivered_via: intent?.theme_delivered_via,
      callback_motifs: intent?.callback_motifs,
      banned_elements: intent?.banned_elements,
      ending_feeling: intent?.ending_feeling,
      climax_payoff_image: intent?.climax_payoff_image,
    },
    ageProfileSummary: {
      band: ageProfile?.ageBand || ageProfile?.band,
      linesPerSpread: ageProfile?.narrativeConstraints?.linesPerSpread,
      wordsPerSpread: ageProfile?.narrativeConstraints?.wordsPerSpread,
      syllablesPerLine: ageProfile?.narrativeConstraints?.syllablesPerLine,
      dialogueDensity: ageProfile?.narrativeConstraints?.dialogueDensity,
    },
    beatSheet: {
      spreads: (beatSheet?.spreads || []).map((b) => ({
        spread: b.spread,
        purpose: b.purpose,
        target_emotion: b.target_emotion,
        page_turn_hook: b.page_turn_hook,
        success_criteria: b.success_criteria,
        prohibited: b.prohibited,
        callbacks_introduced: b.callbacks_introduced,
        callbacks_used: b.callbacks_used,
      })),
    },
    manuscript: drafts.map((d) => ({ spread: d.spread, lines: d.lines })),
    characterBible,
    worldBible: {
      style_rules: worldBible?.style_rules,
      prohibited_visual_drift: worldBible?.prohibited_visual_drift,
    },
  });

  const resp = await callWithRole('CRITIC', {
    systemPrompt: SYSTEM,
    userPrompt,
    jsonMode: true,
    temperature: 0.25,
    maxTokens: 6000,
    label: 'v2.manuscriptCritic',
  });

  const report = resp.json;
  if (!report || typeof report !== 'object') throw new Error('manuscriptCritic: empty/invalid JSON');

  // Normalize.
  report.scores = report.scores || {};
  report.per_spread = Array.isArray(report.per_spread) ? report.per_spread : [];
  report.targeted_revisions = Array.isArray(report.targeted_revisions) ? report.targeted_revisions : [];
  report.abandoned_threads = Array.isArray(report.abandoned_threads) ? report.abandoned_threads : [];
  report.whole_book_repetition = Array.isArray(report.whole_book_repetition) ? report.whole_book_repetition : [];
  report.meaning_sanity_book_wide = report.meaning_sanity_book_wide || { passed: true, violations: [] };
  report.bible_consistency_book_wide = report.bible_consistency_book_wide || { passed: true, violations: [] };
  report.prohibited_respected_book_wide = report.prohibited_respected_book_wide || { passed: true, violations: [] };
  report.accept_recommendation = typeof report.accept_recommendation === 'boolean'
    ? report.accept_recommendation
    : Boolean(report.accept);

  report.version = '1.0';
  report.generated_at = new Date().toISOString();
  report.model = resp.model;

  ctx.log(
    'info',
    `[v2] manuscriptCritic accept=${report.accept_recommendation} targeted=${report.targeted_revisions.length} hard_meaning=${report.meaning_sanity_book_wide.passed} hard_bible=${report.bible_consistency_book_wide.passed} hard_prohibited=${report.prohibited_respected_book_wide.passed}`,
  );
  return report;
}

module.exports = { manuscriptCriticActivity };
