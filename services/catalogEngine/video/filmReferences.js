/**
 * Video reference selection (gift video): which sheets of the Book Bible
 * ride a clip request, and how many.
 *
 * The vendor counts PICTURES per request — the start frame, the end frame
 * and every reference image together (Kling: seven, error 1201 on
 * 2026-09-08 when a full-story shot sent one start frame + seven sheets).
 * So a request's references are held to `imageBudget` (providers/models.js)
 * with a fixed priority, and the kept entries keep the kit's ORDER: a
 * request that fits every sheet is byte-identical to the unbudgeted one,
 * so its cache keys hold. An omitted reference is never silent — the
 * callers log it, record it and warn on the result — and never a lost
 * prop: the start frame is the book's own verified illustration, which
 * already shows it; a reference only guards its design during motion.
 */

/** Attachment priority: the child's sheet first, the companion next, props after. */
const IDENTITY_RANK = { character: 0, companion: 1 };

/**
 * Keep at most `budget` entries: the lowest rank first, ties in list order,
 * and the kept entries in their ORIGINAL order (a list that fits is
 * returned unchanged).
 * @template T
 * @param {T[]} list
 * @param {number} budget
 * @param {(entry: T, index: number) => number} rank lower keeps first
 * @returns {{kept: T[], omitted: T[]}}
 */
function keepWithinBudget(list, budget, rank) {
  if (!(list.length > budget)) return { kept: [...list], omitted: [] };
  const order = list.map((entry, i) => ({ i, rank: rank(entry, i) })).sort((a, b) => a.rank - b.rank || a.i - b.i);
  const keep = new Set(order.slice(0, Math.max(0, budget)).map(x => x.i));
  return { kept: list.filter((_, i) => keep.has(i)), omitted: list.filter((_, i) => !keep.has(i)) };
}

/**
 * Select video references without changing the book's illustration kit.
 * Personalization props are decorative; story props use the pinned critical
 * flag. Unknown story-object metadata is retained rather than guessed away.
 * @param {object} bible
 * @returns {{sheets: Array<{kind: string, sheet: object, value: string|null, storyObjectId: string|null}>, omittedProps: string[]}}
 */
function selectFilmReferenceSheets(bible) {
  const definitions = new Map((bible.storyObjects?.objects || []).map(def => [def.id, def]));
  const omittedProps = [];
  const sheets = [['character', bible.sheet], ['companion', bible.companion]]
    .filter(([, sheet]) => sheet?.base64).map(([kind, sheet]) => ({ kind, sheet, value: null, storyObjectId: null }));
  for (const prop of bible.props || []) {
    if (!prop.sheet?.base64 && !prop.sheet?.omitted) continue;
    if (!prop.storyObjectId || definitions.get(prop.storyObjectId)?.critical === false) {
      omittedProps.push(prop.value);
      continue;
    }
    sheets.push({ kind: 'prop', sheet: prop.sheet, value: prop.value, storyObjectId: prop.storyObjectId });
  }
  return { sheets, omittedProps };
}

/**
 * The references ONE shot attaches within the model's budget: the child
 * always, the companion next, then the essential props — a prop the shot's
 * spread STAGES (a required story-object occurrence) before one it merely
 * mentions, before one it never shows. Splitting the kit by scene is what
 * lets a book with more essential props than one request can carry still
 * animate every scene with the props that scene needs.
 * @param {Array<{kind: string, sheet: object, storyObjectId?: string|null, value?: string|null}>} sheets from selectFilmReferenceSheets
 * @param {{spread: number, budget: number, storyObjects?: {objects?: object[]}|null}} p
 * @returns {{sheets: object[], omitted: string[]}}
 */
function shotReferenceSheets(sheets, { spread, budget, storyObjects }) {
  const staged = new Map();
  for (const def of storyObjects?.objects || []) {
    const occurrence = (def.occurrences || []).find(o => o.spread === spread);
    if (occurrence) staged.set(def.id, occurrence.required === false ? 3 : 2);
  }
  const rank = entry => (Object.prototype.hasOwnProperty.call(IDENTITY_RANK, entry.kind) ? IDENTITY_RANK[entry.kind] : (staged.get(entry.storyObjectId) ?? 4));
  const { kept, omitted } = keepWithinBudget(sheets, budget, rank);
  return { sheets: kept, omitted: omitted.map(e => e.value || e.kind) };
}

module.exports = { selectFilmReferenceSheets, shotReferenceSheets, keepWithinBudget };
