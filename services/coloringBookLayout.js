'use strict';

const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const PTS_PER_INCH = 72;
const PAGE_W_PT = 612;  // 8.5" at 72 dpi
const PAGE_H_PT = 792;  // 11" at 72 dpi

// Lulu bleed dimensions
const BLEED = 0.125 * PTS_PER_INCH;  // 9pt = 0.125"
const INTERIOR_W_PT = PAGE_W_PT + BLEED * 2;  // 8.75" = 630pt
const INTERIOR_H_PT = PAGE_H_PT + BLEED * 2;  // 11.25" = 810pt
const SAFETY_MARGIN = 0.5 * PTS_PER_INCH;     // 36pt = 0.5"

// Cover wrap dimensions (saddle stitch — no spine)
const COVER_W_PT = (8.5 * 2 + 0.125 * 2) * PTS_PER_INCH;  // 17.25" = 1242pt
const COVER_H_PT = INTERIOR_H_PT;  // 11.25" = 810pt
const COVER_HALF_W = 8.5 * PTS_PER_INCH;  // 612pt — each half before bleed

// ── Font paths (same location as layoutEngine) ─────────────────────────────
const FONT_DIR = path.join(__dirname, '..', 'fonts');
const FONT_PATHS = {
  bubblegum:      path.join(FONT_DIR, 'BubblegumSans-Regular.ttf'),
  playfair:       path.join(FONT_DIR, 'PlayfairDisplay.ttf'),
  playfairItalic: path.join(FONT_DIR, 'PlayfairDisplay-Italic.ttf'),
  dancing:        path.join(FONT_DIR, 'DancingScript.ttf'),
  helv:           path.join(FONT_DIR, 'LiberationSans-Regular.ttf'),
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
    load(FONT_PATHS.helv),
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
 * If frontCoverBuffer (AI art) is provided, it is used as a full-bleed background.
 * Falls back to old B&W style if only coverImageBuffer is available.
 */
async function buildCover(pdfDoc, fonts, { title, childName, coverImageBuffer, frontCoverBuffer }) {
  const p = pdfDoc.addPage([PAGE_W_PT, PAGE_H_PT]);
  const titleFont = fonts.bubblegum || fonts.playfair || fonts.helv;
  const subFont = fonts.bubblegum || fonts.dancing || fonts.playfairItalic || fonts.helv;
  const centerX = PAGE_W_PT / 2;

  if (frontCoverBuffer) {
    // ── AI-generated full-bleed background ──
    try {
      const coverPng = await sharp(frontCoverBuffer).png().toBuffer();
      const pdfImage = await pdfDoc.embedPng(coverPng);
      p.drawImage(pdfImage, { x: 0, y: 0, width: PAGE_W_PT, height: PAGE_H_PT });
    } catch (err) {
      console.warn(`[buildCover] Could not embed AI front cover: ${err.message}`);
      p.drawRectangle({ x: 0, y: 0, width: PAGE_W_PT, height: PAGE_H_PT, color: rgb(0.05, 0.05, 0.12) });
    }

    // Title text overlay with shadow
    const titleStr = title.toUpperCase();
    const titleSz = 28;
    const maxW = PAGE_W_PT - 80;
    const titleWords = titleStr.split(' ');
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
      drawCenteredTextWithShadow(p, line, titleFont, titleSz, y, rgb(1, 1, 1), centerX);
      y -= lineH;
    }

    drawCenteredTextWithShadow(p, 'COLORING EDITION', titleFont, 18, y - 10, rgb(1, 0.9, 0.5), centerX);

    const sub = `A personalized coloring book for ${childName || 'You'}`;
    drawCenteredTextWithShadow(p, sub, subFont, 14, 80, rgb(1, 1, 1), centerX);
    drawCenteredTextWithShadow(p, 'BY GIFTMYBOOK', fonts.helv, 10, 50, rgb(1, 1, 0.9), centerX);

  } else {
    // ── Fallback: old programmatic cover ──
    p.drawRectangle({ x: 0, y: 0, width: PAGE_W_PT, height: PAGE_H_PT, color: rgb(0.05, 0.05, 0.12) });

    if (coverImageBuffer) {
      const bwCover = await sharp(coverImageBuffer)
        .grayscale().threshold(150).png().toBuffer();
      const pdfImage = await pdfDoc.embedPng(bwCover);
      const imgArea = { w: PAGE_W_PT - 80, h: 440 };
      const imgY = (PAGE_H_PT - imgArea.h) / 2 + 20;
      p.drawImage(pdfImage, { x: 40, y: imgY, width: imgArea.w, height: imgArea.h });
    }

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

    drawCenteredText(p, 'COLORING EDITION', titleFont, 18, y - 10, rgb(0.75, 0.55, 0.1));

    const sub = `A personalized coloring book for ${childName || 'You'}`;
    drawCenteredText(p, sub, subFont, 14, 80, rgb(0.8, 0.8, 0.85));
    drawCenteredText(p, 'BY GIFTMYBOOK', fonts.helv, 10, 50, rgb(0.5, 0.5, 0.55));
  }
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

// ── Interior PDF helpers (Lulu bleed pages) ────────────────────────────────

/**
 * Add a coloring page to the interior PDF with bleed margins.
 * Page size: 8.75"×11.25" (trim 8.5"×11" + 0.125" bleed).
 */
async function addInteriorColoringPage(pdfDoc, imageBuffer, title, pageNumber, fonts) {
  const processed = await sharp(imageBuffer)
    .grayscale()
    .threshold(150)
    .png()
    .toBuffer();

  const pdfImage = await pdfDoc.embedPng(processed);
  const p = pdfDoc.addPage([INTERIOR_W_PT, INTERIOR_H_PT]);

  // White background (ensures bleed area is white)
  p.drawRectangle({ x: 0, y: 0, width: INTERIOR_W_PT, height: INTERIOR_H_PT, color: rgb(1, 1, 1) });

  // Image area: full bleed page minus bottom band area
  // Bottom band sits at BLEED+16 to BLEED+48 (same as legacy but shifted by bleed)
  const bandTop = BLEED + 48;
  const imgY = bandTop;
  const imgH = INTERIOR_H_PT - BLEED - imgY;  // from band top to bleed top
  p.drawImage(pdfImage, { x: BLEED, y: imgY, width: INTERIOR_W_PT - BLEED * 2, height: imgH });

  // Dark navy banner at bottom (within trim area)
  p.drawRectangle({ x: BLEED, y: BLEED + 16, width: INTERIOR_W_PT - BLEED * 2, height: 32, color: rgb(0.06, 0.07, 0.14) });

  const bangersFont = fonts?.bangersFont;
  if (bangersFont) {
    const titleStr = title ? title.toUpperCase() : '';
    if (titleStr) {
      const tw = bangersFont.widthOfTextAtSize(titleStr, 11);
      p.drawText(titleStr, { x: (INTERIOR_W_PT - tw) / 2, y: BLEED + 26, size: 11, font: bangersFont, color: rgb(1, 1, 1) });
    }
    if (pageNumber) {
      const numStr = String(pageNumber);
      const nw = bangersFont.widthOfTextAtSize(numStr, 9);
      p.drawText(numStr, { x: INTERIOR_W_PT - BLEED - 16 - nw, y: BLEED + 27, size: 9, font: bangersFont, color: rgb(0.7, 0.7, 0.75) });
    }
  }
}

/**
 * Add a title page to the interior PDF (with bleed).
 */
function addInteriorTitlePage(pdfDoc, fonts, { title, childName }) {
  const p = pdfDoc.addPage([INTERIOR_W_PT, INTERIOR_H_PT]);
  const titleFont = fonts.bubblegum || fonts.playfair || fonts.helv;
  const subFont = fonts.bubblegum || fonts.dancing || fonts.playfairItalic || fonts.helv;

  p.drawRectangle({ x: 0, y: 0, width: INTERIOR_W_PT, height: INTERIOR_H_PT, color: rgb(1, 1, 1) });

  // Title centered in upper half
  const titleStr = title.toUpperCase();
  const titleSz = 28;
  const maxW = INTERIOR_W_PT - SAFETY_MARGIN * 2 - BLEED * 2;
  const titleWords = titleStr.split(' ');
  const lines = []; let cur = '';
  for (const w of titleWords) {
    const t = cur ? `${cur} ${w}` : w;
    if (titleFont.widthOfTextAtSize(t, titleSz) > maxW && cur) { lines.push(cur); cur = w; }
    else cur = t;
  }
  if (cur) lines.push(cur);

  const lineH = titleSz * 1.35;
  let y = INTERIOR_H_PT / 2 + lineH * lines.length / 2 + 40;
  for (const line of lines) {
    const lw = titleFont.widthOfTextAtSize(line, titleSz);
    p.drawText(line, { x: (INTERIOR_W_PT - lw) / 2, y, size: titleSz, font: titleFont, color: rgb(0.1, 0.1, 0.2) });
    y -= lineH;
  }

  // "COLORING EDITION"
  const ceText = 'COLORING EDITION';
  const ceW = titleFont.widthOfTextAtSize(ceText, 18);
  p.drawText(ceText, { x: (INTERIOR_W_PT - ceW) / 2, y: y - 10, size: 18, font: titleFont, color: rgb(0.4, 0.4, 0.45) });

  // Personalized subtitle
  const sub = `A personalized coloring book for ${childName || 'You'}`;
  const subW = subFont.widthOfTextAtSize(sub, 14);
  p.drawText(sub, { x: (INTERIOR_W_PT - subW) / 2, y: BLEED + SAFETY_MARGIN + 60, size: 14, font: subFont, color: rgb(0.4, 0.4, 0.45) });

  // Branding
  const brand = 'BY GIFTMYBOOK';
  const brandW = fonts.helv.widthOfTextAtSize(brand, 10);
  p.drawText(brand, { x: (INTERIOR_W_PT - brandW) / 2, y: BLEED + SAFETY_MARGIN + 30, size: 10, font: fonts.helv, color: rgb(0.6, 0.6, 0.65) });
}

/**
 * Add a "Draw Your Own" blank page to the interior PDF (with bleed).
 */
function addInteriorDesignYourOwnPage(pdfDoc, childName, bangersFont) {
  const p = pdfDoc.addPage([INTERIOR_W_PT, INTERIOR_H_PT]);
  p.drawRectangle({ x: 0, y: 0, width: INTERIOR_W_PT, height: INTERIOR_H_PT, color: rgb(1, 1, 1) });

  // Decorative borders (shifted for bleed)
  const outerX = BLEED + 24;
  const outerY = BLEED + 24;
  const outerW = INTERIOR_W_PT - BLEED * 2 - 48;
  const outerH = INTERIOR_H_PT - BLEED * 2 - 48;
  p.drawRectangle({ x: outerX, y: outerY, width: outerW, height: outerH, borderColor: rgb(0, 0, 0), borderWidth: 3, color: rgb(1, 1, 1) });
  p.drawRectangle({ x: outerX + 8, y: outerY + 8, width: outerW - 16, height: outerH - 16, borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 1, color: rgb(1, 1, 1) });

  const diyTitle = 'DRAW YOUR OWN ADVENTURE!';
  const titleSize = 22;
  const tw = bangersFont.widthOfTextAtSize(diyTitle, titleSize);
  p.drawText(diyTitle, { x: (INTERIOR_W_PT - tw) / 2, y: INTERIOR_H_PT - BLEED - 72, size: titleSize, font: bangersFont, color: rgb(0.05, 0.05, 0.12) });

  const sub = `${childName || 'Your'}'s creation`;
  const subSize = 12;
  const sw = bangersFont.widthOfTextAtSize(sub, subSize);
  p.drawText(sub, { x: (INTERIOR_W_PT - sw) / 2, y: INTERIOR_H_PT - BLEED - 94, size: subSize, font: bangersFont, color: rgb(0.3, 0.3, 0.35) });

  const note = 'BY GIFTMYBOOK';
  const noteSize = 8;
  const noteW = bangersFont.widthOfTextAtSize(note, noteSize);
  p.drawText(note, { x: (INTERIOR_W_PT - noteW) / 2, y: BLEED + 36, size: noteSize, font: bangersFont, color: rgb(0.5, 0.5, 0.55) });
}

/**
 * Add a back matter page to the interior PDF (with bleed).
 */
function addInteriorBackMatterPage(pdfDoc, fonts, { childName }) {
  const p = pdfDoc.addPage([INTERIOR_W_PT, INTERIOR_H_PT]);
  const titleFont = fonts.bubblegum || fonts.playfairItalic || fonts.playfair || fonts.helv;
  const subFont = fonts.bubblegum || fonts.dancing || fonts.helv;

  p.drawRectangle({ x: 0, y: 0, width: INTERIOR_W_PT, height: INTERIOR_H_PT, color: rgb(1, 1, 1) });

  const mid = INTERIOR_H_PT / 2;
  const textCb = 'Colored by';
  const cbW = titleFont.widthOfTextAtSize(textCb, 22);
  p.drawText(textCb, { x: (INTERIOR_W_PT - cbW) / 2, y: mid + 40, size: 22, font: titleFont, color: rgb(0.1, 0.12, 0.25) });

  p.drawLine({ start: { x: 100 + BLEED, y: mid }, end: { x: INTERIOR_W_PT - 100 - BLEED, y: mid }, thickness: 1, color: rgb(0.6, 0.6, 0.6) });

  const masterpiece = childName ? `${childName}'s Masterpiece` : 'My Masterpiece';
  const mW = subFont.widthOfTextAtSize(masterpiece, 16);
  p.drawText(masterpiece, { x: (INTERIOR_W_PT - mW) / 2, y: mid - 30, size: 16, font: subFont, color: rgb(0.75, 0.55, 0.1) });

  const brand = 'GiftMyBook.com';
  const bW = fonts.helv.widthOfTextAtSize(brand, 10);
  p.drawText(brand, { x: (INTERIOR_W_PT - bW) / 2, y: BLEED + SAFETY_MARGIN, size: 10, font: fonts.helv, color: rgb(0.7, 0.7, 0.7) });
}

/**
 * Build the Lulu-compatible interior PDF (no cover, with bleed).
 * Pages: title page + coloring pages + "Draw Your Own" + back matter = 20 pages.
 * Page size: 8.75"×11.25" (8.5"×11" trim + 0.125" bleed each side).
 * @param {Array<{buffer: Buffer|null, success: boolean, title?: string}>} pages
 * @param {{ title?: string, childName?: string }} opts
 * @returns {Promise<Buffer>} PDF bytes
 */
async function buildInteriorPdf(pages, opts = {}) {
  const { title = 'My Coloring Book', childName = '' } = opts;

  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`${title} — Coloring Book (Interior)`);
  pdfDoc.setAuthor('GiftMyBook');

  const fonts = await loadFonts(pdfDoc);
  const bangersFont = fonts.bubblegum || fonts.playfair || fonts.helv;

  // 1. Title page
  addInteriorTitlePage(pdfDoc, fonts, { title, childName });

  // 2. Coloring pages
  let pageIndex = 0;
  for (const page of pages) {
    if (page.buffer) {
      pageIndex++;
      await addInteriorColoringPage(pdfDoc, page.buffer, page.title, pageIndex, { bangersFont });
    }
  }

  // 3. Draw Your Own page
  addInteriorDesignYourOwnPage(pdfDoc, childName, bangersFont);

  // 4. Back matter page
  addInteriorBackMatterPage(pdfDoc, fonts, { childName });

  return Buffer.from(await pdfDoc.save());
}

