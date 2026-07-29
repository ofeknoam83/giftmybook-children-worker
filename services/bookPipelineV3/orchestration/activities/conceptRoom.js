/**
 * W1 — Concept Room.
 *
 * Three INDEPENDENT concept pitches, one per fixed creative angle
 * (llm/conceptAngles.json). Each call is blind to the others; diversity
 * comes from the angle directives, not from sampling temperature (the
 * anthropic family rejects temperature — see anthropicClient.js).
 *
 * The activity generates ONE concept for the angle it is given; the
 * workflow fans out three executions so each concept is its own artifact
 * (replayable individually).
 */

const fs = require('fs');
const path = require('path');
const { callWithRole } = require('../../llm/modelRouter');
const { normalizeConcept, FORM_CHOICES } = require('../../schema/document');

const SYSTEM = fs.readFileSync(
  path.join(__dirname, '../../llm/prompts/conceptRoom.system.md'),
  'utf8',
);

const { angles: CONCEPT_ANGLES } = require('../../llm/conceptAngles.json');

/**
 * @param {{ brief: object, ageProfile: object, theme: string, spreadCount: number, angle: { id, label, directive } }} input
 */
async function conceptRoomActivity(input, ctx) {
  const { brief, ageProfile, theme, spreadCount, angle, coverImagery } = input;
  if (!angle?.id) throw new Error('conceptRoom: angle required');

  // Band form restriction (2026-07-29 QA review): sparse_lyric is not
  // available for INFANT/TODDLER — the Liv book's fragment/mood failure
  // style is that form's signature, and a lap baby needs "this happened,
  // so then this happened".
  const allowedForms = Array.isArray(ageProfile?.narrativeConstraints?.allowedForms)
    && ageProfile.narrativeConstraints.allowedForms.length
    ? ageProfile.narrativeConstraints.allowedForms.filter((f) => FORM_CHOICES.includes(f))
    : FORM_CHOICES;

  const userPrompt = JSON.stringify({
    // P4: imagery the parent-approved cover promises — every concept must
    // honor it (or at least never contradict it).
    approvedCoverShows: coverImagery
      ? {
        ...coverImagery,
        note: 'The book cover the parent approved depicts these props, this setting, and this mood. Your concept must feature this imagery or weave it in naturally — never pitch a story the cover visibly does not belong to.',
      }
      : null,
    assigned_angle: angle,
    brief: {
      child_as_character: brief?.child_as_character,
      gift_intent: brief?.gift_intent,
      constraints: brief?.constraints,
      child: brief?.child,
      interests: brief?.interests || [],
      story_world: brief?.story_world || null,
      themes: brief?.themes || null,
      storyRoles: brief?.storyRoles || null,
    },
    theme,
    spreadCount,
    allowed_forms: allowedForms,
    ageProfile: {
      band: ageProfile?.ageBand || ageProfile?.band,
      narrativeConstraints: ageProfile?.narrativeConstraints,
      vocabularyConstraints: ageProfile?.vocabularyConstraints,
    },
  });

  const resp = await callWithRole('CONCEPT', {
    systemPrompt: SYSTEM,
    userPrompt,
    jsonMode: true,
    maxTokens: 2500,
    label: `v3.concept.${angle.id}`,
  });

  const concept = normalizeConcept(resp.json, { angleId: angle.id });
  // Deterministic backstop (cheap here — nothing has been written yet): a
  // concept that picked a band-disallowed form is coerced to rhythmic
  // prose, loudly.
  if (!allowedForms.includes(concept.form_choice)) {
    ctx.log('warn', `[v3] concept '${angle.id}' chose form '${concept.form_choice}' — not allowed for this band (${allowedForms.join('|')}); coercing to rhythmic_prose`);
    concept.form_choice = 'rhythmic_prose';
  }
  concept._usage = resp.usage;
  concept._model = resp.model;
  ctx.log('info', `[v3] concept '${angle.id}': form=${concept.form_choice} logline='${concept.logline.slice(0, 90)}'`);
  return concept;
}

module.exports = { conceptRoomActivity, CONCEPT_ANGLES };
