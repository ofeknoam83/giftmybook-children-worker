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
    drawCentered(p, `From ${fromLabel}`, dedFont, FROM_SZ, y, C.brownMid);
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

// ── Graphic Novel V2 — Multi-panel professional layout engine ─────────────────
const { getTemplate, PAGE_W: GN_PAGE_W, PAGE_H: GN_PAGE_H, MARGIN: GN_MARGIN, GUTTER: GN_GUTTER } = require('./gnPageTemplates');
const { renderPanelOverlays } = require('./gnBubbleRenderer');

const PANEL_BORDER_W = 1.5;
const PANEL_BORDER_COLOR = rgb(0.05, 0.05, 0.1);
const GN_PAGE_NUM_SIZE = 8;
const GN_PAGE_NUM_COLOR = rgb(0.55, 0.55, 0.6);

/** Load embedded comic font from local file (no network download). */
let _comicFontCache = null;
function getComicFontBytes() {
  if (_comicFontCache) return _comicFontCache;
  const fontPath = path.join(__dirname, '..', 'fonts', 'ComicNeue-Bold.ttf');
  _comicFontCache = fs.readFileSync(fontPath);
  return _comicFontCache;
}

/**
 * Embed a panel image into a panel rect, cover-cropping to fill.
 */
async function embedPanelImage(pdfDoc, page, imageBuffer, panelRect) {
  if (!imageBuffer) {
    // Placeholder — light gray
    page.drawRectangle({
      x: panelRect.x, y: panelRect.y,
      width: panelRect.w, height: panelRect.h,
      color: rgb(0.92, 0.92, 0.94),
    });
    return;
  }

  try {
    // Resize image to exact panel dimensions with cover crop
    const resizedBuf = await sharp(imageBuffer)
      .resize(Math.round(panelRect.w * 3), Math.round(panelRect.h * 3), { fit: 'cover', position: 'center' })
      .jpeg({ quality: 93 })
      .toBuffer();

    let pdfImage;
    try { pdfImage = await pdfDoc.embedJpg(resizedBuf); }
    catch { pdfImage = await pdfDoc.embedPng(imageBuffer); }

    page.drawImage(pdfImage, {
      x: panelRect.x, y: panelRect.y,
      width: panelRect.w, height: panelRect.h,
    });
  } catch (e) {
    console.warn(`[LayoutEngine] Panel image embed failed: ${e.message}`);
    page.drawRectangle({
      x: panelRect.x, y: panelRect.y,
      width: panelRect.w, height: panelRect.h,
      color: rgb(0.92, 0.92, 0.94),
    });
  }
}

/**
 * Render a multi-panel story page.
 */
async function renderGnStoryPage(pdfDoc, pageData, font, pageNum) {
  const page = pdfDoc.addPage([GN_PAGE_W, GN_PAGE_H]);

  // White background
  page.drawRectangle({ x: 0, y: 0, width: GN_PAGE_W, height: GN_PAGE_H, color: rgb(1, 1, 1) });

  const template = getTemplate(pageData.layout);
  const panels = pageData.panels || [];

  for (let i = 0; i < template.panels.length; i++) {
    const tPanel = template.panels[i];
    const panelData = panels[i] || {};

    // Embed panel illustration
    await embedPanelImage(pdfDoc, page, panelData.imageBuffer, tPanel);

    // Draw panel border (skip for bleed panels)
    if (!tPanel.bleed) {
      page.drawRectangle({
        x: tPanel.x, y: tPanel.y,
        width: tPanel.w, height: tPanel.h,
        borderColor: PANEL_BORDER_COLOR,
        borderWidth: PANEL_BORDER_W,
      });
    }

    // Render dialogue bubbles, captions, SFX overlays
    renderPanelOverlays(page, panelData, tPanel, font);
  }

  // Page number — bottom center
  const numStr = String(pageNum);
  const nw = font.widthOfTextAtSize(numStr, GN_PAGE_NUM_SIZE);
  page.drawText(numStr, {
    x: (GN_PAGE_W - nw) / 2,
    y: 12,
    size: GN_PAGE_NUM_SIZE, font, color: GN_PAGE_NUM_COLOR,
  });
}

/**
 * Add graphic novel title page — clean white design.
 */
function addGnTitlePage(pdfDoc, title, subtitle, font) {
  const page = pdfDoc.addPage([GN_PAGE_W, GN_PAGE_H]);
  page.drawRectangle({ x: 0, y: 0, width: GN_PAGE_W, height: GN_PAGE_H, color: rgb(1, 1, 1) });

  // Title
  const titleSize = 32;
  const maxTitleW = GN_PAGE_W - 80;
  const words = (title || '').split(/\s+/);
  const titleLines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(test, titleSize) > maxTitleW && cur) { titleLines.push(cur); cur = w; }
    else cur = test;
  }
  if (cur) titleLines.push(cur);

  let ty = GN_PAGE_H / 2 + 60;
  for (const line of titleLines) {
    const lw = font.widthOfTextAtSize(line, titleSize);
    page.drawText(line, { x: (GN_PAGE_W - lw) / 2, y: ty, size: titleSize, font, color: rgb(0.08, 0.08, 0.12) });
    ty -= 42;
  }

  // Gold rule
  const ruleW = 80;
  page.drawRectangle({ x: (GN_PAGE_W - ruleW) / 2, y: ty + 10, width: ruleW, height: 2, color: rgb(0.76, 0.55, 0.18) });

  if (subtitle) {
    const subText = subtitle.length > 70 ? subtitle.slice(0, 67) + '...' : subtitle;
    const sw = font.widthOfTextAtSize(subText, 11);
    page.drawText(subText, { x: Math.max(10, (GN_PAGE_W - sw) / 2), y: ty - 16, size: 11, font, color: rgb(0.4, 0.4, 0.45) });
  }

  const gmb = 'GiftMyBook';
  const gw = font.widthOfTextAtSize(gmb, 10);
  page.drawText(gmb, { x: (GN_PAGE_W - gw) / 2, y: 30, size: 10, font, color: rgb(0.5, 0.5, 0.55) });
}

