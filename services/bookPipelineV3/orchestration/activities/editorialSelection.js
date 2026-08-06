/**
 * W2 — Editorial Selection.
 *
 * A cross-family editor (deepseek by default — deliberately NOT the writer
 * family, which is openai) scores the three concepts against gift_intent +
 * the rubric, picks a winner, grafts the best elements from the losers, and
 * names the runner-up (retained as the exhaustion-ladder fallback).
 */

const fs = require('fs');
const path = require('path');
const { callWithRole } = require('../../llm/modelRouter');

const SYSTEM = fs.readFileSync(
  path.join(__dirname, '../../llm/prompts/editorialSelection.system.md'),
  'utf8',
);

/**
 * @param {{ brief: object, ageProfile: object, concepts: object[] }} input
 */
async function editorialSelectionActivity(input, ctx) {
  const { brief, ageProfile, concepts } = input;
  if (!Array.isArray(concepts) || concepts.length < 2) {
    throw new Error(`editorialSelection: need >=2 concepts, got ${concepts?.length || 0}`);
  }

  const userPrompt = JSON.stringify({
    brief: {
      gift_intent: brief?.gift_intent,
      child_as_character: brief?.child_as_character,
      constraints: brief?.constraints,
      // The editor's rubric weighs personalization depth and disqualifies
      // pitches that ignore the fixed casting — it needs the same code-attached
      // personalization fields every other writing stage receives (these were
      // omitted when the fields were introduced, leaving the editor to judge
      // personalization blind).
      interests: brief?.interests,
      themes: brief?.themes,
      storyRoles: brief?.storyRoles,
      storyFormat: brief?.storyFormat,
    },
    ageProfile: {
      band: ageProfile?.ageBand || ageProfile?.band,
      narrativeConstraints: ageProfile?.narrativeConstraints,
    },
    concepts,
  });

  const resp = await callWithRole('EDITOR', {
    systemPrompt: SYSTEM,
    userPrompt,
    jsonMode: true,
    temperature: 0.3,
    maxTokens: 1500,
    label: 'v3.editor',
  });

  const out = resp.json;
  const ids = new Set(concepts.map((c) => c.id));
  if (!out || !ids.has(out.winner_id)) {
    throw new Error(`editorialSelection: winner_id '${out?.winner_id}' not among concepts [${Array.from(ids).join(', ')}]`);
  }
  const runnerUpId = ids.has(out.runner_up_id) && out.runner_up_id !== out.winner_id
    ? out.runner_up_id
    : concepts.find((c) => c.id !== out.winner_id).id;

  const selection = {
    winner_id: out.winner_id,
    runner_up_id: runnerUpId,
    rationale: String(out.rationale || ''),
    grafts: Array.isArray(out.grafts)
      ? out.grafts.map((g) => ({
        from_concept: String(g.from_concept || ''),
        element: String(g.element || ''),
        why: String(g.why || ''),
      }))
      : [],
    scores: out.scores || {},
    _usage: resp.usage,
    _model: resp.model,
  };

  ctx.log('info', `[v3] editorialSelection: winner=${selection.winner_id} runnerUp=${selection.runner_up_id} grafts=${selection.grafts.length}`);
  return selection;
}

module.exports = { editorialSelectionActivity };
