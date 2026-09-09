'use strict';

const { PDFDocument, PDFArray, PDFRawStream, decodePDFRawStream } = require('pdf-lib');
const { assemblePdf, computeUpsellCardLayout, SAFE, BLEED, notePageSource } = require('../../services/layoutEngine');
const LULU = require('../../services/luluSpec');

// Lulu's interior guidelines (2026-09-08): 0.125" bleed, a 0.5" safety
// margin for ALL content plus a 0.2" gutter on the inner edge, page 1 on
// the right. These tests run without image buffers (no sharp), so every
// drawn element is PDF type, a path, or an embedded QR image — and its
// position can be read straight out of the content stream. Embedded fonts
// write glyph ids, not text, so pages are recognised by their type SIZES.

const PW = 630;
const PH = 630;

/** Concatenated, decoded content of one page. */
function pageContent(doc, index) {
  const contents = doc.getPage(index).node.Contents();
  if (!contents) return '';
  const streams = contents instanceof PDFArray
    ? contents.asArray().map(ref => doc.context.lookup(ref))
    : [contents];
  return streams
    .filter(s => s instanceof PDFRawStream)
    .map(s => Buffer.from(decodePDFRawStream(s).decode()).toString('latin1'))
    .join('\n');
}

/**
 * Every drawn element on a page as a box: text origins (Tm), rectangles
 * (pdf-lib draws them as a translate + a closed path) and images (a
 * translate + a scale matrix + Do), all in page points.
 */
function drawnBoxes(content) {
  const boxes = [];
  for (const m of content.matchAll(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm/g)) {
    boxes.push({ kind: 'text', x: +m[1], y: +m[2], w: 0, h: 0 });
  }
  for (const block of content.split(/\bq\b/)) {
    const t = block.match(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm/);
    if (!t) continue;
    const x = +t[1]; const y = +t[2];
    const img = block.match(/(-?[\d.]+) 0 0 (-?[\d.]+) 0 0 cm\s+\/\S+ Do/);
    if (img) { boxes.push({ kind: 'image', x, y, w: +img[1], h: +img[2] }); continue; }
    const rect = block.match(/0 0 m\s+0 (-?[\d.]+) l\s+(-?[\d.]+) [\d.-]+ l\s+[\d.-]+ 0 l\s+h/);
    if (rect) boxes.push({ kind: 'rect', x, y, w: +rect[2], h: +rect[1] });
  }
  return boxes;
}

const fontSizes = content => [...content.matchAll(/\/\S+ (-?[\d.]+) Tf/g)].map(m => +m[1]);
const hasImages = content => /\/\S+ Do/.test(content);

function spreadEntries(n) {
  return Array.from({ length: n }, (_, i) => ({ type: 'spread', spread: i + 1, captionText: `Line ${i + 1}.` }));
}

const upsellCovers = [0, 1, 2, 3].map(index => ({ index, title: `Story ${index}`, styleLabel: 'watercolor' }));

describe('Lulu geometry constants', () => {
  test('bleed is 0.125" and the safety inset covers Lulu\'s 0.5" margin + 0.2" gutter', () => {
    expect(BLEED).toBe(9);
    expect(SAFE - BLEED).toBeGreaterThanOrEqual((LULU.GUIDELINES.safetyIn + LULU.GUIDELINES.gutterIn) * 72);
    expect(SAFE).toBe(60);
  });
});

describe('upsell spread card geometry', () => {
  test('both cards, their labels and the footer sit inside the safety inset on both pages', () => {
    for (const cardsTopY of [PH - SAFE, PH - SAFE - 60]) {
      const l = computeUpsellCardLayout({ pw: PW, ph: PH, cardsTopY });
      expect(l.fits).toBe(true);
      expect(l.footerY).toBe(SAFE);
      expect(l.offsetY).toBeGreaterThan(SAFE + 7); // the footer's 7pt type clears the cards
      for (const i of [0, 1]) {
        expect(l.cardX(i)).toBeGreaterThanOrEqual(SAFE);
        expect(l.cardX(i) + l.cardW).toBeLessThanOrEqual(PW - SAFE);
      }
      expect(l.coverY + l.coverH).toBeLessThanOrEqual(cardsTopY);
      expect(l.coverY + l.coverH).toBeLessThanOrEqual(PH - SAFE);
    }
  });

  test('a header too tall for the cards is reported, never silently overflowed', () => {
    expect(computeUpsellCardLayout({ pw: PW, ph: PH, cardsTopY: 300 }).fits).toBe(false);
  });
});

