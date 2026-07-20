/**
 * Signature style bible (design D11 — "one signature style, perfected").
 *
 * sb-1 (2026-07-20): the sb-0 placeholder prompted a soft 2D storybook look
 * ("NOT 3D render") while the cover pipeline is deliberately FROZEN to the
 * premium 3D Pixar-style CGI (`PIXAR_STYLE` in shared/illustration/config —
 * `canonicalBookArtStyle()` ignores the request on purpose). Result: 3D
 * covers stapled to 2D interiors — the mismatch a customer called out on
 * book 36e79635 ("I don't think the style is pixar premium"). The bible now
 * derives from the SAME frozen PIXAR_STYLE language the cover uses, so the
 * whole book reads as one product. The spread judge's style class flips
 * accordingly (2D/painterly drift is the break — see qa/spreadJudge.js).
 *
 * STYLE_VERSION participates in the identity-kit cache key: photoHash +
 * STYLE_VERSION + PROMPT_VERSION. Never edit the bible text without
 * bumping the version — silent style drift across cached sheets is
 * exactly the class of bug the versioning exists to prevent. (Bumping to
 * sb-1 regenerates every cached sheet once — intended.)
 */

const { PIXAR_STYLE } = require('../../shared/illustration/config');

const STYLE_VERSION = 'sb-1-pixar-premium-3d';

const STYLE_BIBLE = `SIGNATURE ART STYLE — GiftMyBook picture books (premium 3D, matches the book's cover):
- ${PIXAR_STYLE.prefix} ${PIXAR_STYLE.suffix}.
- NOT THIS: ${PIXAR_STYLE.antiStyle}.
- Characters are appealing 3D animated-film characters with expressive faces; child proportions must match the stated age exactly.
- Backgrounds are fully modeled 3D environments but readable — one clear focal point, supporting detail recedes into gentle depth-of-field.
- Consistent rendering quality, materials, and lighting language across every image in a book.
- Absolutely no text, letters, numbers, watermarks, or signatures in the artwork.`;

module.exports = { STYLE_VERSION, STYLE_BIBLE };
