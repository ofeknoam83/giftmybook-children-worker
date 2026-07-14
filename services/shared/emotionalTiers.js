/**
 * Emotional-book theme registry + age→tier mapping.
 *
 * Extracted from services/storyPlanner.js so server.js (and any future
 * pipeline) can resolve emotional theming without depending on the legacy
 * planner module. NOTE (v3 cutover): tiers E3/E4 currently map to
 * EARLY_READER — the picture-books-only cutover (plan Phase D) will force
 * all tiers to PICTURE_BOOK; keep that change in the cutover PR, not here.
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
  if (a <= 9) return { tier: 'E3', bookFormat: 'EARLY_READER', spreads: 18, minPages: 48 };
  return { tier: 'E4', bookFormat: 'EARLY_READER', spreads: 20, minPages: 56 };
}

module.exports = { EMOTIONAL_THEMES, getEmotionalTier };
