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
 *
 * Group/collective cast (2026-07-22, book 20d4fd6e, space theme): a scene
 * calling for a GROUP ("small aliens") was counted as ONE countable
 * individual — so every realistic crowd (4-5 aliens) failed as
 * extra_character / cast mismatch, burning candidate budgets. A cast member
 * may now be a GROUP: rendered as an allowed background cluster whose exact
 * count is NOT enforced, and NOT counted toward the enforced individual
 * total. A group is detected by an explicit structured flag (preferred —
 * `{ group: true }` / `{ count: 'many' }`) or, as a fallback for a bare
 * plural string the writer/art director emits, a plural/collective-noun
 * heuristic. Named/singular individuals are still enforced exactly, so a
 * stranger or a duplicated hero still fails.
 */

/** Collective/plural nouns that mark a bare-string cast member as a group. */
const GROUP_NOUNS = [
  'aliens', 'creatures', 'monsters', 'robots', 'animals', 'birds', 'fish',
  'bugs', 'insects', 'friends', 'children', 'kids', 'people', 'villagers',
  'crowd', 'group', 'cluster', 'flock', 'swarm', 'pack', 'herd', 'crew',
  'fairies', 'elves', 'dwarves', 'goblins', 'pirates', 'penguins', 'puppies',
  'kittens', 'ducklings', 'dancers', 'guests', 'passengers', 'students',
  'classmates', 'teammates', 'critters', 'sprites', 'gnomes',
];

/** Phrases that explicitly mark a cast member as a collective. */
const GROUP_PHRASE = /\b(a group of|a cluster of|a crowd of|a bunch of|a flock of|a swarm of|a pack of|a herd of|a team of|several|many|some|lots of|a few)\b/;

/**
 * The display label for a cast member (a bare string, or a structured
 * `{ name | label }` object).
 * @param {string|object} member
 * @returns {string}
 */
function memberLabel(member) {
  if (member && typeof member === 'object') return String(member.name || member.label || '').trim();
  return String(member || '').trim();
}

/**
 * True when a cast member is a GROUP/collective rather than one countable
 * individual. Prefers an explicit structured flag; falls back to a
 * plural/collective-noun heuristic on the label for bare strings.
 * @param {string|object} member
 * @returns {boolean}
 */
function isGroupMember(member) {
  if (member && typeof member === 'object' && (member.group === true || member.count === 'many')) {
    return true;
  }
  const lower = memberLabel(member).toLowerCase();
  if (!lower) return false;
  if (GROUP_PHRASE.test(lower)) return true;
  return GROUP_NOUNS.some((n) => new RegExp(`\\b${n}\\b`).test(lower));
}

/**
 * @param {Array<string|object>|undefined} characters - scene_contract.characters_present
 * @returns {string} e.g. "(exactly 2, nobody else): [1] Amit — the child hero; [2] a magical turtle"
 *   or, when a group is present, "(named cast enforced exactly; a declared
 *   group is allowed to be many): [1] Amit — the child hero (exactly one).
 *   Plus a small group of small aliens (a background cluster, 2-5, exact
 *   count not enforced). No OTHER named individuals."
 */
function formatCastList(characters) {
  const list = Array.isArray(characters) ? characters.filter(Boolean) : [];
  if (list.length === 0) return '(exactly 1, nobody else): [1] the child — the child hero';

  const flags = list.map(isGroupMember);
  const hasGroup = flags.some(Boolean);

  if (!hasGroup) {
    const entries = list.map((c, i) => `[${i + 1}] ${memberLabel(c)}${i === 0 ? ' — the child hero' : ''}`);
    return `(exactly ${list.length}, nobody else): ${entries.join('; ')}`;
  }

  const individuals = [];
  const groups = [];
  list.forEach((c, i) => {
    if (flags[i]) groups.push(memberLabel(c));
    else individuals.push({ label: memberLabel(c), hero: i === 0 });
  });

  const groupStr = groups
    .map((g) => `a small group of ${g} (a background cluster, 2-5, exact count not enforced)`)
    .join('. Plus ');

  if (individuals.length === 0) {
    return `(a declared group, no enforced named individuals): ${groupStr}. No OTHER named individuals.`;
  }

  const indStr = individuals
    .map((m, i) => `[${i + 1}] ${m.label}${m.hero ? ' — the child hero' : ''} (exactly one)`)
    .join('; ');
  return `(named cast enforced exactly; a declared group is allowed to be many): ${indStr}. Plus ${groupStr}. No OTHER named individuals.`;
}

module.exports = { formatCastList, isGroupMember, memberLabel, GROUP_NOUNS };
