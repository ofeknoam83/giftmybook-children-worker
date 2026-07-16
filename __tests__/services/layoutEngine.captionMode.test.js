'use strict';

const { PDFDocument } = require('pdf-lib');
const { assemblePdf } = require('./../../services/layoutEngine');

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

  test('each square spread contributes exactly two pages (caption verso + art recto)', async () => {
    const two = await build([
      spreadEntry({ illustrationAspect: 'square', captionText: 'One.' }),
      { type: 'spread', spread: 2, illustrationAspect: 'square', captionText: 'Two.' },
    ], { minPages: 2 });
    // 3 front matter + 2×2 spread pages + 1 closing = 8 (already even, ≥ minPages)
    expect(two.getPageCount()).toBe(8);
  });
});
