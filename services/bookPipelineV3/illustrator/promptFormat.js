/**
 * Shared prompt formatting for the native illustrator — pieces that the
 * RENDER prompt and the QA JUDGE prompt must read identically.
 *
 * Cast list (2026-07-16, book 5792dc26): joining characters_present with
 * ', ' turned ["Amit", "a magical turtle"] into "Amit, a magical turtle" —
 * an apposition the judge read as "Amit IS a magical turtle", failing good
 * candidates for showing "an extra boy". The list is now numbered with an
 * explicit count, and the hero (always first in the writer's contract) is
 * labeled, so neither the renderer nor the judge can misparse it.
 */

/**
 * @param {string[]|undefined} characters - scene_contract.characters_present
 * @returns {string} e.g. "(exactly 2, nobody else): [1] Amit — the child hero; [2] a magical turtle"
 */
function formatCastList(characters) {
  const list = Array.isArray(characters) ? characters.filter(Boolean).map(String) : [];
  if (list.length === 0) return '(exactly 1, nobody else): [1] the child — the child hero';
  const entries = list.map((c, i) => `[${i + 1}] ${c}${i === 0 ? ' — the child hero' : ''}`);
  return `(exactly ${list.length}, nobody else): ${entries.join('; ')}`;
}

module.exports = { formatCastList };
