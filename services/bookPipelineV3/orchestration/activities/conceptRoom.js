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
const { normalizeConcept } = require('../../schema/document');

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
    },
    theme,
    spreadCount,
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
  concept._usage = resp.usage;
  concept._model = resp.model;
  ctx.log('info', `[v3] concept '${angle.id}': form=${concept.form_choice} logline='${concept.logline.slice(0, 90)}'`);
  return concept;
}

module.exports = { conceptRoomActivity, CONCEPT_ANGLES };
