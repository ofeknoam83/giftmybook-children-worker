/**
 * pq-1 Phase 2.4 — the PRINT-CROP preview (docs/PRINT_QUALITY_PLAN.md).
 *
 * The admin, the Art Bench and the customer flipbook used to see the raw
 * 16:9 render; the printed book shows the middle 86% of its height across
 * two facing 8.5 × 8.5 in pages, with the fold at the centre. This module
 * draws that: the exact crop the layout engine prints (the same maths as
 * `splitSpreadImage` — scale to the 2:1 spread width, centre-crop the
 * height), with thin guides for the trim line, the safety margin and the
 * fold/gutter band, uploaded beside every shipped render as
 * `<renderKey>.print.jpg`. A square (caption) render gets its single page
 * with trim + safety guides; a `half` render has its left half — the text
 * panel in print — dimmed and labelled. Pure sharp; fail-open per spread.
 */

'use strict';

const sharp = require('sharp');
const LULU = require('../../luluSpec');
const { uploadBuffer, getSignedUrl } = require('../../gcsStorage');

const SIGNED_URL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PRODUCT = LULU.PRODUCTS.CHILDREN_PICTURE_BOOK;

/**
 * The print-frame geometry for one render, as fractions of the RENDER.
 * Wide: the printed spread is trim+bleed pages side by side (2:1); the
 * render is scaled to that width and centre-cropped in height. Square:
 * the whole render is the page.
 * @param {'wide'|'square'} aspect
 * @param {{width: number, height: number}} source
 * @returns {{crop: {left: number, top: number, width: number, height: number}, pages: number, bleedFrac: number, safetyFrac: number, gutterFrac: number}}
 */
function printFrame(aspect, source) {
  const pageIn = PRODUCT.trimWidthIn + 2 * LULU.GUIDELINES.bleedIn; // 8.75
  const pages = aspect === 'wide' ? 2 : 1;
  const canvasW = pageIn * pages;
  const canvasH = pageIn;
  const scale = source.width / canvasW; // px per inch on the source
  const cropH = Math.min(source.height, Math.round(canvasH * scale));
  const top = Math.max(0, Math.floor((source.height - cropH) / 2));
  return {
    crop: { left: 0, top, width: source.width, height: cropH },
    pages,
    bleedFrac: LULU.GUIDELINES.bleedIn / pageIn,
    safetyFrac: (LULU.GUIDELINES.bleedIn + LULU.GUIDELINES.safetyIn + LULU.GUIDELINES.gutterIn) / pageIn,
    gutterFrac: LULU.GUIDELINES.gutterIn / pageIn,
  };
}

/**
 * Build the preview JPEG: the print crop at `width` px with guides.
 * @param {Buffer} buffer the shipped render
 * @param {{aspect: 'wide'|'square', textLayout: string, width?: number}} opts
 * @returns {Promise<Buffer>}
 */
async function buildPrintPreview(buffer, { aspect, textLayout, width = 1600 }) {
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) throw new Error('unreadable render');
  const frame = printFrame(aspect, { width: meta.width, height: meta.height });
  const outW = frame.pages === 2 ? width : Math.round(width / 2);
  const outH = Math.round(outW / frame.pages);
  const base = sharp(buffer).extract(frame.crop).resize(outW, outH, { fit: 'fill' });

  const pageW = outW / frame.pages;
  const bleed = frame.bleedFrac * pageW;
  const safety = frame.safetyFrac * pageW;
  const gutter = frame.gutterFrac * pageW;
  const g = [];
  const line = (x1, y1, x2, y2, stroke, dash) => g.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${stroke}" stroke-width="2"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`);
  // Trim (orange) and safety (green) per page; the fold + gutter band (grey) between pages.
  for (let p = 0; p < frame.pages; p += 1) {
    const x0 = p * pageW;
    line(x0 + bleed, 0, x0 + bleed, outH, '#d9822b'); line(x0 + pageW - bleed, 0, x0 + pageW - bleed, outH, '#d9822b');
    line(x0 + safety, 0, x0 + safety, outH, '#2e7d4f', '8,6'); line(x0 + pageW - safety, 0, x0 + pageW - safety, outH, '#2e7d4f', '8,6');
  }
  line(0, bleed, outW, bleed, '#d9822b'); line(0, outH - bleed, outW, outH - bleed, '#d9822b');
  line(0, safety, outW, safety, '#2e7d4f', '8,6'); line(0, outH - safety, outW, outH - safety, '#2e7d4f', '8,6');
  if (frame.pages === 2) {
    g.push(`<rect x="${(pageW - gutter).toFixed(1)}" y="0" width="${(2 * gutter).toFixed(1)}" height="${outH}" fill="#222" opacity="0.35"/>`);
    line(pageW, 0, pageW, outH, '#111', '12,8');
    if (textLayout === 'half') {
      g.push(`<rect x="0" y="0" width="${pageW.toFixed(1)}" height="${outH}" fill="#f7f2ea" opacity="0.82"/>`);
      g.push(`<text x="${(pageW / 2).toFixed(1)}" y="${(outH / 2).toFixed(1)}" font-family="Helvetica, Arial, sans-serif" font-size="${Math.round(outH * 0.05)}" fill="#5f6875" text-anchor="middle">TEXT PAGE IN PRINT</text>`);
    }
  }
  const legend = 'orange = trim · green = safety margin' + (frame.pages === 2 ? ' · grey = fold + gutter' : '');
  g.push(`<text x="${(safety + 6).toFixed(1)}" y="${(outH - safety - 8).toFixed(1)}" font-family="Helvetica, Arial, sans-serif" font-size="${Math.round(outH * 0.024)}" fill="#ffffff" stroke="#000" stroke-width="0.6" paint-order="stroke">${legend}</text>`);
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}">${g.join('')}</svg>`);
  return base.composite([{ input: svg, top: 0, left: 0 }]).jpeg({ quality: 86 }).toBuffer();
}

/**
 * The preview's storage key beside its render.
 * @param {string} renderKey `…/spread-N.<aspect>.png`
 * @returns {string}
 */
function printPreviewKey(renderKey) {
  return `${String(renderKey).replace(/\.png$/i, '')}.print.jpg`;
}

/**
 * Build + upload a print preview for every result that holds pixels.
 * Fail-open per spread: a preview that cannot be built is logged and
 * skipped, never a failed book. Mutates each result with `printPreviewUrl`
 * / `printPreviewKey` and returns the URL list in result order.
 * @param {Array<{spread: number, buffer: Buffer|null, storageKey: string}>} results
 * @param {{aspect: 'wide'|'square', textLayout: string, log: Function}} p
 * @returns {Promise<string[]>}
 */
async function attachPrintPreviews(results, { aspect, textLayout, log }) {
  const urls = [];
  for (const r of results) {
    if (!r || !r.buffer) continue;
    try {
      const key = printPreviewKey(r.storageKey);
      const jpeg = await buildPrintPreview(r.buffer, { aspect, textLayout });
      await uploadBuffer(jpeg, key, 'image/jpeg');
      r.printPreviewKey = key;
      r.printPreviewUrl = await getSignedUrl(key, SIGNED_URL_TTL_MS);
      if (r.printPreviewUrl) urls.push(r.printPreviewUrl);
    } catch (err) {
      log('warn', `Spread ${r.spread}: print preview skipped (${err.message})`);
    }
  }
  return urls;
}

module.exports = { printFrame, buildPrintPreview, printPreviewKey, attachPrintPreviews };
