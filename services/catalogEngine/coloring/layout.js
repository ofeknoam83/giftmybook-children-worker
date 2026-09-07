/**
 * The printed coloring book (cb-1, docs/COLORING_BOOK_V2_PLAN.md §4.8) —
 * pdf-lib, the layoutEngine conventions, and Lulu's print-ready rules
 * encoded as constants and a PREFLIGHT the callback reports:
 *
 *  - Interior: US Letter trim 8.5×11 in + 0.125 in bleed on every side ⇒
 *    every page 8.75×11.25 in (630×810 pt), identical size, no printer
 *    marks, the cover NOT included; all text and important art inside
 *    Lulu's 0.25 in safety margin (this layout keeps 0.5 in); saddle stitch
 *    ⇒ page count a multiple of 4 within 4–48 (padded with white pages);
 *    images at 300 PPI (a page below the floor is upscaled to it, never
 *    printed soft, and the effective PPI is reported); fonts embedded;
 *    interior ink in DeviceGray (a B&W interior never carries RGB black).
 *  - Cover: ONE page, the saddle-stitch wrap without a spine — 2 × 8.5 in
 *    + 0.125 in bleed each side = 17.25 × 11.25 in (1242×810 pt); back on
 *    the left, front on the right; every word ≥ 0.5 in from the trim edges
 *    and the fold; no barcode (we do not print an ISBN).
 *  - The art box: 7.5 × 9.75 in inside the safety margin; a 3:4 render is
 *    scaled to the width and the 1.25% overflow top and bottom is cropped
 *    with sharp before embedding — never stretched.
 *  - Words are PDF type, never pixels (D5): the page caption in Kalam, the
 *    matter pages in Bubblegum / Kalam / Liberation Sans over the border
 *    plate (or a typeset double rule when the plate is unavailable).
 *  - The cover never comes from a model: the approved cover's OWN pixels
 *    (which already carry the painted title) on a palette band derived from
 *    the art, "COLORING BOOK" and the child line typeset.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { PDFDocument, rgb, grayscale } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const PT = 72;
/** Lulu print spec for the coloring product (SKU 0850X1100BWSTDSS060UW444MXX). */
const LULU_SPEC = Object.freeze({
  trimWidthIn: 8.5,
  trimHeightIn: 11,
  bleedIn: 0.125,
  safetyMarginIn: 0.25,
  layoutSafetyIn: 0.5,
  minPages: 4,
  maxPages: 48,
  pageMultiple: 4,
  targetPpi: 300,
  minPpi: 150,
  minTextPt: 6,
  minLinePt: 0.25,
});
const TRIM_W = LULU_SPEC.trimWidthIn * PT;
const TRIM_H = LULU_SPEC.trimHeightIn * PT;
const BLEED = LULU_SPEC.bleedIn * PT;
const PAGE_W = TRIM_W + BLEED * 2; // 630
const PAGE_H = TRIM_H + BLEED * 2; // 810
const SAFE = LULU_SPEC.layoutSafetyIn * PT; // 36
const COVER_W = TRIM_W * 2 + BLEED * 2; // 1242
const COVER_H = PAGE_H; // 810
/** The art box (page coords, bleed included): 7.5 × 9.75 in. */
const ART = Object.freeze({ x: BLEED + SAFE, w: 7.5 * PT, y: BLEED + 0.75 * PT, h: 9.75 * PT });
const ART_RATIO = ART.w / ART.h; // 0.769…
const CAPTION_SIZE = 11;
const CAPTION_BASELINE = BLEED + 0.5 * PT; // 0.5 in above the trim bottom
const GEOMETRY = Object.freeze({ PT, TRIM_W, TRIM_H, BLEED, PAGE_W, PAGE_H, SAFE, COVER_W, COVER_H, ART, ART_RATIO, CAPTION_SIZE, CAPTION_BASELINE });

