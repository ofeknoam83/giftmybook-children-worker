'use strict';

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const PTS_PER_INCH = 72;
const PAGE_PT = 8.5 * PTS_PER_INCH; // 612pt — square 8.5x8.5"
const TARGET_DPI = 300;
const PAGE_PX = Math.round(PAGE_PT / PTS_PER_INCH * TARGET_DPI); // 2550px

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
 * Build the cover page.
 */
function buildCover(pdfDoc, fonts, { title, childName }) {
  const p = pdfDoc.addPage([PAGE_PT, PAGE_PT]);
  const mid = PAGE_PT / 2;
  const titleFont = fonts.bubblegum || fonts.playfair || fonts.helv;
  const subFont = fonts.bubblegum || fonts.dancing || fonts.playfairItalic || fonts.helv;
  const navy = rgb(0.1, 0.12, 0.25);
  const gold = rgb(0.75, 0.55, 0.1);

  p.drawRectangle({ x: 0, y: 0, width: PAGE_PT, height: PAGE_PT, color: rgb(1, 1, 1) });

  p.drawRectangle({ x: 0, y: PAGE_PT - 36, width: PAGE_PT, height: 36, color: navy });
  p.drawRectangle({ x: 0, y: PAGE_PT - 40, width: PAGE_PT, height: 4, color: gold });

  p.drawRectangle({ x: 0, y: 0, width: PAGE_PT, height: 36, color: navy });
  p.drawRectangle({ x: 0, y: 36, width: PAGE_PT, height: 4, color: gold });

  const titleSz = 32;
  const titleWords = title.split(' ');
  const maxW = PAGE_PT - 80;
  let lines = []; let cur = '';
  for (const w of titleWords) {
    const t = cur ? `${cur} ${w}` : w;
    if (titleFont.widthOfTextAtSize(t, titleSz) > maxW && cur) { lines.push(cur); cur = w; }
    else cur = t;
  }
  if (cur) lines.push(cur);

  const lineH = titleSz * 1.35;
  let y = mid + (lines.length * lineH) / 2 + 20;
  for (const line of lines) {
    drawCenteredText(p, line, titleFont, titleSz, y, navy);
    y -= lineH;
  }

  const ruleY = mid - 20;
  p.drawLine({ start: { x: PAGE_PT / 2 - 80, y: ruleY }, end: { x: PAGE_PT / 2 + 80, y: ruleY }, thickness: 1.5, color: gold });

  const sub = `A Coloring Book for ${childName || 'You'}`;
  drawCenteredText(p, sub, subFont, 18, ruleY - 30, gold);

  drawCenteredText(p, 'Color Your Story', fonts.helv, 12, 60, rgb(0.5, 0.5, 0.5));
}

/**
 * Embed a coloring page image as a full-bleed page.
 * Page dimensions match the image's actual aspect ratio — no squashing.
 * Forces pure black-and-white output: grayscale + threshold.
 */
async function addColoringPage(pdfDoc, imageBuffer) {
  // Process to B&W first, then read actual dimensions
  const processed = await sharp(imageBuffer)
    .grayscale()
    .threshold(150) // 150 keeps medium grays (skin, hair mid-tones) white; only true dark outlines go black
    .png()
    .toBuffer();

  const meta = await sharp(processed).metadata();
  const imgW = meta.width;
  const imgH = meta.height;

  // Normalise so the longer dimension = 8.5" (612pt), preserving ratio
  const maxPt = 8.5 * PTS_PER_INCH;
  let pageW, pageH;
  if (imgW >= imgH) {
    pageW = maxPt;
    pageH = Math.round(maxPt * imgH / imgW);
  } else {
    pageH = maxPt;
    pageW = Math.round(maxPt * imgW / imgH);
  }

  const pdfImage = await pdfDoc.embedPng(processed);
  const p = pdfDoc.addPage([pageW, pageH]);
  p.drawImage(pdfImage, { x: 0, y: 0, width: pageW, height: pageH });
}

/**
 * Build the back cover page.
 */
function buildBackCover(pdfDoc, fonts, { childName }) {
  const p = pdfDoc.addPage([PAGE_PT, PAGE_PT]);
  const navy = rgb(0.1, 0.12, 0.25);
  const gold = rgb(0.75, 0.55, 0.1);
  const titleFont = fonts.bubblegum || fonts.playfairItalic || fonts.playfair || fonts.helv;
  const subFont = fonts.bubblegum || fonts.dancing || fonts.helv;

  p.drawRectangle({ x: 0, y: 0, width: PAGE_PT, height: PAGE_PT, color: rgb(1, 1, 1) });
  p.drawRectangle({ x: 0, y: PAGE_PT - 36, width: PAGE_PT, height: 36, color: navy });
  p.drawRectangle({ x: 0, y: 0, width: PAGE_PT, height: 36, color: navy });

  const mid = PAGE_PT / 2;
  drawCenteredText(p, 'Colored by', titleFont, 22, mid + 40, navy);

  p.drawLine({ start: { x: 100, y: mid }, end: { x: PAGE_PT - 100, y: mid }, thickness: 1, color: rgb(0.6, 0.6, 0.6) });

  drawCenteredText(p, childName ? `${childName}'s Masterpiece` : 'My Masterpiece', subFont, 16, mid - 30, gold);
  drawCenteredText(p, 'GiftMyBook.com', fonts.helv, 10, 50, rgb(0.7, 0.7, 0.7));
}

/**
 * Assemble the full coloring book PDF.
 * @param {Array<{buffer: Buffer|null, success: boolean}>} pages
 * @param {{ title?: string, childName?: string, pagesOnly?: boolean }} opts
 * @returns {Promise<Buffer>} PDF bytes
 */
async function buildColoringBookPdf(pages, opts = {}) {
  const { title = 'My Coloring Book', childName = '', pagesOnly = false } = opts;

  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`${title} — Coloring Book`);
  pdfDoc.setAuthor('GiftMyBook');

  let fonts;
  if (!pagesOnly) {
    fonts = await loadFonts(pdfDoc);
    buildCover(pdfDoc, fonts, { title, childName });
  }

  for (const page of pages) {
    if (page.buffer) {
      await addColoringPage(pdfDoc, page.buffer);
    }
  }

  if (!pagesOnly) {
    buildBackCover(pdfDoc, fonts, { childName });
  }

  return Buffer.from(await pdfDoc.save());
}

module.exports = { buildColoringBookPdf };
