/**
 * Layout Engine V3 — Composes story entries into interior PDF.
 *
 * Pages (no blank page 2):
 *   p1: blank
 *   p2: title page
 *   p3: copyright
 *   p4: dedication
 *   p5–p(4+spreads*2): story spreads
 *   closing page
 *   upsell spread (2 pages: 2 covers each, full portrait)
 *
 * Picture book: 8.5" × 8.5"  (612 × 612 pts)
 * Early reader: 6" × 9"       (432 × 648 pts)
 * All pages include 0.125" (9pt) bleed on all sides.
 *
 * Fonts (embedded TTF):
 *   - Playfair Display — titles
 *   - Dancing Script   — dedication body + subtitle
 *   - Helvetica        — captions, bylines (standard)
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const sharp   = require('sharp');
const { execFile } = require('child_process');
const os = require('os');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

/**
 * Upscale an image buffer 4x using ImageMagick Lanczos + unsharp.
 * Falls back to sharp Lanczos3 if ImageMagick is unavailable.
 */
async function upscaleImage(buf) {
  const tmpIn  = path.join(os.tmpdir(), `gmb-upscale-in-${Date.now()}.png`);
  const tmpOut = path.join(os.tmpdir(), `gmb-upscale-out-${Date.now()}.jpg`);
  try {
    fs.writeFileSync(tmpIn, buf);
    await execFileAsync('convert', [
      tmpIn,
      '-filter', 'Lanczos',
      '-resize', '400%',
      '-unsharp', '0x1.5+0.7+0.02',
      '-quality', '95',
      tmpOut,
    ], { timeout: 120000 });
    const result = fs.readFileSync(tmpOut);
    return result;
  } catch (e) {
    console.warn('[LayoutEngine] ImageMagick upscale failed, using sharp fallback:', e.message);
    // Fallback: sharp Lanczos3
    const meta = await sharp(buf).metadata();
    return sharp(buf)
      .resize(meta.width * 4, meta.height * 4, { kernel: 'lanczos3', fastShrinkOnLoad: false })
      .sharpen({ sigma: 0.8, m1: 0.5, m2: 1.5 })
      .jpeg({ quality: 95 })
      .toBuffer();
  } finally {
    try { fs.unlinkSync(tmpIn); } catch (_) {}
    try { fs.unlinkSync(tmpOut); } catch (_) {}
  }
}

// ── Geometry constants ───────────────────────────────────────────────────────
const BLEED       = 9;    // 0.125" in pts
const SAFE        = BLEED + 50; // safe text inset from page edge
const TARGET_DPI  = 300;
const PTS_PER_INCH= 72;

const FORMATS = {
  PICTURE_BOOK: { width: 612, height: 612 },
  EARLY_READER: { width: 432, height: 648 },
};

// ── Palette ──────────────────────────────────────────────────────────────────
const C = {
  white:      rgb(1, 1, 1),
  black:      rgb(0.059, 0.086, 0.141),
  brownMid:   rgb(0.431, 0.325, 0.220),
  brownLight: rgb(0.600, 0.502, 0.400),
  gold:       rgb(0.765, 0.549, 0.180),
  goldLight:  rgb(0.855, 0.718, 0.431),
  cardBg:     rgb(0.969, 0.949, 0.918),   // #f7f2ea — matches cover-selection page
  primary:    rgb(0.141, 0.416, 0.780),   // site primary blue
  grayLight:  rgb(0.620, 0.647, 0.686),
};

// ── Font paths (bundled in worker image) ─────────────────────────────────────
const FONT_DIR = path.join(__dirname, '..', 'fonts');
const FONT_PATHS = {
  playfair:       path.join(FONT_DIR, 'PlayfairDisplay.ttf'),
  playfairItalic: path.join(FONT_DIR, 'PlayfairDisplay-Italic.ttf'),
  dancing:        path.join(FONT_DIR, 'DancingScript.ttf'),
};

// ── Text helpers ──────────────────────────────────────────────────────────────
function wrapText(text, font, size, maxW) {
  const words = String(text).split(/\s+/);
  const lines = []; let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(t, size) > maxW && cur) { lines.push(cur); cur = w; }
    else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

