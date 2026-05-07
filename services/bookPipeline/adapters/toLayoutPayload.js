/**
 * Layout adapter.
 *
 * Converts the canonical book document into the shape that the existing
 * `services/layoutEngine.assemblePdf` expects.
 *
 * Two layout shapes are supported, driven by `MODELS.SPREAD_RENDER`:
 *
 *   - **wide** (Gemini path): caption is baked into the wide 16:9 illustration
 *     by the renderer, so this adapter does NOT pass caption text — only the
 *     wide spread image. assemblePdf splits the image into left + right pages.
 *
 *   - **square** (OpenAI gpt-image-2 path): the renderer emits a 1:1
 *     illustration with NO on-image text. This adapter forwards the manuscript
 *     caption text per spread; assemblePdf renders the caption as PDF text on
 *     the verso (left) page and the square illustration full-bleed on the
 *     recto (right) page.
 *
 * The caller is responsible for fetching `spreadIllustrationBuffer` from
 * `imageStorageKey` before calling assemblePdf (kept as a caller
 * responsibility so this module stays pure).
 */

const { MODELS } = require('../constants');

function _resolveIllustrationAspect() {
  const m = String(MODELS.SPREAD_RENDER || '').toLowerCase();
  if (m.startsWith('gpt-image') || m.startsWith('openai-image')) return 'square';
  return 'wide';
}

/**
 * @param {object} doc
 * @returns {{ format: string, entries: object[], opts: object, spreadStorageKeys: string[] }}
 */
function toLayoutPayload(doc) {
  const aspect = _resolveIllustrationAspect();
  const entries = doc.spreads.map(s => ({
    type: 'spread',
    spread: s.spreadNumber,
    spreadIllustrationUrl: s.illustration?.imageUrl || null,
    spreadIllustrationStorageKey: s.illustration?.imageStorageKey || null,
    illustrationAspect: aspect,
    captionText: aspect === 'square' ? (s.manuscript?.text || '') : undefined,
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
