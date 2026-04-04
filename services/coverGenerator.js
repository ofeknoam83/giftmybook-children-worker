/**
 * Cover Generator — Creates Lulu-compliant wrap-around cover PDF
 * (back cover + spine + front cover) with 0.125" bleed.
 */

const { PDFDocument, rgb, StandardFonts, degrees } = require('pdf-lib');
const { generateIllustration } = require('./illustrationGenerator');
const { downloadBuffer } = require('./gcsStorage');
const sharp = require('sharp');

/**
 * Generate a Lulu-compliant wrap-around cover PDF.
 *
 * Layout (left → right): bleed | back cover | spine | front cover | bleed
 *
 * @param {string} title
 * @param {object} childDetails - { childName, childAppearance }
 * @param {string} characterRefUrl - Character reference image URL
 * @param {string} bookFormat - PICTURE_BOOK or EARLY_READER
 * @param {object} opts - { pageCount, artStyle, faceRef, preGeneratedCoverBuffer, ... }
 * @returns {Promise<{coverPdfBuffer: Buffer, frontCoverImageUrl: string}>}
 */
async function generateCover(title, childDetails, characterRefUrl, bookFormat, opts = {}) {
  const isPictureBook = (bookFormat || '').toLowerCase() === 'picture_book';
  const trimWidth = isPictureBook ? 612 : 432;   // 8.5" or 6" in pts
  const trimHeight = isPictureBook ? 612 : 648;  // 8.5" or 9" in pts
  const bleed = 9; // 0.125" in pts (Lulu standard)

  // Spine width: (pageCount / 444) + 0.06 inches, converted to pts
  const pageCount = opts.pageCount || 32;
  const spineInches = (pageCount / 444) + 0.06;
  const spineWidth = Math.max(spineInches * 72, 6); // minimum 6pts to be printable

  // Total page dimensions
  const totalWidth = (trimWidth + bleed) * 2 + spineWidth;
  const totalHeight = trimHeight + bleed * 2;

  console.log(`[CoverGenerator] Wrap-around cover: ${totalWidth.toFixed(1)}x${totalHeight.toFixed(1)}pts, spine=${spineWidth.toFixed(1)}pts (${pageCount} pages)`);

  // ── Obtain front cover image ──
  let frontCoverImageUrl = null;
  let frontCoverBuffer = null;

  if (opts.preGeneratedCoverBuffer) {
    console.log('[CoverGenerator] Using pre-generated cover buffer');
    frontCoverBuffer = opts.preGeneratedCoverBuffer;
  } else {
    const artStyle = opts.artStyle || 'watercolor';
    const coverScene = `A beautiful ${artStyle} children's book cover illustration. `
      + `The main character is a ${childDetails.childAge || childDetails.age || 5}-year-old child named ${childDetails.childName || childDetails.name}. `
      + `The scene should be inviting, colorful, and magical — suggesting the start of an adventure. `
      + `The child should be centered, looking happy and confident. `
      + `Background should be thematic and whimsical.`;

    try {
      const imageUrl = await generateIllustration(
        coverScene, characterRefUrl, artStyle, opts.faceRef || null,
        { costTracker: opts.costTracker, bookId: opts.bookId,
          childAppearance: childDetails.appearance || childDetails.childAppearance,
          childName: childDetails.name || childDetails.childName },
      );
      frontCoverImageUrl = imageUrl;
      if (imageUrl) {
        frontCoverBuffer = await downloadBuffer(imageUrl);
      }
    } catch (err) {
      console.error('[CoverGenerator] Failed to generate cover illustration:', err.message);
    }
  }

  // ── Build wrap-around PDF ──
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([totalWidth, totalHeight]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // Back cover area: x=0, width = bleed + trimWidth
  const backWidth = bleed + trimWidth;
  page.drawRectangle({
    x: 0, y: 0,
    width: backWidth,
    height: totalHeight,
    color: rgb(0.95, 0.93, 0.88), // warm cream
  });

  // Spine area: x = bleed + trimWidth, width = spineWidth
  const spineX = backWidth;
  page.drawRectangle({
    x: spineX, y: 0,
    width: spineWidth,
    height: totalHeight,
    color: rgb(0.90, 0.87, 0.80), // slightly darker warm tone
  });

  // Spine text (vertical, if spine >= 18pts / 0.25")
  if (spineWidth >= 18 && title) {
    const spineFontSize = Math.min(8, spineWidth * 0.6);
    const textWidth = font.widthOfTextAtSize(title, spineFontSize);
    // Rotate -90° so text reads top-to-bottom when book is upright
    const textX = spineX + spineWidth / 2 + spineFontSize * 0.35;
    const textY = totalHeight / 2 + textWidth / 2;
    page.drawText(title, {
      x: textX,
      y: textY,
      size: spineFontSize,
      font,
      color: rgb(0.3, 0.25, 0.2),
      rotate: degrees(-90),
    });
  }

  // Front cover area: x = bleed + trimWidth + spineWidth, width = trimWidth + bleed
  const frontX = backWidth + spineWidth;
  const frontWidth = trimWidth + bleed;

  // Background fallback for front cover
  page.drawRectangle({
    x: frontX, y: 0,
    width: frontWidth,
    height: totalHeight,
    color: rgb(0.95, 0.93, 0.88),
  });

  // Embed front cover illustration
  if (frontCoverBuffer) {
    try {
      const resized = await sharp(frontCoverBuffer)
        .resize(Math.round(frontWidth), Math.round(totalHeight), { fit: 'cover' })
        .png()
        .toBuffer();
      const img = await pdfDoc.embedPng(resized);
      page.drawImage(img, {
        x: frontX, y: 0,
        width: frontWidth,
        height: totalHeight,
      });
    } catch (err) {
      console.error('[CoverGenerator] Failed to embed cover image:', err.message);
    }
  }

  const pdfBytes = await pdfDoc.save();
  return {
    coverPdfBuffer: Buffer.from(pdfBytes),
    frontCoverImageUrl,
  };
}

module.exports = { generateCover };
