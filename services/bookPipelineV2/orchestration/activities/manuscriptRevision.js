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

  // Lift band constraints into a prominent narrative preamble so the model
  // cannot miss them. Same fix as manuscriptWriter — buried JSON constraints
  // were causing OVER-delivery and past-tense leaks.
  const nc = ageProfile?.narrativeConstraints || {};
  const wps = nc.wordsPerSpread || {};
  const lps = nc.linesPerSpread || {};
  const spl = nc.syllablesPerLine || {};
  const bandName = ageProfile?.ageBand || ageProfile?.band || 'unknown';

  // Words/line budget tied to band so the model sees the arithmetic explicitly.
  const wordsPerLineMax = (lps.max && wps.max) ? (wps.max / lps.max).toFixed(1) : null;

  const instructionLines = [
    `Revise ONLY the spreads listed in targeted_revisions. Fix the listed failures exactly. Do not introduce new defects. Do not return spreads that are not flagged. Mode: ${mode}.`,
    `Age band: ${bandName}. Spreads flagged for revision: ${targetedRevisions.length}.`,
    '',
    'BAND CONSTRAINTS — EVERY REVISED SPREAD MUST SATISFY:',
    `- Words per spread: between ${wps.min} and ${wps.max} (target ~${wps.target}). Going OVER ${wps.max} is JUST AS WRONG as going UNDER ${wps.min}.`,
    wordsPerLineMax ? `- That means with ${lps.max} lines you have at most ~${wordsPerLineMax} words per line on average. Write SHORT lines.` : null,
    `- Lines per spread: between ${lps.min} and ${lps.max} (target ${lps.target}).`,
    `- Syllables per line: between ${spl.min} and ${spl.max} (target ${spl.target}).`,
    nc.rhymeScheme ? `- Rhyme scheme: ${nc.rhymeScheme} (strictness: ${nc.rhymeStrictness || 'default'}).` : null,
    nc.dialogueDensity ? `- Dialogue density: ${nc.dialogueDensity}.` : null,
    '',
    'SELF-CHECK BEFORE EMITTING EACH REVISED SPREAD:',
    `1. Count the words. If count > ${wps.max}, delete adjectives or compress phrases until count ≤ ${wps.max}.`,
    `2. Count the words. If count < ${wps.min}, expand naturally until count ≥ ${wps.min}.`,
    '3. Read every verb. If any verb is past tense, rewrite it (see TENSE rule below) before emitting.',
    '',
    'TENSE — PRESENT ONLY. Every verb must be either:',
    '  (a) third-person singular present in -s/-es: "she hums", "he runs", "the leaf sways", or',
    '  (b) base/infinitive form: "to be", "to rest", or',
    '  (c) present participle in -ing: "humming", "resting".',
    'NO past-tense verbs of any kind. No -ed endings on verbs (regular past). No irregular past forms (ran, sang, saw, told, came, made, took, gave, knew, slept, woke, stood, sat, held, heard, blew, drew, spoke, broke, went, was, were).',
    'Past tense in any line is a HARD failure (past_tense_regular / past_tense_irregular).',
    '',
    'Do NOT introduce any HARD_GATE failure that the spread did not already have.',
  ].filter(Boolean);

  const userPrompt = JSON.stringify({
    instructions: instructionLines.join('\n'),
    ageProfile: {
      band: bandName,
      linesPerSpread: nc.linesPerSpread,
      wordsPerSpread: nc.wordsPerSpread,
      syllablesPerLine: nc.syllablesPerLine,
      rhymeScheme: nc.rhymeScheme,
      rhymeStrictness: nc.rhymeStrictness,
      dialogueDensity: nc.dialogueDensity,
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
