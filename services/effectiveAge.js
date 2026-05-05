/**
 * Resolve the effective child age the pipeline should use for band routing.
 *
 * Birthday themes already prefer birth-date-derived age (celebrationAge) over
 * the client-provided childAge.
 *
 * PR K extends the same preference to parent themes (Mother's Day,
 * Father's Day) because lap-baby books were silently routing to PB_TODDLER
 * when a stale `childAge` was sent for a child whose birth date was correct.
 * PB_TODDLER bypasses every infant-band PR (H/I/J.1/J.4) and produces
 * dance/run/twirl/dialogue text the lap-baby cannot perform.
 *
 * Birth date is the ground-truth signal — when present, it wins on
 * birthday + parent themes.
 *
 * @param {object} params
 * @param {string} params.theme
 * @param {string|null|undefined} params.birthDateRaw
 * @param {number|null|undefined} params.childAge
 * @param {number|null|undefined} params.celebrationAge
 *   integer years derived from birth date by computeCelebrationAge
 * @returns {{ age: number, source: 'celebrationAge'|'childAge' }}
 */
function resolveEffectiveAge({ theme, birthDateRaw, childAge, celebrationAge }) {
  const isBirthdayTheme = theme === 'birthday' || theme === 'birthday_magic';
  const isParentTheme = theme === 'mothers_day' || theme === 'fathers_day';

  if (isBirthdayTheme && birthDateRaw) {
    return { age: celebrationAge, source: 'celebrationAge' };
  }
  if (isParentTheme && birthDateRaw) {
    return { age: celebrationAge, source: 'celebrationAge' };
  }
  return { age: childAge, source: 'childAge' };
}

/**
 * Themes whose effective age is derived from birth date (when present).
 * Exposed so callers can decide whether to log the override.
 */
const BIRTH_DATE_PREFERRED_THEMES = new Set([
  'birthday',
  'birthday_magic',
  'mothers_day',
  'fathers_day',
]);

module.exports = {
  resolveEffectiveAge,
  BIRTH_DATE_PREFERRED_THEMES,
};
