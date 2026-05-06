/**
 * Stage 3 — Story Intent
 *
 * Translates personalization + age into the structural story plan
 * (theme as shape, emotional arc, climax mechanic, callback motifs,
 * banned elements). See design doc §3.3.
 */

const fs = require('fs');
const path = require('path');
const { callWithRole } = require('../../llm/modelRouter');

const SYSTEM = fs.readFileSync(
  path.join(__dirname, '../../llm/prompts/storyIntent.system.md'),
  'utf8',
);

async function storyIntentActivity(input, ctx) {
  const { brief, ageProfile } = input;
  const userPrompt = JSON.stringify({
    instructions: 'Produce the StoryIntent JSON for this child + brief + age profile.',
    brief,
    ageProfile,
  });
  ctx.log('info', `[v2] storyIntent calling PLANNER`);
  const resp = await callWithRole('PLANNER', {
    systemPrompt: SYSTEM,
    userPrompt,
    jsonMode: true,
    temperature: 0.5,
    maxTokens: 4500,
    label: 'v2.intent',
  });
  const intent = resp.json;
  if (!intent || typeof intent !== 'object') {
    throw new Error('storyIntent: empty/invalid JSON from model');
  }
  intent.version = intent.version || '1.0';
  intent.generated_at = new Date().toISOString();
  intent.model = resp.model;
  return intent;
}

module.exports = { storyIntentActivity };