function drawCentered(page, text, font, size, y, color) {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: (page.getWidth() - w) / 2, y, size, font, color });
}

function drawCenteredBlock(page, lines, font, size, startY, lineH, color) {
  for (let i = 0; i < lines.length; i++) {
    drawCentered(page, lines[i], font, size, startY - i * lineH, color);
  }
}

function goldRule(page, y, w = 80) {
  const pw = page.getWidth();
  page.drawRectangle({ x: (pw - w) / 2, y, width: w, height: 1.2, color: C.gold });
}

// ── Image helpers ─────────────────────────────────────────────────────────────

async function embedFullBleed(pdfDoc, page, buf) {
  const pw = page.getWidth(); const ph = page.getHeight();
  const wp = Math.round(pw / PTS_PER_INCH * TARGET_DPI);
  const hp = Math.round(ph / PTS_PER_INCH * TARGET_DPI);
  // fit: 'cover' fills the page edge-to-edge (full-bleed design intent)
  const r = await sharp(buf)
    .resize(wp, hp, { fit: 'cover' })
    .toColorspace('srgb').jpeg({ quality: 93 }).toBuffer();
  const img = await pdfDoc.embedJpg(r);
  page.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
}

async function splitSpreadImage(buf, pw, ph) {
  // Strategy: "Full-bleed spread with controlled center crop"
  // 1. Upscale 4x (Lanczos + unsharp) so source ~1376px → ~5500px (319 DPI at print size)
  // 2. Scale to fill spread width (2×page width) exactly
  // 3. Crop evenly from top+bottom (~6%) to fit page height
  // 4. Split down the center into two square full-bleed pages

  const wp = Math.round(pw / PTS_PER_INCH * TARGET_DPI);  // page width in pixels
  const hp = Math.round(ph / PTS_PER_INCH * TARGET_DPI);  // page height in pixels
  const spreadW = wp * 2;  // full spread = 2 pages wide

  // Step 1: Upscale 4x for print quality
  const upscaled = await upscaleImage(buf);

  // Step 2: Scale to fill spread width exactly, crop center vertically, split — all in one pass
  const upscaledMeta = await sharp(upscaled).metadata();
  const scaledH = Math.round(upscaledMeta.height * spreadW / upscaledMeta.width);
  const cropTop  = Math.max(0, Math.floor((scaledH - hp) / 2));

  // Step 3: Scale + crop in one sharp operation (avoids raw buffer issue)
  const spreadBuf = await sharp(upscaled)
    .resize(spreadW, scaledH, { kernel: 'lanczos3' })
    .extract({ left: 0, top: cropTop, width: spreadW, height: hp })
    .toColorspace('srgb').jpeg({ quality: 93 }).toBuffer();

  // Step 4: Split exactly down the center
  const leftBuf  = await sharp(spreadBuf)
    .extract({ left: 0,  top: 0, width: wp, height: hp })
    .toBuffer();
  const rightBuf = await sharp(spreadBuf)
    .extract({ left: wp, top: 0, width: wp, height: hp })
    .toBuffer();

  return { leftBuf, rightBuf };
}

// ── Font loader (lazy, cached per pdfDoc) ────────────────────────────────────
async function loadFonts(pdfDoc) {
  pdfDoc.registerFontkit(fontkit);
  const load = (p) => fs.existsSync(p) ? pdfDoc.embedFont(fs.readFileSync(p)) : null;
  const [playfair, playfairItalic, dancing, helv, helvB] = await Promise.all([
    load(FONT_PATHS.playfair),
    load(FONT_PATHS.playfairItalic),
    load(FONT_PATHS.dancing),
    pdfDoc.embedFont(StandardFonts.Helvetica),
    pdfDoc.embedFont(StandardFonts.HelveticaBold),
  ]);
  return { playfair, playfairItalic, dancing, helv, helvB };
}

// ── Page builders ─────────────────────────────────────────────────────────────

function buildBlankPage(pdfDoc, pw, ph) {
  pdfDoc.addPage([pw, ph]);
}

