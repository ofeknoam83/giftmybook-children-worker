/**
 * Text Compositor Service
 *
 * Composites text onto illustration images programmatically using Sharp + SVG.
 * This eliminates all font/text consistency issues by rendering text outside
 * of the AI image generation pipeline.
 *
 * Text is rendered via SVG overlays with configurable fonts, positions, and styles.
 */

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// ── Font Configuration ──

const FONT_DIR = path.join(__dirname, '..', 'fonts');

const FONT_OPTIONS = {
  'bubblegum': {
    family: 'Bubblegum Sans',
    weight: '400',
    fallback: 'cursive',
    file: 'BubblegumSans-Regular.ttf',
  },
  'comic-neue': {
    family: 'Comic Neue',
    weight: '700',
    fallback: 'cursive',
    file: 'ComicNeue-Bold.ttf',
  },
  'kalam': {
    family: 'Kalam',
    weight: '400',
    fallback: 'cursive',
    file: 'Kalam-Regular.ttf',
  },
  'playfair': {
    family: 'Playfair Display',
    weight: '400',
    fallback: 'serif',
    file: 'PlayfairDisplay.ttf',
  },
};

// Default font for children's books
const DEFAULT_FONT_KEY = 'bubblegum';

/**
 * Load a font file as a base64 data URI for SVG @font-face.
 * Cached after first load.
 */
const fontCache = new Map();
function loadFontAsDataUri(fontKey) {
  if (fontCache.has(fontKey)) return fontCache.get(fontKey);

  const config = FONT_OPTIONS[fontKey];
  if (!config || !config.file) return null;

  const fontPath = path.join(FONT_DIR, config.file);
  try {
    const fontBuffer = fs.readFileSync(fontPath);
    const base64 = fontBuffer.toString('base64');
    const dataUri = `data:font/ttf;base64,${base64}`;
    fontCache.set(fontKey, dataUri);
    return dataUri;
  } catch (err) {
    console.warn(`[textCompositor] Could not load font ${fontKey} from ${fontPath}: ${err.message}`);
    return null;
  }
}

class TextCompositor {
  /**
   * Composite text onto an illustration.
   *
   * @param {Buffer} illustrationBuffer - The raw illustration image (PNG/JPEG)
   * @param {string} pageText - The story text to render
   * @param {object} layoutConfig - Text layout configuration
   * @param {string} layoutConfig.fontKey - Font key from FONT_OPTIONS
   * @param {number} [layoutConfig.fontSize] - Font size in pixels (auto-calculated if omitted)
   * @param {string} [layoutConfig.fontColor] - Text color (default: '#2C2C2C')
   * @param {string} [layoutConfig.position] - 'bottom' or 'top' (default: 'bottom')
   * @param {number} [layoutConfig.textWidthPct] - Max text width as fraction of image width (default: 0.35)
   * @param {boolean} [layoutConfig.showBackground] - Add semi-transparent background behind text (default: true)
   * @param {string} [layoutConfig.bgColor] - Background color (default: 'rgba(255,255,255,0.75)')
   * @returns {Promise<Buffer>} - The composited image as a PNG buffer
   */
  async compositeText(illustrationBuffer, pageText, layoutConfig = {}) {
    if (!pageText || !pageText.trim()) {
      return illustrationBuffer; // No text to add
    }

    const metadata = await sharp(illustrationBuffer).metadata();
    const imgWidth = metadata.width;
    const imgHeight = metadata.height;

    const fontKey = layoutConfig.fontKey || DEFAULT_FONT_KEY;
    const fontConfig = FONT_OPTIONS[fontKey] || FONT_OPTIONS[DEFAULT_FONT_KEY];
    const fontColor = layoutConfig.fontColor || '#2C2C2C';
    const position = layoutConfig.position || 'bottom';
    const textWidthPct = layoutConfig.textWidthPct || 0.35;
    const showBackground = layoutConfig.showBackground !== false;
    const bgColor = layoutConfig.bgColor || 'rgba(255,255,255,0.75)';

    // Calculate font size relative to image dimensions
    const fontSize = layoutConfig.fontSize || this._calculateFontSize(imgWidth, imgHeight);
    const lineHeight = Math.round(fontSize * 1.4);

    // Calculate max text width in pixels
    const maxTextWidth = Math.round(imgWidth * textWidthPct);

    // Wrap text into lines
    const lines = this.wrapText(pageText, maxTextWidth, fontSize);

    // Calculate SVG dimensions
    const textBlockHeight = lines.length * lineHeight + Math.round(fontSize * 0.8);
    const padding = Math.round(fontSize * 0.6);
    const svgWidth = imgWidth;
    const svgHeight = imgHeight;

    // Calculate text position
    let textY;
    let bgY;
    if (position === 'top') {
      textY = padding + fontSize; // Start from top with padding
      bgY = 0;
    } else {
      // bottom (default)
      textY = imgHeight - textBlockHeight - padding + fontSize;
      bgY = imgHeight - textBlockHeight - padding * 2;
    }

    const bgHeight = textBlockHeight + padding * 2;

    // Calculate text X position (centered)
    const textX = Math.round(imgWidth / 2);

    // Load font as data URI for SVG embedding
    const fontDataUri = loadFontAsDataUri(fontKey);

    // Build SVG
    const fontFaceRule = fontDataUri
      ? `@font-face {
          font-family: '${fontConfig.family}';
          src: url('${fontDataUri}') format('truetype');
          font-weight: ${fontConfig.weight};
          font-style: normal;
        }`
      : '';

    const bgRect = showBackground
      ? `<rect x="0" y="${bgY}" width="${svgWidth}" height="${bgHeight}" fill="${bgColor}" rx="8"/>`
      : '';

    const textElements = lines.map((line, i) => {
      const y = textY + i * lineHeight;
      return `<text x="${textX}" y="${y}" class="story-text">${escapeXml(line)}</text>`;
    }).join('\n    ');

    const svg = `<svg width="${svgWidth}" height="${svgHeight}" xmlns="http://www.w3.org/2000/svg">
  <style>
    ${fontFaceRule}
    .story-text {
      fill: ${fontColor};
      font-family: '${fontConfig.family}', ${fontConfig.fallback};
      font-size: ${fontSize}px;
      font-weight: ${fontConfig.weight};
      text-anchor: middle;
    }
  </style>
  ${bgRect}
  ${textElements}
</svg>`;

    const svgBuffer = Buffer.from(svg);

    // Composite SVG over the illustration
    const result = await sharp(illustrationBuffer)
      .composite([{ input: svgBuffer, top: 0, left: 0 }])
      .png()
      .toBuffer();

    console.log(`[textCompositor] Composited ${lines.length} lines of text (${position}, ${fontSize}px, ${fontConfig.family})`);
    return result;
  }