describe('assemblePdf against the Lulu interior guidelines', () => {
  let doc;
  beforeAll(async () => {
    const buf = await assemblePdf(spreadEntries(12), 'picture_book', {
      title: 'Amit and the Star Map', childName: 'Amit', bookId: 'book-1', upsellCovers, minPages: 32,
    });
    doc = await PDFDocument.load(buf);
  });

  test('every page is trim + bleed and the count is Lulu\'s even 32 minimum', () => {
    expect(doc.getPageCount()).toBe(32);
    for (const page of doc.getPages()) {
      expect(page.getWidth()).toBe(PW);
      expect(page.getHeight()).toBe(PH);
    }
  });

  test('the upsell spread opens on a VERSO (even page number) so its two pages face each other', () => {
    // p1 blank, p2 dedication, p3 title, p4–27 story, p28 closing ("The
    // End" at 44pt) — then a blank recto 29 so the upsell is pages 30 + 31
    // (indices 29, 30): the header page carries the 18pt tagline and the
    // QR images, the second page the QR images alone.
    expect(fontSizes(pageContent(doc, 27))).toContain(44);
    expect(pageContent(doc, 28)).toBe('');
    expect(fontSizes(pageContent(doc, 29))).toContain(18);
    expect(hasImages(pageContent(doc, 29))).toBe(true);
    expect(fontSizes(pageContent(doc, 30))).not.toContain(18);
    expect(hasImages(pageContent(doc, 30))).toBe(true);
    expect(pageContent(doc, 31)).toBe('');
    const firstUpsellPageNumber = 29 + 1;
    expect(firstUpsellPageNumber % 2).toBe(0);
  });

  test('every drawn element of the upsell pages stays inside the safety inset', () => {
    for (const index of [29, 30]) {
      const boxes = drawnBoxes(pageContent(doc, index));
      expect(boxes.filter(b => b.kind === 'image').length).toBe(2); // the two QR codes
      expect(boxes.filter(b => b.kind === 'rect').length).toBeGreaterThan(0);
      expect(boxes.filter(b => b.kind === 'text').length).toBeGreaterThan(0);
      for (const b of boxes) {
        expect(b.x).toBeGreaterThanOrEqual(SAFE - 3);
        expect(b.y).toBeGreaterThanOrEqual(SAFE - 3);
        expect(b.x + b.w).toBeLessThanOrEqual(PW - SAFE + 3);
        expect(b.y + b.h).toBeLessThanOrEqual(PH - SAFE + 3);
      }
    }
  });

  test('the title page byline sits on the safety line, not in the trim zone', () => {
    const texts = drawnBoxes(pageContent(doc, 2)).filter(b => b.kind === 'text');
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) expect(t.y).toBeGreaterThanOrEqual(SAFE);
  });

  test('the preflight accepts the assembled interior', async () => {
    const r = await LULU.preflightPictureBook({ interiorPdf: Buffer.from(await doc.save()), bindingType: 'CHILDREN_PICTURE_BOOK' });
    expect(r.ok).toBe(true);
    expect(r.interior.fonts.other).toEqual([]);
    // The byline / footer face is the embedded Liberation Sans now; only
    // the upsell style label still rides the base-14 Helvetica-Bold.
    expect(r.interior.fonts.base14).toEqual(['Helvetica-Bold']);
  });
});

describe('pq-1 page report', () => {
  test('notePageSource turns a source width and the printed span into effective PPI', () => {
    const report = [];
    notePageSource(report, { page: 4, spread: 1, source: { width: 4096, height: 2304 }, spanIn: 17.5, role: 'spread-left' });
    notePageSource(report, { page: 6, spread: 2, source: { width: 1024, height: 576 }, spanIn: 17.5, role: 'half-right' });
    notePageSource(report, { page: 8, spread: 3, source: { width: 2048, height: 2048 }, spanIn: 8.75, role: 'square' });
    notePageSource(report, { page: 9, spread: 4, source: null, spanIn: 8.75, role: 'square' });
    expect(report.map(r => r.ppi)).toEqual([234, 59, 234, null]);
    expect(report[0]).toMatchObject({ page: 4, spread: 1, role: 'spread-left', spanIn: 17.5 });
    // A missing report array is a no-op, never a throw.
    expect(() => notePageSource(null, { page: 1, spread: 1, source: { width: 10, height: 10 }, spanIn: 1, role: 'square' })).not.toThrow();
  });

  test('assemblePdf fills opts.pageReport for every printed art page when the art is real', async () => {
    let sharp;
    try { sharp = require('sharp'); await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).png().toBuffer(); }
    catch { return; } // the sharp binary is not usable in this sandbox — the pure helper above covers the math
    const wide = await sharp({ create: { width: 1024, height: 576, channels: 3, background: '#8ab' } }).png().toBuffer();
    const square = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: '#a8b' } }).png().toBuffer();
    const pageReport = [];
    await assemblePdf([
      { type: 'spread', spread: 1, textLayout: 'half', captionText: 'One.', spreadIllustrationBuffer: wide },
      { type: 'spread', spread: 2, illustrationAspect: 'square', captionText: 'Two.', spreadIllustrationBuffer: square },
      { type: 'spread', spread: 3, captionText: 'Three.', spreadIllustrationBuffer: wide },
    ], 'picture_book', { title: 'T', childName: 'A', minPages: 8, pageReport });
    expect(pageReport.map(r => [r.role, r.ppi])).toEqual([
      ['half-right', 59], ['square', 234], ['spread-left', 59], ['spread-right', 59],
    ]);
    // Front matter is 3 pages: half → panel 4 + art 5; caption → text 6 + art 7; wide → 8 + 9.
    expect(pageReport.map(r => r.page)).toEqual([5, 7, 8, 9]);
  });
});

describe('assemblePdf without an upsell spread', () => {
  test('pads to the even 32 without inserting a parity blank', async () => {
    const buf = await assemblePdf(spreadEntries(12), 'picture_book', { title: 'T', childName: 'A', minPages: 32 });
    const d = await PDFDocument.load(buf);
    expect(d.getPageCount()).toBe(32);
    expect(fontSizes(pageContent(d, 27))).toContain(44);
    for (let i = 28; i < 32; i += 1) expect(pageContent(d, i)).toBe('');
  });
});
