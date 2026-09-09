/**
 * Lulu print specification for the children's picture-book products — the
 * ONE place the trim, bleed, safety margins, gutter, page limits, spine
 * formulas and cover-wrap geometry live. `layoutEngine` (the interior),
 * `coverGenerator` (the wrap) and {@link preflightPictureBook} all read
 * from here, so the file we BUILD and the file we CHECK can never disagree
 * about a number.
 *
 * Sources (Lulu Book Creation Guide + Print API help centre — "PDF creation
 * settings", "How is spine width calculated?", "Creating your hardcover
 * casewrap cover"):
 *   - Interior: 0.125 in bleed on every edge (page size = trim + 0.25 in),
 *     0.5 in safety margin for ALL content, a minimum 0.2 in gutter on the
 *     inner edge, 300 ppi images, embedded fonts, single pages (never
 *     spreads), no crop/bleed marks, no security. Page 1 prints on the RIGHT.
 *   - Paperback (perfect bound) cover: one page, bleed + back + spine +
 *     front + bleed wide, trim + 2 × bleed tall; spine = pages / paper PPI
 *     + 0.06 in (the SKU's "444" IS the paper PPI). No spine text under 80
 *     pages. Minimum 32 pages.
 *   - Hardcover (casewrap) cover: the board is 0.125 in larger than the trim
 *     on the three free edges and the artwork wraps 0.75 in around it, so
 *     every outer edge carries 0.875 in beyond the trim (the 8.5 × 8.5 in
 *     book is a 19.0 × 10.25 in canvas at the 0.25 in spine); the spine
 *     comes from Lulu's stepped table (24–84 pages → 0.25 in, 85–140 →
 *     0.5 in, …); a 0.75 in safety margin for all content. Minimum 24 pages.
 *
 * Every product below is one of the app's `bindingType` keys, with the
 * `pod_package_id` the app orders it under (server/services/lulu.js there)
 * — the SKU encodes trim (0850X0850), colour, quality, BINDING (PB / CW),
 * paper weight, PPI (444) and finish, which is exactly what this spec
 * derives the geometry from.
 */

'use strict';

const PT_PER_IN = 72;

/** Lulu's file guidelines — inches. */
const GUIDELINES = Object.freeze({
  bleedIn: 0.125,
  /** Interior AND paperback cover: keep every element this far inside the trim. */
  safetyIn: 0.5,
  /** Interior: the extra inner-edge margin the binding swallows. */
  gutterIn: 0.2,
  /** Hardcover casewrap cover: Lulu's larger safety margin. */
  casewrapSafetyIn: 0.75,
  /** Casewrap: artwork wrapped around the board beyond the board's own edge. */
  casewrapWrapIn: 0.75,
  /** Casewrap: the board overhangs the trim by this much on the three free edges. */
  casewrapOverhangIn: 0.125,
  /** Perfect bound: the flat cover allowance Lulu adds to the page block. */
  perfectBoundSpineAllowanceIn: 0.06,
  /** Lulu recommends no spine text below this page count. */
  spineTextMinPages: 80,
  targetPpi: 300,
  /**
   * pq-1: the effective PPI a page must reach to count as print-sharp here
   * — a 4K render across the 17.5 in spread (4096 / 17.5). Below it the
   * preflight WARNS; below `ppiFloor` (a caller knob, 0 = never) it errors.
   */
  sharpPpi: 234,
  /**
   * pq-1 Phase 4.3: the share of a page's pixels above 0.9 HSV saturation
   * past which the preflight warns that the press will dull it.
   */
  gamutWarnShare: 0.35,
});

/**
 * Lulu's hardcover casewrap spine table (page count → spine width, inches).
 * The first two rows (24–84 → 0.25 in, 85–140 → 0.5 in) are verified against
 * Lulu's Book Creation Guide; the rows above 140 pages follow the same
 * guide's sixteenth-of-an-inch steps and must be re-verified against Lulu's
 * cover-dimension calculator before any product exceeds 140 pages (the
 * children's books top out near 40). Exported for tests.
 */
