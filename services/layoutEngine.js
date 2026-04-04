/**
 * Layout Engine — Composes illustrations + text into PDF page spreads
 *
 * Picture book: 8.5" x 8.5" (612 x 612 points)
 * Early reader: 6" x 9" (432 x 648 points)
 *
 * Interior pages include 0.125" (9pt) bleed on all sides per Lulu spec.
 */

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const sharp = require('sharp');

const BLEED = 9; // 0.125" in pts — Lulu standard

const FORMATS = {
  PICTURE_BOOK: { width: 612, height: 612, label: '8.5x8.5' },
  EARLY_READER: { width: 432, height: 648, label: '6x9' },
};

const LAYOUT_TYPES = {
  FULL_BLEED: 'FULL_BLEED',
  TEXT_BOTTOM: 'TEXT_BOTTOM',
  TEXT_LEFT: 'TEXT_LEFT',
  NO_TEXT: 'NO_TEXT',
};

const LULU_MIN_PAGES = 32;

/**
 * Assemble all spreads into a single interior PDF.
 * @param {Array<{spreadNumber, text, illustrationBuffer, layoutType}>} spreads
 * @param {string} bookFormat - PICTURE_BOOK or EARLY_READER
 * @param {object} opts
 * @returns {Promise<Buffer>} PDF buffer
 */
async function assemblePdf(spreads, bookFormat, opts = {}) {
  const format = FORMATS[bookFormat] || FORMATS[(bookFormat || '').toUpperCase()] || FORMATS.PICTURE_BOOK;
  const pageWidth = format.width + BLEED * 2;
  const pageHeight = format.height + BLEED * 2;
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const title = opts.title || 'My Story';
  const childName = opts.childName || '';
  const dedication = opts.dedication || (childName ? `For ${childName}` : '');

  // Page 1: Blank (half-title page — just white)
  pdfDoc.addPage([pageWidth, pageHeight]);

  // Page 2: Blank (verso)
  pdfDoc.addPage([pageWidth, pageHeight]);

  // Page 3: Title page (recto)
  const titlePage = pdfDoc.addPage([pageWidth, pageHeight]);
  const titleFontSize = 28;
  const titleWidth = boldFont.widthOfTextAtSize(title, titleFontSize);
  titlePage.drawText(title, {
    x: (pageWidth - titleWidth) / 2,
    y: pageHeight / 2 + 30,
    size: titleFontSize,
    font: boldFont,
    color: rgb(0.15, 0.15, 0.15),
  });
  if (childName) {
    const subtitle = `A story about ${childName}`;
    const subFontSize = 16;
    const subWidth = font.widthOfTextAtSize(subtitle, subFontSize);
    titlePage.drawText(subtitle, {
      x: (pageWidth - subWidth) / 2,
      y: pageHeight / 2 - 15,
      size: subFontSize,
      font,
      color: rgb(0.4, 0.4, 0.4),
    });
  }

  // Page 4: Blank (verso)
  pdfDoc.addPage([pageWidth, pageHeight]);

  // Page 5: Dedication page (recto)
  if (dedication) {
    const dedPage = pdfDoc.addPage([pageWidth, pageHeight]);
    const dedFontSize = 18;
    const dedWidth = font.widthOfTextAtSize(dedication, dedFontSize);
    dedPage.drawText(dedication, {
      x: (pageWidth - dedWidth) / 2,
      y: pageHeight / 2,
      size: dedFontSize,
      font,
      color: rgb(0.3, 0.3, 0.3),
    });
  }

  // Page 6: Blank (verso before story starts)
  pdfDoc.addPage([pageWidth, pageHeight]);

  // Story spreads — full-bleed illustrations
  for (const spread of spreads) {
    const page = pdfDoc.addPage([pageWidth, pageHeight]);

    if (spread.illustrationBuffer) {
      try {
        // Resize to full page WITH bleed
        const imgBuffer = await sharp(spread.illustrationBuffer)
          .resize(Math.round(pageWidth), Math.round(pageHeight), {
            fit: 'cover',
          })
          .png()
          .toBuffer();
        let img;
        try { img = await pdfDoc.embedPng(imgBuffer); }
        catch { img = await pdfDoc.embedJpg(imgBuffer); }
        page.drawImage(img, { x: 0, y: 0, width: pageWidth, height: pageHeight });
      } catch (err) {
        console.error(`[LayoutEngine] Failed to embed illustration for spread ${spread.spreadNumber}:`, err.message);
      }
    }
  }

  // Pad to Lulu minimum of 32 pages for paperback
  while (pdfDoc.getPageCount() < LULU_MIN_PAGES) {
    pdfDoc.addPage([pageWidth, pageHeight]);
  }
  // Ensure even page count
  if (pdfDoc.getPageCount() % 2 !== 0) {
    pdfDoc.addPage([pageWidth, pageHeight]);
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}


module.exports = { assemblePdf, FORMATS, LAYOUT_TYPES };
