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
 *   - Bubblegum Sans   — titles, body text (primary children's book font)
 *   - Kalam            — dedication body (handwritten feel, no ligature bugs)
 *   - Playfair Display — fallback / italic accents
 *   - Dancing Script   — (disabled: "th" ligature bug in pdf-lib)
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
// comicLayoutPresets and comicLetterer are no longer used — graphic novel pages
// are now rendered as full-page AI-generated images with text baked in.

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
  bubblegum:      path.join(FONT_DIR, 'BubblegumSans-Regular.ttf'),
  playfair:       path.join(FONT_DIR, 'PlayfairDisplay.ttf'),
  playfairItalic: path.join(FONT_DIR, 'PlayfairDisplay-Italic.ttf'),
  dancing:        path.join(FONT_DIR, 'DancingScript.ttf'),
  kalam:          path.join(FONT_DIR, 'Kalam-Regular.ttf'),
  comicNeue:      path.join(FONT_DIR, 'ComicNeue-Bold.ttf'),
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

function drawCentered(page, text, font, size, y, color, opts = {}) {
  const cs = opts.characterSpacing || 0;
  const w = font.widthOfTextAtSize(text, size) + cs * Math.max(0, text.length - 1);
  page.drawText(text, { x: (page.getWidth() - w) / 2, y, size, font, color, ...(cs !== 0 ? { characterSpacing: cs } : {}) });
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
  // Center crop — equal from top and bottom.
  // The illustration prompt enforces 25% margin from all edges to survive this crop + print bleed.
  const excessH  = Math.max(0, scaledH - hp);
  const cropTop  = Math.floor(excessH / 2);

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
  const [bubblegum, playfair, playfairItalic, dancing, kalam, helv, helvB] = await Promise.all([
    load(FONT_PATHS.bubblegum),
    load(FONT_PATHS.playfair),
    load(FONT_PATHS.playfairItalic),
    load(FONT_PATHS.dancing),
    load(FONT_PATHS.kalam),
    pdfDoc.embedFont(StandardFonts.Helvetica),
    pdfDoc.embedFont(StandardFonts.HelveticaBold),
  ]);
  return { bubblegum, playfair, playfairItalic, dancing, kalam, helv, helvB };
}

// ── Page builders ─────────────────────────────────────────────────────────────

function buildBlankPage(pdfDoc, pw, ph) {
  pdfDoc.addPage([pw, ph]);
}

function buildTitlePage(pdfDoc, pw, ph, fonts, opts) {
  const { bubblegum, playfair, playfairItalic, helv } = fonts;
  const { title, childName } = opts;
  const p = pdfDoc.addPage([pw, ph]);
  const maxW = pw - SAFE * 2;
  const primaryFont = bubblegum || playfair || helv;

  const TITLE_SZ = pw < 500 ? 28 : 36;
  const lines  = wrapText(title || 'My Story', primaryFont, TITLE_SZ, maxW);
  const lineH  = TITLE_SZ * 1.3;
  const blockH = lines.length * lineH;
  const startY = ph / 2 + blockH / 2 + 30;
  drawCenteredBlock(p, lines, primaryFont, TITLE_SZ, startY, lineH, C.black);

  goldRule(p, ph / 2 - 8, 100);

  if (childName) {
    const sub  = `A story written just for ${childName}`;
    const subFont = bubblegum || playfairItalic || helv;
    const subSz = 20;
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
  const { bubblegum, playfairItalic, kalam, helv } = fonts;
  const { bookFrom, dedication } = opts;
  const p = pdfDoc.addPage([pw, ph]);
  if (!dedication && !bookFrom) return;

  const maxW = pw - SAFE * 2;
  // Kalam — handwritten feel; Dancing Script has "th" ligature bugs in pdf-lib
  const dedFont = kalam || playfairItalic || helv;

  // Extract "From X:" header from the dedication text if present,
  // so it always renders with the styled header treatment (smaller font + gold rule).
  let fromLabel = null;
  let bodyText = (dedication || '').replace(/\\n/g, '\n');

  const fromInDed = bodyText.match(/^From\s+(.+?):\s*\n?/i);
  if (fromInDed) {
    fromLabel = fromInDed[1].trim();
    bodyText = bodyText.slice(fromInDed[0].length);
  } else if (bookFrom) {
    fromLabel = bookFrom;
  }

  // Ensure dedication page never shows a bare "From X:" with no body text
  if (!bodyText.trim() && fromLabel) {
    bodyText = 'Made with love, just for you.';
  }

  const FROM_SZ  = 18;
  const RULE_GAP = 12;
  const availH   = ph - SAFE * 2;

  let dedSz = 22;
  const MIN_DED_SZ = 14;

  function wrapBody(sz) {
    const lh = sz * 1.55;
    const segments = bodyText.split('\n');
    const lines = [];
    for (const seg of segments) {
      if (seg.trim() === '') { lines.push(''); continue; }
      lines.push(...wrapText(seg, dedFont, sz, maxW));
    }
    return { lines, lh };
  }

  function totalH(sz) {
    const { lines, lh } = wrapBody(sz);
    const bodyH = lines.length * lh;
    const fromH = fromLabel ? (FROM_SZ + RULE_GAP + 1.2 + RULE_GAP + lh) : 0;
    return fromH + bodyH;
  }

  while (dedSz > MIN_DED_SZ && totalH(dedSz) > availH) {
    dedSz -= 1;
  }

  const { lines: dedLines, lh: DED_LH } = wrapBody(dedSz);
  const bodyH  = dedLines.length * DED_LH;
  const fromH  = fromLabel ? (FROM_SZ + RULE_GAP + 1.2 + RULE_GAP + DED_LH) : 0;
  const blockH = fromH + bodyH;

  let y = ph / 2 + blockH / 2;
  y = Math.min(y, ph - SAFE);

  if (fromLabel) {
    drawCentered(p, `With love from ${fromLabel}`, dedFont, FROM_SZ, y, C.brownMid);
    y -= FROM_SZ + RULE_GAP;
    goldRule(p, y, 80);
    y -= RULE_GAP + 1.2 + DED_LH;
  }

  for (const line of dedLines) {
    if (y < SAFE) break;
    if (line !== '') drawCentered(p, line, dedFont, dedSz, y, C.black);
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

/**
 * Build a 6×9" chapter book PDF with typeset text pages and chapter-opener illustrations.
 * @param {Array<{chapterTitle: string, text: string, imageBuffer?: Buffer}>} chapters
 * @param {object} opts - { title, childName, bookFrom, dedication, year, bookId, upsellCovers }
 * @returns {Promise<Buffer>} PDF buffer
 */
async function buildChapterBookPdf(chapters, opts = {}) {
  const { title = 'My Story', childName = '', bookFrom = '', dedication = '', year = new Date().getFullYear() } = opts;

  // 6×9" in points (no bleed for chapter book interior — Lulu handles trim)
  const PW = 6 * 72;  // 432pt
  const PH = 9 * 72;  // 648pt
  const CB_MARGIN = 54;  // 0.75" margins
  const BODY_W = PW - CB_MARGIN * 2;

  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(title);
  pdfDoc.setAuthor('GiftMyBook');

  const fonts = await loadFonts(pdfDoc);
  const { bubblegum, playfair, playfairItalic, helv, helvB } = fonts;
  const titleFont = bubblegum || playfair || helvB || helv;
  const bodyFont = bubblegum || playfair || helv;
  const italicFont = playfairItalic || bubblegum || helv;

  const BLACK = rgb(0.08, 0.08, 0.1);
  const GOLD = rgb(0.75, 0.55, 0.1);
  const GRAY = rgb(0.5, 0.5, 0.5);

  // ── Helper: wrap text to lines ──
  function cbWrapToLines(text, font, fontSize, maxWidth) {
    const words = text.split(/\s+/);
    const lines = [];
    let current = '';
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(test, fontSize) > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
    return lines;
  }

  // ── Helper: typeset a block of prose onto pages ──
  function typesetProse(text, chapterNumber) {
    const BODY_SZ = 11;
    const LINE_H = BODY_SZ * 1.65;
    const PARA_GAP = BODY_SZ * 0.8;
    const HEADER_H = 40;

    const paragraphs = text.split(/\n\n+/).filter(p => p.trim());

    let page = pdfDoc.addPage([PW, PH]);
    let y = PH - CB_MARGIN - HEADER_H;

    // Chapter header
    const chapterLabel = `Chapter ${chapterNumber}`;
    const headerW = titleFont.widthOfTextAtSize(chapterLabel, 9);
    page.drawText(chapterLabel, { x: (PW - headerW) / 2, y: PH - CB_MARGIN - 14, size: 9, font: titleFont, color: GOLD });
    page.drawLine({ start: { x: CB_MARGIN, y: PH - CB_MARGIN - 20 }, end: { x: PW - CB_MARGIN, y: PH - CB_MARGIN - 20 }, thickness: 0.5, color: GOLD });

    for (const para of paragraphs) {
      const isItalicPara = para.startsWith('*') && para.endsWith('*');
      const cleanPara = para.replace(/^\*/, '').replace(/\*$/, '');
      const font = isItalicPara ? italicFont : bodyFont;
      const lines = cbWrapToLines(cleanPara, font, BODY_SZ, BODY_W);

      const neededH = lines.length * LINE_H + PARA_GAP;
      if (y - neededH < CB_MARGIN) {
        // Page number
        const pageNum = pdfDoc.getPageCount();
        page.drawText(`${pageNum}`, { x: PW / 2, y: CB_MARGIN / 2, size: 9, font: bodyFont, color: GRAY });

        page = pdfDoc.addPage([PW, PH]);
        y = PH - CB_MARGIN - HEADER_H;
        page.drawText(chapterLabel, { x: (PW - headerW) / 2, y: PH - CB_MARGIN - 14, size: 9, font: titleFont, color: GOLD });
        page.drawLine({ start: { x: CB_MARGIN, y: PH - CB_MARGIN - 20 }, end: { x: PW - CB_MARGIN, y: PH - CB_MARGIN - 20 }, thickness: 0.5, color: GOLD });
      }

      for (const line of lines) {
        page.drawText(line, { x: CB_MARGIN, y, size: BODY_SZ, font, color: BLACK });
        y -= LINE_H;
      }
      y -= PARA_GAP;
    }

    // Page number on last page
    const pageNum = pdfDoc.getPageCount();
    page.drawText(`${pageNum}`, { x: PW / 2, y: CB_MARGIN / 2, size: 9, font: bodyFont, color: GRAY });
  }

  // ── Front matter: Title page ──
  {
    const p = pdfDoc.addPage([PW, PH]);
    p.drawRectangle({ x: 0, y: 0, width: PW, height: PH, color: rgb(1, 1, 1) });
    const titleLines = cbWrapToLines(title, titleFont, 28, BODY_W);
    let ty = PH / 2 + (titleLines.length * 38) / 2 + 20;
    for (const line of titleLines) {
      const lw = titleFont.widthOfTextAtSize(line, 28);
      p.drawText(line, { x: (PW - lw) / 2, y: ty, size: 28, font: titleFont, color: BLACK });
      ty -= 38;
    }
    p.drawLine({ start: { x: PW / 2 - 40, y: ty - 10 }, end: { x: PW / 2 + 40, y: ty - 10 }, thickness: 1, color: GOLD });
    if (childName) {
      const sub = `A story for ${childName}`;
      const sw = (italicFont).widthOfTextAtSize(sub, 12);
      p.drawText(sub, { x: (PW - sw) / 2, y: ty - 28, size: 12, font: italicFont, color: GRAY });
    }
    const yearStr = `${year} \u00B7 GiftMyBook`;
    const yw = bodyFont.widthOfTextAtSize(yearStr, 9);
    p.drawText(yearStr, { x: (PW - yw) / 2, y: CB_MARGIN, size: 9, font: bodyFont, color: GRAY });
  }

  // ── Dedication page ──
  if (dedication) {
    const p = pdfDoc.addPage([PW, PH]);
    const dedLines = cbWrapToLines(dedication, italicFont, 12, BODY_W - 40);
    let dy = PH / 2 + (dedLines.length * 18) / 2;
    for (const line of dedLines) {
      const lw = italicFont.widthOfTextAtSize(line, 12);
      p.drawText(line, { x: (PW - lw) / 2, y: dy, size: 12, font: italicFont, color: BLACK });
      dy -= 18;
    }
  }

  // ── Chapters ──
  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i];

    // Chapter title page (with illustration if available)
    const p = pdfDoc.addPage([PW, PH]);
    p.drawRectangle({ x: 0, y: 0, width: PW, height: PH, color: rgb(1, 1, 1) });

    if (chapter.imageBuffer) {
      try {
        let imgBuf = chapter.imageBuffer;
        // Resize to 6×9" portrait at 300 DPI
        const TARGET_W_PX = Math.round(6 * 300);  // 1800px
        const TARGET_H_PX = Math.round(9 * 300);  // 2700px
        const meta = await sharp(imgBuf).metadata();
        const scaleW = TARGET_W_PX / meta.width;
        const scaleH = TARGET_H_PX / meta.height;
        const scale = Math.max(scaleW, scaleH);
        const scaledW = Math.round(meta.width * scale);
        const scaledH = Math.round(meta.height * scale);
        const cropX = Math.floor((scaledW - TARGET_W_PX) / 2);
        const cropY = Math.floor((scaledH - TARGET_H_PX) / 2);

        imgBuf = await sharp(imgBuf)
          .resize(scaledW, scaledH, { kernel: 'lanczos3' })
          .extract({ left: cropX, top: cropY, width: TARGET_W_PX, height: TARGET_H_PX })
          .jpeg({ quality: 93 })
          .toBuffer();

        const pdfImg = await pdfDoc.embedJpg(imgBuf);
        p.drawImage(pdfImg, { x: 0, y: 0, width: PW, height: PH });

        // Dark gradient overlay at bottom for chapter title
        p.drawRectangle({ x: 0, y: 0, width: PW, height: 100, color: rgb(0, 0, 0), opacity: 0.55 });
        const chLabelW = titleFont.widthOfTextAtSize(`Chapter ${i + 1}`, 10);
        p.drawText(`Chapter ${i + 1}`, { x: (PW - chLabelW) / 2, y: 72, size: 10, font: titleFont, color: rgb(0.8, 0.6, 0.1) });
        const chTitleLines = cbWrapToLines(chapter.chapterTitle, titleFont, 18, PW - 40);
        let cty = 55;
        for (const line of chTitleLines.slice().reverse()) {
          const lw = titleFont.widthOfTextAtSize(line, 18);
          p.drawText(line, { x: (PW - lw) / 2, y: cty, size: 18, font: titleFont, color: rgb(1, 1, 1) });
          cty += 22;
        }
      } catch (imgErr) {
        console.warn(`[buildChapterBookPdf] Chapter ${i + 1} image embed failed: ${imgErr.message}`);
        const chLabel = `Chapter ${i + 1}`;
        const lw1 = titleFont.widthOfTextAtSize(chLabel, 14);
        p.drawText(chLabel, { x: (PW - lw1) / 2, y: PH / 2 + 30, size: 14, font: titleFont, color: GOLD });
        const lw2 = titleFont.widthOfTextAtSize(chapter.chapterTitle, 24);
        p.drawText(chapter.chapterTitle, { x: (PW - lw2) / 2, y: PH / 2 - 10, size: 24, font: titleFont, color: BLACK });
      }
    } else {
      // No illustration: elegant text chapter title page
      const chLabel = `\u2014 Chapter ${i + 1} \u2014`;
      const lw1 = titleFont.widthOfTextAtSize(chLabel, 12);
      p.drawText(chLabel, { x: (PW - lw1) / 2, y: PH / 2 + 40, size: 12, font: titleFont, color: GOLD });
      const chTitleW = titleFont.widthOfTextAtSize(chapter.chapterTitle, 22);
      p.drawText(chapter.chapterTitle, { x: (PW - chTitleW) / 2, y: PH / 2, size: 22, font: titleFont, color: BLACK });
    }

    // Chapter prose pages
    if (chapter.text) {
      typesetProse(chapter.text, i + 1);
    }
  }

  // ── Back matter: "The End" ──
  {
    const p = pdfDoc.addPage([PW, PH]);
    const endW = (italicFont).widthOfTextAtSize('The End', 24);
    p.drawText('The End', { x: (PW - endW) / 2, y: PH / 2, size: 24, font: italicFont, color: BLACK });
    const childLabel = `A story for ${childName || 'you'}`;
    const childW = bodyFont.widthOfTextAtSize(childLabel, 12);
    p.drawText(childLabel, { x: (PW - childW) / 2, y: PH / 2 - 30, size: 12, font: italicFont, color: GRAY });
  }

  // Pad to even page count for binding
  while (pdfDoc.getPageCount() % 2 !== 0) {
    pdfDoc.addPage([PW, PH]);
  }

  return Buffer.from(await pdfDoc.save());
}

// ── Comic font cache (for graphic novel speech bubbles & captions) ────────────
let comicFontBytes = null;
function getComicFont() {
  if (comicFontBytes) return comicFontBytes;
  // Comic Neue Bold — bundled in fonts/ directory (OFL license)
  if (fs.existsSync(FONT_PATHS.comicNeue)) {
    comicFontBytes = fs.readFileSync(FONT_PATHS.comicNeue);
    return comicFontBytes;
  }
  return null;
}

/**
 * Group panels into pages based on pageLayout capacity.
 * Returns [{ layout, panels: [] }, ...]
 */
function groupPanelsIntoPages(allPanels) {
  const CAPACITY = {
    'splash': 1,
    'strip+2': 3,
    '1large+2small': 3,
    '3equal': 3,
    '2equal': 2,
    '4equal': 4,
  };

  const pages = [];
  let i = 0;
  while (i < allPanels.length) {
    const layout = allPanels[i].pageLayout || '3equal';
    const cap = CAPACITY[layout] || 3;
    const group = allPanels.slice(i, i + cap);
    pages.push({ layout, panels: group });
    i += group.length;
  }
  return pages;
}

/**
 * Draw a speech bubble with a short edge-attached tail pointing toward the speaker.
 * All coordinates in panelRect are top-left origin; pageH converts to pdf-lib bottom-up.
 */
function drawOvalBubble(page, panelRect, text, speakerPosition, font, pageH) {
  const sp = speakerPosition || 'left';

  const fontSize = 10;
  const maxTextW = panelRect.w * 0.50;
  const textLines = wrapText(text, font, fontSize, maxTextW);
  const lineH = fontSize * 1.35;
  const textW = Math.max(...textLines.map(l => font.widthOfTextAtSize(l, fontSize)), 50);
  const textH = textLines.length * lineH;

  const padX = 14;
  const padY = 10;
  let bubbleW = Math.max(textW + padX * 2, 70);
  let bubbleH = Math.max(textH + padY * 2, 28);

  // Bubble placed away from speaker; speaker hint for tail direction
  const posMap = {
    'left':         { bx: 0.72, by: 0.18 },
    'right':        { bx: 0.28, by: 0.18 },
    'center':       { bx: 0.50, by: 0.15 },
    'bottom-left':  { bx: 0.72, by: 0.18 },
    'bottom-right': { bx: 0.28, by: 0.18 },
    'top-left':     { bx: 0.72, by: 0.72 },
    'top-right':    { bx: 0.28, by: 0.72 },
  };
  const speakerHint = {
    'left':         { sx: 0.18, sy: 0.45 },
    'right':        { sx: 0.82, sy: 0.45 },
    'center':       { sx: 0.50, sy: 0.60 },
    'bottom-left':  { sx: 0.18, sy: 0.72 },
    'bottom-right': { sx: 0.82, sy: 0.72 },
    'top-left':     { sx: 0.18, sy: 0.28 },
    'top-right':    { sx: 0.82, sy: 0.28 },
  };

  const bpos = posMap[sp] || posMap['left'];
  const spos = speakerHint[sp] || speakerHint['left'];

  let cx = panelRect.x + panelRect.w * bpos.bx;
  let cy = panelRect.y + panelRect.h * bpos.by;

  const margin = 5;
  cx = Math.max(panelRect.x + bubbleW / 2 + margin, Math.min(panelRect.x + panelRect.w - bubbleW / 2 - margin, cx));
  cy = Math.max(panelRect.y + bubbleH / 2 + margin, Math.min(panelRect.y + panelRect.h - bubbleH / 2 - margin, cy));

  const speakerX = panelRect.x + panelRect.w * spos.sx;
  const speakerY = panelRect.y + panelRect.h * spos.sy;

  // Direction from bubble center toward speaker
  const dx = speakerX - cx;
  const dy = speakerY - cy;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const ndx = dx / dist;
  const ndy = dy / dist;

  // Point on ellipse boundary closest to speaker
  const rx = bubbleW / 2;
  const ry = bubbleH / 2;
  const t = Math.atan2(ndy * rx, ndx * ry);
  const edgeX = cx + rx * Math.cos(t);
  const edgeY = cy + ry * Math.sin(t);

  // Short tail — 18pt or 30% of distance, whichever is smaller
  const tailLen = Math.min(18, dist * 0.30);
  const tipX = edgeX + ndx * tailLen;
  const tipY = edgeY + ndy * tailLen;

  // PDF coords (y from bottom)
  const pdfCY = pageH - cy;
  const pdfEdgeY = pageH - edgeY;
  const pdfTipY = pageH - tipY;

  // Ellipse body
  page.drawEllipse({
    x: cx, y: pdfCY,
    xScale: rx, yScale: ry,
    color: rgb(1, 1, 1),
    borderColor: rgb(0.12, 0.12, 0.12),
    borderWidth: 1.25,
  });

  // Tail base spread (perpendicular to direction, at the ellipse edge)
  const tailBaseHalf = 5;
  const perpX = -ndy * tailBaseHalf;
  const perpY = ndx * tailBaseHalf;
  const b1 = { x: edgeX + perpX, y: pdfEdgeY + perpY };
  const b2 = { x: edgeX - perpX, y: pdfEdgeY - perpY };
  const tip = { x: tipX, y: pdfTipY };

  // White fill to erase ellipse border under the tail base
  const FILL_STEPS = 12;
  for (let s = 0; s <= FILL_STEPS; s++) {
    const f = s / FILL_STEPS;
    page.drawLine({
      start: { x: b1.x + (tip.x - b1.x) * f, y: b1.y + (tip.y - b1.y) * f },
      end:   { x: b2.x + (tip.x - b2.x) * f, y: b2.y + (tip.y - b2.y) * f },
      thickness: 1.5, color: rgb(1, 1, 1),
    });
  }
  page.drawLine({ start: b1, end: tip, thickness: 1.25, color: rgb(0.12, 0.12, 0.12) });
  page.drawLine({ start: b2, end: tip, thickness: 1.25, color: rgb(0.12, 0.12, 0.12) });

  // Text centered in bubble
  const textStartY = pdfCY + (textLines.length * lineH) / 2 - fontSize;
  for (let li = 0; li < textLines.length; li++) {
    const line = textLines[li];
    const lw = font.widthOfTextAtSize(line, fontSize);
    page.drawText(line, {
      x: cx - lw / 2,
      y: textStartY - li * lineH,
      size: fontSize, font, color: rgb(0, 0, 0),
    });
  }
}

/**
 * Render a single comic page from a page group { layout, panels }.
 */
async function renderComicPage(pdfDoc, pageGroup, ctx) {
  const { bangersFont, helv, pageH: PAGE_H, pageW: PAGE_W } = ctx;

  const MARGIN_C = 24;
  const GUTTER_C = 8;
  const CONTENT_X = MARGIN_C;
  const CONTENT_W = PAGE_W - MARGIN_C * 2;

  const DPI = 300;
  const px = (pt) => Math.round(pt / 72 * DPI);

  const { layout, panels } = pageGroup;

  // Check if first panel is scene opener (establishing + panelNumber 1)
  const firstPanel = panels[0] || {};
  const isSceneOpener = firstPanel.panelType === 'establishing' && firstPanel.panelNumber === 1;
  const sceneHeaderH = isSceneOpener ? 20 : 0;

  const CONTENT_Y = MARGIN_C;
  const CONTENT_H = PAGE_H - MARGIN_C * 2 - sceneHeaderH;
  const contentTopY = CONTENT_Y + CONTENT_H; // top of content area in PDF coords (bottom-up)

  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);

  // Fill entire page with black (gutters show through)
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: rgb(0, 0, 0) });

  // Scene title header (above content area)
  if (isSceneOpener) {
    const headerY = PAGE_H - MARGIN_C - sceneHeaderH;
    page.drawRectangle({ x: 0, y: headerY, width: PAGE_W, height: sceneHeaderH, color: rgb(0, 0, 0) });
    const sceneLabel = `SCENE ${firstPanel.sceneNumber || ''} \u2014 ${(firstPanel.sceneTitle || '').toUpperCase()}`;
    const slw = bangersFont.widthOfTextAtSize(sceneLabel, 9);
    page.drawText(sceneLabel, {
      x: (PAGE_W - slw) / 2,
      y: headerY + 5,
      size: 9,
      font: bangersFont,
      color: rgb(1, 1, 1),
    });
  }

  // Compute panel rects based on layout (in PDF coordinates: y=0 at bottom)
  let panelRects = [];

  if (layout === 'splash') {
    panelRects = [{ x: CONTENT_X, y: CONTENT_Y, w: CONTENT_W, h: CONTENT_H }];
  } else if (layout === 'strip+2') {
    const stripH = CONTENT_H * 0.18;
    const lower2H = CONTENT_H - stripH - GUTTER_C;
    const panelW = (CONTENT_W - GUTTER_C) / 2;
    // Strip at top (high y in PDF), two panels below
    panelRects = [
      { x: CONTENT_X, y: CONTENT_Y + lower2H + GUTTER_C, w: CONTENT_W, h: stripH },
      { x: CONTENT_X, y: CONTENT_Y, w: panelW, h: lower2H },
      { x: CONTENT_X + panelW + GUTTER_C, y: CONTENT_Y, w: panelW, h: lower2H },
    ];
  } else if (layout === '1large+2small') {
    const largeH = CONTENT_H * 0.55;
    const smallH = CONTENT_H - largeH - GUTTER_C;
    const smallW = (CONTENT_W - GUTTER_C) / 2;
    panelRects = [
      { x: CONTENT_X, y: CONTENT_Y + smallH + GUTTER_C, w: CONTENT_W, h: largeH },
      { x: CONTENT_X, y: CONTENT_Y, w: smallW, h: smallH },
      { x: CONTENT_X + smallW + GUTTER_C, y: CONTENT_Y, w: smallW, h: smallH },
    ];
  } else if (layout === '3equal') {
    const panelH = (CONTENT_H - GUTTER_C * 2) / 3;
    for (let i = 0; i < 3; i++) {
      panelRects.push({ x: CONTENT_X, y: CONTENT_Y + (2 - i) * (panelH + GUTTER_C), w: CONTENT_W, h: panelH });
    }
  } else if (layout === '2equal') {
    const panelH = (CONTENT_H - GUTTER_C) / 2;
    panelRects = [
      { x: CONTENT_X, y: CONTENT_Y + panelH + GUTTER_C, w: CONTENT_W, h: panelH },
      { x: CONTENT_X, y: CONTENT_Y, w: CONTENT_W, h: panelH },
    ];
  } else if (layout === '4equal') {
    const panelW = (CONTENT_W - GUTTER_C) / 2;
    const panelH = (CONTENT_H - GUTTER_C) / 2;
    panelRects = [
      { x: CONTENT_X, y: CONTENT_Y + panelH + GUTTER_C, w: panelW, h: panelH },                         // top-left
      { x: CONTENT_X + panelW + GUTTER_C, y: CONTENT_Y + panelH + GUTTER_C, w: panelW, h: panelH },     // top-right
      { x: CONTENT_X, y: CONTENT_Y, w: panelW, h: panelH },                                              // bottom-left
      { x: CONTENT_X + panelW + GUTTER_C, y: CONTENT_Y, w: panelW, h: panelH },                          // bottom-right
    ];
  } else {
    // Fallback: stack all panels equally
    const panelH = (CONTENT_H - GUTTER_C * Math.max(0, panels.length - 1)) / Math.max(1, panels.length);
    for (let i = 0; i < panels.length; i++) {
      panelRects.push({ x: CONTENT_X, y: CONTENT_Y + (panels.length - 1 - i) * (panelH + GUTTER_C), w: CONTENT_W, h: panelH });
    }
  }

  // Draw each panel
  for (let pi = 0; pi < Math.min(panels.length, panelRects.length); pi++) {
    const panel = panels[pi];
    const rect = panelRects[pi];

    // 1. Draw panel image or placeholder
    if (panel.imageBuffer) {
      try {
        const targetW = px(rect.w);
        const targetH = px(rect.h);
        const resized = await sharp(panel.imageBuffer)
          .resize(targetW, targetH, { fit: 'cover' })
          .jpeg({ quality: 88 })
          .toBuffer();
        const img = await pdfDoc.embedJpg(resized);
        page.drawImage(img, { x: rect.x, y: rect.y, width: rect.w, height: rect.h });
      } catch (_) {
        page.drawRectangle({ x: rect.x, y: rect.y, width: rect.w, height: rect.h, color: rgb(0.722, 0.773, 0.839) });
      }
    } else {
      // Soft blue-grey placeholder (#b8c5d6)
      page.drawRectangle({ x: rect.x, y: rect.y, width: rect.w, height: rect.h, color: rgb(0.722, 0.773, 0.839) });
    }

    // 2. Caption band at top of panel — dynamic height for multi-line narration
    if (panel.caption && panel.caption.trim()) {
      const capFS = 9;
      const capLH = capFS * 1.4;
      const capPadX = 8;
      const capPadY = 5;
      const capLines = wrapText(panel.caption, bangersFont, capFS, rect.w - capPadX * 2);
      const maxBandH = rect.h * 0.30;
      const visibleLines = [];
      let runH = capPadY * 2;
      for (const ln of capLines) {
        if (runH + capLH > maxBandH) break;
        visibleLines.push(ln);
        runH += capLH;
      }
      const bandH = visibleLines.length * capLH + capPadY * 2;
      const captionY = rect.y + rect.h - bandH;
      page.drawRectangle({ x: rect.x, y: captionY, width: rect.w, height: bandH, color: rgb(0.102, 0.102, 0.180) });
      let ty = captionY + bandH - capPadY - capFS;
      for (const ln of visibleLines) {
        page.drawText(ln, { x: rect.x + capPadX, y: ty, size: capFS, font: bangersFont, color: rgb(1, 1, 1) });
        ty -= capLH;
      }
    }

    // 3. Speech bubble
    if (panel.dialogue && panel.dialogue.trim()) {
      // Convert panel rect to top-left coordinate system for bubble positioning
      const bubbleRect = {
        x: rect.x,
        y: PAGE_H - rect.y - rect.h, // convert to top-down y
        w: rect.w,
        h: rect.h,
      };
      drawOvalBubble(page, bubbleRect, panel.dialogue, panel.speakerPosition, bangersFont, PAGE_H);
    }
  }

  // Page number
  const pgNum = `${pdfDoc.getPageCount()}`;
  const pnw = helv.widthOfTextAtSize(pgNum, 8);
  page.drawText(pgNum, { x: (PAGE_W - pnw) / 2, y: 6, size: 8, font: helv, color: rgb(0.6, 0.6, 0.6) });
}