const CASEWRAP_SPINE_TABLE = Object.freeze([
  [84, 0.25], [140, 0.5], [168, 0.625], [194, 0.688], [222, 0.75], [250, 0.813],
  [278, 0.875], [306, 0.938], [334, 1.0], [360, 1.063], [388, 1.125], [416, 1.188],
  [444, 1.25], [472, 1.313], [500, 1.375], [528, 1.438], [556, 1.5], [582, 1.563],
  [610, 1.625], [638, 1.688], [666, 1.75], [694, 1.813], [722, 1.875], [750, 1.938],
  [778, 2.0], [800, 2.063],
]);

/**
 * The products the worker prints, keyed by the app's `bindingType`.
 * `paperPpi` is the SKU's pages-per-inch figure (444 = 80# coated white).
 */
const PRODUCTS = Object.freeze({
  CHILDREN_PICTURE_BOOK: Object.freeze({
    key: 'CHILDREN_PICTURE_BOOK',
    podPackageId: '0850X0850FCSTDPB080CW444GXX',
    binding: 'perfect',
    trimWidthIn: 8.5,
    trimHeightIn: 8.5,
    paperPpi: 444,
    minPages: 32,
    maxPages: 800,
  }),
  CHILDREN_PICTURE_BOOK_HARDCOVER: Object.freeze({
    key: 'CHILDREN_PICTURE_BOOK_HARDCOVER',
    podPackageId: '0850X0850FCSTDCW080CW444GXX',
    binding: 'casewrap',
    trimWidthIn: 8.5,
    trimHeightIn: 8.5,
    paperPpi: 444,
    minPages: 24,
    maxPages: 800,
  }),
});

/**
 * The interior page floor the worker enforces for EVERY picture book: Lulu's
 * perfect-bound minimum. A hardcover interior (Lulu minimum 24) is padded to
 * the same 32 so the one interior prints in either binding — a customer's
 * reorder may switch binding without a rebuild.
 */
const INTERIOR_MIN_PAGES = 32;

/**
 * Resolve the picture-book product for an app `bindingType`. Anything that
 * is not a hardcover key is the paperback (the same default the cover wrap
 * has always used: `bindingType` absent ⇒ perfect bound).
 * @param {string|null|undefined} bindingType
 * @returns {object} one of {@link PRODUCTS}
 */
function pictureBookProduct(bindingType) {
  return String(bindingType || '').toUpperCase().includes('HARDCOVER')
    ? PRODUCTS.CHILDREN_PICTURE_BOOK_HARDCOVER
    : PRODUCTS.CHILDREN_PICTURE_BOOK;
}

/**
 * Perfect-bound spine width, inches (Lulu: pages / paper PPI + 0.06 in).
 * @param {number} pageCount
 * @param {number} [paperPpi=444]
 * @returns {number}
 */
function perfectBoundSpineIn(pageCount, paperPpi = 444) {
  return pageCount / paperPpi + GUIDELINES.perfectBoundSpineAllowanceIn;
}

/**
 * Casewrap spine width, inches, from Lulu's stepped table.
 * @param {number} pageCount
 * @returns {number}
 */
function casewrapSpineIn(pageCount) {
  const row = CASEWRAP_SPINE_TABLE.find(([maxPages]) => pageCount <= maxPages);
  return (row || CASEWRAP_SPINE_TABLE[CASEWRAP_SPINE_TABLE.length - 1])[1];
}

/**
 * Interior page size (trim + bleed on every edge), points.
 * @param {{trimWidthIn: number, trimHeightIn: number}} product
 * @returns {{widthPt: number, heightPt: number}}
 */
function interiorPageSizePt(product) {
  return {
    widthPt: (product.trimWidthIn + 2 * GUIDELINES.bleedIn) * PT_PER_IN,
    heightPt: (product.trimHeightIn + 2 * GUIDELINES.bleedIn) * PT_PER_IN,
  };
}

/**
 * The one-page wrap cover's geometry for a binding and page count.
 *
 * Paperback: `bleed + back + spine + front + bleed` wide, `trim + 2 × bleed`
 * tall. Casewrap: every outer edge carries overhang + wrap + bleed beyond
 * the trim (0.875 in), the spine comes from the table. `edgeIn` is what the
 * cover layout extends the artwork by on each outer edge; `safetyIn` is how
 * far inside the trim all text and machine codes must stay.
 *
 * @param {{trimWidthIn: number, trimHeightIn: number, binding: 'perfect'|'casewrap', paperPpi?: number}} product
 * @param {number} pageCount
 * @returns {{binding: string, spineIn: number, edgeIn: number, widthIn: number, heightIn: number, safetyIn: number,
 *   spinePt: number, edgePt: number, widthPt: number, heightPt: number, safetyPt: number}}
 */
