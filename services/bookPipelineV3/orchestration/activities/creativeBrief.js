/**
 * W0 — Creative Brief.
 *
 * One call that replaces v2's seven-stage planning chain with a single
 * deep brief: the child as a character (real details ranked by story
 * potential), the gift intent the finished book is judged against, and
 * the constraints every later stage must respect.
 */

const fs = require('fs');
const path = require('path');
const { callWithRole } = require('../../llm/modelRouter');

const SYSTEM = fs.readFileSync(
  path.join(__dirname, '../../llm/prompts/creativeBrief.system.md'),
  'utf8',
);

function fallbackPronouns(gender) {
  const g = String(gender || '').toLowerCase();
  if (g === 'female' || g === 'girl') return { subject: 'she', object: 'her', possessive: 'her' };
  if (g === 'male' || g === 'boy') return { subject: 'he', object: 'him', possessive: 'his' };
  return { subject: 'they', object: 'them', possessive: 'their' };
}

/**
 * @param {{ rawRequest: object, ageProfile: object }} input
 */
async function creativeBriefActivity(input, ctx) {
  const { rawRequest, ageProfile } = input;
  const child = rawRequest?.child || {};

  const userPrompt = JSON.stringify({
    order: {
      childName: child.name || rawRequest?.childName,
      ageYears: child.age ?? rawRequest?.childAge ?? null,
      birthDate: child.birthDate || null,
      gender: child.gender || rawRequest?.childGender || null,
      interests: child.interests || rawRequest?.childInterests || [],
      customDetails: rawRequest?.customDetails || '',
      theme: rawRequest?.theme || 'adventure',
      heartfeltNote: rawRequest?.heartfeltNote || null,
      bookFrom: rawRequest?.bookFrom || null,
      emotional: rawRequest?.emotionalCategory
        ? {
          category: rawRequest.emotionalCategory,
          situation: rawRequest.emotionalSituation,
          parentGoal: rawRequest.emotionalParentGoal,
          copingResourceHint: rawRequest.copingResourceHint,
        }
        : null,
    },
    ageProfile: {
      band: ageProfile?.ageBand || ageProfile?.band,
      narrativeConstraints: ageProfile?.narrativeConstraints,
      vocabularyConstraints: ageProfile?.vocabularyConstraints,
    },
  });

  const resp = await callWithRole('BRIEF', {
    systemPrompt: SYSTEM,
    userPrompt,
    jsonMode: true,
    maxTokens: 2500,
    label: 'v3.brief',
  });

  const out = resp.json;
  if (!out || !Array.isArray(out.child_as_character) || !out.gift_intent) {
    throw new Error('creativeBrief: invalid JSON (expected child_as_character[] + gift_intent)');
  }

  const brief = {
    child_as_character: out.child_as_character,
    gift_intent: String(out.gift_intent),
    constraints: {
      banned_elements: Array.isArray(out.constraints?.banned_elements) ? out.constraints.banned_elements.map(String) : [],
      safety_notes: Array.isArray(out.constraints?.safety_notes) ? out.constraints.safety_notes.map(String) : [],
      pronouns: out.constraints?.pronouns?.subject
        ? out.constraints.pronouns
        : fallbackPronouns(child.gender || rawRequest?.childGender),
    },
    child: {
      name: child.name || rawRequest?.childName || 'the child',
      age: child.age ?? rawRequest?.childAge ?? null,
    },
    _usage: resp.usage,
    _model: resp.model,
  };

  const loadBearing = brief.child_as_character.filter((d) => d.load_bearing === true).length;
  ctx.log('info', `[v3] creativeBrief: ${brief.child_as_character.length} details (${loadBearing} load-bearing), gift_intent='${brief.gift_intent.slice(0, 80)}...'`);
  return brief;
}

module.exports = { creativeBriefActivity };
