/**
 * Layout Engine V2 — Composes V2 story entries into interior PDF.
 *
 * Handles front matter (title page, blanks, dedication) and
 * story spreads (left + right pages with full-bleed illustrations
 * and text overlays).
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

const LULU_MIN_PAGES = 32;

/**
 * Draw text overlay at the bottom of a page with a semi-transparent
 * white background for readability over illustrations.
 */
function drawTextOverlay(page, font, text, pageWidth, pageHeight) {
  if (!text) return;

  const fontSize = 14;
  const lineHeight = fontSize * 1.5;
  const maxTextWidth = pageWidth - 80; // 40pt margin each side
  const marginBottom = BLEED + 30;

  // Word-wrap the text
  const words = text.split(/\s+/);
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const testWidth = font.widthOfTextAtSize(testLine, fontSize);
    if (testWidth > maxTextWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);

  const textBlockHeight = lines.length * lineHeight + 20; // 10pt padding top + bottom
  const bgY = marginBottom - 10;
  const bgHeight = textBlockHeight;

  // Semi-transparent white background
  page.drawRectangle({
    x: 20,
    y: bgY,
    width: pageWidth - 40,
    height: bgHeight,
    color: rgb(1, 1, 1),
    opacity: 0.75,
    borderWidth: 0,
  });

  // Draw each line centered
  for (let i = 0; i < lines.length; i++) {
    const lineWidth = font.widthOfTextAtSize(lines[i], fontSize);
    const x = (pageWidth - lineWidth) / 2;
    const y = bgY + bgHeight - 10 - (i * lineHeight) - fontSize;
    page.drawText(lines[i], {
      x,
      y,
      size: fontSize,
      font,
      color: rgb(0.1, 0.1, 0.1),
    });
  }
}

/**
 * Embed an image buffer full-bleed onto a PDF page.
 */
async function embedImageFullBleed(pdfDoc, page, imageBuffer, pageWidth, pageHeight) {
  const resized = await sharp(imageBuffer)
    .resize(Math.round(pageWidth), Math.round(pageHeight), { fit: 'cover' })
    .png()
    .toBuffer();

  let img;
  try {
    img = await pdfDoc.embedPng(resized);
  } catch {
    img = await pdfDoc.embedJpg(resized);
  }

  page.drawImage(img, { x: 0, y: 0, width: pageWidth, height: pageHeight });
}

/**
 * Assemble all V2 story entries into a single interior PDF.
 *
 * @param {Array<object>} storyEntries - V2 array: [{type, page, ...}, ...]
 *   Each entry may have: illustrationBuffer, spreadIllustrationBuffer,
 *   leftIllustrationBuffer, rightIllustrationBuffer (attached by caller)
 * @param {string} bookFormat - PICTURE_BOOK or EARLY_READER
 * @param {object} opts
 * @returns {Promise<Buffer>} PDF buffer
 */
async function assemblePdf(storyEntries, bookFormat, opts = {}) {
  const format = FORMATS[bookFormat] || FORMATS[(bookFormat || '').toUpperCase()] || FORMATS.PICTURE_BOOK;
  const pageWidth = format.width + BLEED * 2;
  const pageHeight = format.height + BLEED * 2;
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  for (const entry of storyEntries) {
    switch (entry.type) {
      case 'blank': {
        pdfDoc.addPage([pageWidth, pageHeight]);
        break;
      }

      case 'title_page': {
        const page = pdfDoc.addPage([pageWidth, pageHeight]);

        // If entry has an illustration, draw it full bleed as background
        if (entry.illustrationBuffer) {
          await embedImageFullBleed(pdfDoc, page, entry.illustrationBuffer, pageWidth, pageHeight);
        }

        // Draw title centered, large bold font
        const titleText = entry.title || opts.title || 'My Story';
        const titleFontSize = 28;
        const titleWidth = boldFont.widthOfTextAtSize(titleText, titleFontSize);
        page.drawText(titleText, {
          x: (pageWidth - titleWidth) / 2,
          y: pageHeight / 2 + 30,
          size: titleFontSize,
          font: boldFont,
          color: entry.illustrationBuffer ? rgb(1, 1, 1) : rgb(0.15, 0.15, 0.15),
        });

        // Draw subtitle below
        const subtitleText = entry.subtitle || (opts.childName ? `A bedtime story for ${opts.childName}` : '');
        if (subtitleText) {
          const subFontSize = 16;
          const subWidth = font.widthOfTextAtSize(subtitleText, subFontSize);
          page.drawText(subtitleText, {
            x: (pageWidth - subWidth) / 2,
            y: pageHeight / 2 - 15,
            size: subFontSize,
            font,
            color: entry.illustrationBuffer ? rgb(0.9, 0.9, 0.9) : rgb(0.4, 0.4, 0.4),
          });
        }
        break;
      }

      case 'dedication_page': {
        const page = pdfDoc.addPage([pageWidth, pageHeight]);

        if (entry.illustrationBuffer) {
          await embedImageFullBleed(pdfDoc, page, entry.illustrationBuffer, pageWidth, pageHeight);
        }

        // Draw dedication text centered
        const dedText = entry.text || opts.dedication || '';
        if (dedText) {
          const dedFontSize = 18;
          const dedWidth = font.widthOfTextAtSize(dedText, dedFontSize);
          page.drawText(dedText, {
            x: (pageWidth - dedWidth) / 2,
            y: pageHeight / 2,
            size: dedFontSize,
            font,
            color: entry.illustrationBuffer ? rgb(1, 1, 1) : rgb(0.3, 0.3, 0.3),
          });
        }
        break;
      }

      case 'spread': {
        // LEFT PAGE
        const leftPage = pdfDoc.addPage([pageWidth, pageHeight]);
        // RIGHT PAGE
        const rightPage = pdfDoc.addPage([pageWidth, pageHeight]);

        // Full spread illustration (same image on both pages)
        if (entry.spreadIllustrationBuffer) {
          await embedImageFullBleed(pdfDoc, leftPage, entry.spreadIllustrationBuffer, pageWidth, pageHeight);
          await embedImageFullBleed(pdfDoc, rightPage, entry.spreadIllustrationBuffer, pageWidth, pageHeight);
        }

        // Or separate left/right illustrations
        if (entry.leftIllustrationBuffer) {
          await embedImageFullBleed(pdfDoc, leftPage, entry.leftIllustrationBuffer, pageWidth, pageHeight);
        }
        if (entry.rightIllustrationBuffer) {
          await embedImageFullBleed(pdfDoc, rightPage, entry.rightIllustrationBuffer, pageWidth, pageHeight);
        }

        // Text overlays
        if (entry.left?.text) {
          drawTextOverlay(leftPage, font, entry.left.text, pageWidth, pageHeight);
        }
        if (entry.right?.text) {
          drawTextOverlay(rightPage, font, entry.right.text, pageWidth, pageHeight);
        }
        break;
      }

      default:
        // Unknown entry type — skip
        console.warn(`[LayoutEngine] Unknown entry type: ${entry.type}`);
        break;
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

module.exports = { assemblePdf, FORMATS };
