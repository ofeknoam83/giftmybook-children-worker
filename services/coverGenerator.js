/**
 * Cover Generator — Creates Lulu-compliant wrap-around cover PDF
 * (back cover + spine + front cover) with 0.125" bleed.
 *
 * Back cover includes: synopsis blurb, age badge, barcode clear zone, GiftMyBook mark.
 */

const { PDFDocument, rgb, StandardFonts, degrees } = require('pdf-lib');
const { generateIllustration } = require('./illustrationGenerator');
const { downloadBuffer } = require('./gcsStorage');
const sharp = require('sharp');

/**
 * Word-wrap text to fit a max width.
 */
function wrapText(text, font, fontSize, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let currentLine = '';
  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (font.widthOfTextAtSize(testLine, fontSize) > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

/**
 * Extract dominant color from an image buffer using sharp.
 * Returns {r, g, b} normalized to 0-1.
 */
async function extractDominantColor(imageBuffer) {
  try {
    const { dominant } = await sharp(imageBuffer).stats();
    return {
      r: dominant.r / 255,
      g: dominant.g / 255,
      b: dominant.b / 255,
    };
  } catch {
    return { r: 0.95, g: 0.93, b: 0.88 }; // warm cream fallback
  }
}

/**
 * Soften a color toward cream (for background use).
 */
function softenColor(color, amount = 0.5) {
  const cream = { r: 0.95, g: 0.93, b: 0.88 };
  return {
    r: color.r + (cream.r - color.r) * amount,
    g: color.g + (cream.g - color.g) * amount,
    b: color.b + (cream.b - color.b) * amount,
  };
}

/**
 * Generate a Lulu-compliant wrap-around cover PDF.
 *
 * Layout (left → right): bleed | back cover | spine | front cover | bleed
 *
 * @param {string} title
 * @param {object} childDetails - { childName, childAge, childAppearance }
 * @param {string} characterRefUrl
 * @param {string} bookFormat - PICTURE_BOOK or EARLY_READER
 * @param {object} opts
 * @returns {Promise<{coverPdfBuffer: Buffer, frontCoverImageUrl: string}>}
 */
async function generateCover(title, childDetails, characterRefUrl, bookFormat, opts = {}) {
  const isPictureBook = (bookFormat || '').toLowerCase() === 'picture_book';
  const trimWidth = isPictureBook ? 612 : 432;
  const trimHeight = isPictureBook ? 612 : 648;
  const bleed = 9; // 0.125" Lulu standard

  const pageCount = opts.pageCount || 32;
  const spineInches = (pageCount / 444) + 0.06;
  const spineWidth = Math.max(spineInches * 72, 6);

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
        coverScene, characterRefUrl, artStyle, {
          costTracker: opts.costTracker,
          bookId: opts.bookId,
          childAppearance: childDetails.appearance || childDetails.childAppearance,
          childName: childDetails.name || childDetails.childName,
          childPhotoUrl: opts.childPhotoUrl,
          _cachedPhotoBase64: opts._cachedPhotoBase64,
          _cachedPhotoMime: opts._cachedPhotoMime,
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

  // ── Extract dominant color from front cover for back cover palette ──
  const coverColor = frontCoverBuffer
    ? await extractDominantColor(frontCoverBuffer)
    : { r: 0.95, g: 0.93, b: 0.88 };
  const backBgColor = softenColor(coverColor, 0.6); // soft version of cover's dominant color
  const spineBgColor = softenColor(coverColor, 0.4); // slightly deeper for spine
  const textColor = { r: 0.2, g: 0.18, b: 0.15 }; // warm dark brown

  // ── Build wrap-around PDF ──
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([totalWidth, totalHeight]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // ═══════════════════════════════════════
  // BACK COVER (left side)
  // ═══════════════════════════════════════
  const backWidth = bleed + trimWidth;

  // Background — soft version of front cover's dominant color
  page.drawRectangle({
    x: 0, y: 0,
    width: backWidth,
    height: totalHeight,
    color: rgb(backBgColor.r, backBgColor.g, backBgColor.b),
  });

  // Subtle decorative line near top
  const accentColor = softenColor(coverColor, 0.2);
  page.drawRectangle({
    x: bleed + 60, y: totalHeight - bleed - 80,
    width: trimWidth - 120, height: 1.5,
    color: rgb(accentColor.r, accentColor.g, accentColor.b),
    opacity: 0.4,
  });

  const childName = childDetails.childName || childDetails.name || '';
  const childAge = childDetails.childAge || childDetails.age || 5;
  const synopsis = opts.synopsis || '';
  const heartfeltNote = opts.heartfeltNote || '';
  const bookFrom = opts.bookFrom || '';
  const safeMargin = 36;
  const contentWidth = trimWidth - safeMargin * 2;
  const centerX = bleed + trimWidth / 2;

  let yPos = totalHeight - bleed - 110; // Start below the decorative line

  // ── Synopsis blurb (centered, top area) ──
  if (synopsis) {
    const synopsisFontSize = isPictureBook ? 12 : 10;
    const lineHeight = synopsisFontSize * 1.7;
    const lines = wrapText(synopsis, font, synopsisFontSize, contentWidth - 20);

    for (let i = 0; i < lines.length; i++) {
      const lineWidth = font.widthOfTextAtSize(lines[i], synopsisFontSize);
      page.drawText(lines[i], {
        x: centerX - lineWidth / 2,
        y: yPos - i * lineHeight,
        size: synopsisFontSize,
        font,
        color: rgb(textColor.r, textColor.g, textColor.b),
      });
    }
    yPos -= lines.length * lineHeight + 25;
  }

  // ── Heartfelt note from gifter (if exists) ──
  if (heartfeltNote) {
    // Decorative separator
    page.drawRectangle({
      x: centerX - 30, y: yPos + 5,
      width: 60, height: 0.8,
      color: rgb(accentColor.r, accentColor.g, accentColor.b),
      opacity: 0.3,
    });
    yPos -= 15;

    // Note text in slightly smaller, warm style
    const noteSize = 10;
    const noteLineHeight = noteSize * 1.6;
    const noteLines = wrapText(heartfeltNote, font, noteSize, contentWidth - 40);
    for (let i = 0; i < Math.min(noteLines.length, 6); i++) { // Cap at 6 lines
      const lw = font.widthOfTextAtSize(noteLines[i], noteSize);
      page.drawText(noteLines[i], {
        x: centerX - lw / 2,
        y: yPos - i * noteLineHeight,
        size: noteSize,
        font,
        color: rgb(textColor.r + 0.1, textColor.g + 0.1, textColor.b + 0.1),
      });
    }
    yPos -= Math.min(noteLines.length, 6) * noteLineHeight + 10;

    // Attribution
    if (bookFrom) {
      const attrText = `— ${bookFrom}`;
      const attrSize = 9;
      const attrWidth = font.widthOfTextAtSize(attrText, attrSize);
      page.drawText(attrText, {
        x: centerX - attrWidth / 2,
        y: yPos,
        size: attrSize,
        font,
        color: rgb(textColor.r + 0.15, textColor.g + 0.15, textColor.b + 0.15),
      });
      yPos -= 30;
    }
  }

  // ── Age badge (pill shape, centered) ──
  const ageTier = childAge <= 2 ? '0-2' : childAge <= 5 ? '3-5' : childAge <= 8 ? '6-8' : '9-12';
  const ageText = `Ages ${ageTier}`;
  const ageFontSize = 8;
  const ageTextWidth = font.widthOfTextAtSize(ageText, ageFontSize);
  const pillWidth = ageTextWidth + 16;
  const pillHeight = 17;
  const pillX = centerX - pillWidth / 2;
  const pillY = Math.max(yPos - 10, bleed + 80);

  page.drawRectangle({
    x: pillX, y: pillY,
    width: pillWidth, height: pillHeight,
    color: rgb(textColor.r, textColor.g, textColor.b),
    opacity: 0.85,
    borderWidth: 0,
  });
  page.drawText(ageText, {
    x: pillX + 8,
    y: pillY + 5,
    size: ageFontSize,
    font: boldFont,
    color: rgb(1, 1, 1),
  });

  // ── "Made with love for {name}" ──
  if (childName) {
    const loveText = `Made with love for ${childName}`;
    const loveSize = 8;
    const loveWidth = font.widthOfTextAtSize(loveText, loveSize);
    page.drawText(loveText, {
      x: centerX - loveWidth / 2,
      y: bleed + 50,
      size: loveSize,
      font,
      color: rgb(textColor.r + 0.15, textColor.g + 0.15, textColor.b + 0.15),
    });
  }

  // ── GiftMyBook.com brand mark (bottom) ──
  const brandText = 'GiftMyBook.com';
  const brandSize = 7;
  const brandWidth = font.widthOfTextAtSize(brandText, brandSize);
  page.drawText(brandText, {
    x: centerX - brandWidth / 2,
    y: bleed + 25,
    size: brandSize,
    font,
    color: rgb(textColor.r + 0.25, textColor.g + 0.25, textColor.b + 0.25),
  });

  // Subtle decorative line near bottom
  page.drawRectangle({
    x: bleed + 60, y: bleed + 70,
    width: trimWidth - 120, height: 1.5,
    color: rgb(accentColor.r, accentColor.g, accentColor.b),
    opacity: 0.4,
  });

  // ═══════════════════════════════════════
  // SPINE
  // ═══════════════════════════════════════
  const spineX = backWidth;

  // Spine background — deeper shade of the cover color
  page.drawRectangle({
    x: spineX, y: 0,
    width: spineWidth,
    height: totalHeight,
    color: rgb(spineBgColor.r, spineBgColor.g, spineBgColor.b),
  });

  // Subtle edge lines on both sides of spine
  page.drawRectangle({
    x: spineX, y: 0,
    width: 0.5, height: totalHeight,
    color: rgb(accentColor.r, accentColor.g, accentColor.b),
    opacity: 0.15,
  });
  page.drawRectangle({
    x: spineX + spineWidth - 0.5, y: 0,
    width: 0.5, height: totalHeight,
    color: rgb(accentColor.r, accentColor.g, accentColor.b),
    opacity: 0.15,
  });

  // Spine text (vertical, if spine >= 18pts / 0.25")
  if (spineWidth >= 18 && title) {
    const spineFontSize = Math.min(8, spineWidth * 0.55);
    const spineTextWidth = boldFont.widthOfTextAtSize(title, spineFontSize);
    // Center the text vertically and horizontally on the spine
    const textX = spineX + spineWidth / 2 + spineFontSize * 0.35;
    const textY = totalHeight / 2 + spineTextWidth / 2;
    page.drawText(title, {
      x: textX,
      y: textY,
      size: spineFontSize,
      font: boldFont,
      color: rgb(textColor.r, textColor.g, textColor.b),
      rotate: degrees(-90),
    });
  }

  // ═══════════════════════════════════════
  // FRONT COVER (right side)
  // ═══════════════════════════════════════
  const frontX = backWidth + spineWidth;
  const frontWidth = trimWidth + bleed;

  // Background fallback
  page.drawRectangle({
    x: frontX, y: 0,
    width: frontWidth,
    height: totalHeight,
    color: rgb(backBgColor.r, backBgColor.g, backBgColor.b),
  });

  // Embed front cover illustration at 300 DPI
  if (frontCoverBuffer) {
    try {
      const targetWidthPx = Math.round(frontWidth / 72 * 300);
      const targetHeightPx = Math.round(totalHeight / 72 * 300);
      const resized = await sharp(frontCoverBuffer)
        .resize(targetWidthPx, targetHeightPx, { fit: 'cover' })
        .jpeg({ quality: 95 })
        .toBuffer();
      const img = await pdfDoc.embedJpg(resized);
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