function buildTitlePage(pdfDoc, pw, ph, fonts, opts) {
  const { playfair, playfairItalic, dancing, helv } = fonts;
  const { title, childName } = opts;
  const p = pdfDoc.addPage([pw, ph]);
  const maxW = pw - SAFE * 2;

  // Main title — Playfair Display
  const TITLE_SZ = pw < 500 ? 28 : 36;
  const lines  = wrapText(title || 'My Story', playfair || helv, TITLE_SZ, maxW);
  const lineH  = TITLE_SZ * 1.3;
  const blockH = lines.length * lineH;
  const startY = ph / 2 + blockH / 2 + 30;
  drawCenteredBlock(p, lines, playfair || helv, TITLE_SZ, startY, lineH, C.black);

  goldRule(p, ph / 2 - 8, 100);

  // Subtitle — Dancing Script
  if (childName) {
    const sub  = `A story written just for ${childName}`;
    const subFont = dancing || playfairItalic || helv;
    const subSz = 22;
    drawCentered(p, sub, subFont, subSz, ph / 2 - 40, C.brownMid);
  }

  // Byline
  const by = 'Created by GiftMyBook';
  const byW = helv.widthOfTextAtSize(by, 10);
  p.drawText(by, { x: (pw - byW) / 2, y: BLEED + 22, size: 10, font: helv, color: C.grayLight });
}

function buildCopyrightPage(pdfDoc, pw, ph, fonts, opts) {
  const { helv } = fonts;
  const { year, childName } = opts;
  const p = pdfDoc.addPage([pw, ph]);
  const yr = year || new Date().getFullYear();
  const lines = [
    `\u00A9 ${yr} GiftMyBook`,
    'Made with love at GiftMyBook.com',
    'All rights reserved.',
    '',
    childName ? `Personalized for ${childName}` : '',
  ].filter(l => l !== undefined);
  let y = ph * 0.38;
  for (const l of lines) {
    if (!l) { y -= 12; continue; }
    const lw = helv.widthOfTextAtSize(l, 10);
    p.drawText(l, { x: (pw - lw) / 2, y, size: 10, font: helv, color: C.grayLight });
    y -= 18;
  }
}

function buildDedicationPage(pdfDoc, pw, ph, fonts, opts) {
  const { playfairItalic, dancing, helv } = fonts;
  const { bookFrom, dedication } = opts;
  const p = pdfDoc.addPage([pw, ph]);
  if (!dedication && !bookFrom) return;

  const maxW = pw - SAFE * 2;
  const dedFont = dancing || playfairItalic || helv;

  const FROM_SZ      = 18;
  const DED_SZ       = 26;
  const DED_LH       = DED_SZ * 1.55;
  const RULE_GAP     = 14;
  const TITLE_TO_DED = DED_LH * 2; // 2 lines of extra space between rule and dedication text

  const dedText  = dedication || '';
  const dedLines = wrapText(dedText, dedFont, DED_SZ, maxW);
  const bodyH    = dedLines.length * DED_LH;
  const blockH   = FROM_SZ + RULE_GAP + 1.2 + RULE_GAP + TITLE_TO_DED + bodyH;

  // Anchor whole block to page vertical center
  let y = ph / 2 + blockH / 2;

  if (bookFrom) {
    drawCentered(p, `From ${bookFrom}`, playfairItalic || helv, FROM_SZ, y, C.brownMid);
    y -= FROM_SZ + RULE_GAP;
    goldRule(p, y, 80);
    y -= RULE_GAP + 1.2 + TITLE_TO_DED; // extra 2-line gap after rule
  }

  for (const line of dedLines) {
    drawCentered(p, line, dedFont, DED_SZ, y, C.black);
    y -= DED_LH;
  }
}

function buildClosingPage(pdfDoc, pw, ph, fonts) {
  const { playfair, helv } = fonts;
  const p = pdfDoc.addPage([pw, ph]);
  const endSz = 44;
  const endW  = (playfair || helv).widthOfTextAtSize('The End', endSz);
  p.drawText('The End', { x: (pw - endW) / 2, y: ph / 2 + 12, size: endSz, font: playfair || helv, color: C.black });
  goldRule(p, ph / 2 - 14, 60);
  const bw = helv.widthOfTextAtSize('GiftMyBook.com', 10);
  p.drawText('GiftMyBook.com', { x: (pw - bw) / 2, y: ph / 2 - 34, size: 10, font: helv, color: C.grayLight });
}