// ── Cover wrap PDF (Lulu saddle stitch) ─────────────────────────────────────

/**
 * Draw text with a subtle shadow/outline for readability over illustrations.
 * Draws the text twice: once offset in dark color (shadow), then the main text on top.
 */
function drawTextWithShadow(page, text, font, size, x, y, color, shadowColor = rgb(0, 0, 0)) {
  const shadowOffset = Math.max(1, Math.round(size / 20));
  // Shadow (dark, slightly offset)
  page.drawText(text, { x: x + shadowOffset, y: y - shadowOffset, size, font, color: shadowColor, opacity: 0.4 });
  // Main text
  page.drawText(text, { x, y, size, font, color });
}

/**
 * Draw centered text with shadow for readability over illustrations.
 */
function drawCenteredTextWithShadow(page, text, font, size, y, color, centerX) {
  const w = font.widthOfTextAtSize(text, size);
  const x = centerX - w / 2;
  drawTextWithShadow(page, text, font, size, x, y, color);
}

/**
 * Build wrap-around cover PDF for Lulu saddle stitch printing.
 * Layout: back cover (left) + front cover (right), no spine.
 * Total size: 17.25"×11.25".
 * @param {{ title?: string, childName?: string, frontCoverBuffer?: Buffer, backCoverBuffer?: Buffer, coverImageBuffer?: Buffer }} opts
 * @returns {Promise<Buffer>} PDF bytes
 */
