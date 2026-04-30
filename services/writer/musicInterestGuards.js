/**
 * Writer prompt snippets when questionnaire data mentions music/singing.
 * Reduces repetitive "floating musical note / melody chase" MacGuffins.
 */

const MUSIC_SIGNAL = /\b(sing(?:ing)?|song|songs|music|karaoke|chorus|choir|vocal(?:ist)?)\b/i;

/**
 * @param {(string|null|undefined)[]} chunks
 * @returns {boolean}
 */
function questionnaireMentionsMusic(...chunks) {
  for (const c of chunks) {
    if (typeof c !== 'string' || !c.trim()) continue;
    if (MUSIC_SIGNAL.test(c)) return true;
  }
  return false;
}

/** @param {Record<string,string>|undefined} anecdotes */
function anecdoteBlob(anecdotes) {
  if (!anecdotes || typeof anecdotes !== 'object') return '';
  const keys = [
    'favorite_activities', 'funny_thing', 'meaningful_moment', 'moms_favorite_moment',
    'dads_favorite_moment', 'favorite_food', 'other_detail', 'anything_else',
  ];
  return keys.map(k => anecdotes[k]).filter(Boolean).join(' ');
}

/** One-shot line appended to legacy storyPlanner system prompts when music shows up in the brief. */
const STORY_PLANNER_MUSIC_BIAS_LINE =
  '\n\nMUSIC / SINGING IN THE BRIEF: If interests or questionnaire mention singing or music, do **not** default the plot spine to floating glowing notes, a "runaway melody" chase, or recovering a fading lullaby as a physical collectible unless custom details explicitly request music-as-magic fantasy. Prefer grounded shared moments — car singalong, kitchen hum with a pretend mic, marching past a bandshell, humming while stacking blocks — with at most one light whimsical sound-image in the whole book if any.';

/**
 * Legacy Phase-1 planner: coarse text blob from child questionnaire + optional custom string.
 * @param {object} childDetails
 * @param {string} [customDetails]
 */
function childDetailsSuggestMusicInterest(childDetails, customDetails = '') {
  const interestBlob = Array.isArray(childDetails?.interests)
    ? childDetails.interests.join(' ')
    : typeof childDetails?.interests === 'string'
      ? childDetails.interests
      : '';
  const anecdotes = anecdoteBlob(childDetails?.childAnecdotes || childDetails?.anecdotes);
  return questionnaireMentionsMusic(interestBlob, anecdotes, typeof customDetails === 'string' ? customDetails : '');
}

/**
 * @param {string[]} sections
 * @param {object} child
 */
function appendMusicInterestNarrativeGuards(sections, child, book = {}) {
  const interestBlob = Array.isArray(child?.interests) ? child.interests.join(' ') : '';
  const an = anecdoteBlob(child?.anecdotes);
  const extras = [book.customDetails, book.heartfeltNote]
    .map(x => (typeof x === 'string' ? x : ''))
    .filter(Boolean)
    .join('\n');
  if (!questionnaireMentionsMusic(interestBlob, an, extras)) return;

  sections.push('\n## MUSIC OR SINGING IN THE QUESTIONNAIRE (USE IT — DON\'T DEFAULT TO ONE TROPE)\n');
  sections.push('- The questionnaire mentions singing or music. Ground it in **real, concrete scenes** parents can visualize: humming while stirring a pot, a car singalong with windows cracked, karaoke booth doorway glow, humming while stacking blocks, marching rhythm on a playground, a living-room dance-spin with a pretend microphone, humming while tying shoes.');
  sections.push('- **Do NOT** build the spine on these unless `customDetails` explicitly asks for a fantasy music world: glowing/floating musical notes as a recurring visual; chasing a lone "lost melody"; a trail of cartoon notes leading through spreads; recovering a fading lullaby as a collectible object unless the questionnaire names that idea.');
  sections.push('- **At most one** mildly whimsical sound-image in the entire book — and only if natural. Prefer depicting **voices, bodies moving to rhythm, and shared moments** rather than anthropomorphized music notation.');
}

module.exports = {
  questionnaireMentionsMusic,
  appendMusicInterestNarrativeGuards,
  STORY_PLANNER_MUSIC_BIAS_LINE,
  childDetailsSuggestMusicInterest,
};
