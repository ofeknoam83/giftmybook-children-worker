'use strict';

const { PDFDocument } = require('pdf-lib');
const { assemblePdf, pickOverlayTone } = require('./../../services/layoutEngine');

// Caption-mode layout (native illustrator, 2026-07-16): a 'spread' entry with
// illustrationAspect: 'square' must produce a TYPESET caption verso page +
// a full-bleed recto page — never the legacy wide-split path (which bisects
// the square art and prints no story text). These tests run without image
// buffers, so no sharp native ops are hit (the sandbox sharp binary is
// incompatible — see layoutEngine.splitSpread.test.js).
//
// Front matter is blank + dedication + title = 3 pages, so the first spread's
// verso page is page index 3.
const VERSO_INDEX = 3;

async function build(entries, opts = {}) {
  const buf = await assemblePdf(entries, 'picture_book', { title: 'T', childName: 'Amit', minPages: 6, ...opts });
  return PDFDocument.load(buf);
}

function spreadEntry(extra = {}) {
  return { type: 'spread', spread: 1, ...extra };
}

describe('assemblePdf caption mode (square entries)', () => {
  test('a square entry with captionText typesets the caption on the verso page', async () => {
    const doc = await build([
      spreadEntry({ illustrationAspect: 'square', captionText: 'Amit zips his life vest tight.\nThe river hums a morning song.' }),
    ]);
    const verso = doc.getPage(VERSO_INDEX);
    // Typeset caption ⇒ the verso page has drawn content.
    expect(verso.node.Contents()).toBeDefined();
  });

  test('a wide (legacy) entry leaves the verso page as a bare image slot — no typeset text', async () => {
    const doc = await build([spreadEntry()]);
    const verso = doc.getPage(VERSO_INDEX);
    // Legacy path draws nothing without an image buffer: no content stream.
    expect(verso.node.Contents()).toBeUndefined();
  });

  test('an empty captionText on a square entry adds the page but draws nothing (early return)', async () => {
    const doc = await build([spreadEntry({ illustrationAspect: 'square', captionText: '' })]);
    expect(doc.getPage(VERSO_INDEX).node.Contents()).toBeUndefined();
  });

  // Embedded text layout (2026-07-17): wide art spans both pages, the caption
  // is typeset OVER the half containing the art director's quiet zone —
  // integrated (no scrim panel), tone picked from the zone's luminance. These
  // tests run without image buffers so no sharp native ops are hit — the
  // overlay draws in the fallback light-text tone regardless of the image,
  // which is exactly what we pin.
  describe('embedded overlay', () => {
    test('caption overlays the LEFT page for a left-* zone', async () => {
      const doc = await build([
        spreadEntry({ illustrationAspect: 'wide', textLayout: 'embedded', captionText: 'The fox pads past the hose.', textZone: 'left-top' }),
      ]);
      // verso (index 3) carries the overlay; recto (index 4) stays bare.
      expect(doc.getPage(VERSO_INDEX).node.Contents()).toBeDefined();
      expect(doc.getPage(VERSO_INDEX + 1).node.Contents()).toBeUndefined();
    });

    test('caption overlays the RIGHT page for a right-* zone', async () => {
      const doc = await build([
        spreadEntry({ illustrationAspect: 'wide', textLayout: 'embedded', captionText: 'Then something darts near the flower bed.', textZone: 'right-bottom' }),
      ]);
      expect(doc.getPage(VERSO_INDEX).node.Contents()).toBeUndefined();
      expect(doc.getPage(VERSO_INDEX + 1).node.Contents()).toBeDefined();
    });

    test('two pages per embedded spread; legacy wide entries (no textLayout) draw no overlay', async () => {
      const doc = await build([
        spreadEntry({ illustrationAspect: 'wide', textLayout: 'embedded', captionText: 'One.', textZone: 'left-top' }),
        { type: 'spread', spread: 2, illustrationAspect: 'wide' }, // legacy re-finalize entry
      ], { minPages: 2 });
      // 3 front matter + 2×2 spread pages + 1 closing = 8
      expect(doc.getPageCount()).toBe(8);
      // legacy spread pages (indexes 5,6) have no typeset content
      expect(doc.getPage(5).node.Contents()).toBeUndefined();
      expect(doc.getPage(6).node.Contents()).toBeUndefined();
    });

    // Integrated typesetting: the overlay tone is picked from the caption
    // band's mean luminance (0-255). Light zones (sky, sand) take dark ink;
    // everything else takes white type with a dark halo.
    test('pickOverlayTone maps zone luminance to text tone', () => {
      expect(pickOverlayTone(0)).toBe('light-text');     // night scene
      expect(pickOverlayTone(139)).toBe('light-text');   // just under threshold
      expect(pickOverlayTone(140)).toBe('dark-text');    // threshold
      expect(pickOverlayTone(200)).toBe('dark-text');    // bright sky
      expect(pickOverlayTone(255)).toBe('dark-text');    // white
    });
  });

  test('each square spread contributes exactly two pages (caption verso + art recto)', async () => {
    const two = await build([
      spreadEntry({ illustrationAspect: 'square', captionText: 'One.' }),
      { type: 'spread', spread: 2, illustrationAspect: 'square', captionText: 'Two.' },
    ], { minPages: 2 });
    // 3 front matter + 2×2 spread pages + 1 closing = 8 (already even, ≥ minPages)
    expect(two.getPageCount()).toBe(8);
  });
});

