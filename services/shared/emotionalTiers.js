/**
 * Emotional-book theme registry + age→tier mapping.
 *
 * Extracted from services/storyPlanner.js so server.js (and any future
 * pipeline) can resolve emotional theming without depending on the legacy
 * planner module.
 *
 * v3-only cutover: every tier is a PICTURE_BOOK (product decision — emotional
 * books all-ages are picture books; early readers are retired). Tier ids are
 * kept so age still shapes tone/pacing downstream, but E3/E4 now ship with
 * the standard picture-book dimensions (13 spreads / 32 pages) instead of
 * their former early-reader sizes.
 */

/** Themes that trigger the emotional-book pipeline behavior. */
const EMOTIONAL_THEMES = new Set([
  'anxiety',
  'anger',
  'fear',
  'grief',
  'loneliness',
  'new_beginnings',
  'self_worth',
  'family_change',
]);

/**
 * Map a child's age to the emotional-book tier (format + spread count).
 * @param {number} age - child's age in years
 * @returns {{tier: string, bookFormat: string, spreads: number, minPages: number}}
 */
function getEmotionalTier(age) {
  const a = Number(age) || 5;
  if (a <= 3) return { tier: 'E1', bookFormat: 'PICTURE_BOOK', spreads: 8, minPages: 32 };
  if (a <= 6) return { tier: 'E2', bookFormat: 'PICTURE_BOOK', spreads: 13, minPages: 32 };
  // E3/E4 keep their tier ids (age still shapes tone/vocabulary downstream)
  // but ship as standard 32-page picture books — early readers are retired.
  if (a <= 9) return { tier: 'E3', bookFormat: 'PICTURE_BOOK', spreads: 13, minPages: 32 };
  return { tier: 'E4', bookFormat: 'PICTURE_BOOK', spreads: 13, minPages: 32 };
}

module.exports = { EMOTIONAL_THEMES, getEmotionalTier };
