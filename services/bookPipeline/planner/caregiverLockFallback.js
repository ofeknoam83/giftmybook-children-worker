/**
 * Caregiver-lock fallback synthesis (Phase-X).
 *
 * Pure helper extracted from detectCoverComposition.js so it can be unit-
 * tested without dragging in sharp / gcsStorage / illustrationGenerator
 * at module load time.
 *
 * Why this exists: the full chain of caregiver QA tags
 * (caregiver_body_duplicated, phantom_arms, caregiver_skin_drift,
 * caregiver_shadow_substitution) is gated on a non-null `caregiverLock`
 * inside services/illustrator/consistencyQa.js (lines 255 + 262). When the
 * second vision call (callCaregiverVision) returns null — transient HTTP,
 * malformed JSON, or `present:false` on a face it didn't recognize — the
 * lock is null and the QA model NEVER receives the JSON field definitions
 * for those tags. The entire two-Mama defense vanishes silently.
 *
 * This synthesizes a minimal lock with role inferred from theme. Every
 * visual field uses the "(see cover render)" sentinel that the QA prompt's
 * repair templates already substitute (consistencyQa.js:256, 268, 271,
 * 274). The QA model receives the structural tag schema and can flag
 * duplications by reading the cover pixels for identity rather than a
 * textual lock.
 */

/**
 * @param {string|null|undefined} theme - book theme (e.g. 'mothers_day')
 * @returns {{
 *   present: true,
 *   role: string,
 *   skinTone: string,
 *   skinFamilyVsChild: string,
 *   hair: string,
 *   outfit: string,
 *   build: string,
 *   face: string,
 *   synthesizedFallback: true,
 * }}
 */
function synthesizeCaregiverLockFallback(theme) {
  const themeStr = String(theme || '').toLowerCase();
  const role = themeStr === 'mothers_day' ? 'mother'
    : themeStr === 'fathers_day' ? 'father'
    : themeStr === 'grandparents_day' ? 'grandparent'
    : 'caregiver';
  return {
    present: true,
    role,
    skinTone: '(see cover render)',
    skinFamilyVsChild: 'unclear',
    hair: '(see cover render)',
    outfit: '(see cover render)',
    build: '(see cover render)',
    face: '(see cover render)',
    synthesizedFallback: true,
  };
}

module.exports = { synthesizeCaregiverLockFallback };
