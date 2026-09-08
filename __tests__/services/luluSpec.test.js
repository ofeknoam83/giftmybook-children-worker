'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const LULU = require('../../services/luluSpec');

const { PRODUCTS, GUIDELINES, coverGeometry, casewrapSpineIn, perfectBoundSpineIn, pictureBookProduct, interiorPageSizePt, preflightPictureBook, unembeddedFonts } = LULU;
const PB = PRODUCTS.CHILDREN_PICTURE_BOOK;
const HC = PRODUCTS.CHILDREN_PICTURE_BOOK_HARDCOVER;

describe('luluSpec geometry', () => {
  test('interior pages are trim + 0.125in bleed on every edge (8.75in square = 630pt)', () => {
    expect(interiorPageSizePt(PB)).toEqual({ widthPt: 630, heightPt: 630 });
    expect(interiorPageSizePt(HC)).toEqual({ widthPt: 630, heightPt: 630 });
  });

  test('paperback: spine = pages / 444 + 0.06in; canvas = bleed + back + spine + front + bleed', () => {
    const g = coverGeometry(PB, 32);
    expect(g.binding).toBe('perfect');
    expect(g.spineIn).toBeCloseTo(32 / 444 + 0.06, 6);
    expect(g.edgePt).toBe(9);
    expect(g.widthPt).toBeCloseTo(9 + 612 + g.spinePt + 612 + 9, 6);
    expect(g.heightPt).toBe(630);
    expect(g.safetyIn).toBe(0.5);
    expect(perfectBoundSpineIn(48, 460)).toBeCloseTo(48 / 460 + 0.06, 6);
  });

  test('hardcover casewrap: 8.5in square at 32 pages is Lulu\'s 19.0 × 10.25in canvas with a 0.25in spine', () => {
    const g = coverGeometry(HC, 32);
    expect(g.binding).toBe('casewrap');
    expect(g.edgeIn).toBe(0.875);
    expect(g.spineIn).toBe(0.25);
    expect(g.widthIn).toBeCloseTo(19.0, 6);
    expect(g.heightIn).toBeCloseTo(10.25, 6);
    expect(g.widthPt).toBeCloseTo(1368, 6);
    expect(g.heightPt).toBeCloseTo(738, 6);
    expect(g.safetyIn).toBe(0.75);
  });

  test('casewrap spine table steps at Lulu\'s page boundaries', () => {
    expect(casewrapSpineIn(24)).toBe(0.25);
    expect(casewrapSpineIn(84)).toBe(0.25);
    expect(casewrapSpineIn(85)).toBe(0.5);
    expect(casewrapSpineIn(140)).toBe(0.5);
    expect(casewrapSpineIn(141)).toBe(0.625);
    expect(casewrapSpineIn(5000)).toBe(2.063);
  });

  test('bindingType resolves the product: any HARDCOVER key is the casewrap, everything else the paperback', () => {
    expect(pictureBookProduct('CHILDREN_PICTURE_BOOK_HARDCOVER').key).toBe('CHILDREN_PICTURE_BOOK_HARDCOVER');
    expect(pictureBookProduct('hardcover').binding).toBe('casewrap');
    expect(pictureBookProduct('CHILDREN_PICTURE_BOOK').binding).toBe('perfect');
    expect(pictureBookProduct(null).binding).toBe('perfect');
    expect(pictureBookProduct('').podPackageId).toBe('0850X0850FCSTDPB080CW444GXX');
  });

  test('the spec pins the guideline numbers the layout reads', () => {
    expect(GUIDELINES.bleedIn).toBe(0.125);
    expect(GUIDELINES.safetyIn).toBe(0.5);
    expect(GUIDELINES.gutterIn).toBe(0.2);
    expect(GUIDELINES.targetPpi).toBe(300);
    expect(GUIDELINES.spineTextMinPages).toBe(80);
    expect(LULU.INTERIOR_MIN_PAGES).toBe(32);
  });
});

async function makeInterior(pages, size = [630, 630], { oddPage = null } = {}) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage(oddPage === i ? [600, 630] : size);
  return Buffer.from(await doc.save());
}

async function makeCover(product, pages, override = null) {
  const g = coverGeometry(product, pages);
  const doc = await PDFDocument.create();
  doc.addPage(override || [g.widthPt, g.heightPt]);
  return Buffer.from(await doc.save());
}

