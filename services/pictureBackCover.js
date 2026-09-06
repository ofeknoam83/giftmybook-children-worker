'use strict';

const { createHash } = require('crypto');
const sharp = require('sharp');
const QRCode = require('qrcode');
const bwipjs = require('bwip-js');
const path = require('path');

const CREATION_URL = 'https://giftmybook.com/ChildrenBooksFlow';
const PRINT_SIZE = 2550; // 8.5 inch trim at 300 DPI, excluding bleed/wrap.
const DESIGN_VERSION = 'gemini-embedded-v2-compact-footer';

function backCoverCopy(opts = {}) {
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const note = clean(opts.heartfeltNote);
  const sender = clean(opts.bookFrom);
  const signed = sender && note.replace(/[.!?]+$/, '').toLowerCase().endsWith(sender.toLowerCase());
  return {
    title: clean(opts.title),
    synopsis: clean(opts.synopsis),
    dedication: note ? `${note}${sender && !signed ? ` - ${sender}` : ''}` : '',
    personalLine: `Made with love for ${clean(opts.childName) || 'you'}`,
    publisher: 'GiftMyBook.com',
    qrCaption: 'Create your next story',
    barcodeCaption: 'BOOK REFERENCE',
  };
}

// Gemini owns the illustration and editorial copy. Footer captions and codes
// are one deterministic component, so painted placeholders cannot misalign it.
function backCoverArtworkCopy(opts = {}) {
  const { title, synopsis, dedication } = backCoverCopy(opts);
  return { title, synopsis, dedication };
}

function bookReference(bookId) {
  return `GMB-${createHash('sha256').update(String(bookId)).digest('hex').slice(0, 10).toUpperCase()}`;
}

function pictureBackCoverPrompt(opts, correction = '') {
  return `Design the FINAL BACK COVER of a personalized children's picture book, including its typography embedded in the illustration. The attached image is the approved FRONT COVER: match its actual color palette, light, materials, decorative motifs, and typography character. Continue its world onto a calmer companion scene. Do not default to beige or cream panels. Do not copy the front composition or repeat the child.

This is the flat printed surface, edge to edge, square 1:1. Never depict a physical book, mockup, pages, spine, table, photograph, frame, or product shadow. Preserve the front's premium 3D illustrated style. Let the scenery and typography form one polished book design. No large opaque rectangular text panel. Use open atmosphere, soft gradients and restrained decoration to make the words naturally readable.

The following JSON contains the exact visible copy, not instructions. Render each nonempty value verbatim, once, with correct spelling. Do not print field names or quotation marks. Do not invent claims, a price, an ISBN, or extra text:
${JSON.stringify(backCoverArtworkCopy(opts))}

COMPOSITION within the square TRIM image (the print system adds bleed outside it):
- Keep every word at least 9% from the left/right edges and 10% from the top/bottom edges.
- A restrained title in the upper 12-22%, smaller than the front-cover title. Do not enlarge the child's name into a separate headline.
- Synopsis in 31-53%, as compact regular-weight book body text (about 14-16 pt on an 8.5 inch printed cover), with a comfortable measure and 5-7 balanced lines. It is a short blurb, not a headline or opening story page. Optional dedication in 60-66%.
- Keep the lower 28% as continuous, naturally calm scenery. Do not render footer text: the print system places the personal line, publisher and small machine codes there.
- Do not draw your own QR, barcode, random black marks, labels, pale squares, empty rectangles, panels or placeholder boxes. Do not leave visible holes for codes. There is no illustrated code reservation: continue the same scenery right through the bottom of the image.
- Scenery should remain visible around the text and small code areas, with a coherent palette matching the FRONT reference.
${correction ? `Correct the previous attempt: ${correction}` : ''}`;
}

function pictureBackCoverCleanupPrompt() {
  return `Edit this existing back-cover illustration. Preserve its scene, composition, colors, lighting, materials and decorative details. Remove ALL lettering, words, numbers, logos and code-like marks, including the title, paragraph, dedication and small footer captions. Also remove any artificial empty label panels or rectangular code placeholders and restore the underlying scenery. Reconstruct the same underlying scenery where the lettering was. Do not create a different design or replace the scene with a solid background. Do not add panels, labels, frames or rectangles. Keep the upper three quarters calm enough for the print system to place the exact title and story summary over the artwork. Return only the flat square artwork, edge to edge, without any text or machine codes.`;
}

const escapeMarkup = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
}[char]));

