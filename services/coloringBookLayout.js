'use strict';

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const PTS_PER_INCH = 72;
const PAGE_W_PT = 612;  // 8.5" at 72 dpi
const PAGE_H_PT = 792;  // 11" at 72 dpi

// ── Font paths (same location as layoutEngine) ─────────────────────────────
const FONT_DIR = path.join(__dirname, '..', 'fonts');
const FONT_PATHS = {
  bubblegum:      path.join(FONT_DIR, 'BubblegumSans-Regular.ttf'),
  playfair:       path.join(FONT_DIR, 'PlayfairDisplay.ttf'),
  playfairItalic: path.join(FONT_DIR, 'PlayfairDisplay-Italic.ttf'),
  dancing:        path.join(FONT_DIR, 'DancingScript.ttf'),
};

/**
 * Load fonts from the fonts directory (reuse fonts from layoutEngine).
 */
async function loadFonts(pdfDoc) {
  pdfDoc.registerFontkit(fontkit);
  const load = (p) => fs.existsSync(p) ? pdfDoc.embedFont(fs.readFileSync(p)) : null;
  const [bubblegum, playfair, playfairItalic, dancing, helv] = await Promise.all([
    load(FONT_PATHS.bubblegum),
    load(FONT_PATHS.playfair),
    load(FONT_PATHS.playfairItalic),
    load(FONT_PATHS.dancing),
    pdfDoc.embedFont(StandardFonts.Helvetica),
  ]);
  return { bubblegum, playfair, playfairItalic, dancing, helv };
}

function drawCenteredText(page, text, font, size, y, color = rgb(0.1, 0.1, 0.2)) {
  const w = font.widthOfTextAtSize(text, size);
  const pw = page.getWidth();
  page.drawText(text, { x: (pw - w) / 2, y, size, font, color });
}

/**
 * Build the cover page — "Coloring Edition" style.
 * If coverImageBuffer is provided, it is converted to B&W and used as the main visual.
 */
async function buildCover(pdfDoc, fonts, { title, childName, coverImageBuffer }) {
  const p = pdfDoc.addPage([PAGE_W_PT, PAGE_H_PT]);
  const titleFont = fonts.bubblegum || fonts.playfair || fonts.helv;
  const subFont = fonts.bubblegum || fonts.dancing || fonts.playfairItalic || fonts.helv;

  // Black background
  p.drawRectangle({ x: 0, y: 0, width: PAGE_W_PT, height: PAGE_H_PT, color: rgb(0.05, 0.05, 0.12) });

  if (coverImageBuffer) {
    // Convert cover to B&W (grayscale + threshold 150)
    const bwCover = await sharp(coverImageBuffer)
      .grayscale()
      .threshold(150)
      .png()
      .toBuffer();
    const pdfImage = await pdfDoc.embedPng(bwCover);
    // Center the image in the middle portion of the page
    const imgArea = { w: PAGE_W_PT - 80, h: 440 };
    const imgY = (PAGE_H_PT - imgArea.h) / 2 + 20;
    p.drawImage(pdfImage, { x: 40, y: imgY, width: imgArea.w, height: imgArea.h });
  }

  // Title — large, upper area
  const titleStr = title.toUpperCase();
  const titleSz = 28;
  const titleWords = titleStr.split(' ');
  const maxW = PAGE_W_PT - 80;
  let lines = []; let cur = '';
  for (const w of titleWords) {
    const t = cur ? `${cur} ${w}` : w;
    if (titleFont.widthOfTextAtSize(t, titleSz) > maxW && cur) { lines.push(cur); cur = w; }
    else cur = t;
  }
  if (cur) lines.push(cur);

  const lineH = titleSz * 1.35;
  let y = PAGE_H_PT - 60;
  for (const line of lines) {
    drawCenteredText(p, line, titleFont, titleSz, y, rgb(1, 1, 1));
    y -= lineH;
  }

  // "COLORING EDITION" subtitle
  drawCenteredText(p, 'COLORING EDITION', titleFont, 18, y - 10, rgb(0.75, 0.55, 0.1));

  // Personalized subtitle at bottom area
  const sub = `A personalized coloring book for ${childName || 'You'}`;
  drawCenteredText(p, sub, subFont, 14, 80, rgb(0.8, 0.8, 0.85));

  // Bottom branding
  drawCenteredText(p, 'BY GIFTMYBOOK', fonts.helv, 10, 50, rgb(0.5, 0.5, 0.55));
}

/**
 * Embed a coloring page image on a fixed 612×792 page with title band at bottom.
 * Forces pure black-and-white output: grayscale + threshold.
 * @param {PDFDocument} pdfDoc
 * @param {Buffer} imageBuffer
 * @param {string} [title] - page title shown in bottom band
 * @param {number} [pageNumber] - page number shown in bottom band
 * @param {object} [fonts] - { bangersFont } for title rendering
 */
async function addColoringPage(pdfDoc, imageBuffer, title, pageNumber, fonts) {
  const processed = await sharp(imageBuffer)
    .grayscale()
    .threshold(150)
    .png()
    .toBuffer();

  const pdfImage = await pdfDoc.embedPng(processed);
  const p = pdfDoc.addPage([PAGE_W_PT, PAGE_H_PT]);

  // Image fills area above title band: y=48 to y=776 (728pt tall), full width
  p.drawImage(pdfImage, { x: 0, y: 48, width: PAGE_W_PT, height: 728 });

  // Dark navy banner at bottom
  p.drawRectangle({ x: 0, y: 16, width: PAGE_W_PT, height: 32, color: rgb(0.06, 0.07, 0.14) });

  const bangersFont = fonts?.bangersFont;
  if (bangersFont) {
    // Title text centered, 11pt white
    const titleStr = title ? title.toUpperCase() : '';
    if (titleStr) {
      const tw = bangersFont.widthOfTextAtSize(titleStr, 11);
      p.drawText(titleStr, { x: (PAGE_W_PT - tw) / 2, y: 26, size: 11, font: bangersFont, color: rgb(1, 1, 1) });
    }
    // Page number right-aligned in the band
    if (pageNumber) {
      const numStr = String(pageNumber);
      const nw = bangersFont.widthOfTextAtSize(numStr, 9);
      p.drawText(numStr, { x: PAGE_W_PT - 16 - nw, y: 27, size: 9, font: bangersFont, color: rgb(0.7, 0.7, 0.75) });
    }
  }
}

