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

function drawCenteredText(page, text, font, size, y, color = rgb(0.1, 0.1, 0.2), centerX) {
  const w = font.widthOfTextAtSize(text, size);
  const cx = centerX != null ? centerX : page.getWidth() / 2;
  page.drawText(text, { x: cx - w / 2, y, size, font, color });
}

/**
 * Build the cover page — "Coloring Edition" style.
 * If frontCoverBuffer (AI art) is provided, it is used as a full-bleed background.
 * Falls back to old B&W style if only coverImageBuffer is available.
 */
async function buildCover(pdfDoc, fonts, { childName, coverImageBuffer, frontCoverBuffer }) {
  const p = pdfDoc.addPage([PAGE_W_PT, PAGE_H_PT]);
  const subFont = fonts.bubblegum || fonts.dancing || fonts.playfairItalic || fonts.helv;

  if (frontCoverBuffer) {
    // AI-generated pencil cover, full-bleed, no overlays — the parent cover's
    // title is already embedded in the pencil art so we do not add one here.
    try {
      const coverPng = await sharp(frontCoverBuffer).png().toBuffer();
      const pdfImage = await pdfDoc.embedPng(coverPng);
      p.drawImage(pdfImage, { x: 0, y: 0, width: PAGE_W_PT, height: PAGE_H_PT });
    } catch (err) {
      console.warn(`[buildCover] Could not embed AI front cover: ${err.message}`);
      p.drawRectangle({ x: 0, y: 0, width: PAGE_W_PT, height: PAGE_H_PT, color: rgb(1, 1, 1) });
    }
  } else {
    // Fallback only: minimal personalization line, no title overlay.
    p.drawRectangle({ x: 0, y: 0, width: PAGE_W_PT, height: PAGE_H_PT, color: rgb(1, 1, 1) });

    if (coverImageBuffer) {
      const bwCover = await sharp(coverImageBuffer)
        .grayscale().threshold(150).png().toBuffer();
      const pdfImage = await pdfDoc.embedPng(bwCover);
      const imgArea = { w: PAGE_W_PT - 80, h: 440 };
      const imgY = (PAGE_H_PT - imgArea.h) / 2;
      p.drawImage(pdfImage, { x: 40, y: imgY, width: imgArea.w, height: imgArea.h });
    }

    if (childName) {
      const sub = `A coloring book for ${childName}`;
      drawCenteredText(p, sub, subFont, 16, 80, rgb(0.2, 0.2, 0.3));
    }
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

  // Lulu saddle-stitch requires page count to be a multiple of 4, minimum 8
  const MIN_PAGES = 8;
  while (pdfDoc.getPageCount() < MIN_PAGES || pdfDoc.getPageCount() % 4 !== 0) {
    const blankPage = pdfDoc.addPage([INTERIOR_W_PT, INTERIOR_H_PT]);
    blankPage.drawRectangle({ x: 0, y: 0, width: INTERIOR_W_PT, height: INTERIOR_H_PT, color: rgb(1, 1, 1) });
  }

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
  // Only `subFont` is used now (for the programmatic fallback "A coloring
  // book for X" line). All title/header overlays were removed per product
  // requirement — the parent cover's title is already embedded in the
  // pencil front cover and we never print an ISBN/barcode.
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
    // No text overlays and no barcode clear-zone: the parent cover's title is
    // already embedded in the pencil front cover, and we intentionally do not
    // print an ISBN/barcode.

    // Embed front cover image on right half (full bleed)
    try {
      const frontPng = await sharp(frontCoverBuffer).png().toBuffer();
      const frontImg = await pdfDoc.embedPng(frontPng);
      p.drawImage(frontImg, { x: frontX, y: 0, width: frontW, height: COVER_H_PT });
    } catch (err) {
      console.warn(`[coverWrap] Could not embed front cover AI image: ${err.message}`);
      // Fallback: white background
      p.drawRectangle({ x: frontX, y: 0, width: frontW, height: COVER_H_PT, color: rgb(1, 1, 1) });
    }

    // Embed back cover image on left half (full bleed)
    try {
      const backPng = await sharp(backCoverBuffer).png().toBuffer();
      const backImg = await pdfDoc.embedPng(backPng);
      p.drawImage(backImg, { x: 0, y: 0, width: BLEED + COVER_HALF_W, height: COVER_H_PT });
    } catch (err) {
      console.warn(`[coverWrap] Could not embed back cover AI image: ${err.message}`);
      p.drawRectangle({ x: 0, y: 0, width: BLEED + COVER_HALF_W, height: COVER_H_PT, color: rgb(1, 1, 1) });
    }

  } else {
    // ── Fallback: programmatic cover (no AI art available) ──
    // Even on the fallback path we honor the "no added title" rule — only a
    // minimal personalization line is drawn so the PDF isn't completely blank.
    p.drawRectangle({ x: 0, y: 0, width: COVER_W_PT, height: COVER_H_PT, color: rgb(1, 1, 1) });

    // Front cover (right half): single line with the child's name, centered
    if (childName) {
      const nameStr = `A coloring book for ${childName}`;
      drawCenteredText(p, nameStr, subFont, 18, COVER_H_PT / 2, rgb(0.2, 0.2, 0.3), frontCenterX);
    }

    if (coverImageBuffer) {
      try {
        const coverPng = await sharp(coverImageBuffer)
          .grayscale().threshold(150)
          .flatten({ background: { r: 255, g: 255, b: 255 } })
          .png().toBuffer();
        const pdfImage = await pdfDoc.embedPng(coverPng);
        const imgSize = 320;
        p.drawImage(pdfImage, { x: frontCenterX - imgSize / 2, y: (COVER_H_PT - imgSize) / 2 - 40, width: imgSize, height: imgSize });
      } catch (err) {
        console.warn(`[coverWrap] Could not embed cover image: ${err.message}`);
      }
    }

    // Back cover (left half): intentionally blank — no title, no ISBN/barcode.
  }

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
 * Generate a cover thumbnail PNG of the front cover only.
 * When AI pencil cover art is available it is used directly (no text
 * overlays — the parent cover's title is already baked into the pencil
 * front cover). When no AI art is available, falls back to a plain white
 * canvas with the B&W cover image embedded and a tiny personalization line.
 *
 * @param {{ childName?: string, frontCoverBuffer?: Buffer, coverImageBuffer?: Buffer }} opts
 * @returns {Promise<Buffer>} PNG buffer (~600x776px)
 */
async function generateCoverThumbnailPng(opts = {}) {
  const { childName = '', frontCoverBuffer, coverImageBuffer } = opts;
  const width = 600;
  const height = 776;

  if (frontCoverBuffer) {
    // AI pencil cover already has everything it needs — just resize it.
    try {
      return await sharp(frontCoverBuffer)
        .resize(width, height, { fit: 'cover' })
        .png()
        .toBuffer();
    } catch (err) {
      console.warn(`[coverThumbnail] Could not process AI cover: ${err.message}`);
      // fall through to the programmatic fallback below
    }
  }

  // ── Fallback: white canvas, optional B&W image, optional tiny name line ──
  const layers = [];
  const composite = sharp({
    create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  });

  if (coverImageBuffer) {
    try {
      const coverImg = await sharp(coverImageBuffer)
        .grayscale().threshold(150)
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .resize(440, 440, { fit: 'inside' })
        .png().toBuffer();
      layers.push({ input: coverImg, top: Math.round((height - 440) / 2), left: Math.round((width - 440) / 2) });
    } catch (err) {
      console.warn(`[coverThumbnail] Could not process cover image: ${err.message}`);
    }
  }

  if (childName) {
    const escapedName = childName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const svgOverlay = Buffer.from(
      `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <text x="${width / 2}" y="${height - 40}" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#444">A coloring book for ${escapedName}</text>
      </svg>`
    );
    layers.push({ input: svgOverlay, top: 0, left: 0 });
  }

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