function coverGeometry(product, pageCount) {
  const pages = Number.isInteger(pageCount) && pageCount > 0 ? pageCount : INTERIOR_MIN_PAGES;
  const casewrap = product.binding === 'casewrap';
  const spineIn = casewrap ? casewrapSpineIn(pages) : perfectBoundSpineIn(pages, product.paperPpi || 444);
  // Casewrap: the board overhangs the trim, then the artwork wraps around
  // the board — 0.875 in beyond the trim on every outer edge (the wrap IS
  // the bleed there). Paperback: the plain 0.125 in bleed.
  const edgeIn = casewrap
    ? GUIDELINES.casewrapOverhangIn + GUIDELINES.casewrapWrapIn
    : GUIDELINES.bleedIn;
  const widthIn = 2 * edgeIn + 2 * product.trimWidthIn + spineIn;
  const heightIn = product.trimHeightIn + 2 * edgeIn;
  const safetyIn = casewrap ? GUIDELINES.casewrapSafetyIn : GUIDELINES.safetyIn;
  return {
    binding: product.binding,
    spineIn, edgeIn, widthIn, heightIn, safetyIn,
    spinePt: spineIn * PT_PER_IN,
    edgePt: edgeIn * PT_PER_IN,
    widthPt: widthIn * PT_PER_IN,
    heightPt: heightIn * PT_PER_IN,
    safetyPt: safetyIn * PT_PER_IN,
  };
}

/** PDF base-14 font names — every viewer and Lulu's normalizer carry them. */
const BASE14 = new Set([
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
  'Symbol', 'ZapfDingbats',
]);

/**
 * Every font resource in a PDF that carries no embedded font program,
 * split into the base-14 names (the sanctioned exception Lulu's normalizer
 * substitutes) and anything else (a real "fonts not embedded" rejection).
 * Type0 composite fonts are judged through their descendant CIDFont, which
 * pdf-lib registers as its own indirect object; Type3 fonts carry their
 * glyph procedures inline and are always self-contained.
 *
 * @param {import('pdf-lib').PDFDocument} pdfDoc
 * @returns {{base14: string[], other: string[]}}
 */
function unembeddedFonts(pdfDoc) {
  const { PDFDict, PDFName } = require('pdf-lib');
  const FONT = PDFName.of('Font');
  const base14 = new Set();
  const other = new Set();
  for (const [, obj] of pdfDoc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || obj.get(PDFName.of('Type')) !== FONT) continue;
    const subtype = String(obj.get(PDFName.of('Subtype')) || '');
    if (subtype === '/Type0' || subtype === '/Type3') continue;
    const descriptor = pdfDoc.context.lookup(obj.get(PDFName.of('FontDescriptor')));
    const embedded = descriptor instanceof PDFDict
      && ['FontFile', 'FontFile2', 'FontFile3'].some(k => descriptor.has(PDFName.of(k)));
    if (embedded) continue;
    const name = String(obj.get(PDFName.of('BaseFont')) || '/unknown').replace(/^\//, '');
    (BASE14.has(name) ? base14 : other).add(name);
  }
  return { base14: [...base14].sort(), other: [...other].sort() };
}

