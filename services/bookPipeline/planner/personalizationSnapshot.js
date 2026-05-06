/**
 * Format brief.child + brief.customDetails for story-bible / spread-spec prompts.
 */

const ANECDOTE_KEYS_PRIORITY = [
  'favorite_activities', 'calls_mom', 'calls_dad', 'funny_thing', 'meaningful_moment',
  'moms_favorite_moment', 'dads_favorite_moment', 'favorite_food', 'favorite_toys',
  'anything_else', 'other_detail',
];

/**
 * @param {{ interests?: string[], appearance?: string, anecdotes?: Record<string,string> }} child
 * @param {Record<string, unknown>} [customDetails]
 * @param {{ subject?: string, object?: string, possessive?: string, reflexive?: string }} [pronouns]
 *   Canonical pronoun set resolved at brief boundary (AA-CW-5a). When provided
 *   it is rendered as the first line of the snapshot so every planner /
 *   spread-spec / story-bible prompt sees the same authoritative pronouns and
 *   cannot drift between waves.
 * @returns {string} Multi-line snapshot for planner LLMs.
 */
function renderPersonalizationSnapshotForPlanner(child = {}, customDetails = {}, pronouns = null) {
  const lines = [];

  // AA-CW-5b — pronouns first, so every downstream LLM (storyBible,
  // spreadSpecs) anchors on the same canonical set the writer / rewriter use.
  if (pronouns && typeof pronouns === 'object') {
    const s = String(pronouns.subject || '').trim();
    const o = String(pronouns.object || '').trim();
    const p = String(pronouns.possessive || '').trim();
    const r = String(pronouns.reflexive || '').trim();
    if (s && o && p && r) {
      lines.push(`PRONOUNS (use ONLY these, never swap, never alternate): subject=${s}, object=${o}, possessive=${p}, reflexive=${r}`);
    }
  }

  const interests = Array.isArray(child.interests) ? child.interests.filter(Boolean) : [];
  if (interests.length) {
    lines.push(`INTERESTS (ground spine, MacGuffin, companion flavors, and props here first): ${interests.join(', ')}`);
  }
  const appearance = typeof child.appearance === 'string' && child.appearance.trim();
  if (appearance) lines.push(`APPEARANCE: ${appearance.trim()}`);

  const anecdotes = child.anecdotes && typeof child.anecdotes === 'object' ? child.anecdotes : {};
  for (const k of ANECDOTE_KEYS_PRIORITY) {
    const v = anecdotes[k];
    if (typeof v === 'string' && v.trim()) lines.push(`QUESTIONNAIRE ${k}: ${v.trim()}`);
  }

  const body = lines.length
    ? lines.join('\n')
    : '  (sparse — mine concrete hooks from custom details block only if present)';

  return ['## PERSONALIZATION SNAPSHOT — PRIORITIZE OVER GENERIC ADVENTURE PALETTES', body].join('\n');
}

/**
 * @param {object} [child]
 * @param {Record<string, unknown>} [customDetails]
 * @returns {boolean}
 */
function briefHasRichPersonalization(child, customDetails) {
  const hasInterests = Array.isArray(child?.interests) && child.interests.some(s => String(s).trim());
  const an = child?.anecdotes && typeof child.anecdotes === 'object' ? child.anecdotes : {};
  const hasAnecdote = Object.values(an).some(v => typeof v === 'string' && v.trim());
  const hasCustom = Object.values(customDetails || {}).some(v => v != null && String(v).trim());
  return hasInterests || hasAnecdote || hasCustom;
}

module.exports = {
  renderPersonalizationSnapshotForPlanner,
  briefHasRichPersonalization,
};