const FONT_DIR = path.join(__dirname, '..', '..', '..', 'fonts');
const FONT_PATHS = Object.freeze({
  kalam: path.join(FONT_DIR, 'Kalam-Regular.ttf'),
  bubblegum: path.join(FONT_DIR, 'BubblegumSans-Regular.ttf'),
  playfair: path.join(FONT_DIR, 'PlayfairDisplay.ttf'),
  playfairItalic: path.join(FONT_DIR, 'PlayfairDisplay-Italic.ttf'),
  helv: path.join(FONT_DIR, 'LiberationSans-Regular.ttf'),
});
const INK = grayscale(0);
const INK_SOFT = grayscale(0.35);
const INK_RULE = grayscale(0.55);
const COCOA = rgb(0x2A / 255, 0x1C / 255, 0x12 / 255);
const WHITE = rgb(1, 1, 1);

/**
 * Embed the fonts (fontkit; ligatures off, the layoutEngine lesson).
 * @param {PDFDocument} pdfDoc
 * @returns {Promise<{kalam: object|null, bubblegum: object|null, playfair: object|null, playfairItalic: object|null, helv: object}>}
 */
async function loadFonts(pdfDoc) {
  pdfDoc.registerFontkit(fontkit);
  const load = p => (fs.existsSync(p) ? pdfDoc.embedFont(fs.readFileSync(p), { features: { liga: false } }) : null);
  const [kalam, bubblegum, playfair, playfairItalic, helv] = await Promise.all(Object.values(FONT_PATHS).map(load));
  const { StandardFonts } = require('pdf-lib');
  return { kalam, bubblegum, playfair, playfairItalic, helv: helv || await pdfDoc.embedFont(StandardFonts.Helvetica) };
}

/** Word-wrap to a width. @param {string} text @param {object} font @param {number} size @param {number} maxWidth @returns {string[]} */
function wrapText(text, font, size, maxWidth) {
  const lines = [];
  let cur = '';
  for (const word of String(text || '').split(/\s+/).filter(Boolean)) {
    const attempt = cur ? `${cur} ${word}` : word;
    if (font.widthOfTextAtSize(attempt, size) > maxWidth && cur) { lines.push(cur); cur = word; } else cur = attempt;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Fit a size so `text` fits `maxWidth` (never below `min`). */
function fitSize(text, font, size, maxWidth, min = 10) {
  let s = size;
  while (s > min && font.widthOfTextAtSize(text, s) > maxWidth) s -= 1;
  return s;
}

/** Draw centred text. */
function drawCentered(page, text, font, size, y, color, centerX) {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: (centerX != null ? centerX : page.getWidth() / 2) - w / 2, y, size, font, color });
}

/**
 * Prepare one page render for the art box: 8-bit grayscale PNG cropped to
 * the box ratio (a 3:4 image loses 1.25% top and bottom, never stretched)
 * and upscaled to Lulu's 300 PPI floor when the render is smaller.
 * @param {Buffer} buffer
 * @returns {Promise<{png: Buffer, width: number, height: number, ppi: number, upscaled: boolean}>}
 */
async function prepareArt(buffer) {
  let meta;
  try {
    meta = await sharp(buffer).metadata();
  } catch (err) {
    throw new Error(`page render is not a decodable image (${err.message})`);
  }
  const srcW = meta.width || 0;
  const srcH = meta.height || 0;
  if (!srcW || !srcH) throw new Error('page render is not a decodable image');
  // Crop to the box ratio from the centre.
  let cropW = srcW; let cropH = Math.round(srcW / ART_RATIO);
  if (cropH > srcH) { cropH = srcH; cropW = Math.round(srcH * ART_RATIO); }
  const left = Math.floor((srcW - cropW) / 2);
  const top = Math.floor((srcH - cropH) / 2);
  let pipeline = sharp(buffer).extract({ left, top, width: cropW, height: cropH });
  const ppiNative = cropW / (ART.w / PT);
  let upscaled = false;
  let outW = cropW;
  if (ppiNative < LULU_SPEC.targetPpi) {
    outW = Math.round(LULU_SPEC.targetPpi * (ART.w / PT));
    pipeline = pipeline.resize({ width: outW, kernel: sharp.kernel.lanczos3 });
    upscaled = true;
  }
  const png = await pipeline.flatten({ background: '#ffffff' }).grayscale().toColourspace('b-w').png().toBuffer();
  const outMeta = await sharp(png).metadata();
  return { png, width: outMeta.width, height: outMeta.height, ppi: Math.round(outW / (ART.w / PT)), upscaled };
}