describe('assemblePdf half-page layout (full-spread art + uniform text panel)', () => {
  const { computeBookCaptionBlock, BOOK_CAPTION_FONT_SIZE } = require('./../../services/layoutEngine');

  test('a half entry produces a painted uniform text panel verso + art recto slot', async () => {
    const doc = await build([
      spreadEntry({ textLayout: 'half', illustrationAspect: 'wide', captionText: 'Amit sails the paper boat.' }),
    ]);
    const verso = doc.getPage(VERSO_INDEX);
    // The panel rectangle + typeset caption => drawn content even with no art.
    expect(verso.node.Contents()).toBeDefined();
  });

  test('half without captionText falls through without crashing', async () => {
    const doc = await build([
      spreadEntry({ textLayout: 'half', illustrationAspect: 'wide' }),
    ]);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(6);
  });

  test('book typography is ONE system: caption pages and half panels share the fixed size', () => {
    const stub = { name: 'stub', widthOfTextAtSize: (t, s) => t.length * s * 0.5 };
    const fonts = { bubblegum: stub, playfair: stub, playfairItalic: stub, helv: stub };
    const geom = { pw: 630, ph: 630 };
    const short = computeBookCaptionBlock(fonts, 'A short line.', geom);
    const long = computeBookCaptionBlock(fonts, 'A much longer caption that wraps across several lines of the text panel and would have shrunk under the old adaptive ladder. '.repeat(2), geom);
    expect(short.size).toBe(BOOK_CAPTION_FONT_SIZE);
    expect(long.size).toBe(BOOK_CAPTION_FONT_SIZE);
    // Same serif face on both (caption-page priority, not the overlay face).
    expect(short.font).toBe(fonts.playfairItalic);
    expect(long.font).toBe(fonts.playfairItalic);
  });

  test('the smaller ladder steps are an overflow safety valve only', () => {
    const stub = { name: 'stub', widthOfTextAtSize: (t, s) => t.length * s * 0.5 };
    const fonts = { bubblegum: stub, playfair: stub, playfairItalic: stub, helv: stub };
    // A caption so long it cannot fit the printable height at the standard
    // size steps down instead of clipping toward the bleed.
    const huge = computeBookCaptionBlock(fonts, ('word '.repeat(24) + '\n').repeat(30), { pw: 630, ph: 630 });
    expect(huge.size).toBeLessThan(BOOK_CAPTION_FONT_SIZE);
  });
});
