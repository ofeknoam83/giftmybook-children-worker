/**
 * Layout adapter.
 *
 * Converts the canonical book document into the shape that the existing
 * `services/layoutEngine.assemblePdf` expects.
 *
 * Text is already painted INTO each illustration by the new pipeline, so
 * this adapter does NOT pass `left`/`right` caption text — only the spread
 * illustrations and the book metadata. The caller is responsible for
 * fetching `spreadIllustrationBuffer` from `imageStorageKey` before calling
 * assemblePdf (kept as a caller responsibility so this module stays pure).
 */

/**
 * @param {object} doc
 * @returns {{ format: string, entries: object[], opts: object, spreadStorageKeys: string[] }}
 */
function toLayoutPayload(doc) {
  const entries = doc.spreads.map(s => ({
    type: 'spread',
    spread: s.spreadNumber,
    spreadIllustrationUrl: s.illustration?.imageUrl || null,
    spreadIllustrationStorageKey: s.illustration?.imageStorageKey || null,
  }));

  const opts = {
    title: doc.cover.title,
    childName: doc.brief.child.name,
    bookId: doc.request.bookId,
    year: new Date().getFullYear(),
  };

  const spreadStorageKeys = entries
    .map(e => e.spreadIllustrationStorageKey)
    .filter(Boolean);

  return {
    format: doc.request.format,
    entries,
    opts,
    spreadStorageKeys,
  };
}

module.exports = { toLayoutPayload };
