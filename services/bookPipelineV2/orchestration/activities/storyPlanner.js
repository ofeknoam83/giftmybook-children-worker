/**
 * Stage 4 — Story Planner (the narrative skeleton)
 *
 * Bridges the abstract `StoryIntent` to the concrete `BeatSheet` by
 * producing a single `StoryBible` that names the three-act shape, the
 * midpoint, the climax payoff, and the ending image. The beat-sheet
 * activity will consume this.
 *
 * For tonight, this is a focused PLANNER call with a compact prompt
 * (no separate prompt file — the contract is small enough).
 */

const { callWithRole } = require('../../llm/modelRouter');

const SYSTEM = `You are a children's-book story planner. Given a StoryIntent and an AgeProfile, produce a StoryBible JSON: { logline, three_act_shape: { act_1, act_2, act_3 }, midpoint, climax_payoff_image, ending_image, theme_motif_table: [ { motif_id, role_in_arc } ], protagonist_voice_notes }. Be concrete. Make sure climax_payoff_image and ending_image are physical images a director could brief, not abstract concepts. Output STRICT JSON only.`;

async function storyPlannerActivity(input, ctx) {
  const { intent, ageProfile } = input;
  const resp = await callWithRole('PLANNER', {
    systemPrompt: SYSTEM,
    userPrompt: JSON.stringify({ intent, ageProfile }),
    jsonMode: true,
    temperature: 0.45,
    maxTokens: 3500,
    label: 'v2.storyPlanner',
  });
  const bible = resp.json;
  if (!bible || typeof bible !== 'object') throw new Error('storyPlanner: empty/invalid JSON');
  bible.version = '1.0';
  bible.generated_at = new Date().toISOString();
  bible.model = resp.model;
  ctx.log('info', `[v2] storyPlanner produced bible with logline: "${(bible.logline || '').slice(0, 80)}…"`);
  return bible;
}

module.exports = { storyPlannerActivity };