async function buildUpsellSpread(pdfDoc, pw, ph, fonts, opts) {
  const { playfair, playfairItalic, helv, helvB } = fonts;
  const { upsellCovers, childName, bookId } = opts;
  if (!upsellCovers || upsellCovers.length === 0) return;

  let qrcode;
  try { qrcode = require('qrcode'); } catch (_) {}

  const MARGIN = 27;
  const GAP    = 14;
  const CARD_W = (pw - MARGIN * 2 - GAP) / 2;
  const COVER_H= Math.round(CARD_W * (2400 / 1792)); // 3:4 portrait ratio
  const LABEL_H= 52;

  for (let pageIdx = 0; pageIdx < 2; pageIdx++) {
    const p = pdfDoc.addPage([pw, ph]);
    const pagePair = upsellCovers.slice(pageIdx * 2, pageIdx * 2 + 2);
    if (pagePair.length === 0) continue;

    // Header (left page only)
    let cardsTopY;
    if (pageIdx === 0) {
      const tag    = `What will ${childName || 'your child'}\u2019s next story be?`;
      const tagSz  = 18;
      const tagLines = wrapText(tag, playfair || helv, tagSz, pw - MARGIN * 2);
      const tagLH  = tagSz * 1.35;
      let ty = ph - MARGIN - 4;
      for (const line of tagLines) { drawCentered(p, line, playfair || helv, tagSz, ty, C.black); ty -= tagLH; }
      drawCentered(p, 'Choose the next adventure...', playfairItalic || helv, 11, ty - 2, C.brownMid);
      cardsTopY = ty - 16;
    } else {
      cardsTopY = ph - MARGIN - 4;
    }

    const availH  = cardsTopY - MARGIN;
    const cardH   = COVER_H + LABEL_H;
    const offsetY = MARGIN + Math.max(0, (availH - cardH) / 2);
    const coverY  = offsetY + LABEL_H;

    for (let ci = 0; ci < pagePair.length; ci++) {
      const uc   = pagePair[ci];
      const cardX = MARGIN + ci * (CARD_W + GAP);
      const buf   = uc.coverBuffer;

      if (buf) {
        try {
          const wp = Math.round(CARD_W / PTS_PER_INCH * 200);
          const hp = Math.round(COVER_H / PTS_PER_INCH * 200);
          const resized = await sharp(buf)
            .resize(wp, hp, { fit: 'contain', background: { r: 247, g: 242, b: 234, alpha: 1 } })
            .toColorspace('srgb').jpeg({ quality: 90 }).toBuffer();
          const img = await pdfDoc.embedJpg(resized);
          p.drawImage(img, { x: cardX, y: coverY, width: CARD_W, height: COVER_H });
        } catch (e) {
          console.warn(`[LayoutEngine] Upsell cover embed failed: ${e.message}`);
          p.drawRectangle({ x: cardX, y: coverY, width: CARD_W, height: COVER_H, color: C.cardBg });
        }
      } else {
        p.drawRectangle({ x: cardX, y: coverY, width: CARD_W, height: COVER_H, color: C.cardBg });
      }

      // Gold border
      p.drawRectangle({ x: cardX - 1, y: coverY - 1, width: CARD_W + 2, height: COVER_H + 2,
        borderColor: C.goldLight, borderWidth: 1 });

      // QR — bottom-right of cover, white bg
      if (qrcode && bookId) {
        const QR_SZ = 50;
        try {
          const qrBuf = await qrcode.toBuffer(`https://giftmybook.com/upsell/${bookId}/${uc.index ?? (pageIdx * 2 + ci)}`,
            { type: 'png', width: 220, margin: 1 });
          const qrImg = await pdfDoc.embedPng(qrBuf);
          const qrX = cardX + CARD_W - QR_SZ - 5;
          const qrY = coverY + 5; // bottom-right (PDF y=0 is bottom)
          p.drawRectangle({ x: qrX - 2, y: qrY - 2, width: QR_SZ + 4, height: QR_SZ + 4, color: C.white });
          p.drawImage(qrImg, { x: qrX, y: qrY, width: QR_SZ, height: QR_SZ });
        } catch (e) { console.warn(`[LayoutEngine] QR failed: ${e.message}`); }
      }

      // Style label
      const labelY = offsetY + LABEL_H - 16;
      p.drawText((uc.styleLabel || uc.artStyle || '').toUpperCase(), {
        x: cardX, y: labelY, size: 8, font: helvB, color: C.primary,
      });

      // Title
      const titleLines = wrapText(uc.title || '', playfair || helv, 10, CARD_W);
      for (let ti = 0; ti < Math.min(titleLines.length, 2); ti++) {
        p.drawText(titleLines[ti], { x: cardX, y: labelY - 13 - ti * 13, size: 10, font: playfair || helv, color: C.black });
      }
    }

    // Footer
    const ft = `GiftMyBook.com  \u00B7  A personalized book made just for ${childName || 'your child'}`;
    const ftW = helv.widthOfTextAtSize(ft, 7);
    p.drawText(ft, { x: (pw - ftW) / 2, y: BLEED + 4, size: 7, font: helv, color: C.grayLight });
  }
}

