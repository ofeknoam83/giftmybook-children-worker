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
const { resolveThemeAxes, buildThemeDirective } = require('../../../shared/themes');
const { buildStoryRoles, roleTokens, summarizeRolesForLog } = require('../../storyRoles');

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

  // Theme axes (2026-07-29): occasion = WHY the book exists, storyTheme =
  // WHERE it lives. Resolved here (from the new explicit fields or the
  // legacy single `theme`) and attached to the returned brief so every
  // downstream stage — concept, writer, revision, judges — rides them
  // without new plumbing. The composed directive is the operative text.
  const themeAxes = resolveThemeAxes({
    occasion: rawRequest?.occasion,
    storyTheme: rawRequest?.storyTheme,
    theme: rawRequest?.theme,
  });
  const themeDirective = buildThemeDirective(themeAxes);

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
      // Structured anecdotes (2026-07-29 QA review): beside the flattened
      // customDetails so the brief model can rank them into
      // child_as_character. The binding input-to-role mapping is attached
      // code-side below (brief.storyRoles) — never trusted to the LLM.
      childAnecdotes: rawRequest?.childAnecdotes || null,
      // Raw questionnaire Q/A triples (sanitized at the API boundary) — the
      // richest personalization signal the parent gives us; forwarded
      // verbatim so the brief can mine anecdotes the structured fields miss.
      answeredQuestions: rawRequest?.answeredQuestions || [],
      theme: rawRequest?.theme || 'adventure',
      occasion: themeAxes.occasion,
      storyTheme: themeAxes.storyTheme,
      themeDirective,
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
    // Deterministic, code-side (same rationale as `interests` above): the
    // ordered occasion + story theme must survive to every later prompt.
    themes: {
      occasion: themeAxes.occasion,
      storyTheme: themeAxes.storyTheme,
      directive: themeDirective,
    },
    // Input-to-role casting sheet (2026-07-29 QA review rule 3):
    // deterministic, code-side — same rationale as `themes` above. Each
    // role is a plot mechanic the writer must honor; the gate's
    // parent_name_missing check and the role-usage lints read it too.
    storyRoles: buildStoryRoles({
      childAnecdotes: rawRequest?.childAnecdotes,
      interests,
      childName: child.name || rawRequest?.childName,
    }),
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

  // Roles backstop warning (same philosophy as the interests backstop): a
  // cast role whose tokens never surface in child_as_character means the
  // model ranked a bought-and-paid-for personalization input out of the
  // brief. The code-side attachment above means downstream stages get the
  // role regardless — this is the loud paper trail.
  if (brief.storyRoles) {
    const detailText = brief.child_as_character
      .map((d) => `${d.detail || ''} ${d.story_potential || ''}`)
      .join(' ')
      .toLowerCase();
    for (const key of ['tool', 'turningPoint', 'worldObject']) {
      const role = brief.storyRoles[key];
      if (!role) continue;
      const tokens = roleTokens(role.value);
      if (tokens.length && !tokens.some((t) => detailText.includes(t))) {
        ctx.log('warn', `[v3] creativeBrief: story role '${key}' ('${role.value.slice(0, 40)}') absent from child_as_character — the code-side storyRoles attachment still carries it downstream`);
      }
    }
  }

  const loadBearing = brief.child_as_character.filter((d) => d.load_bearing === true).length;
  ctx.log('info', `[v3] creativeBrief: ${brief.child_as_character.length} details (${loadBearing} load-bearing), interests=[${interests.join(', ')}], occasion=${themeAxes.occasion || 'none'}, storyTheme=${themeAxes.storyTheme || 'none'}, storyRoles={${summarizeRolesForLog(brief.storyRoles)}}, story_world='${(brief.story_world || 'none').slice(0, 80)}', gift_intent='${brief.gift_intent.slice(0, 80)}...'`);
  return brief;
}

module.exports = { creativeBriefActivity };