async function drawGraphicNovelPanelImage(pdfDoc, page, panel, blueprint) {
  const rect = blueprint.rect;
  const shadowOff = 2;
  // Drop shadow behind panel
  page.drawRectangle({
    x: rect.x + shadowOff, y: rect.y - shadowOff,
    width: rect.w, height: rect.h,
    color: rgb(0.75, 0.75, 0.75),
  });
  // White panel backing
  page.drawRectangle({ x: rect.x, y: rect.y, width: rect.w, height: rect.h, color: rgb(1, 1, 1) });
  if (!panel.imageBuffer) {
    page.drawRectangle({ x: rect.x, y: rect.y, width: rect.w, height: rect.h, color: rgb(0.88, 0.90, 0.93) });
  } else {
    try {
      const targetW = Math.round(rect.w / 72 * 300);
      const targetH = Math.round(rect.h / 72 * 300);
      const resized = await sharp(panel.imageBuffer)
        .resize(targetW, targetH, { fit: 'cover' })
        .jpeg({ quality: 90 })
        .toBuffer();
      // Free the original download buffer — only the resized JPEG is needed
      panel.imageBuffer = null;
      const img = await pdfDoc.embedJpg(resized);
      page.drawImage(img, { x: rect.x, y: rect.y, width: rect.w, height: rect.h });
    } catch (embedErr) {
      console.warn(`[layoutEngine] Panel embed failed: ${embedErr.message}`);
      page.drawRectangle({ x: rect.x, y: rect.y, width: rect.w, height: rect.h, color: rgb(0.88, 0.90, 0.93) });
    }
  }
  // Dark panel border
  const bw = 2.5;
  const borderColor = rgb(0.08, 0.08, 0.12);
  page.drawRectangle({ x: rect.x, y: rect.y, width: rect.w, height: bw, color: borderColor }); // bottom
  page.drawRectangle({ x: rect.x, y: rect.y + rect.h - bw, width: rect.w, height: bw, color: borderColor }); // top
  page.drawRectangle({ x: rect.x, y: rect.y, width: bw, height: rect.h, color: borderColor }); // left
  page.drawRectangle({ x: rect.x + rect.w - bw, y: rect.y, width: bw, height: rect.h, color: borderColor }); // right
}