// ── Reflection & Adult Note Pages (Emotional E3/E4) ─────────────────────────

function buildReflectionPage(pdfDoc, pw, ph, fonts, opts) {
  const { playfair, helv } = fonts;
  const p = pdfDoc.addPage([pw, ph]);
  const maxW = pw - SAFE * 2;

  // Title
  const title = 'For You';
  const titleSz = 28;
  drawCentered(p, title, playfair || helv, titleSz, ph - SAFE - 30, C.black);

  // Gold rule under title
  goldRule(p, ph - SAFE - 50, 60);

  // Reflection text
  let y = ph - SAFE - 80;
  if (opts.text) {
    const textLines = wrapText(opts.text, helv, 11, maxW);
    for (const line of textLines) {
      const lw = helv.widthOfTextAtSize(line, 11);
      p.drawText(line, { x: (pw - lw) / 2, y, size: 11, font: helv, color: C.brownMid });
      y -= 18;
    }
    y -= 10;
  }

  // Prompts with ruled lines for writing
  if (opts.prompts && Array.isArray(opts.prompts)) {
    for (const prompt of opts.prompts) {
      const promptLines = wrapText(prompt, helv, 11, maxW);
      for (const line of promptLines) {
        p.drawText(line, { x: SAFE, y, size: 11, font: helv, color: C.black });
        y -= 16;
      }
      // Add ruled lines for writing
      for (let li = 0; li < 3; li++) {
        y -= 18;
        p.drawRectangle({ x: SAFE, y, width: maxW, height: 0.5, color: C.grayLight });
      }
      y -= 14;
    }
  }
}