/** A white page with the bleed area white. */
function blankPage(pdfDoc) {
  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: WHITE });
  return page;
}

/**
 * Draw the border plate (or a typeset double rule) inside the trim.
 * @param {object} page
 * @param {PDFDocument} pdfDoc
 * @param {Buffer|null} borderPlate a 3:4 line-art PNG
 */
async function drawFrame(page, pdfDoc, borderPlate) {
  if (borderPlate) {
    try {
      const png = await sharp(borderPlate).flatten({ background: '#ffffff' }).grayscale().toColourspace('b-w').png().toBuffer();
      const img = await pdfDoc.embedPng(png);
      // The plate fills the trim area edge to edge inside the bleed (its
      // own motifs are ~10% wide, so the frame sits inside the safety zone).
      page.drawImage(img, { x: BLEED, y: BLEED, width: TRIM_W, height: TRIM_H });
      return;
    } catch (err) {
      // fall through to the typeset rule
    }
  }
  page.drawRectangle({ x: BLEED + SAFE, y: BLEED + SAFE, width: TRIM_W - SAFE * 2, height: TRIM_H - SAFE * 2, borderColor: INK, borderWidth: 2 });
  page.drawRectangle({ x: BLEED + SAFE + 8, y: BLEED + SAFE + 8, width: TRIM_W - SAFE * 2 - 16, height: TRIM_H - SAFE * 2 - 16, borderColor: INK_RULE, borderWidth: 0.75 });
}

/**
 * The title page: the book title, "COLORING BOOK", "This book belongs to".
 */
async function addTitlePage(pdfDoc, fonts, { title, childName, borderPlate }) {
  const page = blankPage(pdfDoc);
  await drawFrame(page, pdfDoc, borderPlate);
  const titleFont = fonts.bubblegum || fonts.playfair || fonts.helv;
  const maxW = TRIM_W - SAFE * 2 - 1.2 * PT;
  const lines = wrapText(String(title || 'My Coloring Book'), titleFont, 34, maxW);
  let y = PAGE_H / 2 + 1.6 * PT + (lines.length - 1) * 22;
  for (const line of lines) { drawCentered(page, line, titleFont, fitSize(line, titleFont, 34, maxW, 18), y, INK); y -= 44; }
  drawCentered(page, 'COLORING BOOK', titleFont, 18, y - 6, INK_SOFT);
  const sub = fonts.kalam || fonts.helv;
  drawCentered(page, 'This book belongs to', sub, 14, PAGE_H / 2 - 1.6 * PT, INK);
  const ruleY = PAGE_H / 2 - 2.1 * PT;
  page.drawLine({ start: { x: PAGE_W / 2 - 1.6 * PT, y: ruleY }, end: { x: PAGE_W / 2 + 1.6 * PT, y: ruleY }, thickness: 0.75, color: INK_RULE });
  if (childName) drawCentered(page, `A coloring book for ${childName}`, sub, 11, BLEED + SAFE + 1.2 * PT, INK_SOFT);
  drawCentered(page, 'Crayons and coloured pencils work best on these pages.', fonts.helv, 8, BLEED + SAFE + 0.75 * PT, INK_SOFT);
}

/**
 * The "Meet {name}" page: the landscape line sheet fitted inside the art
 * box with a typeset heading above it.
 */
async function addMeetPage(pdfDoc, fonts, { sheet, childName, caption }) {
  const page = blankPage(pdfDoc);
  const srcMeta = await sharp(sheet).metadata();
  const ratio = srcMeta.width / srcMeta.height;
  const maxW = ART.w;
  const maxH = ART.h - 1.2 * PT;
  let w = maxW; let h = w / ratio;
  if (h > maxH) { h = maxH; w = h * ratio; }
  // Lulu's 300 PPI floor at the drawn width (a landscape sheet is drawn
  // wider than its native size would print sharp).
  const neededPx = Math.round(LULU_SPEC.targetPpi * (w / PT));
  let pipeline = sharp(sheet).flatten({ background: '#ffffff' });
  if (srcMeta.width < neededPx) pipeline = pipeline.resize({ width: neededPx, kernel: sharp.kernel.lanczos3 });
  const png = await pipeline.grayscale().toColourspace('b-w').png().toBuffer();
  const img = await pdfDoc.embedPng(png);
  const meta = await sharp(png).metadata();
  const x = ART.x + (ART.w - w) / 2;
  const y = ART.y + (ART.h - 1.2 * PT - h) / 2;
  page.drawImage(img, { x, y, width: w, height: h });
  const heading = fonts.bubblegum || fonts.helv;
  drawCentered(page, `Meet ${childName || 'the hero'}`, heading, 28, ART.y + ART.h - 0.6 * PT, INK);
  if (caption) drawCentered(page, caption, fonts.kalam || fonts.helv, CAPTION_SIZE, CAPTION_BASELINE, INK);
  return { ppi: Math.round(meta.width / (w / PT)) };
}