/**
 * Build the back cover page.
 */
function buildBackCover(pdfDoc, fonts, { childName }) {
  const p = pdfDoc.addPage([PAGE_W_PT, PAGE_H_PT]);
  const navy = rgb(0.1, 0.12, 0.25);
  const gold = rgb(0.75, 0.55, 0.1);
  const titleFont = fonts.bubblegum || fonts.playfairItalic || fonts.playfair || fonts.helv;
  const subFont = fonts.bubblegum || fonts.dancing || fonts.helv;

  p.drawRectangle({ x: 0, y: 0, width: PAGE_W_PT, height: PAGE_H_PT, color: rgb(1, 1, 1) });
  p.drawRectangle({ x: 0, y: PAGE_H_PT - 36, width: PAGE_W_PT, height: 36, color: navy });
  p.drawRectangle({ x: 0, y: 0, width: PAGE_W_PT, height: 36, color: navy });

  const mid = PAGE_H_PT / 2;
  drawCenteredText(p, 'Colored by', titleFont, 22, mid + 40, navy);

  p.drawLine({ start: { x: 100, y: mid }, end: { x: PAGE_W_PT - 100, y: mid }, thickness: 1, color: rgb(0.6, 0.6, 0.6) });

  drawCenteredText(p, childName ? `${childName}'s Masterpiece` : 'My Masterpiece', subFont, 16, mid - 30, gold);
  drawCenteredText(p, 'GiftMyBook.com', fonts.helv, 10, 50, rgb(0.7, 0.7, 0.7));
}

/**
 * Add a "Design Your Own Adventure" blank page at the end.
 */
function addDesignYourOwnPage(pdfDoc, childName, bangersFont) {
  const page = pdfDoc.addPage([PAGE_W_PT, PAGE_H_PT]);
  // White background
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W_PT, height: PAGE_H_PT, color: rgb(1, 1, 1) });

  // Outer decorative border
  page.drawRectangle({ x: 24, y: 24, width: 564, height: 744, borderColor: rgb(0, 0, 0), borderWidth: 3, color: rgb(1, 1, 1) });

  // Inner thin border
  page.drawRectangle({ x: 32, y: 32, width: 548, height: 728, borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 1, color: rgb(1, 1, 1) });

  // Top title
  const diyTitle = 'DRAW YOUR OWN ADVENTURE!';
  const titleSize = 22;
  const tw = bangersFont.widthOfTextAtSize(diyTitle, titleSize);
  page.drawText(diyTitle, { x: (PAGE_W_PT - tw) / 2, y: 720, size: titleSize, font: bangersFont, color: rgb(0.05, 0.05, 0.12) });

  // Child name subtitle
  const sub = `${childName || 'Your'}'s creation`;
  const subSize = 12;
  const sw = bangersFont.widthOfTextAtSize(sub, subSize);
  page.drawText(sub, { x: (PAGE_W_PT - sw) / 2, y: 698, size: subSize, font: bangersFont, color: rgb(0.3, 0.3, 0.35) });

  // Bottom note
  const note = 'BY GIFTMYBOOK';
  const noteSize = 8;
  const noteW = bangersFont.widthOfTextAtSize(note, noteSize);
  page.drawText(note, { x: (PAGE_W_PT - noteW) / 2, y: 36, size: noteSize, font: bangersFont, color: rgb(0.5, 0.5, 0.55) });
}

/**
 * Assemble the full coloring book PDF.
 * @param {Array<{buffer: Buffer|null, success: boolean, title?: string}>} pages
 * @param {{ title?: string, childName?: string, pagesOnly?: boolean, coverImageBuffer?: Buffer }} opts
 * @returns {Promise<Buffer>} PDF bytes
 */
async function buildColoringBookPdf(pages, opts = {}) {
  const { title = 'My Coloring Book', childName = '', pagesOnly = false, coverImageBuffer } = opts;

  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`${title} — Coloring Book`);
  pdfDoc.setAuthor('GiftMyBook');

  let fonts;
  let bangersFont;
  if (!pagesOnly) {
    fonts = await loadFonts(pdfDoc);
    bangersFont = fonts.bubblegum || fonts.playfair || fonts.helv;
    await buildCover(pdfDoc, fonts, { title, childName, coverImageBuffer });
  } else {
    fonts = await loadFonts(pdfDoc);
    bangersFont = fonts.bubblegum || fonts.playfair || fonts.helv;
  }

  let pageIndex = 0;
  for (const page of pages) {
    if (page.buffer) {
      pageIndex++;
      await addColoringPage(pdfDoc, page.buffer, page.title, pageIndex, { bangersFont });
    }
  }

  if (!pagesOnly) {
    addDesignYourOwnPage(pdfDoc, childName, bangersFont);
    buildBackCover(pdfDoc, fonts, { childName });
  }

  return Buffer.from(await pdfDoc.save());
}

module.exports = { buildColoringBookPdf };