/**
 * Render a text-rich interstitial page (scene opener, internal monologue, letter/diary, narrator aside).
 * These are programmatic pages with beautiful typography — no AI-generated image needed.
 */
function renderTextInterstitialPage(pdfDoc, pageData, fonts, pageW, pageH) {
  const page = pdfDoc.addPage([pageW, pageH]);
  const type = pageData.interstitialType || 'scene_opener';
  const goldColor = rgb(0.765, 0.549, 0.180);
  const inkColor = rgb(0.08, 0.08, 0.12);
  const subtleGray = rgb(0.45, 0.45, 0.50);
  const margin = 60;
  const textWidth = pageW - margin * 2;

  if (type === 'letter_or_diary') {
    // Parchment-style background with handwritten feel
    page.drawRectangle({ x: 0, y: 0, width: pageW, height: pageH, color: rgb(0.96, 0.94, 0.88) });
    // Subtle border
    const inset = 36;
    page.drawRectangle({ x: inset, y: inset, width: pageW - inset * 2, height: pageH - inset * 2, borderColor: rgb(0.80, 0.73, 0.62), borderWidth: 0.8 });

    // Heading (if provided)
    if (pageData.heading) {
      const headFont = fonts.accentFont || fonts.bodyFont;
      const headLines = wrapText(pageData.heading, headFont, 16, textWidth);
      let y = pageH - margin - 40;
      for (const line of headLines) {
        const w = headFont.widthOfTextAtSize(line, 16);
        page.drawText(line, { x: (pageW - w) / 2, y, size: 16, font: headFont, color: inkColor });
        y -= 24;
      }
    }

    // Body text in handwritten-style font
    if (pageData.bodyText) {
      const bodyFont = fonts.handwrittenFont || fonts.accentFont || fonts.bodyFont;
      const bodyLines = wrapText(pageData.bodyText, bodyFont, 13, textWidth - 20);
      let y = pageH / 2 + (bodyLines.length * 10);
      for (const line of bodyLines) {
        page.drawText(line, { x: margin + 10, y, size: 13, font: bodyFont, color: rgb(0.20, 0.18, 0.15) });
        y -= 20;
      }
    }
  } else if (type === 'internal_monologue') {
    // Moody, contemplative page
    page.drawRectangle({ x: 0, y: 0, width: pageW, height: pageH, color: rgb(0.95, 0.95, 0.97) });

    // Gold left accent bar
    page.drawRectangle({ x: margin - 8, y: pageH / 2 - 80, width: 3, height: 160, color: goldColor });

    // Body text in italic
    if (pageData.bodyText) {
      const bodyFont = fonts.accentFont || fonts.bodyFont;
      const bodyLines = wrapText(pageData.bodyText, bodyFont, 13, textWidth - 30);
      let y = pageH / 2 + (bodyLines.length * 10);
      for (const line of bodyLines) {
        page.drawText(line, { x: margin + 10, y, size: 13, font: bodyFont, color: rgb(0.15, 0.15, 0.20) });
        y -= 21;
      }
    }

    // Attribution (character name)
    if (pageData.heading) {
      const attrFont = fonts.bodyFont;
      const attrText = `\u2014 ${pageData.heading}`;
      const attrW = attrFont.widthOfTextAtSize(attrText, 10);
      page.drawText(attrText, { x: pageW - margin - attrW, y: pageH / 2 - 100, size: 10, font: attrFont, color: subtleGray });
    }
  } else if (type === 'narrator_aside') {
    // Clean, centered prose
    page.drawRectangle({ x: 0, y: 0, width: pageW, height: pageH, color: rgb(0.98, 0.97, 0.95) });

    // Decorative diamond ornament
    const cx = pageW / 2;
    const ornY = pageH / 2 + 100;
    page.drawLine({ start: { x: cx - 4, y: ornY }, end: { x: cx, y: ornY + 4 }, thickness: 1, color: goldColor });
    page.drawLine({ start: { x: cx, y: ornY + 4 }, end: { x: cx + 4, y: ornY }, thickness: 1, color: goldColor });
    page.drawLine({ start: { x: cx + 4, y: ornY }, end: { x: cx, y: ornY - 4 }, thickness: 1, color: goldColor });
    page.drawLine({ start: { x: cx, y: ornY - 4 }, end: { x: cx - 4, y: ornY }, thickness: 1, color: goldColor });

    // Body text centered
    if (pageData.bodyText) {
      const bodyFont = fonts.accentFont || fonts.bodyFont;
      const bodyLines = wrapText(pageData.bodyText, bodyFont, 13, textWidth - 40);
      let y = ornY - 30;
      for (const line of bodyLines) {
        const w = bodyFont.widthOfTextAtSize(line, 13);
        page.drawText(line, { x: (pageW - w) / 2, y, size: 13, font: bodyFont, color: rgb(0.15, 0.15, 0.20) });
        y -= 21;
      }
    }
  } else {
    // scene_opener (default) — chapter title + atmospheric prose
    page.drawRectangle({ x: 0, y: 0, width: pageW, height: pageH, color: rgb(0.97, 0.96, 0.94) });

    // Decorative border
    const inset = 30;
    page.drawRectangle({ x: inset, y: inset, width: pageW - inset * 2, height: pageH - inset * 2, borderColor: inkColor, borderWidth: 1.5 });
    page.drawRectangle({ x: inset + 5, y: inset + 5, width: pageW - (inset + 5) * 2, height: pageH - (inset + 5) * 2, borderColor: goldColor, borderWidth: 0.8 });

    // Chapter heading
    if (pageData.heading) {
      const headFont = fonts.titleFont || fonts.bodyFont;
      const headSize = 28;
      const headLines = wrapText(pageData.heading, headFont, headSize, textWidth);
      let y = pageH / 2 + 80;
      for (const line of headLines) {
        const w = headFont.widthOfTextAtSize(line, headSize);
        page.drawText(line, { x: (pageW - w) / 2, y, size: headSize, font: headFont, color: inkColor });
        y -= 36;
      }

      // Gold rule
      const ruleY = y + 14;
      page.drawRectangle({ x: (pageW - 80) / 2, y: ruleY, width: 80, height: 1.2, color: goldColor });

      // Subheading
      if (pageData.subheading) {
        const subFont = fonts.accentFont || fonts.bodyFont;
        const subW = subFont.widthOfTextAtSize(pageData.subheading, 14);
        page.drawText(pageData.subheading, { x: (pageW - subW) / 2, y: ruleY - 24, size: 14, font: subFont, color: subtleGray });
      }
    }

    // Body text
    if (pageData.bodyText) {
      const bodyFont = fonts.accentFont || fonts.bodyFont;
      const bodyLines = wrapText(pageData.bodyText, bodyFont, 12, textWidth - 20);
      let y = pageH / 2 - 50;
      for (const line of bodyLines) {
        const w = bodyFont.widthOfTextAtSize(line, 12);
        page.drawText(line, { x: (pageW - w) / 2, y, size: 12, font: bodyFont, color: rgb(0.20, 0.20, 0.25) });
        y -= 19;
      }
    }
  }
}