/**
 * Deterministic preflight of a picture book's print pair against this spec —
 * the checks Lulu's own validation runs at order time, run at BUILD time so
 * a file Lulu would reject never reaches the app as "ready". Mirrors the
 * coloring book's `preflightLulu`.
 *
 * Errors (Lulu rejects the file): interior page count outside the product's
 * range or odd; an interior page whose size is not trim + bleed; a cover
 * that is not exactly one page of the geometry the page count demands; a
 * non-base-14 font without an embedded program. Notes: base-14 fonts in
 * use (accepted, substituted by Lulu's normalizer) — reported, never a flag.
 *
 * Pass `interiorPdf` alone, `coverPdf` + `pageCount` alone (a cover-only
 * rebuild), or both (the page count then comes from the interior).
 *
 * pq-1: `pageReport` (the layout engine's per-page source resolutions —
 * `assemblePdf({ pageReport })`) and `coverSource` (the front cover's
 * source pixel size) add an effective-PPI check per printed art page and
 * for the cover: below `GUIDELINES.sharpPpi` a WARNING, below `ppiFloor`
 * (0 = never) an ERROR. Reported as `pages` / `minPpi` / `coverPpi`.
 *
 * @param {{interiorPdf?: Buffer, coverPdf?: Buffer, bindingType?: string|null, pageCount?: number,
 *   pageReport?: Array<{page: number, spread: number|null, ppi: number|null, role?: string}>,
 *   coverSource?: {width: number, height: number}|null, ppiFloor?: number}} p
 * @returns {Promise<{ok: boolean, errors: string[], warnings: string[], notes: string[], product: string,
 *   podPackageId: string, pageCount: number|null, interior: object|null, cover: object|null,
 *   pages: Array|null, minPpi: number|null, coverPpi: number|null}>}
 */
