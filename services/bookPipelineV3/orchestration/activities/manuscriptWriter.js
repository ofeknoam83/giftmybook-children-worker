/**
 * W3 — Manuscript Writer.
 *
 * Writes ONE complete manuscript (all spreads, one call) from the winning
 * concept. The workflow invokes this activity twice in parallel with
 * different DRAFT VARIANT directives — best-of-2 diversity comes from the
 * prompt variants because they work across every model family. (Do not
 * replace them with a temperature spread: the anthropic family, available
 * per-role via BOOK_PIPELINE_V3_*_FAMILY, rejects sampling-temperature
 * overrides — claude-opus-4-8 400s on `temperature`.)
 *
 * Also used for the exhaustion-ladder 'fresh' manuscript (from the
 * runner-up concept) and for gate mechanical fixes via `mechanicalNotes`.
 */

const fs = require('fs');
const path = require('path');
const { callWithRole } = require('../../llm/modelRouter');
const { normalizeManuscript } = require('../../schema/document');
const { narrativeTenseFor } = require('../../ageProfiles');

const SYSTEM = fs.readFileSync(
  path.join(__dirname, '../../llm/prompts/manuscriptWriter.system.md'),
  'utf8',
);

const DRAFT_VARIANTS = {
  A: 'DRAFT VARIANT A — lean into MUSICALITY: the refrain, the read-aloud rhythm, lines that beg to be performed. Sound is your first tool.',
  B: 'DRAFT VARIANT B — lean into VISUAL STORYTELLING: page-turn surprise, scenes an illustrator will fight to paint, the picture carrying half the meaning. The eye is your first tool.',
  fresh: 'FRESH ATTEMPT — a previous manuscript from a different concept failed the quality panel. Write this book completely fresh from THIS concept; do not imitate any earlier draft.',
};

function buildBudgetPreamble(ageProfile, spreadCount) {
  const nc = ageProfile?.narrativeConstraints || {};
  const wps = nc.wordsPerSpread || {};
  const lps = nc.linesPerSpread || {};
  const bandName = ageProfile?.ageBand || ageProfile?.band || 'unknown';
  return [
    `Age band: ${bandName}. Total spreads: ${spreadCount}.`,
    `WORD BUDGET (typesetting limit, machine-checked): between ${wps.min} and ${wps.max} words per spread (target ~${wps.target}). Over is as wrong as under.`,
    `Lines per spread: between ${lps.min} and ${lps.max} (target ${lps.target}).`,
    // 2026-08-02 customer feedback: past tense is the narrative standard
    // (classic storybook voice); the lap-baby bands stay present tense.
    narrativeTenseFor(ageProfile) === 'present'
      ? 'TENSE: present tense ONLY — every verb (machine-checked).'
      : 'TENSE: PAST TENSE narration — the story already happened ("Maya raced", never "Maya races"). Every narration verb is past tense; only dialogue inside quotation marks stays in its natural spoken tense.',
    nc.dialogueDensity ? `Dialogue density for this band: ${nc.dialogueDensity}.` : null,
  ].filter(Boolean).join('\n');
}

/**
 * @param {{
 *   brief: object, ageProfile: object, concept: object, selection?: object,
 *   spreadCount: number, variant: 'A'|'B'|'fresh',
 *   mechanicalNotes?: Array<{spread:number, reasons:string[]}>,
 * }} input
 */
async function manuscriptWriterActivity(input, ctx) {
  const { brief, ageProfile, concept, selection, spreadCount, variant = 'A', mechanicalNotes } = input;
  if (!concept?.id) throw new Error('manuscriptWriter: concept required');

  const userPrompt = JSON.stringify({
    draft_variant: DRAFT_VARIANTS[variant] || DRAFT_VARIANTS.A,
    budget_preamble: buildBudgetPreamble(ageProfile, spreadCount),
    brief: {
      child_as_character: brief?.child_as_character,
      gift_intent: brief?.gift_intent,
      constraints: brief?.constraints,
      child: brief?.child,
      interests: brief?.interests || [],
      story_world: brief?.story_world || null,
      themes: brief?.themes || null,
      storyRoles: brief?.storyRoles || null,
      storyFormat: brief?.storyFormat || null,
    },
    concept,
    editor_grafts: selection?.grafts || [],
    spreadCount,
    ageProfile: {
      band: ageProfile?.ageBand || ageProfile?.band,
      narrativeConstraints: ageProfile?.narrativeConstraints,
      vocabularyConstraints: ageProfile?.vocabularyConstraints,
    },
    ...(Array.isArray(mechanicalNotes) && mechanicalNotes.length
      ? {
        mechanical_fixes_required:
          'The following spreads broke machine-checked rules. Rewrite the book honoring every rule; the listed spreads MUST be fixed: '
          + JSON.stringify(mechanicalNotes),
      }
      : {}),
  });

  const resp = await callWithRole('WRITER', {
    systemPrompt: SYSTEM,
    userPrompt,
    jsonMode: true,
    maxTokens: 8000,
    label: `v3.manuscript.${variant}`,
  });

  const manuscript = normalizeManuscript(resp.json, {
    id: variant,
    expectedSpreads: spreadCount,
    model: resp.model,
  });
  // Band form restriction (2026-07-29 QA review): a manuscript written in
  // a band-disallowed form (sparse_lyric for INFANT/TODDLER) cannot be
  // silently relabeled — the text IS the form. Throw so the activity retry
  // regenerates it (the concept stage already coerced form_choice, so this
  // only fires when the writer drifted on its own).
  const allowedForms = ageProfile?.narrativeConstraints?.allowedForms;
  if (Array.isArray(allowedForms) && allowedForms.length && !allowedForms.includes(manuscript.form)) {
    throw new Error(`manuscriptWriter: form '${manuscript.form}' is not allowed for band ${ageProfile?.ageBand || ageProfile?.band} (allowed: ${allowedForms.join('|')})`);
  }
  manuscript.concept_id = concept.id;
  manuscript._usage = resp.usage;

  ctx.log('info', `[v3] manuscript ${variant}: form=${manuscript.form} title='${manuscript.title.slice(0, 60)}' spreads=${manuscript.spreads.length}`);
  return manuscript;
}

module.exports = { manuscriptWriterActivity, DRAFT_VARIANTS, buildBudgetPreamble };
