/**
 * Stage 8 — Page Writer
 *
 * Writes ONE spread at a time. Per design doc principle 8 (iterate
 * small) and principle 4 (determinism beats persuasion): the writer's
 * context is bounded to ageProfile + intent + bibles + the current beat
 * + the rolling summaries of the previous two spreads. We never feed
 * the whole manuscript back to the writer — that's how v1 collapsed
 * into self-repetition.
 *
 * Output is a SpreadDraft.
 */

const fs = require('fs');
const path = require('path');
const { callWithRole } = require('../../llm/modelRouter');

const SYSTEM = fs.readFileSync(
  path.join(__dirname, '../../llm/prompts/pageWriter.system.md'),
  'utf8',
);

/**
 * @param {{
 *   beat: object,
 *   ageProfile: object,
 *   intent: object,
 *   characterBible: object,
 *   worldBible: object,
 *   recentSummaries: Array<object>,
 *   previousFailures?: Array<object>,
 *   revisionMode?: 'deterministic' | 'critic' | null,
 * }} input
 */
async function pageWriterActivity(input, ctx) {
  const {
    beat, ageProfile, intent, characterBible, worldBible,
    recentSummaries = [], previousFailures = null, revisionMode = null,
  } = input;

  const userPrompt = JSON.stringify({
    instructions: revisionMode
      ? `Revise this spread to fix the listed failures. Fix exactly what is listed. Do not introduce new defects.`
      : `Write spread ${beat?.spread}. Honor every success_criteria. Avoid every prohibited item. Match the band exactly.`,
    revisionMode,
    beat,
    ageProfile: {
      band: ageProfile?.ageBand || ageProfile?.band,
      linesPerSpread: ageProfile?.narrativeConstraints?.linesPerSpread,
      wordsPerSpread: ageProfile?.narrativeConstraints?.wordsPerSpread,
      syllablesPerLine: ageProfile?.narrativeConstraints?.syllablesPerLine,
      rhymeScheme: ageProfile?.narrativeConstraints?.rhymeScheme,
      rhymeStrictness: ageProfile?.narrativeConstraints?.rhymeStrictness,
      vocabularyConstraints: ageProfile?.vocabularyConstraints,
    },
    intent: {
      logline: intent?.logline,
      theme_delivered_via: intent?.theme_delivered_via,
      callback_motifs: intent?.callback_motifs,
      banned_elements: intent?.banned_elements,
    },
    characterBible,
    worldBible: {
      style_rules: worldBible?.style_rules,
      cover_anchor_rules: worldBible?.cover_anchor_rules,
      prohibited_visual_drift: worldBible?.prohibited_visual_drift,
    },
    recentSummaries,
    previousFailures: previousFailures || undefined,
  });

  const resp = await callWithRole('WRITER', {
    systemPrompt: SYSTEM,
    userPrompt,
    jsonMode: true,
    temperature: revisionMode === 'deterministic' ? 0.35 : 0.7,
    maxTokens: 1800,
    label: revisionMode ? `v2.writer.revise.${revisionMode}` : 'v2.writer',
  });
  const draft = resp.json;
  if (!draft || typeof draft !== 'object') throw new Error('pageWriter: empty/invalid JSON');

  // Normalize the draft shape so downstream gate + critic always see
  // the same fields.
  draft.spread = beat?.spread;
  draft.lines = Array.isArray(draft.lines) ? draft.lines.map(String) : [];
  if (!draft.text && draft.lines.length) draft.text = draft.lines.join('\n');
  if (!draft.lines.length && typeof draft.text === 'string') {
    draft.lines = draft.text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  }
  draft.version = '1.0';
  draft.generated_at = new Date().toISOString();
  draft.model = resp.model;
  ctx.log('info', `[v2] pageWriter spread=${draft.spread} lines=${draft.lines.length}${revisionMode ? ' (revision:' + revisionMode + ')' : ''}`);
  return draft;
}

module.exports = { pageWriterActivity };
