/**
 * Shared helpers for surfacing questionnaire anecdotes into writer prompts.
 *
 * Historically each theme writer (generic, mothers_day, fathers_day) had its
 * own copy of formatAnecdotes and personalizationChecklist, each with a
 * slightly different field list. That meant the same child's favorite cake
 * flavor (for example) made it into a birthday prompt but not a Father's Day
 * one — for no reason except the copies had drifted.
 *
 * This module is the single source of truth. Every questionnaire field the
 * writer cares about is listed here once.
 */

/**
 * Ordered list of anecdote fields the writer renders into the user prompt.
 * Order here controls display order in the prompt. All are optional.
 *
 * Keep in sync with:
 *  - services/validation.js ANECDOTE_FIELDS
 *  - services/writer/engine.js buildChildFromLegacy
 */
const ANECDOTE_FIELDS = [
  { key: 'favorite_activities',  label: 'Favorite activities' },
  { key: 'funny_thing',          label: 'Funny thing they do' },
  { key: 'meaningful_moment',    label: 'Meaningful moment' },
  { key: 'moms_favorite_moment', label: "Mom's favorite moment" },
  { key: 'dads_favorite_moment', label: "Dad's favorite moment" },
  { key: 'favorite_food',        label: 'Favorite food' },
  { key: 'favorite_cake_flavor', label: 'Favorite cake flavor' },
  { key: 'favorite_toys',        label: 'Favorite toys' },
  { key: 'other_detail',         label: 'Other detail' },
  { key: 'anything_else',        label: 'Additional' },
];

/**
 * Format the anecdotes object as a plain-text block suitable for prompt
 * injection. Empty / missing values are skipped. Returns '' if nothing to
 * render.
 *
 * @param {Record<string, string>} [anecdotes]
 * @returns {string}
 */
function formatAnecdotes(anecdotes) {
  if (!anecdotes || typeof anecdotes !== 'object') return '';
  const lines = [];
  for (const { key, label } of ANECDOTE_FIELDS) {
    const val = anecdotes[key];
    if (typeof val === 'string' && val.trim()) {
      lines.push(`${label}: ${val.trim()}`);
    }
  }
  return lines.join('\n');
}

/**
 * Build the "personalization checklist" — every concrete detail the writer
 * MUST land somewhere in the prose. Used to keep specific, personal details
 * from being abstracted away into greeting-card filler.
 *
 * Returns a flat array of human-readable strings, ready to join with '\n- '.
 *
 * @param {object} child
 * @param {object} book
 * @param {object} [plan]
 * @returns {string[]}
 */
function buildPersonalizationChecklist(child, book, plan) {
  const items = [];
  const a = (child && child.anecdotes) || {};
  for (const { key, label } of ANECDOTE_FIELDS) {
    const val = a[key];
    if (typeof val === 'string' && val.trim()) {
      items.push(`${label}: ${val.trim()}`);
    }
  }
  if (Array.isArray(child?.interests) && child.interests.length > 0) {
    items.push(`Interests to weave in: ${child.interests.join(', ')}`);
  }
  // Accept seed either off the plan or passed implicitly via the writer's
  // _storySeed stash. Both paths can coexist.
  const seed = plan?.storySeed || null;
  if (seed?.favorite_object && typeof seed.favorite_object === 'string' && seed.favorite_object.trim()) {
    items.push(`Story object/companion: ${seed.favorite_object.trim()}`);
  }
  if (seed?.setting && typeof seed.setting === 'string' && seed.setting.trim()) {
    items.push(`World/setting: ${seed.setting.trim()}`);
  }
  if (book && typeof book.customDetails === 'string' && book.customDetails.trim()) {
    items.push(`Parent-written custom details (every specific noun/person/place here must land somewhere concrete): ${book.customDetails.trim()}`);
  }
  return items;
}

module.exports = {
  ANECDOTE_FIELDS,
  formatAnecdotes,
  buildPersonalizationChecklist,
};
