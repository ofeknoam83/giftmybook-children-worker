'use strict';

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const fontkit = require('@pdf-lib/fontkit');
const { createHash } = require('crypto');
const { resolveTypographyGuideRules } = require('../../shared/illustration/config');
const { wrapStoryLines } = require('../../shared/illustration/textBlock');

// A reference, never an overlay on the output. Gemini still paints every
// word into the illustration. No generated first page gets to set the size.
const GUIDE_HEIGHT = 1536;
const GUIDE_WIDTH = Math.round(GUIDE_HEIGHT * 16 / 9 * 0.45);
let font;
function guideFont() {
  if (!font) font = fontkit.create(fs.readFileSync(path.join(__dirname, '../../../fonts/PlayfairDisplay.ttf')));
  return font;
}

async function chooseBookTextInk(reference) {
  try {
    const source = Buffer.isBuffer(reference) ? reference : Buffer.from(reference.base64, 'base64');
    const { data } = await sharp(source).rotate().resize(32, 32, { fit: 'fill' }).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const values = [];
    for (let i = 0; i < data.length; i += 3) values.push(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
    values.sort((a, b) => a - b);
    // ONE decision from the approved cover, not a per-spread recolor. The
    // median discounts title lettering and isolated moon/flower highlights.
    return values[Math.floor(values.length / 2)] < 115 ? 'light' : 'dark';
  } catch { return 'dark'; }
}

async function createTypographyGuide({ childAge, ink = 'dark', text }) {
  const rules = resolveTypographyGuideRules(childAge, ink);
  const f = guideFont();
  const capPercent = rules.capHeightPercent;
  const capHeight = GUIDE_HEIGHT * capPercent / 100;
  const h = f.glyphForCodePoint('H'.codePointAt(0)).bbox;
  const scale = capHeight / (h.maxY - h.minY);
  const linePitch = GUIDE_HEIGHT * rules.linePitchPercent / 100;
  const lines = wrapStoryLines(text || 'A small adventure begins. There is so much to discover.', rules.maxCharsPerLine);
  const x = GUIDE_HEIGHT * 16 / 9 * rules.edgePaddingPercent / 100;
  const y = GUIDE_HEIGHT * rules.topPaddingPercent / 100;
  const paths = [];
  lines.forEach((line, i) => {
    let cursor = x;
    const run = f.layout(line);
    run.glyphs.forEach((glyph, j) => {
      const pos = run.positions[j];
      const tx = cursor + pos.xOffset * scale;
      const ty = y + capHeight + i * linePitch - pos.yOffset * scale;
      paths.push(`<path d="${glyph.path.toSVG()}" transform="translate(${tx} ${ty}) scale(${scale} ${-scale})" fill="${rules.fontColorHex}" stroke="${ink === 'light' ? '#2A1C12' : '#fff9ef'}" stroke-width="${0.4 / scale}" paint-order="stroke fill"/>`);
      cursor += pos.xAdvance * scale;
    });
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${GUIDE_WIDTH}" height="${GUIDE_HEIGHT}" viewBox="0 0 ${GUIDE_WIDTH} ${GUIDE_HEIGHT}">${paths.join('')}</svg>`;
  const bytes = await sharp(Buffer.from(svg)).png().toBuffer();
  const hash = createHash('sha256').update('typography-guide-v1').update(bytes).digest('hex').slice(0, 16);
  return { kind: 'guide', spread: 0, side: 'left', base64: bytes.toString('base64'), mimeType: 'image/png', hash,
    ink, inkHex: rules.fontColorHex, capHeightPercent: capPercent, pinned: true };
}

// A new reference changes every cache key. Ordinary retries of an older
// book must keep its existing namespace, including partially generated books.
async function canUseTypographyGuide({ enabled, reviewedOnly, forceRerender, legacyPaths, guidePaths = [] }, exists = require('../../gcsStorage').objectExists) {
  if (!enabled || reviewedOnly) return false;
  if (forceRerender) return true;
  try {
    // A previous explicit upgrade may coexist with old paid-for renders.
    // Resume the new guide namespace once any of its renders exists.
    if ((await Promise.all(guidePaths.map(key => exists(key)))).some(Boolean)) return true;
    return !(await Promise.all(legacyPaths.map(key => exists(key)))).some(Boolean);
  }
  catch { return false; } // a failed existence check must not invalidate saved artwork
}

module.exports = { canUseTypographyGuide, createTypographyGuide, chooseBookTextInk, GUIDE_HEIGHT, GUIDE_WIDTH };