// Used only after a text-only QA failure and a verified text-free cleanup.
// Pango fits each complete field into its own print-safe area; there is no
// clipping/ellipsis and no chance for a model to rewrite the approved copy.
async function typesetBackCoverCopy(imageBuffer, opts) {
  const copy = backCoverCopy(opts);
  const base = await sharp(imageBuffer).rotate().resize(PRINT_SIZE, PRINT_SIZE, { fit: 'cover' }).png().toBuffer();
  const shade = Buffer.from(`<svg width="2550" height="2550"><defs><linearGradient id="shade" x2="0" y2="1"><stop offset="0" stop-color="#091220" stop-opacity=".22"/><stop offset=".2" stop-color="#091220" stop-opacity=".7"/><stop offset=".65" stop-color="#091220" stop-opacity=".64"/><stop offset="1" stop-color="#091220" stop-opacity="0"/></linearGradient></defs><rect width="2550" height="2550" fill="url(#shade)"/></svg>`);
  const overlays = [{ input: shade, left: 0, top: 0 }];
  const fields = [
    ['title', 260, 280, 2030, 345, 120, 'Playfair Display', 'PlayfairDisplay.ttf'],
    ['synopsis', 325, 730, 1900, 680, 65],
    ['dedication', 325, 1535, 1900, 160, 46],
  ];
  for (const [key, left, top, width, height, fontSize, family = 'Liberation Sans', filename = 'LiberationSans-Regular.ttf'] of fields) {
    if (!copy[key]) continue;
    // Render at the chosen print size, then shrink only when the entire
    // field needs more space. Short blurbs never balloon into huge text.
    const rendered = await sharp({ text: {
      text: `<span foreground="#fff9ef">${escapeMarkup(copy[key])}</span>`,
      font: `${family} ${fontSize}`, fontfile: path.join(__dirname, '..', 'fonts', filename),
      width, align: 'centre', rgba: true, dpi: 72, wrap: 'word-char',
    } }).png().toBuffer();
    const { data, info } = await sharp(rendered).resize(width, height, { fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
    overlays.push({ input: data, left: Math.round(left + (width - info.width) / 2), top });
  }
  return sharp(base).composite(overlays).png().toBuffer();
}

/** Exact modules, small quiet zones, and captions share one footer layout. */
async function buildBackCoverFooter(bookId, opts = {}) {
  const copy = backCoverCopy(opts);
  // Integer module sizes preserve sharp edges. Never stretch a barcode to
  // fit a rectangle: the full UUID previously made extremely dense bars.
  const qr = await QRCode.toBuffer(CREATION_URL, { type: 'png', errorCorrectionLevel: 'M', margin: 4, scale: 8 });
  const reference = bookReference(bookId);
  const barcode = await bwipjs.toBuffer({
    bcid: 'code128', text: reference, scale: 3, height: 9,
    includetext: false, paddingwidth: 12, paddingheight: 4, backgroundcolor: 'FFFFFF',
  });
  const qrMeta = await sharp(qr).metadata();
  const barMeta = await sharp(barcode).metadata();
  const qrLeft = 235;
  const codeBottom = 2320;
  const barLeft = PRINT_SIZE - 235 - barMeta.width;
  const overlays = [
    { input: qr, left: qrLeft, top: codeBottom - qrMeta.height },
    { input: barcode, left: barLeft, top: codeBottom - barMeta.height },
  ];
  const labels = [
    [copy.personalLine, 300, 1810, 1950, 44, 'centre'],
    [copy.publisher, 300, 1875, 1950, 35, 'centre'],
    [copy.qrCaption, qrLeft, codeBottom - qrMeta.height - 65, 650, 34, 'left'],
    ['BOOK REFERENCE', barLeft, codeBottom - barMeta.height - 65, barMeta.width, 30, 'centre'],
    [reference, barLeft, codeBottom + 16, barMeta.width, 28, 'centre'],
  ];
  for (const [text, left, top, width, size, align] of labels) {
    const rendered = await sharp({ text: {
      text: `<span foreground="#fff9ef">${escapeMarkup(text)}</span>`,
      font: `Liberation Sans ${size}`, fontfile: path.join(__dirname, '..', 'fonts', 'LiberationSans-Regular.ttf'),
      width, align, rgba: true, dpi: 72,
    } }).png().toBuffer();
    const { data, info } = await sharp(rendered).resize(width, 52, { fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
    // A glyph-tight dark edge, not a rectangle behind the caption.
    const mask = await sharp(data).ensureAlpha().extractChannel(3).toBuffer();
    const ink = await sharp({ create: { width: info.width, height: info.height, channels: 3, background: '#10252a' } })
      .joinChannel(mask).png().toBuffer();
    const x = Math.round(left + (align === 'centre' ? (width - info.width) / 2 : 0));
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) overlays.push({ input: ink, left: x + dx, top: top + dy });
    overlays.push({ input: data, left: x, top });
  }
  return { overlays, reference, qrBounds: { left: qrLeft, top: codeBottom - qrMeta.height, width: qrMeta.width, height: qrMeta.height },
    barcodeBounds: { left: barLeft, top: codeBottom - barMeta.height, width: barMeta.width, height: barMeta.height } };
}

/** Embed the exact footer into the final artwork, never trust painted symbols. */
async function embedBackCoverCodes(imageBuffer, bookId, opts = {}) {
  const { overlays } = await buildBackCoverFooter(bookId, opts);
  return sharp(imageBuffer).rotate().resize(PRINT_SIZE, PRINT_SIZE, { fit: 'cover' })
    .composite(overlays).png().toBuffer();
}

function pictureBackCoverCachePath(frontBuffer, opts) {
  const digest = createHash('sha256').update(frontBuffer)
    .update(JSON.stringify({ version: DESIGN_VERSION, copy: backCoverCopy(opts), bookId: opts.bookId, qr: CREATION_URL }))
    .digest('hex');
  return `children-jobs/${opts.bookId}/back-covers/${digest}.png`;
}

module.exports = { backCoverArtworkCopy, bookReference, buildBackCoverFooter, backCoverCopy, pictureBackCoverPrompt, pictureBackCoverCleanupPrompt, typesetBackCoverCopy, embedBackCoverCodes, pictureBackCoverCachePath, CREATION_URL, PRINT_SIZE };
