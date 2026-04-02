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
  const pageCount = opts.pageCount || 32;
  const artStyle = opts.artStyle || 'watercolor';

  // Dimensions
  const isPictureBook = bookFormat === 'PICTURE_BOOK';
  const trimWidth = isPictureBook ? 612 : 432;   // 8.5" or 6"
  const trimHeight = isPictureBook ? 612 : 648;  // 8.5" or 9"
  const spineWidth = Math.round(pageCount * SPINE_WIDTH_PER_PAGE);
  const bleed = 18; // 0.25" bleed on all sides
  const totalWidth = (trimWidth + bleed) * 2 + spineWidth;
  const totalHeight = trimHeight + bleed * 2;

  let frontCoverImageUrl = null;
  let frontCoverBuffer = null;

  if (opts.preGeneratedCoverBuffer) {
    console.log('[CoverGenerator] Using pre-generated cover buffer — skipping illustration generation');
    frontCoverBuffer = opts.preGeneratedCoverBuffer;
  } else {
    // Generate front cover illustration
    const coverScene = `A beautiful ${artStyle} children's book cover illustration. `
      + `The main character is a ${childDetails.childAge || childDetails.age || 5}-year-old child named ${childDetails.childName || childDetails.name}. `
      + `The scene should be inviting, colorful, and magical — suggesting the start of an adventure. `
      + `The child should be centered, looking happy and confident. `
      + `Background should be thematic and whimsical.`;

    try {
      const imageUrl = await generateIllustration(
        coverScene,
        characterRefUrl,
        artStyle,
        opts.faceRef || null,
        {
          costTracker: opts.costTracker,
          bookId: opts.bookId,
          childAppearance: childDetails.appearance || childDetails.childAppearance,
          childName: childDetails.name || childDetails.childName,
        },
      );
      frontCoverImageUrl = imageUrl;
      if (imageUrl) {
        frontCoverBuffer = await downloadBuffer(imageUrl);
      }
    } catch (err) {
      console.error('[CoverGenerator] Failed to generate cover illustration:', err.message);
    }
  }

  // Build cover PDF
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const lightFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const page = pdfDoc.addPage([totalWidth, totalHeight]);

  // Background
  page.drawRectangle({
    x: 0, y: 0, width: totalWidth, height: totalHeight,
    color: rgb(0.95, 0.93, 0.88),
  });

  // Front cover area (right side)
  const frontX = trimWidth + bleed + spineWidth;

  // Embed front cover illustration
  if (frontCoverBuffer) {
    try {
      const resized = await sharp(frontCoverBuffer)
        .resize(trimWidth + bleed, trimHeight + bleed * 2, { fit: 'cover' })
        .png()
        .toBuffer();
      const img = await pdfDoc.embedPng(resized);
      page.drawImage(img, {
        x: frontX,
        y: 0,
        width: trimWidth + bleed,
        height: totalHeight,
      });
    } catch (err) {
      console.error('[CoverGenerator] Failed to embed cover image:', err.message);
    }
  }

  // Title on front cover
  const titleSize = 28;
  const titleWidth = font.widthOfTextAtSize(title, titleSize);
  const titleX = frontX + (trimWidth - titleWidth) / 2;
  // Title background
  page.drawRectangle({
    x: titleX - 10,
    y: totalHeight - bleed - 80,
    width: titleWidth + 20,
    height: 50,
    color: rgb(1, 1, 1),
    opacity: 0.8,
  });
  page.drawText(title, {
    x: titleX,
    y: totalHeight - bleed - 60,
    size: titleSize,
    font,
    color: rgb(0.15, 0.15, 0.15),
  });

  // Spine
  const spineX = trimWidth + bleed;
  page.drawRectangle({
    x: spineX, y: 0, width: spineWidth, height: totalHeight,
    color: rgb(0.3, 0.5, 0.7),
  });
  // Spine text (rotated — simplified: just draw horizontally if spine is wide enough)
  if (spineWidth > 30) {
    const spineText = title.substring(0, 20);
    const spineTextSize = 8;
    page.drawText(spineText, {
      x: spineX + 4,
      y: totalHeight / 2,
      size: spineTextSize,
      font: lightFont,
      color: rgb(1, 1, 1),
    });
  }

  // Back cover (left side)
  const backCenterX = (trimWidth + bleed) / 2;
  const backText = `A personalized story for ${childDetails.childName || childDetails.name || 'your child'}`;
  const backTextWidth = lightFont.widthOfTextAtSize(backText, 14);
  page.drawText(backText, {
    x: backCenterX - backTextWidth / 2,
    y: totalHeight / 2 + 20,
    size: 14,
    font: lightFont,
    color: rgb(0.3, 0.3, 0.3),
  });

  page.drawText('giftmybook.com', {
    x: backCenterX - lightFont.widthOfTextAtSize('giftmybook.com', 10) / 2,
    y: bleed + 30,
    size: 10,
    font: lightFont,
    color: rgb(0.5, 0.5, 0.5),
  });

  const pdfBytes = await pdfDoc.save();
  return {
    coverPdfBuffer: Buffer.from(pdfBytes),
    frontCoverImageUrl,
  };
}

module.exports = { generateCover };