/**
 * One coloring page: the art in the box, the caption typeset below.
 * @returns {Promise<{ppi: number, upscaled: boolean}>}
 */
async function addColoringPage(pdfDoc, fonts, { buffer, caption, captions = true }) {
  const page = blankPage(pdfDoc);
  const art = await prepareArt(buffer);
  const img = await pdfDoc.embedPng(art.png);
  page.drawImage(img, { x: ART.x, y: ART.y, width: ART.w, height: ART.h });
  if (captions && caption) {
    const font = fonts.kalam || fonts.helv;
    drawCentered(page, String(caption).slice(0, 60), font, CAPTION_SIZE, CAPTION_BASELINE, INK);
  }
  return { ppi: art.ppi, upscaled: art.upscaled };
}

/** "Draw what {name} saw next" — the border plate around an empty centre. */
async function addDrawYourOwnPage(pdfDoc, fonts, { childName, borderPlate }) {
  const page = blankPage(pdfDoc);
  await drawFrame(page, pdfDoc, borderPlate);
  drawCentered(page, `Draw what ${childName || 'you'} saw next`, fonts.bubblegum || fonts.helv, 22, PAGE_H - BLEED - SAFE - 1.0 * PT, INK);
}

/** "Colored by ______" — the last page. */
async function addColoredByPage(pdfDoc, fonts, { borderPlate }) {
  const page = blankPage(pdfDoc);
  await drawFrame(page, pdfDoc, borderPlate);
  drawCentered(page, 'Colored by', fonts.bubblegum || fonts.helv, 24, PAGE_H / 2 + 0.4 * PT, INK);
  page.drawLine({ start: { x: PAGE_W / 2 - 2.2 * PT, y: PAGE_H / 2 - 0.4 * PT }, end: { x: PAGE_W / 2 + 2.2 * PT, y: PAGE_H / 2 - 0.4 * PT }, thickness: 0.75, color: INK_RULE });
  drawCentered(page, 'GiftMyBook.com', fonts.helv, 9, BLEED + SAFE + 0.6 * PT, INK_SOFT);
}

/**
 * Build the Lulu interior PDF.
 * @param {object} p
 * @param {Array<{index: number, kind: string, buffer: Buffer, title?: string}>} p.pages coloring pages in book order (the `meet` page carries the line sheet)
 * @param {string} p.title the picture book's title
 * @param {string} [p.childName]
 * @param {Buffer|null} [p.borderPlate]
 * @param {boolean} [p.captions]
 * @returns {Promise<{buffer: Buffer, pageCount: number, coloringPageCount: number, pages: Array<{index: number, ppi: number, upscaled: boolean}>}>}
 */
