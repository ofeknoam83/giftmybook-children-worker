/**
 * Cover Generator — Creates front/back cover + spine for children's books
 */

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { generateIllustration } = require('./illustrationGenerator');
const { downloadBuffer } = require('./gcsStorage');
const sharp = require('sharp');

const SPINE_WIDTH_PER_PAGE = 0.0025 * 72; // ~0.18pt per page (Lulu standard)

/**
 * Generate a complete cover PDF (front + spine + back).
 * @param {string} title
 * @param {object} childDetails - { childName, childAppearance }
 * @param {string} characterRefUrl - Character reference image URL
 * @param {string} bookFormat - PICTURE_BOOK or EARLY_READER
 * @param {object} opts - { pageCount, artStyle, faceRef }
 * @returns {Promise<{coverPdfBuffer: Buffer, frontCoverImageUrl: string}>}
 */
async function generateCover(title, childDetails, characterRefUrl, bookFormat, opts = {}) {
  const isPictureBook = bookFormat === 'PICTURE_BOOK';
  const trimWidth = isPictureBook ? 612 : 432;
  const trimHeight = isPictureBook ? 612 : 648;
  const bleed = 18; // 0.25" bleed on all sides
  const pageWidth = trimWidth + bleed * 2;
  const pageHeight = trimHeight + bleed * 2;

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

  // Build square cover PDF (front cover only)
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([pageWidth, pageHeight]);

  // Background fallback
  page.drawRectangle({
    x: 0, y: 0, width: pageWidth, height: pageHeight,
    color: rgb(0.95, 0.93, 0.88),
  });

  // Embed front cover illustration (full bleed)
  if (frontCoverBuffer) {
    try {
      const resized = await sharp(frontCoverBuffer)
        .resize(pageWidth, pageHeight, { fit: 'cover' })
        .png()
        .toBuffer();
      const img = await pdfDoc.embedPng(resized);
      page.drawImage(img, { x: 0, y: 0, width: pageWidth, height: pageHeight });
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
