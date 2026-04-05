/**
 * Layout Engine V2 — Composes V2 story entries into interior PDF.
 *
 * Handles front matter (half-title, title, copyright, dedication) and
 * story spreads (left + right pages with full-bleed illustrations).
 *
 * Picture book: 8.5" x 8.5" (612 x 612 points)
 * Early reader: 6" x 9" (432 x 648 points)
 *
 * Interior pages include 0.125" (9pt) bleed on all sides per Lulu spec.
 * 32-page books need 0" extra gutter margin per Lulu (< 60 pages threshold).
 */

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const sharp = require('sharp');

const BLEED = 9; // 0.125" in pts — Lulu standard
const SAFETY_MARGIN = 36; // 0.5" in pts — Lulu minimum safety from trim edge
const TARGET_DPI = 300;
const PTS_PER_INCH = 72;

const FORMATS = {
  PICTURE_BOOK: { width: 612, height: 612, label: '8.5x8.5' },
  EARLY_READER: { width: 432, height: 648, label: '6x9' },
};

/**
 * Embed an image buffer full-bleed onto a PDF page at print-quality DPI.
 */
async function embedImageFullBleed(pdfDoc, page, imageBuffer, pageWidth, pageHeight) {
  const targetWidthPx = Math.round(pageWidth / PTS_PER_INCH * TARGET_DPI);
  const targetHeightPx = Math.round(pageHeight / PTS_PER_INCH * TARGET_DPI);

  const resized = await sharp(imageBuffer)
    .resize(targetWidthPx, targetHeightPx, { fit: 'cover' })
    .toColorspace('srgb')
    .jpeg({ quality: 95 })
    .toBuffer();

  const img = await pdfDoc.embedJpg(resized);
  page.drawImage(img, { x: 0, y: 0, width: pageWidth, height: pageHeight });
}

/**
 * Split a landscape spread illustration into left and right halves.
 * The input should be a wide (16:9) image generated for a two-page spread.
 *
 * @param {Buffer} imageBuffer - Wide landscape image
 * @param {number} pageWidth - Single page width in pts (with bleed)
 * @param {number} pageHeight - Single page height in pts (with bleed)
 * @returns {Promise<{leftHalf: Buffer, rightHalf: Buffer}>}
 */
async function splitSpreadImage(imageBuffer, pageWidth, pageHeight) {
  const targetWidthPx = Math.round(pageWidth / PTS_PER_INCH * TARGET_DPI);
  const targetHeightPx = Math.round(pageHeight / PTS_PER_INCH * TARGET_DPI);
  const fullWidthPx = targetWidthPx * 2;

  const resized = await sharp(imageBuffer)
    .resize(fullWidthPx, targetHeightPx, { fit: 'cover' })
    .toColorspace('srgb')
    .toBuffer();

  const leftHalf = await sharp(resized)
    .extract({ left: 0, top: 0, width: targetWidthPx, height: targetHeightPx })
    .jpeg({ quality: 95 })
    .toBuffer();

  const rightHalf = await sharp(resized)
    .extract({ left: targetWidthPx, top: 0, width: targetWidthPx, height: targetHeightPx })
    .jpeg({ quality: 95 })
    .toBuffer();

  return { leftHalf, rightHalf };
}