async function buildInteriorPdf(p) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`${p.title || 'My Coloring Book'} — Coloring Book (Interior)`);
  pdfDoc.setAuthor('GiftMyBook');
  const fonts = await loadFonts(pdfDoc);
  await addTitlePage(pdfDoc, fonts, { title: p.title, childName: p.childName, borderPlate: p.borderPlate || null });
  const report = [];
  let coloringPageCount = 0;
  for (const pg of p.pages || []) {
    if (!pg || !Buffer.isBuffer(pg.buffer)) continue;
    coloringPageCount += 1;
    if (pg.kind === 'meet') {
      const r = await addMeetPage(pdfDoc, fonts, { sheet: pg.buffer, childName: p.childName, caption: p.captions === false ? null : pg.title });
      report.push({ index: pg.index, ppi: r.ppi, upscaled: false });
    } else {
      const r = await addColoringPage(pdfDoc, fonts, { buffer: pg.buffer, caption: pg.title, captions: p.captions !== false });
      report.push({ index: pg.index, ppi: r.ppi, upscaled: r.upscaled });
    }
  }
  await addDrawYourOwnPage(pdfDoc, fonts, { childName: p.childName, borderPlate: p.borderPlate || null });
  await addColoredByPage(pdfDoc, fonts, { borderPlate: p.borderPlate || null });
  // Lulu saddle stitch: a multiple of 4, at least the minimum — pad with white pages.
  while (pdfDoc.getPageCount() < LULU_SPEC.minPages || pdfDoc.getPageCount() % LULU_SPEC.pageMultiple !== 0) blankPage(pdfDoc);
  return { buffer: Buffer.from(await pdfDoc.save()), pageCount: pdfDoc.getPageCount(), coloringPageCount, pages: report };
}

/**
 * The dominant colour of an image, clamped to a print-safe band, and the
 * ink that reads on it.
 * @param {Buffer} buffer
 * @returns {Promise<{r: number, g: number, b: number, ink: 'light'|'dark'}>} channels 0-1
 */
async function paletteFor(buffer) {
  let d = { r: 230, g: 200, b: 120 };
  try {
    const stats = await sharp(buffer).stats();
    if (stats && stats.dominant) d = stats.dominant;
  } catch (err) {
    // keep the default
  }
  let r = d.r / 255; let g = d.g / 255; let b = d.b / 255;
  const lum = () => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // Clamp to a printable band: neither a near-white wash nor a muddy black.
  let guard = 0;
  while (lum() > 0.72 && guard++ < 10) { r *= 0.9; g *= 0.9; b *= 0.9; }
  while (lum() < 0.18 && guard++ < 20) { r = r + (1 - r) * 0.2; g = g + (1 - g) * 0.2; b = b + (1 - b) * 0.2; }
  return { r, g, b, ink: lum() > 0.5 ? 'dark' : 'light' };
}

/**
 * Build the Lulu cover wrap (one page, no spine).
 * @param {object} p
 * @param {Buffer} p.coverArt the approved cover's own pixels
 * @param {string} p.title
 * @param {string} [p.childName]
 * @param {string} [p.worldName]
 * @param {number} [p.coloringPageCount]
 * @param {Buffer|null} [p.vignette] a line-art sheet for the back panel
 * @returns {Promise<{buffer: Buffer, palette: {r: number, g: number, b: number, ink: string}}>}
 */
