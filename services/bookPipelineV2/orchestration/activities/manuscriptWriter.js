/**
 * Stage 8 — Manuscript Writer (one-shot, all spreads)
 *
 * Writes the entire picture-book manuscript in ONE LLM call. The writer
 * sees: AgeProfile, StoryIntent, all CharacterBibles, WorldBible, and
 * the full BeatSheet. It returns one entry per spread.
 *
 * Replaces the per-spread `pageWriter` activity. Continuity, arc,
 * callbacks and book-wide non-repetition are now the writer's
 * responsibility (because it sees the whole book) instead of being
 * patched in via rolling summaries and per-spread loops.
 *
 * Output:
 *   { spreads: [ { spread: number, lines: string[], text: string,
 *                  version, generated_at, model } ] }
 */

const fs = require('fs');
const path = require('path');
const { callWithRole } = require('../../llm/modelRouter');

const SYSTEM = fs.readFileSync(
  path.join(__dirname, '../../llm/prompts/manuscriptWriter.system.md'),
  'utf8',
);

/**
 * @param {{
 *   beatSheet: object,
 *   ageProfile: object,
 *   intent: object,
 *   characterBible: object,
 *   worldBible: object,
 *   targetedRevisions?: Array<{ spread: number, failures: Array<object> }>,
 *   currentManuscript?: Array<{ spread: number, lines: string[] }>,
 *   freshAttempt?: boolean,
 * }} input
 */
async function manuscriptWriterActivity(input, ctx) {
  const {
    beatSheet, ageProfile, intent, characterBible, worldBible,
    freshAttempt = false,
  } = input;

  // Lift band constraints into a prominent narrative preamble so the model
  // cannot miss them. Burying these inside JSON has been observed to cause
  // systematic OVER-delivery (17–23 words per spread on tight bands).
  const nc = ageProfile?.narrativeConstraints || {};
  const wps = nc.wordsPerSpread || {};
  const lps = nc.linesPerSpread || {};
  const spl = nc.syllablesPerLine || {};
  const bandName = ageProfile?.ageBand || ageProfile?.band || 'unknown';
  const beatCount = (beatSheet?.spreads || []).length;

  // Words/line budget tied to band so the model sees the arithmetic explicitly.
  const wordsPerLineMax = (lps.max && wps.max) ? (wps.max / lps.max).toFixed(1) : null;

  const instructionLines = [
    freshAttempt
      ? 'Write the COMPLETE manuscript FRESH. One entry per beat in the BeatSheet.'
      : 'Write the COMPLETE manuscript. One entry per beat in the BeatSheet.',
    `Age band: ${bandName}. Total spreads to write: ${beatCount}.`,
    '',
    'BAND CONSTRAINTS — APPLY TO EVERY SPREAD:',
    `- Words per spread: between ${wps.min} and ${wps.max} (target ~${wps.target}). Going OVER ${wps.max} is JUST AS WRONG as going UNDER ${wps.min}.`,
    wordsPerLineMax ? `- That means with ${lps.max} lines you have at most ~${wordsPerLineMax} words per line on average. Write SHORT lines.` : null,
    `- Lines per spread: between ${lps.min} and ${lps.max} (target ${lps.target}).`,
    `- Syllables per line: between ${spl.min} and ${spl.max} (target ${spl.target}).`,
    nc.rhymeScheme ? `- Rhyme scheme: ${nc.rhymeScheme} (strictness: ${nc.rhymeStrictness || 'default'}).` : null,
    nc.dialogueDensity ? `- Dialogue density: ${nc.dialogueDensity}.` : null,
    '',
    'SELF-CHECK BEFORE EMITTING EACH SPREAD:',
    `1. Count the words in the spread. If count > ${wps.max}, delete adjectives or compress phrases until count ≤ ${wps.max}. Do NOT emit a spread that is over the cap.`,
    `2. Count the words. If count < ${wps.min}, expand naturally until count ≥ ${wps.min}.`,
    '3. Read every verb. If any verb is in past tense, rewrite it (see TENSE rule below) before emitting.',
    '',
    'TENSE — PRESENT ONLY. Every verb must be either:',
    '  (a) third-person singular present in -s/-es: "she hums", "he runs", "the leaf sways", or',
    '  (b) base/infinitive form: "to be", "to rest", or',
    '  (c) present participle in -ing: "humming", "resting".',
    'NO past-tense verbs of any kind. No -ed endings on verbs (regular past). No irregular past forms (ran, sang, saw, told, came, made, took, gave, knew, slept, woke, stood, sat, held, heard, blew, drew, spoke, broke, went, was, were).',
    'Past tense in any line is a HARD failure (past_tense_regular / past_tense_irregular).',
    '',
    'Honor every beat literally. Apply every rule per-spread AND across the whole book.',
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
      ending_feeling: intent?.ending_feeling,
      climax_payoff_image: intent?.climax_payoff_image,
    },
    characterBible,
    worldBible: {
      style_rules: worldBible?.style_rules,
      cover_anchor_rules: worldBible?.cover_anchor_rules,
      prohibited_visual_drift: worldBible?.prohibited_visual_drift,
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
  });

  const resp = await callWithRole('WRITER', {
    systemPrompt: SYSTEM,
    userPrompt,
    jsonMode: true,
    temperature: 0.7,
    // Enough room for 13 spreads × ~6 lines × ~14 words plus structure.
    // Real cost is far smaller; this is the headroom ceiling.
    maxTokens: 6000,
    label: freshAttempt ? 'v2.manuscriptWriter.fresh' : 'v2.manuscriptWriter',
  });

  const out = resp.json;
  if (!out || typeof out !== 'object' || !Array.isArray(out.spreads)) {
    throw new Error('manuscriptWriter: empty/invalid JSON (expected { spreads: [...] })');
  }

  // Normalize each spread.
  const normalized = out.spreads.map((s) => {
    const lines = Array.isArray(s.lines) ? s.lines.map(String) : [];
    return {
      spread: typeof s.spread === 'number' ? s.spread : null,
      lines,
      text: lines.join('\n'),
      version: '1.0',
      generated_at: new Date().toISOString(),
      model: resp.model,
    };
  }).filter((s) => s.spread !== null);

  // Order by spread number (writer is asked for ordered output but be
  // defensive — JSON ordering is not guaranteed by some clients).
  normalized.sort((a, b) => a.spread - b.spread);

  ctx.log('info', `[v2] manuscriptWriter spreads=${normalized.length}${freshAttempt ? ' (fresh)' : ''}`);
  // Debug log: dump every spread's lines so we can diagnose under-delivery
  // (e.g. line_length_window failures across all spreads). Each line is
  // truncated to keep log volume sane. Remove once writer behaviour stabilises.
  for (const s of normalized) {
    const lines = s.lines.map((l, i) => `L${i + 1}:"${String(l).slice(0, 80)}"`).join(' ');
    ctx.log('info', `[v2] manuscriptWriter.dump spread=${s.spread} lineCount=${s.lines.length} ${lines}`);
  }
  return { spreads: normalized, model: resp.model };
}

module.exports = { manuscriptWriterActivity };