describe('preflightPictureBook', () => {
  test('a conforming paperback pair passes with no errors', async () => {
    const r = await preflightPictureBook({ interiorPdf: await makeInterior(32), coverPdf: await makeCover(PB, 32), bindingType: 'CHILDREN_PICTURE_BOOK' });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.pageCount).toBe(32);
    expect(r.product).toBe('CHILDREN_PICTURE_BOOK');
    expect(r.podPackageId).toBe('0850X0850FCSTDPB080CW444GXX');
    expect(r.interior.expectedPt).toEqual([630, 630]);
    expect(r.cover.spinePt).toBeCloseTo((32 / 444 + 0.06) * 72, 6);
  });

  test('a conforming hardcover pair passes; the cover must be the casewrap canvas', async () => {
    const ok = await preflightPictureBook({ interiorPdf: await makeInterior(36), coverPdf: await makeCover(HC, 36), bindingType: 'CHILDREN_PICTURE_BOOK_HARDCOVER' });
    expect(ok.ok).toBe(true);
    expect(ok.cover.expectedPt[0]).toBeCloseTo(1368, 6);
    // The paperback wrap sent for a hardcover order is the classic rejection.
    const bad = await preflightPictureBook({ interiorPdf: await makeInterior(36), coverPdf: await makeCover(PB, 36), bindingType: 'CHILDREN_PICTURE_BOOK_HARDCOVER' });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join('\n')).toMatch(/cover is .* expected 1368\.0×738\.0/);
  });

  test('page count below the product minimum and an odd count are errors', async () => {
    const r = await preflightPictureBook({ interiorPdf: await makeInterior(31), bindingType: 'CHILDREN_PICTURE_BOOK' });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/31 pages \(perfect allows 32-800\)/),
      expect.stringMatching(/page count 31 is odd/),
    ]));
  });

  test('one interior page of the wrong size names the page', async () => {
    const r = await preflightPictureBook({ interiorPdf: await makeInterior(32, [630, 630], { oddPage: 4 }), bindingType: '' });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([expect.stringMatching(/interior page 5 is 600\.0×630\.0 pt, expected 630\.0×630\.0/)]);
  });

  test('a cover-only rebuild is checked against the supplied page count', async () => {
    const r = await preflightPictureBook({ coverPdf: await makeCover(PB, 40), pageCount: 40, bindingType: 'CHILDREN_PICTURE_BOOK' });
    expect(r.ok).toBe(true);
    expect(r.interior).toBeNull();
    const two = await PDFDocument.create();
    two.addPage([1251, 630]); two.addPage([1251, 630]);
    const multi = await preflightPictureBook({ coverPdf: Buffer.from(await two.save()), pageCount: 40, bindingType: '' });
    expect(multi.errors).toEqual(expect.arrayContaining([expect.stringMatching(/cover has 2 pages, expected 1/)]));
    const noCount = await preflightPictureBook({ coverPdf: await makeCover(PB, 40), bindingType: '' });
    expect(noCount.errors).toEqual([expect.stringMatching(/without the interior page count/)]);
  });

  test('base-14 fonts are a note, an embedded TTF is silent, a non-base-14 font without a program is an error', async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const helv = await doc.embedFont(StandardFonts.HelveticaBold);
    const lib = await doc.embedFont(fs.readFileSync(path.join(__dirname, '..', '..', 'fonts', 'LiberationSans-Regular.ttf')));
    for (let i = 0; i < 32; i += 1) {
      const p = doc.addPage([630, 630]);
      p.drawText('x', { x: 100, y: 100, size: 12, font: i % 2 ? helv : lib });
    }
    // pdf-lib writes the font dictionaries at save time — inspect the saved file.
    const saved = Buffer.from(await doc.save());
    const fonts = unembeddedFonts(await PDFDocument.load(saved));
    expect(fonts).toEqual({ base14: ['Helvetica-Bold'], other: [] });
    const r = await preflightPictureBook({ interiorPdf: saved, bindingType: '' });
    expect(r.ok).toBe(true);
    expect(r.notes).toEqual([expect.stringMatching(/base-14 fonts .*Helvetica-Bold/)]);
    expect(r.interior.fonts.other).toEqual([]);

    // A hand-built simple font with no descriptor and a non-standard name.
    const { PDFName } = require('pdf-lib');
    const rogue = await PDFDocument.create();
    rogue.addPage([630, 630]);
    rogue.context.register(rogue.context.obj({ Type: 'Font', Subtype: 'TrueType', BaseFont: PDFName.of('Comic-Sans') }));
    const bad = await preflightPictureBook({ interiorPdf: Buffer.from(await rogue.save()), pageCount: 32, bindingType: '' });
    expect(bad.errors).toEqual(expect.arrayContaining([expect.stringMatching(/no embedded program: Comic-Sans/)]));
  });

  test('nothing to check is an error, never a silent pass', async () => {
    const r = await preflightPictureBook({ bindingType: '' });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(['nothing to preflight']);
  });
});
