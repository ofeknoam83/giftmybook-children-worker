/**
 * Stage 12 — Book-Wide Critic (cross-family)
 *
 * Final pass over the full accepted manuscript. Grades arc coherence,
 * callback payoff, theme delivery, abandoned threads, repetition,
 * ending landing, and the read-as-a-book-not-episodes feel. Produces
 * `targeted_revisions[]` listing exactly which spreads need another
 * pass. Routed to CRITIC family (≠ WRITER).
 *
 * For tonight, the targeted_revisions are logged but not auto-looped —
 * the per-spread loop already exhausts up to 3 revision rounds. Phase
 * 2.5 wires the book-wide loop.
 */

const fs = require('fs');
const path = require('path');
const { callWithRole } = require('../../llm/modelRouter');

const SYSTEM = fs.readFileSync(
  path.join(__dirname, '../../llm/prompts/bookWideCritic.system.md'),
  'utf8',
);

async function bookWideCriticActivity(input, ctx) {
  const { intent, beatSheet, drafts, characterBible, worldBible } = input;
  const userPrompt = JSON.stringify({
    instructions: 'Grade the full manuscript. Return BookWideCriticReport JSON.',
    intent,
    beatSheet,
    manuscript: drafts.map((d) => ({ spread: d.spread, lines: d.lines })),
    characterBible,
    worldBible,
  });

  const resp = await callWithRole('CRITIC', {
    systemPrompt: SYSTEM,
    userPrompt,
    jsonMode: true,
    temperature: 0.25,
    maxTokens: 4500,
    label: 'v2.bookWideCritic',
  }, { mustDifferFrom: 'WRITER' });

  const report = resp.json;
  if (!report || typeof report !== 'object') throw new Error('bookWideCritic: empty/invalid JSON');
  report.scores = report.scores || {};
  report.targeted_revisions = Array.isArray(report.targeted_revisions) ? report.targeted_revisions : [];
  report.accept_recommendation = typeof report.accept_recommendation === 'boolean'
    ? report.accept_recommendation
    : Boolean(report.accept);
  report.version = '1.0';
  report.generated_at = new Date().toISOString();
  report.model = resp.model;
  ctx.log('info', `[v2] bookWideCritic accept=${report.accept_recommendation} targeted_revisions=${report.targeted_revisions.length}`);
  return report;
}

module.exports = { bookWideCriticActivity };
