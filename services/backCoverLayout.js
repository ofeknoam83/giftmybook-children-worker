'use strict';

const { rgb, StandardFonts } = require('pdf-lib');
const bwipjs = require('bwip-js');
const QRCode = require('qrcode');
const { CREATION_URL } = require('./pictureBackCover');

function fitLines(value, font, size, width, maxLines) {
  const words = String(value || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
    if (line) lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  const clipped = lines.slice(0, maxLines);
  for (let i = 0; i < clipped.length; i++) {
    const truncated = font.widthOfTextAtSize(clipped[i], size) > width || (i === maxLines - 1 && lines.length > maxLines);
    if (truncated) {
      let text = clipped[i];
      while (text && font.widthOfTextAtSize(`${text}...`, size) > width) text = text.slice(0, -1);
      clipped[i] = `${text.trimEnd()}...`;
    }
  }
  return clipped;
}

/** A typeset back cover; the barcode encodes the internal book id, not an ISBN. */
async function drawBookBackCover(page, geom, content) {
  const { edgeBleed, trimWidth, totalHeight } = geom;
  const { title, synopsis, heartfeltNote, bookFrom, childName, bookId } = content;
  const doc = page.doc;
  const [font, bold, serif, serifBold, italic] = await Promise.all([
    StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.TimesRoman,
    StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic,
  ].map(name => doc.embedFont(name)));
  const safe = 45;
  const x = edgeBleed + safe;
  const width = trimWidth - 2 * safe;
  const textX = x + 28;
  const textWidth = width - 56;
  const top = totalHeight - edgeBleed - safe;
  const ink = rgb(0.10, 0.19, 0.17);
  const titleLines = fitLines(title || 'A story made just for you', serifBold, 25, textWidth, 2);
  const summaryLines = fitLines(synopsis, serif, 15, textWidth, 7);
  const note = String(heartfeltNote || '').trim();
  const sender = String(bookFrom || '').trim();
  const alreadySigned = sender && note.replace(/[.!?]+$/, '').toLowerCase().endsWith(sender.toLowerCase());
  const noteLines = fitLines(note ? `${note}${sender && !alreadySigned ? ` - ${sender}` : ''}` : '', italic, 11, textWidth, 3);
  const height = 92 + titleLines.length * 28 + summaryLines.length * 22 + (noteLines.length ? 20 + noteLines.length * 16 : 0);
  page.drawRectangle({ x, y: top - height, width, height, color: rgb(0.99, 0.98, 0.94), opacity: 0.96 });
  let y = top - 28;
  page.drawText('A PERSONALIZED STORYBOOK', { x: textX, y, size: 8, font: bold, color: ink });
  y -= 36;
  for (const line of titleLines) { page.drawText(line, { x: textX, y, size: 25, font: serifBold, color: ink }); y -= 28; }
  y -= 9;
  for (const line of summaryLines) { page.drawText(line, { x: textX, y, size: 15, font: serif, color: ink }); y -= 22; }
  if (noteLines.length) y -= 16;
  for (const line of noteLines) { page.drawText(line, { x: textX, y, size: 11, font: italic, color: ink }); y -= 16; }

  // The footer has its own opaque paper backing so branding and the bars
  // remain legible over arbitrary back-cover artwork and the plain fallback.
  const footerY = edgeBleed + safe;
  page.drawRectangle({ x, y: footerY, width, height: 100, color: rgb(0.99, 0.98, 0.94), opacity: 0.96 });
  const qr = await doc.embedPng(await QRCode.toBuffer(CREATION_URL, { margin: 4, scale: 8, errorCorrectionLevel: 'M' }));
  page.drawImage(qr, { x: x + 10, y: footerY + 15, width: 70, height: 70 });
  page.drawText('Create your next story', { x: x + 90, y: footerY + 69, size: 10, font: bold, color: ink });
  page.drawText('GiftMyBook.com', { x: x + 90, y: footerY + 48, size: 12, font: bold, color: ink });
  const madeFor = fitLines(`Made with love for ${childName || 'you'}`, font, 10, width - 312, 2);
  madeFor.forEach((line, i) => page.drawText(line, { x: x + 90, y: footerY + 29 - i * 13, size: 10, font, color: ink }));
  if (bookId) {
    const barcode = await bwipjs.toBuffer({
      bcid: 'code128', text: String(bookId), scale: 4, height: 12,
      includetext: false, paddingwidth: 12, paddingheight: 2, backgroundcolor: 'FFFFFF',
    });
    const image = await doc.embedPng(barcode);
    const bx = x + width - 212;
    page.drawRectangle({ x: bx, y: footerY + 8, width: 200, height: 60, color: rgb(1, 1, 1) });
    page.drawImage(image, { x: bx + 8, y: footerY + 17, width: 184, height: 32 });
  }
  return { summaryBottom: top - height, footerTop: footerY + 100 };
}

module.exports = { drawBookBackCover, fitLines };
