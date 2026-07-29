/**
 * Input-to-role mapping (2026-07-29 QA review, "AI Writer Guidelines" +
 * "AI Writer Feedback & Word List").
 *
 * The review's root-cause finding on the Liv book: personalization inputs
 * were handed to the model as a profile and came out as decoration —
 * mentioned once, never used ("Alex and Daniel were collected and
 * discarded"; "calls everything mama" became a nonsense exclamation). The
 * fix is rule 3: "Pre-map inputs to roles BEFORE generation. Don't hand the
 * model a profile and let it decide."
 *
 * This module builds that casting sheet deterministically from the
 * structured childAnecdotes (services/validation.js ANECDOTE_FIELDS —
 * sanitizeAnecdotes emits every key, '' when absent). It attaches to the
 * brief in creativeBriefActivity (the brief.themes pattern) and rides to
 * concept / writer / revision / judges; the gate's parent_name_missing
 * check and the role-usage lints read it via ctx.storyRoles.
 *
 * Missing inputs use the guidelines' warm defaults where one exists
 * (homeBase → "a warm, familiar home"); a role with no input is null —
 * defaults must feel intentional, never like placeholders.
 */

/** Stopwords excluded from role-usage token matching. */
const TOKEN_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'with',
  'his', 'her', 'their', 'my', 'our', 'your', 'she', 'he', 'they', 'it',
  'loves', 'love', 'likes', 'like', 'playing', 'plays', 'play', 'really',
  'always', 'everything', 'anything', 'things', 'thing', 'very', 'all',
  'every', 'when', 'them', 'also', 'lots', 'calls', 'time',
]);

/** Non-empty trimmed string or null ('' means "not provided"). */
function val(x) {
  const s = String(x ?? '').trim();
  return s.length ? s : null;
}

/**
 * Content tokens of a role value, for fuzzy lint matching ("playing and
 * swimming" → ['swimming']; inflection folding stays crude on purpose —
 * the lints that consume this are SOFT).
 *
 * @param {string} value
 * @returns {string[]} lowercase tokens, stopwords removed, 3+ chars
 */
function roleTokens(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z’']+/)
    .map((t) => t.replace(/[’']/g, ''))
    .filter((t) => t.length >= 3 && !TOKEN_STOPWORDS.has(t));
}

/**
 * Build the casting sheet. Every role is {source, value, directive} | null;
 * finalScene carries the parent fields; homeBase always exists (warm
 * default when nothing better is known).
 *
 * @param {{ childAnecdotes?: object, interests?: string[], childName?: string }} input
 * @returns {object|null} storyRoles, or null when there is nothing to cast
 */
function buildStoryRoles({ childAnecdotes, interests, childName } = {}) {
  const a = childAnecdotes || {};
  const name = val(childName) || 'the child';

  const hobby = val(a.favorite_activities)
    || (Array.isArray(interests) && interests.length ? interests.join(', ') : null);
  const funny = val(a.funny_thing);
  const callsMom = val(a.calls_mom);
  const callsDad = val(a.calls_dad);
  const food = val(a.favorite_food);
  const momName = val(a.mom_name);
  const dadName = val(a.dad_name);
  const place = val(a.favorite_place);

  const roles = {};

  roles.tool = hobby
    ? {
      source: 'favorite_activities',
      value: hobby,
      directive: `${name}'s hobby (${hobby}) is the TOOL that solves the story problem — it must be USED at the attempt/turn beats to make real progress, not mentioned as decoration`,
    }
    : null;

  // The funny trait is the turning point. When funny_thing is absent but a
  // calls_mom/calls_dad quirk exists (the Liv case: "calls everything
  // mama"), that quirk IS the funny trait; when both exist, funny_thing
  // wins and the calls_* fields serve the final scene only.
  const turning = funny
    ? { source: 'funny_thing', value: funny }
    : (callsMom && { source: 'calls_mom', value: callsMom })
    || (callsDad && { source: 'calls_dad', value: callsDad })
    || null;
  roles.turningPoint = turning
    ? {
      ...turning,
      directive: `${name}'s funny trait ("${turning.value}") is the TURNING POINT — the exact thing that resolves the threat. Demonstrate it LITERALLY AS BEHAVIOUR the reader watches, never converted to dialogue or an exclamation ("calls everything mama" means ${name} points at the moon and says mama — NOT someone shouting "Mama!")`,
    }
    : null;

  roles.worldObject = food
    ? {
      source: 'favorite_food',
      value: food,
      directive: `${name}'s favorite food (${food}) appears as a PHYSICAL OBJECT inside the story world — a landscape element, creature, or object ${name} uses MID-STORY (spreads 4-10), never background scenery and never only a reward at the end`,
    }
    : null;

  roles.finalScene = (momName || dadName)
    ? {
      momName,
      dadName,
      callsMom,
      callsDad,
      directive: `provided parent names are MANDATORY on the page: the ending must return ${name} to ${[momName, dadName].filter(Boolean).join(' and ')} by name (a hug, a shared moment) in the closing spreads`,
    }
    : null;

  roles.homeBase = place
    ? {
      source: 'favorite_place',
      value: place,
      default: false,
      directive: `${name}'s favorite place (${place}) is the return-to-comfort location at the very end`,
    }
    : {
      source: null,
      value: 'a warm, familiar home',
      default: true,
      directive: 'no favorite place was given — end somewhere warm and familiar (home, a hug), kept vague so any parent feels it; the default must read as a choice, not a fallback',
    };

  const hasAny = roles.tool || roles.turningPoint || roles.worldObject || roles.finalScene || !roles.homeBase.default;
  return hasAny ? roles : null;
}

/** One-line roles summary for the creativeBrief log. */
function summarizeRolesForLog(roles) {
  if (!roles) return 'none';
  const parts = [];
  if (roles.tool) parts.push(`tool='${roles.tool.value.slice(0, 30)}'`);
  if (roles.turningPoint) parts.push(`turn='${roles.turningPoint.value.slice(0, 30)}' (${roles.turningPoint.source})`);
  if (roles.worldObject) parts.push(`worldObject='${roles.worldObject.value.slice(0, 30)}'`);
  if (roles.finalScene) parts.push(`finalScene=[${[roles.finalScene.momName, roles.finalScene.dadName].filter(Boolean).join(', ')}]`);
  parts.push(`homeBase='${roles.homeBase.value.slice(0, 30)}'${roles.homeBase.default ? ' (default)' : ''}`);
  return parts.join(', ');
}

module.exports = { buildStoryRoles, roleTokens, summarizeRolesForLog };