/**
 * Render a single graphic novel story page by embedding the full-page AI-generated image.
 * The image includes panels, borders, speech bubbles, captions, and SFX — all rendered by Gemini.
 */
async function renderGraphicNovelStoryPage(pdfDoc, pageData, pageW, pageH) {
  const page = pdfDoc.addPage([pageW, pageH]);

  if (!pageData.imageBuffer) {
    // Placeholder if image is missing
    page.drawRectangle({ x: 0, y: 0, width: pageW, height: pageH, color: rgb(0.88, 0.90, 0.93) });
    return;
  }

  try {
    // Embed full-page image at 300 DPI
    const targetW = Math.round(pageW / 72 * 300);
    const targetH = Math.round(pageH / 72 * 300);
    const resized = await sharp(pageData.imageBuffer)
      .resize(targetW, targetH, { fit: 'cover' })
      .jpeg({ quality: 92 })
      .toBuffer();
    pageData.imageBuffer = null; // Free original buffer
    const img = await pdfDoc.embedJpg(resized);
    page.drawImage(img, { x: 0, y: 0, width: pageW, height: pageH });
  } catch (embedErr) {
    console.warn(`[layoutEngine] Page embed failed: ${embedErr.message}`);
    page.drawRectangle({ x: 0, y: 0, width: pageW, height: pageH, color: rgb(0.88, 0.90, 0.93) });
  }
}