function buildAdultNotePage(pdfDoc, pw, ph, fonts, opts) {
  const { playfair, playfairItalic, helv } = fonts;
  const p = pdfDoc.addPage([pw, ph]);
  const maxW = pw - SAFE * 2;

  // Title
  const title = 'For the Adult Reading This';
  const titleSz = 22;
  drawCentered(p, title, playfair || helv, titleSz, ph - SAFE - 30, C.black);

  // Gold rule
  goldRule(p, ph - SAFE - 48, 80);

  // Note text
  let y = ph - SAFE - 72;
  if (opts.text) {
    const noteFont = playfairItalic || helv;
    const noteLines = wrapText(opts.text, noteFont, 10, maxW);
    for (const line of noteLines) {
      const lw = noteFont.widthOfTextAtSize(line, 10);
      p.drawText(line, { x: (pw - lw) / 2, y, size: 10, font: noteFont, color: C.brownMid });
      y -= 16;
    }
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * @param {Array} storyEntries
 * @param {string} bookFormat - PICTURE_BOOK | EARLY_READER
 * @param {object} opts - { title, childName, dedication, bookFrom, year, upsellCovers, bookId }
 */
async function assemblePdf(storyEntries, bookFormat, opts = {}) {
  const fmt    = FORMATS[(bookFormat || '').toUpperCase()] || FORMATS.PICTURE_BOOK;
  const pw     = fmt.width  + BLEED * 2;
  const ph     = fmt.height + BLEED * 2;

  const pdfDoc = await PDFDocument.create();
  const fonts  = await loadFonts(pdfDoc);

  const { title, childName, dedication, bookFrom, year, upsellCovers, bookId } = opts;

  // ── Front matter ──────────────────────────────────────────────────────────
  buildBlankPage(pdfDoc, pw, ph);
  buildDedicationPage(pdfDoc, pw, ph, fonts, { bookFrom, dedication });
  buildTitlePage(pdfDoc, pw, ph, fonts, { title, childName });

  // ── Story spreads ─────────────────────────────────────────────────────────
  // picture_book (age ≤5): spreadIllustrationBuffer = wide 16:9 image → split into left+right pages
  // Always use spread format — illustrations are always wide 16:9 split down center
  const isPictureBook = true; // was: (bookFormat || '').toUpperCase() !== 'EARLY_READER'

  for (const entry of storyEntries) {
    if (entry.type === 'reflection') {
      buildReflectionPage(pdfDoc, pw, ph, fonts, { text: entry.text, prompts: entry.prompts });
      continue;
    }
    if (entry.type === 'adult_note') {
      buildAdultNotePage(pdfDoc, pw, ph, fonts, { text: entry.text });
      continue;
    }
    if (entry.type !== 'spread') continue;

    if (isPictureBook) {
      // ── PICTURE BOOK: wide landscape image split down the middle ──
      const leftPage  = pdfDoc.addPage([pw, ph]);
      const rightPage = pdfDoc.addPage([pw, ph]);
      if (entry.spreadIllustrationBuffer) {
        try {
          const { leftBuf, rightBuf } = await splitSpreadImage(entry.spreadIllustrationBuffer, pw, ph);
          await embedFullBleed(pdfDoc, leftPage,  leftBuf);
          await embedFullBleed(pdfDoc, rightPage, rightBuf);
        } catch (e) {
          console.warn(`[LayoutEngine] spread split failed: ${e.message}`);
        }
      } else {
        // Fallback: pre-split buffers
        if (entry.leftIllustrationBuffer)  await embedFullBleed(pdfDoc, leftPage,  entry.leftIllustrationBuffer);
        if (entry.rightIllustrationBuffer) await embedFullBleed(pdfDoc, rightPage, entry.rightIllustrationBuffer);
      }

    } else {
      // ── EARLY READER: each illustration = one full page (1:1 square) ──
      if (entry.leftIllustrationBuffer) {
        await embedFullBleed(pdfDoc, pdfDoc.addPage([pw, ph]), entry.leftIllustrationBuffer);
      }
      if (entry.rightIllustrationBuffer) {
        await embedFullBleed(pdfDoc, pdfDoc.addPage([pw, ph]), entry.rightIllustrationBuffer);
      }
      // Single spread image fallback
      if (!entry.leftIllustrationBuffer && !entry.rightIllustrationBuffer && entry.spreadIllustrationBuffer) {
        await embedFullBleed(pdfDoc, pdfDoc.addPage([pw, ph]), entry.spreadIllustrationBuffer);
      }
    }
  }
  // ── Closing ───────────────────────────────────────────────────────────────
  buildClosingPage(pdfDoc, pw, ph, fonts);

  // ── Upsell spread ─────────────────────────────────────────────────────────
  if (upsellCovers && upsellCovers.length > 0) {
    await buildUpsellSpread(pdfDoc, pw, ph, fonts, { upsellCovers, childName, bookId });
  }

  // Enforce Lulu minimum page count and ensure even page count for binding
  const MIN_PAGES = opts.minPages || 32;
  while (pdfDoc.getPageCount() < MIN_PAGES || pdfDoc.getPageCount() % 2 !== 0) {
    pdfDoc.addPage([pw, ph]);
  }

  return Buffer.from(await pdfDoc.save());
}

module.exports = { assemblePdf, FORMATS };
