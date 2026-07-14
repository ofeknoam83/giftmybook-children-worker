/**
 * Illustration policy — single source of truth for who may appear in spreads
 * and how secondaries are merged from cover vision + customer confirmations.
 */

const { PARENT_THEMES } = require('./config');

/**
 * @param {Array<{role?: string, label?: string, description?: string}>|null|undefined} confirmedCharacters
 * @returns {string} Multiline bullet list for prompts / QA, or empty string.
 */
function formatConfirmedCharactersForIllustration(confirmedCharacters) {
  if (!Array.isArray(confirmedCharacters) || confirmedCharacters.length === 0) return '';
  const lines = [];
  for (const c of confirmedCharacters) {
    if (!c || c.role === 'exclude') continue;
    if (c.role === 'main_child') continue;
    const label = String(c.label || c.role || 'person').trim();
    const desc = String(c.description || '').trim() || 'appearance per customer confirmation';
    lines.push(`- ${label} (role=${c.role || 'secondary'}): ${desc}`);
  }
  return lines.join('\n');
}

/**
 * When the themed parent is not on the cover, do not treat confirmed Mom/Dad
 * as licensable full-face references — implied-presence rules still apply.
 *
 * @param {Array<object>|null|undefined} confirmedCharacters
 * @param {string} theme
 * @returns {Array<object>|null}
 */
function filterConfirmedForCoverPolicy(confirmedCharacters, theme) {
  if (!Array.isArray(confirmedCharacters) || confirmedCharacters.length === 0) return null;
  if (!PARENT_THEMES.has(theme)) return confirmedCharacters;

  const isParentRole = (role) => {
    const r = String(role || '').toLowerCase();
    return /\b(mother|father|mom|dad|mama|papa|mommy|daddy|parent)\b/.test(r);
  };

  return confirmedCharacters.filter((c) => {
    if (!c || c.role === 'exclude' || c.role === 'main_child') return false;
    if (isParentRole(c.role) || isParentRole(c.label)) return false;
    return true;
  });
}

/**
 * Merge Gemini cover-vision secondary lines with customer-confirmed cast.
 *
 * @param {string|null|undefined} coverVisionText - Raw model output from cover scan (or null if NONE).
 * @param {string} confirmedBlock - From formatConfirmedCharactersForIllustration (may be empty).
 * @returns {string|null}
 */
function mergeCoverAndConfirmedSecondaries(coverVisionText, confirmedBlock) {
  const cv = typeof coverVisionText === 'string' ? coverVisionText.trim() : '';
  const cb = typeof confirmedBlock === 'string' ? confirmedBlock.trim() : '';
  if (cv && cb) {
    return `${cv}\n\nCustomer-confirmed cast (match consistently when the story includes them):\n${cb}`;
  }
  if (cv) return cv;
  if (cb) {
    return `Customer-confirmed cast (match consistently when the story includes them):\n${cb}`;
  }
  return null;
}

/**
 * Short paragraph for consistency QA when non-cover adults are allowed via confirmation.
 *
 * @param {string} mergedSecondaries
 * @returns {string}
 */
function buildQaAllowedHumansNote(mergedSecondaries) {
  const t = typeof mergedSecondaries === 'string' ? mergedSecondaries.trim() : '';
  if (!t) return '';
  return `Customer confirmation + cover policy: the following people MAY appear as full or partial figures when the story requires them (faces allowed only if they are part of this list and not blocked by parent-theme implied-presence rules): ${t.slice(0, 1200)}`;
}

module.exports = {
  formatConfirmedCharactersForIllustration,
  filterConfirmedForCoverPolicy,
  mergeCoverAndConfirmedSecondaries,
  buildQaAllowedHumansNote,
};