/**
 * Build a print-ready graphic novel PDF with full-page AI-generated images.
 * Each story page is a single full-page image (panels, text, bubbles all baked in by Gemini).
 * @param {Array} _unused - Legacy parameter, no longer used
 * @param {object} opts - { title, childName, tagline, dedication, year, pages, upsellCovers, bookId }
 */
async function buildGraphicNovelPdf(_unused, opts = {}) {
  const { title = 'My Graphic Novel', childName = '', tagline = '', dedication = '', year = new Date().getFullYear(), upsellCovers, bookId } = opts;

  const PAGE_W = 450;  // 6.25" with bleed
  const PAGE_H = 666;  // 9.25" with bleed

  const srcPages = Array.isArray(opts.pages) ? opts.pages : [];

  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  pdfDoc.setTitle(title);
  pdfDoc.setAuthor('GiftMyBook');

  // Fonts for title/dedication/end pages and text interstitial pages
  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  let bubblegum = helvBold;
  let playfair = helv;
  let playfairItalic = helv;
  let kalam = helv;
  try {
    if (fs.existsSync(FONT_PATHS.bubblegum)) bubblegum = await pdfDoc.embedFont(fs.readFileSync(FONT_PATHS.bubblegum));
    if (fs.existsSync(FONT_PATHS.playfair)) playfair = await pdfDoc.embedFont(fs.readFileSync(FONT_PATHS.playfair));
    if (fs.existsSync(FONT_PATHS.playfairItalic)) playfairItalic = await pdfDoc.embedFont(fs.readFileSync(FONT_PATHS.playfairItalic));
    if (fs.existsSync(FONT_PATHS.kalam)) kalam = await pdfDoc.embedFont(fs.readFileSync(FONT_PATHS.kalam));
  } catch (_) {}

  const fonts = {
    titleFont: bubblegum || helvBold,
    bodyFont: helv,
    accentFont: playfairItalic || helv,
    handwrittenFont: kalam || helv,
  };

  // ── Helper: decorative double-line border ──
  const goldColor = rgb(0.765, 0.549, 0.180);
  const inkColor = rgb(0.08, 0.08, 0.12);
  function drawDecorativeBorder(p, pw, ph) {
    const inset = 30;
    p.drawRectangle({ x: inset, y: inset, width: pw - inset * 2, height: ph - inset * 2, borderColor: inkColor, borderWidth: 2 });
    p.drawRectangle({ x: inset + 6, y: inset + 6, width: pw - (inset + 6) * 2, height: ph - (inset + 6) * 2, borderColor: goldColor, borderWidth: 1 });
  }
  function drawGoldRule(p, y, pw, w) {
    const ruleW = w || 80;
    p.drawRectangle({ x: (pw - ruleW) / 2, y, width: ruleW, height: 1.2, color: goldColor });
  }
  function drawGoldDiamond(p, x, y, size) {
    const s = size || 4;
    p.drawLine({ start: { x: x - s, y }, end: { x, y: y + s }, thickness: 1.2, color: goldColor });
    p.drawLine({ start: { x, y: y + s }, end: { x: x + s, y }, thickness: 1.2, color: goldColor });
    p.drawLine({ start: { x: x + s, y }, end: { x, y: y - s }, thickness: 1.2, color: goldColor });
    p.drawLine({ start: { x, y: y - s }, end: { x: x - s, y }, thickness: 1.2, color: goldColor });
  }

  // Title page
  {
    const p = pdfDoc.addPage([PAGE_W, PAGE_H]);
    p.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: rgb(1, 1, 1) });
    drawDecorativeBorder(p, PAGE_W, PAGE_H);

    const diamondY = PAGE_H / 2 + 110;
    drawGoldDiamond(p, PAGE_W / 2 - 20, diamondY, 3);
    drawGoldDiamond(p, PAGE_W / 2, diamondY, 4);
    drawGoldDiamond(p, PAGE_W / 2 + 20, diamondY, 3);

    const titleLines = wrapText(title, fonts.titleFont, 32, PAGE_W - 100);
    let y = PAGE_H / 2 + 70;
    for (const line of titleLines) {
      const width = fonts.titleFont.widthOfTextAtSize(line, 32);
      p.drawText(line, { x: (PAGE_W - width) / 2, y, size: 32, font: fonts.titleFont, color: inkColor });
      y -= 40;
    }

    drawGoldRule(p, y + 10, PAGE_W, 100);

    if (tagline) {
      const lines = wrapText(tagline, fonts.accentFont, 12, PAGE_W - 110);
      let ty = y - 16;
      for (const line of lines.slice(0, 3)) {
        const width = fonts.accentFont.widthOfTextAtSize(line, 12);
        p.drawText(line, { x: (PAGE_W - width) / 2, y: ty, size: 12, font: fonts.accentFont, color: rgb(0.35, 0.35, 0.40) });
        ty -= 18;
      }
    }

    const sub = `A personalized graphic novel for ${childName}`;
    const subWidth = fonts.bodyFont.widthOfTextAtSize(sub, 11);
    p.drawText(sub, { x: (PAGE_W - subWidth) / 2, y: 60, size: 11, font: fonts.bodyFont, color: goldColor });
    const yearText = `${year} \u00B7 GiftMyBook`;
    const yearWidth = fonts.bodyFont.widthOfTextAtSize(yearText, 8);
    p.drawText(yearText, { x: (PAGE_W - yearWidth) / 2, y: 40, size: 8, font: fonts.bodyFont, color: rgb(0.55, 0.55, 0.60) });
  }

  if (dedication) {
    const p = pdfDoc.addPage([PAGE_W, PAGE_H]);
    p.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: rgb(0.99, 0.98, 0.96) });
    const inset = 40;
    p.drawRectangle({ x: inset, y: inset, width: PAGE_W - inset * 2, height: PAGE_H - inset * 2, borderColor: goldColor, borderWidth: 0.8, color: undefined });

    const lines = wrapText(dedication, fonts.accentFont, 14, PAGE_W - 130);
    let y = PAGE_H / 2 + lines.length * 10;
    for (const line of lines) {
      const width = fonts.accentFont.widthOfTextAtSize(line, 14);
      p.drawText(line, { x: (PAGE_W - width) / 2, y, size: 14, font: fonts.accentFont, color: rgb(0.12, 0.12, 0.16) });
      y -= 22;
    }
  }

  // Story pages — illustrated pages are full-page AI images (text baked in), text interstitials are programmatic
  for (let i = 0; i < srcPages.length; i++) {
    if (srcPages[i].pageType === 'text_interstitial') {
      renderTextInterstitialPage(pdfDoc, srcPages[i], fonts, PAGE_W, PAGE_H);
    } else {
      await renderGraphicNovelStoryPage(pdfDoc, srcPages[i], PAGE_W, PAGE_H);
    }
    if ((i + 1) % 10 === 0 || i === srcPages.length - 1) {
      const mem = process.memoryUsage();
      console.log(`[layoutEngine] Rendered page ${i + 1}/${srcPages.length} (heap=${Math.round(mem.heapUsed / 1024 / 1024)}MB, rss=${Math.round(mem.rss / 1024 / 1024)}MB)`);
    }
  }

  // ── Upsell spread (QR covers) ──
  if (upsellCovers && upsellCovers.length > 0) {
    const upsellFonts = { playfair, playfairItalic, helv, helvB: helvBold };
    await buildUpsellSpread(pdfDoc, PAGE_W, PAGE_H, upsellFonts, { upsellCovers, childName, bookId });
  }

  // End page
  {
    const p = pdfDoc.addPage([PAGE_W, PAGE_H]);
    p.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: rgb(1, 1, 1) });
    drawDecorativeBorder(p, PAGE_W, PAGE_H);

    const main = 'The End';
    const mainWidth = fonts.accentFont.widthOfTextAtSize(main, 36);
    p.drawText(main, { x: (PAGE_W - mainWidth) / 2, y: PAGE_H / 2 + 14, size: 36, font: fonts.accentFont, color: inkColor });

    drawGoldRule(p, PAGE_H / 2 - 6, PAGE_W, 80);

    const sub = `${childName}'s story`;
    const subWidth = fonts.accentFont.widthOfTextAtSize(sub, 12);
    p.drawText(sub, { x: (PAGE_W - subWidth) / 2, y: PAGE_H / 2 - 28, size: 12, font: fonts.accentFont, color: goldColor });

    drawGoldDiamond(p, PAGE_W / 2 - 20, PAGE_H / 2 - 56, 3);
    drawGoldDiamond(p, PAGE_W / 2, PAGE_H / 2 - 56, 4);
    drawGoldDiamond(p, PAGE_W / 2 + 20, PAGE_H / 2 - 56, 3);

    const brand = `${year} \u00B7 GiftMyBook`;
    const brandWidth = fonts.bodyFont.widthOfTextAtSize(brand, 8);
    p.drawText(brand, { x: (PAGE_W - brandWidth) / 2, y: 40, size: 8, font: fonts.bodyFont, color: rgb(0.55, 0.55, 0.60) });
  }

  while (pdfDoc.getPageCount() % 2 !== 0) {
    pdfDoc.addPage([PAGE_W, PAGE_H]);
  }

  console.log(`[layoutEngine] Graphic novel PDF ready to save: ${pdfDoc.getPageCount()} pages`);
  try {
    return Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
  } catch (saveErr) {
    if (!saveErr.message.includes('Invalid string length')) throw saveErr;

    // pdf-lib hit V8 string limit — rebuild with quality 80 (still 300 DPI)
    console.warn(`[layoutEngine] PDF save failed (${saveErr.message}), retrying at quality 80`);
    const retryDoc = await PDFDocument.create();
    retryDoc.registerFontkit(fontkit);

    const retryFonts = {};
    retryFonts.bodyFont = await retryDoc.embedFont(StandardFonts.Helvetica);
    retryFonts.titleFont = await retryDoc.embedFont(StandardFonts.HelveticaBold);
    retryFonts.accentFont = retryFonts.bodyFont;
    try { if (fs.existsSync(FONT_PATHS.bubblegum)) retryFonts.titleFont = await retryDoc.embedFont(fs.readFileSync(FONT_PATHS.bubblegum)); } catch (_) {}
    try { if (fs.existsSync(FONT_PATHS.playfairItalic)) retryFonts.accentFont = await retryDoc.embedFont(fs.readFileSync(FONT_PATHS.playfairItalic)); } catch (_) {}

    // Re-download page images from GCS (originals were freed during first attempt)
    const { downloadBuffer: dlBuf } = require('./gcsStorage');
    for (const page of srcPages) {
      if (!page.imageBuffer && page.illustrationUrl) {
        try { page.imageBuffer = await dlBuf(page.illustrationUrl); }
        catch (_) { page.imageBuffer = null; }
      }
    }

    // Title page (simplified)
    const tp = retryDoc.addPage([PAGE_W, PAGE_H]);
    tp.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: rgb(1, 1, 1) });
    const titleLines2 = wrapText(title, retryFonts.titleFont, 32, PAGE_W - 100);
    let ty2 = PAGE_H / 2 + 70;
    for (const line of titleLines2) {
      const w = retryFonts.titleFont.widthOfTextAtSize(line, 32);
      tp.drawText(line, { x: (PAGE_W - w) / 2, y: ty2, size: 32, font: retryFonts.titleFont, color: rgb(0.08, 0.08, 0.12) });
      ty2 -= 40;
    }

    // Story pages at quality 80 — full-page images
    for (let i = 0; i < srcPages.length; i++) {
      const pageData = srcPages[i];
      const pg = retryDoc.addPage([PAGE_W, PAGE_H]);
      if (pageData.imageBuffer) {
        try {
          const tw = Math.round(PAGE_W / 72 * 300);
          const th = Math.round(PAGE_H / 72 * 300);
          const resized = await sharp(pageData.imageBuffer)
            .resize(tw, th, { fit: 'cover' })
            .jpeg({ quality: 80 })
            .toBuffer();
          pageData.imageBuffer = null;
          const img = await retryDoc.embedJpg(resized);
          pg.drawImage(img, { x: 0, y: 0, width: PAGE_W, height: PAGE_H });
        } catch (_) {
          pg.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: rgb(0.88, 0.90, 0.93) });
        }
      } else {
        pg.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: rgb(0.88, 0.90, 0.93) });
      }
    }

    while (retryDoc.getPageCount() % 2 !== 0) retryDoc.addPage([PAGE_W, PAGE_H]);
    console.log(`[layoutEngine] Retry PDF saving: ${retryDoc.getPageCount()} pages at quality 80`);
    return Buffer.from(await retryDoc.save({ useObjectStreams: false }));
  }
}

module.exports = { assemblePdf, buildChapterBookPdf, buildGraphicNovelPdf, FORMATS };