async function buildCoverWrapPdf(p) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`${p.title || 'My Coloring Book'} — Coloring Book (Cover)`);
  pdfDoc.setAuthor('GiftMyBook');
  const fonts = await loadFonts(pdfDoc);
  const page = pdfDoc.addPage([COVER_W, COVER_H]);
  const palette = await paletteFor(p.coverArt);
  const band = rgb(palette.r, palette.g, palette.b);
  const ink = palette.ink === 'dark' ? COCOA : WHITE;
  page.drawRectangle({ x: 0, y: 0, width: COVER_W, height: COVER_H, color: band });

  // ── Front (right half) ──
  const frontX = BLEED + TRIM_W; // the fold
  const frontCenter = frontX + TRIM_W / 2;
  const artW = 7.5 * PT;
  const artY = BLEED + 1.55 * PT;
  const artX = frontCenter - artW / 2;
  const artPng = await sharp(p.coverArt).flatten({ background: '#ffffff' }).png().toBuffer();
  const artImg = await pdfDoc.embedPng(artPng);
  const artMeta = await sharp(artPng).metadata();
  const artH = artW * (artMeta.height / artMeta.width);
  page.drawRectangle({ x: artX - 4, y: artY - 4, width: artW + 8, height: artH + 8, color: WHITE });
  page.drawImage(artImg, { x: artX, y: artY, width: artW, height: artH });
  const display = fonts.bubblegum || fonts.helv;
  drawCentered(page, 'COLORING BOOK', display, 30, COVER_H - BLEED - SAFE - 0.55 * PT, ink, frontCenter);
  const childLine = p.childName ? `A coloring book for ${p.childName}` : 'A coloring book to keep';
  drawCentered(page, childLine, fonts.kalam || fonts.helv, fitSize(childLine, fonts.kalam || fonts.helv, 16, TRIM_W - SAFE * 2, 11), BLEED + 0.85 * PT, ink, frontCenter);
  drawCentered(page, 'GiftMyBook', fonts.helv, 8, BLEED + SAFE + 0.05 * PT, ink, frontCenter);

  // ── Back (left half) ──
  const backCenter = BLEED + TRIM_W / 2;
  const panelW = 5.2 * PT; const panelH = 5.2 * PT;
  const panelX = backCenter - panelW / 2; const panelY = COVER_H / 2 - panelH / 2 + 0.6 * PT;
  page.drawRectangle({ x: panelX, y: panelY, width: panelW, height: panelH, color: WHITE });
  if (p.vignette) {
    try {
      const vPng = await sharp(p.vignette).flatten({ background: '#ffffff' }).grayscale().toColourspace('b-w').png().toBuffer();
      const vImg = await pdfDoc.embedPng(vPng);
      const vMeta = await sharp(vPng).metadata();
      const ratio = vMeta.width / vMeta.height;
      let w = panelW - 0.3 * PT; let h = w / ratio;
      if (h > panelH - 0.3 * PT) { h = panelH - 0.3 * PT; w = h * ratio; }
      page.drawImage(vImg, { x: backCenter - w / 2, y: panelY + (panelH - h) / 2, width: w, height: h });
    } catch (err) {
      // an undecodable vignette leaves the white panel
    }
  }
  const blurbFont = fonts.kalam || fonts.helv;
  const n = Number.isInteger(p.coloringPageCount) ? p.coloringPageCount : null;
  const blurb1 = `${n ? `${n} brand-new scenes` : 'Brand-new scenes'} from ${p.worldName || 'the story world'}`;
  const blurb2 = `the moments between the pages of ${p.title || 'the book'}`;
  const maxW = TRIM_W - SAFE * 2;
  let y = panelY - 0.55 * PT;
  for (const line of [...wrapText(blurb1, blurbFont, 15, maxW), ...wrapText(blurb2, blurbFont, 13, maxW)]) {
    const size = line === blurb1 || blurb1.includes(line) ? 15 : 13;
    drawCentered(page, line, blurbFont, size, y, ink, backCenter);
    y -= size + 6;
  }
  drawCentered(page, 'GiftMyBook.com', fonts.helv, 9, BLEED + SAFE + 0.05 * PT, ink, backCenter);
  return { buffer: Buffer.from(await pdfDoc.save()), palette };
}

/**
 * The admin thumbnail of the front cover (sharp composite; the type uses a
 * sans fallback — it is not the printed file).
 * @param {{coverArt: Buffer, childName?: string, palette?: {r: number, g: number, b: number, ink: string}}} p
 * @returns {Promise<Buffer>} PNG 600×776
 */