  /**
   * Wrap text into lines that fit within maxWidthPx.
   *
   * @param {string} text - Text to wrap
   * @param {number} maxWidthPx - Maximum width in pixels
   * @param {number} fontSize - Font size in pixels
   * @returns {string[]} Array of text lines
   */
  wrapText(text, maxWidthPx, fontSize) {
    // Conservative estimate: average character width ≈ fontSize * 0.55
    const avgCharWidth = fontSize * 0.55;
    const maxCharsPerLine = Math.max(8, Math.floor(maxWidthPx / avgCharWidth));

    const words = text.split(/\s+/).filter(Boolean);
    const lines = [];
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      if (testLine.length > maxCharsPerLine && currentLine) {
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
   * Get a default text layout configuration based on spread position.
   *
   * @param {number} spreadIndex - 0-based index
   * @param {number} totalSpreads - Total number of spreads
   * @returns {object} Layout configuration
   */
  static getDefaultLayout(spreadIndex, totalSpreads) {
    // Alternate between bottom and top placement for visual variety
    const position = spreadIndex % 2 === 0 ? 'bottom' : 'top';

    return {
      fontKey: DEFAULT_FONT_KEY,
      fontColor: '#2C2C2C',
      position,
      textWidthPct: 0.35,
      showBackground: true,
      bgColor: 'rgba(255,255,255,0.75)',
    };
  }

  /**
   * Calculate an appropriate font size based on image dimensions.
   * Targets readable text for children's books (equivalent to ~22pt at print size).
   *
   * @param {number} width - Image width in pixels
   * @param {number} height - Image height in pixels
   * @returns {number} Font size in pixels
   */
  _calculateFontSize(width, height) {
    // For a typical 16:9 spread at 1024px wide, target ~36px font
    // Scale proportionally to image width
    const baseFontSize = Math.round(width * 0.035);
    // Clamp between 24 and 72 pixels
    return Math.max(24, Math.min(72, baseFontSize));
  }
}

/**
 * Escape XML special characters for safe SVG text embedding.
 */
function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = { TextCompositor, FONT_OPTIONS, DEFAULT_FONT_KEY };