async function preflightPictureBook({ interiorPdf, coverPdf, bindingType, pageCount, pageReport, coverSource, ppiFloor = 0 } = {}) {
  const { PDFDocument } = require('pdf-lib');
  const product = pictureBookProduct(bindingType);
  const errors = [];
  const warnings = [];
  const notes = [];
  const near = (a, b) => Math.abs(a - b) <= 0.5;
  const fmt = n => (Math.round(n * 10) / 10).toFixed(1);
  let pages = Number.isInteger(pageCount) ? pageCount : null;
  let interior = null;
  let cover = null;

  const fontReport = (doc, which) => {
    const fonts = unembeddedFonts(doc);
    if (fonts.other.length) errors.push(`${which} uses fonts with no embedded program: ${fonts.other.join(', ')}`);
    if (fonts.base14.length) notes.push(`${which} uses PDF base-14 fonts (substituted by Lulu's normalizer): ${fonts.base14.join(', ')}`);
    return fonts;
  };

  if (interiorPdf) {
    const doc = await PDFDocument.load(interiorPdf, { updateMetadata: false });
    const sizes = doc.getPages().map(pg => [pg.getWidth(), pg.getHeight()]);
    pages = sizes.length;
    const { widthPt, heightPt } = interiorPageSizePt(product);
    if (pages < product.minPages || pages > product.maxPages) {
      errors.push(`interior has ${pages} pages (${product.binding} allows ${product.minPages}-${product.maxPages})`);
    }
    if (pages % 2 !== 0) errors.push(`interior page count ${pages} is odd (every leaf prints two pages)`);
    const wrong = sizes.map(([w, h], i) => (near(w, widthPt) && near(h, heightPt) ? null : i + 1)).filter(Boolean);
    if (wrong.length) {
      const [w, h] = sizes[wrong[0] - 1];
      errors.push(`interior page${wrong.length > 1 ? 's' : ''} ${wrong.slice(0, 5).join(', ')}${wrong.length > 5 ? '…' : ''} ${wrong.length > 1 ? 'are' : 'is'} ${fmt(w)}×${fmt(h)} pt, expected ${fmt(widthPt)}×${fmt(heightPt)} (trim + bleed)`);
    }
    interior = { pages, sizePt: sizes[0] || [], expectedPt: [widthPt, heightPt], fonts: fontReport(doc, 'interior') };
  }

  if (!interiorPdf && coverPdf && pages != null) {
    if (pages < product.minPages || pages > product.maxPages) {
      errors.push(`cover page count ${pages} is outside ${product.binding}'s ${product.minPages}-${product.maxPages} page range`);
    }
    if (pages % 2 !== 0) errors.push(`cover page count ${pages} is odd (every leaf prints two pages)`);
  }

  if (coverPdf) {
    const doc = await PDFDocument.load(coverPdf, { updateMetadata: false });
    const sizes = doc.getPages().map(pg => [pg.getWidth(), pg.getHeight()]);
    const geometry = pages ? coverGeometry(product, pages) : null;
    if (sizes.length !== 1) errors.push(`cover has ${sizes.length} pages, expected 1 (the wrap)`);
    if (!geometry) {
      errors.push('cover cannot be checked without the interior page count');
    } else if (sizes[0] && (!near(sizes[0][0], geometry.widthPt) || !near(sizes[0][1], geometry.heightPt))) {
      errors.push(`cover is ${fmt(sizes[0][0])}×${fmt(sizes[0][1])} pt, expected ${fmt(geometry.widthPt)}×${fmt(geometry.heightPt)} (${product.binding}, ${pages} pages, spine ${fmt(geometry.spinePt)} pt)`);
    }
    cover = {
      pages: sizes.length,
      sizePt: sizes[0] || [],
      expectedPt: geometry ? [geometry.widthPt, geometry.heightPt] : null,
      spinePt: geometry ? geometry.spinePt : null,
      fonts: fontReport(doc, 'cover'),
    };
  }

  // pq-1: effective resolution — the pixels behind each printed art page.
  let pagesReport = null;
  let minPpi = null;
  if (Array.isArray(pageReport) && pageReport.length) {
    pagesReport = pageReport.map(r => ({ page: r.page, spread: r.spread ?? null, role: r.role || null, ppi: Number.isFinite(r.ppi) ? r.ppi : null, saturatedShare: Number.isFinite(r.saturatedShare) ? r.saturatedShare : null }));
    const hot = pagesReport.filter(r => r.saturatedShare != null && r.saturatedShare > GUIDELINES.gamutWarnShare);
    if (hot.length) {
      warnings.push(`${hot.length} art page${hot.length > 1 ? 's' : ''} very saturated (${Math.round(Math.max(...hot.map(r => r.saturatedShare)) * 100)}% of pixels above 0.9 saturation on page ${hot.sort((a, b) => b.saturatedShare - a.saturatedShare)[0].page}) — expect the press to print it duller than the screen`);
    }
    const unmeasured = ppiFloor > 0 ? pagesReport.filter(r => r.ppi == null) : [];
    if (unmeasured.length) {
      errors.push(`${unmeasured.length} art page${unmeasured.length > 1 ? 's' : ''} could not be measured against the ${ppiFloor} ppi floor (page ${unmeasured[0].page})`);
    }
    const measured = pagesReport.filter(r => r.ppi != null);
    if (measured.length) {
      minPpi = Math.min(...measured.map(r => r.ppi));
      const soft = measured.filter(r => r.ppi < GUIDELINES.sharpPpi);
      const failing = ppiFloor > 0 ? measured.filter(r => r.ppi < ppiFloor) : [];
      if (failing.length) {
        errors.push(`${failing.length} art page${failing.length > 1 ? 's' : ''} below the ${ppiFloor} ppi floor (lowest ${minPpi} ppi on page ${failing.sort((a, b) => a.ppi - b.ppi)[0].page})`);
      } else if (soft.length) {
        warnings.push(`${soft.length} art page${soft.length > 1 ? 's' : ''} below ${GUIDELINES.sharpPpi} ppi effective (lowest ${minPpi} ppi on page ${soft.sort((a, b) => a.ppi - b.ppi)[0].page}; Lulu recommends ${GUIDELINES.targetPpi}) — the source render is smaller than the print needs`);
      }
    }
  }
  let coverPpi = null;
  if (coverSource && coverSource.width > 0) {
    coverPpi = Math.round(coverSource.width / product.trimWidthIn);
    if (ppiFloor > 0 && coverPpi < ppiFloor) errors.push(`front cover is ${coverPpi} ppi effective, below the ${ppiFloor} ppi floor`);
    else if (coverPpi < GUIDELINES.sharpPpi) warnings.push(`front cover is ${coverPpi} ppi effective (${coverSource.width}px across ${product.trimWidthIn} in; Lulu recommends ${GUIDELINES.targetPpi})`);
  }

  if (!interiorPdf && !coverPdf) errors.push('nothing to preflight');

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    notes,
    product: product.key,
    podPackageId: product.podPackageId,
    pageCount: pages,
    interior,
    cover,
    pages: pagesReport,
    minPpi,
    coverPpi,
  };
}

module.exports = {
  PT_PER_IN,
  GUIDELINES,
  PRODUCTS,
  INTERIOR_MIN_PAGES,
  CASEWRAP_SPINE_TABLE,
  pictureBookProduct,
  perfectBoundSpineIn,
  casewrapSpineIn,
  interiorPageSizePt,
  coverGeometry,
  unembeddedFonts,
  preflightPictureBook,
};
