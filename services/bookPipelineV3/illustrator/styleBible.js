/**
 * Signature style bible (design D11 — "one signature style, perfected").
 *
 * ⚠️ PLACEHOLDER. The real style bible is an authored product artifact
 * (style document + reference images) owned by the product team — it is
 * the blocking external dependency for the identity kit (cutover plan
 * §External dependencies). This placeholder keeps the pipeline code
 * buildable and testable; bump STYLE_VERSION when the authored bible
 * lands so every identity-kit cache entry regenerates.
 *
 * STYLE_VERSION participates in the identity-kit cache key: photoHash +
 * STYLE_VERSION + PROMPT_VERSION. Never edit the bible text without
 * bumping the version — silent style drift across cached sheets is
 * exactly the class of bug the versioning exists to prevent.
 */

const STYLE_VERSION = 'sb-0-placeholder';

const STYLE_BIBLE = `SIGNATURE ART STYLE — GiftMyBook picture books:
- Warm, painterly digital illustration with soft brushwork and visible texture; NOT flat vector, NOT 3D render, NOT photoreal.
- Rich cinematic lighting with gentle rim light; colors saturated but never neon.
- Characters have expressive, slightly oversized eyes and soft rounded features; child proportions must match the stated age exactly.
- Backgrounds are storybook-lush but readable — one clear focal point, supporting detail recedes.
- Consistent line weight and rendering quality across every image in a book.
- Absolutely no text, letters, numbers, watermarks, or signatures in the artwork.`;

module.exports = { STYLE_VERSION, STYLE_BIBLE };