/**
 * Assemble all V2 story entries into a single interior PDF.
 *
 * @param {Array<object>} storyEntries - V2 array: [{type, page, ...}, ...]
 *   Each entry may have: illustrationBuffer, spreadIllustrationBuffer,
 *   leftIllustrationBuffer, rightIllustrationBuffer (attached by caller)
 * @param {string} bookFormat - PICTURE_BOOK or EARLY_READER
 * @param {object} opts - { title, childName, dedication, year }
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

      case 'half_title_page': {
        const page = pdfDoc.addPage([pageWidth, pageHeight]);
        const titleText = entry.title || opts.title || 'My Story';
        const titleFontSize = 22;
        const titleWidth = boldFont.widthOfTextAtSize(titleText, titleFontSize);
        page.drawText(titleText, {
          x: (pageWidth - titleWidth) / 2,
          y: pageHeight * 0.55,
          size: titleFontSize,
          font: boldFont,
          color: rgb(0.2, 0.15, 0.1),
        });
        break;
      }

      case 'title_page': {
        const page = pdfDoc.addPage([pageWidth, pageHeight]);

        if (entry.illustrationBuffer) {
          await embedImageFullBleed(pdfDoc, page, entry.illustrationBuffer, pageWidth, pageHeight);
        }

        const titleText = entry.title || opts.title || 'My Story';
        const titleFontSize = 28;
        const titleWidth = boldFont.widthOfTextAtSize(titleText, titleFontSize);
        const textColor = entry.illustrationBuffer ? rgb(1, 1, 1) : rgb(0.15, 0.15, 0.15);
        page.drawText(titleText, {
          x: (pageWidth - titleWidth) / 2,
          y: pageHeight / 2 + 50,
          size: titleFontSize,
          font: boldFont,
          color: textColor,
        });

        const subtitleText = entry.subtitle || (opts.childName ? `A bedtime story for ${opts.childName}` : '');
        if (subtitleText) {
          const subFontSize = 16;
          const subWidth = font.widthOfTextAtSize(subtitleText, subFontSize);
          page.drawText(subtitleText, {
            x: (pageWidth - subWidth) / 2,
            y: pageHeight / 2 + 5,
            size: subFontSize,
            font,
            color: entry.illustrationBuffer ? rgb(0.9, 0.9, 0.9) : rgb(0.4, 0.4, 0.4),
          });
        }

        const bylineText = 'Created by GiftMyBook';
        const bylineFontSize = 11;
        const bylineWidth = font.widthOfTextAtSize(bylineText, bylineFontSize);
        page.drawText(bylineText, {
          x: (pageWidth - bylineWidth) / 2,
          y: pageHeight / 2 - 25,
          size: bylineFontSize,
          font,
          color: entry.illustrationBuffer ? rgb(0.8, 0.8, 0.8) : rgb(0.5, 0.5, 0.5),
        });
        break;
      }

      case 'copyright_page': {
        const page = pdfDoc.addPage([pageWidth, pageHeight]);
        const year = entry.year || opts.year || new Date().getFullYear();
        const lines = [
          `\u00A9 ${year} GiftMyBook`,
          'Made with love at GiftMyBook.com',
          'All rights reserved',
        ];
        const fontSize = 10;
        const lineHeight = fontSize * 1.8;
        const textColor = rgb(0.5, 0.5, 0.5);
        const startY = pageHeight * 0.3;

        for (let i = 0; i < lines.length; i++) {
          const lineWidth = font.widthOfTextAtSize(lines[i], fontSize);
          page.drawText(lines[i], {
            x: (pageWidth - lineWidth) / 2,
            y: startY - i * lineHeight,
            size: fontSize,
            font,
            color: textColor,
          });
        }
        break;
      }

      case 'dedication_page': {
        const page = pdfDoc.addPage([pageWidth, pageHeight]);

        if (entry.illustrationBuffer) {
          await embedImageFullBleed(pdfDoc, page, entry.illustrationBuffer, pageWidth, pageHeight);
        }

        const dedText = entry.text || opts.dedication || '';
        if (dedText) {
          const textColor = entry.illustrationBuffer ? rgb(1, 1, 1) : rgb(0.3, 0.3, 0.3);
          const sideMargin = BLEED + SAFETY_MARGIN + 20;
          const maxDedWidth = pageWidth - sideMargin * 2;

          const fromMatch = dedText.match(/^(From [^:]+:)\n(.*)$/s);
          let yPos = pageHeight / 2 + 40;

          if (fromMatch) {
            const fromText = fromMatch[1];
            const fromSize = 13;
            const fromWidth = font.widthOfTextAtSize(fromText, fromSize);
            page.drawText(fromText, {
              x: (pageWidth - fromWidth) / 2,
              y: yPos + 30,
              size: fromSize,
              font,
              color: textColor,
            });

            const noteText = fromMatch[2].trim();
            const noteFontSize = 14;
            const noteLineHeight = noteFontSize * 1.6;
            const noteWords = noteText.split(/\s+/);
            const noteLines = [];
            let currentLine = '';
            for (const word of noteWords) {
              const testLine = currentLine ? `${currentLine} ${word}` : word;
              if (font.widthOfTextAtSize(testLine, noteFontSize) > maxDedWidth && currentLine) {
                noteLines.push(currentLine);
                currentLine = word;
              } else {
                currentLine = testLine;
              }
            }
            if (currentLine) noteLines.push(currentLine);

            for (let i = 0; i < noteLines.length; i++) {
              const lineWidth = font.widthOfTextAtSize(noteLines[i], noteFontSize);
              page.drawText(noteLines[i], {
                x: (pageWidth - lineWidth) / 2,
                y: yPos - (i * noteLineHeight),
                size: noteFontSize,
                font,
                color: textColor,
              });
            }
          } else {
            const dedFontSize = 18;
            const dedWidth = font.widthOfTextAtSize(dedText, dedFontSize);
            if (dedWidth <= maxDedWidth) {
              page.drawText(dedText, {
                x: (pageWidth - dedWidth) / 2,
                y: pageHeight / 2,
                size: dedFontSize,
                font,
                color: textColor,
              });
            } else {
              const dedLineHeight = dedFontSize * 1.5;
              const words = dedText.split(/\s+/);
              const lines = [];
              let cl = '';
              for (const w of words) {
                const tl = cl ? `${cl} ${w}` : w;
                if (font.widthOfTextAtSize(tl, dedFontSize) > maxDedWidth && cl) {
                  lines.push(cl);
                  cl = w;
                } else { cl = tl; }
              }
              if (cl) lines.push(cl);
              const startY = pageHeight / 2 + (lines.length * dedLineHeight) / 2;
              for (let i = 0; i < lines.length; i++) {
                const lw = font.widthOfTextAtSize(lines[i], dedFontSize);
                page.drawText(lines[i], {
                  x: (pageWidth - lw) / 2,
                  y: startY - i * dedLineHeight,
                  size: dedFontSize,
                  font,
                  color: textColor,
                });
              }
            }
          }
        }
        break;
      }

      case 'spread': {
        const leftPage = pdfDoc.addPage([pageWidth, pageHeight]);
        const rightPage = pdfDoc.addPage([pageWidth, pageHeight]);

        if (entry.spreadIllustrationBuffer) {
          const { leftHalf, rightHalf } = await splitSpreadImage(
            entry.spreadIllustrationBuffer, pageWidth, pageHeight
          );
          const leftImg = await pdfDoc.embedJpg(leftHalf);
          leftPage.drawImage(leftImg, { x: 0, y: 0, width: pageWidth, height: pageHeight });
          const rightImg = await pdfDoc.embedJpg(rightHalf);
          rightPage.drawImage(rightImg, { x: 0, y: 0, width: pageWidth, height: pageHeight });
        }

        if (entry.leftIllustrationBuffer) {
          await embedImageFullBleed(pdfDoc, leftPage, entry.leftIllustrationBuffer, pageWidth, pageHeight);
        }
        if (entry.rightIllustrationBuffer) {
          await embedImageFullBleed(pdfDoc, rightPage, entry.rightIllustrationBuffer, pageWidth, pageHeight);
        }
        break;
      }

      case 'closing_page': {
        const page = pdfDoc.addPage([pageWidth, pageHeight]);
        const endText = 'The End';
        const endFontSize = 20;
        const endWidth = boldFont.widthOfTextAtSize(endText, endFontSize);
        page.drawText(endText, {
          x: (pageWidth - endWidth) / 2,
          y: pageHeight / 2 + 10,
          size: endFontSize,
          font: boldFont,
          color: rgb(0.2, 0.15, 0.1),
        });

        const brandText = 'GiftMyBook.com';
        const brandFontSize = 9;
        const brandWidth = font.widthOfTextAtSize(brandText, brandFontSize);
        page.drawText(brandText, {
          x: (pageWidth - brandWidth) / 2,
          y: pageHeight / 2 - 20,
          size: brandFontSize,
          font,
          color: rgb(0.5, 0.5, 0.5),
        });
        break;
      }

      default:
        console.warn(`[LayoutEngine] Unknown entry type: ${entry.type}`);
        break;
    }
  }

  // Ensure even page count for print
  if (pdfDoc.getPageCount() % 2 !== 0) {
    pdfDoc.addPage([pageWidth, pageHeight]);
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

module.exports = { assemblePdf, FORMATS };