async function renderCoverThumbnail(p) {
  const width = 600; const height = 776;
  const palette = p.palette || await paletteFor(p.coverArt);
  const bg = { r: Math.round(palette.r * 255), g: Math.round(palette.g * 255), b: Math.round(palette.b * 255) };
  const inkHex = palette.ink === 'dark' ? '#2A1C12' : '#ffffff';
  const artW = 530;
  const art = await sharp(p.coverArt).flatten({ background: '#ffffff' }).resize({ width: artW }).png().toBuffer();
  const artMeta = await sharp(art).metadata();
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <text x="${width / 2}" y="64" text-anchor="middle" font-family="Liberation Sans, DejaVu Sans, Helvetica, Arial, sans-serif" font-size="34" font-weight="bold" fill="${inkHex}">COLORING BOOK</text>
    <text x="${width / 2}" y="${height - 36}" text-anchor="middle" font-family="Liberation Sans, DejaVu Sans, Helvetica, Arial, sans-serif" font-size="18" fill="${inkHex}">${esc(p.childName ? `A coloring book for ${p.childName}` : 'A coloring book to keep')}</text>
  </svg>`);
  return sharp({ create: { width, height, channels: 3, background: bg } })
    .composite([
      { input: await sharp({ create: { width: artW + 8, height: artMeta.height + 8, channels: 3, background: '#ffffff' } }).png().toBuffer(), left: Math.round((width - artW) / 2) - 4, top: 96 },
      { input: art, left: Math.round((width - artW) / 2), top: 100 },
      { input: svg, left: 0, top: 0 },
    ])
    .png().toBuffer();
}

/**
 * Preview PNGs of the first pages.
 * @param {Array<{buffer: Buffer}>} pages
 * @param {number} [n]
 * @param {number} [width]
 * @returns {Promise<Buffer[]>}
 */
async function renderPreviews(pages, n = 4, width = 800) {
  const out = [];
  for (const pg of (pages || []).slice(0, n)) {
    if (!pg || !Buffer.isBuffer(pg.buffer)) continue;
    try { out.push(await sharp(pg.buffer).flatten({ background: '#ffffff' }).resize({ width, fit: 'inside' }).png().toBuffer()); } catch (err) { /* skip */ }
  }
  return out;
}

/**
 * Preflight the PDFs against Lulu's rules (the numbers this layout is
 * built to; a violation here is a bug, and it is reported, never hidden).
 * @param {{interior: Buffer, cover: Buffer, pageReport?: Array<{index: number, ppi: number}>}} p
 * @returns {Promise<{ok: boolean, errors: string[], warnings: string[], interior: {pages: number, sizePt: number[]}, cover: {pages: number, sizePt: number[]}, minPpi: number|null}>}
 */
async function preflightLulu(p) {
  const errors = [];
  const warnings = [];
  const near = (a, b) => Math.abs(a - b) < 0.5;
  const interior = await PDFDocument.load(p.interior);
  const sizes = interior.getPages().map(pg => [pg.getWidth(), pg.getHeight()]);
  const pages = sizes.length;
  if (pages < LULU_SPEC.minPages || pages > LULU_SPEC.maxPages) errors.push(`interior has ${pages} pages (saddle stitch allows ${LULU_SPEC.minPages}-${LULU_SPEC.maxPages})`);
  if (pages % LULU_SPEC.pageMultiple !== 0) errors.push(`interior page count ${pages} is not a multiple of ${LULU_SPEC.pageMultiple}`);
  sizes.forEach(([w, h], i) => { if (!near(w, PAGE_W) || !near(h, PAGE_H)) errors.push(`interior page ${i + 1} is ${w.toFixed(1)}×${h.toFixed(1)} pt, expected ${PAGE_W}×${PAGE_H} (trim + bleed)`); });
  const cover = await PDFDocument.load(p.cover);
  const coverSizes = cover.getPages().map(pg => [pg.getWidth(), pg.getHeight()]);
  if (coverSizes.length !== 1) errors.push(`cover has ${coverSizes.length} pages, expected 1 (the wrap)`);
  if (coverSizes[0] && (!near(coverSizes[0][0], COVER_W) || !near(coverSizes[0][1], COVER_H))) errors.push(`cover is ${coverSizes[0][0].toFixed(1)}×${coverSizes[0][1].toFixed(1)} pt, expected ${COVER_W}×${COVER_H}`);
  const ppis = (p.pageReport || []).map(r => r.ppi).filter(n => Number.isFinite(n));
  const minPpi = ppis.length ? Math.min(...ppis) : null;
  if (minPpi != null && minPpi < LULU_SPEC.minPpi) errors.push(`a page image is ${minPpi} PPI (Lulu minimum ${LULU_SPEC.minPpi})`);
  else if (minPpi != null && minPpi < LULU_SPEC.targetPpi) warnings.push(`the lowest page image is ${minPpi} PPI (Lulu recommends ${LULU_SPEC.targetPpi})`);
  return { ok: errors.length === 0, errors, warnings, interior: { pages, sizePt: sizes[0] || [] }, cover: { pages: coverSizes.length, sizePt: coverSizes[0] || [] }, minPpi };
}

module.exports = {
  LULU_SPEC,
  GEOMETRY,
  FONT_PATHS,
  loadFonts,
  wrapText,
  prepareArt,
  paletteFor,
  buildInteriorPdf,
  buildCoverWrapPdf,
  renderCoverThumbnail,
  renderPreviews,
  preflightLulu,
};