async function buildCoverWrapPdf(opts = {}) {
  const { title = 'My Coloring Book', childName = '', frontCoverBuffer, backCoverBuffer, coverImageBuffer } = opts;

  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`${title} — Cover`);
  pdfDoc.setAuthor('GiftMyBook');

  const fonts = await loadFonts(pdfDoc);
  const titleFont = fonts.bubblegum || fonts.playfair || fonts.helv;
  const subFont = fonts.bubblegum || fonts.dancing || fonts.playfairItalic || fonts.helv;

  const p = pdfDoc.addPage([COVER_W_PT, COVER_H_PT]);

  // ── Layout coordinates ──
  const frontX = BLEED + COVER_HALF_W;  // right half starts here
  const frontW = COVER_HALF_W + BLEED;  // includes right bleed
  const frontCenterX = BLEED + COVER_HALF_W + COVER_HALF_W / 2;
  const backCenterX = BLEED + COVER_HALF_W / 2;

  const hasAiCovers = frontCoverBuffer && backCoverBuffer;

  if (hasAiCovers) {
    // ── AI-generated cover art as full-bleed backgrounds ──

    // Embed front cover image on right half (full bleed)
    try {
      const frontPng = await sharp(frontCoverBuffer).png().toBuffer();
      const frontImg = await pdfDoc.embedPng(frontPng);
      p.drawImage(frontImg, { x: frontX, y: 0, width: frontW, height: COVER_H_PT });
    } catch (err) {
      console.warn(`[coverWrap] Could not embed front cover AI image: ${err.message}`);
      // Fallback: solid color
      p.drawRectangle({ x: frontX, y: 0, width: frontW, height: COVER_H_PT, color: rgb(1, 0.92, 0.6) });
    }

    // Embed back cover image on left half (full bleed)
    try {
      const backPng = await sharp(backCoverBuffer).png().toBuffer();
      const backImg = await pdfDoc.embedPng(backPng);
      p.drawImage(backImg, { x: 0, y: 0, width: BLEED + COVER_HALF_W, height: COVER_H_PT });
    } catch (err) {
      console.warn(`[coverWrap] Could not embed back cover AI image: ${err.message}`);
      p.drawRectangle({ x: 0, y: 0, width: BLEED + COVER_HALF_W, height: COVER_H_PT, color: rgb(1, 0.95, 0.78) });
    }

    // ── Front cover text overlay (pdf-lib, with shadow for readability) ──

    // Title at top (word-wrap if needed)
    const titleStr = title.toUpperCase();
    const titleSz = 32;
    const maxTitleW = COVER_HALF_W - SAFETY_MARGIN * 2;
    const titleWords = titleStr.split(' ');
    const titleLines = []; let curLine = '';
    for (const w of titleWords) {
      const t = curLine ? `${curLine} ${w}` : w;
      if (titleFont.widthOfTextAtSize(t, titleSz) > maxTitleW && curLine) { titleLines.push(curLine); curLine = w; }
      else curLine = t;
    }
    if (curLine) titleLines.push(curLine);

    const lineH = titleSz * 1.35;
    let y = COVER_H_PT - BLEED - SAFETY_MARGIN - 40;
    for (const line of titleLines) {
      drawCenteredTextWithShadow(p, line, titleFont, titleSz, y, rgb(1, 1, 1), frontCenterX);
      y -= lineH;
    }

    // "Coloring Book" subtitle
    drawCenteredTextWithShadow(p, 'Coloring Book', titleFont, 24, y - 8, rgb(1, 0.95, 0.7), frontCenterX);

    // Child's name
    const nameStr = childName ? `A personalized book for ${childName}` : '';
    if (nameStr) {
      drawCenteredTextWithShadow(p, nameStr, subFont, 16, BLEED + SAFETY_MARGIN + 60, rgb(1, 1, 1), frontCenterX);
    }

    // GiftMyBook branding at bottom of front
    drawCenteredTextWithShadow(p, 'GiftMyBook.com', fonts.helv, 9, BLEED + SAFETY_MARGIN + 14, rgb(1, 1, 0.9), frontCenterX);

    // ── Back cover text overlay ──

    // "Made with love for {childName}" centered on back
    const loveStr = `Made with love for ${childName || 'You'}`;
    drawCenteredTextWithShadow(p, loveStr, subFont, 20, COVER_H_PT / 2 + 20, rgb(1, 1, 1), backCenterX);

    // GiftMyBook branding on back
    drawCenteredTextWithShadow(p, 'GiftMyBook.com', fonts.helv, 12, COVER_H_PT / 2 - 30, rgb(1, 1, 0.9), backCenterX);

  } else {
    // ── Fallback: old programmatic cover (no AI art available) ──
    p.drawRectangle({ x: 0, y: 0, width: COVER_W_PT, height: COVER_H_PT, color: rgb(1, 0.92, 0.6) });

    // Front cover (right half)
    const frameInset = SAFETY_MARGIN;
    const frameX = frontX + frameInset;
    const frameY = BLEED + frameInset;
    const frameW = COVER_HALF_W - frameInset * 2;
    const frameH = COVER_H_PT - BLEED * 2 - frameInset * 2;
    p.drawRectangle({ x: frameX, y: frameY, width: frameW, height: frameH, borderColor: rgb(0.95, 0.5, 0.15), borderWidth: 6, color: undefined });
    p.drawRectangle({ x: frameX + 10, y: frameY + 10, width: frameW - 20, height: frameH - 20, borderColor: rgb(0.2, 0.7, 0.7), borderWidth: 3, color: undefined });

    const nameStr = childName ? `${childName}'s` : 'My';
    const nameSz = 36;
    const nameW = titleFont.widthOfTextAtSize(nameStr, nameSz);
    p.drawText(nameStr, { x: frontCenterX - nameW / 2, y: COVER_H_PT - BLEED - SAFETY_MARGIN - 60, size: nameSz, font: titleFont, color: rgb(0.15, 0.15, 0.3) });

    const cbStr = 'Coloring Book';
    const cbSz = 28;
    const cbW = titleFont.widthOfTextAtSize(cbStr, cbSz);
    p.drawText(cbStr, { x: frontCenterX - cbW / 2, y: COVER_H_PT - BLEED - SAFETY_MARGIN - 100, size: cbSz, font: titleFont, color: rgb(0.85, 0.35, 0.2) });

    if (coverImageBuffer) {
      try {
        const coverPng = await sharp(coverImageBuffer)
          .grayscale().threshold(150)
          .flatten({ background: { r: 255, g: 235, b: 153 } })
          .png().toBuffer();
        const pdfImage = await pdfDoc.embedPng(coverPng);
        const imgSize = 320;
        p.drawImage(pdfImage, { x: frontCenterX - imgSize / 2, y: (COVER_H_PT - imgSize) / 2 - 20, width: imgSize, height: imgSize });
      } catch (err) {
        console.warn(`[coverWrap] Could not embed cover image: ${err.message}`);
      }
    }

    const decorColors = [rgb(0.95,0.3,0.3), rgb(0.3,0.7,0.95), rgb(0.4,0.85,0.4), rgb(0.95,0.7,0.2), rgb(0.7,0.4,0.9)];
    const decorPositions = [
      { x: frontX + 30, y: COVER_H_PT - 60 }, { x: frontX + COVER_HALF_W - 40, y: COVER_H_PT - 80 },
      { x: frontX + 40, y: BLEED + 50 }, { x: frontX + COVER_HALF_W - 50, y: BLEED + 60 },
      { x: frontX + COVER_HALF_W / 2 - 120, y: COVER_H_PT - BLEED - SAFETY_MARGIN - 80 },
      { x: frontX + COVER_HALF_W / 2 + 120, y: COVER_H_PT - BLEED - SAFETY_MARGIN - 80 },
    ];
    for (let i = 0; i < decorPositions.length; i++) {
      const { x, y } = decorPositions[i];
      p.drawCircle({ x, y, size: 8 + (i % 3) * 3, color: decorColors[i % decorColors.length] });
    }

    const brandFront = 'GiftMyBook.com';
    const brandFW = fonts.helv.widthOfTextAtSize(brandFront, 9);
    p.drawText(brandFront, { x: frontCenterX - brandFW / 2, y: BLEED + SAFETY_MARGIN + 10, size: 9, font: fonts.helv, color: rgb(0.4, 0.4, 0.45) });

    // Back cover (left half)
    p.drawRectangle({ x: BLEED, y: BLEED, width: COVER_HALF_W, height: COVER_H_PT - BLEED * 2, color: rgb(1, 0.95, 0.78) });

    const loveStr = `Made with love for ${childName || 'You'}`;
    const loveSz = 20;
    const loveW = subFont.widthOfTextAtSize(loveStr, loveSz);
    p.drawText(loveStr, { x: backCenterX - loveW / 2, y: COVER_H_PT / 2 + 20, size: loveSz, font: subFont, color: rgb(0.2, 0.2, 0.35) });

    const brandBack = 'GiftMyBook.com';
    const brandBSz = 12;
    const brandBW = fonts.helv.widthOfTextAtSize(brandBack, brandBSz);
    p.drawText(brandBack, { x: backCenterX - brandBW / 2, y: COVER_H_PT / 2 - 30, size: brandBSz, font: fonts.helv, color: rgb(0.5, 0.5, 0.55) });
  }

  // Barcode clear area: bottom-right of back cover, 2"×1.2" (144×86.4pt)
  const barcodeW = 2 * PTS_PER_INCH;
  const barcodeH = 1.2 * PTS_PER_INCH;
  const barcodeX = BLEED + COVER_HALF_W - SAFETY_MARGIN - barcodeW;
  const barcodeY = BLEED + SAFETY_MARGIN;
  p.drawRectangle({ x: barcodeX, y: barcodeY, width: barcodeW, height: barcodeH, color: rgb(1, 1, 1) });

  return Buffer.from(await pdfDoc.save());
}

