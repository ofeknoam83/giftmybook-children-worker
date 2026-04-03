/**
 * Layout Engine — Composes illustrations + text into PDF page spreads
 *
 * Picture book: 8.5" x 8.5" (612 x 612 points)
 * Early reader: 6" x 9" (432 x 648 points)
 */

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const sharp = require('sharp');

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

const MARGIN = 36; // 0.5 inch
const TEXT_FONT_SIZE = 14;
const TEXT_LINE_HEIGHT = 20;

/**
 * Assemble all spreads into a single interior PDF.
 * @param {Array<{spreadNumber, text, illustrationBuffer, layoutType}>} spreads
 * @param {string} bookFormat - PICTURE_BOOK or EARLY_READER
 * @param {object} opts
 * @returns {Promise<Buffer>} PDF buffer
 */
async function assemblePdf(spreads, bookFormat, opts = {}) {
  const format = FORMATS[bookFormat] || FORMATS.PICTURE_BOOK;
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // Title page
  const titlePage = pdfDoc.addPage([format.width, format.height]);
  const title = opts.title || 'My Story';
  const titleWidth = font.widthOfTextAtSize(title, 24);
  titlePage.drawText(title, {
    x: (format.width - titleWidth) / 2,
    y: format.height / 2 + 20,
    size: 24,
    font,
    color: rgb(0.15, 0.15, 0.15),
  });

  if (opts.childName) {
    const subtitle = `A story about ${opts.childName}`;
    const subWidth = font.widthOfTextAtSize(subtitle, 14);
    titlePage.drawText(subtitle, {
      x: (format.width - subWidth) / 2,
      y: format.height / 2 - 20,
      size: 14,
      font,
      color: rgb(0.4, 0.4, 0.4),
    });
  }

  // Content spreads — text is now embedded in the illustrations, so always full-bleed
  for (const spread of spreads) {
    const page = pdfDoc.addPage([format.width, format.height]);

    // Embed illustration as full-bleed image (text is already in the image)
    if (spread.illustrationBuffer) {
      try {
        const imgBuffer = await prepareImage(spread.illustrationBuffer, format, LAYOUT_TYPES.FULL_BLEED);
        let img;
        // Try PNG first, fall back to JPEG
        try {
          img = await pdfDoc.embedPng(imgBuffer);
        } catch {
          img = await pdfDoc.embedJpg(imgBuffer);
        }

        const imgDims = getImageDimensions(format, LAYOUT_TYPES.FULL_BLEED);
        page.drawImage(img, imgDims);
      } catch (err) {
        console.error(`[LayoutEngine] Failed to embed illustration for spread ${spread.spreadNumber}:`, err.message);
      }
    }

    // Page number
    const pageNum = String(spread.spreadNumber || '');
    if (pageNum) {
      const numWidth = font.widthOfTextAtSize(pageNum, 10);
      page.drawText(pageNum, {
        x: (format.width - numWidth) / 2,
        y: 20,
        size: 10,
        font,
        color: rgb(0.6, 0.6, 0.6),
      });
    }
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

/**
 * Prepare image buffer for embedding in the PDF.
 */
async function prepareImage(buffer, format, layoutType) {
  const dims = getImageDimensions(format, layoutType);
  return sharp(buffer)
    .resize(Math.round(dims.width), Math.round(dims.height), { fit: 'cover' })
    .png()
    .toBuffer();
}

/**
 * Get image dimensions based on format and layout type.
 */
function getImageDimensions(format, layoutType) {
  switch (layoutType) {
    case LAYOUT_TYPES.FULL_BLEED:
      return { x: 0, y: 0, width: format.width, height: format.height };
    case LAYOUT_TYPES.TEXT_BOTTOM:
      return { x: 0, y: format.height * 0.35, width: format.width, height: format.height * 0.65 };
    case LAYOUT_TYPES.TEXT_LEFT:
      return { x: format.width * 0.45, y: 0, width: format.width * 0.55, height: format.height };
    case LAYOUT_TYPES.NO_TEXT:
      return { x: 0, y: 0, width: format.width, height: format.height };
    default:
      return { x: 0, y: format.height * 0.35, width: format.width, height: format.height * 0.65 };
  }
}

/**
 * Get text area bounds based on format and layout type.
 */
function getTextArea(format, layoutType) {
  switch (layoutType) {
    case LAYOUT_TYPES.FULL_BLEED:
      return {
        x: MARGIN + 10,
        y: MARGIN + 10,
        width: format.width - 2 * (MARGIN + 10),
        maxY: format.height * 0.25,
      };
    case LAYOUT_TYPES.TEXT_BOTTOM:
      return {
        x: MARGIN,
        y: MARGIN,
        width: format.width - 2 * MARGIN,
        maxY: format.height * 0.30,
      };
    case LAYOUT_TYPES.TEXT_LEFT:
      return {
        x: MARGIN,
        y: MARGIN,
        width: format.width * 0.40,
        maxY: format.height - 2 * MARGIN,
      };
    default:
      return {
        x: MARGIN,
        y: MARGIN,
        width: format.width - 2 * MARGIN,
        maxY: format.height * 0.30,
      };
  }
}

/**
 * Draw word-wrapped text in a given area.
 */
function drawWrappedText(page, font, text, area) {
  const words = text.split(/\s+/);
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? currentLine + ' ' + word : word;
    const testWidth = font.widthOfTextAtSize(testLine, TEXT_FONT_SIZE);
    if (testWidth > area.width && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);

  // Draw from top of text area downward (PDF coordinates: y increases upward)
  let y = area.y + area.maxY - TEXT_LINE_HEIGHT;
  for (const line of lines) {
    if (y < area.y) break;
    // Center text horizontally within the text area
    const lineWidth = font.widthOfTextAtSize(line, TEXT_FONT_SIZE);
    const x = area.x + (area.width - lineWidth) / 2;
    page.drawText(line, {
      x,
      y,
      size: TEXT_FONT_SIZE,
      font,
      color: rgb(0.1, 0.1, 0.1),
    });
    y -= TEXT_LINE_HEIGHT;
  }
}

module.exports = { assemblePdf, FORMATS, LAYOUT_TYPES };
