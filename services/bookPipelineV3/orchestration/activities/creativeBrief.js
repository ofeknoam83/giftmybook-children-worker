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
  const { rawRequest, ageProfile, coverImagery } = input;
  const child = rawRequest?.child || {};

  const userPrompt = JSON.stringify({
    // P4: the parent already approved a cover — the story must honor what
    // it depicts (or at least never contradict it).
    approvedCoverShows: coverImagery
      ? {
        ...coverImagery,
        note: 'The parent approved a book cover depicting these props, this setting, and this mood BEFORE the story was written. The story you brief must feature this imagery (or gracefully incorporate it) — a cover promising a compass-and-map quest must not front a story where neither appears.',
      }
      : null,
    order: {
      childName: child.name || rawRequest?.childName,
      ageYears: child.age ?? rawRequest?.childAge ?? null,
      birthDate: child.birthDate || null,
      gender: child.gender || rawRequest?.childGender || null,
      interests: child.interests || rawRequest?.childInterests || [],
      customDetails: rawRequest?.customDetails || '',
      // Raw questionnaire Q/A triples (sanitized at the API boundary) — the
      // richest personalization signal the parent gives us; forwarded
      // verbatim so the brief can mine anecdotes the structured fields miss.
      answeredQuestions: rawRequest?.answeredQuestions || [],
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

  // Interests ride the brief VERBATIM, code-side — every stage downstream
  // (concept, writer, revision, judges) reads only the brief, so trusting
  // the LLM to echo them is exactly how "kid likes space" became a generic
  // jungle book.
  const interests = (Array.isArray(child.interests) && child.interests.length
    ? child.interests
    : (rawRequest?.childInterests || [])).map(String).filter(Boolean);

  const brief = {
    // Shallow-copy the entries: the backstop below may append, and mutating
    // the raw LLM output in place would leak into anything else holding it.
    child_as_character: out.child_as_character.map((d) => ({ ...d })),
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
    interests,
    story_world: typeof out.story_world === 'string' && out.story_world.trim()
      ? out.story_world.trim().slice(0, 300)
      : null,
    _usage: resp.usage,
    _model: resp.model,
  };

  // Backstop: if the model ranked every stated interest out of the brief,
  // force the strongest one back in as load-bearing. Deterministic, loud —
  // a stated interest is why the parent bought the book.
  if (interests.length > 0) {
    const detailText = brief.child_as_character
      .map((d) => `${d.detail || ''} ${d.story_potential || ''}`)
      .join(' ')
      .toLowerCase();
    const primary = interests[0];
    if (!detailText.includes(primary.toLowerCase())) {
      brief.child_as_character.push({
        detail: `loves ${primary}`,
        story_potential: `the story's world or premise should visibly live in ${primary} — it is a stated interest from the order, not decoration`,
        load_bearing: true,
        source: 'interest_backstop',
      });
      ctx.log('warn', `[v3] creativeBrief dropped stated interest '${primary}' — backstop load-bearing entry appended`);
    }
  }

  const loadBearing = brief.child_as_character.filter((d) => d.load_bearing === true).length;
  ctx.log('info', `[v3] creativeBrief: ${brief.child_as_character.length} details (${loadBearing} load-bearing), interests=[${interests.join(', ')}], story_world='${(brief.story_world || 'none').slice(0, 80)}', gift_intent='${brief.gift_intent.slice(0, 80)}...'`);
  return brief;
}

module.exports = { creativeBriefActivity };