// ── PNG rendering helpers ───────────────────────────────────────────────────

/**
 * Convert a raw image buffer to a standardized preview PNG.
 * @param {Buffer} imageBuffer - Raw image buffer (any format sharp supports)
 * @param {number} [targetWidth=800] - Target width in pixels
 * @returns {Promise<Buffer>} PNG buffer
 */
async function imageToPreviewPng(imageBuffer, targetWidth = 800) {
  return sharp(imageBuffer)
    .resize(targetWidth, null, { fit: 'inside', withoutEnlargement: false })
    .png()
    .toBuffer();
}

/**
 * Generate a cover thumbnail PNG.
 * If frontCoverBuffer (AI art) is available, use it as the base and overlay text with sharp/SVG.
 * Otherwise falls back to old yellow-background style.
 * @param {{ title?: string, childName?: string, frontCoverBuffer?: Buffer, coverImageBuffer?: Buffer }} opts
 * @returns {Promise<Buffer>} PNG buffer (front cover only, ~600×776px)
 */
async function generateCoverThumbnailPng(opts = {}) {
  const { title = 'My Coloring Book', childName = '', frontCoverBuffer, coverImageBuffer } = opts;
  const width = 600;
  const height = 776;

  const layers = [];
  let composite;

  if (frontCoverBuffer) {
    // ── AI cover art as base ──
    try {
      const base = await sharp(frontCoverBuffer)
        .resize(width, height, { fit: 'cover' })
        .png()
        .toBuffer();
      composite = sharp(base);
    } catch (err) {
      console.warn(`[coverThumbnail] Could not process AI cover: ${err.message}`);
      composite = sharp({
        create: { width, height, channels: 4, background: { r: 255, g: 235, b: 153, alpha: 1 } }
      });
    }
  } else {
    // ── Fallback: old yellow background ──
    composite = sharp({
      create: { width, height, channels: 4, background: { r: 255, g: 235, b: 153, alpha: 1 } }
    });

    if (coverImageBuffer) {
      try {
        const coverImg = await sharp(coverImageBuffer)
          .grayscale().threshold(150)
          .flatten({ background: { r: 255, g: 235, b: 153 } })
          .resize(360, 360, { fit: 'inside' })
          .png().toBuffer();
        layers.push({ input: coverImg, top: Math.round((height - 360) / 2 + 10), left: Math.round((width - 360) / 2) });
      } catch (err) {
        console.warn(`[coverThumbnail] Could not process cover image: ${err.message}`);
      }
    }
  }

  // SVG text overlay (sharp composite — this is just a thumbnail, Sharp is OK here)
  const escapedName = (childName || 'My').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escapedTitle = (title || 'My Coloring Book').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Use white text with dark shadow when over AI art, dark text when over yellow
  const hasAi = !!frontCoverBuffer;
  const titleColor = hasAi ? '#FFFFFF' : '#26264D';
  const subColor = hasAi ? '#FFF3CC' : '#D95933';
  const brandColor = hasAi ? '#FFFFEE' : '#666670';
  const shadow = hasAi ? 'filter="url(#shadow)"' : '';
  const shadowDef = hasAi ? `<defs><filter id="shadow" x="-5%" y="-5%" width="115%" height="115%"><feDropShadow dx="1" dy="1" stdDeviation="2" flood-color="#000000" flood-opacity="0.6"/></filter></defs>` : '';

  const svgOverlay = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    ${shadowDef}
    <text x="${width / 2}" y="60" text-anchor="middle" font-family="sans-serif" font-size="24" font-weight="bold" fill="${titleColor}" ${shadow}>${escapedTitle}</text>
    <text x="${width / 2}" y="95" text-anchor="middle" font-family="sans-serif" font-size="36" font-weight="bold" fill="${titleColor}" ${shadow}>${escapedName}'s</text>
    <text x="${width / 2}" y="132" text-anchor="middle" font-family="sans-serif" font-size="28" font-weight="bold" fill="${subColor}" ${shadow}>Coloring Book</text>
    <text x="${width / 2}" y="${height - 30}" text-anchor="middle" font-family="sans-serif" font-size="12" fill="${brandColor}" ${shadow}>GiftMyBook.com</text>
  </svg>`);

  layers.push({ input: svgOverlay, top: 0, left: 0 });

  return composite.composite(layers).png().toBuffer();
}

/**
 * Assemble the full coloring book PDF.
 * @param {Array<{buffer: Buffer|null, success: boolean, title?: string}>} pages
 * @param {{ title?: string, childName?: string, pagesOnly?: boolean, coverImageBuffer?: Buffer, frontCoverBuffer?: Buffer }} opts
 * @returns {Promise<Buffer>} PDF bytes
 */
async function buildColoringBookPdf(pages, opts = {}) {
  const { title = 'My Coloring Book', childName = '', pagesOnly = false, coverImageBuffer, frontCoverBuffer } = opts;

  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`${title} — Coloring Book`);
  pdfDoc.setAuthor('GiftMyBook');

  let fonts;
  let bangersFont;
  if (!pagesOnly) {
    fonts = await loadFonts(pdfDoc);
    bangersFont = fonts.bubblegum || fonts.playfair || fonts.helv;
    await buildCover(pdfDoc, fonts, { title, childName, coverImageBuffer, frontCoverBuffer });
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

module.exports = {
  buildColoringBookPdf,
  buildInteriorPdf,
  buildCoverWrapPdf,
  generateCoverThumbnailPng,
  imageToPreviewPng,
};
