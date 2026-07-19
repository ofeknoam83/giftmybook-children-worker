/**
 * Layout adapter.
 *
 * Converts the canonical book document into the shape that the existing
 * `services/layoutEngine.assemblePdf` expects.
 *
 * Two layout shapes exist in assemblePdf:
 *
 *   - **square** (the native illustrator — every book since the cutover):
 *     the renderer emits a 1:1 illustration with NO on-image text. This
 *     adapter forwards the manuscript caption text per spread; assemblePdf
 *     renders the caption as PDF text on the verso (left) page and the
 *     square illustration full-bleed on the recto (right) page.
 *
 *   - **wide** (pre-cutover legacy books only): caption baked into the wide
 *     illustration; no caption text passed; assemblePdf splits the image
 *     into left + right pages. Kept so a legacy-rendered checkpoint doc
 *     re-entering layout (re-finalize) still lays out correctly.
 *
 * The caller is responsible for fetching `spreadIllustrationBuffer` from
 * `imageStorageKey` before calling assemblePdf (kept as a caller
 * responsibility so this module stays pure).
 */

/**
 * @param {object} doc
 * @returns {{ format: string, entries: object[], opts: object, spreadStorageKeys: string[] }}
 */
function toLayoutPayload(doc) {
  const isNative = doc.v3?.illustrator?.version === 'native';
  const textLayout = isNative ? (doc.v3?.textLayout || 'caption') : null;
  const aspect = isNative ? (textLayout === 'embedded' ? 'wide' : 'square') : 'wide';
  const entries = doc.spreads.map(s => ({
    type: 'spread',
    spread: s.spreadNumber,
    spreadIllustrationUrl: s.illustration?.imageUrl || null,
    spreadIllustrationStorageKey: s.illustration?.imageStorageKey || null,
    illustrationAspect: aspect,
    captionText: isNative ? (s.manuscript?.text || '') : undefined,
    ...(textLayout ? { textLayout } : {}),
    ...(textLayout === 'embedded' ? { textZone: s.illustration?.textZone || null, heroBox: s.illustration?.heroBox || null, figuresBox: s.illustration?.figuresBox || null } : {}),
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
