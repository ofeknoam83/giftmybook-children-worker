/**
 * Stage 10 — Spread Critic (cross-family)
 *
 * Grades a single accepted-by-gate draft against its beat. The CRITIC
 * role is enforced to be a different family from the WRITER role —
 * v2's locked principle and the single most important reason this
 * service exists.
 *
 * Output is a CriticReport.
 */

const fs = require('fs');
const path = require('path');
const { callWithRole } = require('../../llm/modelRouter');

const SYSTEM = fs.readFileSync(
  path.join(__dirname, '../../llm/prompts/spreadCritic.system.md'),
  'utf8',
);

async function spreadCriticActivity(input, ctx) {
  const { draft, beat, ageProfile, intent, characterBible, previousSummary } = input;
  const userPrompt = JSON.stringify({
    instructions: 'Grade this spread against the beat. Return CriticReport JSON.',
    draft,
    beat,
    ageProfileSummary: {
      band: ageProfile?.ageBand || ageProfile?.band,
      linesPerSpread: ageProfile?.narrativeConstraints?.linesPerSpread,
      wordsPerSpread: ageProfile?.narrativeConstraints?.wordsPerSpread,
      syllablesPerLine: ageProfile?.narrativeConstraints?.syllablesPerLine,
    },
    intent: {
      logline: intent?.logline,
      banned_elements: intent?.banned_elements,
      callback_motifs: intent?.callback_motifs,
    },
    characterBible,
    previousSummary: previousSummary || null,
  });

  // Cross-family enforcement happens here. If env overrides set CRITIC
  // to the same family as WRITER, this throws BEFORE any LLM call.
  const resp = await callWithRole('CRITIC', {
    systemPrompt: SYSTEM,
    userPrompt,
    jsonMode: true,
    temperature: 0.2,
    maxTokens: 2500,
    label: 'v2.spreadCritic',
  }, { mustDifferFrom: 'WRITER' });

  const report = resp.json;
  if (!report || typeof report !== 'object') throw new Error('spreadCritic: empty/invalid JSON');

  // Normalize.
  report.spread = draft?.spread;
  report.scores = report.scores || {};
  report.meaning_sanity = report.meaning_sanity || { passed: true, violations: [] };
  report.prohibited_respected = report.prohibited_respected || { passed: true, violations: [] };
  report.callback_fidelity = report.callback_fidelity || { passed: true, notes: [] };
  report.bible_consistency = report.bible_consistency || { passed: true, notes: [] };
  report.suggested_fixes = Array.isArray(report.suggested_fixes) ? report.suggested_fixes : [];
  report.accept_recommendation = typeof report.accept_recommendation === 'boolean'
    ? report.accept_recommendation
    : Boolean(report.accept);

  report.version = '1.0';
  report.generated_at = new Date().toISOString();
  report.model = resp.model;
  ctx.log('info', `[v2] spreadCritic spread=${report.spread} accept=${report.accept_recommendation} fixes=${report.suggested_fixes.length}`);
  return report;
}

module.exports = { spreadCriticActivity };
