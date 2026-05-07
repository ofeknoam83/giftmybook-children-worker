/**
 * Stage 11 — Manuscript Revision (one call, only flagged spreads)
 *
 * Given the full current manuscript and a list of `targeted_revisions`
 * (each: { spread, failures: [...] }), rewrites ONLY the flagged
 * spreads and returns them. Unflagged spreads are not returned and
 * are merged back by the caller.
 *
 * Single LLM call, regardless of how many spreads are flagged. The
 * revisor sees the whole manuscript so it doesn't reintroduce
 * book-wide repetition, broken arc, or callback misses.
 */

const fs = require('fs');
const path = require('path');
const { callWithRole } = require('../../llm/modelRouter');

const SYSTEM = fs.readFileSync(
  path.join(__dirname, '../../llm/prompts/manuscriptRevision.system.md'),
  'utf8',
);

/**
 * @param {{
 *   currentManuscript: Array<{ spread: number, lines: string[] }>,
 *   beatSheet: object,
 *   ageProfile: object,
 *   intent: object,
 *   characterBible: object,
 *   worldBible: object,
 *   targetedRevisions: Array<{ spread: number, failures: Array<object>, reasons?: string[] }>,
 *   mode?: 'gate' | 'critic' | 'mixed',
 * }} input
 */
async function manuscriptRevisionActivity(input, ctx) {
  const {
    currentManuscript, beatSheet, ageProfile, intent, characterBible, worldBible,
    targetedRevisions = [], mode = 'mixed',
  } = input;

  if (!Array.isArray(targetedRevisions) || targetedRevisions.length === 0) {
    // Nothing to revise — return empty patch. Caller treats this as a no-op.
    ctx.log('warn', '[v2] manuscriptRevision called with no targetedRevisions; returning empty patch');
    return { spreads: [], model: null };
  }

  const flaggedSet = new Set(targetedRevisions.map((t) => t.spread));
  const flaggedBeats = (beatSheet?.spreads || []).filter((b) => flaggedSet.has(b.spread));

  const userPrompt = JSON.stringify({
    instructions: `Revise ONLY the spreads listed in targeted_revisions. Fix the listed failures exactly. Do not introduce new defects. Do not return spreads that are not flagged. Mode: ${mode}.`,
    ageProfile: {
      band: ageProfile?.ageBand || ageProfile?.band,
      linesPerSpread: ageProfile?.narrativeConstraints?.linesPerSpread,
      wordsPerSpread: ageProfile?.narrativeConstraints?.wordsPerSpread,
      syllablesPerLine: ageProfile?.narrativeConstraints?.syllablesPerLine,
      rhymeScheme: ageProfile?.narrativeConstraints?.rhymeScheme,
      rhymeStrictness: ageProfile?.narrativeConstraints?.rhymeStrictness,
      dialogueDensity: ageProfile?.narrativeConstraints?.dialogueDensity,
      vocabularyConstraints: ageProfile?.vocabularyConstraints,
    },
    intent: {
      logline: intent?.logline,
      arc: intent?.arc,
      theme_delivered_via: intent?.theme_delivered_via,
      callback_motifs: intent?.callback_motifs,
      banned_elements: intent?.banned_elements,
    },
    characterBible,
    worldBible: {
      style_rules: worldBible?.style_rules,
      prohibited_visual_drift: worldBible?.prohibited_visual_drift,
    },
    flaggedBeats: flaggedBeats.map((b) => ({
      spread: b.spread,
      purpose: b.purpose,
      target_emotion: b.target_emotion,
      page_turn_hook: b.page_turn_hook,
      success_criteria: b.success_criteria,
      prohibited: b.prohibited,
      callbacks_introduced: b.callbacks_introduced,
      callbacks_used: b.callbacks_used,
    })),
    currentManuscript: currentManuscript.map((d) => ({ spread: d.spread, lines: d.lines })),
    targeted_revisions: targetedRevisions,
  });

  const resp = await callWithRole('WRITER', {
    systemPrompt: SYSTEM,
    userPrompt,
    jsonMode: true,
    temperature: 0.5,
    maxTokens: 4000,
    label: `v2.manuscriptRevision.${mode}`,
  });

  const out = resp.json;
  if (!out || typeof out !== 'object' || !Array.isArray(out.spreads)) {
    throw new Error('manuscriptRevision: empty/invalid JSON (expected { spreads: [...] })');
  }

  // Normalize each returned spread; only keep those that were actually flagged.
  const normalized = out.spreads
    .map((s) => {
      const lines = Array.isArray(s.lines) ? s.lines.map(String) : [];
      return {
        spread: typeof s.spread === 'number' ? s.spread : null,
        lines,
        text: lines.join('\n'),
        version: '1.0',
        generated_at: new Date().toISOString(),
        model: resp.model,
      };
    })
    .filter((s) => s.spread !== null && flaggedSet.has(s.spread));

  ctx.log(
    'info',
    `[v2] manuscriptRevision flagged=${targetedRevisions.length} returned=${normalized.length} mode=${mode}`,
  );
  return { spreads: normalized, model: resp.model };
}

module.exports = { manuscriptRevisionActivity };