/**
 * Add graphic novel dedication page — clean white.
 */
function addGnDedicationPage(pdfDoc, dedication, bookFrom, font) {
  const page = pdfDoc.addPage([GN_PAGE_W, GN_PAGE_H]);
  page.drawRectangle({ x: 0, y: 0, width: GN_PAGE_W, height: GN_PAGE_H, color: rgb(1, 1, 1) });

  const dedWords = (dedication || '').split(/\s+/);
  const dedLines = [];
  let cur = '';
  for (const w of dedWords) {
    const test = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(test, 13) > GN_PAGE_W - 90 && cur) { dedLines.push(cur); cur = w; }
    else cur = test;
  }
  if (cur) dedLines.push(cur);

  const totalH = dedLines.length * 20;
  let dy = GN_PAGE_H / 2 + totalH / 2;
  for (const line of dedLines) {
    const lw = font.widthOfTextAtSize(line, 13);
    page.drawText(line, { x: (GN_PAGE_W - lw) / 2, y: dy, size: 13, font, color: rgb(0.15, 0.15, 0.2) });
    dy -= 20;
  }

  if (bookFrom) {
    const fromText = `— ${bookFrom}`;
    const fw = font.widthOfTextAtSize(fromText, 10);
    page.drawText(fromText, { x: (GN_PAGE_W - fw) / 2, y: dy - 14, size: 10, font, color: rgb(0.45, 0.45, 0.5) });
  }
}

/**
 * Add graphic novel end page — clean white with "The End".
 */
function addGnEndPage(pdfDoc, childName, font) {
  const page = pdfDoc.addPage([GN_PAGE_W, GN_PAGE_H]);
  page.drawRectangle({ x: 0, y: 0, width: GN_PAGE_W, height: GN_PAGE_H, color: rgb(1, 1, 1) });

  const endSize = 40;
  const part1 = 'The ';
  const part2 = 'End';
  const totalW = font.widthOfTextAtSize(part1 + part2, endSize);
  const endColor = rgb(0.08, 0.08, 0.12);
  page.drawText(part1, { x: (GN_PAGE_W - totalW) / 2, y: GN_PAGE_H / 2 + 10, size: endSize, font, color: endColor });
  page.drawText(part2, { x: (GN_PAGE_W - totalW) / 2 + font.widthOfTextAtSize(part1, endSize), y: GN_PAGE_H / 2 + 10, size: endSize, font, color: endColor });

  // Gold rule
  const ruleW = 60;
  page.drawRectangle({ x: (GN_PAGE_W - ruleW) / 2, y: GN_PAGE_H / 2 - 8, width: ruleW, height: 2, color: rgb(0.76, 0.55, 0.18) });

  if (childName) {
    const subText = `${childName}'s story`;
    const sw = font.widthOfTextAtSize(subText, 12);
    page.drawText(subText, { x: (GN_PAGE_W - sw) / 2, y: GN_PAGE_H / 2 - 32, size: 12, font, color: rgb(0.5, 0.5, 0.55) });
  }

  const gmb = 'GiftMyBook';
  const gw = font.widthOfTextAtSize(gmb, 9);
  page.drawText(gmb, { x: (GN_PAGE_W - gw) / 2, y: 28, size: 9, font, color: rgb(0.55, 0.55, 0.6) });
}

/**
 * Build a 7×10" graphic novel PDF from page-level story data.
 *
 * @param {Array} pages - storyPlan.pages (page-level data with panels)
 * @param {object} opts - { title, subtitle, childName, bookFrom, dedication }
 */
async function buildGraphicNovelPdf(pages, opts = {}) {
  const allPages = pages || [];

  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  // Embed comic font from local file
  let comicFont;
  try {
    const fontBuf = getComicFontBytes();
    comicFont = await pdfDoc.embedFont(fontBuf);
  } catch (e) {
    console.warn('[LayoutEngine] Comic font load failed, using Helvetica Bold:', e.message);
    comicFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  }

  // Title page
  addGnTitlePage(pdfDoc, opts.title || 'My Graphic Novel', opts.subtitle || '', comicFont);

  // Dedication page
  if (opts.dedication) {
    addGnDedicationPage(pdfDoc, opts.dedication, opts.bookFrom, comicFont);
  }

  // Story pages
  let pageNum = 1;
  for (const pageData of allPages) {
    await renderGnStoryPage(pdfDoc, pageData, comicFont, pageNum);
    pageNum++;
  }

  // End page
  addGnEndPage(pdfDoc, opts.childName || '', comicFont);

  // Pad to even page count for binding
  while (pdfDoc.getPageCount() % 2 !== 0) {
    const blank = pdfDoc.addPage([GN_PAGE_W, GN_PAGE_H]);
    blank.drawRectangle({ x: 0, y: 0, width: GN_PAGE_W, height: GN_PAGE_H, color: rgb(1, 1, 1) });
  }

  return Buffer.from(await pdfDoc.save());
}

module.exports = { assemblePdf, buildChapterBookPdf, buildGraphicNovelPdf, FORMATS };
