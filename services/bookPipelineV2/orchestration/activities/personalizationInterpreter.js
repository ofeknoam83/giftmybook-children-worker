/**
 * Stage 1 — Personalization Interpreter
 *
 * Converts the questionnaire + parent goal into structural directives.
 * Output: PersonalizationBrief.json (see design doc §3.1).
 */

const fs = require('fs');
const path = require('path');
const { callWithRole } = require('../../llm/modelRouter');

const SYSTEM = fs.readFileSync(
  path.join(__dirname, '../../llm/prompts/personalizationInterpreter.system.md'),
  'utf8',
);

async function personalizationInterpreterActivity(input, ctx) {
  const { rawRequest, ageProfile } = input;

  const userPrompt = JSON.stringify({
    instructions: 'Produce the PersonalizationBrief JSON for this child + parent goal + age profile.',
    questionnaire: {
      child: rawRequest.child || {},
      customDetails: rawRequest.customDetails || {},
      theme: rawRequest.theme || null,
      bookFormat: rawRequest.format || null,
      parentGoal: rawRequest.parentGoal || rawRequest.parent_goal || null,
      childAnecdotes: rawRequest.childAnecdotes || rawRequest.child_anecdotes || null,
    },
    ageProfile,
  });

  ctx.log('info', `[v2] interpreter calling PLANNER for child=${rawRequest?.child?.name || 'n/a'}`);
  const resp = await callWithRole('PLANNER', {
    systemPrompt: SYSTEM,
    userPrompt,
    jsonMode: true,
    temperature: 0.4,
    maxTokens: 4500,
    label: 'v2.interpreter',
  });

  const brief = resp.json;
  if (!brief || typeof brief !== 'object') {
    throw new Error('personalizationInterpreter: empty/invalid JSON from model');
  }
  // Force version stamp.
  brief.version = brief.version || '1.0';
  brief.generated_at = new Date().toISOString();
  brief.model = resp.model;
  return brief;
}

module.exports = { personalizationInterpreterActivity };
